import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  writeFile,
  appendFile,
  mkdir,
  rm,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentOf,
  createInspector,
  ownsThread,
  threadId,
} from "../../scripts/session-debug.mjs";
import { parseLines, sessionModel } from "../../scripts/session-model.mjs";
const stamp = (n) => new Date(1700000000000 + n * 1000).toISOString();
const event = (n, type, p = {}) => ({
  type: "event_msg",
  timestamp: stamp(n),
  payload: { type, ...p },
});
const id = "a".repeat(64);
const user = (n, text) => ({
  type: "response_item",
  timestamp: stamp(n),
  payload: {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  },
});
const codex = [
  {
    type: "session_meta",
    payload: {
      id: "test",
      base_instructions: { text: "base <script>no()</script>" },
      dynamic_tools: [{ name: "tool", inputSchema: { type: "object" } }],
    },
  },
  event(0, "task_started", { turn_id: "t1" }),
  {
    type: "turn_context",
    timestamp: stamp(0),
    payload: { model: "test-model" },
  },
  user(
    1,
    `<context>\n${JSON.stringify({ session_thread: id })}\n</context>\nRequest: "hello"`,
  ),
  {
    type: "token_usage_record",
    timestamp: stamp(2),
    payload: {
      turn_id: "t1",
      response_id: "r1",
      usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 },
    },
  },
  event(2, "token_count", {
    info: {
      total_token_usage: {
        input_tokens: 100,
        cached_input_tokens: 50,
        output_tokens: 10,
      },
    },
  }),
  event(3, "task_complete", { turn_id: "t1", duration_ms: 2900 }),
];

