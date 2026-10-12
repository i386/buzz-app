import { afterEach, expect, it, vi } from "vitest";
import { fakeSpawn, flush } from "./claude-testing";
import type { Spawn, ToolServer } from "./claude";
import {
  AgentSessions,
  IDLE_MS,
  localSessions,
  MAX_LIVE,
  type SavedSession,
  Spare,
  type SessionStore,
} from "./sessions";

afterEach(() => {
  vi.useRealTimers();
});

const memoryStore = (): SessionStore & { all: Map<string, SavedSession> } => {
  const all = new Map<string, SavedSession>();
  return {
    all,
    get: (key) => all.get(key),
    set: (key, session) => void all.set(key, session),
    delete: (key) => void all.delete(key),
  };
};

/** The native host's processes, shared by every agent: it allows `capacity`
 * alive at once, counting one from when it is asked until it has exited. */
function host(capacity = Number.POSITIVE_INFINITY, known?: Set<string>) {
  const fake = fakeSpawn(known);
  const alive = new Set<object>();
  const counts = { spawns: 0, peak: 0 };
  const spawn: Spawn = (id, spawnOptions) => {
    if (alive.size >= capacity)
      return Promise.reject(new Error("Too many processes are running"));
    const slot = {};
    alive.add(slot);
    counts.spawns++;
    counts.peak = Math.max(counts.peak, alive.size);
    const process = fake.spawn(id, spawnOptions);
    void process
      .then((started) => started.exited)
      .finally(() => alive.delete(slot));
    return process;
  };
  return { ...fake, spawn, alive, counts };
}

function sessions(
  options: Partial<{
    known: Set<string>;
    store: ReturnType<typeof memoryStore>;
    /** Every process keeps its turns open until finished. */
    hold: boolean;
    /** Holds each launch after it reads the settings, as a memory read does. */
    launched: Promise<void>;
    /** The shared spare its new conversations look for. */
    spare: Spare;
    /** The host its processes run on; by default its own, with no limit. */
    host: ReturnType<typeof host>;
    tools: ToolServer;
    now: () => number;
  }> = {},
) {
  const fake = options.host ?? host(undefined, options.known);
  const store = options.store ?? memoryStore();
  let model = "opus";
  let ids = 0;
  const spawn: Spawn = (id, spawnOptions) => {
    // The fake records each process as the call begins.
    const process = fake.spawn(id, spawnOptions);
    const started = fake.processes.at(-1);
    if (options.hold && started) started.hold = true;
    return process;
  };
  const pool = new AgentSessions({
    spawn,
    ...(options.spare ? { spare: options.spare } : {}),
    store,
    launch: async () => {
      const current = model;
      await options.launched;
      return {
        cwd: "/work",
        systemPrompt: "prompt",
        model: current,
        ...(options.tools ? { tools: options.tools } : {}),
      };
    },
    fingerprint: () => model,
    newId: () => `new-${++ids}`,
    ...(options.now ? { now: options.now } : {}),
  });
  const claudes = () =>
    fake.processes.filter((process) => process.id === "claude");
  return {
    pool,
    store,
    spawn,
    host: fake,
    claudes,
    live: () => claudes().filter((process) => !process.killed),
    setModel: (next: string) => {
      model = next;
    },
  };
}

/** Sessions with a spare, spawned like their own processes. */
function withSpare(options: Parameters<typeof sessions>[0] = {}) {
  let ids = 0;
  let parts: ReturnType<typeof sessions> | undefined;
  const spare = new Spare(
    (id, spawnOptions) => {
      if (!parts) throw new Error("not ready");
      return parts.spawn(id, spawnOptions);
    },
    async (_conversation, message) => ({ from: "spare", message }),
    () => `spare-${++ids}`,
  );
  parts = sessions({ ...options, spare });
  return { ...parts, spare };
}

const tool = (process: { emit(message: object): void }, id: string) =>
  process.emit({
    type: "control_request",
    request_id: id,
    request: {
      subtype: "mcp_message",
      server_name: "buzz",
      message: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    },
  });
