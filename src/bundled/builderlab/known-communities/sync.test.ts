// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  emptySync,
  enqueue,
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
const accepted: UpdateResult = { kind: "accepted" };

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
const queued = (...urls: string[]) =>
  urls.reduce((state, url) => enqueue(state, url, false), emptySync());
/** The account service: a set of destinations with idempotent edits. */
function fakeService(...held: string[]) {
  const rows = new Set(held);
  return {
    rows,
    list: (): ListResult => ({ kind: "listed", communities: [...rows] }),
    add(url: string): UpdateResult {
      rows.add(url);
      return accepted;
    },
    remove(url: string): UpdateResult {
      rows.delete(url);
      return accepted;
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
    list: vi.fn<KnownCommunitiesClient["list"]>(async () => ({
      kind: "listed",
      communities: [],
    })),
    add: vi.fn<KnownCommunitiesClient["add"]>(async () => accepted),
    remove: vi.fn<KnownCommunitiesClient["remove"]>(async () => accepted),
  };
}
/** `arrange` sets the service's answers before the sign-in starts the drain,
 * which reaches the first upload without yielding to the test. */
async function fixture({
  snapshot = {} as Partial<ClientSnapshot>,
  signedIn = true,
  arrange = (_client: ReturnType<typeof fakeClient>) => {},
} = {}) {
  const s = store(snapshot);
  const client = fakeClient();
  arrange(client);
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
  /** Every edit sent, in order, as the intent it carried. */
  const sent = () =>
    [
      ...client.add.mock.invocationCallOrder,
      ...client.remove.mock.invocationCallOrder,
    ]
      .sort((x, y) => x - y)
      .map((order): PendingOp => {
        const added = client.add.mock.invocationCallOrder.indexOf(order);
        return added >= 0
          ? { url: client.add.mock.calls[added]?.[0] ?? "", removed: false }
          : {
              url:
                client.remove.mock.calls[
                  client.remove.mock.invocationCallOrder.indexOf(order)
                ]?.[0] ?? "",
              removed: true,
            };
      });
  return { ...s, client, session, dispose, sent };
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
  expect(h.client.list).not.toHaveBeenCalled();
  h.client.list.mockResolvedValueOnce({
    kind: "listed",
    communities: [secondary],
  });
  const op = h.outbox()[0];
  h.set({ status: "ready" });
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.client.list).toHaveBeenCalledWith(expect.any(AbortSignal));
  // The complete list replaces what is known; the destination saved elsewhere
  // is handed to the service to add, and the queued add keeps its place.
  expect(h.apply).toHaveBeenNthCalledWith(
    1,
    { known: [secondary], outbox: [op] },
    { add: [secondary], remove: [] },
  );
  expect(h.client.add).toHaveBeenCalledTimes(1);
  expect(h.client.add).toHaveBeenCalledWith(primary, expect.any(AbortSignal));
  expect(h.client.remove).not.toHaveBeenCalled();
  expect(h.apply).toHaveBeenLastCalledWith({
    known: [secondary, primary],
    outbox: [],
  });
  expect(h.status.mock.calls.map(([s]) => s?.phase)).toContain("syncing");
  h.dispose();
});

it("merges nothing more than once per sign-in, and sends a newly queued intent at once", async () => {
  const h = await fixture();
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  h.enqueue(primary);
  await until(() => expect(h.client.add).toHaveBeenCalledTimes(1));
  expect(h.client.add.mock.calls[0]?.[0]).toBe(primary);
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.outbox()).toEqual([]);
  expect(h.known()).toEqual([primary]);
  h.enqueue(primary, true);
  await until(() => expect(h.client.remove).toHaveBeenCalledTimes(1));
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.known()).toEqual([]);
  expect(h.client.list).toHaveBeenCalledTimes(1);
  h.dispose();
});

