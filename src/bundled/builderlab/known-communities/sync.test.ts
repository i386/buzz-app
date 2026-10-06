// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  emptySync,
  enqueue,
  type ListedCommunity,
  type PendingOp,
  type SyncChanges,
  type SyncState,
} from "../../../features/communities/known-communities";
import type {
  ClientSnapshot,
  KnownCommunities,
} from "../../../features/communities/service";
import { createOAuthSession } from "../oauth/session";
import { deferred } from "../test-helpers";
import type {
  KnownCommunitiesClient,
  ListResult,
  UpdateResult,
} from "./client";
import { startKnownCommunitiesSync } from "./sync";

const viewer = "ab".repeat(32);
const primary = "wss://primary.example";
const secondary = "wss://secondary.example";
const reachError = () => new Error("Couldn’t reach Builderlab.");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Settles pending promise chains without moving the fake clock. */
const until = (check: () => void) =>
  vi.waitFor(check, { interval: 0, timeout: 2000 });
const accepted = (op: PendingOp): UpdateResult => ({
  kind: "accepted",
  record: {
    url: op.url,
    revision: op.expectedRevision + 1,
    removed: op.removed,
  },
});
const queued = (...urls: string[]) =>
  urls.reduce((state, url) => enqueue(state, url, false), emptySync());
/** The account service's rules for a destination, as its store applies them:
 * the operation that wrote the row answers again for it, a stale fence
 * conflicts with the current record, and otherwise the edit is the next
 * revision. */
function fakeService() {
  const rows = new Map<
    string,
    { record: ListedCommunity; operationId: string }
  >();
  return {
    rows,
    list: (): ListResult => ({
      kind: "listed",
      communities: [...rows.values()].map((row) => row.record),
    }),
    update(op: PendingOp): UpdateResult {
      const row = rows.get(op.url);
      if (row?.operationId === op.operationId)
        return row.record.revision === op.expectedRevision + 1 &&
          row.record.removed === op.removed
          ? { kind: "accepted", record: row.record }
          : { kind: "revision_conflict", record: row.record };
      if ((row?.record.revision ?? 0) !== op.expectedRevision)
        return row
          ? { kind: "revision_conflict", record: row.record }
          : { kind: "revision_conflict" };
      const record = {
        url: op.url,
        revision: op.expectedRevision + 1,
        removed: op.removed,
      };
      rows.set(op.url, { record, operationId: op.operationId });
      return { kind: "accepted", record };
    },
  };
}

/** The capability as the service provides it: the record, the queue, and the
 * writes back. `apply` keeps only the sync state; membership changes are the
 * service's business and are asserted as the changes handed to it. */
function store(initial: Partial<ClientSnapshot> = {}) {
  let snapshot: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    profile: { name: "", picture: "" },
    sync: emptySync(),
    viewer,
    selected: null,
    memberships: [],
    ...initial,
  };
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const status = vi.fn<KnownCommunities["status"]>();
  const apply = vi.fn(async (next: SyncState, _changes?: SyncChanges) => {
    snapshot = { ...snapshot, sync: next };
    notify();
  });
  const knownCommunities: KnownCommunities = {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    pending: () => snapshot.sync.outbox,
    apply,
    status,
  };
  return {
    knownCommunities,
    apply,
    status,
    set(change: Partial<ClientSnapshot>) {
      snapshot = { ...snapshot, ...change };
      notify();
    },
    enqueue(url: string, removed = false) {
      this.set({ sync: enqueue(snapshot.sync, url, removed) });
    },
    outbox: () => snapshot.sync.outbox,
    known: () => snapshot.sync.known,
  };
}
function fakeClient() {
  return {
    identity: vi.fn<KnownCommunitiesClient["identity"]>(async () => ({
      kind: "identity",
      pubkey: viewer,
    })),
    list: vi.fn<KnownCommunitiesClient["list"]>(async () => ({
      kind: "listed",
      communities: [],
    })),
    update: vi.fn<KnownCommunitiesClient["update"]>(async (_pubkey, op) =>
      accepted(op),
    ),
  };
}
async function fixture({
  snapshot = {} as Partial<ClientSnapshot>,
  signedIn = true,
} = {}) {
  const s = store(snapshot);
  const client = fakeClient();
  const session = createOAuthSession(async () => ({
    value: "secret",
    account: { subject: "user", email: "a@example.com" },
  }));
  const dispose = startKnownCommunitiesSync({
    client,
    session,
    knownCommunities: s.knownCommunities,
  });
  if (signedIn) await session.signIn();
  return { ...s, client, session, dispose };
}
const synced = (pending = 0) => ({ phase: "synced", pending });

