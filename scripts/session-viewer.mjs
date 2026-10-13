// Shared standalone HTML viewer for agent session exporters, modeled on Pi's.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

// Transcripts are untrusted text: never interpret their Markdown, HTML, or URLs.
export const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
export const text = (value) =>
  typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
const time = (timestamp) =>
  `<div class="time">${escapeHtml(timestamp?.slice(11, 19))}</div>`;
// Long text shows a preview; clicking toggles the full text, as in Pi's viewer.
function expandable(value, lines = 10) {
  const all = text(value).split("\n");
  if (all.length <= lines) return `<pre>${escapeHtml(all.join("\n"))}</pre>`;
  return `<details><summary>${escapeHtml(all.slice(0, Math.max(1, lines)).join("\n"))} … (${all.length} lines)</summary><pre>${escapeHtml(all.join("\n"))}</pre></details>`;
}

// Entry builders: kind drives filters, label/preview the sidebar, html the card.
export const entry = {
  model: (timestamp, label) => ({
    timestamp,
    kind: "model",
    label: "model",
    preview: label,
    html: `<div class="model">${time(timestamp)}Switched to model: <span class="accent">${escapeHtml(label)}</span></div>`,
  }),
  // Model-visible context outside the conversation: one quiet, collapsed row.
  // A one-line body, once unwrapped from `<system-reminder>`, also shows inline.
  // `extra.scope` is the role it was sent as: system, developer or user.
  instructions: (timestamp, label, body, extra = {}) => {
    const brief = body.replace(/<\/?system-reminder>/g, "").trim();
    return {
      timestamp,
      kind: "instructions",
      label,
      preview: body,
      html: `<details class="tool context instructions"><summary>${escapeHtml(label)}${/^.{1,120}$/.test(brief) ? ` <span class="accent">${escapeHtml(brief)}</span>` : ""}</summary><div class="details-body">${time(timestamp)}<pre>${escapeHtml(body)}</pre></div></details>`,
      ...extra,
    };
  },
  // Tool definitions as recorded, `[{ name, description, schema }]`, one
  // disclosure per tool.
  tools: (timestamp, label, tools, extra = {}) => ({
    timestamp,
    kind: "instructions",
    label,
    tools,
    ...extra,
    preview: tools.map((tool) => tool.name).join(", "),
    html: `<details class="tool context instructions"><summary>${escapeHtml(label)}</summary><div class="details-body">${time(timestamp)}${tools
      .map(
        ({ name, description, schema }) =>
          `<details><summary>${escapeHtml(name)}</summary><pre>${escapeHtml([description, schema && text(schema)].filter(Boolean).join("\n\n"))}</pre></details>`,
      )
      .join("")}</div></details>`,
  }),
  // A Buzz turn shows its request, with the full turn context collapsed.
  user: (timestamp, body, request) => ({
    timestamp,
    kind: "user",
    label: "user",
    preview: request ?? body,
    html: `<div class="card user">${time(timestamp)}${request === undefined ? expandable(body, 20) : `<pre>${escapeHtml(request)}</pre><div class="title muted">Buzz turn</div>${expandable(body, 0)}`}</div>`,
  }),
  assistant: (timestamp, body) => ({
    timestamp,
    kind: "assistant",
    label: "assistant",
    preview: body,
    html: `<div class="assistant">${time(timestamp)}<pre>${escapeHtml(body)}</pre></div>`,
  }),
  thinking: (timestamp, body) => ({
    timestamp,
    kind: "assistant",
    label: "thinking",
    preview: body,
    html: `<div class="assistant thinking">${time(timestamp)}<pre>${escapeHtml(body)}</pre></div>`,
  }),
  // `result` is undefined while pending; `detail` names the call's target.
  tool: (timestamp, { name, detail = "", input, result, error = false }) => ({
    timestamp,
    kind: "tool",
    label: name,
    preview: detail || text(input),
    html: `<details class="card tool ${result === undefined ? "pending" : error ? "error" : "done"}"><summary>${escapeHtml(name)}${detail ? ` <span class="accent">${escapeHtml(detail)}</span>` : ""}${error ? ` <span class="status">failed</span>` : ""}</summary><div class="details-body">${time(timestamp)}${expandable(input, 20)}${result === undefined ? "" : `<div class="output">${expandable(result)}</div>`}</div></details>`,
  }),
  // A message the agent posted to Buzz through its send tool.
  sent: (timestamp, body) => ({
    timestamp,
    kind: "sent",
    label: "posted to Buzz",
    preview: body,
    html: `<div class="card sent">${time(timestamp)}<pre>${escapeHtml(body)}</pre></div>`,
  }),
  other: (timestamp, label, value) => ({
    timestamp,
    kind: "other",
    label,
    preview: text(value),
    html: `<div class="card">${time(timestamp)}<div class="title">${escapeHtml(label)}</div>${expandable(value)}</div>`,
  }),
};

