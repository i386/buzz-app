import {
  acknowledge,
  conflict,
  heads,
  mergeList,
  type KnownRecord,
  type ListedCommunity,
  type SyncStatus,
} from "../../../features/communities/known-communities";
import type { KnownCommunities } from "../../../features/communities/service";
import type { OAuthSession } from "../oauth/session";
import type { KnownCommunitiesClient, Refusal } from "./client";

/** Why the service refused, in the viewer's terms. */
const REASONS: Record<
  Exclude<Refusal["kind"], "identity_mismatch" | "rejected">,
  string
> = {
  invalid_request: "Builderlab refused one of your community addresses.",
  forbidden: "This Builderlab account can’t sync communities.",
  limit_reached: "Builderlab can’t save more communities for this account.",
};
const reason = (refusal: Exclude<Refusal, { kind: "identity_mismatch" }>) =>
  refusal.kind === "rejected"
    ? `Builderlab refused this request (HTTP ${refusal.status}).`
    : REASONS[refusal.kind];
const backoff = (failures: number) => Math.min(60_000, 1000 * 2 ** failures);
/** The record is kept under the destination's key; its own address stays out. */
const known = ({ revision, removed }: ListedCommunity): KnownRecord => ({
  revision,
  removed,
});

/** Drains the known-community outbox to the account service and reconciles
 * its list, for one plugin lifetime. It runs only while signed in: each
 * sign-in checks that the account's bound key is this device's identity
 * (never binding it), merges the complete server list, then uploads queued
 * operations one at a time, so a destination never has two in flight and a
 * retry re-sends the identical request under the same operation ID. A newly
 * queued operation, the window coming online or becoming visible runs it
 * again at once; a failure retries at 1·2·4… s, capped at a minute. Only a
 * destination's head is sent; an intent queued behind it waits for the head
 * to settle. The service's refusals are not retried: a mismatched binding
 * stops everything until the next sign-in, as does an account that cannot
 * sync, while a refused address, a full account or another client error parks
 * that one operation. Signing out or disposal abandons in-flight work and
 * leaves the outbox intact. */
