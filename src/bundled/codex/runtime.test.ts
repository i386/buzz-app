import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { apply } from "./index";
import { describe, afterEach, expect, it, vi } from "vitest";
import type { Agent, Delivery } from "../../features/agents/service";
import type { RelayData } from "../../features/relay/service";
import type { EventData } from "../../features/relay/events";
import { eventDto } from "../../features/relay/events";
import { keypair, signed } from "../../features/relay/testing";
import type { HostProcessOptions } from "../../features/host/service";
import { BUZZ_PROMPT } from "../../buzz-mcp/prompt";
import { createAgentMemories } from "../../features/agents/memory";
import { CodexRuntime, codexStep, programs } from "./runtime";
import type { Wire } from "./rpc";

// The plugin registers only in the Mac/Linux desktop app.
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));

const owner = "a".repeat(64);
const pubkey = "b".repeat(64);
const root = "c".repeat(64);
const scope = "https://relay.test:owner";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const runtimes: CodexRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes) runtime.dispose();
  runtimes.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** External app-server protocol fixture: turns complete only when released by
 * the test. The runtime owns routing, steering, cleanup and publication. */
function fixture(
  remainingTerminals: unknown[] = [],
  termination?: Promise<void>,
  plugin = false,
) {
  let terminals = remainingTerminals;
  let options: HostProcessOptions | undefined;
  let thread = 0;
  let turn = 0;
  const sent: Wire[] = [];
  /** Methods the server answers with a JSON-RPC error instead of a result. */
  const failing = new Set<string>();
  const toolCalls = new Map<
    number | string,
    { threadId: string | undefined; turnId: string; callId: string }
  >();
  const exits = deferred<number | null>();
  const storage = new Map<string, string>();
  const process = {
    write: async (data: string) => {
      const request: Wire = JSON.parse(data);
      sent.push(request);
      if (request.id != null && !request.method) {
        const call = toolCalls.get(request.id);
        if (call)
          emit({
            method: "item/completed",
            params: {
              threadId: call.threadId,
              turnId: call.turnId,
              item: {
                type: "dynamicToolCall",
                id: call.callId,
                success: (request.result as { success?: boolean })?.success,
              },
            },
          });
        return;
      }
      if (request.id == null) return;
      if (request.method && failing.has(request.method)) {
        emit({
          id: request.id,
          error: { message: `${request.method} failed` },
        });
        return;
      }
      const params = request.params as Record<string, unknown>;
      let result: unknown = {};
      if (request.method === "model/list")
        result = {
          data: [
            {
              model: "test-model",
              displayName: "Test Model",
              isDefault: true,
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: ["low", "medium", "high"].map(
                (reasoningEffort) => ({ reasoningEffort, description: "" }),
              ),
            },
            {
              model: "deep-model",
              displayName: "",
              isDefault: false,
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: ["high", "xhigh"].map(
                (reasoningEffort) => ({ reasoningEffort, description: "" }),
              ),
            },
          ],
          nextCursor: null,
        };
      if (request.method === "config/read")
        result = {
          config: {
            mcp_servers: {
              "company.tools": {
                command: "secret-tool",
                enabled: true,
                url: null,
              },
            },
          },
        };
      if (request.method === "thread/start")
        result = { thread: { id: `thread-${++thread}`, cwd: params.cwd } };
      if (request.method === "thread/resume")
        result = { thread: { id: params.threadId, cwd: params.cwd } };
      if (request.method === "turn/start")
        result = { turn: { id: `turn-${++turn}` } };
      if (request.method === "turn/interrupt")
        emit({
          method: "turn/completed",
          params: {
            threadId: params.threadId,
            turn: { id: params.turnId, status: "interrupted" },
          },
        });
      if (request.method === "thread/backgroundTerminals/list")
        result = { data: terminals, nextCursor: null };
      if (
        request.method === "thread/backgroundTerminals/terminate" &&
        termination
      ) {
        await termination;
        terminals = [];
      }
      emit({ id: request.id, result });
    },
    end: vi.fn(async () => {
      closed = true;
      exits.resolve(0);
    }),
    kill: vi.fn(async () => {
      exits.resolve(null);
    }),
    exited: exits.promise,
  };
  let closed = false;
  let appServerSpawns = 0;
  const fileReads: { cwd?: string; path: string }[] = [];
  const spawn = vi.fn(async (_id: string, value?: HostProcessOptions) => {
    // The plugin starts the app server as a step of Buzz's `codex.sh`.
    const appServer =
      _id === "app-server" ||
      value?.args?.slice(2, 4).join(" ") === "run app-server";
    if (plugin && appServer && appServerSpawns++ === 0) {
      const catalogExit = deferred<number | null>();
      return {
        write: async (data: string) => {
          const request: Wire = JSON.parse(data);
          if (request.id == null) return;
          const result =
            request.method === "account/read"
              ? { account: { type: "chatgpt" } }
              : request.method === "model/list"
                ? { data: [], nextCursor: null }
                : {};
          value?.onStdout?.(`${JSON.stringify({ id: request.id, result })}\n`);
        },
        end: async () => catalogExit.resolve(0),
        kill: async () => catalogExit.resolve(null),
        exited: catalogExit.promise,
      };
    }
    if (_id === "workspace") {
      value?.onStdout?.("/home/test/.buzz\n");
      return { ...process, exited: Promise.resolve(0) };
    }
    if (_id === "read") {
      fileReads.push({
        ...(value?.cwd ? { cwd: value.cwd } : {}),
        path: value?.args?.[0] ?? "",
      });
      value?.onStdout?.(
        btoa(
          value?.args?.[0] === "attachment.jpg"
            ? "\xff\xd8\xff"
            : "FILE CONTENT",
        ),
      );
      return { ...process, exited: Promise.resolve(0) };
    }
    // The plugin's setup checks find Buzz's copy installed and signed in.
    const step = value?.args?.slice(3).join(" ");
    if (step === "--version" || step === "login status") {
      value?.onStdout?.("codex-cli 0.162.1\n");
      return { ...process, exited: Promise.resolve(0) };
    }
    options = value;
    return process;
  });
  const emit = (value: Wire) =>
    options?.onStdout?.(`${JSON.stringify(value)}\n`);
  const publish = vi.fn(async (event: unknown) => ({
    ...(event as object),
    id: "d".repeat(64),
  }));
  const read = vi.fn(async () => [] as EventData[]);
  const memories: { slug: string; body: string; createdAt: number }[] = [];
  const memoryRead = vi.fn(async () => ({ entries: memories, partial: false }));
  const memoryView = {
    refresh: vi.fn(async () => {}),
    snapshot: () => ({
      status: "ready",
      listing: { entries: memories, partial: false },
    }),
    dispose: vi.fn(),
  };
  const memoryOpen = vi.fn(() => memoryView);
  const snapshot = {
    status: "ready",
    scope: scope as string | undefined,
    session: {
      workflowAuthority: undefined as string | undefined,
      profiles: {
        ensure: vi.fn(async () => {}),
        event: vi.fn(
          (_key: string): ReturnType<typeof eventDto> | undefined => undefined,
        ),
      },
      read,
      agentMemories: { open: memoryOpen, read: memoryRead },
      channels: {
        list: () => ({
          channels: [{ id: "channel", name: "test", channelType: "stream" }],
        }),
      },
    },
  };
  const relay = { snapshot: () => snapshot } as unknown as RelayData;
  const store = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  } as Storage;
  const runtime = new CodexRuntime(spawn, () => relay, store);
  runtimes.push(runtime);
  const events: EventData[] = [];
  const query = vi.fn(async (filters: readonly Record<string, unknown>[]) =>
    events.filter((event) =>
      filters.some((filter) =>
        Object.entries(filter).every(([key, value]) => {
          if (key === "ids") return (value as string[]).includes(event.id);
          if (key === "kinds") return (value as number[]).includes(event.kind);
          if (key.startsWith("#"))
            return event.tags.some(
              ([name, item]) =>
                name === key.slice(1) &&
                (value as string[]).includes(item ?? ""),
            );
          return true;
        }),
      ),
    ),
  );
  const remember = vi.fn(async (slug: string, body: string, after: number) => {
    const index = memories.findIndex((memory) => memory.slug === slug);
    if (index >= 0) memories.splice(index, 1);
    memories.push({ slug, body, createdAt: after + 1 });
  });
  const upload = vi.fn(async (_data: string, mime: string) => ({
    url: "https://files.test/file",
    sha256: "e".repeat(64),
    size: 12,
    type: mime,
  }));
  const workingUntil = vi.fn<Delivery["workingUntil"]>();
  const media = vi.fn(async () => btoa("\x89PNG\r\n"));
  const agent = {
    pubkey,
    owner,
    name: "Codex",
    publish,
    query,
    upload,
    media,
    remember,
  };
  runtime.sync([{ pubkey } as Agent]);
  let id = 0;
  const delivery = (content: string, threadRoot = root): Delivery => {
    const result: Delivery = {
      trigger: {
        type: "mention",
        event: {
          id: (++id).toString(16).padStart(64, "0"),
          pubkey: owner,
          kind: 9,
          content,
          created_at: 10,
          tags: [
            ["h", "channel"],
            ["e", threadRoot, "", "reply"],
          ],
        } as Extract<Delivery["trigger"], { type: "mention" }>["event"],
      },
      channelId: "channel",
      agent: agent as unknown as Delivery["agent"],
      config: {
        workspace: "/tmp/codex-test",
        model: "test-model",
        effort: "low",
        instructions: "TEST_INSTRUCTIONS",
      },
      signal: new AbortController().signal,
      workingUntil,
      current: () => true,
    };
    if (result.trigger.type !== "timer")
      events.push(result.trigger.event as EventData);
    return result;
  };
  /** Agents' running agents, whichever community is selected. */
  const running = [{ ...agent, type: "buzz.codex/codex" }];
  const listeners: (() => void)[] = [];
  let runPlugin: (delivery: Delivery) => Promise<void> = (delivery) =>
    runtime.run(delivery);
  let pluginDispose = () => {};
  if (plugin) {
    vi.stubGlobal("localStorage", store);
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    apply({
      host: { spawn },
      agents: {
        snapshot: () => ({ status: "ready", agents: [], running }),
        relay: () => relay,
        subscribe: (listener: () => void) => {
          listeners.push(listener);
          return () => {};
        },
        register: (type: { run: typeof runPlugin }) => {
          runPlugin = type.run;
        },
      },
      effect: (effect: () => () => void) => {
        pluginDispose = effect();
      },
    } as unknown as Parameters<typeof apply>[0]);
  }
  const starts = () => sent.filter((wire) => wire.method === "turn/start");
  const interrupt = () => {
    const index = starts().length - 1;
    const params = starts()[index]?.params as { threadId: string };
    emit({
      method: "turn/completed",
      params: {
        threadId: params.threadId,
        turn: { id: `turn-${index + 1}`, status: "interrupted" },
      },
    });
  };
  let toolId = 0;
  const tool = async (
    name: string,
    args: unknown,
    index = starts().length - 1,
    overrides = {},
  ) => {
    const threadId = (
      starts()[index]?.params as { threadId: string } | undefined
    )?.threadId;
    const id = `tool-${++toolId}`;
    toolCalls.set(id, { threadId, turnId: `turn-${index + 1}`, callId: id });
    emit({
      id,
      method: "item/tool/call",
      params: {
        threadId,
        turnId: `turn-${index + 1}`,
        namespace: "buzz",
        callId: id,
        tool: name,
        arguments: args,
        ...overrides,
      },
    });
    await vi.waitFor(() =>
      expect(sent.some((wire) => wire.id === id && !wire.method)).toBe(true),
    );
    return sent.find((wire) => wire.id === id && !wire.method);
  };
  const complete = async (index = starts().length - 1, text = "DONE") => {
    if (!closed && text)
      await tool("send", { audience: "everyone", text, final: true }, index);
    const params = starts()[index]?.params as { threadId: string };
    emit({
      method: "item/completed",
      params: {
        threadId: params.threadId,
        item: { type: "agentMessage", text, phase: "final_answer" },
      },
    });
    emit({
      method: "turn/completed",
      params: {
        threadId: params.threadId,
        turn: { id: `turn-${index + 1}`, status: "completed" },
      },
    });
  };
  return {
    runtime,
    tool,
    query,
    fileReads,
    memoryOpen,
    memoryRead,
    memoryView,
    remember,
    upload,
    running,
    media,
    runPlugin: (delivery: Delivery) => runPlugin(delivery),
    notify: () =>
      listeners.forEach((listener) => {
        listener();
      }),
    pluginDispose: () => pluginDispose(),
    spawn,
    process,
    sent,
    failing,
    emit,
    publish,
    read,
    storage,
    delivery,
    workingUntil,
    starts,
    complete,
    interrupt,
    snapshot,
    exits,
  };
}
it("hands over promptly and runs conversations independently on one server", async () => {
  const f = fixture();
  await f.runtime.run({
    ...f.delivery("@Codex first"),
    team: "<team>\nCrew\n</team>",
  });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  expect(f.publish).not.toHaveBeenCalled();
  await f.runtime.run(f.delivery("@Codex independent", "e".repeat(64)));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  expect(f.spawn).toHaveBeenCalledTimes(1);
  f.complete(0, "FIRST");
  f.complete(1, "OTHER");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
  const started = f.sent.find((wire) => wire.method === "thread/start")
    ?.params as Record<string, unknown>;
  expect(started).toMatchObject({
    model: "test-model",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  });
  expect(started.baseInstructions).toBeUndefined();
  expect(started.developerInstructions).toContain("coding agent in Buzz");
  expect(started.developerInstructions).toContain(
    "Never publish a bare acknowledgement.",
  );
  expect(started.developerInstructions).toContain(BUZZ_PROMPT);
  expect(f.starts()[0]?.params).toMatchObject({
    additionalContext: {
      "buzz.instructions": {
        kind: "application",
        value: expect.stringContaining("TEST_INSTRUCTIONS"),
      },
    },
  });
  expect(f.starts()[0]?.params).toMatchObject({
    additionalContext: {
      "buzz.instructions": {
        value: expect.stringContaining(
          "</agent-instructions>\n\nCurrent team sections replace all prior team sections. None means you are on no team.\n<team>\nCrew\n</team>",
        ),
      },
    },
  });
  expect(f.starts()[1]?.params).toMatchObject({
    additionalContext: {
      "buzz.instructions": {
        value: expect.not.stringContaining("<team>"),
      },
    },
  });
  expect(f.starts()[1]?.params).toMatchObject({
    additionalContext: {
      "buzz.instructions": {
        value: expect.stringContaining(
          "Your `core` memory is auto-injected into your context every turn",
        ),
      },
    },
  });
  expect((started.config as Record<string, unknown>).mcp_servers).toEqual({
    "company.tools": { enabled: false, command: "secret-tool" },
  });
  expect(started.config).toMatchObject({
    web_search: "disabled",
    mcp_servers: { "company.tools": { enabled: false } },
    "features.apps": false,
    "features.plugins": false,
  });
  expect(f.spawn.mock.calls[0]?.[1]).not.toHaveProperty("agent");
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    kind: 9,
    content: "FIRST",
    tags: expect.arrayContaining([["e", root, "", "reply"]]),
  });
});
/** A second agent on the same runtime, with its own identity and publisher. */
function second(f: ReturnType<typeof fixture>) {
  const other = "9".repeat(64);
  const base = f.delivery("unused").agent;
  const agent = {
    ...base,
    pubkey: other,
    name: "Other",
    publish: vi.fn(async (event: unknown) => ({
      ...(event as object),
      id: "8".repeat(64),
    })),
  } as unknown as Delivery["agent"];
  f.runtime.sync([{ pubkey } as Agent, { pubkey: other } as Agent]);
  return {
    agent,
    delivery: (content: string) => ({
      ...f.delivery(content, "7".repeat(64)),
      agent,
    }),
  };
}
const contents = (publish: { mock: { calls: unknown[][] } }) =>
  publish.mock.calls.map(([event]) => (event as { content: string }).content);