test("accepts thread links, not arbitrary URLs", () => {
  assert.equal(threadId(`buzz://message?id=${id}`), id);
  assert.throws(() => threadId(`https://example.com/?id=${id}`));
  assert.throws(() => threadId("bad"));
});
test("matches user delivery context, not tool outputs or quoted history", () => {
  assert.equal(ownsThread(codex, id), true);
  assert.equal(
    ownsThread(
      [
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            output: JSON.stringify(codex),
          },
        },
      ],
      id,
    ),
    false,
  );
  assert.equal(
    ownsThread(
      [user(0, `<thread-context>${JSON.stringify(codex)}</thread-context>`)],
      id,
    ),
    false,
  );
});
test("only tolerates a partial final line", () => {
  assert.equal(parseLines('{"a":1}\n{"a":', true).length, 1);
  assert.throws(() => parseLines('{bad}\n{"a":1}\n', true));
});
test("Codex exposes recorded context and counts usage only once", () => {
  const result = sessionModel([...codex, codex[4]], {
    rates: { "test-model": { input: 2, output: 10, cached: 1, written: 2 } },
  });
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].durationMs, 2900);
  assert.equal(result.turns[0].usage.input, 100);
  assert.equal(result.turns[0].requests.length, 1);
  assert.equal(result.turns[0].estimate, 0.00025);
  assert.equal(result.turns[0].cost, null);
  const { instructions, tools } = result.setup;
  assert.deepEqual(
    instructions.map((e) => [e.label, e.scope]),
    [
      ["Base instructions", "developer"],
      ["Run settings", "settings"],
    ],
  );
  assert.equal(instructions[0].body, "base <script>no()</script>");
  assert.equal(tools[0].label, "Dynamic tools · 1 (native tools not recorded)");
  assert.match(tools[0].note, /native tools/);
  assert.deepEqual(tools[0].tools, [
    { name: "tool", description: undefined, schema: { type: "object" } },
  ]);
  assert.ok(result.entries.every((e) => e.kind !== "instructions"));
});
test("Codex keeps prompt setup apart and shows later setting changes inline", () => {
  const context = (n, p) => ({
    type: "turn_context",
    timestamp: stamp(n),
    payload: { turn_id: `t${n}`, model: "m", ...p },
  });
  const message = (n, role, text) => ({
    type: "response_item",
    timestamp: stamp(n),
    payload: {
      type: "message",
      role,
      content: [
        { type: role === "assistant" ? "output_text" : "input_text", text },
      ],
    },
  });
  const result = sessionModel([
    { type: "session_meta", payload: { id: "s", model_provider: "openai" } },
    context(0, { approval_policy: "never" }),
    message(1, "developer", "<multi_agent_role>lead</multi_agent_role>"),
    message(1, "user", "# AGENTS.md instructions for /x\n\nbe kind"),
    message(2, "assistant", "ok"),
    context(3, { approval_policy: "never" }),
    context(4, { approval_policy: "on-request" }),
  ]);
  assert.deepEqual(
    result.setup.instructions.map((e) => [e.label, e.scope]),
    [
      ["Run settings", "settings"],
      ["developer · multi agent role", "developer"],
      ["user · AGENTS.md", "user"],
    ],
  );
  const settings = result.setup.instructions[0].body;
  assert.match(settings, /"model_provider": "openai"/);
  assert.doesNotMatch(settings, /turn_id/);
  const inline = result.entries.filter((e) => e.kind === "instructions");
  assert.deepEqual(
    inline.map((e) => [e.label, e.scope, e.timestamp]),
    [["Run settings", "settings", stamp(4)]],
  );
});
test("Claude puts the recorded system prompt and tools in the prompt setup", () => {
  const attachment = (n, a, extra = {}) => ({
    type: "attachment",
    timestamp: stamp(n),
    attachment: a,
    ...extra,
  });
  const reminder = (n, type, text) =>
    attachment(
      n,
      { type },
      { rendered: [{ content: text }], renderedRole: "system" },
    );
  const systemPrompt = ["base <b>", "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"];
  const wire = { name: "Bash", description: "Run", input_schema: {} };
  const tools = [{ name: "Bash", description: "Run", schema: wire }];
  const result = sessionModel([
    {
      type: "user",
      uuid: "u",
      timestamp: stamp(0),
      message: { content: "hi" },
    },
    reminder(0, "date", "Today is 2026-10-10."),
    attachment(0, { type: "credential_org", organizationUuid: "x" }),
    attachment(0, { type: "prompt_snapshot", systemPrompt }),
    {
      type: "assistant",
      timestamp: stamp(1),
      message: {
        id: "m",
        model: "m1",
        content: [{ type: "text", text: "ok" }],
      },
    },
    attachment(1, {
      type: "prompt_snapshot",
      systemPrompt,
      cliPrefix: "You are Claude Code.",
      tools,
    }),
    reminder(2, "total_tokens_reminder", "<b>9 left</b>"),
    attachment(2, { type: "prompt_snapshot", systemPrompt, tools }),
  ]);
  const { instructions, tools: groups } = result.setup;
  assert.deepEqual(
    instructions.map((e) => [e.label, e.scope]),
    [
      ["System prompt", "system"],
      ["system · date", "system"],
    ],
  );
  assert.equal(instructions[0].timestamp, stamp(0));
  assert.deepEqual(instructions[0].blocks, [
    "You are Claude Code.",
    ...systemPrompt,
  ]);
  assert.deepEqual(
    groups.map((g) => [g.label, g.tools]),
    [
      [
        "Tools · 1",
        [{ name: "Bash", description: "Run", schema: { input_schema: {} } }],
      ],
    ],
  );
  // Later reminders stay inline, after the reply they followed.
  const order = result.entries.map((e) => e.label);
  assert.deepEqual(order, [
    "user",
    "assistant",
    "system · total tokens reminder",
  ]);
  assert.equal(result.entries[2].scope, "system");
  assert.match(result.entries[2].html, /&lt;b&gt;9 left&lt;\/b&gt;/);
});
test("Claude deduplicates streamed blocks and ignores tool-result turns", () => {
  const records = [
    {
      type: "user",
      uuid: "u",
      timestamp: stamp(0),
      message: { content: "hi" },
    },
    ...[1, 2].map((n) => ({
      type: "assistant",
      timestamp: stamp(n),
      message: {
        id: "m",
        model: "m1",
        content: [{ type: "text", text: "ok" }],
        usage: {
          input_tokens: 5,
          cache_read_input_tokens: 20,
          output_tokens: 2,
        },
      },
    })),
    {
      type: "user",
      timestamp: stamp(3),
      message: {
        content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
      },
    },
  ];
  const result = sessionModel(records);
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].usage.input, 5);
  assert.equal(result.turns[0].durationMs, null);
  assert.equal(result.turns[0].requests.length, 1);
});
test("Claude shows a send as posted only once its result confirms it", () => {
  const send = (id, text) => ({
    type: "tool_use",
    id,
    name: "mcp__buzz__send",
    input: { audience: "everyone", text },
  });
  const records = [
    { type: "user", timestamp: stamp(0), message: { content: "hi" } },
    {
      type: "assistant",
      timestamp: stamp(1),
      message: {
        id: "m",
        content: [
          send("ok", "posted"),
          send("bad", "rejected"),
          send("wait", "pending"),
        ],
      },
    },
    {
      type: "user",
      timestamp: stamp(2),
      message: {
        content: [
          { type: "tool_result", tool_use_id: "ok", content: "sent 1" },
          {
            type: "tool_result",
            tool_use_id: "bad",
            content: "No single channel member is @Nobody",
            is_error: true,
          },
        ],
      },
    },
  ];
  const entries = sessionModel(records).entries;
  assert.deepEqual(
    entries.filter((e) => e.kind === "sent").map((e) => e.preview),
    ["posted"],
  );
  const tools = entries.filter((e) => e.kind === "tool");
  assert.equal(tools.length, 2);
  assert.match(tools[0].html, /class="card tool error"/);
  assert.match(tools[0].html, /No single channel member is @Nobody/);
  assert.match(tools[1].html, /class="card tool pending"/);
});