/** Parse argv and JSONL, let `build` extract entries, and write the viewer. */
export function exportSession(build) {
  const [source, destination, ...extra] = process.argv.slice(2);
  if (!source || !destination || extra.length > 0) {
    console.error(
      `Usage: bin/node scripts/${basename(process.argv[1])} <session.jsonl> <output.html>`,
    );
    process.exit(1);
  }
  try {
    const records = readFileSync(source, "utf8")
      .split("\n")
      .flatMap((line, index) => {
        if (!line.trim()) return [];
        try {
          return [JSON.parse(line)];
        } catch {
          throw new Error(
            `Invalid JSON on line ${index + 1}; no export written`,
          );
        }
      });
    const { title, info, entries } = build(records);
    if (entries.length === 0) throw new Error("No recorded entries to export");
    const count = (kind) => entries.filter((item) => item.kind === kind).length;
    const html = page(
      title,
      [
        ...info,
        `${count("user")} user messages · ${count("assistant")} assistant messages · ${count("tool")} tool calls · local snapshot`,
        `Transcript: ${resolve(source)}`,
      ],
      entries,
    );
    // Never overwrite a transcript or an existing export; keep private data local.
    writeFileSync(destination, html, { flag: "wx", mode: 0o600 });
    console.log(
      `Exported ${entries.length} entries to ${resolve(destination)}`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function page(title, info, entries) {
  const nonce = randomBytes(16).toString("base64");
  const nav = entries
    .map(
      (item, index) =>
        `<div class="node" data-kind="${item.kind}" data-target="e${index}"><span class="role role-${item.kind}">${escapeHtml(item.label)}:</span> ${escapeHtml(item.preview.replace(/\s+/g, " ").slice(0, 200))}</div>`,
    )
    .join("\n");
  const cards = entries
    .map(
      (item, index) =>
        `<section id="e${index}" data-kind="${item.kind}">${item.html}</section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(title)}</title>
<style>
:root { --bg: #1c1a22; --panel: #232129; --text: #e2e3e6; --muted: #a2a5ae; --dim: #6f7380;
  --accent: #8fd3e0; --success: #7bd6a8; --user: #2b3050; --tool: #213a30; --error: #4a2a24; --pending: #33343a; --custom: #3d2a45; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font: 12px/18px ui-monospace, Menlo, Consolas, monospace; color: var(--text); background: var(--bg); display: flex; }
aside { width: 380px; flex-shrink: 0; position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; background: var(--panel); border-right: 1px solid var(--dim); }
.controls { padding: 12px; display: flex; flex-wrap: wrap; gap: 4px; }
input { width: 100%; margin-bottom: 4px; padding: 4px 8px; font: inherit; font-size: 11px; color: var(--text); background: var(--bg); border: 1px solid var(--dim); border-radius: 3px; }
button { padding: 2px 8px; font: inherit; font-size: 10px; color: var(--muted); background: none; border: 1px solid var(--dim); border-radius: 3px; cursor: pointer; }
button.active { color: var(--bg); background: var(--accent); border-color: var(--accent); }
nav { overflow-y: auto; padding-bottom: 12px; }
.node { padding: 1px 12px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.node:hover, .node.active { background: var(--user); }
.role { color: var(--muted); } .role-user { color: var(--accent); font-weight: bold; } .role-assistant { color: var(--success); }
main { flex: 1; min-width: 0; padding: 18px 36px; display: flex; flex-direction: column; align-items: center; gap: 18px; }
main > * { width: 100%; max-width: 800px; }
.header { background: var(--panel); border-radius: 4px; padding: 18px; color: var(--muted); overflow-wrap: anywhere; }
h1 { font-size: 12px; color: var(--accent); margin-bottom: 12px; }
.card { padding: 18px; border-radius: 4px; background: var(--panel); }
.user { background: var(--user); } .tool.done { background: var(--tool); } .tool.error { background: var(--error); } .tool.pending { background: var(--pending); } .instructions { background: var(--custom); }
.assistant { padding: 0 18px; } .thinking pre { color: var(--muted); font-style: italic; }
.time { font-size: 10px; color: var(--dim); }
.title { font-weight: bold; margin-bottom: 6px; } .muted { color: var(--muted); font-weight: normal; margin-top: 12px; }
.accent { color: var(--accent); }
.model { color: var(--muted); padding: 0 18px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
.output { margin-top: 12px; color: var(--muted); }
.expandable { cursor: pointer; } .expandable .full, .expandable.expanded .preview { display: none; } .expandable.expanded .full { display: block; }
.hint { color: var(--dim); font-style: italic; }
.hidden { display: none !important; }
</style></head><body>
<aside><div class="controls"><input id="search" type="search" placeholder="Search...">
<button data-filter="default" class="active">Default</button><button data-filter="no-tools">No-tools</button><button data-filter="user">User</button><button data-filter="all">All</button></div>
<nav>${nav}</nav></aside>
<main><div class="header"><h1>${escapeHtml(title)}</h1>${info.map(escapeHtml).join("<br>")}</div>
${cards}</main>
<script nonce="${nonce}">
const shown = { default: (k) => k !== "instructions", "no-tools": (k) => k !== "instructions" && k !== "tool", user: (k) => k === "user", all: () => true };
let filter = "default";
function apply() {
  const query = document.getElementById("search").value.toLowerCase();
  for (const node of document.querySelectorAll(".node")) {
    const card = document.getElementById(node.dataset.target);
    const visible = shown[filter](node.dataset.kind) && (!query || card.textContent.toLowerCase().includes(query));
    node.classList.toggle("hidden", !visible);
    card.classList.toggle("hidden", !visible);
  }
}
for (const button of document.querySelectorAll("button[data-filter]"))
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    for (const other of document.querySelectorAll("button[data-filter]")) other.classList.toggle("active", other === button);
    apply();
  });
document.getElementById("search").addEventListener("input", apply);
document.addEventListener("click", (event) => {
  const node = event.target.closest(".node");
  if (node) {
    for (const other of document.querySelectorAll(".node.active")) other.classList.remove("active");
    node.classList.add("active");
    document.getElementById(node.dataset.target).scrollIntoView({ block: "start" });
  }
  const more = event.target.closest(".expandable");
  if (more && !String(getSelection())) more.classList.toggle("expanded");
});
apply();
</script>
</body></html>`;
}