it("waits for sign-in and a ready identity, then lists, merges and drains", async () => {
  const h = await fixture({
    signedIn: false,
    snapshot: {
      status: "loading",
      memberships: [{ id: "https://primary.example", name: "Primary" }],
      sync: queued(primary),
    },
  });
  expect(h.status).toHaveBeenLastCalledWith({
    phase: "signed-out",
    pending: 1,
  });
  await h.session.signIn();
  // Signed in, but the device record is still loading: nothing to send yet.
  expect(h.status).toHaveBeenLastCalledWith({ phase: "pending", pending: 1 });
  expect(h.client.identity).not.toHaveBeenCalled();
  h.client.list.mockResolvedValueOnce({
    kind: "listed",
    communities: [{ url: secondary, revision: 3, removed: false }],
  });
  const op = h.outbox()[0];
  h.set({ status: "ready" });
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.client.identity).toHaveBeenCalledTimes(1);
  expect(h.client.list).toHaveBeenCalledWith(viewer, expect.any(AbortSignal));
  // The complete list replaces what is known; the destination saved elsewhere
  // is handed to the service to add, and the queued add keeps its place.
  expect(h.apply).toHaveBeenNthCalledWith(
    1,
    { known: { [secondary]: { revision: 3, removed: false } }, outbox: [op] },
    { add: [secondary], remove: [] },
  );
  expect(h.client.update).toHaveBeenCalledTimes(1);
  expect(h.client.update).toHaveBeenCalledWith(
    viewer,
    op,
    expect.any(AbortSignal),
  );
  expect(h.apply).toHaveBeenLastCalledWith({
    known: {
      [secondary]: { revision: 3, removed: false },
      [primary]: { revision: 1, removed: false },
    },
    outbox: [],
  });
  expect(h.status.mock.calls.map(([s]) => s?.phase)).toContain("syncing");
  h.dispose();
});

it("merges nothing more than once per sign-in, and sends a newly queued intent at once", async () => {
  const h = await fixture();
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  h.enqueue(primary);
  await until(() => expect(h.client.update).toHaveBeenCalledTimes(1));
  expect(h.client.update.mock.calls[0]?.[1]).toMatchObject({
    url: primary,
    removed: false,
  });
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.outbox()).toEqual([]);
  expect(h.known()).toEqual({ [primary]: { revision: 1, removed: false } });
  expect(h.client.identity).toHaveBeenCalledTimes(1);
  expect(h.client.list).toHaveBeenCalledTimes(1);
  h.dispose();
});

it.each([
  { name: "another key", identity: { pubkey: "cd".repeat(32) } },
  { name: "no key", identity: {} },
])(
  "stops before listing while the account is bound to $name, without binding it",
  async ({ identity }) => {
    const h = await fixture({
      signedIn: false,
      snapshot: { sync: queued(primary) },
    });
    h.client.identity.mockResolvedValue({ kind: "identity", ...identity });
    await h.session.signIn();
    await until(() =>
      expect(h.status).toHaveBeenLastCalledWith({
        phase: "needs-binding",
        pending: 1,
      }),
    );
    expect(h.client.list).not.toHaveBeenCalled();
    expect(h.client.update).not.toHaveBeenCalled();
    // Neither a trigger nor time changes that until the next sign-in.
    window.dispatchEvent(new Event("online"));
    h.enqueue(secondary);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.client.identity).toHaveBeenCalledTimes(1);
    expect(h.status).toHaveBeenLastCalledWith({
      phase: "needs-binding",
      pending: 2,
    });
    h.session.signOut();
    expect(h.status).toHaveBeenLastCalledWith({
      phase: "signed-out",
      pending: 2,
    });
    h.client.identity.mockResolvedValue({ kind: "identity", pubkey: viewer });
    await h.session.signIn();
    await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
    expect(h.client.identity).toHaveBeenCalledTimes(2);
    expect(h.client.update).toHaveBeenCalledTimes(2);
    h.dispose();
  },
);

