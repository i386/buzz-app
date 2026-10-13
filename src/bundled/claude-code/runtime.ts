// Turns Agents deliveries into Claude turns. Each agent of this type has its
// own sessions; a delivery becomes a prompt in the harness format, sent to the
// session for its conversation; a watch or timer wake runs as a one-off turn in
// a new session, in its Interest's lane. The run returns once the turn is handed over,
// so one agent works in several conversations at once. Claude acts in Buzz with
// the in-process Buzz tools, signed by the agent's native-held key; the runtime
// only reports a turn that fails.
import type { Context } from "../../buzz-mcp/client";
import { respond } from "../../buzz-mcp/rpc";
import { fromOwner, workflowOf } from "../../features/agents/owner-attestation";
import type { AgentReads } from "../../features/agents/reads";
import type {
  Agent,
  AgentHandle,
  Delivery,
  Effort,
  Models,
} from "../../features/agents/service";
import type { Host } from "../../features/host/service";
import type { EventData } from "../../features/relay/events";
import { threadReference } from "../../features/relay/thread-reference";
import type { Settled, Spawn, ToolServer } from "./claude";
import { appClient } from "../../buzz-mcp/app-client";
import { coreOf, MemoryReads } from "../../features/agent-harness/core-memory";
import { Lanes } from "./lanes";
import {
  ATTENTION_REVIEW,
  CONTEXT_LIMIT,
  type Scope,
  steerPrompt,
  systemPrompt,
  timerPrompt,
  turnPrompt,
  watchPrompt,
} from "./prompt";
import { AgentSessions, localSessions, Spare } from "./sessions";
import { readTranscript, type Conversation } from "./transcript";

/** What a session can switch to between turns. Claude runs `max` as
 * `xhigh` in a stream-json session, so it is not offered. */
const EFFORTS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
];

export type Config = Readonly<{
  /** A Claude model or alias; empty uses Claude's own default. */
  model: string;
  instructions: string;
  /** The agent's working directory, absolute or `~/…`. */
  workspace: string;
  /** Whether each thread is its own session, or the whole channel is one. */
  scope: Scope;
}>;
export const DEFAULT_CONFIG: Config = Object.freeze({
  model: "",
  instructions: "",
  workspace: "~/.buzz",
  scope: "thread",
});
export const config = (value: unknown): Config => ({
  ...DEFAULT_CONFIG,
  ...(value && typeof value === "object" ? (value as Partial<Config>) : {}),
});

/** A saved session, for the owner's transcript list. */
export type SavedConversation = Conversation & {
  key: string;
  sessionId: string;
  /** The channel's name, when this community lists it. */
  name?: string;
  at: number;
};

const MEMORY_TIMEOUT_MS = 5_000;
const NAMES_TIMEOUT_MS = 2_000;
const CHAT = [9, 40002];

type Entry = {
  sessions: AgentSessions;
  config: Config;
  /** The team sections of the latest run; a change restarts idle sessions. */
  team: string;
  /** The agent's name, for its prompt; a rename restarts idle sessions. */
  name?: string;
  /** Whether the owner has attention on: new sessions get its tools, its
   * guidance and the end-of-turn review. */
  attention: boolean;
  /** Watch and timer turns, one lane per Interest. */
  lanes: Lanes;
  /** The agent's handle from its latest delivery, for the tools to act with. */
  handle?: AgentHandle;
  /** Where each conversation's tools default to: its latest turn's thread. */
  contexts: Map<string, Context>;
  /** Each conversation's latest posting policy: when its turns were handed
   * over, and when all of them settled. */
  policies: Map<
    string,
    { topLevel: boolean; handed: Promise<unknown>; settled: Promise<unknown> }
  >;
};

/** Where an agent's processes run, and with which model. */
const where = ({ workspace, model }: Config) => ({
  cwd: workspace,
  ...(model.trim() ? { model: model.trim() } : {}),
});

