import { useEffect, useRef, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import {
  RECOVERY_TITLE,
  RetryNowButton,
  useInlineRecovery,
} from "../../features/relay/RecoveryNotice";
import { liveRecoveryStatus } from "../../features/relay/live-recovery";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./LiveStatus.module.css";

export function LiveStatus({
  live,
  channelId,
  partialRoster,
  diagnostics = false,
  recovery,
  onRecovered,
}: {
  live: RelaySession["live"];
  channelId: string | undefined;
  partialRoster: boolean;
  diagnostics?: boolean;
  /** The session recovery owner. A mounted status shows its notice inline
   * above the composer, in place of the floating fallback. */
  recovery?: RelaySession["recovery"];
  /** A recovery or retry control that had focus went away; move focus on. */
  onRecovered?: (() => void) | undefined;
}) {
  const { recovering: retrying, shown } = useInlineRecovery(
    diagnostics ? undefined : recovery,
  );
  // A removed element does not always report blur, so check where focus
  // landed once the notice is gone.
  const focused = useRef(false);
  useEffect(() => {
    if (shown || !focused.current) return;
    focused.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) onRecovered?.();
  }, [shown, onRecovered]);
  const snapshot = useSyncExternalStore(
    live.subscribe,
    live.snapshot,
    live.snapshot,
  );
  const route = channelId
    ? snapshot.routes.find((route) => route.channelId === channelId)
    : undefined;
  const head = snapshot.heads.find((head) => head.channelId === channelId);
  const globals = snapshot.routes.filter((route) => !route.channelId);
  const relevant = [...(route ? [route] : []), ...globals];
  const recovering = relevant.filter((route) => {
    const quota = /^rate-limited: quota exceeded; retry in (\d+)s$/.exec(
      route.error ?? "",
    );
    return (
      snapshot.status === "connected" &&
      route.status === "pending" &&
      quota !== null &&
      Number(quota[1]) <= 60
    );
  });
  // Only bounded automatic WS quota recovery is quiet. Do not let it mask an
  // actionable failure in another route, connection, roster or finite head.
  const actionable = relevant.filter((route) => !recovering.includes(route));
  const routeError = actionable.find((route) => route.error)?.error;
  const error =
    snapshot.error ?? snapshot.roster.error ?? head?.error ?? routeError;
  const incompleteRoster =
    partialRoster && snapshot.roster.state === "verified";
  const issue =
    ["unavailable", "retrying", "error"].includes(snapshot.status) ||
    error !== undefined ||
    actionable.some((route) => ["error", "limited"].includes(route.status)) ||
    head?.state === "error" ||
    ["error", "deferred"].includes(snapshot.roster.state) ||
    incompleteRoster;
  const reason = error?.includes("rate-limited: quota exceeded")
    ? "A relay request was rate-limited; recovery needs attention."
    : (error ??
      (incompleteRoster
        ? "Some channels are missing from the current roster."
        : ["error", "deferred"].includes(snapshot.roster.state)
          ? "Channel list needs refreshing."
          : "Live updates are unavailable."));
  if (diagnostics) {
    const connecting =
      snapshot.status === "connecting" ||
      (channelId && route?.status !== "live") ||
      globals.some((route) => route.status === "pending");
    return (
      <>
        <p>
          Live updates:{" "}
          {issue
            ? reason
            : recovering.length
              ? "recovering automatically after rate limiting; awaiting confirmation"
              : connecting
                ? "connecting"
                : "stream established"}
        </p>
        {(error || recovering[0]?.error) && (
          <p>Last rejection: {error ?? recovering[0]?.error}</p>
        )}
      </>
    );
  }
  if (recovery && shown)
    return (
      <section
        role="status"
        aria-label={RECOVERY_TITLE}
        className={styles.recovery}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={(event) => {
          focused.current = event.currentTarget.contains(
            event.relatedTarget as Node | null,
          );
        }}
      >
        <div className={styles.message}>
          <p className="text-label-sm text-warning">{RECOVERY_TITLE}</p>
        </div>
        <RetryNowButton recovery={recovery} />
      </section>
    );
  // Startup, bounded automatic quota recovery and the first automatic retry do
  // not need user attention.
  if (!issue || (retrying && liveRecoveryStatus(snapshot) !== "settled"))
    return null;
  // What automatic recovery cannot change: capacity, a partial roster, a
  // denial or a sign-in failure. Capacity and a partial roster stay passive.
  // A failure the user can fix (signer, access) keeps an explicit retry,
  // because recovery and wake signals skip it.
  const manual =
    liveRecoveryStatus(snapshot) === "settled" &&
    (snapshot.status === "error" ||
      actionable.some((route) => route.status === "error") ||
      head?.state === "error" ||
      snapshot.roster.state === "error");
  return (
    <section
      role="status"
      aria-label="Live updates limited"
      className={styles.recovery}
    >
      <div className={styles.message}>
        <p className="text-label-sm text-warning">Live updates limited</p>
        <p className="text-body-sm text-subtle">
          {reason} Only currently accessible messages remain readable.
        </p>
      </div>
      {manual && (
        <Button
          type="button"
          size="sm"
          onClick={() => {
            live.retry();
            // Retry removes this focused control; hand focus on explicitly.
            onRecovered?.();
          }}
        >
          Retry live updates
        </Button>
      )}
    </section>
  );
}
