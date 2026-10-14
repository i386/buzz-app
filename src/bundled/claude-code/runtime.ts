// Turns Agents deliveries into Claude turns. Each agent of this type has its
// own sessions; a delivery becomes a prompt in the harness format, sent to the
// session for its conversation; a watch or timer wake runs as a one-off turn in
// a new session, in its Interest's lane. The run returns once the turn is handed over,
// so one agent works in several conversations at once. Claude acts in Buzz with
// the in-process Buzz tools, signed by the agent's native-held key; the runtime
// only reports a turn that fails.
import type { Context } from "../../buzz-mcp/client";
import { respond } from "../../buzz-mcp/rpc";
import {
  fromOwner,
  type Agent,
  type AgentHandle,
  type Delivery,
  type Effort,
  type Models,
} from "../../features/agents/service";
import { meChat } from "../../features/agents/me-chat";
import type { Host } from "../../features/host/service";
import type { EventData } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { threadReference } from "../../features/relay/thread-reference";
import type { Settled, Spawn, ToolServer } from "./claude";
import { appClient } from "../../buzz-mcp/app-client";
import { ATTENTION_REVIEW } from "../../buzz-mcp/attention-prompt";
import { coreOf, MemoryReads } from "../../features/agent-harness/core-memory";
import { Lanes } from "../../features/agents/lanes";
import { wake } from "../../features/agents/wakes";
import {
  CONTEXT_LIMIT,
  type Scope,
  steerPrompt,
  systemPrompt,
  turnPrompt,
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
    /** The owner's connection to each agent's own community. */
    private readonly relay: (pubkey: string) => RelayData | undefined,
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
    const snapshot = this.relay(pubkey)?.snapshot();
    const channels =
      snapshot?.status === "ready"
        ? snapshot.session.channels.list().channels
        : [];
    return localSessions(this.storage, pubkey)
      .list()
      .map(([key, saved]) => {
        const [channelId = key, root] = key.split("/");
        const name = channels.find((row) => row.id === channelId)?.name;
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
    const name = this.channelName(pubkey, place.channelId);
    return {
      key: place.root ? `${place.channelId}/${place.root}` : place.channelId,
      agent: pubkey,
      sessionId: last.sessionId,
      ...place,
      ...(name ? { name } : {}),
      at: last.endedAt ?? last.startedAt,
    };
  }
  private channelName(pubkey: string, channelId: string) {
    const snapshot = this.relay(pubkey)?.snapshot();
    return snapshot?.status === "ready"
      ? snapshot.session.channels
          .list()
          .channels.find((row) => row.id === channelId)?.name
      : undefined;
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
      const snapshot = this.relay(agent.pubkey)?.snapshot();
      if (
        !(await fromOwner(trigger.event, agent.owner, {
          agent: agent.pubkey,
          authority:
            snapshot?.status === "ready"
              ? snapshot.session.workflowAuthority
              : undefined,
          profiles:
            snapshot?.status === "ready"
              ? snapshot.session.profiles
              : undefined,
        }))
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
      workingUntil(
        wake(
          entry.lanes,
          agent,
          trigger,
          current,
          (key, text) => {
            const done = entry.sessions.runOnce(key, text);
            this.notify();
            return done.finally(() => this.notify());
          },
          "Claude",
        ),
      );
      return;
    }
    const { event } = trigger;
    const channel =
      channelId ?? event.tags.find((tag) => tag[0] === "h")?.[1] ?? undefined;
    if (!channel) return;
    const topLevel = await meChat(
      () => this.relay(agent.pubkey),
      agent.owner,
      channel,
      signal,
    );
    // Frozen with the policy: a scope change while this waits must not move
    // its prompt to another conversation than the one it is delivered to.
    const key = this.key(entry, agent.pubkey, event, channel, topLevel);
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
  private key(
    entry: Entry,
    self: string,
    event: EventData,
    channelId: string,
    topLevel: boolean,
  ) {
    const summary = this.summary(self, channelId);
    return topLevel ||
      summary?.channelType === "dm" ||
      entry.config.scope === "channel"
      ? channelId
      : `${channelId}/${threadReference(event)?.rootId ?? event.id}`;
  }
  private summary(self: string, channelId: string) {
    const snapshot = this.relay(self)?.snapshot();
    const session = snapshot?.status === "ready" ? snapshot.session : undefined;
    return (
      session?.channels.list().channels.find((item) => item.id === channelId) ??
      session?.channels.get?.(channelId)
    );
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
    const snapshot = this.relay(self)?.snapshot();
    const session = snapshot?.status === "ready" ? snapshot.session : undefined;
    const summary = this.summary(self, channelId);
    const dm = summary?.channelType === "dm";
    const thread = threadReference(event);
    const rootId = thread?.rootId ?? event.id;
    // The conversation it was admitted to, not the scope as it is now.
    const scope: Scope = key === channelId ? "channel" : "thread";
    const seen = fresh ? 0 : entry.sessions.seen(key);
    let earlier: readonly EventData[] = [];
    if (session && (thread || dm || topLevel))
      try {
        const events = await session.read(
          thread && !topLevel
            ? [
                { ids: [rootId], limit: 1 },
                { kinds: CHAT, "#h": [channelId], "#e": [rootId], limit: 200 },
              ]
            : [{ kinds: CHAT, "#h": [channelId], limit: CONTEXT_LIMIT + 1 }],
          { signal: AbortSignal.timeout(NAMES_TIMEOUT_MS * 2) },
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
    if (session)
      await Promise.race([
        session.profiles.ensure(pubkeys, "foreground").catch(() => undefined),
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
      name: (pubkey: string) =>
        session?.names.resolve(pubkey, undefined, members) ??
        session?.profiles.snapshot().get(pubkey)?.name ??
        undefined,
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

  /** The agent's memory, read back through the owner's session. */
  private memories(pubkey: string) {
    const snapshot = this.relay(pubkey)?.snapshot();
    if (snapshot?.status !== "ready")
      return Promise.reject(new Error("Buzz is not connected"));
    return this.memoryReads.read(
      snapshot.session,
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
    const snapshot = this.relay(pubkey)?.snapshot();
    if (snapshot?.status === "ready")
      this.memoryReads.forget(snapshot.session, pubkey);
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