export class ClaudeRuntime {
  private readonly agents = new Map<string, Entry>();
  private readonly memoryReads = new MemoryReads();
  private readonly listeners = new Set<() => void>();
  /** Each agent's last session list, kept until something changes so a view
   * reading it gets the same array back. */
  private readonly views = new Map<
    string,
    ReturnType<AgentSessions["snapshot"]>
  >();
  /** One process started ahead of need, for any agent's next new conversation. */
  private readonly spare = new Spare(
    (id, options) => this.spawn(id, options),
    (_conversation, message) => respond(undefined, {}, message),
  );

  constructor(
    private readonly host: Pick<Host, "spawn">,
    /** What each agent's turns read of its community, while it can be read. */
    private readonly reads: (pubkey: string) => AgentReads | undefined,
    private readonly storage: Storage = globalThis.localStorage,
    private readonly resolveConfig: (raw: unknown) => Config = config,
  ) {}

  private get spawn(): Spawn {
    const spawn = this.host.spawn?.bind(this.host);
    if (!spawn) throw new Error("Claude agents run only in the desktop app");
    return spawn;
  }

  /** Brings the runtime in line with this type's agents: changed settings
   * restart idle sessions, removed agents stop, and a spare waits while any
   * agent is here. */
  sync(agents: readonly Agent[]) {
    const current = new Set(agents.map((agent) => agent.pubkey));
    // Deleted, signed out or its community disconnected: either way its
    // processes stop. Saved sessions stay so it resumes when it is back.
    for (const [pubkey, entry] of this.agents)
      if (!current.has(pubkey)) {
        entry.lanes.stop();
        entry.sessions.dispose();
        this.agents.delete(pubkey);
      }
    for (const agent of agents) {
      const next = this.resolveConfig(agent.config);
      const entry = this.agents.get(agent.pubkey);
      if (!entry)
        this.entry(agent.pubkey, next, agent.attentionEnabled).name =
          agent.name;
      else if (
        JSON.stringify(entry.config) !== JSON.stringify(next) ||
        entry.name !== agent.name ||
        entry.attention !== agent.attentionEnabled
      ) {
        // Attention changes what a new session is told and offered. Turned
        // off, its waiting watch and timer turns are dropped too.
        if (!agent.attentionEnabled) entry.lanes.clear();
        entry.config = next;
        entry.name = agent.name;
        entry.attention = agent.attentionEnabled;
        entry.sessions.reconfigure();
      }
    }
    this.spare.warm(
      ...agents.map((agent) => where(this.resolveConfig(agent.config))),
    );
    this.notify();
  }

  /** The models the agent's next turn can run on, with their effort levels.
   * Without a pick it uses its own: the configured one, or else the one its
   * sessions report. `default` duplicates a listed model, so it is not offered. */
  async models(pubkey: string): Promise<Models> {
    const entry = this.agents.get(pubkey);
    const configured = entry?.config.model.trim();
    const {
      models: listed,
      model: reported,
      effort,
    } = (await entry?.sessions.metadata()) ?? { models: [] };
    // A turn without a pick keeps the session's effort on any model.
    const resting = (efforts: readonly Effort[]) =>
      effort && efforts.some((level) => level.id === effort) ? { effort } : {};
    const own = configured || reported || "";
    const offered = listed.filter((model) => model.value !== "default");
    const models = offered.map((model) => {
      const efforts =
        model.supportsEffort === false
          ? []
          : EFFORTS.filter(
              (level) =>
                !model.supportedEffortLevels ||
                model.supportedEffortLevels.includes(level.id),
            );
      return {
        id: model.value,
        label: modelName(model.resolvedModel ?? model.value),
        efforts,
        ...resting(efforts),
      };
    });
    const current =
      offered.find(
        (model) => own === model.value || own === model.resolvedModel,
      )?.value ?? own;
    // An own model Claude does not list is still the one it runs.
    return models.some((model) => model.id === current)
      ? { current, models }
      : {
          current,
          models: [
            {
              id: current,
              label: current ? modelName(current) : "Claude",
              efforts: EFFORTS,
              ...resting(EFFORTS),
            },
            ...models,
          ],
        };
  }