export function startKnownCommunitiesSync({
  client,
  session,
  knownCommunities,
}: {
  client: KnownCommunitiesClient;
  session: OAuthSession;
  knownCommunities: KnownCommunities;
}) {
  let disposed = false;
  // One per signed-in span; absent while signed out.
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let running = false;
  let rerun = false;
  let listed = false;
  let halted: "needs-binding" | "error" | undefined;
  let error: string | undefined;
  // Refused operations wait for the next sign-in, counted as pending meanwhile.
  const parked = new Set<string>();
  let outbox = knownCommunities.snapshot().sync.outbox;
  let ready = knownCommunities.snapshot().status === "ready";

  const publish = () => {
    if (disposed) return;
    const pending = knownCommunities.pending().length;
    const phase: SyncStatus["phase"] = !controller
      ? "signed-out"
      : halted === "needs-binding"
        ? "needs-binding"
        : running
          ? "syncing"
          : error
            ? "error"
            : pending
              ? "pending"
              : "synced";
    knownCommunities.status(
      phase === "error" && error
        ? { phase, pending, error }
        : { phase, pending },
    );
  };
  const refuse = (refusal: Refusal) => {
    if (refusal.kind === "identity_mismatch") halted = "needs-binding";
    else {
      halted = "error";
      error = reason(refusal);
    }
  };
  async function run() {
    if (disposed || !controller || halted || running) return;
    const snapshot = knownCommunities.snapshot();
    // The store's listener runs this again once the identity is ready.
    if (snapshot.status !== "ready" || !snapshot.viewer) return;
    clearTimeout(timer);
    timer = undefined;
    const { signal } = controller;
    const viewer = snapshot.viewer;
    running = true;
    rerun = false;
    publish();
    try {
      if (!listed) {
        const bound = await client.identity(signal);
        if (bound.kind !== "identity") return refuse(bound);
        // Binding is Hosted communities' job; here a different or missing
        // key only means the list belongs to another identity.
        if (bound.pubkey !== viewer)
          return refuse({ kind: "identity_mismatch" });
        const list = await client.list(viewer, signal);
        if (list.kind !== "listed") return refuse(list);
        signal.throwIfAborted();
        const current = knownCommunities.snapshot();
        const merged = mergeList(
          current.sync,
          current.memberships,
          list.communities,
        );
        await knownCommunities.apply(merged.state, {
          add: merged.add,
          remove: merged.remove,
        });
        listed = true;
      }
      for (;;) {
        const op = heads(knownCommunities.pending()).find(
          (entry) => !parked.has(entry.operationId),
        );
        if (!op) break;
        const result = await client.update(viewer, op, signal);
        signal.throwIfAborted();
        const state = knownCommunities.snapshot().sync;
        if (result.kind === "accepted")
          await knownCommunities.apply(
            acknowledge(state, op, known(result.record)),
          );
        else if (result.kind === "revision_conflict") {
          // The service wins: its record is adopted and followed, never
          // overwritten by re-sending the refused intent.
          const settled = conflict(
            state,
            op,
            result.record && known(result.record),
          );
          await knownCommunities.apply(
            settled.state,
            settled.divergence === "removed-elsewhere"
              ? { remove: [op.url] }
              : settled.divergence === "added-elsewhere"
                ? { add: [op.url] }
                : {},
          );
        } else if (
          result.kind === "identity_mismatch" ||
          result.kind === "forbidden"
        )
          return refuse(result);
        else {
          parked.add(op.operationId);
          error = reason(result);
        }
      }
      failures = 0;
      if (parked.size === 0) error = undefined;
    } catch (reason) {
      if (
        signal.aborted ||
        (reason instanceof Error && reason.name === "AbortError")
      )
        return;
      error =
        reason instanceof Error
          ? reason.message
          : "Couldn’t sync your community list.";
      timer = setTimeout(() => void run(), backoff(failures++));
    } finally {
      running = false;
      publish();
      if (rerun) void run();
    }
  }
  /** A trigger resets the backoff and runs now, or again once the request in
   * flight settles. */
  const kick = () => {
    if (disposed || !controller || halted) return;
    failures = 0;
    clearTimeout(timer);
    timer = undefined;
    if (running) rerun = true;
    else void run();
  };
  const onSession = () => {
    const signedIn = session.snapshot().status === "signed-in";
    if (signedIn && !controller) {
      controller = new AbortController();
      listed = false;
      halted = undefined;
      error = undefined;
      parked.clear();
      kick();
      // A run reports as it goes; a record still loading leaves none to run.
      if (!running) publish();
    } else if (!signedIn && controller) {
      controller.abort();
      controller = undefined;
      clearTimeout(timer);
      timer = undefined;
      publish();
    }
  };
  const onStore = () => {
    const snapshot = knownCommunities.snapshot();
    const wasReady = ready;
    ready = snapshot.status === "ready";
    if (snapshot.sync.outbox === outbox) {
      if (ready && !wasReady) kick();
      return;
    }
    const previous = outbox;
    outbox = snapshot.sync.outbox;
    // A queued intent this owner has not seen runs the drain at once; its own
    // acknowledgements only shrink or rebase the queue.
    const fresh = outbox.some(
      (op) => !previous.some((seen) => seen.operationId === op.operationId),
    );
    if (fresh || (ready && !wasReady)) kick();
    publish();
  };
  const online = () => kick();
  const visible = () => {
    if (document.visibilityState === "visible") kick();
  };
  const unsubscribeSession = session.subscribe(onSession);
  const unsubscribeStore = knownCommunities.subscribe(onStore);
  if (typeof window !== "undefined") window.addEventListener("online", online);
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", visible);
  onSession();
  publish();
  return () => {
    disposed = true;
    controller?.abort();
    controller = undefined;
    clearTimeout(timer);
    unsubscribeSession();
    unsubscribeStore();
    if (typeof window !== "undefined")
      window.removeEventListener("online", online);
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", visible);
    knownCommunities.status(undefined);
  };
}
