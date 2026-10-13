// Wall-clock accounting for the diagnostic viewer. Model request starts are not
// in the native transcripts: inference windows are explicitly elapsed estimates,
// bounded by the preceding input/result and observed model output. Tool windows
// use call/result timestamps. Partition their union, never sum overlapping work.
const time = (value) => {
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
};

export function tokenBreakdown(usage, provider) {
  const { input = 0, output = 0, cached = 0, written = 0 } = usage ?? {};
  const fresh =
    provider === "codex" ? Math.max(0, input - cached - written) : input;
  return {
    fresh,
    cached,
    written,
    output,
    total: fresh + cached + written + output,
  };
}

export function partitionTime(start, end, intervals) {
  const clipped = intervals
    .map((i) => ({
      ...i,
      start: Math.max(start, i.start),
      end: Math.min(end, i.end),
    }))
    .filter((i) => i.end > i.start);
  const edges = [
    ...new Set([start, end, ...clipped.flatMap((i) => [i.start, i.end])]),
  ].sort((a, b) => a - b);
  const segments = [];
  for (let i = 1; i < edges.length; i++) {
    const a = edges[i - 1],
      b = edges[i];
    if (b <= a) continue;
    const kinds = new Set(
      clipped.filter((s) => s.start < b && s.end > a).map((s) => s.kind),
    );
    const kind = kinds.size > 1 ? "overlap" : ([...kinds][0] ?? "unknown");
    const last = segments.at(-1);
    if (last?.kind === kind && last.end === a) last.end = b;
    else segments.push({ kind, start: a, end: b });
  }
  return segments;
}

function toolLabel(p) {
  if (p.name !== "exec") return p.name ?? p.type;
  const nested = [
    ...new Set(
      [...String(p.input ?? p.arguments ?? "").matchAll(/tools\.([\w]+)/g)].map(
        (m) => m[1].replace(/^buzz__/, ""),
      ),
    ),
  ];
  return nested.length
    ? `${nested.slice(0, 2).join(" + ")}${nested.length > 2 ? ` +${nested.length - 2}` : ""}`
    : "exec";
}

function isActivity(r, provider) {
  if (provider === "codex")
    return r.type === "response_item" || r.type === "event_msg";
  return (
    r.type === "user" ||
    (r.type === "assistant" && r.message?.model !== "<synthetic>")
  );
}

