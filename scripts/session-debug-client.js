const $ = (id) => document.getElementById(id);
const htmlEscape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const number = (n) => Number(n ?? 0).toLocaleString();
const money = (n) => `$${n.toFixed(4)}`;
let state,
  signature = "",
  pending = false,
  // The session on screen stays put once shown, even when another agent in
  // the thread becomes the latest; the picker changes it.
  pinned = null;
const duration = (ms) => {
  const s = Math.max(0, ms) / 1000;
  if (s < 1) return `${Math.round(s * 1000)}ms`;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)}s`;
  return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
};
const compact = (n) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`
      : String(n);
// Dense duration for the summary line: 0.3s · 47s · 2m43 · 25m · 1h12.
const brief = (ms) => {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 600)
    return `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, "0")}`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
};
const clock = (ms) => new Date(ms).toISOString().slice(11, 19);
const kindNames = {
  inference: "Inference",
  tool: "Tools",
  overlap: "Inference + tool",
  unknown: "Unattributed",
  idle: "Idle",
};
const kindNotes = {
  unknown: "Run active, but no model or tool activity recorded",
  idle: "No run active; waiting for the next prompt",
};
// One vertical time axis for the whole session. Active time is proportional;
// idle waits between runs collapse to a fixed-height break so a 25-minute pause
// can't flatten seconds of work. Each painted segment remembers which
// inference/tool items were active in it, for the hover readout.
const IDLE_HEIGHT = 30;
const PAD = 14;
const MIN_SCALE = 0.00225;
let chart = { segments: [], marks: [] },
  chartHtml = "";