test("captured costs are differenced within a launch and reset on restart", () => {
  const records = [0, 10, 20].map((n) => ({
    type: "user",
    uuid: String(n),
    timestamp: stamp(n),
    message: { content: "hi" },
  }));
  const trace = [
    { type: "context", timestamp: stamp(0), payload: { systemPrompt: "base" } },
    {
      type: "result",
      timestamp: stamp(5),
      payload: { total_cost_usd: 1, duration_ms: 5000 },
    },
    {
      type: "result",
      timestamp: stamp(15),
      payload: { total_cost_usd: 3, duration_ms: 5000 },
    },
    { type: "context", timestamp: stamp(20), payload: { systemPrompt: "new" } },
    {
      type: "result",
      timestamp: stamp(25),
      payload: { total_cost_usd: 0.5, duration_ms: 5000 },
    },
  ];
  assert.deepEqual(
    sessionModel(records, { trace }).turns.map((t) => t.cost),
    [1, 2, 0.5],
  );
});
test("live server follows appended records and rejects cross-origin reads", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "session-debug-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "session.jsonl");
  await writeFile(file, `${codex.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const { server, url } = await createInspector({ file, traceRoot: dir });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let response = await fetch(`${url}state`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).turns.length, 1);
  await appendFile(
    file,
    `${JSON.stringify(event(10, "task_started", { turn_id: "t2" }))}\n`,
  );
  response = await fetch(`${url}state`);
  assert.equal((await response.json()).turns.length, 2);
  assert.equal(
    (
      await fetch(`${url}state`, {
        headers: { Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(`${url}../../other`)).status, 404);
});

test("names each matching session's agent and opens the one picked", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "session-pick-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "codex"));
  await mkdir(join(dir, "claude"));
  const pubkey = "b".repeat(64);
  const named = {
    type: "response_item",
    timestamp: stamp(0),
    payload: {
      type: "message",
      role: "developer",
      content: [
        {
          type: "input_text",
          text: `You are codex00 (pubkey ${pubkey}), a coding agent in Buzz.`,
        },
      ],
    },
  };
  const codexFile = join(dir, "codex", "rollout.jsonl");
  await writeFile(
    codexFile,
    [codex[0], named, ...codex.slice(1)]
      .map((r) => JSON.stringify(r))
      .join("\n"),
  );
  // An unnamed Claude session in the same thread, the more recent of the two.
  const claudeFile = join(dir, "claude", "session.jsonl");
  await writeFile(
    claudeFile,
    JSON.stringify({
      type: "user",
      sessionId: "claude-session",
      timestamp: stamp(5),
      message: { role: "user", content: `Thread root: ${id}\nhi` },
    }),
  );
  await utimes(codexFile, 1000, 1000);
  await utimes(claudeFile, 2000, 2000);
  const { server, url } = await createInspector({
    target: id,
    roots: [join(dir, "codex"), join(dir, "claude")],
    traceRoot: dir,
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const latest = await (await fetch(`${url}state`)).json();
  assert.equal(latest.file, claudeFile);
  assert.equal(latest.agent, null);
  assert.deepEqual(
    latest.candidates.map((c) => [c.path, c.agent?.name ?? null, c.harness]),
    [
      [codexFile, "codex00", "Codex"],
      [claudeFile, null, "Claude"],
    ],
  );
  const picked = await (
    await fetch(`${url}state?session=${encodeURIComponent(codexFile)}`)
  ).json();
  assert.equal(picked.file, codexFile);
  assert.deepEqual(picked.agent, { name: "codex00", pubkey });
  // A path that does not match the thread falls back rather than being read.
  const other = await (
    await fetch(
      `${url}state?session=${encodeURIComponent(join(dir, "x.jsonl"))}`,
    )
  ).json();
  assert.equal(other.file, claudeFile);
});

test("reads the agent from a Claude prompt snapshot, the latest name winning", () => {
  const pubkey = "d".repeat(64);
  const snapshot = (name) => ({
    type: "attachment",
    attachment: {
      type: "prompt_snapshot",
      systemPrompt: [
        "Claude Code base",
        `<identity>\nYou are ${name} (pubkey ${pubkey}).\n</identity>\n\n<base>`,
      ],
    },
  });
  assert.deepEqual(agentOf([snapshot("Old"), snapshot("Pollen")]), {
    name: "Pollen",
    pubkey,
  });
  // Delivered user text that quotes an identity line is not the agent.
  assert.equal(agentOf([user(1, `You are Mallory (pubkey ${pubkey}).`)]), null);
});

test("historical response views never pair a tool with its later result", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "session-boundary-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "session.jsonl");
  const records = [
    ...codex.slice(0, 4),
    {
      type: "response_item",
      timestamp: stamp(1),
      payload: {
        type: "function_call",
        call_id: "call",
        name: "tool",
        arguments: "{}",
      },
    },
    codex[4],
    {
      type: "response_item",
      timestamp: stamp(3),
      payload: {
        type: "function_call_output",
        call_id: "call",
        output: "FUTURE_RESULT",
      },
    },
    codex[6],
  ];
  await writeFile(file, records.map((r) => JSON.stringify(r)).join("\n"));
  const { server, url } = await createInspector({ file, traceRoot: dir });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const snapshot = await (await fetch(`${url}state?through=r1`)).json();
  assert.equal(snapshot.snapshotAt, stamp(2));
  assert.equal(
    JSON.stringify(snapshot.entries).includes("FUTURE_RESULT"),
    false,
  );
  assert.equal(snapshot.turns.length, 1);
  const full = await (await fetch(`${url}state`)).json();
  assert.equal(JSON.stringify(full.entries).includes("FUTURE_RESULT"), true);
});

test("Claude background notifications remain inside their originating turn", () => {
  const records = [
    { type: "user", timestamp: stamp(0), message: { content: "hello" } },
    {
      type: "user",
      timestamp: stamp(1),
      message: { content: "<task-notification>done</task-notification>" },
    },
    {
      type: "user",
      timestamp: stamp(2),
      message: {
        content:
          "<new-message-arrived-while-you-were-working>also this</new-message-arrived-while-you-were-working>",
      },
    },
  ];
  assert.equal(sessionModel(records).turns.length, 1);
});
