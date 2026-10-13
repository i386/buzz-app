import { afterEach, expect, it, vi } from "vitest";
import { createAgentActivity } from "./activity";
import type { ArchiveHost, ArchivePage } from "../archive/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const agent = "a".repeat(64);
function captured(
  index = 0,
  channelId: string | null = "alpha",
  payload: unknown = index,
) {
  return {
    id: index.toString(16).padStart(64, "0"),
    agent,
    createdAt: Math.floor(Date.now() / 1000),
    receivedAt: Date.now(),
    plaintext: JSON.stringify({
      kind: "turn_liveness",
      turnId: String(index),
      timestamp: new Date().toISOString(),
      channelId,
      payload,
    }),
  };
}
function page(records: ArchivePage["records"]): ArchivePage {
  return {
    records: [...records].reverse(),
    agents: [...new Set(records.map((row) => row.agent))],
    before: null,
    skipped: 0,
    revision: 0,
  };
}
function harness(initial: ReturnType<typeof captured>[] = []) {
  vi.useFakeTimers();
  let saved = initial;
  const host: ArchiveHost = {
    location: "device",
    settings: vi.fn(),
    configure: vi.fn(),
    read: vi.fn(async () => page(saved)),
    clear: vi.fn(async () => {
      saved = [];
    }),
  };
  let allowed = true;
  let known = true;
  const observe = vi.fn();
  const activity = createAgentActivity(
    true,
    observe,
    () => allowed,
    undefined,
    { host, canRestore: (channel) => allowed && known && channel !== "denied" },
  );
  const activate = () => activity.queries.activate();
  let release = () => {};
  return {
    activity,
    host,
    read: vi.mocked(host.read),
    start: () => {
      release = activate();
      activity.state({
        status: "connected",
        routes: [{ id: "observer", status: "live", replay: "unknown" }],
      });
    },
    release: () => release(),
    saved: () => saved,
    generation: () => observe.mock.lastCall?.[0] as number,
    deny: () => {
      allowed = false;
      activity.accessChanged();
    },
    unknown: () => {
      known = false;
    },
    allow: () => {
      allowed = true;
      known = true;
      activity.accessChanged();
    },
    known: () => {
      known = true;
      activity.restoreHistory();
    },
  };
}
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("restores display only, deduplicates live capture, and never learns typing ownership from disk", async () => {
  const item = captured();
  const f = harness([item]);
  f.start();
  await settle();
  expect(f.activity.queries.snapshot().records).toHaveLength(1);
  expect(f.activity.queries.snapshot().turns).toEqual([]);
  f.activity.channelEvents([
    {
      id: "b".repeat(64),
      kind: 20002,
      pubkey: agent,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["h", "alpha"]],
      content: "",
    },
  ]);
  expect(f.activity.queries.snapshot().typing).toEqual([]);
  const live = captured(1);
  f.activity.receive(live, f.generation());
  f.activity.receive(live, f.generation());
  expect(f.activity.queries.snapshot().records).toHaveLength(2);
  expect(f.activity.queries.snapshot().turns[0]?.state).toBe("working");
  f.release();
  expect(f.host.clear).not.toHaveBeenCalled();
  expect(f.activity.queries.snapshot().records).toEqual([]);
  f.activity.dispose();
});

it.each(["clear", "disable", "dispose", "revoke"])(
  "fences a late host page after %s",
  async (action) => {
    const item = captured();
    const f = harness([item]);
    const read = deferred<ArchivePage>();
    f.read.mockImplementationOnce(() => read.promise);
    f.start();
    await settle();
    expect(f.read).toHaveBeenCalledOnce();
    if (action === "clear") await f.activity.queries.clearHistory();
    if (action === "disable") f.release();
    if (action === "dispose") f.activity.dispose();
    if (action === "revoke") f.deny();
    read.resolve(page([item]));
    await settle();
    expect(f.activity.queries.snapshot().records).toEqual([]);
    if (action === "revoke") expect(f.saved()).toHaveLength(1);
    f.activity.dispose();
  },
);

it("keeps permitted history through initial access settlement, hides denied records without deleting potentially recoverable history, and retries a mid-load roster grant", async () => {
  const item = captured();
  const f = harness([item]);
  const read = deferred<ArchivePage>();
  f.read.mockImplementationOnce(() => read.promise);
  f.start();
  f.unknown();
  await settle();
  f.known();
  read.resolve(page([item]));
  await settle();
  expect(f.activity.queries.snapshot().records).toHaveLength(1);
  f.activity.accessChanged();
  await settle();
  expect(f.activity.queries.snapshot().records).toHaveLength(1);
  expect(f.host.clear).not.toHaveBeenCalled();
  expect(f.activity.queries.snapshot().turns).toEqual([]);
  f.deny();
  await settle();
  expect(f.saved()).toHaveLength(1);
  expect(f.activity.queries.snapshot().records).toEqual([]);
  f.allow();
  await settle();
  expect(f.activity.queries.snapshot().records).toHaveLength(1);
  f.activity.dispose();
});