function runSegments(run) {
  const items = run.items.filter(
    (i) => (i.kind === "inference" || i.kind === "tool") && i.end > i.start,
  );
  const edges = [
    ...new Set([run.start, run.end, ...items.flatMap((i) => [i.start, i.end])]),
  ]
    .filter((t) => t >= run.start && t <= run.end)
    .sort((a, b) => a - b);
  const out = [];
  for (let k = 1; k < edges.length; k++) {
    const a = edges[k - 1],
      b = edges[k];
    const active = items.filter((i) => i.start < b && i.end > a);
    const inference = active.some((i) => i.kind === "inference");
    const tool = active.some((i) => i.kind === "tool");
    const kind =
      inference && tool
        ? "overlap"
        : inference
          ? "inference"
          : tool
            ? "tool"
            : "unknown";
    const key = active.map((i) => i.id).join("|");
    const last = out.at(-1);
    if (last && last.key === key && last.end === a) last.end = b;
    else out.push({ kind, key, start: a, end: b, items: active, run });
  }
  return out;
}
// Min-height segments inflate the layout, so refit once with the overflow removed.
function layoutChart(timing, height) {
  const first = layoutAt(timing, height, null);
  if (first.height <= height || first.scale <= MIN_SCALE) return first;
  return layoutAt(
    timing,
    height,
    first.scale *
      (1 - (first.height - height) / Math.max(1, first.height - first.fixed)),
  );
}
function layoutAt(timing, height, fitted) {
  const perRun = timing.runs.map((run) => ({ run, segs: runSegments(run) }));
  const activeMs = timing.runs.reduce((n, r) => n + (r.end - r.start), 0);
  const breaks = timing.runs.filter(
    (r, i) => i && r.start > timing.runs[i - 1].end,
  ).length;
  const fixed = PAD * 2 + breaks * IDLE_HEIGHT;
  // px per ms: fit the active time to the rail, within readable bounds.
  const scale = Math.max(
    MIN_SCALE,
    fitted ??
      Math.min(0.06, Math.max(240, height - fixed) / Math.max(1, activeMs)),
  );
  const segments = [],
    marks = [],
    runs = [];
  let y = PAD;
  for (const [index, { run, segs }] of perRun.entries()) {
    const previous = timing.runs[index - 1];
    if (previous && run.start > previous.end) {
      segments.push({
        kind: "idle",
        start: previous.end,
        end: run.start,
        items: [],
        run,
        y,
        h: IDLE_HEIGHT,
      });
      y += IDLE_HEIGHT;
    }
    const top = y;
    for (const s of segs) {
      s.y = y;
      s.h = Math.max(3, (s.end - s.start) * scale);
      segments.push(s);
      y += s.h;
    }
    if (segs.length) {
      segs[0].cap = "cap-top";
      segs.at(-1).cap = `${segs.length === 1 ? "cap-top " : ""}cap-bottom`;
    }
    runs.push({ run, y: top, h: y - top });
    for (const item of run.items)
      if (item.kind === "inference") {
        const at =
          segs.find((s) => item.start >= s.start && item.start < s.end) ??
          segs.at(-1);
        marks.push({
          item,
          run,
          y: at
            ? at.y +
              ((item.start - at.start) / Math.max(1, at.end - at.start)) * at.h
            : top,
        });
      }
  }
  return { segments, marks, runs, height: y + PAD, scale, fixed };
}
const context = (t) => t.fresh + t.cached + t.written;
function renderSummary(timing) {
  const tokens = { fresh: 0, cached: 0, written: 0, output: 0 };
  let inferences = 0,
    peak = 0;
  for (const run of timing.runs)
    for (const i of run.items)
      if (i.kind === "inference") {
        inferences++;
        peak = Math.max(peak, context(i.tokens));
        for (const k of Object.keys(tokens)) tokens[k] += i.tokens[k];
      }
  const costs = state.turns.map((t) => t.cost ?? t.estimate);
  const cost = costs.some((c) => c != null)
    ? costs.reduce((a, c) => a + (c ?? 0), 0)
    : null;
  const input = context(tokens);
  // Sub-second overlap stays in the tooltip; it would only crowd the line.
  const parts = ["inference", "tool", "overlap", "unknown", "idle"]
    .filter(
      (k) =>
        timing.totals[k] >= (k === "overlap" ? 1000 : 1) ||
        k === "inference" ||
        k === "tool",
    )
    .map(
      (k) =>
        `<span title="${kindNames[k]}${k === "inference" ? " (estimated from record timestamps)" : ""}: ${duration(timing.totals[k])}"><i class="key key-${k}"></i>${brief(timing.totals[k])}</span>`,
    )
    .join("");
  const tokenTitle = `${number(tokens.fresh)} new input · ${number(tokens.cached)} cache read · ${number(tokens.written)} cache write · ${number(tokens.output)} output · ${inferences} model calls · peak context ${number(peak)}`;
  return `<div class="rail-total"><strong title="Wall time ${duration(timing.end - timing.start)} across ${timing.runs.length} run${timing.runs.length === 1 ? "" : "s"}">${brief(timing.end - timing.start)}</strong>${parts}</div><div class="rail-tokens" title="${tokenTitle}"><strong>${compact(input + tokens.output)}</strong> tokens · ${input ? Math.round((tokens.cached / input) * 100) : 0}% cached${cost == null ? "" : ` · ${money(cost)}`}</div>`;
}
function renderTiming(timing, force = false) {
  if (!timing?.runs.length) {
    $("summary").textContent = "Waiting for timing records…";
    $("timeline").replaceChildren();
    chartHtml = "";
    return;
  }
  const summary = renderSummary(timing);
  if ($("summary").innerHTML !== summary) $("summary").innerHTML = summary;
  const scroller = document.querySelector(".timeline-scroll");
  const scroll = scroller.scrollTop;
  const atEnd = scroll + scroller.clientHeight >= scroller.scrollHeight - 40;
  // Lay out 1.5× the visible height: taller segments are easier to hover, at
  // the cost of some scrolling.
  chart = layoutChart(timing, scroller.clientHeight * 1.5);
  // Marks show each call's new (uncached) tokens; the full window is on hover.
  const fresh = (t) => t.fresh + t.written;
  const maxFresh = Math.max(1, ...chart.marks.map((m) => fresh(m.item.tokens)));
  const last = chart.segments.at(-1);
  const html = `<div class="chart" style="height:${chart.height}px">${chart.runs
    .map(
      (r) =>
        `<span class="run-label" style="top:${r.y}px" title="Run started ${clock(r.run.start)} UTC · ${duration(r.run.end - r.run.start)}">${clock(r.run.start).slice(0, 5)}</span><span class="run-track${r.run.ongoing ? " live" : ""}" style="top:${r.y}px;height:${r.h}px"></span>`,
    )
    .join("")}${chart.segments
    .map((s, i) =>
      s.kind === "idle"
        ? `<button type="button" class="idle-break" data-seg="${i}" style="top:${s.y}px;height:${s.h}px" aria-label="Idle ${duration(s.end - s.start)}"><span>${brief(s.end - s.start)} idle</span></button>`
        : `<button type="button" class="seg key-${s.kind}${s.cap ? ` ${s.cap}` : ""}${s.run.ongoing && s === last ? " live" : ""}" data-seg="${i}" style="top:${s.y}px;height:${s.h}px" aria-label="${htmlEscape(`${kindNames[s.kind]} ${duration(s.end - s.start)}${s.items.length ? `: ${s.items.map((it) => it.name ?? "inference").join(", ")}` : ""}`)}"></button>`,
    )
    .join("")}${chart.marks
    .map(
      (m, i) =>
        `<button type="button" class="tok" data-mark="${i}" style="top:${m.y}px;--share:${(fresh(m.item.tokens) / maxFresh).toFixed(4)}" aria-label="${compact(fresh(m.item.tokens))} new tokens"><i></i></button>`,
    )
    .join("")}<div class="viewport" hidden></div></div>`;
  if (force || chartHtml !== html) {
    $("timeline").innerHTML = html;
    chartHtml = html;
  }
  if (atEnd) scroller.scrollTop = scroller.scrollHeight;
  else scroller.scrollTop = scroll;
}
function tipRow(color, value, label, detail) {
  const row = document.createElement("div");
  row.className = "tip-row";
  const key = document.createElement("i");
  key.className = `key key-${color}`;
  const strong = document.createElement("strong");
  strong.textContent = value;
  const name = document.createElement("span");
  name.textContent = label;
  row.append(key, strong, name);
  if (detail) {
    const small = document.createElement("small");
    small.textContent = detail;
    row.append(small);
  }
  return row;
}
function inferenceRow(item) {
  return tipRow(
    "inference",
    item.estimated ? duration(item.end - item.start) : "untimed",
    "Inference",
  );
}
// Token mark readout: the whole context window as one bar (cached prefix,
// then this call's new tokens), with new/out counts beneath.
function contextReadout(item) {
  const t = item.tokens;
  const size = context(t);
  const added = t.fresh + t.written;
  const bar = document.createElement("div");
  bar.className = "ctx-bar";
  const cached = document.createElement("i");
  cached.className = "ctx-cached";
  cached.style.width = `${size ? (t.cached / size) * 100 : 0}%`;
  const fresh = document.createElement("i");
  fresh.className = "ctx-new";
  fresh.style.width = `${size ? (added / size) * 100 : 0}%`;
  bar.append(cached, fresh);
  const stats = document.createElement("div");
  stats.className = "ctx-stats";
  const stat = (value, label, className) => {
    const span = document.createElement("span");
    if (className) span.className = className;
    const strong = document.createElement("strong");
    strong.textContent = value;
    span.append(strong, ` ${label}`);
    return span;
  };
  stats.append(
    stat(`+${compact(added)}`, "new"),
    stat(compact(t.output), "out"),
  );
  if (item.estimate != null) stats.append(stat(money(item.estimate), ""));
  const total = document.createElement("span");
  total.className = "ctx-total";
  total.textContent = compact(size);
  total.title = `${number(t.cached)} cached · ${number(t.fresh)} input · ${number(t.written)} cache write`;
  stats.append(total);
  return [bar, stats];
}
function showTip(target, x, y) {
  const tip = $("tip");
  const seg = chart.segments[target.dataset.seg];
  const mark = chart.marks[target.dataset.mark];
  if (!seg && !mark) return hideTip();
  if (mark) tip.replaceChildren(...contextReadout(mark.item));
  else {
    const head = document.createElement("div");
    head.className = "tip-head";
    head.textContent =
      seg.kind === "idle"
        ? `${clock(seg.start)} – ${clock(seg.end)}`
        : clock(seg.start);
    const rows = seg.items.length
      ? seg.items.map((item) =>
          item.kind === "inference"
            ? inferenceRow(item)
            : tipRow(
                "tool",
                item.open ? "running" : duration(item.end - item.start),
                item.name ?? "tool",
              ),
        )
      : [
          tipRow(
            seg.kind,
            duration(seg.end - seg.start),
            kindNames[seg.kind],
            kindNotes[seg.kind],
          ),
        ];
    tip.replaceChildren(head, ...rows);
  }
  tip.classList.toggle("compact", !!mark);
  tip.hidden = false;
  const box = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(innerWidth - box.width - 8, x + 16)}px`;
  tip.style.top = `${Math.max(8, Math.min(innerHeight - box.height - 8, y - box.height / 2))}px`;
}
function hideTip() {
  $("tip").hidden = true;
}
// Jump the conversation to the record nearest the hovered activity.
function jumpTo(target) {
  const seg = chart.segments[target.dataset.seg];
  const item =
    chart.marks[target.dataset.mark]?.item ??
    seg?.items.find((i) => i.kind === "tool") ??
    seg?.items[0];
  const at = item
    ? item.kind === "inference"
      ? item.end
      : item.start
    : seg?.start;
  if (at == null || !state?.entries) return;
  let best = null;
  for (const e of state.entries) {
    if (e.kind === "instructions") continue;
    const node = document.getElementById(`row-${e.id}`);
    const t = Date.parse(e.timestamp);
    if (!node || !Number.isFinite(t)) continue;
    if (!best || Math.abs(t - at) < Math.abs(best.t - at)) best = { node, t };
  }
  if (!best) return;
  best.node.scrollIntoView({ block: "center", behavior: "smooth" });
  best.node.classList.remove("flash");
  void best.node.offsetWidth;
  best.node.classList.add("flash");
}
// Hover targets: a context mark, or the bar column widened by 8px each side so
// 2px segments don't need precise aim. Elsewhere on the rail shows nothing.
let hot = null;
function targetAt(event) {
  const mark = event.target.closest("[data-mark]");
  if (mark) return mark;
  const bar = $("timeline").querySelector(".seg");
  if (!bar) return null;
  const box = bar.getBoundingClientRect();
  const pad = 8;
  if (event.clientX < box.left - pad || event.clientX > box.right + pad)
    return event.target.closest(".idle-break");
  const y = event.clientY - $("timeline").getBoundingClientRect().top;
  const index = chart.segments.findIndex((s) => y >= s.y && y < s.y + s.h);
  return $("timeline").querySelector(`[data-seg="${index}"]`);
}
function setHot(node) {
  if (hot === node) return;
  hot?.classList.remove("hot");
  hot = node;
  hot?.classList.add("hot");
}
$("timeline").addEventListener("pointermove", (event) => {
  const target = targetAt(event);
  setHot(target);
  if (target) showTip(target, event.clientX, event.clientY);
  else hideTip();
});
$("timeline").addEventListener("pointerleave", () => {
  setHot(null);
  hideTip();
});
$("timeline").addEventListener("focusin", (event) => {
  const target = event.target.closest("[data-seg],[data-mark]");
  if (!target) return;
  const box = target.getBoundingClientRect();
  showTip(target, box.right, box.top + box.height / 2);
});
$("timeline").addEventListener("focusout", hideTip);
$("timeline").addEventListener("click", (event) => {
  // A keyboard click has no pointer position: use the button it activated.
  const target =
    event.detail === 0
      ? event.target.closest("[data-seg],[data-mark],.idle-break")
      : targetAt(event);
  if (target) jumpTo(target);
});
// Minimap viewport: the conversation's on-screen time range as a band on the
// rail, like an editor scrollbar map. An entry spans until the next one starts;
// each band edge interpolates within the entry it crosses, so it glides with
// the scroll instead of stepping entry by entry.
function timeToY(t) {
  const segs = chart.segments;
  if (!segs.length) return null;
  if (t <= segs[0].start) return segs[0].y;
  for (const s of segs)
    if (t < s.end)
      return t <= s.start
        ? s.y
        : s.y + ((t - s.start) / Math.max(1, s.end - s.start)) * s.h;
  const last = segs.at(-1);
  return last.y + last.h;
}
function visibleEntries(top, bottom) {
  const rows = [];
  for (const node of $("content").children) {
    const t = Date.parse(node.dataset.time);
    if (!Number.isFinite(t)) continue;
    const box = node.getBoundingClientRect();
    rows.push({ t, top: box.top, bottom: box.bottom });
    if (box.top > bottom) break;
  }
  const first = rows.findLastIndex((row) => row.top <= top);
  return rows.slice(Math.max(0, first));
}
function timeAtLine(rows, line) {
  const end = chart.segments.at(-1)?.end ?? rows.at(-1).t;
  let i = rows.findLastIndex((row) => row.top <= line);
  if (i < 0) i = 0;
  const row = rows[i],
    next = rows[i + 1];
  const to = next ? next.t : Math.max(row.t, end);
  const span = (next ? next.top : row.bottom) - row.top;
  const share =
    span > 0 ? Math.min(1, Math.max(0, (line - row.top) / span)) : 0;
  return row.t + share * Math.max(0, to - row.t);
}
function updateViewport(reveal) {
  const band = document.querySelector(".chart .viewport");
  if (!band) return;
  const top = document.querySelector(".toolbar").getBoundingClientRect().bottom;
  const rows = visibleEntries(top, innerHeight);
  band.hidden = !rows.length || !chart.segments.length;
  if (band.hidden) return;
  const y0 = timeToY(timeAtLine(rows, top)),
    y1 = Math.max(y0, timeToY(timeAtLine(rows, innerHeight)));
  band.style.top = `${y0 - 3}px`;
  band.style.height = `${Math.max(6, y1 - y0 + 6)}px`;
  if (!reveal) return;
  // Follow continuously: keep the band inside the rail with a margin, moving
  // the rail only as far as the band itself moved past that margin.
  const scroller = document.querySelector(".timeline-scroll");
  const margin = Math.min(48, scroller.clientHeight / 6);
  const view = scroller.clientHeight - 2 * margin;
  if (y1 - y0 > view || y0 < scroller.scrollTop + margin)
    scroller.scrollTop = y0 - margin;
  else if (y1 > scroller.scrollTop + scroller.clientHeight - margin)
    scroller.scrollTop = y1 - scroller.clientHeight + margin;
}
let viewportFrame = 0;
addEventListener(
  "scroll",
  () => {
    if (viewportFrame) return;
    viewportFrame = requestAnimationFrame(() => {
      viewportFrame = 0;
      updateViewport(true);
    });
  },
  { passive: true },
);
addEventListener(
  "resize",
  () => state?.timing && renderTiming(state.timing, true),
);

// Shown only when more than one session matches, such as two agents answering
// in the same thread.
function renderPicker(candidates = [], file) {
  const picker = $("session");
  picker.hidden = candidates.length < 2;
  if (picker.hidden) return;
  const who = (c) => (c.agent ? `${c.agent.name} (${c.harness})` : c.harness);
  const options = [...candidates]
    .sort((a, b) => String(a.started).localeCompare(String(b.started)))
    .map((c, _, all) => {
      // The agent's name, and its start time only to tell two of its sessions apart.
      const since =
        all.filter((o) => who(o) === who(c)).length > 1 &&
        Number.isFinite(Date.parse(c.started))
          ? ` · started ${clock(Date.parse(c.started))}`
          : "";
      return `<option value="${htmlEscape(c.path)}" title="${htmlEscape(c.path)}">${htmlEscape(who(c) + since)}</option>`;
    })
    .join("");
  // Rebuilding an open list would close it, so only when the options change.
  if (picker.dataset.options !== options) {
    picker.innerHTML = options;
    picker.dataset.options = options;
  }
  picker.value = file;
}
$("session").addEventListener("change", (event) => {
  pinned = event.target.value;
  poll();
});
function render() {
  if (!state || state.waiting) {
    $("content").textContent = state?.message ?? "Loading…";
    return;
  }
  const nearBottom =
    window.scrollY + innerHeight >= document.documentElement.scrollHeight - 100;
  const open = new Set(
    [...document.querySelectorAll("details[open]")].map((d) => d.dataset.key),
  );
  const focused = document.activeElement;
  const focusedKey = focused?.closest("details")?.dataset.key;
  const scroll = window.scrollY;
  const query = $("search").value.toLowerCase();
  renderPicker(state.candidates, state.file);
  const { harness, model, effort } = state.header ?? {};
  // The picker, when shown, already names the agent and harness.
  const who = $("session").hidden
    ? `<strong>${htmlEscape(state.agent?.name ?? harness)}</strong>${state.agent ? `<span>${htmlEscape(harness)}</span>` : ""}`
    : "";
  const scope = `${who}${model ? `<span class="chip">${htmlEscape(model)}</span>` : ""}${effort ? `<span class="chip effort">${htmlEscape(effort)}</span>` : ""}`;
  if ($("scope").innerHTML !== scope) $("scope").innerHTML = scope;
  $("scope").title = state.sessionId ?? "";
  renderTiming(state.timing);
  renderSetup(state.setup);
  const rows = state.entries
    .filter((e) =>
      `${e.label} ${e.preview} ${e.html}`.toLowerCase().includes(query),
    )
    .map((e) => ({
      id: e.id,
      time: e.timestamp,
      html: `${e.kind === "tool" || e.kind === "instructions" ? "" : `<h2>${htmlEscape(e.label)}</h2>`}${e.html}`,
    }));
  // Reconcile entries by stable transcript position: live polling must not close
  // a disclosure, reset selection, or steal focus while the person reads.
  const container = $("content");
  const existing = new Map([...container.children].map((n) => [n.id, n]));
  let previous = null;
  for (const row of rows) {
    const id = `row-${row.id}`;
    let node = existing.get(id);
    if (!node) {
      node = document.createElement("section");
      node.className = "entry";
      node.id = id;
    }
    if (row.time) node.dataset.time = row.time;
    else delete node.dataset.time;
    if (node.dataset.html !== row.html) {
      node.innerHTML = row.html;
      node.dataset.html = row.html;
      node.querySelectorAll("details").forEach((d, i) => {
        d.dataset.key ||= `${id}-${i}`;
        d.open = open.has(d.dataset.key);
      });
    }
    if (
      previous
        ? previous.nextElementSibling !== node
        : container.firstElementChild !== node
    )
      container.insertBefore(
        node,
        previous ? previous.nextElementSibling : container.firstElementChild,
      );
    previous = node;
    existing.delete(id);
  }
  for (const node of existing.values()) node.remove();
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No matching records.";
    container.append(empty);
  }
  if (focusedKey && !document.contains(focused))
    [...container.querySelectorAll("details")]
      .find((d) => d.dataset.key === focusedKey)
      ?.querySelector("summary")
      ?.focus({ preventScroll: true });
  if (nearBottom) window.scrollTo(0, document.documentElement.scrollHeight);
  else window.scrollTo(0, scroll);
  updateViewport(false);
}
// Prompt setup: what the model was given before its first response, apart
// from the conversation. Transcript text is untrusted: everything is escaped
// before the small Markdown subset below adds its own tags.
const SCOPES = {
  system: "System",
  developer: "Developer",
  user: "User",
  settings: "Settings",
};
const BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";
const inline = (text) =>
  htmlEscape(text)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
// Headings, lists, fenced code, tag-only lines, inline code and bold. No links
// or raw HTML.
function markdown(source) {
  const out = [];
  let para = [],
    list = [],
    code = null;
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    if (list.length)
      out.push(
        `<ul>${list.map(([depth, text]) => `<li class="depth-${depth}">${inline(text)}</li>`).join("")}</ul>`,
      );
    para = [];
    list = [];
  };
  for (const line of String(source ?? "").split("\n")) {
    if (code) {
      if (/^\s*```/.test(line)) {
        out.push(
          `<pre class="md-code"><code>${htmlEscape(code.join("\n"))}</code></pre>`,
        );
        code = null;
      } else code.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const item = line.match(/^(\s*)(?:[-*]|\d+[.)])\s+(.+)$/);
    if (/^\s*```/.test(line)) {
      flush();
      code = [];
    } else if (heading) {
      flush();
      const level = Math.min(6, heading[1].length + 2);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (/^\s*<\/?[A-Za-z][\w.-]*>\s*$/.test(line)) {
      flush();
      out.push(`<div class="md-tag">${htmlEscape(line.trim())}</div>`);
    } else if (item) {
      if (para.length) flush();
      list.push([Math.min(3, Math.floor(item[1].length / 2)), item[2]]);
    } else if (!line.trim()) flush();
    else if (list.length && /^\s/.test(line))
      list.at(-1)[1] += ` ${line.trim()}`;
    else {
      if (list.length) flush();
      para.push(line);
    }
  }
  if (code)
    out.push(
      `<pre class="md-code"><code>${htmlEscape(code.join("\n"))}</code></pre>`,
    );
  flush();
  return out.join("");
}
// Pretty JSON with keys, strings, numbers and literals told apart.
function json(value, indent = "") {
  const next = `${indent}  `;
  if (Array.isArray(value))
    return value.length
      ? `[\n${value.map((v) => next + json(v, next)).join(",\n")}\n${indent}]`
      : "[]";
  if (value && typeof value === "object") {
    const fields = Object.entries(value);
    return fields.length
      ? `{\n${fields.map(([k, v]) => `${next}<span class="j-key">${htmlEscape(JSON.stringify(k))}</span>: ${json(v, next)}`).join(",\n")}\n${indent}}`
      : "{}";
  }
  const kind =
    typeof value === "string"
      ? "j-str"
      : typeof value === "number"
        ? "j-num"
        : "j-lit";
  return `<span class="${kind}">${htmlEscape(JSON.stringify(value))}</span>`;
}
const parsed = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
function setupBody(item) {
  if (item.blocks)
    return item.blocks
      .map((block) =>
        block === BOUNDARY
          ? `<div class="md-boundary">${htmlEscape(block)}</div>`
          : `<div class="md-block">${markdown(block)}</div>`,
      )
      .join("");
  const value = item.scope === "settings" && parsed(item.body);
  return value ? `<pre class="json">${json(value)}</pre>` : markdown(item.body);
}
let setupKey = "";
function renderSetup(setup) {
  const key = JSON.stringify(setup ?? null);
  if (key === setupKey) return;
  setupKey = key;
  const { instructions = [], tools = [] } = setup ?? {};
  const count = tools.reduce((n, group) => n + group.tools.length, 0);
  $("prompt-toggle").hidden = !instructions.length && !count;
  $("tab-tools").textContent = `Tools · ${count}`;
  const items = instructions
    .map((item) => {
      const scope = SCOPES[item.scope] ? item.scope : "other";
      const label = item.label.replace(/^(system|developer|user) · /, "");
      const at = Date.parse(item.timestamp);
      return `<details class="setup-item" open><summary><span class="scope scope-${scope}">${SCOPES[scope] ?? "Context"}</span><span class="setup-label">${htmlEscape(label)}</span>${Number.isFinite(at) ? `<span class="setup-time">${clock(at)}</span>` : ""}</summary><div class="md">${setupBody(item)}</div></details>`;
    })
    .join("");
  $("prompt-instructions").innerHTML = items
    ? `<p class="prompt-note">What the model received before its first response. Later context stays in the conversation.</p>${items}`
    : `<p class="empty">No instructions recorded.</p>`;
  $("prompt-tools").innerHTML =
    tools
      .map(
        (group) =>
          `${group.note ? `<p class="prompt-note">${htmlEscape(group.note)}</p>` : ""}${group.tools
            .map(
              (tool) =>
                `<details class="tool-def"><summary><span class="tool-name">${htmlEscape(tool.name)}</span><span class="tool-desc">${htmlEscape(String(tool.description ?? "").split("\n")[0])}</span></summary><div class="md">${markdown(tool.description)}</div>${tool.schema ? `<pre class="json">${json(tool.schema)}</pre>` : ""}</details>`,
            )
            .join("")}`,
      )
      .join("") || `<p class="empty">No tool definitions recorded.</p>`;
}
function showPrompt(open) {
  $("prompt").hidden = !open;
  $("prompt-toggle").setAttribute("aria-expanded", String(open));
  if (open) $("prompt-close").focus();
  else $("prompt-toggle").focus();
}
function showTab(name) {
  for (const tab of ["instructions", "tools"]) {
    $(`tab-${tab}`).setAttribute("aria-selected", String(tab === name));
    $(`prompt-${tab}`).hidden = tab !== name;
  }
}
$("prompt-toggle").addEventListener("click", () =>
  showPrompt($("prompt").hidden),
);
$("prompt-close").addEventListener("click", () => showPrompt(false));
$("tab-instructions").addEventListener("click", () => showTab("instructions"));
$("tab-tools").addEventListener("click", () => showTab("tools"));
addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("prompt").hidden) showPrompt(false);
});
$("search").addEventListener("input", render);
$("theme").addEventListener("click", () => {
  document.documentElement.dataset.theme =
    (document.documentElement.dataset.theme ||
      (matchMedia("(prefers-color-scheme:dark)").matches
        ? "dark"
        : "light")) === "dark"
      ? "light"
      : "dark";
});
function setStatus(kind, text, detail) {
  const status = $("status");
  status.dataset.state = kind;
  status.title = detail;
  if (status.textContent !== text) status.textContent = text;
}
async function poll() {
  if (pending) return;
  pending = true;
  try {
    const asked = pinned;
    const url = new URL("state", location.href);
    if (asked) url.searchParams.set("session", asked);
    const response = await fetch(url, { cache: "no-store" });
    const next = await response.json();
    if (!response.ok) throw new Error(next.error ?? "Could not read session");
    // Picked another session while this read was out: the next poll shows it.
    if (asked !== pinned) return;
    pinned ??= next.file ?? null;
    const nextSignature = JSON.stringify(next);
    setStatus("live", "Live", `Checked ${new Date().toLocaleTimeString()}`);
    if (signature !== nextSignature) {
      state = next;
      signature = nextSignature;
      render();
    }
  } catch (error) {
    // Until a picked session loads, the picker names the one still on screen.
    if (state?.file) $("session").value = state.file;
    setStatus("error", "Reconnecting…", error.message);
  } finally {
    pending = false;
  }
}
await poll();
setInterval(poll, 1000);