it.each([
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
    name: "an upload is forbidden",
    arrange: (h: Awaited<ReturnType<typeof fixture>>) =>
      h.client.add.mockResolvedValue({ kind: "forbidden" }),
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
    h.client.list.mock.calls.length +
    h.client.add.mock.calls.length +
    h.client.remove.mock.calls.length;
  const before = calls();
  window.dispatchEvent(new Event("online"));
  h.enqueue(secondary);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(calls()).toBe(before);
  expect(h.outbox()).toHaveLength(2);
  h.session.signOut();
  h.client.list.mockResolvedValue({ kind: "listed", communities: [] });
  h.client.add.mockResolvedValue(accepted);
  await h.session.signIn();
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.outbox()).toEqual([]);
  h.dispose();
});

it("uploads one intent at a time, in queue order", async () => {
  const first = deferred<UpdateResult>();
  const h = await fixture({
    snapshot: { sync: queued(primary, secondary) },
    arrange: (client) => client.add.mockReturnValueOnce(first.promise),
  });
  await until(() => expect(h.client.add).toHaveBeenCalledTimes(1));
  expect(h.client.add.mock.calls[0]?.[0]).toBe(primary);
  expect(h.status).toHaveBeenLastCalledWith({ phase: "syncing", pending: 2 });
  await vi.advanceTimersByTimeAsync(5000);
  expect(h.client.add).toHaveBeenCalledTimes(1);
  first.resolve(accepted);
  await until(() => expect(h.client.add).toHaveBeenCalledTimes(2));
  expect(h.client.add.mock.calls[1]?.[0]).toBe(secondary);
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  h.dispose();
});

it("retries a failed upload with the identical request at doubling delays, capped at a minute", async () => {
  const h = await fixture({
    snapshot: { sync: queued(primary) },
    arrange: (client) => client.add.mockRejectedValue(reachError()),
  });
  await until(() =>
    expect(h.status).toHaveBeenLastCalledWith({
      phase: "error",
      pending: 1,
      error: "Couldn’t reach Builderlab.",
    }),
  );
  let attempts = 1;
  // Each failed run reports twice: syncing, then the error.
  let reports = h.status.mock.calls.length;
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(h.client.add).toHaveBeenCalledTimes(attempts);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.client.add).toHaveBeenCalledTimes(++attempts);
    expect(h.client.add.mock.calls.at(-1)?.[0]).toBe(primary);
    reports += 2;
    await until(() => expect(h.status).toHaveBeenCalledTimes(reports));
  }
  // A success resets the backoff for the next failure.
  h.client.add.mockResolvedValueOnce(accepted);
  await vi.advanceTimersByTimeAsync(60000);
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.outbox()).toEqual([]);
  h.enqueue(secondary);
  await until(() =>
    expect(h.status).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "error" }),
    ),
  );
  const count = h.client.add.mock.calls.length;
  await vi.advanceTimersByTimeAsync(999);
  expect(h.client.add).toHaveBeenCalledTimes(count);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.client.add).toHaveBeenCalledTimes(count + 1);
  h.dispose();
});

