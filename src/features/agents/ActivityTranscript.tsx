import { useMemo, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ToolDiff,
  ToolItem,
  Transcript,
  TranscriptItem,
  TranscriptTurn,
} from "./activity-transcript";
import { MAX_MARKDOWN_LENGTH, scanMarkdown } from "../relay/message-content";
import {
  BulbIcon,
  ChatCircleIcon,
  DotsThreeIcon,
  EyeIcon,
  GlobeIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  ShieldIcon,
  TerminalWindowIcon,
  TrashIcon,
  UserIcon,
  WarningCircleIcon,
  WrenchIcon,
} from "../../shared/design-system/icons/index";
import styles from "./ActivityTranscript.module.css";

type TurnState = "working" | "unknown" | "ended";
// Icons follow ACP's standard tool kinds; tool names stay as the adapter sent them.
const ICONS: Record<string, typeof WrenchIcon> = {
  execute: TerminalWindowIcon,
  read: EyeIcon,
  edit: PencilSimpleIcon,
  delete: TrashIcon,
  move: PencilSimpleIcon,
  search: MagnifyingGlassIcon,
  fetch: GlobeIcon,
  think: BulbIcon,
};
const STATUS: Record<string, string> = {
  pending: "Pending",
  in_progress: "Running",
  failed: "Failed",
};
const line = (text: string) => text.split("\n").find(Boolean)?.trim() ?? "";
const time = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
export function duration(ms: number) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}
const toolName = (item: ToolItem) => line(item.title) || "tool";
/** The first location, unless the adapter's title already names it. */
const toolPath = (item: ToolItem) =>
  item.paths[0] && !item.title.includes(item.paths[0]) ? item.paths[0] : "";
const thread = (turn: TranscriptTurn) =>
  turn.threadRootId === null
    ? "Channel conversation"
    : turn.threadRootId
      ? `Thread ${turn.threadRootId.slice(0, 8)}`
      : "Thread unknown";

/** Turn-by-turn transcript of the loaded activity. */
export function ActivityTranscript({
  transcript,
  agentName,
  state,
  before,
}: {
  transcript: Transcript;
  agentName: string;
  state: (turnId: string) => TurnState | undefined;
  /** Paging controls shown above the oldest loaded turn. */
  before?: ReactNode;
}) {
  return (
    <div className={styles.timeline}>
      {before}
      {!transcript.turns.length && (
        <p className="text-body-sm text-secondary">
          No turns captured for this scope yet.
        </p>
      )}
      {transcript.turns.map((turn) => (
        <Turn
          key={turn.turnId}
          turn={turn}
          state={turn.endedAt ? "ended" : (state(turn.turnId) ?? "unknown")}
          agentName={agentName}
        />
      ))}
    </div>
  );
}

function Turn({
  turn,
  state,
  agentName,
}: {
  turn: TranscriptTurn;
  state: TurnState;
  agentName: string;
}) {
  const status = turn.error
    ? "Error"
    : state === "working"
      ? "Working"
      : turn.endedAt
        ? "Completed"
        : "Status unknown";
  const facts = [
    turn.endedAt ? duration(turn.endedAt - turn.startedAt) : "",
    thread(turn),
    turn.source === "heartbeat" ? "heartbeat" : "",
    turn.newSession ? "new session" : "",
    turn.stopReason ?? "",
    turn.context
      ? `context ${Math.round(turn.context.used / 1000)}k/${Math.round(turn.context.size / 1000)}k`
      : "",
  ].filter(Boolean);
  return (
    <article
      className={styles.turn}
      aria-label={`Turn ${time(turn.startedAt)}`}
    >
      <p className={`text-body-sm ${styles.session}`}>
        {[
          "Turn",
          new Date(turn.startedAt).toLocaleString(),
          ...turn.config,
        ].join(" · ")}
      </p>
      <header className={`text-body-sm ${styles.turnHeader}`}>
        <span data-state={turn.error ? "error" : state}>{status}</span>
        {facts.map((fact) => (
          <span key={fact}> · {fact}</span>
        ))}
      </header>
      {turn.partial && (
        <p className="text-body-sm text-secondary">
          The start of this turn isn't loaded.
        </p>
      )}
      {turn.items.map((item) => (
        <div key={item.id} className={styles.item} data-type={item.type}>
          <Item item={item} agentName={agentName} />
        </div>
      ))}
      {turn.error && (
        <p role="note" className={`${styles.row} ${styles.error}`}>
          <WarningCircleIcon size={16} aria-hidden="true" />
          <span className={styles.text}>{turn.error}</span>
        </p>
      )}
      {state === "working" && (
        <p className={`${styles.row} text-secondary`}>
          <DotsThreeIcon size={16} aria-hidden="true" /> Working…
        </p>
      )}
    </article>
  );
}

function Sections({
  title,
  sections,
}: {
  title: string;
  sections: readonly { tag: string; body: string }[];
}) {
  return (
    <details>
      <summary className="text-body-sm text-secondary">
        {title} · {sections.length} sections
      </summary>
      {sections.map((section, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: sections are a positional, immutable parse of one prompt.
        <details key={index} className={styles.section}>
          <summary className="text-body-sm">{section.tag}</summary>
          <pre className={styles.pre}>{section.body}</pre>
        </details>
      ))}
    </details>
  );
}

