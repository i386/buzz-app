import {
  unresolved,
  unsupported,
  type StaffOutcome,
  type StaffRequest,
} from "../../features/relay-staff/contract";

/** One write and everything known about its attempts. */
export type Held<R extends StaffRequest = StaffRequest, M = unknown> = {
  /** The frozen request; null once the relay has settled it. */
  request: R | null;
  /** What the view showed when the write was started. */
  meta: M;
  sending: boolean;
  /** An attempt may have reached the relay without a definite answer. */
  uncertain: boolean;
  outcome: StaffOutcome<unknown> | null;
  /** The request the last finished attempt sent. */
  sent: R | null;
  /** The last attempt finished and no open view has handled it yet. */
  unseen: boolean;
};

/**
 * True when `outcome` settles a write. Before any uncertain attempt that is
 * anything `unresolved()` does not keep. After one, only the relay's own
 * answer to a request that was sent counts: a retry refused before sending,
 * refused for authorization, or answered by something without the route (an
 * old node mid-deploy) says nothing about the earlier attempt.
 */
function settles(outcome: StaffOutcome<unknown>, uncertain: boolean) {
  if (unresolved(outcome)) return false;
  if (!uncertain || outcome.ok) return true;
  const { failure } = outcome;
  return !failure.notSent && !failure.authLost && !unsupported(failure);
}

/**
 * The writes for one signer, admin host and relay. Entries outlive every
 * view; views subscribe, so a reply that lands after a screen was closed and
 * reopened still reaches it. Only the attempt that owns the current entry
 * may change it.
 */
export function createWrites() {
  const entries = new Map<string, Held>();
  const listeners = new Set<() => void>();
  const set = (key: string, entry: Held | null) => {
    if (entry) entries.set(key, entry);
    else entries.delete(key);
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get: (key: string) => entries.get(key) ?? null,
    /** Freezes `request` unless a write under `key` is still held. */
    freeze(key: string, request: StaffRequest, meta?: unknown) {
      if (entries.get(key)?.request) return false;
      set(key, {
        request,
        meta,
        sending: false,
        uncertain: false,
        outcome: null,
        sent: null,
        unseen: false,
      });
      return true;
    },
    /**
     * Claims the last finished attempt under `key` for the view that will
     * handle it: returns the entry once, then null until another finishes.
     */
    see(key: string) {
      const entry = entries.get(key);
      if (!entry?.unseen) return null;
      set(key, { ...entry, unseen: false });
      return entry;
    },
    /** Drops a held write the user gives up on; never while it is sending. */
    discard(key: string) {
      if (!entries.get(key)?.sending) set(key, null);
    },
    /**
     * Sends the held request under `key` unchanged. A request without a
     * `requestId` carries no identity to preserve, so `fresh` replaces it.
     */
    async run<R extends StaffRequest>(
      key: string,
      send: (request: R) => Promise<StaffOutcome<unknown>>,
      fresh?: R,
    ) {
      const held = entries.get(key);
      if (held?.sending) return null;
      const keep = held?.request && (!fresh || "requestId" in held.request);
      const request = (keep ? held.request : fresh) as R | undefined;
      if (!request) return null;
      const start: Held = {
        request,
        meta: keep ? held.meta : undefined,
        sending: true,
        uncertain: keep ? held.uncertain : false,
        outcome: null,
        sent: null,
        unseen: false,
      };
      set(key, start);
      const outcome = await send(request);
      if (entries.get(key)?.request !== request) return outcome;
      const done = {
        ...start,
        sending: false,
        outcome,
        sent: request,
        unseen: true,
      };
      set(
        key,
        settles(outcome, start.uncertain)
          ? { ...done, request: null, uncertain: false }
          : { ...done, uncertain: start.uncertain || unresolved(outcome) },
      );
      return outcome;
    },
  };
}
export type Writes = ReturnType<typeof createWrites>;
