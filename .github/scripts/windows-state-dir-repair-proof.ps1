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
  Write-Output 'MATCHING_GUARDED_ACTION_CONTROL=PASS'

  $env:OPENCLAW_STATE_DIR = $cliState
  $env:OPENCLAW_CONFIG_PATH = $cliConfig
  $priorState = $env:OPENCLAW_STATE_DIR
  $priorConfig = $env:OPENCLAW_CONFIG_PATH
  $gatewayBeforeRefusal = [IO.File]::ReadAllText($gatewayConfig)
  $cliBeforeRefusal = [IO.File]::ReadAllText($cliConfig)
  $refusal = (& openclaw channels add --channel telegram --token $repairToken 2>&1 | Out-String)
  $refusalExit = $LASTEXITCODE
  if ($refusalExit -eq 0) {
    throw 'Mismatched CLI unexpectedly succeeded'
  }
  if ($refusal.Contains($gatewayAuthToken) -or $refusal.Contains($controlToken) -or $refusal.Contains($repairToken)) {
    throw 'CLI refusal exposed a synthetic token'
  }

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
    if ($gatewayAfterRepair -notmatch 'channels' -or $gatewayAfterRepair -notmatch [regex]::Escape($repairToken)) {
      throw 'Repair did not write the requested synthetic channel to Gateway config'
    }
    if ($gatewayAfterRepair.Contains($controlToken)) {
      throw 'Repair left the positive-control token instead of applying the requested value'
    }
    if ([IO.File]::ReadAllText($cliConfig) -ne $cliBeforeRefusal) {
      throw 'Repair wrote to the CLI config instead of Gateway config'
    }
    Write-Output 'CANDIDATE_CLI_REFUSAL_AND_SECRET_OMISSION=PASS'
    Write-Output 'BUILT_CLI_REPAIR_WRITES_GATEWAY_ONLY=PASS'
    Write-Output 'POWERSHELL_CALLER_ENV_RESTORED=PASS'
  }
  Write-Output "MODE=$Mode"
  Write-Output 'WINDOWS_SHIPPED_CLI_PROOF=PASS'
} finally {
  if (-not $gateway.HasExited) {
    Stop-Process -Id $gateway.Id -Force
  }
}