const answered = (
  process: { received: Record<string, unknown>[] },
  id: string,
) =>
  process.received.find(
    (message) =>
      message.type === "control_response" &&
      (message.response as { request_id?: string }).request_id === id,
  )?.response;

it("starts a new conversation on the shared spare and warms another", async () => {
  const { pool, spare, store, claudes } = withSpare();
  spare.warm({ cwd: "/work", model: "opus" });
  await flush();
  expect(claudes()).toHaveLength(1);
  // Started before any agent asked: no prompt yet.
  expect(claudes()[0]?.received).toEqual([]);
  await expect(pool.deliver("c/root", "hello", 10)).resolves.toEqual({
    ok: true,
  });
  await flush();
  expect(claudes()).toHaveLength(2);
  const [used] = claudes();
  expect(used?.received[0]).toMatchObject({
    type: "control_request",
    request: { subtype: "initialize", appendSystemPrompt: "prompt" },
  });
  expect(used?.prompts).toEqual(["hello"]);
  expect(store.get("c/root")).toMatchObject({ id: "spare-1", seen: 10 });
  expect(pool.snapshot()).toEqual([{ key: "c/root", busy: false }]);
});

it("hands the spare's tools to the agent that takes it", async () => {
  const agentTools = vi.fn(async () => ({ from: "agent" }));
  const { pool, spare, claudes } = withSpare({ tools: agentTools });
  spare.warm({ cwd: "/work", model: "opus" });
  await flush();
  const [process] = claudes();
  if (!process) throw new Error("no spare");
  // Claude lists the tools as it starts, before any agent has the spare.
  tool(process, "early");
  await flush();
  expect(answered(process, "early")).toMatchObject({
    response: { mcp_response: { from: "spare" } },
  });
  await pool.deliver("c/root", "hi", 1);
  tool(process, "later");
  await flush();
  expect(answered(process, "later")).toMatchObject({
    response: { mcp_response: { from: "agent" } },
  });
});

it("serves whichever agent starts the next conversation", async () => {
  const one = withSpare();
  const two = sessions({ spare: one.spare });
  one.spare.warm({ cwd: "/work", model: "opus" });
  await flush();
  await one.pool.deliver("c/a", "for one", 1);
  await flush();
  await two.pool.deliver("c/b", "for two", 2);
  // Each took the spare (all started by the first's spawn); neither agent
  // started a process of its own.
  expect(one.claudes().map((process) => process.prompts)).toEqual([
    ["for one"],
    ["for two"],
    [],
  ]);
  expect(two.claudes()).toEqual([]);
});

it("starts a conversation elsewhere afresh, and the spare follows it", async () => {
  const { pool, spare, claudes } = withSpare();
  spare.warm({ cwd: "/other", model: "opus" }, { cwd: "/work", model: "opus" });
  await flush();
  const [other] = claudes();
  await pool.deliver("c/root", "hi", 1);
  await flush();
  expect(other?.killed).toBe(true);
  expect(other?.prompts).toEqual([]);
  const used = claudes().filter((process) => process.prompts.length);
  expect(used[0]?.options.args).toContain("new-1");
  const next = claudes().find((process) =>
    process.options.args?.includes("spare-2"),
  );
  expect(next?.options.cwd).toBe("/work");
  expect(next?.killed).toBe(false);
});

it("does not wait for a spare started elsewhere", async () => {
  // The spare for another folder never finishes starting.
  const spare = new Spare(
    () => new Promise(() => undefined),
    async () => ({}),
  );
  const { pool, claudes } = sessions({ spare });
  spare.warm({ cwd: "/other", model: "opus" });
  await expect(pool.deliver("c/root", "hi", 1)).resolves.toEqual({ ok: true });
  expect(claudes()[0]?.prompts).toEqual(["hi"]);
});