export function wallTiming(records, turns, provider, now = Date.now()) {
  const result = [];
  const allRequests = new Map(
    turns.flatMap((t) => t.requests.map((r) => [r.id, r])),
  );
  const inference = new Map();
  const calls = new Map();
  let ready = null,
    pending = null;
  const codexUsage = records.some((r) => r.type === "token_usage_record");
  for (const [index, r] of records.entries()) {
    const at = time(r.timestamp);
    if (at === null) continue;
    const p = r.payload ?? {};
    if (provider === "codex") {
      if (r.type === "event_msg" && p.type === "task_started") {
        ready = at;
        pending = null;
      }
      if (r.type === "response_item") {
        if (p.type?.endsWith("_output")) {
          const call = calls.get(p.call_id);
          if (call) call.end = Math.max(call.start, at);
          ready = at;
        } else if (p.role === "user") ready = at;
        else if (
          p.type === "reasoning" ||
          p.role === "assistant" ||
          p.call_id
        ) {
          pending ??= { start: ready ?? at, end: at, known: ready !== null };
          pending.end = Math.max(pending.end, at);
          if (p.call_id)
            calls.set(p.call_id, {
              id: p.call_id,
              kind: "tool",
              name: toolLabel(p),
              start: at,
              end: null,
            });
        }
      }
      const id =
        r.type === "token_usage_record"
          ? (p.response_id ?? `usage-${index}`)
          : !codexUsage && r.type === "event_msg" && p.type === "token_count"
            ? `usage-${index}`
            : null;
      if (id && allRequests.has(id)) {
        inference.set(id, {
          id,
          kind: "inference",
          start: pending?.start ?? at,
          end: pending?.end ?? at,
          estimated: !!pending?.known,
        });
        pending = null;
        ready = Math.max(ready ?? at, at);
      }
    } else {
      const blocks = Array.isArray(r.message?.content) ? r.message.content : [];
      if (r.type === "user") {
        ready = at;
        for (const b of blocks)
          if (b.type === "tool_result") {
            const call = calls.get(b.tool_use_id);
            if (call) call.end = Math.max(call.start, at);
          }
      }
      if (r.type === "assistant" && r.message?.model !== "<synthetic>") {
        const id = r.message.id ?? r.requestId ?? `usage-${index}`;
        const span = inference.get(id) ?? {
          id,
          kind: "inference",
          start: ready ?? at,
          end: at,
          estimated: ready !== null,
        };
        span.end = Math.max(span.end, at);
        inference.set(id, span);
        ready = at;
        for (const b of blocks)
          if (b.type === "tool_use" && !calls.has(b.id))
            calls.set(b.id, {
              id: b.id,
              kind: "tool",
              name: b.name,
              start: at,
              end: null,
            });
      }
    }
  }
  for (const [index, t] of turns.entries()) {
    const start = time(t.start);
    if (start === null) continue;
    const next = time(turns[index + 1]?.start) ?? Infinity;
    // Only conversation activity marks a run as busy. Bookkeeping written when
    // the next prompt is queued (queue-operation, attachment, synthetic replies)
    // would otherwise stretch an idle wait into the previous run.
    const lastObserved = records.reduce((last, r) => {
      const at = time(r.timestamp);
      return at !== null && at >= start && at < next && isActivity(r, provider)
        ? Math.max(last, at)
        : last;
    }, start);
    // A missing completion is not proof the provider is still running. Only an
    // explicit active lifecycle extends to now; older Claude logs stop at data.
    const end = Math.max(
      start,
      t.status === "running"
        ? Math.min(next, Math.max(lastObserved, now))
        : !t.inferred && time(t.end) !== null
          ? Math.min(next, time(t.end))
          : lastObserved,
    );
    const items = [];
    for (const r of t.requests) {
      const span = inference.get(r.id) ?? {
        id: r.id,
        kind: "inference",
        start: time(r.timestamp) ?? start,
        end: time(r.timestamp) ?? start,
        estimated: false,
      };
      items.push({
        ...span,
        start: Math.min(end, Math.max(start, span.start)),
        end: Math.min(end, Math.max(start, span.start, span.end)),
        tokens: tokenBreakdown(r.usage, provider),
        estimate: r.estimate,
        model: r.model,
      });
    }
    for (const c of calls.values())
      if (c.start >= start && c.start < Math.min(next, end + 1)) {
        items.push({
          ...c,
          end: Math.min(end, c.end ?? end),
          open: c.end === null,
        });
      }
    const segments = partitionTime(start, end, items);
    for (const [i, s] of segments.entries())
      if (s.kind === "unknown")
        items.push({
          ...s,
          id: `gap-${i}`,
          name: "Unattributed",
          estimated: false,
        });
    items.sort((a, b) => a.start - b.start || a.end - b.end);
    result.push({
      id: t.id,
      start,
      end,
      observedOnly: t.inferred,
      ongoing: t.status === "running",
      segments,
      items,
      recordedDurationMs: t.durationMs,
    });
  }
  const start = result[0]?.start ?? null;
  const end = result.at(-1)?.end ?? null;
  const idle = result
    .slice(1)
    .map((r, i) => ({ kind: "idle", start: result[i].end, end: r.start }))
    .filter((s) => s.end > s.start);
  const segments =
    start === null
      ? []
      : partitionTime(start, end, [
          ...result.flatMap((r) => r.segments),
          ...idle,
        ]);
  // No active run in this period: the agent was idle, waiting for a prompt. It
  // is neither a slow model nor a tool, and stays separate from unattributed
  // gaps inside a run.
  for (const s of segments)
    if (
      s.kind === "unknown" &&
      !result.some((r) => r.start < s.end && r.end > s.start)
    )
      s.kind = "idle";
  const totals = { inference: 0, tool: 0, overlap: 0, unknown: 0, idle: 0 };
  for (const s of segments) totals[s.kind] += s.end - s.start;
  return { start, end, segments, totals, runs: result };
}