it("runs again at once when the window comes online or becomes visible, resetting the backoff", async () => {
  const h = await fixture({
    snapshot: { sync: queued(primary) },
    arrange: (client) => client.add.mockRejectedValue(reachError()),
  });
  await until(() =>
    expect(h.status).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "error" }),
    ),
  );
  expect(h.client.add).toHaveBeenCalledTimes(1);
  let reports = h.status.mock.calls.length;
  window.dispatchEvent(new Event("online"));
  await until(() => expect(h.client.add).toHaveBeenCalledTimes(2));
  // The trigger's own failure starts the backoff over at one second.
  reports += 2;
  await until(() => expect(h.status).toHaveBeenCalledTimes(reports));
  await vi.advanceTimersByTimeAsync(999);
  expect(h.client.add).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.client.add).toHaveBeenCalledTimes(3);
  reports += 2;
  await until(() => expect(h.status).toHaveBeenCalledTimes(reports));
  let visibility = "hidden";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility as DocumentVisibilityState,
  );
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(h.client.add).toHaveBeenCalledTimes(3);
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  await until(() => expect(h.client.add).toHaveBeenCalledTimes(4));
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
  "parks an add the service answers $refusal.kind, keeps sending others, and sends the intent that replaces it",
  async ({ refusal, reason }) => {
    const h = await fixture({
      snapshot: { sync: queued(primary, secondary) },
      arrange: (client) =>
        client.add.mockImplementation(async (url) =>
          url === primary ? refusal : accepted,
        ),
    });
    await until(() =>
      expect(h.status).toHaveBeenLastCalledWith({
        phase: "error",
        pending: 1,
        error: reason,
      }),
    );
    expect(h.client.add).toHaveBeenCalledTimes(2);
    expect(h.outbox()).toEqual([{ url: primary, removed: false }]);
    // Triggers and time pass it over, and the same intent queued again is
    // the same request: still parked.
    window.dispatchEvent(new Event("online"));
    h.enqueue(primary);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.client.add).toHaveBeenCalledTimes(2);
    expect(h.status).toHaveBeenLastCalledWith({
      phase: "error",
      pending: 1,
      error: reason,
    });
    // A fresh intent for another destination still goes.
    h.enqueue(secondary, true);
    await until(() => expect(h.client.remove).toHaveBeenCalledTimes(1));
    expect(h.client.remove.mock.calls[0]?.[0]).toBe(secondary);
    await until(() =>
      expect(h.status).toHaveBeenLastCalledWith({
        phase: "error",
        pending: 1,
        error: reason,
      }),
    );
    // Leaving the refused community replaces the parked add with a removal,
    // which is a different request and goes out; nothing then remains parked.
    h.enqueue(primary, true);
    await until(() => expect(h.client.remove).toHaveBeenCalledTimes(2));
    expect(h.client.remove.mock.calls[1]?.[0]).toBe(primary);
    await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
    expect(h.outbox()).toEqual([]);
    h.dispose();
  },
);

it("sends a parked intent again on the next sign-in", async () => {
  const h = await fixture({
    snapshot: { sync: queued(primary) },
    arrange: (client) =>
      client.add.mockResolvedValueOnce({ kind: "limit_reached" }),
  });
  await until(() =>
    expect(h.status).toHaveBeenLastCalledWith({
      phase: "error",
      pending: 1,
      error: "Builderlab can’t save more communities for this account.",
    }),
  );
  h.session.signOut();
  await h.session.signIn();
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.client.add).toHaveBeenCalledTimes(2);
  expect(h.outbox()).toEqual([]);
  h.dispose();
});

it.each([
  { name: "join, lost acknowledgement, leave", first: false },
  { name: "leave, lost acknowledgement, rejoin", first: true },
])(
  "converges on the latest intent after $name: the retry sends only the newer intent",
  async ({ first }) => {
    const service = fakeService(...(first ? [primary] : []));
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
    const edit =
      (apply: (url: string) => UpdateResult) => async (url: string) => {
        const result = apply(url);
        // The service applied it, but its answer never arrived.
        if (lost) {
          lost = false;
          throw reachError();
        }
        return result;
      };
    h.client.add.mockImplementation(edit((url) => service.add(url)));
    h.client.remove.mockImplementation(edit((url) => service.remove(url)));
    await h.session.signIn();
    await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
    h.enqueue(primary, first);
    await until(() =>
      expect(h.status).toHaveBeenLastCalledWith(
        expect.objectContaining({ phase: "error" }),
      ),
    );
    expect(service.rows.has(primary)).toBe(!first);
    // The user changes their mind during the backoff: the newer intent
    // replaces the one whose answer was lost, and is what the retry sends.
    h.enqueue(primary, !first);
    await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
    expect(h.sent()).toEqual([
      { url: primary, removed: first },
      { url: primary, removed: !first },
    ]);
    expect(service.rows.has(primary)).toBe(first);
    expect(h.known()).toEqual(first ? [primary] : []);
    expect(h.outbox()).toEqual([]);
    // No membership change was ever reported against the user's own change
    // of mind.
    expect(
      h.apply.mock.calls.flatMap(([, changes]) => [
        ...(changes?.add ?? []),
        ...(changes?.remove ?? []),
      ]),
    ).toEqual([]);
    h.dispose();
  },
);