it("keeps a spare that fits any agent, and replaces one that fits none", async () => {
  const { spare, claudes } = withSpare();
  const work = { cwd: "/work", model: "opus" };
  const other = { cwd: "/other", model: "opus" };
  spare.warm(work);
  await flush();
  spare.warm(other, work);
  await flush();
  expect(claudes()).toHaveLength(1);
  spare.warm(other);
  await flush();
  expect(claudes()).toHaveLength(2);
  expect(claudes()[0]?.killed).toBe(true);
  expect(claudes()[1]?.options.cwd).toBe("/other");
});

it("starts no spare again after one dies, until a conversation starts", async () => {
  const { pool, spare, claudes } = withSpare();
  const where = { cwd: "/work", model: "opus" };
  spare.warm(where);
  await flush();
  claudes()[0]?.exit(1, "not signed in");
  await flush();
  spare.warm(where);
  await flush();
  expect(claudes()).toHaveLength(1);
  await pool.deliver("c/root", "hi", 1);
  await flush();
  // One for the conversation, and a spare again.
  expect(claudes()).toHaveLength(3);
});

it("continues a conversation in its own process, apart from others", async () => {
  const { pool, claudes } = sessions();
  await pool.deliver("c/one", "first", 1);
  await pool.deliver("c/two", "other", 2);
  await pool.deliver("c/one", "second", 3);
  const prompts = claudes().map((process) => process.prompts);
  expect(prompts).toContainEqual(["first", "second"]);
  expect(prompts).toContainEqual(["other"]);
});

it("steers a conversation that is still working instead of queueing", async () => {
  const { pool, claudes } = sessions({ hold: true });
  const first = pool.deliver("c/root", "first", 1);
  await flush();
  const process = claudes()[0];
  if (!process) throw new Error("no process");
  const second = pool.deliver("c/root", "plain", 2, { steer: "steer" });
  await flush();
  expect(process.prompts).toEqual(["first", "steer"]);
  expect(pool.snapshot()).toEqual([{ key: "c/root", busy: true }]);
  process.finish();
  await expect(first).resolves.toEqual({ ok: true });
  await expect(second).resolves.toEqual({ ok: true });
});

it("opens one process for messages that arrive together in a new conversation", async () => {
  const { pool, claudes } = sessions();
  await Promise.all([
    pool.deliver("c/root", "one", 1),
    pool.deliver("c/root", "two", 2),
  ]);
  const used = claudes().filter((process) => process.prompts.length);
  expect(used).toHaveLength(1);
  expect(used[0]?.prompts).toEqual(["one", "two"]);
});

it("resumes a saved conversation after its process stops", async () => {
  vi.useFakeTimers();
  const store = memoryStore();
  const { pool, claudes } = sessions({ store });
  await pool.deliver("c/root", "first", 1);
  const first = claudes()[0];
  vi.advanceTimersByTime(IDLE_MS + 1);
  expect(first?.killed).toBe(true);
  expect(pool.snapshot()).toEqual([]);
  await pool.deliver("c/root", "later", 5);
  const resumed = claudes().at(-1);
  expect(resumed?.options.args).toContain("--resume");
  expect(resumed?.options.args).toContain("new-1");
  expect(resumed?.prompts).toEqual(["later"]);
  expect(store.get("c/root")).toMatchObject({ id: "new-1", seen: 5 });
});

it("starts over when a saved session no longer loads", async () => {
  const store = memoryStore();
  store.set("c/root", { id: "lost", seen: 4, at: 1 });
  const { pool, claudes } = sessions({ store });
  await expect(
    pool.deliver("c/root", "hello", 9, {
      fresh: async () => "hello, with the thread so far",
    }),
  ).resolves.toEqual({ ok: true });
  const [failed, fresh] = claudes();
  expect(failed?.options.args).toContain("lost");
  expect(fresh?.options.args).toContain("--session-id");
  expect(fresh?.prompts).toEqual(["hello, with the thread so far"]);
  expect(store.get("c/root")).toMatchObject({ id: "new-1", seen: 9 });
});

