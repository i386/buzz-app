import assert from "node:assert/strict";
import { test } from "node:test";
import {
  partitionTime,
  tokenBreakdown,
  wallTiming,
} from "../../scripts/session-timing.mjs";
import { sessionModel } from "../../scripts/session-model.mjs";
const codexModel = (records) => sessionModel(records, { provider: "codex" });
const stamp = (s) => new Date(1700000000000 + s * 1000).toISOString();
const event = (s, type, p = {}) => ({
  timestamp: stamp(s),
  type: "event_msg",
  payload: { type, ...p },
});
const item = (s, p) => ({
  timestamp: stamp(s),
  type: "response_item",
  payload: p,
});
const usage = (s, id) => ({
  timestamp: stamp(s),
  type: "token_usage_record",
  payload: {
    turn_id: "t",
    response_id: id,
    usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 },
  },
});
const records = [
  event(0, "task_started", { turn_id: "t" }),
  item(0.5, { type: "message", role: "user", content: [] }),
  item(2, {
    type: "function_call",
    call_id: "c",
    name: "read",
    arguments: "{}",
  }),
  usage(2.1, "r1"),
  item(5, { type: "function_call_output", call_id: "c", output: "ok" }),
  item(6, {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "done" }],
  }),
  usage(6.1, "r2"),
  event(7, "task_complete", { turn_id: "t", duration_ms: 7000 }),
];

test("wall time includes inferred inference, tool wait, and every uncovered gap", () => {
  const model = codexModel(records);
  assert.deepEqual(model.timing.totals, {
    inference: 2500,
    tool: 3000,
    unknown: 1500,
    idle: 0,
    overlap: 0,
  });
  assert.equal(
    Object.values(model.timing.totals).reduce((a, b) => a + b, 0),
    7000,
  );
  const inference = model.timing.runs[0].items.filter(
    (i) => i.kind === "inference",
  );
  assert.equal(inference.length, 2);
  assert.equal(inference[0].estimated, true);
  assert.deepEqual(inference[0].tokens, {
    fresh: 20,
    cached: 80,
    written: 0,
    output: 10,
    total: 110,
  });
});
test("parallel tools and overlapping inference never inflate the wall-time total", () => {
  const parts = partitionTime(0, 100, [
    { kind: "tool", start: 10, end: 70 },
    { kind: "tool", start: 30, end: 80 },
    { kind: "inference", start: 60, end: 90 },
  ]);
  assert.deepEqual(parts, [
    { kind: "unknown", start: 0, end: 10 },
    { kind: "tool", start: 10, end: 60 },
    { kind: "overlap", start: 60, end: 80 },
    { kind: "inference", start: 80, end: 90 },
    { kind: "unknown", start: 90, end: 100 },
  ]);
  assert.equal(
    parts.reduce((n, s) => n + s.end - s.start, 0),
    100,
  );
});
test("idle waits between runs stay in the session denominator", () => {
  const model = codexModel([
    ...records,
    event(12, "task_started", { turn_id: "t2" }),
    event(14, "task_complete", { turn_id: "t2" }),
  ]);
  assert.equal(model.timing.totals.idle, 5000);
  assert.equal(
    Object.values(model.timing.totals).reduce((a, b) => a + b, 0),
    14000,
  );
});
test("missing model output timing stays unknown instead of inventing a duration", () => {
  const model = codexModel([
    event(0, "task_started", { turn_id: "t" }),
    usage(4, "r1"),
    event(5, "task_complete", { turn_id: "t" }),
  ]);
  assert.equal(model.timing.totals.inference, 0);
  assert.equal(model.timing.totals.unknown, 5000);
  assert.equal(
    model.timing.runs[0].items.find((i) => i.kind === "inference").estimated,
    false,
  );
});
test("Claude blocks count one inference with tools paired across user results", () => {
  const model = sessionModel([
    { type: "user", timestamp: stamp(0), message: { content: "hi" } },
    {
      type: "assistant",
      timestamp: stamp(1),
      message: {
        id: "m",
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 20,
          output_tokens: 3,
        },
        content: [{ type: "text", text: "hello" }],
      },
    },
    {
      type: "assistant",
      timestamp: stamp(2),
      message: {
        id: "m",
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 20,
          output_tokens: 3,
        },
        content: [{ type: "tool_use", id: "c", name: "read", input: {} }],
      },
    },
    {
      type: "user",
      timestamp: stamp(5),
      message: {
        content: [{ type: "tool_result", tool_use_id: "c", content: "ok" }],
      },
    },
  ]);
  const run = model.timing.runs[0];
  assert.equal(run.items.filter((i) => i.kind === "inference").length, 1);
  assert.equal(run.end - run.start, 5000);
  assert.deepEqual(run.items[0].tokens, {
    fresh: 2,
    cached: 80,
    written: 20,
    output: 3,
    total: 105,
  });
});
test("only explicit running turns extend to now", () => {
  const model = codexModel(records.slice(0, -1));
  const timing = wallTiming(
    records.slice(0, -1),
    model.turns,
    "codex",
    Date.parse(stamp(10)),
  );
  assert.equal(timing.end - timing.start, 10000);
  assert.equal(
    tokenBreakdown({ input: 10, cached: 8, written: 1, output: 2 }, "codex")
      .fresh,
    1,
  );
});
test("Claude resume bookkeeping after a finished run counts as idle, not inference", () => {
  const assistant = (s, id, content, model = "claude-opus") => ({
    type: "assistant",
    timestamp: stamp(s),
    message: {
      id,
      model,
      usage: { input_tokens: 1, output_tokens: 1 },
      content,
    },
  });
  const model = sessionModel([
    { type: "user", timestamp: stamp(0), message: { content: "hi" } },
    assistant(2, "m1", [
      { type: "tool_use", id: "c", name: "send", input: {} },
    ]),
    {
      type: "user",
      timestamp: stamp(3),
      message: {
        content: [{ type: "tool_result", tool_use_id: "c", content: "sent" }],
      },
    },
    { type: "attachment", timestamp: stamp(3) },
    { type: "queue-operation", timestamp: stamp(1500) },
    assistant(
      1500,
      "synthetic-id",
      [{ type: "text", text: "No response requested." }],
      "<synthetic>",
    ),
    { type: "user", timestamp: stamp(1501), message: { content: "next" } },
    assistant(1504, "m2", [{ type: "text", text: "ok" }]),
  ]);
  const { totals, runs } = model.timing;
  assert.equal(runs.length, 2);
  assert.equal(runs[0].end - runs[0].start, 3000);
  assert.equal(totals.idle, 1498000);
  assert.equal(totals.inference, 5000);
  assert.equal(
    model.turns.flatMap((t) => t.requests).some((r) => r.id === "synthetic-id"),
    false,
  );
});
