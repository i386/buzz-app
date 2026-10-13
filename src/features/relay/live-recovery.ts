import type { RecoveryStatus } from "./recovery";
import type { LiveSnapshot } from "./live";

/** The parts of a session's live view that recovery classifies. */
export type LiveRecoveryView = LiveSnapshot &
  Readonly<{
    roster: Readonly<{ state: string; transient?: true }>;
    heads: readonly Readonly<{ state: string; transient?: true }>[];
    previews?: "checking" | "suspended";
  }>;

/** A CLOSED reason that a later attempt can clear. NIP-01 machine prefixes:
 * `rate-limited:` and `error:` are transient; `restricted:`, `blocked:` and
 * `invalid:` need someone to act. Local setup timeouts and exhausted quota
 * retries are transient too. */
export function isTransientLiveError(reason: string | undefined): boolean {
  return (
    !!reason &&
    (reason.startsWith("rate-limited:") ||
      reason.startsWith("error:") ||
      reason === "Live subscription setup timed out; retry available" ||
      reason === "Live request cooldown retries exhausted; retry available")
  );
}

/** How the live layer looks to session recovery. Only failures a retry can
 * fix count as failed. A terminal sign-in error, a denial or invalid traffic
 * is settled here and stays visible in live status instead. */
export function liveRecoveryStatus(view: LiveRecoveryView): RecoveryStatus {
  // "retrying" counts as failed so wake, network and focus signals skip the
  // live layer's own backoff wait too.
  if (
    view.status === "retrying" ||
    view.previews === "suspended" ||
    view.roster.state === "deferred" ||
    (view.roster.state === "error" && view.roster.transient) ||
    view.heads.some((head) => head.state === "error" && head.transient) ||
    view.routes.some(
      (route) => route.status === "error" && isTransientLiveError(route.error),
    )
  )
    return "failed";
  // A retried read in flight is not proof of recovery. Reporting it as
  // settled would reset the delay and loop the retry every second.
  return view.status === "connecting" ||
    view.previews === "checking" ||
    view.roster.state === "pending" ||
    view.heads.some((head) => head.state === "pending") ||
    view.routes.some((route) => route.status === "pending")
    ? "busy"
    : "settled";
}
