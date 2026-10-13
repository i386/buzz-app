import type { RecoveryStatus } from "./recovery";
import type { LiveSnapshot } from "./live";

/** The parts of a session's live view that recovery classifies. */
export type LiveRecoveryView = LiveSnapshot &
  Readonly<{
    roster: Readonly<{ state: string; transient?: true }>;
    heads: readonly Readonly<{ state: string; transient?: true }>[];
    previews?: "checking" | "suspended";
  }>;

/** NIP-01 CLOSED prefixes that mean someone has to act: the same request
 * fails again until access, the request or the client changes. */
const PERMANENT_PREFIXES = [
  "restricted:",
  "blocked:",
  "invalid:",
  "auth-required:",
  "unsupported:",
  "pow:",
  "duplicate:",
];
/** Deterministic local failures (live.ts): retrying sends the same thing. */
const PERMANENT_LOCAL = new Set([
  "Relay supplied invalid live traffic",
  "Unsupported live cooldown; automatic setup stopped",
]);
/** A route failure that a later attempt can clear. Anything not known to
 * need action counts: relays use other and unprefixed reasons for outages,
 * and a capped retry costs little next to a live view that never recovers. */
export function isTransientLiveError(reason: string | undefined): boolean {
  if (reason === undefined) return true;
  return (
    !PERMANENT_LOCAL.has(reason) &&
    !PERMANENT_PREFIXES.some((prefix) => reason.startsWith(prefix))
  );
}

/** How the live layer looks to session recovery. Only failures a retry can
 * fix count as failed. A terminal sign-in error, a denial or invalid traffic
 * is settled here and stays visible in live status instead. */
export function liveRecoveryStatus(view: LiveRecoveryView): RecoveryStatus {
  // A terminal connection error closed the socket: its routes stay pending
  // but nothing is in flight. Finite roster and head reads still count.
  const routes = view.status === "error" ? [] : view.routes;
  // "retrying" counts as failed so wake, network and focus signals skip the
  // live layer's own backoff wait too.
  if (
    view.status === "retrying" ||
    view.previews === "suspended" ||
    view.roster.state === "deferred" ||
    (view.roster.state === "error" && view.roster.transient) ||
    view.heads.some((head) => head.state === "error" && head.transient) ||
    routes.some(
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
    routes.some((route) => route.status === "pending")
    ? "busy"
    : "settled";
}
