// Provider transcripts remain the source of truth. No replay or model requests.
import { buildCodex } from "./export-codex-session.mjs";
import { buildClaude } from "./export-claude-session.mjs";
import { entry } from "./session-viewer.mjs";
import { wallTiming } from "./session-timing.mjs";

export function parseLines(source, live = false) {
  const lines = source.split("\n");
  return lines.flatMap((line, i) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      if (live && i === lines.length - 1) return [];
      throw new Error(`Invalid JSON on line ${i + 1}`);
    }
  });
}

const ms = (stamp) =>
  Number.isFinite(Date.parse(stamp)) ? Date.parse(stamp) : null;
const amount = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const usage = (u = {}) => ({
  input: amount(u.input_tokens),
  output: amount(u.output_tokens),
  cached: amount(u.cached_input_tokens ?? u.cache_read_input_tokens),
  written: amount(u.cache_write_input_tokens ?? u.cache_creation_input_tokens),
});
function total(requests) {
  const out = { input: 0, output: 0, cached: 0, written: 0 };
  for (const r of requests)
    for (const k of Object.keys(out)) out[k] += r.usage[k];
  return out;
}
// Never expose encrypted reasoning blobs as though they were readable context.
function publicRecord(value) {
  if (Array.isArray(value)) return value.map(publicRecord);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["encrypted_content", "signature"].includes(key))
        .map(([key, v]) => [key, publicRecord(v)]),
    );
  return value;
}