it("runs a turn with the model and effort it was delivered with, starting over included", async () => {
  const store = memoryStore();
  store.set("c/root", { id: "lost", seen: 4, at: 1 });
  const { pool, claudes } = sessions({ store });
  await pool.deliver("c/root", "hello", 9, {
    fresh: async () => "hello again",
    pick: { model: "haiku", effort: "low" },
  });
  await pool.deliver("c/root", "next", 10);
  const fresh = claudes().find((process) => process.prompts.length);
  expect(fresh?.prompts).toEqual(["hello again", "next"]);
  expect(fresh?.models).toEqual(["haiku", "opus"]);
  expect(fresh?.efforts).toEqual(["low", "high"]);
});

it("runs up to MAX_LIVE conversations at once", async () => {
  const { pool, live } = sessions({ hold: true });
  for (let index = 0; index < MAX_LIVE; index++)
    void pool.deliver(`c/${index}`, "hi", index);
  await flush();
  expect(live()).toHaveLength(MAX_LIVE);
  expect(pool.snapshot().every((session) => session.busy)).toBe(true);
});

it("runs a one-off turn in a new session that is never saved", async () => {
  const store = memoryStore();
  const { pool, claudes } = sessions({ store });
  await expect(pool.runOnce("timer/a", () => "wake")).resolves.toEqual({
    ok: true,
  });
  const claude = claudes().find((process) => process.prompts.includes("wake"));
  expect(claude?.options.args).toContain("--session-id");
  expect(claude?.killed).toBe(true);
  expect(pool.snapshot()).toEqual([]);
  expect(store.get("timer/a #1")).toBeUndefined();
});

it("asks a one-off turn for its prompt only once its process is ready", async () => {
  let release!: () => void;
  const launched = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { pool, claudes } = sessions({ launched });
  // It went stale while its process started, as a watch turned off would.
  let stale = false;
  const prompt = vi.fn(() => (stale ? undefined : "wake"));
  const waiting = pool.runOnce("watch/a", prompt);
  await flush();
  expect(prompt).not.toHaveBeenCalled();
  stale = true;
  release();
  await expect(waiting).resolves.toEqual({ ok: true });
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(claudes().some((process) => process.prompts.includes("wake"))).toBe(
    false,
  );
});

it("keeps a one-off turn's entry until its process has exited", async () => {
  vi.useFakeTimers();
  const { pool, claudes } = sessions({ hold: true });
  let settled = false;
  const done = pool
    .runOnce("timer/slow", () => "work", 1_000)
    .then((result) => {
      settled = true;
      return result;
    });
  await vi.advanceTimersByTimeAsync(10);
  const claude = claudes().find((process) => process.prompts.includes("work"));
  // The host only signals it; it exits later, as after a grace period.
  if (claude) claude.exitOnKill = false;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(claude?.killed).toBe(true);
  expect(settled).toBe(false);
  expect(pool.snapshot().map((session) => session.key)).toContain(
    "timer/slow #1",
  );
  claude?.exit(null);
  await vi.advanceTimersByTimeAsync(10);
  await expect(done).resolves.toMatchObject({ ok: false });
  expect(pool.snapshot().map((session) => session.key)).not.toContain(
    "timer/slow #1",
  );
});

it("stops the least recently used conversation to stay within its process limit", async () => {
  let clock = 0;
  const { pool, store, live, claudes } = sessions({ now: () => ++clock });
  for (let index = 0; index < MAX_LIVE; index++)
    await pool.deliver(`c/${index}`, "hi", index);
  // Used again: the oldest conversation is no longer the least recently used.
  await pool.deliver("c/0", "again", MAX_LIVE);
  await pool.deliver("c/new", "hi", MAX_LIVE + 1);
  await flush();
  expect(live()).toHaveLength(MAX_LIVE);
  const keys = pool.snapshot().map((session) => session.key);
  expect(keys).not.toContain("c/1");
  expect(keys).toEqual(expect.arrayContaining(["c/0", "c/new"]));
  // The stopped conversation kept its session, and resumes from it.
  expect(store.get("c/1")).toMatchObject({ id: "new-2" });
  await pool.deliver("c/1", "back", MAX_LIVE + 2);
  expect(claudes().at(-1)?.options.args).toEqual(
    expect.arrayContaining(["--resume", "new-2"]),
  );
  expect(claudes().at(-1)?.prompts).toEqual(["back"]);
  expect(live()).toHaveLength(MAX_LIVE);
});

