import { Button } from "../../shared/design-system/ui/Button";
import { useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import styles from "./LiveStatus.module.css";

export function LiveStatus({
  live,
  channelId,
  partialRoster,
  diagnostics = false,
  onRetry,
}: {
  live: RelaySession["live"];
  channelId: string | undefined;
  partialRoster: boolean;
  diagnostics?: boolean;
  onRetry?: (() => void) | undefined;
}) {
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
  // Startup and bounded automatic quota recovery do not need user attention.
  if (!issue) return null;
  return (
    <section
      role="status"
      aria-label="Live updates need attention"
      className={styles.recovery}
    >
      <div className={styles.message}>
        <p className="text-label-sm text-warning">
          Live updates need attention
        </p>
        <p className="text-body-sm text-subtle">
          {reason} Only currently accessible messages remain readable.
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        onClick={() => {
          live.retry();
          onRetry?.();
        }}
      >
        Retry live updates
      </Button>
    </section>
  );
}
