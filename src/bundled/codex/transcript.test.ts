import { expect, it, vi } from "vitest";
import type { HostProcessOptions } from "../../features/host/service";
import type { Wire } from "./rpc";
import { sessionTag } from "./prompt";
import {
  codexTurns,
  findConversation,
  readTranscript,
  shellCommand,
  TURN_LIMIT,
} from "./transcript";

const root = "c".repeat(64);
const conversation = { channelId: "channel", root };
const input = `<context>\n{"channel_id":"channel"}\n</context>\n<buzz-event>\n{"id":"e","pubkey":"sam"}\nRequest: "fix the \\u003ctests\\u003e"\n</buzz-event>`;
const turn = (patch: Record<string, unknown> = {}) => ({
  id: "turn-1",
  status: "completed",
  error: null,
  startedAt: 100,
  completedAt: 160,
  items: [
    {
      type: "userMessage",
      id: "u1",
      content: [{ type: "text", text: input }],
    },
    { type: "reasoning", id: "r1", summary: ["Looking at tests"] },
    {
      type: "commandExecution",
      id: "c1",
      command: "/bin/zsh -lc 'pnpm test'",
      aggregatedOutput: "1 failed",
      status: "failed",
      durationMs: 2000,
    },
    {
      type: "userMessage",
      id: "u2",
      content: [
        {
          type: "text",
          text: '<new-message-arrived-while-you-were-working>\n{}\nRequest: "also lint"\n</new-message-arrived-while-you-were-working>',
        },
      ],
    },
    {
      type: "fileChange",
      id: "f1",
      status: "completed",
      changes: [{ path: "a.ts", kind: "update", diff: "-a\n+b" }],
    },
    {
      type: "dynamicToolCall",
      id: "d1",
      namespace: "buzz",
      tool: "send",
      arguments: { text: "Done" },
      status: "completed",
      contentItems: [{ type: "inputText", text: "sent" }],
      success: true,
    },
    { type: "agentMessage", id: "a1", text: "Fixed." },
    { type: "contextCompaction", id: "x1" },
    // A final answer after the reply went through send.
    { type: "agentMessage", id: "a2", text: "" },
  ],
  ...patch,
});

it("shows a Codex turn's request, steering, tools and reply in the shared transcript model", () => {
  const [mapped] = codexTurns([turn()], conversation, (pubkey) =>
    pubkey === "sam" ? "Sam" : undefined,
  );
  expect(mapped).toMatchObject({
    turnId: "turn-1",
    channelId: "channel",
    threadRootId: root,
    startedAt: 100_000,
    endedAt: 160_000,
  });
  expect(mapped?.items).toEqual([
    expect.objectContaining({
      type: "prompt",
      text: "fix the <tests>",
      author: "Sam",
      steer: false,
      sections: [
        expect.objectContaining({ tag: "context" }),
        expect.objectContaining({ tag: "buzz-event" }),
      ],
    }),
    expect.objectContaining({ type: "thought", text: "Looking at tests" }),
    expect.objectContaining({
      type: "tool",
      title: "pnpm test",
      kind: "execute",
      status: "failed",
      output: "1 failed",
      completedAt: 102_000,
    }),
    expect.objectContaining({ type: "prompt", text: "also lint", steer: true }),
    expect.objectContaining({
      type: "tool",
      kind: "edit",
      paths: ["a.ts"],
      output: "-a\n+b",
    }),
    expect.objectContaining({ type: "message", text: "Done", posted: true }),
    expect.objectContaining({ type: "message", text: "Fixed." }),
  ]);
  const [channelTurn] = codexTurns(
    [turn({ status: "interrupted", completedAt: null, items: [] })],
    { channelId: "channel" },
  );
  expect(channelTurn).toMatchObject({
    threadRootId: null,
    stopReason: "interrupted",
  });
  expect(channelTurn).not.toHaveProperty("endedAt");
});

const agent = { pubkey: "a".repeat(64), name: "Sol" };
const lookup = { agent, channelId: "channel", name: "dev", root };