it.each([
  {
    name: "the identity route refuses the account",
    arrange: (h: Awaited<ReturnType<typeof fixture>>) =>
      h.client.identity.mockResolvedValue({ kind: "forbidden" }),
    status: {
      phase: "error",
      pending: 1,
      error: "This Builderlab account can’t sync communities.",
    },
  },
  {
    name: "the list route refuses the account",
    arrange: (h: Awaited<ReturnType<typeof fixture>>) =>
      h.client.list.mockResolvedValue({ kind: "forbidden" }),
    status: {
      phase: "error",
      pending: 1,
      error: "This Builderlab account can’t sync communities.",
    },
  },
  {
    name: "the list route rejects the request as sent",
    arrange: (h: Awaited<ReturnType<typeof fixture>>) =>
      h.client.list.mockResolvedValue({ kind: "rejected", status: 404 }),
    status: {
      phase: "error",
      pending: 1,
      error: "Builderlab refused this request (HTTP 404).",
    },
  },
  {
    name: "an upload reports a mismatched binding",
    arrange: (h: Awaited<ReturnType<typeof fixture>>) =>
      h.client.update.mockResolvedValue({ kind: "identity_mismatch" }),
    status: { phase: "needs-binding", pending: 1 },
  },
  {
    name: "an upload is forbidden",
    arrange: (h: Awaited<ReturnType<typeof fixture>>) =>
      h.client.update.mockResolvedValue({ kind: "forbidden" }),
    status: {
      phase: "error",
      pending: 1,
      error: "This Builderlab account can’t sync communities.",
    },
  },
])("halts until the next sign-in when $name", async ({ arrange, status }) => {
  const h = await fixture({
    signedIn: false,
    snapshot: { sync: queued(primary) },
  });
  arrange(h);
  await h.session.signIn();
  await until(() => expect(h.status).toHaveBeenLastCalledWith(status));
  const calls = () =>
    h.client.identity.mock.calls.length +
    h.client.list.mock.calls.length +
    h.client.update.mock.calls.length;
  const before = calls();
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(calls()).toBe(before);
  expect(h.outbox()).toHaveLength(1);
  h.dispose();
});

it("uploads one operation at a time, in queue order", async () => {
  const first = deferred<UpdateResult>();
  const h = await fixture({ snapshot: { sync: queued(primary, secondary) } });
  h.client.update.mockReturnValueOnce(first.promise);
  await until(() => expect(h.client.update).toHaveBeenCalledTimes(1));
  expect(h.client.update.mock.calls[0]?.[1]).toMatchObject({ url: primary });
  expect(h.status).toHaveBeenLastCalledWith({ phase: "syncing", pending: 2 });
  await vi.advanceTimersByTimeAsync(5000);
  expect(h.client.update).toHaveBeenCalledTimes(1);
  first.resolve(accepted(h.outbox()[0] as PendingOp));
  await until(() => expect(h.client.update).toHaveBeenCalledTimes(2));
  expect(h.client.update.mock.calls[1]?.[1]).toMatchObject({ url: secondary });
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  h.dispose();
});

it("retries a failed upload with the identical request at doubling delays, capped at a minute", async () => {
  const h = await fixture({ snapshot: { sync: queued(primary) } });
  h.client.update.mockRejectedValue(reachError());
  await until(() =>
    expect(h.status).toHaveBeenLastCalledWith({
      phase: "error",
      pending: 1,
      error: "Couldn’t reach Builderlab.",
    }),
  );
  const [, sent] = h.client.update.mock.calls[0] as [
    string,
    PendingOp,
    AbortSignal,
  ];
  let attempts = 1;
  // Each failed run reports twice: syncing, then the error.
  let reports = h.status.mock.calls.length;
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(h.client.update).toHaveBeenCalledTimes(attempts);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.client.update).toHaveBeenCalledTimes(++attempts);
    // The same operation ID and payload, so the service can replay its answer.
    expect(h.client.update.mock.calls.at(-1)?.[1]).toEqual(sent);
    reports += 2;
    await until(() => expect(h.status).toHaveBeenCalledTimes(reports));
  }
  // A success resets the backoff for the next failure.
  h.client.update.mockImplementationOnce(async (_pubkey, op) => accepted(op));
  await vi.advanceTimersByTimeAsync(60000);
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.outbox()).toEqual([]);
  h.enqueue(secondary);
  await until(() =>
    expect(h.status).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "error" }),
    ),
  );
  const count = h.client.update.mock.calls.length;
  await vi.advanceTimersByTimeAsync(999);
  expect(h.client.update).toHaveBeenCalledTimes(count);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.client.update).toHaveBeenCalledTimes(count + 1);
  h.dispose();
});

