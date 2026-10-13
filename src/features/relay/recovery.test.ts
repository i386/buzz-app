import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createRecovery,
  RECOVERY_DELAYS_MS,
  type RecoveryStatus,
} from "./recovery";

function source(initial: RecoveryStatus = "settled") {
  let status = initial;
  const listeners = new Set<() => void>();
  const retry = vi.fn(() => set("busy"));
  function set(next: RecoveryStatus) {
    status = next;
    for (const listener of [...listeners]) listener();
  }
  return {
    status: () => status,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry,
    set,
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("retries a failed read forever with a capped delay", () => {
  const read = source();
  const recovery = createRecovery([read]);
  read.set("failed");
  expect(recovery.snapshot()).toEqual({ recovering: true, attempt: 0 });
  const delays = [...RECOVERY_DELAYS_MS, 30_000, 30_000, 30_000];
  for (const [index, delay] of delays.entries()) {
    vi.advanceTimersByTime(delay - 1);
    expect(read.retry).toHaveBeenCalledTimes(index);
    vi.advanceTimersByTime(1);
    expect(read.retry).toHaveBeenCalledTimes(index + 1);
    // The notice stays up while the retry runs, then the read fails again.
    expect(recovery.snapshot().recovering).toBe(true);
    read.set("failed");
  }
  recovery.dispose();
});

it("retries only the failed sources and clears once every source settles", () => {
  const failed = source();
  const healthy = source();
  const recovery = createRecovery([failed, healthy]);
  failed.set("failed");
  vi.advanceTimersByTime(RECOVERY_DELAYS_MS[0] ?? 0);
  expect(failed.retry).toHaveBeenCalledTimes(1);
  expect(healthy.retry).not.toHaveBeenCalled();
  expect(recovery.snapshot()).toEqual({ recovering: true, attempt: 1 });
  failed.set("settled");
  expect(recovery.snapshot()).toEqual({ recovering: false, attempt: 0 });
  vi.advanceTimersByTime(60_000);
  expect(failed.retry).toHaveBeenCalledTimes(1);
  recovery.dispose();
});

it("retryNow skips the wait and restarts the delay sequence", () => {
  const read = source();
  const recovery = createRecovery([read]);
  read.set("failed");
  for (const delay of RECOVERY_DELAYS_MS.slice(0, 4)) {
    vi.advanceTimersByTime(delay);
    read.set("failed");
  }
  expect(recovery.snapshot().attempt).toBe(4);
  recovery.retryNow();
  expect(read.retry).toHaveBeenCalledTimes(5);
  read.set("failed");
  expect(recovery.snapshot().attempt).toBe(0);
  vi.advanceTimersByTime(RECOVERY_DELAYS_MS[0] ?? 0);
  expect(read.retry).toHaveBeenCalledTimes(6);
  recovery.dispose();
});

it("retryNow does no work while every source is healthy", () => {
  const read = source();
  const recovery = createRecovery([read]);
  recovery.retryNow();
  expect(read.retry).not.toHaveBeenCalled();
  recovery.dispose();
});

it("dispose stops pending retries", () => {
  const read = source();
  const recovery = createRecovery([read]);
  read.set("failed");
  recovery.dispose();
  vi.advanceTimersByTime(120_000);
  expect(read.retry).not.toHaveBeenCalled();
});
