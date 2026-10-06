// Durable known-community sync state. Pure: every function returns a new
// state and never touches storage, sessions or the network. The service keeps
// this beside the memberships in the one device record, so a membership change
// and the intent to upload it are a single write. Destinations are keyed by the
// account service's `wss://host[:port]` spelling (see `relayAddress`).
import { relayAddress } from "./destination";

/** The server's last known record for a destination. Tombstones are kept for
 * their revision and never shown as memberships. */
export type KnownRecord = { revision: number; removed: boolean };
/** One intent awaiting upload. A destination has at most two, in outbox order:
 * a head, which may already have been sent and so is never replaced, and is
 * the only one the drain dispatches; and one intent queued behind it, which is
 * not sent until the head settles and is replaced by any newer intent
 * meanwhile. A queued intent's fence is provisional until then. */
export type PendingOp = {
  operationId: string;
  url: string;
  expectedRevision: number;
  removed: boolean;
};
export type SyncState = {
  known: Record<string, KnownRecord>;
  outbox: PendingOp[];
};
export type ListedCommunity = KnownRecord & { url: string };
/** Membership changes a server list implies, as destination addresses. */
export type SyncChanges = { add?: string[]; remove?: string[] };
/** How a conflicting server record contradicts the local membership, once no
 * local intent for that destination remains to resolve it. */
export type Divergence = "removed-elsewhere" | "added-elsewhere" | null;
/** What the one sync owner reports while it runs, for the rail's indicator.
 * `pending` counts queued operations, including ones parked after a refusal. */
export type SyncStatus = {
  phase:
    | "signed-out"
    | "needs-binding"
    | "syncing"
    | "synced"
    | "pending"
    | "error";
  pending: number;
  error?: string;
};

export const emptySync = (): SyncState => ({ known: {}, outbox: [] });

const isRevision = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;
const isAddress = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("wss://");
const forUrl = (outbox: PendingOp[], url: string) =>
  outbox.filter((op) => op.url === url);

/** Reads the saved `sync` field. Records from before this field existed, or
 * ones this reader cannot understand, read as empty; malformed entries are
 * dropped individually, and a destination keeps only its first and last
 * operation (the possibly sent head and the newest intent). */
export function parseSync(raw: unknown): SyncState {
  if (!raw || typeof raw !== "object") return emptySync();
  const { known, outbox } = raw as Record<string, unknown>;
  const ops = Array.isArray(outbox)
    ? outbox.flatMap((op): PendingOp[] =>
        op &&
        typeof op === "object" &&
        "operationId" in op &&
        typeof op.operationId === "string" &&
        "url" in op &&
        isAddress(op.url) &&
        "expectedRevision" in op &&
        isRevision(op.expectedRevision) &&
        "removed" in op &&
        typeof op.removed === "boolean"
          ? [
              {
                operationId: op.operationId,
                url: op.url,
                expectedRevision: op.expectedRevision,
                removed: op.removed,
              },
            ]
          : [],
      )
    : [];
  return {
    known: Object.fromEntries(
      known && typeof known === "object"
        ? Object.entries(known).flatMap(([url, record]) =>
            isAddress(url) &&
            record &&
            typeof record === "object" &&
            "revision" in record &&
            isRevision(record.revision) &&
            "removed" in record &&
            typeof record.removed === "boolean"
              ? [[url, { revision: record.revision, removed: record.removed }]]
              : [],
          )
        : [],
    ),
    outbox: ops.filter((op) => {
      const same = forUrl(ops, op.url);
      return same[0] === op || same.at(-1) === op;
    }),
  };
}

/** The operation per destination that may be sent: each head. A queued intent
 * waits behind its head and must never go out while the head is in flight,
 * parked or awaiting a retry. */
export const heads = (outbox: PendingOp[]) =>
  outbox.filter(
    (op, index) => outbox.findIndex((entry) => entry.url === op.url) === index,
  );

/** Records a new intent for a destination. Nothing is queued when the latest
 * word on it already says so: the intent behind the head, the head, or the
 * known record. A fresh head fences on the last known revision, so removing a
 * never-synced destination uploads revision 0 (fencing a delayed first add)
 * and re-adding after a tombstone carries the tombstone's revision. Behind a
 * head the intent waits, replacing one already waiting, with the revision the
 * head would produce as its provisional fence. */