it("runs again at once when the window comes online or becomes visible, resetting the backoff", async () => {
  const h = await fixture({ snapshot: { sync: queued(primary) } });
  h.client.update.mockRejectedValue(reachError());
  await until(() =>
    expect(h.status).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "error" }),
    ),
  );
  expect(h.client.update).toHaveBeenCalledTimes(1);
  let reports = h.status.mock.calls.length;
  window.dispatchEvent(new Event("online"));
  await until(() => expect(h.client.update).toHaveBeenCalledTimes(2));
  // The trigger's own failure starts the backoff over at one second.
  reports += 2;
  await until(() => expect(h.status).toHaveBeenCalledTimes(reports));
  await vi.advanceTimersByTimeAsync(999);
  expect(h.client.update).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.client.update).toHaveBeenCalledTimes(3);
  reports += 2;
  await until(() => expect(h.status).toHaveBeenCalledTimes(reports));
  let visibility = "hidden";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility as DocumentVisibilityState,
  );
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(h.client.update).toHaveBeenCalledTimes(3);
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  await until(() => expect(h.client.update).toHaveBeenCalledTimes(4));
  h.dispose();
});

it.each([
  {
    refusal: { kind: "invalid_request" } as const,
    reason: "Builderlab refused one of your community addresses.",
  },
  {
    refusal: { kind: "limit_reached" } as const,
    reason: "Builderlab can’t save more communities for this account.",
  },
  {
    refusal: { kind: "rejected", status: 415 } as const,
    reason: "Builderlab refused this request (HTTP 415).",
  },
])(
  "parks an operation the service answers $refusal.kind until the next sign-in, with what waits behind it, and keeps sending others",
  async ({ refusal, reason }) => {
    const h = await fixture({ snapshot: { sync: queued(primary, secondary) } });
    h.client.update.mockImplementation(async (_pubkey, op) =>
      op.url === primary ? refusal : accepted(op),
    );
    await until(() =>
      expect(h.status).toHaveBeenLastCalledWith({
        phase: "error",
        pending: 1,
        error: reason,
      }),
    );
    expect(h.client.update).toHaveBeenCalledTimes(2);
    expect(h.outbox().map((op) => op.url)).toEqual([primary]);
    // Triggers and time pass it over, and an intent queued behind it waits
    // with it rather than going out in its place.
    window.dispatchEvent(new Event("online"));
    h.enqueue(primary, true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.client.update).toHaveBeenCalledTimes(2);
    expect(h.status).toHaveBeenLastCalledWith({
      phase: "error",
      pending: 2,
      error: reason,
    });
    // A fresh intent for another destination still goes.
    h.enqueue(secondary, true);
    await until(() => expect(h.client.update).toHaveBeenCalledTimes(3));
    expect(h.client.update.mock.calls[2]?.[1]).toMatchObject({
      url: secondary,
      removed: true,
    });
    await until(() =>
      expect(h.status).toHaveBeenLastCalledWith({
        phase: "error",
        pending: 2,
        error: reason,
      }),
    );
    h.session.signOut();
    h.client.update.mockImplementation(async (_pubkey, op) => accepted(op));
    await h.session.signIn();
    await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
    // The parked head goes first as it was; the removal behind it follows on
    // the revision the head produced.
    expect(h.client.update).toHaveBeenCalledTimes(5);
    expect(h.client.update.mock.calls[3]?.[1]).toEqual(
      h.client.update.mock.calls[0]?.[1],
    );
    expect(h.client.update.mock.calls[4]?.[1]).toMatchObject({
      url: primary,
      removed: true,
      expectedRevision: 1,
    });
    expect(h.outbox()).toEqual([]);
    h.dispose();
  },
);

