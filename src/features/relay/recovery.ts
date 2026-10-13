/** One automatic recovery owner for a relay session's background reads.
 *
 * Each source reports whether it currently shows a failure. While any source
 * fails, recovery retries every failed source with a capped exponential delay.
 * It never gives up. A wake, network or success signal retries at once.
 *
 * Sources are background reads only. User actions (sends, moves, deletes) own
 * their own Retry because repeating them silently could repeat a user intent. */
export type RecoveryStatus = "failed" | "busy" | "settled";
export type RecoverySource = Readonly<{
  status(): RecoveryStatus;
  subscribe(listener: () => void): () => void;
  retry(): void;
}>;
export type RecoverySnapshot = Readonly<{
  /** True while at least one source shows a failure. */
  recovering: boolean;
  /** Backoff index. retryNow restarts it; it does not hide the notice. */
  attempt: number;
  /** True from the first automatic retry until every source settles. Kept
   * apart from `attempt` so a manual or signal retry keeps the notice up. */
  shown: boolean;
}>;
export type RelayRecovery = Readonly<{
  snapshot(): RecoverySnapshot;
  subscribe(listener: () => void): () => void;
  /** Retry failed sources now and restart the delay sequence. `except` skips
   * a source that already owns its own recovery for the triggering event. */
  retryNow(except?: RecoverySource): void;
  dispose(): void;
}>;

export const RECOVERY_DELAYS_MS = Object.freeze([
  1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
]);
const IDLE: RecoverySnapshot = Object.freeze({
  recovering: false,
  attempt: 0,
  shown: false,
});

export function createRecovery(
  sources: readonly RecoverySource[],
  timers: Readonly<{
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  }> = {
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): RelayRecovery {
  const listeners = new Set<() => void>();
  let snapshot = IDLE,
    attempt = 0,
    shown = false,
    timer: unknown,
    running = false,
    disposed = false;
  const publish = (next: RecoverySnapshot) => {
    if (
      next.recovering === snapshot.recovering &&
      next.attempt === snapshot.attempt &&
      next.shown === snapshot.shown
    )
      return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  const cancel = () => {
    if (timer === undefined) return;
    timers.clearTimeout(timer);
    timer = undefined;
  };
  function evaluate() {
    if (disposed || running) return;
    const states = sources.map((source) => source.status());
    if (!states.includes("failed")) {
      cancel();
      // A retry in flight is not proof of recovery: keep the notice and the
      // delay sequence until every source settles.
      if (snapshot.recovering && states.includes("busy")) {
        publish(Object.freeze({ recovering: true, attempt, shown }));
        return;
      }
      attempt = 0;
      shown = false;
      publish(IDLE);
      return;
    }
    publish(Object.freeze({ recovering: true, attempt, shown }));
    if (timer !== undefined) return;
    const delay =
      RECOVERY_DELAYS_MS[Math.min(attempt, RECOVERY_DELAYS_MS.length - 1)] ??
      30_000;
    timer = timers.setTimeout(() => {
      timer = undefined;
      attempt++;
      shown = true;
      run();
    }, delay);
  }
  function run(except?: RecoverySource) {
    if (disposed) return;
    // Retries can publish synchronously; evaluate once after all of them.
    running = true;
    try {
      for (const source of sources)
        if (source !== except && source.status() === "failed") source.retry();
    } finally {
      running = false;
    }
    evaluate();
  }
  const stops = sources.map((source) => source.subscribe(evaluate));
  evaluate();
  return Object.freeze({
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retryNow(except?: RecoverySource) {
      if (disposed) return;
      cancel();
      attempt = 0;
      run(except);
    },
    dispose() {
      disposed = true;
      cancel();
      for (const stop of stops) stop();
      listeners.clear();
    },
  });
}