it("reports read and capture failures independently, preserves live delivery, and retains visible evidence on failed clear", async () => {
  const f = harness();
  f.read.mockRejectedValueOnce(new Error("disk unavailable"));
  f.start();
  await settle();
  expect(f.activity.queries.snapshot().history).toBe("error");
  f.activity.captureState("error");
  f.activity.receive(captured(), f.generation());
  expect(f.activity.queries.snapshot().capture).toBe("error");
  expect(f.activity.queries.snapshot().records).toHaveLength(1);
  vi.mocked(f.host.clear).mockRejectedValueOnce(new Error("denied"));
  await expect(f.activity.queries.clearHistory()).rejects.toThrow("denied");
  expect(f.activity.queries.snapshot().records).toHaveLength(1);
  const old = f.generation();
  await f.activity.queries.clearHistory();
  f.activity.receive(captured(1), old);
  expect(f.activity.queries.snapshot().records).toEqual([]);
  f.activity.dispose();
});

it("keeps unsaved live records during hydration and channel-list refresh without rewinding an older page", async () => {
  const f = harness();
  const read = deferred<ArchivePage>();
  f.read.mockReturnValueOnce(read.promise);
  f.start();
  const live = captured(300);
  f.activity.receive(live, f.generation());
  read.resolve({ ...page([captured(299)]), before: 299 });
  await settle();
  expect(f.activity.queries.snapshot().records.map((row) => row.id)).toContain(
    live.id,
  );
  f.read.mockResolvedValueOnce({ ...page([captured(199)]), before: 199 });
  await f.activity.queries.loadOlder();
  expect(f.activity.queries.snapshot().historyOlder).toBe(true);
  f.activity.restoreHistory();
  await settle();
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(
    new Set(f.activity.queries.snapshot().records.map((row) => row.id)),
  ).toEqual(new Set([captured(199).id, live.id]));
  f.read.mockResolvedValueOnce(page([captured(99)]));
  await f.activity.queries.loadOlder();
  expect(f.read.mock.lastCall?.[0].before).toBe(199);
  f.activity.dispose();
});

it("pages beyond the live RAM cap, including hidden pages, and selects agents in the host query", async () => {
  const f = harness();
  f.read.mockResolvedValueOnce({ ...page([captured(301)]), before: 301 });
  f.unknown();
  f.start();
  await settle();
  expect(f.activity.queries.snapshot()).toMatchObject({
    records: [],
    hasOlder: true,
  });
  f.known();
  await settle();
  for (let i = 500; i < 720; i++)
    f.activity.receive(captured(i), f.generation());
  f.read.mockResolvedValueOnce({ ...page([captured(201)]), before: 201 });
  await f.activity.queries.loadOlder();
  expect(
    f.activity.queries
      .snapshot()
      .records.some((row) => row.id === captured(201).id),
  ).toBe(true);
  f.read.mockResolvedValueOnce(page([captured(101)]));
  await f.activity.queries.loadOlder();
  expect(
    f.activity.queries
      .snapshot()
      .records.some((row) => row.id === captured(101).id),
  ).toBe(true);
  expect(f.activity.queries.snapshot().hasOlder).toBe(false);
  f.activity.queries.selectHistory("b".repeat(64));
  await settle();
  expect(f.read.mock.lastCall?.[0]).toEqual({
    kind: 24200,
    agent: "b".repeat(64),
  });
  f.activity.dispose();
});

it("preserves host arrival order for chunks captured in the same millisecond", async () => {
  const items = [captured(11), captured(10)];
  const f = harness(items);
  f.start();
  await settle();
  expect(f.activity.queries.snapshot().records.map((row) => row.id)).toEqual(
    items.map((row) => row.id),
  );
  f.activity.dispose();
});
it("keeps saved and live agent-management requests out of activity", async () => {
  const item = {
    ...captured(),
    plaintext: JSON.stringify({
      kind: "agent_management_request",
      channelId: "alpha",
      payload: { type: "agent_management_request", action: "update" },
    }),
  };
  const f = harness([item]);
  try {
    f.start();
    await settle();
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.activity.queries.snapshot().records).toEqual([]);
    f.activity.receive(item, f.generation());
    expect(f.activity.queries.snapshot().records).toEqual([]);
    expect(f.activity.queries.snapshot().turns).toEqual([]);
  } finally {
    f.activity.dispose();
  }
});