it("shows the command the model wrote, not the login shell running it", () => {
  expect(shellCommand("/bin/zsh -lc 'git diff --stat'")).toBe(
    "git diff --stat",
  );
  expect(shellCommand(`/bin/bash -lc 'echo '"'"'hi'"'"''`)).toBe("echo 'hi'");
  expect(shellCommand(`/bin/zsh -lc "sed -n '1,9p' a | grep \\"\\$x\\""`)).toBe(
    `sed -n '1,9p' a | grep "$x"`,
  );
  expect(shellCommand("pnpm test")).toBe("pnpm test");
});

it("keeps a send that failed or has not finished as a tool call", () => {
  const send = (id: string, patch: Record<string, unknown>) => ({
    type: "dynamicToolCall",
    id,
    namespace: "buzz",
    tool: "send",
    arguments: { text: "Done" },
    ...patch,
  });
  const [mapped] = codexTurns(
    [
      turn({
        items: [
          send("d1", {
            status: "completed",
            contentItems: [{ type: "inputText", text: "channel not found" }],
            success: false,
          }),
          send("d2", {
            status: "inProgress",
            contentItems: null,
            success: null,
          }),
        ],
      }),
    ],
    conversation,
  );
  expect(mapped?.items).toEqual([
    expect.objectContaining({
      type: "tool",
      title: "buzz.send",
      status: "failed",
      output: "channel not found",
    }),
    expect.objectContaining({
      type: "tool",
      title: "buzz.send",
      status: "in_progress",
    }),
  ]);
});

/** An app-server answering `thread/turns/list` as the test says, and
 * `thread/list` from `threads` as Codex searches names. */
function server(
  list: (params: Record<string, unknown>) => Wire,
  threads: { id: string; name: string; updatedAt: number }[] = [],
) {
  const sent: Wire[] = [];
  const spawn = vi.fn(async (_id: string, options?: HostProcessOptions) => {
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      exit = resolve;
    });
    return {
      write: async (text: string) => {
        const wire: Wire = JSON.parse(text);
        sent.push(wire);
        if (wire.id == null) return;
        const params = wire.params as Record<string, unknown>;
        const reply =
          wire.method === "thread/turns/list"
            ? list(params)
            : wire.method === "thread/list"
              ? {
                  result: {
                    data: threads.filter((thread) =>
                      thread.name.includes(String(params.searchTerm)),
                    ),
                  },
                }
              : { result: {} };
        options?.onStdout?.(`${JSON.stringify({ id: wire.id, ...reply })}\n`);
      },
      end: async () => exit(0),
      kill: async () => exit(1),
      exited,
    };
  });
  return { spawn, sent };
}

/** `thread/turns/list` over a thread's turns, newest first, a page at a time. */
const paged =
  (newest: unknown[]) =>
  ({ limit, cursor }: Record<string, unknown>): Wire => {
    const start = Number(cursor ?? 0);
    const end = start + Number(limit);
    return {
      result: {
        data: newest.slice(start, end),
        nextCursor: end < newest.length ? String(end) : null,
      },
    };
  };

it("reads the latest turns oldest first, a turn per request, and closes its app-server", async () => {
  const { spawn, sent } = server(
    paged([
      turn({ id: "turn-2", status: "inProgress", completedAt: null }),
      turn(),
      ...Array.from({ length: TURN_LIMIT }, (_, index) =>
        turn({ id: `earlier-${index}`, startedAt: 99 - index }),
      ),
    ]),
  );
  const read = await readTranscript(
    spawn,
    { ...lookup, threadId: "thread-1" },
    new AbortController().signal,
  );
  expect(spawn).toHaveBeenCalledWith("app-server", expect.anything());
  const requests = sent.filter((w) => w.method === "thread/turns/list");
  expect(requests).toHaveLength(TURN_LIMIT);
  expect(requests.slice(0, 2).map((w) => w.params)).toEqual([
    {
      threadId: "thread-1",
      limit: 1,
      sortDirection: "desc",
      itemsView: "full",
    },
    {
      threadId: "thread-1",
      limit: 1,
      sortDirection: "desc",
      itemsView: "full",
      cursor: "1",
    },
  ]);
  expect(read?.turns).toHaveLength(TURN_LIMIT);
  expect(read?.turns.slice(-2).map((t) => t.turnId)).toEqual([
    "turn-1",
    "turn-2",
  ]);
  expect(read).toMatchObject({ more: true, working: true });
});