export function enqueue(
  state: SyncState,
  url: string,
  removed: boolean,
): SyncState {
  const [head, queued] = forUrl(state.outbox, url);
  if ((queued ?? head ?? state.known[url])?.removed === removed) return state;
  return {
    known: state.known,
    outbox: [
      ...state.outbox.filter((op) => op !== queued),
      {
        operationId: crypto.randomUUID(),
        url,
        expectedRevision: head
          ? head.expectedRevision + 1
          : (state.known[url]?.revision ?? 0),
        removed,
      },
    ],
  };
}

/** Settles the head against the record the server now holds. Everything for
 * the destination leaves the outbox except the intent queued behind the head,
 * which stays as the new head when the record does not satisfy it, moved onto
 * the record's revision so it is sent as a fresh edit rather than a stale one. */
function settle(
  state: SyncState,
  op: PendingOp,
  record: KnownRecord | undefined,
): SyncState {
  const known = record
    ? { ...state.known, [op.url]: record }
    : Object.fromEntries(
        Object.entries(state.known).filter(([url]) => url !== op.url),
      );
  const queued = forUrl(state.outbox, op.url)
    .filter((entry) => entry.operationId !== op.operationId)
    .at(-1);
  const satisfied = !!record && queued?.removed === record.removed;
  return {
    known,
    outbox: state.outbox.flatMap((entry) =>
      entry.url !== op.url
        ? [entry]
        : entry === queued && !satisfied
          ? [{ ...entry, expectedRevision: record?.revision ?? 0 }]
          : [],
    ),
  };
}

/** The server accepted `op` and now holds `record`. */
export function acknowledge(
  state: SyncState,
  op: PendingOp,
  record: KnownRecord,
): SyncState {
  return settle(state, op, record);
}

/** The server refused `op` because another operation won. The server's record
 * wins: it is adopted and the refused intent is dropped, never re-sent under
 * a newer revision, since that could resurrect a destination removed
 * elsewhere. An intent queued behind it resolves the destination itself, sent
 * afresh or already satisfied, so no divergence is reported then. No record
 * means the server never held this destination; it is forgotten here too, and
 * the next list merge may enqueue it afresh. */
export function conflict(
  state: SyncState,
  op: PendingOp,
  record?: KnownRecord,
): { state: SyncState; divergence: Divergence } {
  const queued = forUrl(state.outbox, op.url).some(
    (entry) => entry.operationId !== op.operationId,
  );
  const divergence: Divergence =
    !record || queued || record.removed === op.removed
      ? null
      : record.removed
        ? "removed-elsewhere"
        : "added-elsewhere";
  return { state: settle(state, op, record), divergence };
}

/** Reconciles the complete server list with the device's memberships. The
 * list replaces what is known. A destination the server has that the device
 * lacks is added unless its removal is still queued; a tombstone for a saved
 * membership removes it unless its re-add is still queued; a saved membership
 * the server has never seen is queued for upload, which is how a device list
 * from before sync existed reaches the account. The newest intent for a
 * destination speaks for it. */
export function mergeList(
  state: SyncState,
  memberships: ReadonlyArray<{ id: string }>,
  list: ListedCommunity[],
): { state: SyncState; add: string[]; remove: string[] } {
  const known: Record<string, KnownRecord> = Object.fromEntries(
    list.map(({ url, revision, removed }) => [url, { revision, removed }]),
  );
  const local = new Set(memberships.map((m) => relayAddress(m.id)));
  // Outbox order puts the queued intent after its head, so the last entry wins.
  const pending = new Map(state.outbox.map((op) => [op.url, op]));
  const add: string[] = [];
  const remove: string[] = [];
  for (const [url, { removed }] of Object.entries(known)) {
    const op = pending.get(url);
    if (!removed && !local.has(url) && !op?.removed) add.push(url);
    if (removed && local.has(url) && (!op || op.removed)) remove.push(url);
  }
  let next: SyncState = { known, outbox: state.outbox };
  for (const url of local)
    if (!Object.hasOwn(known, url) && !pending.has(url))
      next = enqueue(next, url, false);
  return { state: next, add, remove };
}
