#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { entry, exportSession, text } from "./session-viewer.mjs";

const contentText = (content) =>
  (content ?? [])
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n")
    .trim();
// Tool outputs are a string or a list of text/image content items.
const outputText = (output) =>
  Array.isArray(output) &&
  output.every((item) => typeof item?.text === "string")
    ? output.map((item) => item.text).join("\n")
    : output;
// Codex injects AGENTS.md and environment context as user-role messages.
const isContext = (value) =>
  /^(# AGENTS\.md instructions|<environment_context>|<user_instructions>)/.test(
    value,
  );
// Name injected context by its role and leading tag, as `developer · skills instructions`.
const contextLabel = (role, body) =>
  `${role} · ${
    /^# AGENTS\.md/.test(body)
      ? "AGENTS.md"
      : (body.match(/^<([A-Za-z][\w.-]*)>/)?.[1].replace(/[_.]/g, " ") ??
        "instructions")
  }`;
// Buzz turns end with `Request: "<json string>"`; show that instead of context.
function buzzRequest(value) {
  const match = value.match(/^Request: (".*")$/m);
  try {
    return match ? JSON.parse(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function jsonString(literal) {
  try {
    return JSON.parse(literal);
  } catch {
    return undefined;
  }
}

export function buildCodex(records) {
  const meta =
    records.find((record) => record?.type === "session_meta")?.payload ?? {};
  const outputs = new Map(
    records
      .filter((record) => record?.payload?.type?.endsWith?.("_output"))
      .map((record) => [record.payload.call_id, record.payload]),
  );
  const entries = [];
  let model;
  let settings;
  for (const { timestamp, type, payload: item } of records) {
    // Approval, sandbox, collaboration mode and effort, shown when they change.
    if (type === "turn_context" && item) {
      const { turn_id: _, root_turn_id: __, ...rest } = item;
      const next = JSON.stringify(
        {
          ...rest,
          model_provider: meta.model_provider,
          context_window: meta.context_window,
        },
        null,
        2,
      );
      if (next !== settings)
        entries.push(
          entry.instructions(timestamp, "Run settings", next, {
            scope: "settings",
          }),
        );
      settings = next;
    }
    if (type === "turn_context" && item?.model && item.model !== model) {
      model = item.model;
      entries.push(
        entry.model(
          timestamp,
          `${model}${item.effort ? ` · ${item.effort}` : ""}`,
        ),
      );
    }
    if (type !== "response_item" || !item?.type) continue;
    if (item.type === "message") {
      const body = contentText(item.content);
      if (!body) continue;
      if (item.role === "developer" || isContext(body))
        entries.push(
          entry.instructions(timestamp, contextLabel(item.role, body), body, {
            scope: item.role,
          }),
        );
      else if (item.role === "user")
        entries.push(entry.user(timestamp, body, buzzRequest(body)));
      else entries.push(entry.assistant(timestamp, body));
    } else if (item.type === "reasoning") {
      const summary = (item.summary ?? []).map((part) => part.text).join("\n");
      if (summary) entries.push(entry.thinking(timestamp, summary));
    } else if (item.call_id && !item.type.endsWith("_output")) {
      const input = item.input ?? item.arguments ?? item.action ?? "";
      const output = outputs.get(item.call_id);
      const tool = (name) =>
        entry.tool(timestamp, {
          name,
          input,
          result: output && outputText(output.output),
        });
      // Code Mode runs nested tools from an `exec` script: name the calls in
      // order, and show each Buzz send as the message it posted.
      let group = [];
      const flush = () => {
        if (group.length) entries.push(tool([...new Set(group)].join(", ")));
        group = [];
      };
      const calls = [
        ...text(input).matchAll(
          /tools\.([A-Za-z0-9_]+)\(\s*(?:\{\s*"?text"?\s*:\s*("(?:[^"\\]|\\.)*"))?/g,
        ),
      ];
      for (const [, name, literal] of calls) {
        const body = name === "buzz__send" && literal && jsonString(literal);
        if (body === undefined || body === false || body === "")
          group.push(name);
        else {
          flush();
          entries.push(entry.sent(timestamp, body));
        }
      }
      flush();
      if (!calls.length) entries.push(tool(item.name || item.type));
    } else if (!item.type.endsWith("_output")) {
      const { encrypted_content: _, ...rest } = item;
      entries.push(entry.other(timestamp, item.type, rest));
    }
  }
  return {
    title: "Codex session",
    info: [
      `Session: ${meta.id}`,
      `Originator: ${meta.originator} · Codex ${meta.cli_version}`,
      `Working directory: ${meta.cwd}`,
      `Started: ${meta.timestamp}`,
    ],
    entries,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  exportSession(buildCodex);
