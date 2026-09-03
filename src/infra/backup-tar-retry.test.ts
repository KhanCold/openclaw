// Tests for backup tar archive write with EOF race retry.
import { describe, expect, it, vi } from "vitest";
import { writeTarArchiveWithRetry } from "./backup-tar-retry.js";

describe("writeTarArchiveWithRetry", () => {
  it("succeeds on first attempt", async () => {
    const runTar = vi.fn().mockResolvedValue("archive-data");
    const result = await writeTarArchiveWithRetry({
      tempArchivePath: "/tmp/backup.tar",
      runTar,
      sleepMs: vi.fn().mockResolvedValue(undefined),
    });
    expect(result).toBe("archive-data");
    expect(runTar).toHaveBeenCalledTimes(1);
    expect(runTar).toHaveBeenCalledWith("/tmp/backup.tar");
  });

  it("retries on EOF error and succeeds", async () => {
    const runTar = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("did not encounter expected EOF"), { code: "EOF" }))
      .mockResolvedValueOnce("archive-data");
    const sleepMs = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    const result = await writeTarArchiveWithRetry({
      tempArchivePath: "/tmp/backup.tar",
      runTar,
      sleepMs,
      log,
    });

    expect(result).toBe("archive-data");
    expect(runTar).toHaveBeenCalledTimes(2);
    expect(runTar).toHaveBeenNthCalledWith(1, "/tmp/backup.tar");
    expect(runTar).toHaveBeenNthCalledWith(2, "/tmp/backup.tar.retry-2");
    expect(sleepMs).toHaveBeenCalledTimes(1);
    expect(sleepMs).toHaveBeenCalledWith(10_000);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("retries twice on EOF error and succeeds", async () => {
    const runTar = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("encountered unexpected EOF"), { code: "EOF" }))
      .mockRejectedValueOnce(Object.assign(new Error("TAR_BAD_ARCHIVE"), { code: "EOF" }))
      .mockResolvedValueOnce("archive-data");
    const sleepMs = vi.fn().mockResolvedValue(undefined);

    const result = await writeTarArchiveWithRetry({
      tempArchivePath: "/tmp/backup.tar",
      runTar,
      sleepMs,
    });

    expect(result).toBe("archive-data");
    expect(runTar).toHaveBeenCalledTimes(3);
    expect(sleepMs).toHaveBeenCalledTimes(2);
    expect(sleepMs).toHaveBeenNthCalledWith(1, 10_000);
    expect(sleepMs).toHaveBeenNthCalledWith(2, 20_000);
  });

  it("throws after max attempts on EOF error", async () => {
    const err = Object.assign(new Error("did not encounter expected EOF"), { code: "EOF" });
    const runTar = vi.fn().mockRejectedValue(err);
    const sleepMs = vi.fn().mockResolvedValue(undefined);

    await expect(
      writeTarArchiveWithRetry({
        tempArchivePath: "/tmp/backup.tar",
        runTar,
        sleepMs,
      }),
    ).rejects.toThrow("Backup archive write failed");

    expect(runTar).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-EOF error", async () => {
    const runTar = vi.fn().mockRejectedValue(new Error("disk full"));

    await expect(
      writeTarArchiveWithRetry({
        tempArchivePath: "/tmp/backup.tar",
        runTar,
      }),
    ).rejects.toThrow("Backup archive write failed");

    expect(runTar).toHaveBeenCalledTimes(1);
  });

  it("does not retry on non-object error", async () => {
    const runTar = vi.fn().mockRejectedValue("string error");

    await expect(
      writeTarArchiveWithRetry({
        tempArchivePath: "/tmp/backup.tar",
        runTar,
      }),
    ).rejects.toThrow("Backup archive write failed");

    expect(runTar).toHaveBeenCalledTimes(1);
  });

  it("does not retry on null error", async () => {
    const runTar = vi.fn().mockRejectedValue(null);

    await expect(
      writeTarArchiveWithRetry({
        tempArchivePath: "/tmp/backup.tar",
        runTar,
      }),
    ).rejects.toThrow("Backup archive write failed");

    expect(runTar).toHaveBeenCalledTimes(1);
  });

  it("logs offending path when available", async () => {
    const err = Object.assign(new Error("encountered unexpected EOF"), {
      code: "EOF",
      path: "/data/file.txt",
    });
    const runTar = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce("ok");
    const log = vi.fn();

    await writeTarArchiveWithRetry({
      tempArchivePath: "/tmp/backup.tar",
      runTar,
      sleepMs: vi.fn().mockResolvedValue(undefined),
      log,
    });

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("/data/file.txt"),
    );
  });

  it("matches TAR_BAD_ARCHIVE in message", async () => {
    const runTar = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("TAR_BAD_ARCHIVE: corrupted"), { code: "EOF" }))
      .mockResolvedValueOnce("ok");

    const result = await writeTarArchiveWithRetry({
      tempArchivePath: "/tmp/backup.tar",
      runTar,
      sleepMs: vi.fn().mockResolvedValue(undefined),
    });

    expect(result).toBe("ok");
    expect(runTar).toHaveBeenCalledTimes(2);
  });

  it("includes attempt count in error message", async () => {
    const runTar = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(
      writeTarArchiveWithRetry({
        tempArchivePath: "/tmp/backup.tar",
        runTar,
      }),
    ).rejects.toThrow("after 1 attempt");
  });

  it("includes plural attempt count in error message", async () => {
    const err = Object.assign(new Error("EOF"), { code: "EOF" });
    const runTar = vi.fn().mockRejectedValue(err);

    await expect(
      writeTarArchiveWithRetry({
        tempArchivePath: "/tmp/backup.tar",
        runTar,
        sleepMs: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow("after 3 attempts");
  });

  it("uses default sleep when not provided", async () => {
    vi.useFakeTimers();
    const runTar = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("EOF"), { code: "EOF" }))
      .mockResolvedValueOnce("ok");

    // Don't pass sleepMs; should use default sleep import
    const promise = writeTarArchiveWithRetry({
      tempArchivePath: "/tmp/backup.tar",
      runTar,
    });

    await vi.advanceTimersByTimeAsync(10000);
    const result = await promise;

    expect(result).toBe("ok");
    vi.useRealTimers();
  });
});