const servers = (f: ReturnType<typeof fixture>) =>
  f.spawn.mock.calls.filter(([id]) => id === "app-server");
it("serves every agent from one server and routes each tool call to its own agent", async () => {
  const f = fixture();
  const b = second(f);
  await f.runtime.run(f.delivery("@Codex first"));
  await f.runtime.run(b.delivery("@Other second"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  expect(servers(f)).toHaveLength(1);
  expect(f.starts()[1]?.params).toMatchObject({
    additionalContext: {
      "buzz.instructions": { value: expect.stringContaining("Other") },
    },
  });
  await f.complete(1, "FROM OTHER");
  await f.complete(0, "FROM CODEX");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(b.agent.publish).toHaveBeenCalledTimes(1));
  expect(contents(f.publish)).toEqual(["FROM CODEX"]);
  expect(contents(b.agent.publish as never)).toEqual(["FROM OTHER"]);
  expect(f.runtime.sessions("9".repeat(64))[0]?.status).toBe("Idle");
});
it("stops a removed agent's turn without ending the server the others share", async () => {
  const f = fixture();
  const b = second(f);
  await f.runtime.run(f.delivery("work"));
  await f.runtime.run(b.delivery("other work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  const removed = (f.starts()[1]?.params as { threadId: string } | undefined)
    ?.threadId;
  f.runtime.sync([{ pubkey } as Agent]);
  await vi.waitFor(() =>
    expect(
      f.sent.some(
        (wire) =>
          wire.method === "thread/unsubscribe" &&
          (wire.params as { threadId: string }).threadId === removed,
      ),
    ).toBe(true),
  );
  for (const method of ["turn/interrupt", "thread/backgroundTerminals/clean"])
    expect(f.sent.find((wire) => wire.method === method)?.params).toMatchObject(
      { threadId: removed },
    );
  expect(f.process.end).not.toHaveBeenCalled();
  expect(f.runtime.sessions("9".repeat(64))).toHaveLength(0);
  await f.complete(0, "STILL HERE");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(contents(f.publish)).toEqual(["STILL HERE"]);
  expect(b.agent.publish).not.toHaveBeenCalled();
  f.runtime.sync([]);
  await f.exits.promise;
  expect(f.process.end).toHaveBeenCalled();
});
it("ends a stopped agent's leftover shells and lets it start again only after letting go", async () => {
  const f = fixture();
  const b = second(f);
  await f.runtime.run(f.delivery("work"));
  await f.runtime.run(b.delivery("start a dev server"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  const thread = (f.starts()[1]?.params as { threadId: string } | undefined)
    ?.threadId;
  await f.complete(1, "SERVER RUNNING");
  await vi.waitFor(() => expect(b.agent.publish).toHaveBeenCalledTimes(1));
  await f.runtime.run(b.delivery("busy again"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(3));
  const index = (method: string) =>
    f.sent
      .map(
        (wire) =>
          wire.method === method &&
          (wire.params as { threadId: string }).threadId === thread,
      )
      .lastIndexOf(true);
  const before = index("thread/unsubscribe");
  f.runtime.sync([{ pubkey } as Agent]);
  f.runtime.sync([{ pubkey } as Agent, { pubkey: "9".repeat(64) } as Agent]);
  await f.runtime.run(b.delivery("back"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(4));
  expect(index("thread/unsubscribe")).toBeGreaterThan(before);
  expect(index("thread/backgroundTerminals/clean")).toBeGreaterThan(
    index("thread/unsubscribe"),
  );
  expect(index("thread/resume")).toBeGreaterThan(
    index("thread/backgroundTerminals/clean"),
  );
  expect(f.process.end).not.toHaveBeenCalled();
  await f.complete(3, "BACK");
  await f.complete(0, "STILL HERE");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(b.agent.publish).toHaveBeenCalledTimes(2));
  expect(contents(b.agent.publish as never)).toEqual([
    "SERVER RUNNING",
    "BACK",
  ]);
});
it("logs a failed idle terminal clean without ending the shared server or blocking the agent's return", async () => {
  const f = fixture([{ processId: "dev-server" }]);
  const b = second(f);
  await f.runtime.run(f.delivery("work"));
  await f.runtime.run(b.delivery("start a dev server"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  const thread = (f.starts()[1]?.params as { threadId: string } | undefined)
    ?.threadId;
  await f.complete(1, "SERVER RUNNING");
  await vi.waitFor(() => expect(b.agent.publish).toHaveBeenCalledTimes(1));
  f.failing.add("thread/backgroundTerminals/clean");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  f.runtime.sync([{ pubkey } as Agent]);
  await vi.waitFor(() =>
    expect(error).toHaveBeenCalledWith(
      "Codex could not clean a stopped agent's terminals",
      new Error("thread/backgroundTerminals/clean failed"),
    ),
  );
  error.mockRestore();
  expect(
    f.sent.find((wire) => wire.method === "thread/backgroundTerminals/clean")
      ?.params,
  ).toMatchObject({ threadId: thread });
  expect(f.process.end).not.toHaveBeenCalled();
  await f.complete(0, "STILL HERE");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(contents(f.publish)).toEqual(["STILL HERE"]);
  f.runtime.sync([{ pubkey } as Agent, { pubkey: "9".repeat(64) } as Agent]);
  await f.runtime.run(b.delivery("back"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(3));
  expect(
    f.sent.find((wire) => wire.method === "thread/resume")?.params,
  ).toMatchObject({ threadId: thread });
  await f.complete(2, "BACK");
  await vi.waitFor(() => expect(b.agent.publish).toHaveBeenCalledTimes(2));
  expect(contents(b.agent.publish as never)).toEqual([
    "SERVER RUNNING",
    "BACK",
  ]);
});
it("does not clean or log a cleanup error after the last agent closes the server", async () => {
  const f = fixture([{ processId: "dev-server" }]);
  await f.runtime.run(f.delivery("start a dev server"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.complete(0, "SERVER RUNNING");
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers();
  try {
    f.runtime.sync([]);
    await vi.runAllTimersAsync();
    expect(f.process.end).toHaveBeenCalledTimes(1);
    expect(
      f.sent.some((wire) => wire.method === "thread/backgroundTerminals/clean"),
    ).toBe(false);
    expect(error).not.toHaveBeenCalled();
    expect(f.runtime.sessions(pubkey)).toHaveLength(0);
  } finally {
    vi.useRealTimers();
    error.mockRestore();
  }
});
it("reopens the shared server after it exits", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.exits.resolve(3);
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  await f.runtime.run(f.delivery("again"));
  await vi.waitFor(() => expect(servers(f)).toHaveLength(2));
});
it("discovers models and efforts before any turn, sharing one read-only lookup", async () => {
  const f = fixture();
  const agent = { pubkey, config: { workspace: "/tmp/codex-test" } } as Agent;
  const one = f.runtime.preview(agent);
  const two = f.runtime.preview(agent);
  f.runtime.sync([agent]);
  expect(one).toBe(two);
  await expect(one).resolves.toEqual({
    current: "test-model",
    models: [
      {
        id: "test-model",
        label: "Test Model",
        efforts: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
        effort: "medium",
      },
      {
        id: "deep-model",
        label: "deep-model",
        efforts: [
          { id: "high", label: "High" },
          { id: "xhigh", label: "Extra high" },
        ],
        effort: "high",
      },
    ],
  });
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.spawn.mock.calls[0]?.[1]?.cwd).toBe("~/.buzz");
  expect(f.starts()).toEqual([]);
  expect(f.sent.some((wire) => wire.method === "thread/start")).toBe(false);
  expect(f.process.end).not.toHaveBeenCalled();
  expect(f.runtime.preview(agent)).toBe(one);
  f.runtime.sync([]);
  f.spawn.mockRejectedValueOnce(new Error("offline"));
  await expect(f.runtime.preview(agent)).rejects.toThrow("offline");
});
it("shares model discovery with active turns and another agent", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const b = second(f);
  await Promise.all([
    f.runtime.preview(f.delivery("unused").agent as unknown as Agent),
    f.runtime.preview(b.agent as unknown as Agent),
  ]);
  expect(servers(f)).toHaveLength(1);
  expect(f.process.end).not.toHaveBeenCalled();
  f.complete();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
});
it("still offers the listed models when the configured one is not listed", async () => {
  const f = fixture();
  const agent = {
    pubkey,
    config: { workspace: "/tmp/codex-test", model: "newer-model" },
  } as Agent;
  const { current, models } = await f.runtime.preview(agent);
  expect(current).toBe("newer-model");
  expect(models.map((model) => [model.id, model.efforts.length])).toEqual([
    ["newer-model", 0],
    ["test-model", 3],
    ["deep-model", 2],
  ]);
});
it("previews each model at the configured effort when it has it", async () => {
  const f = fixture();
  const agent = {
    pubkey,
    config: { workspace: "/tmp/codex-test", effort: "low" },
  } as Agent;
  const { models } = await f.runtime.preview(agent);
  expect(models.map((model) => model.effort)).toEqual(["low", "high"]);
});
it("starts a turn at the effort its owner picked when the model supports it", async () => {
  const f = fixture();
  await f.runtime.run({ ...f.delivery("@Codex hard"), effort: "high" });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.runtime.run({
    ...f.delivery("@Codex other", "e".repeat(64)),
    effort: "max",
  });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  expect(
    f.starts().map((wire) => (wire.params as { effort?: string }).effort),
  ).toEqual(["high", "low"]);
});
it("starts a turn on the model its owner picked, at an effort that model supports", async () => {
  const f = fixture();
  const run = async (
    thread: string,
    pick: { model?: string; effort?: string },
  ) => {
    const before = f.starts().length;
    await f.runtime.run({ ...f.delivery("@Codex", thread), ...pick });
    await vi.waitFor(() => expect(f.starts()).toHaveLength(before + 1));
  };
  await run("a".repeat(64), { model: "deep-model", effort: "xhigh" });
  // The configured `low` is not one of its levels, so it runs at its default.
  await run("b".repeat(64), { model: "deep-model" });
  // A model Codex no longer lists falls back to the agent's own.
  await run("c".repeat(64), { model: "gone-model" });
  expect(
    f.starts().map((wire) => {
      const { model, effort } = wire.params as {
        model: string;
        effort: string;
      };
      return { model, effort };
    }),
  ).toEqual([
    { model: "deep-model", effort: "xhigh" },
    { model: "deep-model", effort: "high" },
    { model: "test-model", effort: "low" },
  ]);
});
it("runs a mid-turn pick that differs from the running turn as the next turn instead of steering", async () => {
  const f = fixture();
  const settings = (wire: Wire) => {
    const { threadId, model, effort } = wire.params as Record<string, string>;
    return { threadId, model, effort };
  };
  await f.runtime.run(f.delivery("first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.runtime.run({
    ...f.delivery("deeper"),
    model: "deep-model",
    effort: "xhigh",
  });
  await f.complete(0, "FIRST");
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  // An effort pick alone queues too, on the agent's own model.
  await f.runtime.run({ ...f.delivery("harder"), effort: "high" });
  await f.complete(1, "SECOND");
  await vi.waitFor(() => expect(f.starts()).toHaveLength(3));
  expect(f.sent.filter((wire) => wire.method === "turn/steer")).toHaveLength(0);
  expect(f.starts().map(settings)).toEqual([
    { threadId: "thread-1", model: "test-model", effort: "low" },
    { threadId: "thread-1", model: "deep-model", effort: "xhigh" },
    { threadId: "thread-1", model: "test-model", effort: "high" },
  ]);
  f.complete(2, "THIRD");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(3));
  expect(
    f.publish.mock.calls.map(([event]) => (event as EventData).content),
  ).toEqual(["FIRST", "SECOND", "THIRD"]);
});
it("keeps a plain follow-up behind a queued differing pick instead of steering past it", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.runtime.run({ ...f.delivery("deeper"), model: "deep-model" });
  await f.runtime.run(f.delivery("plain"));
  await f.complete(0, "FIRST");
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  // "plain" is still queued while "deeper" runs, so this cannot steer either.
  await f.runtime.run(f.delivery("later"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await f.complete(1, "SECOND");
  await vi.waitFor(() => expect(f.starts()).toHaveLength(3));
  await f.complete(2, "THIRD");
  await vi.waitFor(() => expect(f.starts()).toHaveLength(4));
  expect(f.sent.filter((wire) => wire.method === "turn/steer")).toHaveLength(0);
  const input = (index: number) => JSON.stringify(f.starts()[index]?.params);
  expect(input(1)).toContain("deeper");
  expect(input(1)).toContain('"model":"deep-model"');
  expect(input(2)).toContain("plain");
  expect(input(2)).toContain('"model":"test-model"');
  expect(input(3)).toContain("later");
  f.complete(3, "FOURTH");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(4));
  expect(
    f.publish.mock.calls.map(([event]) => (event as EventData).content),
  ).toEqual(["FIRST", "SECOND", "THIRD", "FOURTH"]);
});
it("steers a mid-turn message whose pick matches the running turn, or has none", async () => {
  const f = fixture();
  await f.runtime.run({
    ...f.delivery("first"),
    model: "test-model",
    effort: "low",
  });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.runtime.run({
    ...f.delivery("same"),
    model: "test-model",
    effort: "low",
  });
  await f.runtime.run(f.delivery("plain"));
  await vi.waitFor(() =>
    expect(f.sent.filter((wire) => wire.method === "turn/steer")).toHaveLength(
      2,
    ),
  );
  f.complete();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.starts()).toHaveLength(1);
});
it("serializes owner follow-ups and routes tool replies to the latest accepted request", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const gate = deferred<EventData[]>();
  f.read.mockImplementationOnce(() => gate.promise);
  const a = f.runtime.run(f.delivery("🤖 @Codex FIRST_STEER"));
  const b = f.runtime.run(f.delivery("SECOND_STEER"));
  try {
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
    expect(f.publish).not.toHaveBeenCalled();
  } finally {
    gate.resolve([]);
  }
  await Promise.all([a, b]);
  await vi.waitFor(() =>
    expect(f.sent.filter((w) => w.method === "turn/steer")).toHaveLength(2),
  );
  // Each mention counts as working until the turn it was steered into answers.
  let settled = 0;
  for (const [done] of f.workingUntil.mock.calls)
    void Promise.resolve(done).then(() => settled++);
  expect(f.workingUntil).toHaveBeenCalledTimes(3);
  // A macrotask lets every pending promise chain finish first.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(0);
  f.complete();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(settled).toBe(3));
  const steering = f.sent.filter((wire) => wire.method === "turn/steer");
  expect(JSON.stringify(steering[0]?.params)).toContain("FIRST_STEER");
  expect(JSON.stringify(steering[1]?.params)).toContain("SECOND_STEER");
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    tags: expect.arrayContaining([["e", "c".repeat(64), "", "reply"]]),
  });
});
it("cuts delayed history off before the request, including same-second messages and edits", async () => {
  const f = fixture();
  const first = f.delivery("CURRENT_REQUEST");
  if (first.trigger.type === "timer") throw new Error("Expected a mention");
  first.trigger.event.tags.push(["ms", "300"]);
  const gate = deferred<EventData[]>();
  const previous: EventData = {
    ...first.trigger.event,
    id: "6".repeat(64),
    content: "EARLIER_MESSAGE",
    tags: [
      ...first.trigger.event.tags.filter(([key]) => key !== "ms"),
      ["ms", "100"],
    ],
  };
  const edit = (id: string, ms: string, content: string): EventData => ({
    ...previous,
    id: id.repeat(64),
    kind: 40003,
    content,
    tags: [
      ["h", "channel"],
      ["e", previous.id],
      ["ms", ms],
    ],
  });
  f.read
    .mockReturnValueOnce(gate.promise)
    .mockResolvedValueOnce([
      edit("f", "250", "EARLIER_EDIT"),
      edit("e", "350", "FUTURE_EDIT"),
    ]);
  await f.runtime.run(first);
  const later = f.delivery("LATER_REQUEST");
  if (later.trigger.type === "timer") throw new Error("Expected a mention");
  later.trigger.event.tags.push(["ms", "400"]);
  try {
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1));
    await f.runtime.run(later);
    expect(f.starts()).toHaveLength(0);
  } finally {
    gate.resolve([
      previous,
      { ...first.trigger.event, id: "0".repeat(64), content: "TIE_BEFORE" },
      first.trigger.event as EventData,
      { ...first.trigger.event, id: "9".repeat(64), content: "TIE_AFTER" },
      later.trigger.event as EventData,
    ]);
  }
  await vi.waitFor(() =>
    expect(f.sent.filter((wire) => wire.method === "turn/steer")).toHaveLength(
      1,
    ),
  );
  const params = f.starts()[0]?.params as { input: { text: string }[] };
  const history = params.input[0]?.text.match(
    /<thread-context>\n([\s\S]*?)\n<\/thread-context>/,
  )?.[1];
  expect(history).toBeDefined();
  expect(
    JSON.parse(history ?? "{}").messages.map(
      (message: { content: string }) => message.content,
    ),
  ).toEqual(["EARLIER_EDIT", "TIE_BEFORE"]);
  expect(
    JSON.stringify(f.sent.find((wire) => wire.method === "turn/steer")?.params),
  ).toContain("LATER_REQUEST");
  await f.complete();
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
});

