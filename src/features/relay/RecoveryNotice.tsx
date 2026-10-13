import { useEffect, useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import type { RelayRecovery } from "./recovery";

const NONE = Object.freeze({ recovering: false, attempt: 0 });
const subscribeNone = () => () => {};
const snapshotNone = () => NONE;
const noClaims = () => 0;

/** Inline surfaces that currently show the recovery notice themselves. Lasting
 * recovery belongs inline above a composer (see DESIGN.md); the floating toast
 * is only the fallback for pages without such a surface. */
const claims = new WeakMap<
  RelayRecovery,
  { count: number; listeners: Set<() => void> }
>();
const claimsOf = (recovery: RelayRecovery) => {
  const existing = claims.get(recovery);
  if (existing) return existing;
  const entry = { count: 0, listeners: new Set<() => void>() };
  claims.set(recovery, entry);
  return entry;
};
const changeClaims = (recovery: RelayRecovery, delta: number) => {
  const entry = claimsOf(recovery);
  entry.count += delta;
  for (const listener of [...entry.listeners]) listener();
};

/** Recovery state for one surface. `shown` is true while the notice is
 * visible; `recovering` is true from the first failure, including the quiet
 * first second before the notice appears. */
export function useRecovery(recovery: RelayRecovery | undefined) {
  const state = useSyncExternalStore(
    recovery?.subscribe ?? subscribeNone,
    recovery?.snapshot ?? snapshotNone,
    recovery?.snapshot ?? snapshotNone,
  );
  return {
    recovering: !!recovery && state.recovering,
    // Stay hidden for a failure that the first automatic retry fixes.
    shown: !!recovery && state.recovering && state.attempt >= 1,
  };
}

/** True while the one recovery notice is visible. Surfaces whose failure
 * the notice already reports hide their own copy of it. */
export function useRecoveryShown(recovery: RelayRecovery | undefined) {
  return useRecovery(recovery).shown;
}

/** Claim the notice for an inline surface while it is mounted. */
export function useInlineRecovery(recovery: RelayRecovery | undefined) {
  useEffect(() => {
    if (!recovery) return;
    changeClaims(recovery, 1);
    return () => changeClaims(recovery, -1);
  }, [recovery]);
  return useRecovery(recovery);
}

export const RECOVERY_TITLE = "Reconnecting to relay…";
export const RECOVERY_DESCRIPTION =
  "Buzz keeps retrying automatically. What is already loaded stays readable.";

export function RetryNowButton({ recovery }: { recovery: RelayRecovery }) {
  return (
    <Button type="button" size="sm" onClick={() => recovery.retryNow()}>
      Retry now
    </Button>
  );
}

/** The fallback floating recovery notice for background relay reads. */
export function RecoveryNotice({
  recovery,
}: {
  recovery: RelayRecovery | undefined;
}) {
  const shown = useRecoveryShown(recovery);
  const inline = useSyncExternalStore(
    recovery
      ? (listener: () => void) => {
          const entry = claimsOf(recovery);
          entry.listeners.add(listener);
          return () => {
            entry.listeners.delete(listener);
          };
        }
      : subscribeNone,
    recovery ? () => claimsOf(recovery).count : noClaims,
    recovery ? () => claimsOf(recovery).count : noClaims,
  );
  if (!recovery || !shown || inline > 0) return null;
  return (
    <ToastNotice
      title={RECOVERY_TITLE}
      description={RECOVERY_DESCRIPTION}
      tone="warning"
    >
      <RetryNowButton recovery={recovery} />
    </ToastNotice>
  );
}