it("backs off when the device record will not save, then replays the identical request", async () => {
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
  expect(h.client.add).toHaveBeenCalledTimes(1);
  // The service accepted it; only the record did not take the answer. The
  // intent stays, and the idempotent request goes again.
  expect(h.outbox()).toEqual([{ url: primary, removed: false }]);
  await vi.advanceTimersByTimeAsync(999);
  expect(h.client.add).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.client.add).toHaveBeenCalledTimes(2);
  expect(h.client.add.mock.calls[1]?.[0]).toBe(primary);
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.outbox()).toEqual([]);
  expect(h.known()).toEqual([primary]);
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
    { known: [], outbox: [op] },
    { add: [], remove: [] },
  );
  expect(h.client.add).toHaveBeenCalledTimes(1);
  expect(h.client.add.mock.calls[0]?.[0]).toBe(primary);
  expect(h.outbox()).toEqual([]);
  h.dispose();
});

it("follows the account on the next sign-in: a removal elsewhere is applied, a membership never uploaded is sent", async () => {
  const service = fakeService(secondary);
  const h = await fixture({
    signedIn: false,
    snapshot: {
      memberships: [
        { id: "https://primary.example", name: "Primary" },
        { id: "https://secondary.example", name: "Secondary" },
      ],
      sync: { known: [secondary], outbox: [] },
    },
  });
  h.client.list.mockImplementation(async () => service.list());
  h.client.add.mockImplementation(async (url) => service.add(url));
  // Another device removed the secondary and added a third community.
  service.rows.delete(secondary);
  service.rows.add("wss://third.example");
  await h.session.signIn();
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  expect(h.apply).toHaveBeenNthCalledWith(
    1,
    {
      known: ["wss://third.example"],
      outbox: [{ url: primary, removed: false }],
    },
    { add: ["wss://third.example"], remove: [secondary] },
  );
  expect(h.sent()).toEqual([{ url: primary, removed: false }]);
  expect(h.known()).toEqual(["wss://third.example", primary]);
  h.dispose();
});

it("signing out abandons the upload in flight and keeps the outbox for the next sign-in", async () => {
  const gate = deferred<UpdateResult>();
  const h = await fixture({
    snapshot: { sync: queued(primary) },
    arrange: (client) => client.add.mockReturnValueOnce(gate.promise),
  });
  await until(() => expect(h.client.add).toHaveBeenCalledTimes(1));
  const [, signal] = h.client.add.mock.calls[0] as [string, AbortSignal];
  const op = h.outbox()[0];
  const applied = h.apply.mock.calls.length;
  h.session.signOut();
  expect(signal.aborted).toBe(true);
  expect(h.status).toHaveBeenLastCalledWith({
    phase: "signed-out",
    pending: 1,
  });
  gate.resolve(accepted);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.apply).toHaveBeenCalledTimes(applied);
  expect(h.outbox()).toEqual([op]);
  await h.session.signIn();
  await until(() => expect(h.status).toHaveBeenLastCalledWith(synced()));
  // A fresh sign-in reads the list again, then resends.
  expect(h.client.list).toHaveBeenCalledTimes(2);
  expect(h.client.add).toHaveBeenCalledTimes(2);
  expect(h.client.add.mock.calls[1]?.[0]).toBe(primary);
  h.dispose();
});

it("stops without a retry when the service ends the session", async () => {
  const h = await fixture({
    signedIn: false,
    snapshot: { sync: queued(primary) },
  });
  h.client.add.mockImplementation(async () => {
    h.session.signOut();
    throw new DOMException("Builderlab session changed.", "AbortError");
  });
  await h.session.signIn();
  await until(() =>
    expect(h.status).toHaveBeenLastCalledWith({
      phase: "signed-out",
      pending: 1,
    }),
  );
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.client.add).toHaveBeenCalledTimes(1);
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
  expect(h.client.add).not.toHaveBeenCalled();
  expect(h.status).toHaveBeenCalledTimes(reports);
});