it.each([
  { name: "join, lost acknowledgement, leave", first: false },
  { name: "leave, lost acknowledgement, rejoin", first: true },
])(
  "converges on the latest intent after $name: the head is replayed as sent, then the queued intent goes as a fresh edit",
  async ({ first }) => {
    const service = fakeService();
    if (first)
      service.rows.set(primary, {
        record: { url: primary, revision: 1, removed: false },
        operationId: "seeded-elsewhere",
      });
    const h = await fixture({
      signedIn: false,
      snapshot: {
        memberships: first
          ? [{ id: "https://primary.example", name: "Primary" }]
          : [],
      },
    });
    h.client.list.mockImplementation(async () => service.list());
    let lost = true;
    h.client.update.mockImplementation(async (_pubkey, op) => {
      const result = service.update(op);
      // The service applied it, but its answer never arrived.
      if (lost) {
        lost = false;
        throw reachError();
      }
      return result;
    });
    await h.session.signIn();
    await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
    h.enqueue(primary, first);
    await until(() =>
      expect(h.status).toHaveBeenLastCalledWith(
        expect.objectContaining({ phase: "error" }),
      ),
    );
    const [, sent] = h.client.update.mock.calls[0] as [
      string,
      PendingOp,
      AbortSignal,
    ];
    const applied = {
      url: primary,
      revision: sent.expectedRevision + 1,
      removed: first,
    };
    expect(service.rows.get(primary)?.record).toEqual(applied);
    // The user changes their mind during the backoff. The head is still the
    // one sent, so the replay answers for what it wrote, and the newer intent
    // follows on that revision instead of carrying the head's stale fence.
    h.enqueue(primary, !first);
    await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
    const ops = h.client.update.mock.calls.map(([, op]) => op);
    expect(ops).toHaveLength(3);
    expect(ops[1]).toEqual(sent);
    expect(ops[2]).toMatchObject({
      url: primary,
      removed: !first,
      expectedRevision: applied.revision,
    });
    expect(ops[2]?.operationId).not.toBe(sent.operationId);
    const final = { revision: applied.revision + 1, removed: !first };
    expect(service.rows.get(primary)?.record).toEqual({
      url: primary,
      ...final,
    });
    expect(h.known()).toEqual({ [primary]: final });
    expect(h.outbox()).toEqual([]);
    // No divergence was ever reported against the user's own change of mind.
    expect(
      h.apply.mock.calls.flatMap(([, changes]) => [
        ...(changes?.add ?? []),
        ...(changes?.remove ?? []),
      ]),
    ).toEqual([]);
    h.dispose();
  },
);

it("backs off when the device record will not save, then replays the identical operation", async () => {
  const h = await fixture();
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  const failure = new Error(
    "Could not save this community on this device. Try again.",
  );
  h.apply.mockRejectedValueOnce(failure);
  h.enqueue(primary);
  await until(() =>
    expect(h.status).toHaveBeenLastCalledWith({
      phase: "error",
      pending: 1,
      error: failure.message,
    }),
  );
  expect(h.client.update).toHaveBeenCalledTimes(1);
  const [, sent] = h.client.update.mock.calls[0] as [
    string,
    PendingOp,
    AbortSignal,
  ];
  // The service accepted it; only the record did not take the answer. The
  // operation stays as sent, so the service can replay its answer.
  expect(h.outbox()).toEqual([sent]);
  await vi.advanceTimersByTimeAsync(999);
  expect(h.client.update).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.client.update).toHaveBeenCalledTimes(2);
  expect(h.client.update.mock.calls[1]?.[1]).toEqual(sent);
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.outbox()).toEqual([]);
  expect(h.known()).toEqual({ [primary]: { revision: 1, removed: false } });
  h.dispose();
});