it.each([
  { channelType: "dm", scope: "thread", whole: true },
  { channelType: "stream", scope: "channel", whole: false },
  { channelType: "stream", scope: "thread", whole: false },
])(
  "defaults Buzz reads to the latest conversation in $channelType/$scope",
  async ({ channelType, scope, whole }) => {
    const f = fixture();
    vi.spyOn(f.snapshot.session.channels, "list").mockReturnValue({
      channels: [{ id: "channel", name: "test", channelType }],
    });
    const otherRoot = "e".repeat(64);
    f.delivery("OTHER_THREAD_CONTEXT", otherRoot);
    const first = f.delivery("CURRENT_REQUEST");
    await f.runtime.run({
      ...first,
      config: { ...(first.config as object), scope },
    });
    await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
    const initial = JSON.stringify((await f.tool("read", {}))?.result);
    expect(initial).toContain("CURRENT_REQUEST");
    expect(initial.includes("OTHER_THREAD_CONTEXT")).toBe(whole);
    const latest = f.delivery(
      "LATEST_REQUEST",
      scope === "thread" && !whole ? root : otherRoot,
    );
    await f.runtime.run({
      ...latest,
      config: { ...(latest.config as object), scope },
    });
    await vi.waitFor(() =>
      expect(
        f.sent.filter((wire) => wire.method === "turn/steer"),
      ).toHaveLength(1),
    );
    const after = JSON.stringify((await f.tool("read", {}))?.result);
    expect(after).toContain("LATEST_REQUEST");
    expect(after.includes("CURRENT_REQUEST")).toBe(whole || scope === "thread");
    expect(after.includes("OTHER_THREAD_CONTEXT")).toBe(
      whole || scope === "channel",
    );
    await f.complete();
    await vi.waitFor(() =>
      expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
    );
  },
);
it("cleans background terminals on server interruption and permits same-thread recovery", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.interrupt();
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Interrupted"),
  );
  expect(
    f.sent.some((wire) => wire.method === "thread/backgroundTerminals/clean"),
  ).toBe(true);
  expect(f.starts()).toHaveLength(1);
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining("turn was interrupted"),
  });
  await expect(f.workingUntil.mock.calls[0]?.[0]).resolves.toEqual({
    ok: false,
    error: "Codex’s turn was interrupted",
  });
  await f.runtime.run(f.delivery("recover"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  f.complete();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
  expect(f.sent.filter((wire) => wire.method === "thread/resume")).toHaveLength(
    1,
  );
});
it("closes a native process returned after runtime disposal", async () => {
  const f = fixture();
  const gate = deferred<Awaited<ReturnType<typeof f.spawn>>>();
  const started = deferred<void>();
  const original = f.spawn.getMockImplementation();
  f.spawn.mockImplementationOnce(async (id, options) => {
    await original?.(id, options);
    started.resolve();
    return gate.promise;
  });
  await f.runtime.run(f.delivery("work"));
  await started.promise;
  f.runtime.dispose();
  try {
    expect(f.starts()).toHaveLength(0);
  } finally {
    gate.resolve(f.process);
  }
  await f.exits.promise;
  expect(f.starts()).toHaveLength(0);
  expect(f.process.end).toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});