  /** Conversations each agent has running, for its status view. */
  sessions(pubkey: string) {
    let view = this.views.get(pubkey);
    if (!view) {
      view = this.agents.get(pubkey)?.sessions.snapshot() ?? [];
      this.views.set(pubkey, view);
    }
    return view;
  }
  /** The agent's saved sessions, most recently used first. */
  conversations(pubkey: string): SavedConversation[] {
    const reads = this.reads(pubkey);
    return localSessions(this.storage, pubkey)
      .list()
      .map(([key, saved]) => {
        const [channelId = key, root] = key.split("/");
        const name = reads?.channelName(channelId);
        return {
          key,
          agent: pubkey,
          sessionId: saved.id,
          channelId,
          ...(root ? { root } : {}),
          ...(name ? { name } : {}),
          at: saved.at,
        };
      });
  }
  /** A conversation's transcript, found from the workspace it ran in. */
  transcript(
    conversation: Conversation,
    workspace: string,
    working: boolean,
    signal: AbortSignal,
  ) {
    return readTranscript(this.spawn, workspace, conversation, working, signal);
  }
  /** The agent's latest session for a conversation that another build of the
   * app started, found in the workspace's Claude Code history. */
  async find(
    pubkey: string,
    place: Readonly<{ channelId: string; root?: string }>,
    workspace: string,
    signal: AbortSignal,
  ): Promise<SavedConversation | undefined> {
    const transcript = await readTranscript(
      this.spawn,
      workspace,
      { agent: pubkey, ...place },
      false,
      signal,
    );
    const last = transcript?.turns.at(-1);
    if (!last?.sessionId) return undefined;
    const name = this.reads(pubkey)?.channelName(place.channelId);
    return {
      key: place.root ? `${place.channelId}/${place.root}` : place.channelId,
      agent: pubkey,
      sessionId: last.sessionId,
      ...place,
      ...(name ? { name } : {}),
      at: last.endedAt ?? last.startedAt,
    };
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify() {
    this.views.clear();
    for (const listener of this.listeners) listener();
  }

  dispose() {
    this.spare.dispose();
    for (const entry of this.agents.values()) {
      entry.lanes.stop();
      entry.sessions.dispose();
    }
    this.agents.clear();
  }

  async run({
    trigger,
    agent,
    config: raw,
    channelId,
    model,
    effort,
    team,
    workingUntil,
    ignored,
    signal,
    step,
    acknowledged,
    superseded,
    current,
  }: Delivery) {
    const settings = this.resolveConfig(raw);
    // Claude runs commands as you; mentions need owner or delegated authority.
    // A watch is the agent's own attention: its event is observed data,
    // framed as such, from anyone.
    if (trigger.type === "mention") {
      if (
        !(await fromOwner(
          trigger.event,
          agent.owner,
          workflowOf(this.reads(agent.pubkey), agent.pubkey),
        ))
      ) {
        ignored?.();
        return;
      }
      signal.throwIfAborted();
    }
    const entry = this.entry(agent.pubkey, settings, agent.attention.enabled());
    entry.handle = agent;
    entry.team = team ?? "";
    if (trigger.type !== "mention") {
      workingUntil(this.wake(entry, agent, trigger, current));
      return;
    }
    const { event } = trigger;
    const channel =
      channelId ?? event.tags.find((tag) => tag[0] === "h")?.[1] ?? undefined;
    if (!channel) return;
    const topLevel =
      (await this.reads(agent.pubkey)?.meChat(agent.owner, channel, signal)) ??
      false;
    // Frozen with the policy: a scope change while this waits must not move
    // its prompt to another conversation than the one it is delivered to.
    const key = await this.key(entry, agent.pubkey, event, channel, topLevel);
    // `fresh` is for a session that has been shown nothing yet.
    const prompt = async (fresh: boolean) =>
      this.review(
        entry,
        turnPrompt({
          ...(await this.turn(
            entry,
            agent.pubkey,
            event,
            channel,
            key,
            topLevel,
            fresh,
          )),
          agent: agent.pubkey,
          label: "@mention",
        }),
      );
    // A turn keeps the posting policy it was admitted with: a request under
    // the other policy waits for the conversation's turns to settle rather
    // than steering into them and changing their tools' context.
    const prior = entry.policies.get(key);
    const same = prior?.topLevel === topLevel;
    const wait = prior && (same ? prior.handed : prior.settled);
    let delivered!: Promise<Settled>;
    const handed = (async () => {
      await wait;
      const text = await prompt(false);
      // A conversation's tools default to its thread; a session shared by
      // several threads is told which to reply in instead.
      entry.contexts.set(
        key,
        topLevel
          ? { channel, topLevel }
          : key === channel
            ? { channel }
            : { channel, root: threadReference(event)?.rootId ?? event.id },
      );
      delivered = entry.sessions.deliver(key, text, event.created_at, {
        steer: steerPrompt(text),
        fresh: () => prompt(true),
        activityScope: topLevel
          ? channel
          : (threadReference(event)?.rootId ?? event.id),
        ...(step ? { step } : {}),
        ...(acknowledged ? { acknowledged } : {}),
        ...(superseded ? { superseded } : {}),
        pick: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
      });
    })();
    const done = handed.then(
      () => delivered,
      (error: unknown): Settled => ({ ok: false, error: String(error) }),
    );
    const policy = {
      topLevel,
      handed: handed.catch(() => undefined),
      settled: Promise.all([same ? prior.settled : undefined, done]).then(
        () => undefined,
      ),
    };
    entry.policies.set(key, policy);
    void policy.settled.then(() => {
      if (entry.policies.get(key) === policy) entry.policies.delete(key);
    });
    // Deliveries keep their order: a later one waits on this handover, and
    // one with nothing to wait for is handed over before `run` returns.
    if (!wait) await handed;
    // The turn outlives `run`, which the host is told so it shows it as working.
    workingUntil(done);
    this.notify();
    this.watch(done, async (error) => {
      if (error) await this.report(agent, channel, event, error, topLevel);
    });
  }

  /** A watch or timer wake: a one-off turn in its Interest's lane, as in
   * Janet. It joins no conversation, and nothing about it is saved. The host
   * says whether it is still `current`, asked when its lane starts it and
   * again once it has a process: a wake whose watch or timer was disabled or
   * removed, whose watch changed or no longer matches, or whose agent's
   * attention went off, while it waited does not run. Its prompt is built
   * then, from the attention as it is. */
  private wake(
    entry: Entry,
    agent: AgentHandle,
    trigger: Exclude<Delivery["trigger"], { type: "mention" }>,
    current: () => boolean,
  ): Promise<Settled> {
    const { slug } = trigger;
    const id = slug.replace(/^watch\//, "");
    const lane = (trigger.type === "watch" ? trigger.watch : trigger.timer)
      .interest_id;
    let settle!: (result: Settled) => void;
    const settled = new Promise<Settled>((resolve) => {
      settle = resolve;
    });
    const dropped = (why: string) => {
      console.warn(`Claude dropped a ${trigger.type} turn: ${why}`);
      settle({ ok: true });
    };
    const queued = entry.lanes.add(
      lane,
      async () => {
        try {
          if (!current()) return settle({ ok: true });
          const done = entry.sessions.runOnce(`${trigger.type}/${id}`, () =>
            this.wakePrompt(agent, trigger, id, current),
          );
          this.notify();
          const result = await done;
          this.notify();
          if (!result.ok)
            console.warn(
              `Claude ${trigger.type} turn failed: ${id}`,
              result.error,
            );
          settle(result);
        } finally {
          // Settled already, unless something above threw.
          settle({ ok: false, error: "The turn failed" });
        }
      },
      () => dropped("attention was turned off or the agent stopped"),
    );
    if (queued !== "queued")
      dropped(
        queued === "full"
          ? `too many are waiting (Interest ${lane})`
          : "the agent stopped",
      );
    return settled;
  }

  /** The prompt for a wake as its watch now is, or undefined when it should
   * no longer run. */
  private async wakePrompt(
    agent: AgentHandle,
    trigger: Exclude<Delivery["trigger"], { type: "mention" }>,
    id: string,
    stillCurrent: () => boolean,
  ) {
    const { attention } = agent;
    if (!stillCurrent()) return undefined;
    const current = (await attention.show(trigger.slug)).object;
    const type = trigger.type === "watch" ? "event" : "timer";
    if (!current || current.type !== type) return undefined;
    const interest = (await attention.show(`interest/${current.interest_id}`))
      .object;
    const instructions =
      interest?.type === "interest"
        ? { instructions: interest.instructions }
        : {};
    const text =
      trigger.type === "watch"
        ? watchPrompt({
            id,
            interest: current.interest_id,
            ...instructions,
            event: trigger.event,
            ...(trigger.classifier ? { classifier: trigger.classifier } : {}),
          })
        : timerPrompt({
            id,
            interest: current.interest_id,
            prompt: current.type === "timer" ? current.prompt : "",
            ...instructions,
            spent: trigger.spent,
          });
    // Asked again: the attention can change while it is read.
    return stillCurrent() ? `${text}\n\n${ATTENTION_REVIEW}` : undefined;
  }

  /** `text` with Janet's end-of-turn attention review, when attention is on. */
  private review(entry: Entry, text: string) {
    return entry.attention ? `${text}\n\n${ATTENTION_REVIEW}` : text;
  }

  private watch(
    done: Promise<{ ok: boolean; error?: string }>,
    after: (error?: string) => unknown,
  ) {
    void done
      .then((result) => after(result.ok ? undefined : result.error))
      .catch((error) => console.warn("Claude turn failed", error))
      .finally(() => this.notify());
  }

  /** Says in the thread that a turn failed, so nobody waits on it. Tells the
   * owner even when a sibling asked: tagging the sibling would wake it, and two
   * agents failing alike would wake each other without end. */
  private report(
    agent: AgentHandle,
    channel: string,
    event: EventData,
    error: string,
    topLevel: boolean,
  ) {
    return agent
      .publish({
        kind: 9,
        content: `⚠️ I couldn't finish that: ${error.slice(0, 500)}`,
        tags: [
          ["h", channel],
          ...(topLevel
            ? []
            : [["e", threadReference(event)?.rootId ?? event.id, "", "reply"]]),
          ["p", agent.owner],
        ],
      })
      .catch((failure) =>
        console.warn("Claude could not report a failed turn", failure),
      );
  }

  /** The conversation the event's turn goes to: a Me chat or DM is one
   * conversation, as is a channel for an agent with channel scope. */
  private async key(
    entry: Entry,
    self: string,
    event: EventData,
    channelId: string,
    topLevel: boolean,
  ) {
    const summary = await this.reads(self)?.channel(channelId);
    return topLevel || summary?.dm === true || entry.config.scope === "channel"
      ? channelId
      : `${channelId}/${threadReference(event)?.rootId ?? event.id}`;
  }

  /** Where the event's turn goes, and what its prompt needs. */
  private async turn(
    entry: Entry,
    self: string,
    event: EventData,
    channelId: string,
    key: string,
    topLevel: boolean,
    fresh = false,
  ) {
    const reads = this.reads(self);
    const summary = await reads?.channel(channelId);
    const dm = summary?.dm === true;
    const thread = threadReference(event);
    const rootId = thread?.rootId ?? event.id;
    // The conversation it was admitted to, not the scope as it is now.
    const scope: Scope = key === channelId ? "channel" : "thread";
    const seen = fresh ? 0 : entry.sessions.seen(key);
    let earlier: readonly EventData[] = [];
    if (reads && (thread || dm || topLevel))
      try {
        const events = await reads.read(
          thread && !topLevel
            ? [
                { ids: [rootId], limit: 1 },
                { kinds: CHAT, "#h": [channelId], "#e": [rootId], limit: 200 },
              ]
            : [{ kinds: CHAT, "#h": [channelId], limit: CONTEXT_LIMIT + 1 }],
          AbortSignal.timeout(NAMES_TIMEOUT_MS * 2),
        );
        earlier = events
          .filter(
            (item) =>
              CHAT.includes(item.kind) &&
              item.id !== event.id &&
              item.created_at <= event.created_at,
          )
          .sort((a, b) => a.created_at - b.created_at);
      } catch (error) {
        console.warn("Claude could not read the conversation", error);
      }
    // A session already has its own replies; a new one is shown them too.
    const unseen = earlier.filter(
      (item) => item.created_at > seen && (!seen || item.pubkey !== self),
    );
    const pubkeys = [
      ...new Set([
        event.pubkey,
        ...unseen.map((item) => item.pubkey),
        ...event.tags
          .filter((tag) => tag[0] === "p")
          .map((tag) => tag[1] ?? ""),
      ]),
    ].filter(Boolean);
    if (reads)
      await Promise.race([
        reads.profiles(pubkeys).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, NAMES_TIMEOUT_MS)),
      ]);
    const members = summary?.members ?? [];
    return {
      key,
      event,
      scope,
      topLevel,
      channel: {
        id: channelId,
        ...(summary?.name ? { name: summary.name } : {}),
        dm,
      },
      ...(thread ? { thread } : {}),
      context: unseen,
      total: earlier.length + 1,
      name: (pubkey: string) => reads?.name(pubkey, members),
    };
  }