export function sessionModel(
  records,
  { provider, file, trace = [], rates = {} } = {},
) {
  provider ??= records.some((r) => r.type === "session_meta")
    ? "codex"
    : "claude";
  const base =
    provider === "codex" ? buildCodex(records) : buildClaude(records);
  const meta = records.find((r) => r.type === "session_meta")?.payload ?? {};
  const turns = [];
  let active;
  let model = "",
    effort = null;
  const start = (id, timestamp, inferred = false) => {
    if (active && !active.end) {
      active.end = timestamp;
      active.status = "boundary inferred";
    }
    active = {
      id,
      start: timestamp,
      end: null,
      status: inferred ? "completion not recorded" : "running",
      inferred,
      model,
      requests: [],
      cost: null,
    };
    turns.push(active);
    return active;
  };
  const requests = new Map();
  let previousTotals;
  const hasUsageRecords = records.some((r) => r.type === "token_usage_record");
  const hasLifecycle = records.some((r) => r.payload?.type === "task_started");
  for (const [index, r] of records.entries()) {
    const p = r.payload ?? {};
    if (r.type === "turn_context") {
      model = p.model ?? model;
      effort =
        p.effort ?? p.collaboration_mode?.settings?.reasoning_effort ?? effort;
      if (active) active.model = model;
    }
    if (provider === "codex") {
      if (r.type === "event_msg" && p.type === "task_started")
        start(p.turn_id ?? `turn-${index}`, r.timestamp);
      if (
        !hasLifecycle &&
        r.type === "response_item" &&
        p.role === "user" &&
        /Request:/.test(JSON.stringify(p.content))
      )
        start(`turn-${index}`, r.timestamp, true);
      if (
        r.type === "event_msg" &&
        ["task_complete", "turn_aborted"].includes(p.type) &&
        active
      ) {
        const t = turns.find((t) => t.id === p.turn_id) ?? active;
        t.end = r.timestamp;
        t.durationMs = p.duration_ms;
        t.status = p.type === "turn_aborted" ? "interrupted" : "complete";
      }
      if (r.type === "token_usage_record" && active) {
        const t = turns.find((t) => t.id === p.turn_id) ?? active;
        requests.set(p.response_id ?? `usage-${index}`, {
          id: p.response_id ?? `usage-${index}`,
          turnId: t.id,
          timestamp: r.timestamp,
          model: t.model,
          usage: usage(p.usage),
          raw: publicRecord(p),
        });
      }
      if (
        r.type === "event_msg" &&
        p.type === "token_count" &&
        p.info?.total_token_usage
      ) {
        const u = usage(p.info.total_token_usage);
        if (
          !hasUsageRecords &&
          active &&
          (!previousTotals ||
            Object.keys(u).some((k) => u[k] !== previousTotals[k]))
        ) {
          const delta = Object.fromEntries(
            Object.keys(u).map((k) => [
              k,
              Math.max(0, u[k] - (previousTotals?.[k] ?? 0)),
            ]),
          );
          requests.set(`usage-${index}`, {
            id: `usage-${index}`,
            turnId: active.id,
            timestamp: r.timestamp,
            model,
            usage: delta,
            inferred: true,
          });
        }
        previousTotals = u;
      }
    } else {
      const content = r.message?.content;
      const blocks = Array.isArray(content)
        ? content
        : [{ type: "text", text: content }];
      const body = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n");
      if (
        r.type === "user" &&
        !r.isMeta &&
        !/^<(task-notification|system-reminder|local-command|command-name)/.test(
          body.trim(),
        ) &&
        body &&
        !blocks.some((b) => b.type === "tool_result")
      ) {
        // Steering remains in the current burst of work, not a fabricated new completion.
        if (!/new-message-arrived-while-you-were-working/.test(body) || !active)
          start(r.uuid ?? `turn-${index}`, r.timestamp, true);
      }
      // Claude writes zero-usage "<synthetic>" replies (for example "No
      // response requested.") when it resumes; no model request happened.
      if (
        r.type === "assistant" &&
        active &&
        r.message?.model !== "<synthetic>"
      ) {
        model = r.message.model ?? model;
        active.model = model;
        if (r.message.usage) {
          const id = r.message.id ?? r.requestId ?? `usage-${index}`;
          // Claude writes multiple content blocks with the same message ID and usage.
          requests.set(id, {
            id,
            turnId: active.id,
            timestamp: r.timestamp,
            model,
            usage: usage(r.message.usage),
            raw: publicRecord(r.message.usage),
          });
        }
      }
      if (r.type === "system" && r.subtype === "turn_duration" && active) {
        active.durationMs = r.durationMs;
        active.end = r.timestamp;
        active.status = "complete";
      }
    }
  }
  const context = [];
  if (provider === "codex") {
    if (meta.base_instructions)
      context.push(
        entry.instructions(
          meta.timestamp,
          "Base instructions",
          typeof meta.base_instructions === "string"
            ? meta.base_instructions
            : (meta.base_instructions.text ??
                JSON.stringify(meta.base_instructions)),
          // Codex 0.156 sends these as the first developer message, with no
          // top-level `instructions`.
          { scope: "developer" },
        ),
      );
    // Namespaced tools are flattened to `namespace.name`.
    const tools = (meta.dynamic_tools ?? [])
      .flatMap((t) =>
        t.type === "namespace"
          ? (t.tools ?? []).map((x) => ({ ...x, name: `${t.name}.${x.name}` }))
          : [t],
      )
      .map((t) => ({
        name: t.name,
        description: t.description,
        schema: t.inputSchema ?? t.parameters,
      }));
    if (tools.length)
      context.push(
        entry.tools(
          meta.timestamp,
          `Dynamic tools · ${tools.length} (native tools not recorded)`,
          tools,
          {
            note: "Codex does not record its native tools, such as shell and apply_patch.",
          },
        ),
      );
  }
  let previousCost = 0;
  for (const r of trace) {
    if (r.type === "context") previousCost = 0;
    if (r.type === "context")
      context.push(
        entry.instructions(
          r.timestamp,
          "Recorded Buzz system prompt additions",
          r.payload.systemPrompt,
        ),
      );
    if (r.type === "tools")
      context.push(
        entry.instructions(
          r.timestamp,
          "Recorded Buzz tool definitions",
          JSON.stringify(r.payload, null, 2),
        ),
      );
    if (r.type === "result") {
      const t = [...turns]
        .reverse()
        .find((t) => ms(t.start) <= ms(r.timestamp));
      if (t) {
        t.end = r.timestamp;
        t.durationMs = r.payload.duration_ms;
        t.inferred = false;
        const cumulative = r.payload.total_cost_usd;
        if (typeof cumulative === "number" && cumulative >= previousCost) {
          t.cost = (t.cost ?? 0) + cumulative - previousCost;
          previousCost = cumulative;
        }
        t.costLabel = "reported total difference";
        t.status = r.payload.is_error ? "error" : "complete";
      }
    }
  }
  for (const t of turns) {
    t.requests = [...requests.values()].filter((r) => r.turnId === t.id);
    t.usage = total(t.requests);
    t.durationMs ??=
      t.end && ms(t.start) !== null
        ? Math.max(0, ms(t.end) - ms(t.start))
        : null;
    const estimate = t.requests.map((r) => {
      r.estimate = null;
      const rate = rates[r.model];
      if (!rate) return null;
      const u = r.usage;
      const input =
        provider === "codex"
          ? Math.max(0, u.input - u.cached - u.written)
          : u.input;
      if (
        ![rate.input, rate.output, rate.cached, rate.written].every(
          (x) => typeof x === "number" && Number.isFinite(x) && x >= 0,
        )
      )
        return null;
      r.estimate =
        (input * rate.input +
          u.output * rate.output +
          u.cached * rate.cached +
          u.written * rate.written) /
        1e6;
      return r.estimate;
    });
    t.estimate =
      estimate.length && estimate.every((v) => v !== null)
        ? estimate.reduce((a, b) => a + b, 0)
        : null;
  }
  const identifiers = new Map();
  // Model switches are summarized in the header instead.
  const all = [
    ...context,
    ...base.entries.filter((e) => e.kind !== "model"),
  ].map((e) => {
    const key = `${e.timestamp ?? "meta"}-${e.kind}-${e.label}`;
    const occurrence = identifiers.get(key) ?? 0;
    identifiers.set(key, occurrence + 1);
    return {
      ...e,
      id: `${key}-${occurrence}`,
      turnId:
        [...turns].reverse().find((t) => ms(t.start) <= ms(e.timestamp))?.id ??
        null,
    };
  });
  // Context sent before the first response is the prompt setup, shown apart
  // from the conversation; later context stays inline.
  const first = all.findIndex((e) =>
    ["assistant", "tool", "sent"].includes(e.kind),
  );
  const setup = all
    .slice(0, first < 0 ? all.length : first)
    .filter((e) => e.kind === "instructions");
  return {
    ...base,
    provider,
    file,
    sessionId: meta.id ?? records.find((r) => r.sessionId)?.sessionId,
    header: {
      harness: provider === "codex" ? "Codex" : "Claude",
      model:
        turns
          .flatMap((t) => t.requests)
          .reverse()
          .find((r) => r.model && r.model !== "<synthetic>")?.model ?? model,
      effort,
    },
    entries: all.filter((e) => !setup.includes(e)),
    setup: {
      // The system prompt leads, as the request's `system` field does.
      instructions: setup
        .filter((e) => !e.tools)
        .sort((a, b) => Number(!!b.blocks) - Number(!!a.blocks))
        .map(({ id, timestamp, label, scope, preview, blocks }) => ({
          id,
          timestamp,
          label,
          scope: scope ?? null,
          body: preview,
          blocks: blocks ?? null,
        })),
      tools: setup
        .filter((e) => e.tools)
        .map(({ id, label, note, tools }) => ({
          id,
          label,
          note: note ?? null,
          tools,
        })),
    },
    turns,
    timing: wallTiming(records, turns, provider),
    limitations:
      provider === "codex"
        ? "Recorded base instructions, dynamic tools, run settings, messages and usage. Native tool schemas and exact post-compaction inference requests are not recorded. Encrypted reasoning is omitted."
        : "Recorded system prompt and tool snapshots (when Claude writes them), injected context as rendered, messages and per-response usage. Request framing, such as billing and SDK system blocks, beta headers and deferred tool schemas, is not recorded. Without completion records, duration is unknown or an inferred boundary.",
  };
}