it("keeps an intent queued while the list is in flight: the merge reads the record again", async () => {
  const list = deferred<ListResult>();
  const h = await fixture({ signedIn: false });
  h.client.list.mockReturnValueOnce(list.promise);
  await h.session.signIn();
  await until(() => expect(h.client.list).toHaveBeenCalledTimes(1));
  h.enqueue(primary);
  const op = h.outbox()[0];
  list.resolve({ kind: "listed", communities: [] });
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.apply).toHaveBeenNthCalledWith(
    1,
    { known: {}, outbox: [op] },
    { add: [], remove: [] },
  );
  expect(h.client.update).toHaveBeenCalledTimes(1);
  expect(h.client.update.mock.calls[0]?.[1]).toEqual(op);
  expect(h.outbox()).toEqual([]);
  h.dispose();
});

it.each([
  {
    name: "a removal elsewhere beats a queued add",
    removed: false,
    record: { url: primary, revision: 5, removed: true },
    changes: { remove: [primary] },
    known: { [primary]: { revision: 5, removed: true } },
  },
  {
    name: "an add elsewhere beats a queued removal",
    removed: true,
    record: { url: primary, revision: 5, removed: false },
    changes: { add: [primary] },
    known: { [primary]: { revision: 5, removed: false } },
  },
  {
    name: "a conflict without a record forgets the destination",
    removed: false,
    record: undefined,
    changes: {},
    known: {},
  },
])(
  "lets the service win a revision conflict: $name",
  async ({ removed, record, changes, known }) => {
    const h = await fixture({
      snapshot: {
        sync: {
          known: { [primary]: { revision: 2, removed: !removed } },
          outbox: [],
        },
      },
    });
    h.client.update.mockResolvedValue(
      record
        ? { kind: "revision_conflict", record }
        : { kind: "revision_conflict" },
    );
    await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
    h.enqueue(primary, removed);
    await until(() => expect(h.client.update).toHaveBeenCalledTimes(1));
    await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
    expect(h.apply).toHaveBeenLastCalledWith({ known, outbox: [] }, changes);
    expect(h.outbox()).toEqual([]);
    h.dispose();
  },
);

it("signing out abandons the upload in flight and keeps the outbox for the next sign-in", async () => {
  const gate = deferred<UpdateResult>();
  const h = await fixture({ snapshot: { sync: queued(primary) } });
  h.client.update.mockReturnValueOnce(gate.promise);
  await until(() => expect(h.client.update).toHaveBeenCalledTimes(1));
  const [, op, signal] = h.client.update.mock.calls[0] as [
    string,
    PendingOp,
    AbortSignal,
  ];
  const applied = h.apply.mock.calls.length;
  h.session.signOut();
  expect(signal.aborted).toBe(true);
  expect(h.status).toHaveBeenLastCalledWith({
    phase: "signed-out",
    pending: 1,
  });
  gate.resolve(accepted(op));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.apply).toHaveBeenCalledTimes(applied);
  expect(h.outbox()).toEqual([op]);
  await h.session.signIn();
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  // A fresh sign-in checks the binding and the list again, then resends.
  expect(h.client.identity).toHaveBeenCalledTimes(2);
  expect(h.client.list).toHaveBeenCalledTimes(2);
  expect(h.client.update).toHaveBeenCalledTimes(2);
  expect(h.client.update.mock.calls[1]?.[1]).toEqual(op);
  h.dispose();
});

it("stops without a retry when the service ends the session", async () => {
  const h = await fixture({ snapshot: { sync: queued(primary) } });
  h.client.update.mockImplementation(async () => {
    h.session.signOut();
    throw new DOMException("Builderlab session changed.", "AbortError");
  });
  await until(() =>
    expect(h.status).toHaveBeenLastCalledWith({
      phase: "signed-out",
      pending: 1,
    }),
  );
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.client.update).toHaveBeenCalledTimes(1);
  expect(h.outbox()).toHaveLength(1);
  h.dispose();
});

it("disposal withdraws the report and stops listening", async () => {
  const h = await fixture();
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  h.dispose();
  expect(h.status).toHaveBeenLastCalledWith(undefined);
  const reports = h.status.mock.calls.length;
  h.enqueue(primary);
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.client.update).not.toHaveBeenCalled();
  expect(h.status).toHaveBeenCalledTimes(reports);
});