it("says it is busy rather than start a process past its limit", async () => {
  // A host with no room past the limit: a start would fail, not be refused.
  const full = host(MAX_LIVE);
  const { pool, live } = sessions({ hold: true, host: full });
  for (let index = 0; index < MAX_LIVE; index++)
    void pool.deliver(`c/${index}`, "hi", index);
  await flush();
  expect(live()).toHaveLength(MAX_LIVE);
  await expect(pool.deliver("c/extra", "hi", 9)).resolves.toEqual({
    ok: false,
    error: `Claude is already working in ${MAX_LIVE} conversations; try again when one finishes`,
  });
  expect(full.counts.spawns).toBe(MAX_LIVE);
  expect(live()).toHaveLength(MAX_LIVE);
  expect(pool.snapshot().map((session) => session.key)).not.toContain(
    "c/extra",
  );
});

it("counts conversations still starting toward its limit", async () => {
  let release!: () => void;
  const launched = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { pool, live } = sessions({ hold: true, launched });
  const results = Array.from({ length: MAX_LIVE + 1 }, (_, index) =>
    pool.deliver(`c/${index}`, "hi", index),
  );
  await expect(results[MAX_LIVE]).resolves.toMatchObject({ ok: false });
  release();
  await flush();
  expect(live()).toHaveLength(MAX_LIVE);
});

it("stops a finished conversation for a new one before its idle time is up", async () => {
  vi.useFakeTimers();
  const { pool, store, live } = sessions();
  await pool.deliver("c/stale", "hi", 1);
  // Past its idle time: stopped by its own timer, not for another.
  vi.advanceTimersByTime(IDLE_MS + 1);
  expect(pool.snapshot()).toEqual([]);
  for (let index = 0; index < MAX_LIVE; index++) {
    vi.advanceTimersByTime(60_000);
    await pool.deliver(`c/${index}`, "hi", index + 2);
  }
  vi.advanceTimersByTime(60_000);
  await pool.deliver("c/new", "hi", MAX_LIVE + 2);
  const keys = pool.snapshot().map((session) => session.key);
  expect(keys).not.toContain("c/0");
  expect(keys).toContain("c/new");
  expect(live()).toHaveLength(MAX_LIVE);
  expect(store.get("c/0")).toBeDefined();
});

it("keeps new threads from several agents within the host's process limit", async () => {
  // Three thread-scoped agents that answer anyone, or watch an active
  // channel, each addressed in two new threads a minute for 14 minutes: well
  // under the rate limit, every turn finished at once, and no conversation
  // idle long enough to stop on its own. One host serves all three, with the
  // room the native host has for every plugin's processes.
  const shared = host(64);
  const spare = new Spare(shared.spawn, async () => ({}));
  const agents = Array.from({ length: 3 }, () =>
    sessions({ host: shared, spare }),
  );
  spare.warm({ cwd: "/work", model: "opus" });
  await flush();
  vi.useFakeTimers();
  const MINUTES = 14;
  for (let minute = 0; minute < MINUTES; minute++) {
    for (const [index, agent] of agents.entries())
      for (const thread of [0, 1])
        await expect(
          agent.pool.deliver(
            `channel/root-${minute}-${thread}`,
            `thread ${minute}-${thread}`,
            minute * 10 + index,
          ),
        ).resolves.toEqual({ ok: true });
    vi.advanceTimersByTime(60_000);
  }
  // More processes were started than the host keeps alive at once, so without
  // stopping conversations the host would have refused the later starts.
  expect(shared.counts.spawns).toBeGreaterThan(64);
  expect(shared.counts.peak).toBeLessThanOrEqual(agents.length * MAX_LIVE + 1);
  for (const agent of agents)
    expect(agent.pool.snapshot()).toHaveLength(MAX_LIVE);
});