it("ignores non-owner messages without spawning", async () => {
  const f = fixture();
  const other = f.delivery("work");
  if (other.trigger.type !== "timer")
    other.trigger.event.pubkey = "f".repeat(64);
  const ignored = vi.fn();
  await f.runtime.run({ ...other, ignored });
  expect(ignored).toHaveBeenCalledOnce();
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});
it("runs a verified relay workflow mention for its owner", async () => {
  const f = fixture();
  const relay = keypair();
  f.snapshot.session.workflowAuthority = relay.pubkey;
  const ask = f.delivery("@Codex workflow");
  const event = eventDto(
    signed(relay, {
      kind: 9,
      content: "@Codex workflow",
      tags: [
        ["h", "channel"],
        ["p", pubkey],
        ["buzz:workflow", "true"],
        ["buzz:workflow-owner", owner],
        ["buzz:workflow-mention", pubkey],
      ],
    }),
  );
  const ignored = vi.fn();
  await f.runtime.run({ ...ask, trigger: { type: "mention", event }, ignored });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  expect(ignored).not.toHaveBeenCalled();
  await f.complete();
  expect(f.publish).toHaveBeenCalled();
});
it.each([false, true])(
  "handles sibling workflow authorization with cancellation=%s",
  async (cancelled) => {
    const f = fixture();
    const relay = keypair(),
      human = keypair(),
      creator = keypair();
    const attestation = [
      "auth",
      human.pubkey,
      "",
      bytesToHex(
        schnorr.sign(
          createHash("sha256")
            .update(`nostr:agent-auth:${creator.pubkey}:`)
            .digest(),
          human.secret,
        ),
      ),
    ];
    const profile = eventDto(
      signed(creator, { kind: 0, content: "{}", tags: [attestation] }),
    );
    f.snapshot.session.workflowAuthority = relay.pubkey;
    f.snapshot.session.profiles.event.mockReturnValue(profile);
    const gate = deferred<void>();
    const controller = new AbortController();
    f.snapshot.session.profiles.ensure.mockReturnValue(gate.promise);
    const ask = f.delivery("work");
    const event = eventDto(
      signed(relay, {
        kind: 9,
        content: "@Codex workflow",
        tags: [
          ["h", "channel"],
          ["p", pubkey],
          ["buzz:workflow", "true"],
          ["buzz:workflow-owner", creator.pubkey],
          ["buzz:workflow-mention", pubkey],
        ],
      }),
    );
    const done = f.runtime.run({
      ...ask,
      signal: controller.signal,
      agent: { ...ask.agent, owner: human.pubkey },
      trigger: { type: "mention", event },
    });
    await vi.waitFor(() =>
      expect(f.snapshot.session.profiles.ensure).toHaveBeenCalledOnce(),
    );
    if (cancelled) {
      f.runtime.sync([]);
      controller.abort();
      gate.resolve();
      await expect(done).rejects.toMatchObject({ name: "AbortError" });
      expect(f.spawn).not.toHaveBeenCalled();
      expect(f.workingUntil).not.toHaveBeenCalled();
      expect(f.runtime.sessions(pubkey)).toEqual([]);
      return;
    }
    gate.resolve();
    await done;
    await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
    expect(f.snapshot.session.profiles.ensure).toHaveBeenCalledWith([
      creator.pubkey,
    ]);
    await f.complete();
    expect(f.publish).toHaveBeenCalled();
  },
);
it("ignores a relay workflow mention without explicit community authority", async () => {
  const f = fixture();
  const relay = keypair();
  const event = eventDto(
    signed(relay, {
      kind: 9,
      content: "@Codex workflow",
      tags: [
        ["h", "channel"],
        ["p", pubkey],
        ["buzz:workflow", "true"],
        ["buzz:workflow-owner", owner],
        ["buzz:workflow-mention", pubkey],
      ],
    }),
  );
  const ignored = vi.fn();
  await f.runtime.run({
    ...f.delivery("work"),
    trigger: { type: "mention", event },
    ignored,
  });
  expect(ignored).toHaveBeenCalledOnce();
  expect(f.spawn).not.toHaveBeenCalled();
});
it("answers another agent its owner attested, telling the owner of failures", async () => {
  const f = fixture();
  const secret = schnorr.utils.randomSecretKey();
  const owner = bytesToHex(schnorr.getPublicKey(secret));
  const sibling = bytesToHex(
    schnorr.getPublicKey(schnorr.utils.randomSecretKey()),
  );
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${sibling}:`)
    .digest();
  const ask = f.delivery("work");
  if (ask.trigger.type !== "timer") {
    ask.trigger.event.pubkey = sibling;
    ask.trigger.event.tags.push([
      "auth",
      owner,
      "",
      bytesToHex(schnorr.sign(digest, secret)),
    ]);
  }
  await f.runtime.run({ ...ask, agent: { ...ask.agent, owner } });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  // A failure tells the owner: tagging the sibling would wake it to fail too.
  f.complete(0, "");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  const failure = f.publish.mock.calls[0]?.[0] as { tags: string[][] };
  expect(failure.tags).toContainEqual(["p", owner]);
  expect(failure.tags).not.toContainEqual(["p", sibling]);
});
it("publishes unexpected exit and empty-completion failures instead of silently losing work", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.complete(0, "");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining("without a final reply"),
  });
  await expect(f.workingUntil.mock.calls[0]?.[0]).resolves.toMatchObject({
    ok: false,
  });
  await f.runtime.run(f.delivery("next"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  f.exits.resolve(3);
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
  expect(f.publish.mock.calls[1]?.[0]).toMatchObject({
    content: expect.stringContaining("Codex exited"),
  });
  await expect(f.workingUntil.mock.calls[1]?.[0]).resolves.toMatchObject({
    ok: false,
    error: expect.stringContaining("Codex exited"),
  });
});
it("sets no deadline of its own on a turn", async () => {
  // Any deadline Buzz set would already have passed.
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
    AbortSignal.abort(
      new DOMException("The operation timed out.", "TimeoutError"),
    ),
  );
  const f = fixture();
  await f.runtime.run(f.delivery("a long job"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.complete();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({ content: "DONE" });
});
it("ends the server when its agent stops running and suppresses a late final answer", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.runtime.sync([]);
  f.complete();
  await f.exits.promise;
  expect(f.process.end).toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});

it("reports an interruption cleanup failure when Codex reports surviving terminals", async () => {
  const f = fixture([{ processId: "42" }]);
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.interrupt();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining(
      "background terminals could not be stopped",
    ),
  });
  expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Needs attention");
  expect(f.process.end).toHaveBeenCalled();
});
it("restores a persisted binding after reload and starts fresh in a different workspace", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.complete();
  await vi.waitFor(() =>
    expect(f.sent.some((w) => w.method === "thread/unsubscribe")).toBe(true),
  );
  f.runtime.dispose();
  await f.exits.promise;
  const restored = fixture();
  for (const [key, value] of f.storage) restored.storage.set(key, value);
  await restored.runtime.run(restored.delivery("continue"));
  await vi.waitFor(() => expect(restored.starts()).toHaveLength(1));
  expect(
    restored.sent.find((w) => w.method === "thread/resume")?.params,
  ).toMatchObject({ excludeTurns: true });
  restored.complete();
  await vi.waitFor(() =>
    expect(restored.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  const useDefaults = restored.delivery("defaults");
  await restored.runtime.run({
    ...useDefaults,
    config: { workspace: "/tmp/codex-test" },
  });
  await vi.waitFor(() => expect(restored.starts()).toHaveLength(2));
  expect(restored.starts()[1]?.params).toMatchObject({
    model: "test-model",
    effort: "medium",
  });
  restored.complete();
  await vi.waitFor(() => expect(restored.publish).toHaveBeenCalledTimes(2));
  const changed = restored.delivery("new workspace");
  await restored.runtime.run({
    ...changed,
    config: { workspace: "/tmp/different-workspace" },
  });
  await vi.waitFor(() => expect(restored.starts()).toHaveLength(3));
  expect(restored.sent.some((w) => w.method === "thread/start")).toBe(true);
  expect(restored.starts()[2]?.params).toMatchObject({
    model: "test-model",
    effort: "medium",
  });
  restored.complete();
  await vi.waitFor(() => expect(restored.publish).toHaveBeenCalledTimes(3));
});

it("waits for terminal termination after asynchronous clean acknowledgement before reporting interruption", async () => {
  const gate = deferred<void>();
  const f = fixture([{ processId: "42" }], gate.promise);
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.interrupt();
  try {
    await vi.waitFor(() =>
      expect(
        f.sent.some((w) => w.method === "thread/backgroundTerminals/terminate"),
      ).toBe(true),
    );
    expect(f.publish).not.toHaveBeenCalled();
  } finally {
    gate.resolve();
  }
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining("turn was interrupted"),
  });
  expect(f.process.end).not.toHaveBeenCalled();
});

it("publishes workspace errors without starting work", async () => {
  const f = fixture();
  await f.runtime.run({
    ...f.delivery("hello"),
    config: { workspace: "relative" },
  });
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining("absolute or ~/… workspace"),
  });
  expect(f.spawn).not.toHaveBeenCalled();
});

it("resolves a workspace under home through the process host", async () => {
  const f = fixture();
  await f.runtime.run({
    ...f.delivery("hello"),
    config: { workspace: "~/code" },
  });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  expect(f.spawn).toHaveBeenCalledWith(
    "workspace",
    expect.objectContaining({ cwd: "~/code" }),
  );
  f.runtime.dispose();
});

it.each([{}, { workspace: "" }, { workspace: "  " }])(
  "runs blank workspace settings in the resolved default: %j",
  async (config) => {
    const f = fixture();
    await f.runtime.run({ ...f.delivery("hello"), config });
    await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
    expect(f.spawn).toHaveBeenCalledWith(
      "app-server",
      expect.objectContaining({ cwd: "~/.buzz" }),
    );
    expect(f.spawn).toHaveBeenCalledWith(
      "workspace",
      expect.objectContaining({ cwd: "~/.buzz" }),
    );
    for (const method of ["config/read", "thread/start"])
      expect(
        f.sent.find((wire) => wire.method === method)?.params,
      ).toMatchObject({ cwd: "/home/test/.buzz" });
    f.complete(0, "DONE");
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
    await f.runtime.run({ ...f.delivery("again"), config });
    await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
    expect(
      f.sent.find((wire) => wire.method === "thread/resume")?.params,
    ).toMatchObject({ cwd: "/home/test/.buzz" });
    f.complete(1, "DONE AGAIN");
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
    f.runtime.dispose();
  },
);

it("reports a default workspace resolution failure without starting a turn", async () => {
  const f = fixture();
  const spawn = f.spawn.getMockImplementation();
  if (!spawn) throw new Error("Missing spawn fixture");
  f.spawn.mockImplementation(async (id, options) =>
    id === "workspace"
      ? { ...f.process, exited: Promise.resolve(1) }
      : spawn(id, options),
  );
  await f.runtime.run({ ...f.delivery("hello"), config: {} });
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining(
      "Could not resolve the Codex workspace ~/.buzz",
    ),
  });
  expect(f.starts()).toHaveLength(0);
});

it("uses the default after changing away from a custom workspace on an existing server", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("custom"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.complete(0, "CUSTOM");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  await f.runtime.run({ ...f.delivery("default"), config: {} });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  const threads = f.sent.filter((wire) => wire.method === "thread/start");
  expect(threads.map((wire) => (wire.params as { cwd: string }).cwd)).toEqual([
    "/tmp/codex-test",
    "/home/test/.buzz",
  ]);
  f.complete(1, "DEFAULT");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
});

it("posts tool-sent parts and never duplicates native assistant text", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.tool("send", { audience: "everyone", text: "PART ONE" });
  await f.tool("send", { audience: "everyone", text: "PART TWO" });
  await f.complete(0, "FINAL");
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  expect(
    f.publish.mock.calls.map(
      ([event]) => (event as { content: string }).content,
    ),
  ).toEqual(["PART ONE", "PART TWO", "FINAL"]);
  const response = f.sent.findIndex(
    (wire) => wire.id === "tool-3" && !wire.method,
  );
  const interrupt = f.sent.findIndex(
    (wire) => wire.method === "turn/interrupt",
  );
  expect(response).toBeGreaterThan(-1);
  expect(interrupt).toBe(-1);
});
it("delivers a plain follow-up after startup without waiting for the running turn", async () => {
  const f = fixture();
  const gate = deferred<Awaited<ReturnType<typeof f.spawn>>>();
  const started = deferred<void>();
  const original = f.spawn.getMockImplementation();
  f.spawn.mockImplementationOnce(async (id, options) => {
    await original?.(id, options);
    started.resolve();
    return gate.promise;
  });
  await f.runtime.run(f.delivery("first"));
  await started.promise;
  try {
    await f.runtime.run(f.delivery("during startup"));
    expect(f.starts()).toHaveLength(0);
  } finally {
    gate.resolve(f.process);
  }
  await vi.waitFor(() =>
    expect(f.sent.filter((w) => w.method === "turn/steer")).toHaveLength(1),
  );
  expect(f.starts()).toHaveLength(1);
  f.complete();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
});

it("keeps plugin work alive through relay reconnect and ends it when its agent stops running", async () => {
  const f = fixture([], undefined, true);
  try {
    await f.runPlugin(f.delivery("work"));
    await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
    f.snapshot.status = "connecting";
    f.snapshot.scope = undefined;
    f.notify();
    f.snapshot.status = "ready";
    f.snapshot.scope = scope;
    f.notify();
    f.complete();
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
    expect(f.process.end).not.toHaveBeenCalled();
    await f.runPlugin(f.delivery("more work"));
    await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
    f.running.length = 0;
    f.notify();
    f.complete();
    await f.exits.promise;
    expect(f.process.end).toHaveBeenCalled();
    expect(f.publish).toHaveBeenCalledTimes(1);
  } finally {
    f.pluginDispose();
  }
});

it("starts the next turn when completion races a plain follow-up's history read", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const gate = deferred<EventData[]>();
  f.read.mockImplementationOnce(() => gate.promise);
  await f.runtime.run(f.delivery("follow-up"));
  try {
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
    await f.complete(0, "FIRST");
  } finally {
    gate.resolve([]);
  }
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  expect(f.sent.filter((wire) => wire.method === "turn/steer")).toHaveLength(0);
  f.complete(1, "SECOND");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
  expect(f.publish.mock.calls[1]?.[0]).toMatchObject({ content: "SECOND" });
});

it.each(["/queue", "/stop", "/steer", "/reset"])(
  "delivers %s as ordinary steering text",
  async (command) => {
    const f = fixture();
    await f.runtime.run(f.delivery("work"));
    await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
    const content = `${command} ordinary text`;
    await f.runtime.run(f.delivery(content));
    await vi.waitFor(() =>
      expect(
        f.sent.filter((wire) => wire.method === "turn/steer"),
      ).toHaveLength(1),
    );
    const steer = f.sent.find((wire) => wire.method === "turn/steer")
      ?.params as { input: { text: string }[] };
    expect(steer.input[0]?.text).toContain(
      `Request: ${JSON.stringify(content)}`,
    );
    expect(f.publish).not.toHaveBeenCalled();
    f.complete();
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  },
);
it.each(["v2", "v3"])(
  "starts fresh instead of restoring a %s binding, whose tools are out of date",
  async (version) => {
    const f = fixture();
    f.storage.set(
      `buzz.codex.sessions.${version}:${scope}:${pubkey}`,
      JSON.stringify({
        [JSON.stringify(["channel", root])]: {
          threadId: "legacy-thread",
          workspace: "/tmp/codex-test",
        },
      }),
    );
    await f.runtime.run(f.delivery("new work"));
    await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
    expect(
      f.sent.filter((wire) => wire.method === "thread/resume"),
    ).toHaveLength(0);
    const thread = f.sent.find((wire) => wire.method === "thread/start")
      ?.params as { dynamicTools: { tools: { name: string }[] }[] };
    expect(thread.dynamicTools[0]?.tools.map((tool) => tool.name)).toContain(
      "media_get",
    );
    f.complete();
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  },
);

it("leaves a failed first startup unbound so the next mention can start fresh", async () => {
  const f = fixture();
  const reading = deferred<void>();
  const gate = deferred<void>();
  f.read.mockImplementationOnce(async () => {
    reading.resolve();
    await gate.promise;
    throw new Error("Relay history unavailable");
  });
  await f.runtime.run(f.delivery("first"));
  await reading.promise;
  try {
    expect(f.storage.size).toBe(0);
    expect(f.starts()).toHaveLength(0);
  } finally {
    gate.resolve();
  }
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining("Relay history unavailable"),
  });
  await f.runtime.run(f.delivery("retry"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  expect(f.sent.filter((wire) => wire.method === "thread/start")).toHaveLength(
    2,
  );
  expect(f.sent.filter((wire) => wire.method === "thread/resume")).toHaveLength(
    0,
  );
  f.complete();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
  expect(JSON.parse([...f.storage.values()][0] ?? "{}")).toMatchObject({
    [JSON.stringify(["channel", root])]: { threadId: "thread-2" },
  });
});

it.each([
  ["no rollout found for thread id thread-1", true],
  ["Permission denied reading saved thread", false],
])("recovers only a missing saved thread: %s", async (error, recover) => {
  const f = fixture();
  await f.runtime.run(f.delivery("first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.complete();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  const write = f.process.write;
  vi.spyOn(f.process, "write").mockImplementation(async (data) => {
    const wire: Wire = JSON.parse(data);
    if (wire.method !== "thread/resume" || wire.id == null) return write(data);
    f.sent.push(wire);
    f.emit({ id: wire.id, error: { code: -32600, message: error } });
  });
  await f.runtime.run(f.delivery("follow-up"));
  if (recover) {
    await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
    expect(f.starts()[1]?.params).toMatchObject({ threadId: "thread-2" });
    f.complete();
  }
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
  expect(f.publish.mock.calls[1]?.[0]).toMatchObject({
    content: recover ? "DONE" : expect.stringContaining(error),
  });
  expect(JSON.parse([...f.storage.values()][0] ?? "{}")).toMatchObject({
    [JSON.stringify(["channel", root])]: {
      threadId: recover ? "thread-2" : "thread-1",
    },
  });
});

it("routes callbacks by thread and turn, rejecting stale, unknown and malformed tools without writes", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("first"));
  await f.runtime.run(f.delivery("other", "e".repeat(64)));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  for (const overrides of [
    { turnId: "stale" },
    { threadId: "missing" },
    { namespace: "other" },
    { tool: "unknown" },
    { arguments: [] },
  ]) {
    expect(
      (
        await f.tool(
          "send",
          { audience: "everyone", text: "must not send" },
          0,
          overrides,
        )
      )?.result,
    ).toMatchObject({
      success: false,
      contentItems: [{ type: "inputText", text: expect.any(String) }],
    });
  }
  expect(f.publish).not.toHaveBeenCalled();
  await f.complete(1, "OTHER");
  await f.complete(0, "FIRST");
  await vi.waitFor(() =>
    expect(
      f.runtime.sessions(pubkey).every((view) => view.status === "Idle"),
    ).toBe(true),
  );
  expect(f.publish.mock.calls.map(([event]) => event)).toMatchObject([
    {
      content: "OTHER",
      tags: expect.arrayContaining([["e", "e".repeat(64), "", "reply"]]),
    },
    {
      content: "FIRST",
      tags: expect.arrayContaining([["e", root, "", "reply"]]),
    },
  ]);
  const count = f.publish.mock.calls.length;
  expect(
    (await f.tool("send", { audience: "everyone", text: "late" }, 0))?.result,
  ).toMatchObject({
    success: false,
  });
  expect(f.publish).toHaveBeenCalledTimes(count);
});

it("gives each turn the agent's current core memory, and goes on without it when unreadable", async () => {
  const f = fixture();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const memory = (index: number) =>
    (
      f.starts()[index]?.params as
        | { additionalContext?: Record<string, { value: string }> }
        | undefined
    )?.additionalContext?.["buzz.instructions"]?.value;
  await f.runtime.run(f.delivery("@Codex first"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  expect(memory(0)).toContain(
    "Current core memory replaces all prior core memory.\n<core-memory>\nNo core memory found.",
  );
  f.complete(0, "FIRST");
  await f.remember("core", "I am Codex.", 0);
  await f.runtime.run(f.delivery("@Codex second", "e".repeat(64)));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
  expect(memory(1)).toContain(
    "Current core memory replaces all prior core memory.\n<core-memory>\nI am Codex.\n</core-memory>",
  );
  f.complete(1, "SECOND");
  f.memoryRead.mockRejectedValueOnce(new Error("offline"));
  await f.runtime.run(f.delivery("@Codex third", "f".repeat(64)));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(3));
  expect(memory(2)).toContain("TEST_INSTRUCTIONS");
  expect(memory(2)).not.toContain("<core-memory>");
  expect(warn).toHaveBeenCalledWith(
    "Codex could not read the agent's memory",
    expect.any(Error),
  );
  f.complete(2, "THIRD");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(3));
  warn.mockRestore();
});

it("does not declare core missing when the owner listing is partial", async () => {
  const f = fixture();
  f.memoryRead.mockResolvedValueOnce({ entries: [], partial: true });
  await f.runtime.run(f.delivery("partial"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const start = f.starts()[0];
  expect(start).toBeDefined();
  const instructions = (
    start?.params as {
      additionalContext?: Record<string, { value: string }>;
    }
  )?.additionalContext?.["buzz.instructions"]?.value;
  expect(instructions).toContain("TEST_INSTRUCTIONS");
  expect(instructions).not.toContain("No core memory found");
  expect(instructions).not.toContain("<core-memory>");
});

it("coalesces concurrent core reads before the owner-view pool is exhausted", async () => {
  const f = fixture();
  const gate = deferred<void>();
  const read = vi.fn(async () => {
    await gate.promise;
    return {
      entries: [
        {
          slug: "core",
          body: "CONCURRENT CORE",
          eventId: "6".repeat(64),
          createdAt: 1,
        },
      ],
      partial: false,
    };
  });
  const memories = createAgentMemories(read, owner, () => true);
  f.snapshot.session.agentMemories =
    memories.capability as unknown as typeof f.snapshot.session.agentMemories;

  await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      f.runtime.run(
        f.delivery(`concurrent ${index}`, index.toString(16).repeat(64)),
      ),
    ),
  );
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  expect(f.starts()).toHaveLength(0);

  gate.resolve();
  await vi.waitFor(() => expect(f.starts()).toHaveLength(5));
  for (const start of f.starts())
    expect(start.params).toMatchObject({
      additionalContext: {
        "buzz.instructions": {
          value: expect.stringContaining("CONCURRENT CORE"),
        },
      },
    });
});

it("uses the launched workspace for shared file tools and the owner view for encrypted memory", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  await f.runtime.run({
    ...f.delivery("follow-up"),
    config: { workspace: "/tmp/different" },
  });
  await vi.waitFor(() =>
    expect(f.sent.some((wire) => wire.method === "turn/steer")).toBe(true),
  );
  expect(
    (await f.tool("mem_set", { slug: "mem/test", text: "remembered" }))?.result,
  ).toMatchObject({ success: true });
  expect((await f.tool("mem_get", { slug: "mem/test" }))?.result).toMatchObject(
    { success: true, contentItems: [{ text: "remembered" }] },
  );
  expect(
    (await f.tool("media_get", { url: "shot.png" }))?.result,
  ).toMatchObject({
    success: true,
    contentItems: [
      {
        type: "inputImage",
        imageUrl: `data:image/png;base64,${btoa("\x89PNG\r\n")}`,
      },
    ],
  });
  expect(f.media).toHaveBeenCalledWith("shot.png");
  expect(f.memoryRead).toHaveBeenCalledWith(pubkey, expect.any(AbortSignal));
  expect(f.remember).toHaveBeenCalledWith("mem/test", "remembered", 0);
  // The turn's own `core` read, then mem_set's read and a fresh post-write read.
  expect(f.memoryRead).toHaveBeenCalledTimes(3);
  expect(
    (
      await f.tool("send", {
        audience: "everyone",
        path: "answer.txt",
        files: ["attachment.jpg"],
        final: true,
      })
    )?.result,
  ).toMatchObject({ success: true });
  f.emit({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    },
  });
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  expect(f.fileReads).toEqual([
    { cwd: "/tmp/codex-test", path: "attachment.jpg" },
    { cwd: "/tmp/codex-test", path: "answer.txt" },
  ]);
  expect(f.upload).toHaveBeenCalledWith(btoa("\xff\xd8\xff"), "image/jpeg");
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining("FILE CONTENT"),
    tags: expect.arrayContaining([["e", "c".repeat(64), "", "reply"]]),
  });
});

it("returns a failed send to Codex for correction without ending its turn", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.publish.mockRejectedValueOnce(new Error("Signing rejected"));
  expect(
    (
      await f.tool("send", {
        audience: "everyone",
        text: "answer",
        final: true,
      })
    )?.result,
  ).toMatchObject({
    success: false,
    contentItems: [{ type: "inputText", text: "Signing rejected" }],
  });
  expect(f.sent.some((wire) => wire.method === "turn/interrupt")).toBe(false);
  await f.complete();
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  expect(f.publish).toHaveBeenCalledTimes(2);
});

it.each(["accepted", "rejected"] as const)(
  "moves same-thread activity only after steering is accepted: %s",
  async (outcome) => {
    const f = fixture();
    const first = { step: vi.fn(), acknowledged: vi.fn(), superseded: vi.fn() };
    const next = { step: vi.fn(), acknowledged: vi.fn(), superseded: vi.fn() };
    await f.runtime.run({ ...f.delivery("first"), ...first });
    await vi.waitFor(() => expect(first.acknowledged).toHaveBeenCalledOnce());
    const started = f.starts()[0];
    if (!started) throw new Error("Expected started turn");
    const threadId = (started.params as { threadId: string }).threadId;
    const step = (command: string) =>
      f.emit({
        method: "item/started",
        params: { threadId, item: { type: "commandExecution", command } },
      });
    step("sleep 20");
    expect(first.step).toHaveBeenLastCalledWith("Shell", "sleep");
    const requested = deferred<void>();
    const response = deferred<void>();
    const write = f.process.write;
    f.process.write = async (data) => {
      const wire: Wire = JSON.parse(data);
      if (wire.method !== "turn/steer") return write(data);
      if (wire.id === undefined) throw new Error("Expected steering RPC id");
      requested.resolve();
      await response.promise;
      if (outcome === "rejected") {
        f.emit({
          id: wire.id,
          error: { code: -32000, message: "Cannot accept follow-up" },
        });
        return;
      }
      await write(data);
    };
    try {
      await f.runtime.run({ ...f.delivery("follow-up"), ...next });
      await requested.promise;
      step("ls");
      expect(first.step).toHaveBeenLastCalledWith("Shell", "ls");
      expect(first.superseded).not.toHaveBeenCalled();
      expect(next.acknowledged).not.toHaveBeenCalled();
      expect(next.step).not.toHaveBeenCalled();
      response.resolve();
      if (outcome === "accepted") {
        await vi.waitFor(() =>
          expect(next.acknowledged).toHaveBeenCalledOnce(),
        );
        expect(first.superseded).toHaveBeenCalledOnce();
        step("pwd");
        expect(next.step).toHaveBeenLastCalledWith("Shell", "pwd");
        expect(first.step).toHaveBeenLastCalledWith("Shell", "ls");
        await f.tool("send", {
          audience: "everyone",
          text: "Updated answer",
          final: true,
        });
        for (const [done] of f.workingUntil.mock.calls)
          await expect(done).resolves.toEqual({ ok: true });
      } else {
        await expect(f.workingUntil.mock.calls[1]?.[0]).resolves.toMatchObject({
          ok: false,
        });
        expect(first.superseded).not.toHaveBeenCalled();
        expect(next.acknowledged).not.toHaveBeenCalled();
        step("pwd");
        expect(first.step).toHaveBeenLastCalledWith("Shell", "pwd");
        await f.tool("send", {
          audience: "everyone",
          text: "Original answer",
          final: true,
        });
        await expect(f.workingUntil.mock.calls[0]?.[0]).resolves.toEqual({
          ok: true,
        });
      }
      await f.complete();
      await vi.waitFor(() =>
        expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
      );
    } finally {
      response.resolve();
    }
  },
);

it("keeps each thread's activity in a shared session and does not move it to watches", async () => {
  const f = fixture();
  const first = { step: vi.fn(), acknowledged: vi.fn(), superseded: vi.fn() };
  const second = { step: vi.fn(), acknowledged: vi.fn(), superseded: vi.fn() };
  const delivery = (text: string, threadRoot: string) => {
    const d = f.delivery(text, threadRoot);
    return { ...d, config: { ...(d.config as object), scope: "channel" } };
  };
  await f.runtime.run({ ...delivery("first thread", root), ...first });
  await vi.waitFor(() => expect(first.acknowledged).toHaveBeenCalledOnce());
  await f.runtime.run({
    ...delivery("second thread", "e".repeat(64)),
    ...second,
  });
  await vi.waitFor(() => expect(second.acknowledged).toHaveBeenCalledOnce());
  expect(first.superseded).not.toHaveBeenCalled();
  const watch = delivery("watched message", root);
  if (watch.trigger.type !== "mention") throw new Error("Expected mention");
  const watched = { step: vi.fn(), acknowledged: vi.fn(), superseded: vi.fn() };
  await f.runtime.run({
    ...watch,
    ...watched,
    trigger: {
      type: "watch",
      event: watch.trigger.event,
      slug: "watch/test",
      watch: {
        type: "event",
        enabled: true,
        interest_id: "test",
        since: 0,
        channels: "all",
        kinds: [9],
      },
    },
  });
  await vi.waitFor(() =>
    expect(f.sent.filter((w) => w.method === "turn/steer")).toHaveLength(2),
  );
  // A tool call waits for the steering chain, establishing that the watch was taken.
  await f.tool("send", {
    audience: "everyone",
    text: "Progress",
    final: false,
  });
  const started = f.starts()[0];
  if (!started) throw new Error("Expected started turn");
  const threadId = (started.params as { threadId: string }).threadId;
  f.emit({
    method: "item/started",
    params: { threadId, item: { type: "reasoning" } },
  });
  expect(first.step).toHaveBeenLastCalledWith("Thinking", undefined);
  expect(second.step).toHaveBeenLastCalledWith("Thinking", undefined);
  expect(first.superseded).not.toHaveBeenCalled();
  expect(second.superseded).not.toHaveBeenCalled();
  expect(watched.acknowledged).not.toHaveBeenCalled();
  expect(watched.step).not.toHaveBeenCalled();
  await f.complete();
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
});

it("delivers pending owner steering after a final send and posts its own answer", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const gate = deferred<EventData[]>();
  f.read.mockImplementationOnce(() => gate.promise);
  await f.runtime.run(f.delivery("new request"));
  try {
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
    await f.tool("send", {
      audience: "everyone",
      text: "prior answer",
      final: true,
    });
    expect(f.sent.some((wire) => wire.method === "turn/interrupt")).toBe(false);
  } finally {
    gate.resolve([]);
  }
  await vi.waitFor(() =>
    expect(f.sent.some((wire) => wire.method === "turn/steer")).toBe(true),
  );
  // The prior answer settles only the first request.
  let steered = false;
  void Promise.resolve(f.workingUntil.mock.calls[1]?.[0]).then(() => {
    steered = true;
  });
  await f.workingUntil.mock.calls[0]?.[0];
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(steered).toBe(false);
  await f.complete(0, "NEW ANSWER");
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  expect(
    f.publish.mock.calls.map(
      ([event]) => (event as { content: string }).content,
    ),
  ).toEqual(["prior answer", "NEW ANSWER"]);
});

it("lets go of a rejected steering mention without ending the running turn", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const write = f.process.write;
  vi.spyOn(f.process, "write").mockImplementation(async (data) => {
    const wire: Wire = JSON.parse(data);
    if (wire.method !== "turn/steer" || wire.id == null) return write(data);
    f.sent.push(wire);
    f.emit({ id: wire.id, error: { code: -32600, message: "model busy" } });
  });
  await f.runtime.run(f.delivery("new request"));
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
    content: expect.stringContaining("Steering was not accepted: model busy"),
  });
  // The rejection answers the mention; the turn it could not join works on.
  let working = false;
  let rejected = false;
  void Promise.resolve(f.workingUntil.mock.calls[0]?.[0]).then(() => {
    working = true;
  });
  void Promise.resolve(f.workingUntil.mock.calls[1]?.[0]).then(() => {
    rejected = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.workingUntil).toHaveBeenCalledTimes(2);
  expect(rejected).toBe(true);
  expect(working).toBe(false);
  expect(f.starts()).toHaveLength(1);
  await f.complete(0, "FIRST ANSWER");
  await vi.waitFor(() =>
    expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle"),
  );
  expect(working).toBe(true);
  expect(
    f.publish.mock.calls.map(
      ([event]) => (event as { content: string }).content,
    ),
  ).toEqual([
    expect.stringContaining("Steering was not accepted"),
    "FIRST ANSWER",
  ]);
});

it("finishes final sends normally and preserves the agent's background terminals", async () => {
  const f = fixture([{ processId: "dev-server" }]);
  await f.runtime.run(f.delivery("start server"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const reply = await f.tool("send", {
    audience: "everyone",
    text: "http://localhost:3000",
    final: true,
  });
  expect(reply?.result).toMatchObject({ success: true });
  expect(f.publish).toHaveBeenCalledTimes(1);
  expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Working");
  expect(f.sent.some((wire) => wire.method === "turn/interrupt")).toBe(false);
  // The request is answered, so it stops counting as working before Codex's
  // closing model call ends the turn.
  await expect(f.workingUntil.mock.calls[0]?.[0]).resolves.toEqual({
    ok: true,
  });
  const threadId = (f.starts()[0]?.params as { threadId: string } | undefined)
    ?.threadId;
  f.emit({
    method: "turn/completed",
    params: { threadId, turn: { id: "turn-1", status: "completed" } },
  });
  await vi.waitFor(() =>
    expect(f.sent.some((wire) => wire.method === "thread/unsubscribe")).toBe(
      true,
    ),
  );
  expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Idle");
  expect(
    f.sent.some((wire) =>
      wire.method?.startsWith("thread/backgroundTerminals/"),
    ),
  ).toBe(false);
  expect(f.process.end).not.toHaveBeenCalled();
  expect(f.publish).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "stops an in-flight file reader at turn end, including late spawn: %s",
  async (late) => {
    const f = fixture();
    await f.runtime.run(f.delivery("work"));
    await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
    const exited = deferred<number | null>();
    const started = deferred<void>();
    const gate = deferred<Awaited<ReturnType<typeof f.spawn>>>();
    const kill = vi.fn(async () => {
      exited.resolve(null);
    });
    const child = { ...f.process, kill, exited: exited.promise };
    f.spawn.mockImplementationOnce(async () => {
      started.resolve();
      return late ? gate.promise : child;
    });
    const reading = f.tool("send", {
      audience: "everyone",
      path: "answer.txt",
      final: true,
    });
    await started.promise;
    f.interrupt();
    try {
      await vi.waitFor(() =>
        expect(f.runtime.sessions(pubkey)[0]?.status).toBe("Interrupted"),
      );
    } finally {
      gate.resolve(child);
    }
    expect((await reading)?.result).toMatchObject({ success: false });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
      content: expect.stringContaining("turn was interrupted"),
    });
  },
);

it("lists saved conversations newest first from storage, and moves a started one to the front", async () => {
  const f = fixture();
  const thread = JSON.stringify(["channel", root]);
  const channel = JSON.stringify(["channel", "channel"]);
  const elsewhere = JSON.stringify(["unlisted", root]);
  f.storage.set(
    `buzz.codex.sessions.v4:${scope}:${pubkey}`,
    JSON.stringify({
      [channel]: { threadId: "before-timestamps", workspace: "/w" },
      [thread]: { threadId: "older", workspace: "/w", at: 1 },
      [elsewhere]: { threadId: "newer", workspace: "/w", at: 2 },
      "not a key": { threadId: "ignored", workspace: "/w", at: 3 },
    }),
  );
  expect(f.runtime.conversations(pubkey)).toEqual([
    {
      key: elsewhere,
      channelId: "unlisted",
      root,
      threadId: "newer",
      at: 2,
    },
    {
      key: thread,
      channelId: "channel",
      name: "test",
      root,
      threadId: "older",
      at: 1,
    },
    {
      key: channel,
      channelId: "channel",
      name: "test",
      threadId: "before-timestamps",
    },
  ]);
  await f.runtime.run(f.delivery("work"));
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  const [latest] = f.runtime.conversations(pubkey);
  expect(latest?.at).toBeGreaterThan(2);
  const stored = Object.keys(
    JSON.parse(
      f.storage.get(`buzz.codex.sessions.v4:${scope}:${pubkey}`) ?? "{}",
    ),
  );
  expect(stored.at(-1)).toBe(latest?.key);
  await f.complete();
});

describe("codexStep", () => {
  it("maps started items into the shared step vocabulary", () => {
    expect(codexStep({ type: "commandExecution", command: "ls" })).toEqual({
      tool: "Shell",
      target: "ls",
    });
    expect(
      codexStep({
        type: "commandExecution",
        command: "sed -n 1,40p src/a.ts",
        commandActions: [{ type: "read", name: "a.ts", path: "src/a.ts" }],
      }),
    ).toEqual({ tool: "Read", target: "a.ts" });
    expect(
      codexStep({
        type: "commandExecution",
        command: "rg agent",
        commandActions: [{ type: "search", query: "agent", path: null }],
      }),
    ).toEqual({ tool: "Grep", target: "agent" });
    expect(
      codexStep({ type: "fileChange", changes: [{ path: "/x/notes.md" }] }),
    ).toEqual({ tool: "Edit", target: "notes.md" });
    expect(codexStep({ type: "mcpToolCall", tool: "send_message" })).toEqual({
      tool: "send_message",
    });
    expect(codexStep({ type: "reasoning" })).toEqual({ tool: "Thinking" });
    expect(codexStep({ type: "userMessage" })).toBeUndefined();
    expect(codexStep(undefined)).toBeUndefined();
  });
});

describe("programs", () => {
  it("names the programs a command runs, without the shell wrapper or scripts", () => {
    expect(
      programs(
        `/bin/zsh -lc "mktemp /tmp/activity-test.XXXX | xargs -I'{}' sh -c 'printf hello > \\"$1\\"; printf x' sh '{}'"`,
      ),
    ).toBe("mktemp, xargs");
    expect(programs("which copilot || true")).toBe("which, true");
    expect(programs("FOO=1 /usr/bin/git status && pnpm test")).toBe(
      "git, pnpm",
    );
    expect(programs("a; b; c; d; e")).toBe("a, b, c and 2 more");
    expect(programs("")).toBeUndefined();
  });
});
