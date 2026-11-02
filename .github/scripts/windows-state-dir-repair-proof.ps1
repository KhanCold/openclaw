param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('baseline', 'candidate')]
  [string]$Mode
)

$ErrorActionPreference = 'Stop'
$repo = (Get-Location).Path
$root = Join-Path $env:RUNNER_TEMP "state dir 'proof' $Mode"
$gatewayState = Join-Path $root 'gateway state'
$cliState = Join-Path $root 'cli state'
$bin = Join-Path $root 'bin'
New-Item -ItemType Directory -Force -Path $gatewayState, $cliState, $bin | Out-Null

$utf8 = [System.Text.UTF8Encoding]::new($false)
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()
$gatewayAuthToken = 'synthetic-windows-proof-gateway-token'
$controlToken = 'synthetic-windows-proof-control-token'
$repairToken = 'synthetic-windows-proof-repair-token'
$gatewayConfig = Join-Path $gatewayState 'openclaw.json'
$cliConfig = Join-Path $cliState 'openclaw.json'
$storeProbePath = Join-Path $repo '.windows-state-dir-repair-secret-store-probe.mts'
$storeProbeCreated = $false
$config = @{
  gateway = @{
    mode = 'local'
    port = $port
    auth = @{ mode = 'token'; token = $gatewayAuthToken }
  }
} | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText($gatewayConfig, $config, $utf8)
[IO.File]::WriteAllText($cliConfig, $config, $utf8)