it("starts again with settings saved while a conversation's process started", async () => {
  let release!: () => void;
  const launched = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { pool, claudes, setModel } = sessions({ launched });
  const done = pool.deliver("c/root", "hi", 1);
  await flush();
  setModel("sonnet");
  pool.reconfigure();
  release();
  await expect(done).resolves.toEqual({ ok: true });
  const [old] = claudes();
  expect(old?.options.args).toContain("opus");
  expect(old?.killed).toBe(true);
  const used = claudes().filter((process) => process.prompts.length);
  expect(used).toHaveLength(1);
  expect(used[0]?.options.args).toContain("sonnet");
});

it("restarts idle processes when settings change", async () => {
  const { pool, claudes, setModel } = sessions();
  await pool.deliver("c/root", "hi", 1);
  await flush();
  const [conversation] = claudes();
  setModel("sonnet");
  pool.reconfigure();
  await flush();
  expect(conversation?.killed).toBe(true);
  await pool.deliver("c/root", "again", 2);
  const resumed = claudes().at(-1);
  expect(resumed?.options.args).toEqual(
    expect.arrayContaining(["--resume", "new-1", "--model", "sonnet"]),
  );
});

it("stops every process when disposed", async () => {
  const { pool, spare, claudes } = withSpare();
  spare.warm({ cwd: "/work", model: "opus" });
  await pool.deliver("c/root", "hi", 1);
  await flush();
  pool.dispose();
  spare.dispose();
  await flush();
  expect(claudes()).toHaveLength(2);
  expect(claudes().every((process) => process.killed)).toBe(true);
  await expect(pool.deliver("c/root", "late", 2)).resolves.toMatchObject({
    ok: false,
  });
  expect(claudes()).toHaveLength(2);
});

it("starts no spare for a conversation that starts after its agents are gone", async () => {
  let release!: () => void;
  const launched = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { pool, spare, live } = withSpare({ launched });
  spare.warm({ cwd: "/work", model: "opus" });
  const done = pool.deliver("c/root", "hi", 1);
  await flush();
  // As the runtime does when its last agent goes, mid-launch.
  pool.dispose();
  spare.warm();
  release();
  await expect(done).resolves.toMatchObject({ ok: false });
  await flush();
  expect(live()).toEqual([]);
});

it("keeps saved sessions per agent in storage", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  } as Storage;
  const one = localSessions(storage, "one");
  const two = localSessions(storage, "two");
  one.set("c/root", { id: "s1", seen: 3, at: 1 });
  two.set("c/root", { id: "s2", seen: 4, at: 2 });
  expect(localSessions(storage, "one").get("c/root")?.id).toBe("s1");
  expect(two.get("c/root")?.id).toBe("s2");
  one.delete("c/root");
  expect(one.get("c/root")).toBeUndefined();
  expect(two.get("c/root")?.id).toBe("s2");
  data.set("buzz.claude-code.sessions.v1", "not json");
  expect(one.get("c/root")).toBeUndefined();
});

it("shares a temporary metadata lookup, releases its process, and refreshes after settings change", async () => {
  const { pool, claudes, live, setModel } = sessions();
  const [first, second] = await Promise.all([pool.metadata(), pool.metadata()]);
  expect(first).toEqual(second);
  expect(first.model).toBe("claude-opus-5-5");
  expect(claudes()).toHaveLength(1);
  expect(live()).toHaveLength(0);
  await pool.metadata();
  expect(claudes()).toHaveLength(1);
  setModel("haiku");
  pool.reconfigure();
  expect((await pool.metadata()).model).toBe("claude-haiku-5-5");
  expect(live()).toHaveLength(0);
  pool.dispose();
});

it("does not start metadata discovery after its agent is disposed during launch", async () => {
  let release!: () => void;
  const launched = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { pool, claudes } = sessions({ launched });
  const result = pool.metadata();
  await flush();
  pool.dispose();
  const stopped = expect(result).rejects.toThrow("stopped");
  release();
  await stopped;
  expect(claudes()).toHaveLength(0);
});
