// Durable known-community sync state. Pure: every function returns a new
// state and never touches storage, sessions or the network. The service keeps
// this beside the memberships in the one device record, so a membership change
// and the intent to upload it are a single write. Destinations are keyed by the
// account service's `wss://host[:port]` spelling (see `relayAddress`).
import { relayAddress } from "./destination";

/** One intent awaiting upload: the latest word on its destination. A newer
 * intent replaces it outright, which is safe because the service's add and
 * remove are idempotent: whichever of them lands last is the state. */
export type PendingOp = { url: string; removed: boolean };
export type SyncState = {
  /** The destinations the service last reported holding. */
  known: string[];
  outbox: PendingOp[];
};
/** Membership changes a server list implies, as destination addresses. */
export type SyncChanges = { add?: string[]; remove?: string[] };
/** What the one sync owner reports while it runs, for the rail's indicator.
 * `pending` counts queued operations, including ones parked after a refusal. */
export type SyncStatus = {
  phase: "signed-out" | "syncing" | "synced" | "pending" | "error";
  pending: number;
  error?: string;
};

export const emptySync = (): SyncState => ({ known: [], outbox: [] });

const isAddress = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("wss://");

/** Reads the saved `sync` field. Records from before this field existed, or
 * ones this reader cannot understand, read as empty, and a malformed entry is
 * dropped on its own. The shape saved before the service's set model (records
 * with revisions, several operations per destination) reads as its live
 * records and each destination's newest operation. */
export function parseSync(raw: unknown): SyncState {
  if (!raw || typeof raw !== "object") return emptySync();
  const { known, outbox } = raw as Record<string, unknown>;
  const ops = Array.isArray(outbox)
    ? outbox.flatMap((op): PendingOp[] =>
        op &&
        typeof op === "object" &&
        "url" in op &&
        isAddress(op.url) &&
        "removed" in op &&
        typeof op.removed === "boolean"
          ? [{ url: op.url, removed: op.removed }]
          : [],
      )
    : [];
  return {
    known: Array.isArray(known)
      ? [...new Set(known.filter(isAddress))]
      : known && typeof known === "object"
        ? Object.entries(known).flatMap(([url, record]) =>
            isAddress(url) &&
            record &&
            typeof record === "object" &&
            (record as { removed?: unknown }).removed !== true
              ? [url]
              : [],
          )
        : [],
    outbox: ops.filter(
      (op, index) =>
        !ops.some((later, at) => at > index && later.url === op.url),
    ),
  };
}

/** Records a new intent for a destination, replacing any older one. Nothing
 * is queued when the latest word already says so: the pending intent, or the
 * service holding the destination. Removing a destination the service is not
 * known to hold still queues, in case another device saved it. */
export function enqueue(
  state: SyncState,
  url: string,
  removed: boolean,
): SyncState {
  const pending = state.outbox.find((op) => op.url === url);
  const latest = pending
    ? pending.removed
    : state.known.includes(url)
      ? false
      : undefined;
  if (latest === removed) return state;
  return {
    known: state.known,
    outbox: [...state.outbox.filter((op) => op.url !== url), { url, removed }],
  };
}

/** The service accepted `op`: it now holds the destination or no longer does.
 * The intent leaves the outbox unless a different one has replaced it since. */
export function acknowledge(state: SyncState, op: PendingOp): SyncState {
  const held = state.known.includes(op.url);
  return {
    known: op.removed
      ? held
        ? state.known.filter((url) => url !== op.url)
        : state.known
      : held
        ? state.known
        : [...state.known, op.url],
    outbox: state.outbox.filter(
      (entry) => entry.url !== op.url || entry.removed !== op.removed,
    ),
  };
}

/** Reconciles the complete server list with the device's memberships. The
 * list replaces what is known. A destination the service has that the device
 * lacks is added unless its removal is queued; a saved membership the service
 * held before but no longer lists was removed elsewhere and is removed unless
 * its re-add is queued; a saved membership the service has never seen is
 * queued for upload, which is how a device list from before sync existed
 * reaches the account. */
export function mergeList(
  state: SyncState,
  memberships: ReadonlyArray<{ id: string }>,
  list: string[],
): { state: SyncState; add: string[]; remove: string[] } {
  const known = [...new Set(list)];
  const local = new Set(memberships.map((m) => relayAddress(m.id)));
  const pending = new Map(state.outbox.map((op) => [op.url, op]));
  const add = known.filter(
    (url) => !local.has(url) && !pending.get(url)?.removed,
  );
  const remove = state.known.filter(
    (url) =>
      local.has(url) &&
      !known.includes(url) &&
      pending.get(url)?.removed !== false,
  );
  let next: SyncState = { known, outbox: state.outbox };
  for (const url of local)
    if (!known.includes(url) && !state.known.includes(url) && !pending.has(url))
      next = enqueue(next, url, false);
  return { state: next, add, remove };
}