it("reads turns that each fit app-server's output frame but together do not", async () => {
  // Three turns of 1.5 MiB: one per frame fits the 4 MiB bound, all three not.
  const big = (id: string) =>
    turn({
      id,
      items: [
        {
          type: "commandExecution",
          id: "c",
          command: "cat log",
          aggregatedOutput: "x".repeat(1.5 * 1024 * 1024),
          status: "completed",
        },
      ],
    });
  const { spawn } = server(paged([big("c"), big("b"), big("a")]));
  const read = await readTranscript(
    spawn,
    { ...lookup, threadId: "thread-1" },
    new AbortController().signal,
  );
  expect(read?.turns.map((t) => t.turnId)).toEqual(["a", "b", "c"]);
  expect(read?.more).toBe(false);
});

it("merges the threads other builds started, found by tag or by their earlier name", async () => {
  const tag = sessionTag(agent.pubkey, lookup);
  const title = `Buzz #dev · thread ${root.slice(0, 8)} · Sol`;
  const threads = [
    { id: "tagged", name: `Renamed · ${tag}`, updatedAt: 3 },
    { id: "legacy", name: title, updatedAt: 2 },
    // Same name, from a same-named channel elsewhere.
    { id: "same-name", name: title, updatedAt: 9 },
    {
      id: "other-agent",
      name: `${title} · buzz:0000000000000000`,
      updatedAt: 4,
    },
  ];
  const started: Record<string, [number, string]> = {
    "thread-1": [300, "channel"],
    tagged: [200, "channel"],
    legacy: [100, "channel"],
    "same-name": [400, "elsewhere"],
  };
  const list = ({ threadId }: Record<string, unknown>): Wire => {
    const [startedAt, channel] = started[String(threadId)] ?? [0, ""];
    const text = `<context>\n${JSON.stringify({ channel_id: channel, session_thread: root })}\n</context>\nRequest: "hi"`;
    return {
      result: {
        data: [
          turn({
            id: String(threadId),
            startedAt,
            items: [
              {
                type: "userMessage",
                id: "u",
                content: [{ type: "text", text }],
              },
            ],
          }),
        ],
        nextCursor: null,
      },
    };
  };
  const { spawn, sent } = server(list, threads);
  const signal = new AbortController().signal;
  const read = await readTranscript(
    spawn,
    { ...lookup, threadId: "thread-1" },
    signal,
  );
  expect(read?.turns.map((t) => t.turnId)).toEqual([
    "legacy",
    "tagged",
    "thread-1",
  ]);
  expect(
    sent.filter((w) => w.method === "thread/list").map((w) => w.params),
  ).toEqual([
    { searchTerm: tag, limit: 50 },
    { searchTerm: title, limit: 50 },
  ]);
  // With no saved thread, the newest one found for it is the conversation's.
  await expect(
    findConversation(server(list, threads).spawn, lookup, signal),
  ).resolves.toEqual({ threadId: "tagged", at: 3000 });
  await expect(
    findConversation(server(list, threads.slice(1)).spawn, lookup, signal),
  ).resolves.toEqual({ threadId: "legacy", at: 2000 });
  await expect(
    findConversation(
      server(list, []).spawn,
      { agent, channelId: "channel", name: "dev" },
      signal,
    ),
  ).resolves.toBeUndefined();
});

it("treats a thread Codex no longer has as missing, and other failures as errors", async () => {
  const signal = new AbortController().signal;
  const saved = { ...lookup, threadId: "thread-1" };
  const gone = server(() => ({
    error: { code: -32600, message: "thread not loaded: thread-1" },
  }));
  await expect(
    readTranscript(gone.spawn, saved, signal),
  ).resolves.toBeUndefined();
  const broken = server(() => ({
    error: { code: -32603, message: "database is locked" },
  }));
  await expect(readTranscript(broken.spawn, saved, signal)).rejects.toThrow(
    "database is locked",
  );
});