$launcher = Join-Path $bin 'openclaw.cmd'
[IO.File]::WriteAllText(
  $launcher,
  "@echo off`r`nnode `"$repo\openclaw.mjs`" %*`r`n",
  $utf8
)
$env:PATH = "$bin;$env:PATH"
if ((Get-Command openclaw).Source -ne $launcher) {
  throw 'Proof launcher did not resolve to the built CLI'
}

function Get-TelegramStoreRefId {
  param([string]$configPath)

  $document = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -AsHashtable
  $ref = $document.channels.telegram.botToken
  if ($ref -isnot [System.Collections.IDictionary] -or
      $ref.source -ne 'store' -or
      [string]::IsNullOrWhiteSpace([string]$ref.provider) -or
      [string]$ref.id -notmatch '^CHANNEL_SETUP_[0-9A-F]{32}$') {
    throw 'Gateway channel config did not contain the expected channel-setup SecretRef'
  }
  return [string]$ref.id
}

function Invoke-SecretStoreProbe {
  param(
    [ValidateSet('match', 'absent')][string]$expectation,
    [string]$stateDir,
    [string]$name,
    [string]$expectedValue = ''
  )

  if ($expectation -eq 'match') {
    $probeOutput = (
      $expectedValue |
        & node --import ./scripts/tsx.mjs $storeProbePath match $stateDir $name 2>&1 |
        Out-String
    )
    $probeExit = $LASTEXITCODE
    if (
      $probeExit -ne 0 -or
      $probeOutput -notmatch '(?m)^SECRET_STORE_VALUE_MATCH=true\s*$'
    ) {
      throw 'Synthetic secret-store value did not match in the selected state directory'
    }
    return
  }

  $probeOutput = (
    & node --import ./scripts/tsx.mjs $storeProbePath absent $stateDir $name 2>&1 |
      Out-String
  )
  $probeExit = $LASTEXITCODE
  if (
    $probeExit -ne 0 -or
    $probeOutput -notmatch '(?m)^SECRET_STORE_ENTRY_ABSENT=true\s*$'
  ) {
    throw 'Unexpected secret-store entry in the selected state directory'
  }
}

function Get-SecretStoreSnapshot {
  param([string]$stateDir)

  $snapshotOutput = (
    & node --import ./scripts/tsx.mjs $storeProbePath snapshot $stateDir 2>&1 |
      Out-String
  )
  $snapshotExit = $LASTEXITCODE
  if (
    $snapshotExit -ne 0 -or
    $snapshotOutput -notmatch '(?m)^SECRET_STORE_SNAPSHOT=[a-f0-9]{64}\s*$'
  ) {
    throw 'Could not read the active secret-store metadata snapshot'
  }
  return [regex]::Match(
    $snapshotOutput,
    '(?m)^SECRET_STORE_SNAPSHOT=[a-f0-9]{64}'
  ).Value
}

$storeProbeSource = @'
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  listSecretStoreEntries,
  readSecretStoreValue,
} from "./src/secrets/store/secret-store.ts";
import { closeOpenClawStateDatabaseAsync } from "./src/state/openclaw-state-db.ts";

function report(label: string, passed: boolean) {
  process.stdout.write(`${label}=${passed}\n`);
  if (!passed) {
    process.exitCode = 1;
  }
}

async function readStdinValue(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r?\n$/, "");
}

async function main() {
  const [mode, stateDir, name] = process.argv.slice(2);
  if (!mode || !stateDir || (mode !== "snapshot" && !name)) {
    throw new Error("invalid probe arguments");
  }
  if (
    (mode === "absent" || mode === "snapshot") &&
    !existsSync(path.join(stateDir, "state", "openclaw.sqlite"))
  ) {
    if (mode === "absent") {
      report("SECRET_STORE_ENTRY_ABSENT", true);
    } else {
      process.stdout.write(`SECRET_STORE_SNAPSHOT=${createHash("sha256").update("[]").digest("hex")}\n`);
    }
    return;
  }
  try {
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const entries = await listSecretStoreEntries({
      scope: { kind: "team" },
      database,
    });
    if (mode === "snapshot") {
      const stableEntries = entries
        .map((entry) => [entry.name, entry.kind, entry.createdAtMs, entry.updatedAtMs])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
      const digest = createHash("sha256").update(JSON.stringify(stableEntries)).digest("hex");
      process.stdout.write(`SECRET_STORE_SNAPSHOT=${digest}\n`);
      return;
    }
    const metadata = entries.find((entry) => entry.name === name);
    if (mode === "absent") {
      report("SECRET_STORE_ENTRY_ABSENT", metadata === undefined);
      return;
    }
    if (mode !== "match") {
      throw new Error("invalid probe mode");
    }
    const result = await readSecretStoreValue({
      scope: { kind: "team" },
      name,
      database,
    });
    const expectedValue = await readStdinValue();
    report(
      "SECRET_STORE_VALUE_MATCH",
      metadata?.kind === "secret" && result.ok && result.value === expectedValue,
    );
  } finally {
    await closeOpenClawStateDatabaseAsync();
  }
}

void main().catch((error: unknown) => {
  const label = error instanceof Error ? error.name : "unknown";
  process.stdout.write(`SECRET_STORE_PROBE_ERROR=${label}\n`);
  process.exitCode = 2;
});
'@

$env:NO_COLOR = '1'
$env:OPENCLAW_HOME = $root
$env:OPENCLAW_STATE_DIR = $gatewayState
$env:OPENCLAW_CONFIG_PATH = $gatewayConfig
$env:OPENCLAW_GATEWAY_PORT = [string]$port
$env:OPENCLAW_SKIP_CHANNELS = '1'
$env:OPENCLAW_SKIP_CRON = '1'
$env:OPENCLAW_SKIP_GMAIL_WATCHER = '1'
$env:OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = '1'
$env:OPENCLAW_SKIP_CANVAS_HOST = '1'
$env:OPENCLAW_DISABLE_BUNDLED_PLUGINS = '1'
$gatewayOut = Join-Path $root 'gateway.out'
$gatewayErr = Join-Path $root 'gateway.err'
$gateway = Start-Process `
  -FilePath (Get-Command node).Source `
  -ArgumentList @("`"$repo\openclaw.mjs`"", 'gateway', 'run', '--allow-unconfigured') `
  -PassThru `
  -RedirectStandardOutput $gatewayOut `
  -RedirectStandardError $gatewayErr

try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if ($gateway.HasExited) {
      throw "Gateway exited early with code $($gateway.ExitCode)"
    }
    try {
      $tcp = [Net.Sockets.TcpClient]::new('127.0.0.1', $port)
      $tcp.Dispose()
      $ready = $true
      break
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  if (-not $ready) {
    throw 'Isolated local Gateway did not become ready'
  }
  if (Test-Path -LiteralPath $storeProbePath) {
    throw 'Unexpected pre-existing secret-store proof helper'
  }
  $storeProbeCreated = $true
  [IO.File]::WriteAllText($storeProbePath, $storeProbeSource, $utf8)

  $env:OPENCLAW_SKIP_CHANNELS = '0'
  $env:OPENCLAW_DISABLE_BUNDLED_PLUGINS = '0'
  Remove-Item Env:OPENCLAW_DEBUG -ErrorAction SilentlyContinue

  $env:OPENCLAW_STATE_DIR = $gatewayState
  $env:OPENCLAW_CONFIG_PATH = $gatewayConfig
  $matching = (& openclaw channels add --channel telegram --token $controlToken 2>&1 | Out-String)
  $matchingExit = $LASTEXITCODE
  if ($matchingExit -ne 0 -or $matching -match 'different state directories|Fix: in PowerShell') {
    throw "Matching Gateway state control failed: $($matching.Replace($gatewayAuthToken, '[synthetic]').Replace($controlToken, '[synthetic]'))"
  }
  $matchingRefId = Get-TelegramStoreRefId $gatewayConfig
  Invoke-SecretStoreProbe 'match' $gatewayState $matchingRefId $controlToken
  Write-Output 'MATCHING_GUARDED_ACTION_CONTROL=PASS'
  Write-Output 'MATCHING_CONTROL_SECRETREF_AND_GATEWAY_STORE=PASS'

  $env:OPENCLAW_STATE_DIR = $cliState
  $env:OPENCLAW_CONFIG_PATH = $cliConfig
  $priorState = $env:OPENCLAW_STATE_DIR
  $priorConfig = $env:OPENCLAW_CONFIG_PATH
  $gatewayBeforeRefusal = [IO.File]::ReadAllText($gatewayConfig)
  $cliBeforeRefusal = [IO.File]::ReadAllText($cliConfig)
  $gatewayStoreBeforeRefusal = Get-SecretStoreSnapshot $gatewayState
  $cliStoreBeforeRefusal = Get-SecretStoreSnapshot $cliState
  $refusal = (& openclaw channels add --channel telegram --token $repairToken 2>&1 | Out-String)
  $refusalExit = $LASTEXITCODE
  if ($refusalExit -eq 0) {
    throw 'Mismatched CLI unexpectedly succeeded'
  }
  if ($refusal.Contains($gatewayAuthToken) -or $refusal.Contains($controlToken) -or $refusal.Contains($repairToken)) {
    throw 'CLI refusal exposed a synthetic token'
  }
  if ((Get-SecretStoreSnapshot $gatewayState) -ne $gatewayStoreBeforeRefusal) {
    throw 'CLI refusal changed the Gateway secret-store metadata snapshot'
  }
  if ((Get-SecretStoreSnapshot $cliState) -ne $cliStoreBeforeRefusal) {
    throw 'CLI refusal changed the CLI secret-store metadata snapshot'
  }
  Write-Output 'CLI_REFUSAL_SECRET_STORE_METADATA_SNAPSHOTS_UNCHANGED=PASS'

  if ($Mode -eq 'baseline') {
    if ($refusal -notmatch 'The CLI command failed\.' -or $refusal -notmatch 'For help, run `openclaw doctor`') {
      throw "Baseline CLI did not reproduce generic failure output: $refusal"
    }
    if ($refusal -match 'No credentials or configuration were written') {
      throw 'Baseline CLI unexpectedly exposed the refusal reason'
    }
    $posixHint = "OPENCLAW_STATE_DIR='$gatewayState' OPENCLAW_CONFIG_PATH='$gatewayConfig' openclaw channels add"
    $powershellOutput = (& powershell.exe -NoLogo -NoProfile -NonInteractive -Command $posixHint 2>&1 | Out-String)
    $powershellExit = $LASTEXITCODE
    if ($powershellExit -eq 0 -or $powershellOutput -notmatch 'not recognized') {
      throw 'The POSIX assignment unexpectedly ran in Windows PowerShell'
    }
    $global:LASTEXITCODE = 0
    if ([IO.File]::ReadAllText($gatewayConfig) -ne $gatewayBeforeRefusal) {
      throw 'Baseline refusal unexpectedly changed Gateway config'
    }
    if ([IO.File]::ReadAllText($cliConfig) -ne $cliBeforeRefusal) {
      throw 'Baseline refusal unexpectedly changed CLI config'
    }
    Write-Output 'BASELINE_CLI_GENERIC_REFUSAL=PASS'
    Write-Output 'BASELINE_POSIX_HINT_POWERSHELL_FAILURE=PASS'
  } else {
    if ($refusal -notmatch 'No credentials or configuration were written') {
      throw "Candidate CLI did not explain the refusal: $($refusal.Replace($gatewayAuthToken, '[synthetic]'))"
    }
    if ($refusal -match 'For help, run `openclaw doctor`') {
      throw 'Candidate refusal remained hidden behind generic doctor guidance'
    }
    $match = [regex]::Match(
      $refusal,
      '(?s)Fix: in PowerShell, run (?<repair>& \{.*?\})\. To write another local store'
    )
    if (-not $match.Success) {
      throw "Candidate CLI did not emit an executable PowerShell repair block: $($refusal.Replace($gatewayAuthToken, '[synthetic]'))"
    }
    $repair = $match.Groups['repair'].Value
    if (-not $repair.Contains('& openclaw channels add } finally')) {
      throw 'Repair block targets an unexpected CLI action'
    }
    if ([IO.File]::ReadAllText($gatewayConfig) -ne $gatewayBeforeRefusal) {
      throw 'Refused candidate CLI changed Gateway config'
    }
    if ([IO.File]::ReadAllText($cliConfig) -ne $cliBeforeRefusal) {
      throw 'Refused candidate CLI changed CLI config'
    }
    $global:LASTEXITCODE = 0

    $withArgs = $repair.Replace(
      '& openclaw channels add } finally',
      "& openclaw channels add --channel telegram --token $repairToken } finally"
    )
    $repairOutput = (Invoke-Expression $withArgs 2>&1 | Out-String)
    $repairExit = $LASTEXITCODE
    if ($repairExit -ne 0) {
      throw "PowerShell repair command failed with exit ${repairExit}: $($repairOutput.Replace($repairToken, '[synthetic]'))"
    }
    $global:LASTEXITCODE = 0
    if ($env:OPENCLAW_STATE_DIR -ne $priorState -or $env:OPENCLAW_CONFIG_PATH -ne $priorConfig) {
      throw 'PowerShell repair did not restore the caller environment'
    }
    $gatewayAfterRepair = [IO.File]::ReadAllText($gatewayConfig)
    if ([IO.File]::ReadAllText($cliConfig) -ne $cliBeforeRefusal) {
      throw 'Repair wrote to the CLI config instead of Gateway config'
    }
    if ((Get-SecretStoreSnapshot $cliState) -ne $cliStoreBeforeRefusal) {
      throw 'Repair changed the CLI secret-store metadata snapshot'
    }
    $repairRefId = Get-TelegramStoreRefId $gatewayConfig
    if ($repairRefId -eq $matchingRefId) {
      throw 'Repair reused the matching-state control SecretRef instead of writing the requested value'
    }
    if ($gatewayAfterRepair -eq $gatewayBeforeRefusal) {
      throw 'Repair did not update the Gateway config with the repair SecretRef'
    }
    if ($gatewayAfterRepair.Contains($controlToken) -or $gatewayAfterRepair.Contains($repairToken)) {
      throw 'Gateway config exposed a synthetic channel token instead of a SecretRef'
    }
    Invoke-SecretStoreProbe 'match' $gatewayState $matchingRefId $controlToken
    Invoke-SecretStoreProbe 'match' $gatewayState $repairRefId $repairToken
    Invoke-SecretStoreProbe 'absent' $cliState $matchingRefId
    Invoke-SecretStoreProbe 'absent' $cliState $repairRefId
    Write-Output 'CANDIDATE_CLI_REFUSAL_AND_SECRET_OMISSION=PASS'
    Write-Output 'BUILT_CLI_REPAIR_WRITES_GATEWAY_CONFIG_AND_STORE_ONLY=PASS'
    Write-Output 'POWERSHELL_CALLER_ENV_RESTORED=PASS'
  }
  Write-Output "MODE=$Mode"
  Write-Output 'WINDOWS_SHIPPED_CLI_PROOF=PASS'
} finally {
  try {
    if ($storeProbeCreated -and (Test-Path -LiteralPath $storeProbePath)) {
      Remove-Item -LiteralPath $storeProbePath -Force
    }
  } finally {
    if (-not $gateway.HasExited) {
      Stop-Process -Id $gateway.Id -Force
    }
  }
}
