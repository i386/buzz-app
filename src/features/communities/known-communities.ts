// Durable known-community sync state. Pure: every function returns a new
// state and never touches storage, sessions or the network. The service keeps
// this beside the memberships in the one device record, so a membership change
// and the intent to upload it are a single write. Destinations are keyed by the
// account service's `wss://host[:port]` spelling (see `relayAddress`).
import { relayAddress } from "./destination";

/** The server's last known record for a destination. Tombstones are kept for
 * their revision and never shown as memberships. */
export type KnownRecord = { revision: number; removed: boolean };
/** One intent awaiting upload. At most one per destination: a newer intent
 * replaces it under a fresh operation ID and inherits its expected revision,
 * so a retry never carries a stale fence past a newer edit. */
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

/** Reads the saved `sync` field. Records from before this field existed, or
 * ones this reader cannot understand, read as empty; malformed entries are
 * dropped individually. */
export function parseSync(raw: unknown): SyncState {
  if (!raw || typeof raw !== "object") return emptySync();
  const { known, outbox } = raw as Record<string, unknown>;
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
    outbox: Array.isArray(outbox)
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
      : [],
  };
}

const without = (outbox: PendingOp[], url: string) =>
  outbox.filter((op) => op.url !== url);

/** Records a new intent for a destination. A fresh intent fences on the last
 * known revision, so removing a never-synced destination uploads revision 0
 * (fencing a delayed first add) and re-adding after a tombstone carries the
 * tombstone's revision. */
export function enqueue(
  state: SyncState,
  url: string,
  removed: boolean,
): SyncState {
  const pending = state.outbox.find((op) => op.url === url);
  return {
    known: state.known,
    outbox: [
      ...without(state.outbox, url),
      {
        operationId: crypto.randomUUID(),
        url,
        expectedRevision:
          pending?.expectedRevision ?? state.known[url]?.revision ?? 0,
        removed,
      },
    ],
  };
}

/** Settles an upload against the record the server now holds. The settled
 * operation leaves the outbox; an intent queued behind it leaves too when the
 * record already satisfies it, and otherwise moves onto the record's revision
 * so it is sent as a fresh edit rather than a stale one. */
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
  const pending = state.outbox.find((entry) => entry.url === op.url);
  const satisfied = !!record && pending?.removed === record.removed;
  if (!pending || pending.operationId === op.operationId || satisfied)
    return { known, outbox: without(state.outbox, op.url) };
  return {
    known,
    outbox: state.outbox.map((entry) =>
      entry === pending
        ? { ...entry, expectedRevision: record?.revision ?? 0 }
        : entry,
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
 * elsewhere. No record means the server never held this destination; it is
 * forgotten here too, and the next list merge may enqueue it afresh. */
export function conflict(
  state: SyncState,
  op: PendingOp,
  record?: KnownRecord,
): { state: SyncState; divergence: Divergence } {
  const next = settle(state, op, record);
  const divergence: Divergence =
    !record ||
    record.removed === op.removed ||
    next.outbox.some((entry) => entry.url === op.url)
      ? null
      : record.removed
        ? "removed-elsewhere"
        : "added-elsewhere";
  return { state: next, divergence };
}

/** Reconciles the complete server list with the device's memberships. The
 * list replaces what is known. A destination the server has that the device
 * lacks is added unless its removal is still queued; a tombstone for a saved
 * membership removes it unless its re-add is still queued; a saved membership
 * the server has never seen is queued for upload, which is how a device list
 * from before sync existed reaches the account. */
export function mergeList(
  state: SyncState,
  memberships: ReadonlyArray<{ id: string }>,
  list: ListedCommunity[],
): { state: SyncState; add: string[]; remove: string[] } {
  const known: Record<string, KnownRecord> = Object.fromEntries(
    list.map(({ url, revision, removed }) => [url, { revision, removed }]),
  );
  const local = new Set(memberships.map((m) => relayAddress(m.id)));
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