function Item({
  item,
  agentName,
}: {
  item: TranscriptItem;
  agentName: string;
}) {
  switch (item.type) {
    case "system":
      return <Sections title="System prompt" sections={item.sections} />;
    case "prompt":
      return (
        <>
          <p className={styles.row}>
            <UserIcon size={16} aria-hidden="true" />
            <span className={styles.text}>
              {item.author && <strong>{item.author} </strong>}
              {item.steer && <em>(steer) </em>}
              {item.text}
            </span>
          </p>
          {item.sections.length > 1 && (
            <Sections title="Prompt context" sections={item.sections} />
          )}
        </>
      );
    case "thought":
      return (
        <p className={`${styles.row} text-secondary`}>
          <BulbIcon size={16} aria-label="Thought" />
          <span className={styles.text}>{item.text}</span>
        </p>
      );
    case "message":
      return (
        <div className={styles.row}>
          <ChatCircleIcon size={16} aria-hidden="true" />
          <div className={styles.reply}>
            <strong>{agentName}</strong>
            {item.posted && (
              <span className="text-body-sm text-secondary"> · Posted</span>
            )}
            <Reply text={item.text} />
          </div>
        </div>
      );
    case "tool":
      return <Tool item={item} />;
    case "plan":
      return (
        <div className={styles.row}>
          <ListChecksIcon size={16} aria-hidden="true" />
          <ul className={styles.plan} aria-label="Plan">
            {item.entries.map((entry, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: plan entries are positional and carry no row state.
              <li key={index} data-status={entry.status}>
                {entry.status === "completed" ? "☑" : "☐"} {entry.content}
              </li>
            ))}
          </ul>
        </div>
      );
    case "status":
      return <p className="text-body-sm text-secondary">{item.text}</p>;
  }
}

// Module-scoped so rerenders keep rendered links (and their focus) in place.
const REMARK = [remarkGfm];
const MARKDOWN: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
  img: ({ alt }) => alt ?? null,
};

/** Agent replies are Markdown; remote images stay unloaded. */
function Reply({ text }: { text: string }) {
  const bounded = useMemo(
    () => text.length <= MAX_MARKDOWN_LENGTH && !scanMarkdown(text).tooDeep,
    [text],
  );
  if (!bounded) return <div className={styles.plain}>{text}</div>;
  return (
    <div className={styles.markdown}>
      <Markdown remarkPlugins={REMARK} components={MARKDOWN}>
        {text}
      </Markdown>
    </div>
  );
}

/** A file's lines; a final newline does not start another line. */
const lines = (text: string) => text.replace(/\n$/, "").split("\n");
/** One hunk between the unchanged leading and trailing lines. */
function Diff({ diff }: { diff: ToolDiff }) {
  const before = diff.oldText === undefined ? [] : lines(diff.oldText);
  const after = lines(diff.newText);
  let head = 0;
  while (
    head < before.length &&
    head < after.length &&
    before[head] === after[head]
  )
    head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  const removed = before.slice(head, before.length - tail);
  const added = after.slice(head, after.length - tail);
  return (
    <figure className={styles.diff}>
      <figcaption className="text-body-sm text-secondary">
        {diff.oldText === undefined ? "New file" : "Changed"} {diff.path}
      </figcaption>
      <pre className={styles.pre}>
        {removed.map((text, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional and immutable.
          <span key={`-${index}`} className={styles.removed}>
            {`- ${text}\n`}
          </span>
        ))}
        {added.map((text, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional and immutable.
          <span key={`+${index}`} className={styles.added}>
            {`+ ${text}\n`}
          </span>
        ))}
      </pre>
    </figure>
  );
}

function Tool({ item }: { item: ToolItem }) {
  const Icon = ICONS[item.kind] ?? WrenchIcon;
  const status = STATUS[item.status];
  const path = toolPath(item);
  return (
    <details className={styles.tool} data-status={item.status}>
      <summary className={styles.row}>
        <Icon size={16} aria-hidden="true" />
        <span className={styles.summary}>
          {status && <span className={styles.status}>{status} </span>}
          <span className={styles.subject}>{toolName(item)}</span>
          {path && <span className={styles.path}> {path}</span>}
        </span>
        {item.permission && (
          <span
            className={`text-body-sm text-secondary ${styles.badge}`}
            title={`Permission options: ${item.permission.options.join(", ")}`}
          >
            <ShieldIcon size={14} aria-hidden="true" />
            {item.permission.outcome ?? "Permission requested"}
          </span>
        )}
        {item.completedAt !== undefined && (
          <span className="text-body-sm text-secondary">
            {duration(item.completedAt - item.at)}
          </span>
        )}
      </summary>
      {item.title.includes("\n") && (
        <pre className={styles.pre}>{item.title}</pre>
      )}
      {item.input && <pre className={styles.pre}>{item.input}</pre>}
      {item.diffs.map((diff, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: diffs are positional tool content.
        <Diff key={index} diff={diff} />
      ))}
      {item.output && <pre className={styles.pre}>{item.output}</pre>}
      {item.truncated && (
        <p className="text-body-sm text-secondary">
          Part of this tool call was too large and was elided by the agent.
        </p>
      )}
    </details>
  );
}