  private entry(pubkey: string, initial: Config, attention: boolean): Entry {
    const existing = this.agents.get(pubkey);
    if (existing) return existing;
    const entry: Entry = {
      config: initial,
      team: "",
      attention,
      lanes: new Lanes(),
      sessions: undefined as unknown as AgentSessions,
      contexts: new Map(),
      policies: new Map(),
    };
    // Each process reads files where it was started, and keeps the tool list
    // it was given, until it is replaced.
    const tools =
      (cwd: string, attention: boolean): ToolServer =>
      async (conversation, message) => {
        const handle = entry.handle;
        const client =
          handle &&
          appClient(handle, {
            spawn: this.spawn,
            cwd,
            memories: async () => (await this.memories(pubkey)).entries,
            remembered: () => this.forget(pubkey),
          });
        const context =
          (conversation && entry.contexts.get(conversation)) || {};
        return respond(client, context, message, {
          offered: attention,
          ...(handle ? { api: handle.attention } : {}),
        });
      };
    entry.sessions = new AgentSessions({
      spawn: (id, options) => this.spawn(id, options),
      spare: this.spare,
      store: localSessions(this.storage, pubkey),
      onChange: () => this.notify(),
      fingerprint: () =>
        JSON.stringify([
          entry.config.model,
          entry.config.workspace,
          entry.config.instructions,
          entry.config.scope,
          entry.team,
          entry.name,
          entry.attention,
        ]),
      launch: async () => {
        const { workspace, instructions, scope } = entry.config;
        const { attention } = entry;
        const memory = await this.core(pubkey);
        return {
          ...where(entry.config),
          tools: tools(workspace, attention),
          systemPrompt: systemPrompt({
            scope,
            cwd: workspace,
            ...(entry.name ? { agent: { name: entry.name, pubkey } } : {}),
            instructions,
            team: entry.team,
            attention,
            ...(memory === undefined ? {} : { memory }),
          }),
        };
      },
    });
    this.agents.set(pubkey, entry);
    return entry;
  }

  /** The agent's memory, as its community's reads give it. */
  private memories(pubkey: string) {
    const reads = this.reads(pubkey);
    if (!reads) return Promise.reject(new Error("Buzz is not connected"));
    return this.memoryReads.read(
      reads,
      pubkey,
      AbortSignal.timeout(MEMORY_TIMEOUT_MS),
    );
  }
  /** The agent's `core` memory for a new session's prompt: its text, `null`
   * when it has none, or undefined when it could not be read, so the session
   * starts without it. */
  private async core(pubkey: string) {
    try {
      return coreOf(await this.memories(pubkey));
    } catch (error) {
      console.warn("Claude could not read the agent's memory", error);
      return undefined;
    }
  }
  private forget(pubkey: string) {
    const reads = this.reads(pubkey);
    if (reads) this.memoryReads.forget(reads.connection, pubkey);
  }
}

/** `claude-opus-5-5` reads as `Opus 5.5`, and an alias such as `opus` as
 * `Opus`. Anything else is shown as it is. */
export function modelName(model: string) {
  const id =
    /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[.*\])?$/.exec(model);
  const family = id?.[1] ?? (/^[a-z]+$/.test(model) ? model : undefined);
  if (!family) return model;
  const name = family[0]?.toUpperCase() + family.slice(1);
  return id ? `${name} ${id[2]}${id[3] ? `.${id[3]}` : ""}` : name;
}
