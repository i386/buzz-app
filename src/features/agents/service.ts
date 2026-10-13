import {
  createLocalAgentActivity,
  type LocalAgentActivity,
  type WorkOutcome,
} from "./local-activity";
import { threadReference } from "../relay/thread-reference";
// Agents: agents that are plugins from the start. A plugin registers an agent
// type (its summary line, peek view, settings tabs and `run`); each agent made
// from it has its own native-held key, an `agent-attention/v1` configuration the
// app owns and the agent edits through its handle, and a config blob the type
// owns. The app delivers matching live events to
// `run` from the stream the owner already receives in the agent's community,
// selected or not, so no plugin opens a socket or a REQ.
//
// A hosted type's provider holds the key and runs the agent instead. The app
// creates it through the type's `remote` steps and signs only the owner's
// attestation. Every agent of either kind is listed in the owner's kind 30177
// records with its type as the `runtime` tag, so every device of the owner's
// can show it: as here, hosted, or on another device.
import { migrateAgentStorage } from "./migrate-storage";
import { Service, type Context } from "@deepseek-ai/cordis";
import { npubEncode } from "nostr-tools/nip19";
import type { ComponentType } from "react";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";
import type { LocalAgentsSnapshot } from "./local";
import { attestedOwner } from "./owner-attestation";
import {
  deleteAgentRecord,
  publishAgentRecord,
  type AgentRecordBody,
  removeAgentFromChannels,
  removeRelayAgent,
} from "./relay-removal";
import { communityDestination, relayOrigin } from "../communities/destination";
import type { Communities } from "../communities/service";
import {
  prepareRemoteAgentAuthorization,
  type NipOaAuthorization,
} from "../host/service";
import { avatarSource } from "../../shared/avatar-source";
import { newer, type EventData, type RelayEvent } from "../relay/events";
import { EFFORT_TAG, MODEL_TAG } from "../relay/messages";
import type { LiveBatch } from "../relay/incoming";
import { LIVE_REPLAY_LIMIT } from "../relay/live";
import { relayPartition } from "../relay/partition";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import {
  addressedTo,
  CHAT_KINDS,
  compileFilter,
  parseSlug,
  tagsAgent,
  watchMatches,
  type AttentionObject,
  type AttentionValue,
  timerSpent,
  timerState,
  type EventWatch,
  type Interest,
  type TimerState,
  type TimerWatch,
} from "./attention";
import {
  AttentionError,
  checkedWrite,
  interestIds,
  show,
  watchSummaries,
  type ClassifierAvailability,
  type ClassifierKey,
  type Shown,
  type WatchFilter,
  type WatchSummary,
  type WriteOptions,
} from "./attention-objects";
import {
  classify,
  excerpt,
  mentionFacts,
  nativeClassifier,
  notRun,
  type ClassifierContext,
  type ClassifierNative,
  type ClassifierOutcome,
} from "./classifier";
import {
  nativeAgents,
  type AgentEventTemplate,
  type AgentIdentity,
  type Carry,
  type AgentsNative,
  type AgentUpload,
  type PortableAgents,
  type PortSource,
} from "./native";
import {
  readRecords,
  readTeams,
  readUnfinished,
  setAttention,
  writeRecords,
  writeTeams,
  writeUnfinished,
  type AgentRecord,
  type SkippedObject,
  type Team,
  type Unfinished,
} from "./store";
// STOPGAP(agent-local-typing): delete with local-typing.ts.
import { typeLocally } from "./local-typing";

/** Where an agent runs: `here`, with its key on this device; `hosted`, by its
 * type's provider; or `elsewhere`, on another of the owner's devices. Only an
 * agent here has attention, timers and config; the others never run here. */
export type AgentPlace = "here" | "hosted" | "elsewhere";
/** One of the viewer's agents, in the community at `relay`. */
export type Agent<Config = unknown> = Readonly<{
  pubkey: string;
  name: string;
  picture?: string;
  /** The agent type's key, `pluginId/typeId`. */
  type: string;
  owner: string;
  relay: string;
  place: AgentPlace;
  /** A hosted agent its provider made whose setup has not finished; `finish`
   * continues it. */
  unfinished?: true;
  attention: Readonly<Record<string, AttentionObject>>;
  /** Stored attention objects that are invalid or over a limit, by slug. */
  skipped: Readonly<Record<string, SkippedObject>>;
  /** Run state of its timers, by slug; written only by the runtime. */
  timers: Readonly<Record<string, TimerState>>;
  /** Whether its watches and timers wake it. Off keeps every object. */
  attentionEnabled: boolean;
  config: Config;
}>;
export type AgentChange<Config = unknown> = Readonly<{
  name?: string;
  /** An HTTPS image URL; `null` or empty removes the picture. */
  picture?: string | null;
  config?: Config;
  attentionEnabled?: boolean;
  /** Slug to new value; `null` deletes the object. */
  attention?: Readonly<Record<string, AttentionValue | null>>;
  /** Timers in `attention` to start over: a new schedule from their
   * `armed_at`, with no occurrences used. */
  restart?: readonly string[];
}>;
/** What a type's read-only peek receives. */
export type AgentPeekProps<Config = unknown> = { agent: Agent<Config> };
/** What each of a type's settings tabs receives. A type writes only its own
 * config; the app owns the name and attention. */
export type AgentViewProps<Config = unknown> = {
  agent: Agent<Config>;
  /** Replaces the type's whole config. Spread `agent.config` to change one
   * field, or tabs that each save a part will erase each other's fields. A
   * hosted type's tabs save to its provider instead; for them this rejects. */
  save(config: Config): Promise<void>;
};
/** What a type's part of the New agent dialog receives: the new agent's
 * starting config, from `defaults`, to fill in. The app owns its key, name and
 * picture around it. */
export type AgentCreateProps<Config = unknown> = {
  config: Config;
  onChange(config: Config): void;
  disabled: boolean;
};
export type AgentTab<Config = unknown> = Readonly<{
  id: string;
  title: string;
  component: ComponentType<AgentViewProps<Config>>;
}>;
/** The agent as `run` holds it. It works for as long as the agent exists. */
export type AgentHandle = Readonly<{
  pubkey: string;
  name: string;
  owner: string;
  publish(event: AgentEventTemplate): Promise<RelayEvent>;
  /** Reads the community as the agent, seeing only what it may see. */
  query(filters: readonly object[]): Promise<RelayEvent[]>;
  /** Uploads base64 `data`, an image or MP4 video, as the agent. */
  upload(data: string, mime: string): Promise<AgentUpload>;
  /** Downloads one of its community's media blobs, by URL or `sha256[.ext]`,
   * as base64. */
  media(url: string): Promise<string>;
  /** Writes memory entry `slug`, newer than the entry it replaces (`after`,
   * that entry's `createdAt`, or 0). The owner reads it back. */
  remember(slug: string, body: string, after: number): Promise<RelayEvent>;
  /** The agent's own attention, one object at a time. */
  attention: AgentAttention;
}>;
/** What an agent reads and writes of its attention. Every read is current,
 * so a long run sees the owner's switch and the classifier's state change. */
export type AgentAttention = Readonly<{
  /** False when the owner turned attention off: none of its objects wakes the
   * agent. The handle still reads and writes them; the attention tools refuse
   * every call while it is off. */
  enabled(): boolean;
  /** Whether a watch's classifier can run now. Classifiers can be saved
   * either way; one that cannot run lets every event pass. */
  classifier(): ClassifierAvailability;
  /** One object and its expected-state token. `interest` scopes the read:
   * an object of another Interest is `wrong-scope`. */
  show(slug: string, interest?: string): Promise<Shown>;
  interests(search?: string): readonly string[];
  watches(filter?: WatchFilter): readonly WatchSummary[];
  /** Replaces, or with `null` removes, one object; returns it as shown after
   * the write. Throws an AttentionError when refused. */
  write(
    slug: string,
    value: AttentionValue | null,
    options: WriteOptions,
  ): Promise<Shown>;
}>;
export type { ClassifierOutcome } from "./classifier";
export type Trigger =
  /** Directly addressed: a chat message that mentions the agent. */
  | Readonly<{ type: "mention"; event: RelayEvent }>
  /** One matching watch; an event that matches several runs once for each. */
  | Readonly<{
      type: "watch";
      event: RelayEvent;
      slug: string;
      watch: EventWatch;
      /** Absent when the watch names an Interest that does not exist. */
      interest?: Interest;
      /** Set when the watch has a classifier: its answers, or why it did
       * not run or failed. An event the classifier cannot check passes
       * rather than lose a match, and the agent is told why. */
      classifier?: ClassifierOutcome;
    }>
  | Readonly<{
      type: "timer";
      slug: string;
      timer: TimerWatch;
      /** Absent when the timer names an Interest that does not exist. */
      interest?: Interest;
      /** This is its last allowed occurrence. */
      spent: boolean;
    }>;
export type Delivery<Config = unknown> = Readonly<{
  trigger: Trigger;
  /** The live route's channel; absent when the wire scope was ambiguous. */
  channelId?: string;
  agent: AgentHandle;
  /** The agent's config when this run started. */
  config: Config;
  /** The model the owner asked for in the triggering message: one of the
   * type's `models`. Absent means the agent's own model. */
  model?: string;
  /** The effort level the owner asked for in the triggering message: one of
   * that model's `efforts`. Absent means the agent's own default. */
  effort?: string;
  /** A section for each team the agent is on, with the team's name, roster and
   * instructions, to follow the agent's own instructions. Absent without one. */
  team?: string;
  /** Aborts on the run's deadline, or when the agent is removed or its type is
   * replaced. Advisory: the handle keeps working, so finishing up is harmless. */
  signal: AbortSignal;
  /** Keeps the run counted as working after `run` returns, until `done`
   * settles, for a type that hands its work off and returns early. */
  workingUntil(done: PromiseLike<unknown>): void;
  /** Optional presentation evidence supplied by the harness, not inferred by the UI. */
  step?(tool: string, target?: string): void;
  /** The plugin declined this request; no work or successful outcome is implied. */
  ignored?(): void;
  /** The harness acknowledged this exact request. Not proof of model consumption. */
  acknowledged?(): void;
  /** A newer acknowledged request owns this turn's activity; hide this message's
   * bubble without claiming success or changing the execution outcome. */
  superseded?(): void;
  /** Whether the trigger should still run, asked again now. False once the
   * agent is removed or its type replaced; for a watch or timer, also once
   * attention was turned off or its object disabled or removed; and for a
   * watch, once it was changed or its event no longer matches. A type that queues a
   * watch's or timer's work asks before it starts that work. */
  current(): boolean;
}>;
export type Effort = Readonly<{ id: string; label: string }>;
/** A model with its effort levels, lowest first. */
export type Model = Readonly<{
  id: string;
  label: string;
  efforts: readonly Effort[];
  /** The effort a run on it uses without a pick, when known. */
  effort?: string;
}>;
/** The models an owner can pick from, and the id of the one used without a pick. */
export type Models = Readonly<{ current: string; models: readonly Model[] }>;
export type AgentType<Config = unknown> = {
  id: string;
  title: string;
  description?: string;
  /** A new agent's starting config and attention objects. */
  defaults(): Readonly<{
    config: Config;
    attention?: Readonly<Record<string, AttentionValue>>;
  }>;
  /** A brought-over agent's config: `config` from `defaults` with whatever of
   * `carry` the type has a place for. Without it, all of `carry` stays behind. */
  adopt?(carry: Carry, config: Config): Config;
  /** One short line under the agent's name, e.g. its model; defaults to the title. */
  summary?(agent: Agent<Config>): string;
  /** A read-only glance shown when the agent is selected in the grid. */
  Peek?: ComponentType<AgentPeekProps<Config>>;
  /** The type's choices in the New agent dialog, such as model and
   * instructions; the new agent starts with the config it settles on. */
  Create?: ComponentType<AgentCreateProps<Config>>;
  /** The type's settings tabs, in order. The host adds Attention after them. */
  tabs?: readonly AgentTab<Config>[];
  /** Models and effort levels the owner can pick for the next run while
   * mentioning the agent. Discovery may be async but must not start a turn.
   * The picks reach that run as `Delivery.model` and `Delivery.effort`. */
  models?(agent: Agent<Config>): Models | Promise<Models>;
  run?(delivery: Delivery<Config>): void | Promise<void>;
  /** Per-run deadline in milliseconds, up to 30 minutes; defaults to 60 seconds. */
  timeoutMs?: number;
  /** Makes the type hosted: its provider runs each agent, so it has no `run`,
   * `models` or `timeoutMs`, and its agents have no attention. */
  remote?: RemoteAgentType;
};
/** A hosted type's provider: it holds each agent's key and runs it. The app
 * calls these in order to create one (`provision`, then `activate`) and owns
 * the owner's agent list; every step is asked again after a failure, so each
 * must be safe to repeat. `community` is the agent's `wss://` community. */
export type RemoteAgentType = Readonly<{
  /** Makes the agent and resolves with its pubkey. Not yet its owner's. */
  provision(
    input: Readonly<{ name: string; community: string; signal: AbortSignal }>,
  ): Promise<Readonly<{ pubkey: string }>>;
  /** Hands over the owner's attestation (NIP-OA), which the agent attaches to
   * what it signs. The provider publishes its profile and starts it. */
  activate(
    input: Readonly<{
      pubkey: string;
      name: string;
      community: string;
      auth: NipOaAuthorization;
      signal: AbortSignal;
    }>,
  ): Promise<void>;
  /** Publishes its profile with this name and picture (an HTTPS image URL). */
  profile(
    input: Readonly<{
      pubkey: string;
      community: string;
      name: string;
      picture?: string;
      signal: AbortSignal;
    }>,
  ): Promise<void>;
  /** Stops it and deletes its key. An agent already gone counts as removed. */
  remove(
    input: Readonly<{ pubkey: string; community: string; signal: AbortSignal }>,
  ): Promise<void>;
}>;
export type RegisteredAgentType = Contribution<AgentType>;
export type AgentsSnapshot = Readonly<{
  status: "unavailable" | "loading" | "ready" | "error";
  /** Whether a watch's classifier can run on this device now. */
  classifier: ClassifierAvailability;
  /** What is known about the saved classifier key, for the owner. */
  classifierKey: ClassifierKey;
  /** The selected community's agents, while it is connected. */
  agents: readonly Agent[];
  /** Every agent kept running here, whichever community is selected: the
   * viewer's agents in each joined community not disconnected. */
  running: readonly Agent[];
  /** The owner's teams on this device, in any community. */
  teams: readonly Team[];
  error?: string;
}>;
export type { Carry, Team };
export type TeamChange = Omit<Team, "id"> & Readonly<{ id?: string }>;
/** What `port` imports: an identity an earlier agent system saved on this
 * machine, or an agent a community member shared. */
export type PortInput = Readonly<
  | { source: PortSource; pubkey: string; type: string }
  | {
      source: "shared";
      type: string;
      name: string;
      /** An HTTPS image URL. */
      picture?: string;
      instructions?: string;
    }
>;
export type NewAgent = Readonly<{
  type: string;
  name: string;
  /** An HTTPS image URL. */
  picture?: string;
  /** Its starting config, from the type's `Create`; else the type's defaults.
   * A hosted type's settings are its provider's, so it has none here. */
  config?: unknown;
}>;
export type Agents = {
  register<Config>(type: AgentType<Config>): void;
  types(): readonly RegisteredAgentType[];
  snapshot(): AgentsSnapshot;
  subscribe(listener: () => void): () => void;
  /** The agent of this pubkey in the selected community, if it is an agent. */
  find(pubkey: string): Agent | undefined;
  /** The owner's connection to a running agent's community, which need not be
   * the selected one: read the agent's conversations through this. */
  relay(pubkey: string): RelayData | undefined;
  /** Makes an agent of `type` in the selected community: here, or with a
   * hosted type at its provider. A hosted one whose setup then fails is kept
   * as `unfinished`. */
  create(input: NewAgent): Promise<Agent>;
  /** Continues an unfinished hosted agent's setup. */
  finish(pubkey: string): Promise<Agent>;
  /** Identities earlier agent systems saved on this machine that are not
   * Agents yet. */
  portable(): Promise<PortableAgents>;
  /** Imports one as an agent of `type` in the selected community: an identity
   * from `portable` keeps its key, name and picture, and a shared agent gets a
   * new key with its name and picture. Either keeps whatever of its
   * instructions and workspace the type adopts; its other settings stay behind. */
  port(input: PortInput): Promise<Agent>;
  save(pubkey: string, change: AgentChange): Promise<void>;
  /** Deletes its key at once. Leaving its channels and archiving it follow in
   * the background whenever its community is open. A hosted agent is archived,
   * leaves its channels and is removed from its provider before this resolves.
   * One on another device is deleted there. */
  remove(pubkey: string): Promise<void>;
  /** Whether a watch's classifier can run on this device now. */
  classifier(): ClassifierAvailability;
  /** Saves the TypeSafe key in native storage, which the classifier uses.
   * It is never read back into the app or given to an agent. */
  setClassifierKey(key: string): Promise<void>;
  clearClassifierKey(): Promise<void>;
  /** Creates a team, or replaces the one with `id`. Members must be agents on
   * this device. */
  saveTeam(team: TeamChange): Promise<Team>;
  /** Deletes the team; its agents are untouched. */
  removeTeam(id: string): Promise<void>;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    agents: Agents;
  }
}

const QUEUE_LIMIT = 32;
/** The spec asks for at least the agent's 2,048 most recent events. */
const SEEN_LIMIT = 2_048;
/** Watched events each agent keeps while their channel's roster is only the one
 * saved on disk, until the relay confirms it. */
const HELD_LIMIT = 256;
/** Bounds one cleanup attempt, whose relay steps otherwise wait on the outbox. */
const CLEANUP_TIMEOUT_MS = 60_000;
/** Runs per agent per minute; bounds two agents that answer each other. */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const TIMEOUT_LIMIT_MS = 30 * 60_000;
const TIMER_TICK_MS = 5_000;
/** How often a failed connection to an unselected community is tried again. */
const RETRY_MS = 30_000;
const EMPTY = Object.freeze({});
const blank = (pubkey: string): AgentRecord => ({
  pubkey,
  attention: EMPTY,
  config: undefined,
});
/** A new agent's settings: its type's defaults. */
function defaults(pubkey: string, type: RegisteredAgentType) {
  const { config, attention = {} } = type.defaults();
  let record: AgentRecord = { pubkey, attention: {}, config };
  for (const [slug, value] of Object.entries(attention))
    record = setAttention(record, slug, value);
  return record;
}
/** Classifier calls in flight per agent. */
/** How long the classifier waits for a reply's parent before it goes on. */
const PARENT_LOOKUP_MS = 5_000;
const CLASSIFY_LIMIT = 32;
const seconds = () => Math.floor(Date.now() / 1000);
const message = (error: unknown) =>
  String(error instanceof Error ? error.message : error);
/** The team sections for agent `self`: each team it is on, its members that
 * still exist by name and npub, and the team's instructions. */
export function teamPrompt(
  teams: readonly Team[],
  agents: readonly Pick<AgentIdentity, "pubkey" | "name">[],
  self: string,
) {
  const names = new Map(agents.map((agent) => [agent.pubkey, agent.name]));
  return teams
    .filter((team) => team.members.includes(self))
    .map((team) => {
      const roster = team.members.flatMap((pubkey) => {
        const name = names.get(pubkey);
        return name === undefined
          ? []
          : [
              `- ${name} (${npubEncode(pubkey)})${pubkey === self ? ", you" : ""}`,
            ];
      });
      return [
        "<team>",
        `You are on the team ${JSON.stringify(team.name)}. Its members, you included:`,
        ...roster,
        "Mention a teammate by name, with their npub, to reach them.",
        ...(team.instructions.trim()
          ? [
              "<team-instructions>",
              team.instructions.trim(),
              "</team-instructions>",
            ]
          : []),
        "</team>",
      ].join("\n");
    })
    .join("\n\n");
}
const bounded = (set: Set<string>, id: string, limit = SEEN_LIMIT) => {
  set.add(id);
  if (set.size > limit) set.delete(set.values().next().value as string);
};
/** Whether an agent answers `event`: its owner's, or one by another agent the
 * owner attested (NIP-OA). Both bundled types answer nobody else. */
export async function fromOwner(
  event: Pick<RelayEvent, "pubkey" | "kind" | "created_at" | "tags">,
  owner: string,
) {
  return event.pubkey === owner || (await attestedOwner(event)) === owner;
}

/** The model and effort the triggering message asks of this agent. Only the
 * owner picks them, so nobody else in a channel can run the agent at their
 * level, and only ones the type lists: effort from the model the run uses. */
async function pickFor(
  trigger: Trigger,
  agent: Agent,
  type: RegisteredAgentType,
): Promise<{ model?: string; effort?: string }> {
  if (trigger.type === "timer" || trigger.event.pubkey !== agent.owner)
    return {};
  const asked = (name: string) =>
    trigger.event.tags.find(
      (tag) => tag[0] === name && tag[1] === agent.pubkey,
    )?.[2];
  const model = asked(MODEL_TAG);
  const effort = asked(EFFORT_TAG);
  if (!model && !effort) return {};
  try {
    const offered = await type.models?.(agent);
    const picked = offered?.models.find((item) => item.id === model);
    const runs =
      picked ?? offered?.models.find((item) => item.id === offered.current);
    return {
      ...(picked ? { model: picked.id } : {}),
      ...(effort && runs?.efforts.some((level) => level.id === effort)
        ? { effort }
        : {}),
    };
  } catch (error) {
    console.warn(`Agent type ${type.key} could not list its models`, error);
    return {};
  }
}

/** What Agents needs of the communities: the viewer, the selected one, and
 * a connection to any joined one without selecting it. */
export type AgentCommunities = Pick<
  Communities,
  "snapshot" | "subscribe" | "open"
>;
type Binding = {
  scope: string;
  origin: string;
  viewer: string;
  session: RelaySession;
  /** Aborts when this binding is replaced, so no work outlives its session. */
  controller: AbortController;
  stopLive: () => void;
};
/** A community the viewer has an agent in, and its session while live. */
type Bound = {
  relay: RelayData;
  stop: () => void;
  binding?: Binding | undefined;
  /** When its failed connection was last tried again. */
  retried?: number;
};
/** The origin a relay URL or community ID names, if it is a valid one. */
const originOf = (value: string) => {
  try {
    return communityDestination(value).url;
  } catch {
    return undefined;
  }
};
/** One of the viewer's kind 30177 agent records. Ones without a `runtime`
 * are earlier agent systems', not shown; replacing one keeps its settings. */
type Listing = Readonly<{
  pubkey: string;
  name: string;
  picture?: string;
  runtime?: string;
  /** The record as read or written, kept by the next one written. */
  prior?: AgentRecordBody | undefined;
}>;
const RUNTIME = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
/** The newest record of each agent, read as listings. */
function listingsOf(events: readonly EventData[], viewer: string) {
  const heads = new Map<string, EventData>();
  for (const event of events) {
    const d = event.tags.find((tag) => tag[0] === "d")?.[1] ?? "";
    if (event.kind === 30177 && event.pubkey === viewer)
      heads.set(d, newer(heads.get(d), event));
  }
  const listings: Listing[] = [];
  for (const [pubkey, event] of heads) {
    if (!/^[0-9a-f]{64}$/.test(pubkey)) continue;
    const runtime = event.tags.find((tag) => tag[0] === "runtime")?.[1] ?? "";
    let body: unknown = null;
    try {
      body = JSON.parse(event.content);
    } catch {}
    const content =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const name = typeof content.name === "string" ? content.name.trim() : "";
    const picture = recordPicture(content.picture);
    listings.push(
      Object.freeze({
        pubkey,
        name,
        ...(picture ? { picture } : {}),
        ...(RUNTIME.test(runtime) ? { runtime } : {}),
        prior: { content, tags: event.tags },
      }),
    );
  }
  return Object.freeze(listings);
}
/** A picture as a record carries it: an HTTPS image URL, never inline data. */
const recordPicture = (value: unknown) => {
  const source = avatarSource(value);
  return source?.startsWith("https:") ? source : undefined;
};
/** The `wss://` URL of a community, as agents and their providers know it. */
const wssOf = (origin: string) =>
  relayOrigin(origin).replace(/^https:/, "wss:");
type Job = {
  work?: ReturnType<LocalAgentActivity["begin"]>;
  trigger: Trigger;
  channelId?: string;
  /** For a watch or timer: the object and attention epoch it was matched or
   * found due under. It runs only while both are still current, so a watch or
   * timer edited, disabled, rearmed, replaced or turned off and on again since
   * then does not run it. */
  matched?: { object: AttentionObject; epoch: number };
};
type WatchTrigger = Extract<Trigger, { type: "watch" }>;
type CompiledWatch = Omit<WatchTrigger, "type" | "event"> & {
  filter?: ReturnType<typeof compileFilter>;
};
/** One agent's runtime, for as long as its identity exists. Edits do not
 * replace it: each job reads the agent as it is when the job starts, and the
 * watches are recompiled only when its attention changes. */
type Runner = {
  readonly pubkey: string;
  /** The registration whose `run` it calls; a new one aborts the in-flight run. */
  type: RegisteredAgentType | undefined;
  controller: AbortController;
  /** Events waiting to run; due timers are found when a run starts instead. */
  queue: Job[];
  running: boolean;
  windowStart: number;
  admitted: number;
  /** Events seen, and events it wrote (so reactions to them reach no watch). */
  readonly seen: Set<string>;
  /** Events seen in each channel, as many as a reconnect replays of it, so
   * other channels' traffic cannot push out one a replay sends again. */
  readonly seenIn: Map<string, Set<string>>;
  readonly wrote: Set<string>;
  /** Watched events whose channel roster is not confirmed yet, by id: they are
   * matched again once it is (see `member()`). */
  readonly held: Map<string, { event: RelayEvent; channelId?: string }>;
  /** Whether native may hold the agent for this copy; true at first, since
   * native outlives a page reload. */
  mayHold: boolean;
  activityClaimed?: boolean;
  /** Advances each time attention is seen off, which voids queued watch work. */
  epoch: number;
  /** Classified watch events not yet queued or dropped. */
  classifying: number;
  /** The last classified event's release: results queue in arrival order. */
  classified: Promise<void>;
  compiled?: {
    attention: Agent["attention"];
    watches: readonly CompiledWatch[];
  };
};

export class AgentsService extends Service implements Agents {
  /** Settles once the saved key's status is known; until then a classified
   * event waits rather than pass unchecked. */
  private jevStatus: Promise<void> | undefined;
  private readonly contributions;
  private readonly listeners = new Set<() => void>();
  /** Every saved identity, deleted ones included: native's list is the agent
   * list, and `records` only adds settings to it. */
  private identities: readonly AgentIdentity[] = [];
  private records: Record<string, AgentRecord>;
  private teamList: readonly Team[];
  private state: AgentsSnapshot;
  /** By origin, so each agent listens in its own community, selected or not. */
  private bound = new Map<string, Bound>();
  /** Agents whose community was live at the last update. */
  private connected = new Set<string>();
  private runners = new Map<string, Runner>();
  /** Counts list requests, so only the latest one is applied. */
  private listed = 0;
  /** Deleted agents whose community cleanup is running, and whether it was
   * asked for again meanwhile, as when the connection recovers mid-attempt. */
  private cleaning = new Map<string, boolean>();
  private unfinished: readonly Unfinished[];
  /** The viewer's agent records in each community, by origin, as last read
   * from its live session and written since. */
  private listings = new Map<string, readonly Listing[]>();
  /** Agents whose record is being written, so a sync writes each once. */
  private listing = new Set<string>();
  /** By origin until its records are first read: the listings written or
   * removed meanwhile, which the read must not undo. */
  private edits = new Map<string, Map<string, Listing | null>>();
  /** By origin, the binding whose read of its records is under way. */
  private reading = new Map<string, Binding>();
  /** Hosted agents whose setup, save or delete is running, so one waits for
   * the others. */
  private busy = new Set<string>();
  /** Hosted and elsewhere agents as last shown, kept while unchanged. */
  private shown = new Map<string, Agent>();

  constructor(
    ctx: Context,
    private readonly communities: AgentCommunities,
    private readonly native: AgentsNative | undefined = nativeAgents(),
    private readonly storage: Storage = globalThis.localStorage,
    private readonly authorize: (
      pubkey: string,
      signal: AbortSignal,
    ) => Promise<NipOaAuthorization> = prepareRemoteAgentAuthorization,
    private readonly localActivity = createLocalAgentActivity(),
    private readonly jev: ClassifierNative | undefined = nativeClassifier(),
  ) {
    super(ctx, "agents");
    this.contributions = createContributions<AgentType>(ctx);
    migrateAgentStorage(storage);
    this.records = readRecords(storage);
    this.unfinished = Object.freeze(readUnfinished(storage));
    this.teamList = Object.freeze(readTeams(storage));
    this.state = Object.freeze({
      status: native ? "loading" : "unavailable",
      classifier: "unavailable",
      classifierKey: "checking",
      agents: [],
      running: [],
      teams: this.teamList,
    });
    ctx.effect(() => {
      const stops = [
        this.contributions.subscribe(() => {
          this.update();
          this.notify();
        }),
        communities.subscribe(() => {
          this.watch();
          this.update();
        }),
      ];
      this.watch();
      void this.refresh();
      this.jevStatus = this.jev
        ?.status()
        .then((configured) => this.setKey(configured ? "saved" : "missing"))
        .catch((error) => {
          console.warn("The classifier key could not be read", error);
          this.setKey("unreadable");
        });
      // Wakes each runner, which starts any timer that is due.
      const tick = setInterval(() => {
        for (const runner of this.runners.values()) void this.drain(runner);
        this.reconnect();
      }, TIMER_TICK_MS);
      return () => {
        clearInterval(tick);
        // A list still being read is stale: it must not reopen communities.
        this.listed++;
        for (const stop of stops) stop();
        for (const origin of [...this.bound.keys()]) this.unbind(origin);
        for (const runner of this.runners.values()) this.retire(runner);
        this.runners.clear();
        // Clear what is shown without reconciling, which would make new runners.
        this.state = Object.freeze({
          ...this.state,
          agents: Object.freeze([]),
          running: Object.freeze([]),
        });
        this.notify();
      };
    });
  }

  register<Config>(type: AgentType<Config>) {
    if (
      !/^[a-z0-9][a-z0-9._-]*$/.test(type.id ?? "") ||
      !type.title ||
      typeof type.defaults !== "function"
    )
      throw new Error("Agent types need an id, a title and defaults");
    if (
      type.timeoutMs !== undefined &&
      !(
        Number.isInteger(type.timeoutMs) &&
        type.timeoutMs >= 1 &&
        type.timeoutMs <= TIMEOUT_LIMIT_MS
      )
    )
      throw new Error(
        `Agent type timeoutMs must be a whole number from 1 to ${TIMEOUT_LIMIT_MS}`,
      );
    const { remote } = type;
    if (
      remote &&
      (type.run ||
        type.models ||
        type.timeoutMs !== undefined ||
        (["provision", "activate", "profile", "remove"] as const).some(
          (step) => typeof remote[step] !== "function",
        ))
    )
      throw new Error(
        "A hosted agent type has provision, activate, profile and remove, and no run, models or timeoutMs",
      );
    this.contributions.register(this.ctx, type as unknown as AgentType);
  }
  types = () => this.contributions.snapshot();
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  find = (pubkey: string) =>
    this.state.agents.find((agent) => agent.pubkey === pubkey);
  relay = (pubkey: string) => {
    const origin = originOf(this.agent(pubkey)?.relay ?? "");
    return origin ? this.bound.get(origin)?.relay : undefined;
  };
  private localCache:
    | {
        identities: readonly AgentIdentity[];
        state: Pick<AgentsSnapshot, "status" | "error">;
        value: LocalAgentsSnapshot;
      }
    | undefined;
  /** Every live agent, in any community, for names and mentions. `snapshot`
   * holds only the selected community's, with their settings. */
  local = (): LocalAgentsSnapshot => {
    const { identities, state } = this;
    const cached = this.localCache;
    if (
      cached?.identities === identities &&
      cached.state.status === state.status &&
      cached.state.error === state.error
    )
      return cached.value;
    const value: LocalAgentsSnapshot = Object.freeze({
      status: state.status,
      agents: Object.freeze(
        identities
          .filter((identity) => !identity.deleted)
          .map(({ pubkey, name, relay, owner }) =>
            Object.freeze({ pubkey, name, relayUrl: relay, owner }),
          ),
      ),
      ...(state.error ? { error: state.error } : {}),
    });
    this.localCache = { identities, state, value };
    return value;
  };

  async create({ type, name, picture, config }: NewAgent) {
    if (!name.trim()) throw new Error("Name the agent");
    const remote = this.types().find((entry) => entry.key === type)?.remote;
    if (remote) {
      const agent = await this.provision(type, remote, name.trim());
      if (!picture) return agent;
      // It exists now, so a picture that fails to save does not fail it.
      await this.save(agent.pubkey, { picture }).catch((error: unknown) =>
        console.warn(`Agent ${agent.name} picture was not saved`, error),
      );
      return this.find(agent.pubkey) ?? agent;
    }
    return this.add(
      type,
      async (native, destination, owner) => ({
        agent: await native.create(destination, owner, type, name.trim()),
      }),
      { config, picture },
    );
  }
  /** Whether watch classifiers can run on this device: a key is saved. */
  classifier(): ClassifierAvailability {
    return this.state.classifier;
  }
  async setClassifierKey(key: string) {
    if (!this.jev)
      throw new Error("The classifier runs only in the desktop app");
    await this.jev.setKey(key);
    this.setKey("saved");
  }
  async clearClassifierKey() {
    if (!this.jev)
      throw new Error("The classifier runs only in the desktop app");
    await this.jev.clearKey();
    this.setKey("missing");
  }
  /** Agents are told a classifier can run only while a key is known to be
   * saved. A key the service refused still runs, and each event reports why
   * it passed unchecked. */
  private setKey(classifierKey: ClassifierKey) {
    const classifier =
      classifierKey === "saved" || classifierKey === "refused"
        ? "available"
        : "unavailable";
    if (this.state.classifierKey === classifierKey) return;
    this.state = Object.freeze({ ...this.state, classifier, classifierKey });
    this.notify();
  }

  /** Has the provider make the agent, then sets it up. From here on it is
   * kept, unfinished until set up, so a failure never makes a second one. */
  private async provision(type: string, remote: RemoteAgentType, name: string) {
    const binding = this.selectedBinding();
    const community = wssOf(binding.origin);
    const { pubkey } = await remote.provision({
      name,
      community,
      signal: binding.controller.signal,
    });
    if (typeof pubkey !== "string" || !/^[0-9a-f]{64}$/.test(pubkey))
      throw new Error("The provider did not return the agent's key");
    if (
      pubkey === binding.viewer ||
      this.identities.some((identity) => identity.pubkey === pubkey) ||
      [...this.bound.keys()].some((origin) => this.rowOf(origin, pubkey))
    )
      throw new Error("The provider returned a key that is already in use");
    this.writeUnfinished([
      ...this.unfinished.filter((setup) => setup.pubkey !== pubkey),
      { pubkey, type, name, relay: community, owner: binding.viewer },
    ]);
    return this.finish(pubkey);
  }

  finish(pubkey: string) {
    return this.exclusive(pubkey, () => this.setUp(pubkey));
  }
  private async setUp(pubkey: string) {
    const setup = this.unfinished.find((entry) => entry.pubkey === pubkey);
    if (!setup) throw new Error("That agent has no setup to finish");
    const remote = this.types().find(
      (entry) => entry.key === setup.type,
    )?.remote;
    if (!remote) throw new Error("That agent type is not available");
    const origin = originOf(setup.relay);
    const binding = this.bindingOf(setup);
    if (!origin || !binding) throw new Error("Connect to its community first");
    const { signal } = binding.controller;
    const auth = await this.authorize(pubkey, signal);
    if (auth[1] !== setup.owner)
      throw new Error("Sign in as the agent's owner to finish its setup");
    await remote.activate({
      pubkey,
      name: setup.name,
      community: setup.relay,
      auth,
      signal,
    });
    await this.writeListing(origin, binding, {
      pubkey,
      name: setup.name,
      runtime: setup.type,
      prior: this.rowOf(origin, pubkey)?.prior,
    });
    this.writeUnfinished(this.unfinished.filter((entry) => entry !== setup));
    const agent = this.find(pubkey);
    if (!agent) throw new Error("The agent was set up in another community");
    return agent;
  }

  async portable() {
    const native = this.native;
    if (!native) throw new Error("Agents run only in the desktop app");
    const found = await native.portable();
    const own = new Set(
      this.identities
        .filter((identity) => !identity.deleted)
        .map((identity) => identity.pubkey),
    );
    return {
      ...found,
      agents: found.agents.filter((agent) => !own.has(agent.pubkey)),
    };
  }

  async port(input: PortInput) {
    const { type } = input;
    if (input.source !== "shared") {
      const { source, pubkey } = input;
      return this.add(type, (native, destination, owner) =>
        native.port(source, pubkey, destination, owner, type),
      );
    }
    const name = input.name.trim();
    if (!name) throw new Error("Name the agent");
    const { picture, instructions } = input;
    // A shared agent has no key to keep; it is a new identity that carries
    // what was shared, as a brought-over one does.
    return this.add(
      type,
      async (native, destination, owner) => ({
        agent: await native.create(destination, owner, type, name),
        ...(instructions?.trim() ? { carry: { instructions } } : {}),
      }),
      { picture },
    );
  }

  /** Saves a new identity of `type` in the selected community with the type's
   * default settings, or the `config` it was made with, adopting what a
   * brought-over one carried. */
  private async add(
    type: string,
    save: (
      native: AgentsNative,
      destination: string,
      owner: string,
    ) => Promise<Readonly<{ agent: AgentIdentity; carry?: Carry }>>,
    made: Readonly<{ config?: unknown; picture?: string | undefined }> = {},
  ) {
    const native = this.native;
    if (!native) throw new Error("Agents run only in the desktop app");
    const binding = this.selectedBinding();
    const kind = this.types().find((entry) => entry.key === type);
    if (!kind) throw new Error("That agent type is not available");
    if (kind.remote)
      throw new Error("A hosted agent's key stays with its provider");
    const settings = defaults("", kind);
    const { agent: identity, carry } = await save(
      native,
      relayOrigin(binding.origin),
      binding.viewer,
    );
    let record = { ...settings, pubkey: identity.pubkey };
    try {
      if (made.config !== undefined)
        record = { ...record, config: made.config };
      if (carry && kind.adopt)
        record = { ...record, config: kind.adopt(carry, record.config) };
      this.write(record);
    } catch (error) {
      // The agent exists either way; unsaved settings start from the defaults.
      console.warn(`Agent ${identity.name} settings were not saved`, error);
    }
    // Before the refresh, which publishes its profile with the picture. The
    // agent exists either way; its picture can be set again later.
    let shown = identity;
    const { picture } = made;
    if (picture)
      await native.setPicture(identity.pubkey, picture).then(
        () => {
          shown = { ...identity, picture };
        },
        (error: unknown) =>
          console.warn(`Agent ${identity.name} picture was not saved`, error),
      );
    await this.refresh();
    return this.view(shown, record);
  }

  /** The selected community's live binding, where agents are made. */
  private selectedBinding() {
    const selected = this.communities.snapshot().selected;
    const binding = selected
      ? this.bound.get(originOf(selected) ?? "")?.binding
      : undefined;
    if (!binding) throw new Error("Connect to a community first");
    return binding;
  }

  async save(pubkey: string, change: AgentChange) {
    const identity = this.live(pubkey);
    if (!identity)
      return this.exclusive(pubkey, () => this.saveHosted(pubkey, change));
    if (!this.native) throw new Error("No such agent on this device");
    const name = change.name?.trim();
    if (name === "") throw new Error("Name the agent");
    let record = this.recordOf(identity);
    if (change.config !== undefined)
      record = { ...record, config: change.config };
    if (change.attentionEnabled !== undefined) {
      const { attentionEnabled: _, ...rest } = record;
      record = change.attentionEnabled
        ? { ...rest, attentionEnabled: true }
        : rest;
    }
    for (const [slug, value] of Object.entries(change.attention ?? {}))
      record = setAttention(
        record,
        slug,
        value,
        undefined,
        change.restart?.includes(slug) ? "restart" : undefined,
      );
    // As the spec's writer: an Interest stays while anything still uses it.
    for (const [slug, value] of Object.entries(change.attention ?? {})) {
      const id = parseSlug(slug)?.id;
      if (value !== null || !slug.startsWith("interest/") || !id) continue;
      if (
        Object.values(record.attention).some(
          (object) =>
            object.value.type !== "interest" && object.value.interest_id === id,
        )
      )
        throw new Error(
          "Remove or move the watches and timers that use this Interest first",
        );
    }
    if (
      change.config !== undefined ||
      change.attention ||
      change.attentionEnabled !== undefined
    )
      this.write(record);
    const picture =
      change.picture === undefined ? undefined : change.picture || null;
    const renamed = name !== undefined && name !== identity.name;
    const repictured =
      picture !== undefined && picture !== (identity.picture ?? null);
    if (renamed) await this.native.rename(pubkey, name);
    if (repictured) await this.native.setPicture(pubkey, picture);
    // Shows the new name or picture and publishes it as the agent's profile.
    if (renamed || repictured) await this.refresh();
  }

  /** A hosted agent's name and picture are its provider's to publish; the app
   * then lists it under them. Its settings are the provider's, not saved here. */
  private async saveHosted(pubkey: string, change: AgentChange) {
    const { agent, remote, origin, binding } = this.hosted(pubkey);
    if (
      change.config !== undefined ||
      change.attention ||
      change.attentionEnabled !== undefined
    )
      throw new Error("A hosted agent's settings save through its provider");
    const name = change.name === undefined ? agent.name : change.name.trim();
    if (!name) throw new Error("Name the agent");
    const picture =
      change.picture === undefined
        ? agent.picture
        : recordPicture(change.picture ?? undefined);
    if (change.picture && !picture)
      throw new Error("A hosted agent's picture is an HTTPS image URL");
    if (name === agent.name && picture === agent.picture) return;
    await remote.profile({
      pubkey,
      community: agent.relay,
      name,
      ...(picture ? { picture } : {}),
      signal: binding.controller.signal,
    });
    await this.writeListing(origin, binding, {
      pubkey,
      name,
      ...(picture ? { picture } : {}),
      runtime: agent.type,
      prior: this.rowOf(origin, pubkey)?.prior,
    });
  }
  /** A hosted agent shown now, its provider, and its community's live session. */
  private hosted(pubkey: string, unfinished = false) {
    const agent = this.state.agents.find(
      (entry) => entry.pubkey === pubkey && entry.place === "hosted",
    );
    if (agent?.unfinished && !unfinished)
      throw new Error("Finish the agent's setup first");
    const remote =
      agent && this.types().find((entry) => entry.key === agent.type)?.remote;
    const origin = agent && originOf(agent.relay);
    const binding = agent && this.bindingOf(agent);
    if (!agent || !remote || !origin || !binding)
      throw new Error("No such agent on this device");
    return { agent, remote, origin, binding };
  }

  async remove(pubkey: string) {
    if (!this.identities.some((identity) => identity.pubkey === pubkey))
      return this.removeHosted(pubkey);
    if (!this.native) throw new Error("Agents run only in the desktop app");
    await this.native.remove(pubkey);
    // Drops its settings, and starts its cleanup if its community is connected.
    await this.refresh();
  }

  /** Has a hosted agent's provider remove it, then takes it out of the
   * community as Delete does for one here. Its record goes last, so a failure
   * leaves it listed for Delete to be tried again. */
  private removeHosted(pubkey: string) {
    if (
      this.state.agents.some(
        (agent) => agent.pubkey === pubkey && agent.place === "elsewhere",
      )
    )
      throw new Error("Delete it on the device that runs it");
    return this.exclusive(pubkey, async () => {
      const { agent, remote, origin, binding } = this.hosted(pubkey, true);
      const { signal } = binding.controller;
      await remote.remove({ pubkey, community: agent.relay, signal });
      // An unfinished one may have published its profile before setup failed.
      await removeRelayAgent(binding.session, binding.viewer, pubkey, signal);
      this.unlist(origin, pubkey);
      this.writeUnfinished(
        this.unfinished.filter((setup) => setup.pubkey !== pubkey),
      );
    });
  }
  private async exclusive<T>(pubkey: string, step: () => Promise<T>) {
    if (this.busy.has(pubkey))
      throw new Error("Wait for the agent's last change to finish");
    this.busy.add(pubkey);
    try {
      return await step();
    } finally {
      this.busy.delete(pubkey);
    }
  }

  async saveTeam({ id, name, instructions, members }: TeamChange) {
    if (!this.native) throw new Error("Agents run only in the desktop app");
    if (!name.trim()) throw new Error("Name the team");
    const unknown = members.find((pubkey) => !this.live(pubkey));
    if (unknown) throw new Error("A member is not an agent on this device");
    if (id && !this.teamList.some((team) => team.id === id))
      throw new Error("No such team");
    const team: Team = Object.freeze({
      id: id ?? crypto.randomUUID(),
      name: name.trim(),
      instructions,
      members: Object.freeze([...new Set(members)]),
    });
    this.writeTeams(
      id
        ? this.teamList.map((saved) => (saved.id === id ? team : saved))
        : [...this.teamList, team],
    );
    return team;
  }

  async removeTeam(id: string) {
    this.writeTeams(this.teamList.filter((team) => team.id !== id));
  }

  /** Saves the teams; memory changes only once storage has taken them. */
  private writeTeams(teams: readonly Team[]) {
    writeTeams(this.storage, teams);
    this.teamList = Object.freeze(teams);
    this.state = Object.freeze({ ...this.state, teams: this.teamList });
    this.notify();
  }

  /** Saves the unfinished setups; memory changes only once storage has them. */
  private writeUnfinished(unfinished: readonly Unfinished[]) {
    writeUnfinished(this.storage, unfinished);
    this.unfinished = Object.freeze(unfinished);
    this.update();
  }

  /** Reads the viewer's agent records in the community, then lists each of
   * its agents here that they lack. A sync asks again until one succeeds.
   * Without the desktop app there are no agents to show. */
  private async readListings(origin: string, binding: Binding) {
    if (!this.native || this.reading.get(origin) === binding) return;
    this.reading.set(origin, binding);
    const { session, viewer, controller } = binding;
    try {
      const events = await session.read(
        [{ kinds: [30177], authors: [viewer], limit: 500 }],
        { signal: controller.signal, priority: "background", fresh: true },
      );
      if (this.bound.get(origin)?.binding !== binding) return;
      const edits = this.edits.get(origin);
      const read = listingsOf(events, viewer).filter(
        (row) => !edits?.has(row.pubkey),
      );
      const written = [...(edits?.values() ?? [])].filter((row) => !!row);
      this.listings.set(origin, Object.freeze([...read, ...written]));
      this.edits.delete(origin);
    } catch (error) {
      // Its edits stay for the next read, which a sync asks for.
      if (!controller.signal.aborted)
        console.warn("The agent list could not be read", error);
      return;
    } finally {
      if (this.reading.get(origin) === binding) this.reading.delete(origin);
    }
    this.update();
    this.list(origin, binding);
  }
  /** The community's listings: as read, or until the first read finishes,
   * those written since. */
  private rowsOf(origin: string): readonly Listing[] {
    return (
      this.listings.get(origin) ??
      [...(this.edits.get(origin)?.values() ?? [])].filter((row) => !!row)
    );
  }
  private rowOf(origin: string, pubkey: string) {
    return this.rowsOf(origin).find((row) => row.pubkey === pubkey);
  }
  /** Lists each agent here in the community whose record is missing or shows
   * another name, picture or type. Waits for the first read, so it never
   * replaces a record it has not seen. */
  private list(origin: string, binding: Binding) {
    if (!this.listings.has(origin)) return;
    for (const identity of this.identities) {
      if (
        identity.deleted ||
        identity.owner !== binding.viewer ||
        originOf(identity.relay) !== origin ||
        this.listing.has(identity.pubkey)
      )
        continue;
      const picture = recordPicture(identity.picture);
      const row = this.rowOf(origin, identity.pubkey);
      if (
        row?.name === identity.name &&
        row.picture === picture &&
        row.runtime === identity.type
      )
        continue;
      const { pubkey } = identity;
      this.listing.add(pubkey);
      this.writeListing(origin, binding, {
        pubkey,
        name: identity.name,
        ...(picture ? { picture } : {}),
        runtime: identity.type,
        prior: row?.prior,
      }).then(
        () => {
          this.listing.delete(pubkey);
          // Lists a rename or new picture made while this write was under way.
          if (this.bound.get(origin)?.binding === binding)
            this.list(origin, binding);
        },
        (error) => {
          this.listing.delete(pubkey);
          if (!binding.controller.signal.aborted)
            console.warn(`Agent ${identity.name} was not listed`, error);
        },
      );
    }
  }
  /** Writes the agent's record and lists it so, without reading it back. */
  private async writeListing(
    origin: string,
    binding: Binding,
    entry: Listing & { runtime: string },
  ) {
    const prior = await publishAgentRecord(
      binding.session,
      entry,
      binding.controller.signal,
    );
    if (this.bound.get(origin)?.binding !== binding) return;
    this.setRow(origin, entry.pubkey, Object.freeze({ ...entry, prior }));
    this.update();
  }
  private unlist(origin: string, pubkey: string) {
    this.setRow(origin, pubkey, null);
  }
  /** Replaces or removes the agent's listing, and keeps the change until the
   * community's records are first read. */
  private setRow(origin: string, pubkey: string, row: Listing | null) {
    const listings = this.listings.get(origin);
    if (!listings) {
      const edits = this.edits.get(origin) ?? new Map<string, Listing | null>();
      this.edits.set(origin, edits.set(pubkey, row));
      return;
    }
    const rest = listings.filter((entry) => entry.pubkey !== pubkey);
    if (row || rest.length !== listings.length)
      this.listings.set(origin, Object.freeze(row ? [...rest, row] : rest));
  }
  /** The selected community's agents that are not here: hosted ones, set up
   * or not, and ones on the viewer's other devices. */
  private listedAgents(origin: string | undefined) {
    const binding = origin ? this.bound.get(origin)?.binding : undefined;
    if (!origin || !binding) return [];
    const here = new Set(this.identities.map((identity) => identity.pubkey));
    const listings = this.rowsOf(origin);
    const types = new Map(this.types().map((type) => [type.key, type]));
    const relay = wssOf(binding.origin);
    const shown: Agent[] = [];
    for (const row of listings)
      if (row.runtime && row.name && !here.has(row.pubkey))
        shown.push(
          this.show({
            pubkey: row.pubkey,
            name: row.name,
            ...(row.picture ? { picture: row.picture } : {}),
            type: row.runtime,
            owner: binding.viewer,
            relay,
            place: types.get(row.runtime)?.remote ? "hosted" : "elsewhere",
          }),
        );
    for (const setup of this.unfinished)
      if (
        originOf(setup.relay) === origin &&
        setup.owner === binding.viewer &&
        !here.has(setup.pubkey) &&
        !listings.some((row) => row.runtime && row.pubkey === setup.pubkey)
      )
        shown.push(
          this.show({
            pubkey: setup.pubkey,
            name: setup.name,
            type: setup.type,
            owner: setup.owner,
            relay: setup.relay,
            place: "hosted",
            unfinished: true,
          }),
        );
    return shown;
  }
  /** The agent as shown, the same object while nothing about it changed. */
  private show(
    fields: Pick<
      Agent,
      | "pubkey"
      | "name"
      | "picture"
      | "type"
      | "owner"
      | "relay"
      | "place"
      | "unfinished"
    >,
  ): Agent {
    const prior = this.shown.get(fields.pubkey);
    if (
      prior &&
      prior.name === fields.name &&
      prior.picture === fields.picture &&
      prior.type === fields.type &&
      prior.owner === fields.owner &&
      prior.relay === fields.relay &&
      prior.place === fields.place &&
      prior.unfinished === fields.unfinished
    )
      return prior;
    const agent: Agent = Object.freeze({
      ...fields,
      attention: EMPTY,
      skipped: EMPTY,
      timers: EMPTY,
      attentionEnabled: false,
      config: undefined,
    });
    this.shown.set(fields.pubkey, agent);
    return agent;
  }

  /** Saves one record; memory changes only once storage has taken it. */
  private write(record: AgentRecord) {
    const records = { ...this.records, [record.pubkey]: record };
    writeRecords(this.storage, records);
    this.records = records;
    this.update();
  }
  private live(pubkey: string) {
    return this.identities.find(
      (identity) => identity.pubkey === pubkey && !identity.deleted,
    );
  }
  /** Its saved settings or, without any, its type's defaults, kept in memory
   * until a save stores them. Without its type there are no defaults yet. */
  private recordOf({ pubkey, type }: AgentIdentity) {
    const kind = this.types().find((entry) => entry.key === type);
    if (!this.records[pubkey] && kind)
      try {
        this.records = { ...this.records, [pubkey]: defaults(pubkey, kind) };
      } catch (error) {
        console.warn(`Agent type ${type} has invalid defaults`, error);
      }
    return this.records[pubkey] ?? blank(pubkey);
  }
  private view(identity: AgentIdentity, record: AgentRecord): Agent {
    return Object.freeze({
      pubkey: identity.pubkey,
      name: identity.name,
      ...(identity.picture && { picture: identity.picture }),
      type: identity.type,
      owner: identity.owner,
      relay: identity.relay,
      place: "here",
      attention: record.attention,
      skipped: record.skipped ?? EMPTY,
      timers: record.timers ?? EMPTY,
      attentionEnabled: record.attentionEnabled === true,
      config: record.config,
    });
  }
  /** The live binding of the agent's community, if it has one now. */
  private bindingOf({ relay, owner }: Pick<AgentIdentity, "relay" | "owner">) {
    const origin = originOf(relay);
    const binding = origin ? this.bound.get(origin)?.binding : undefined;
    return binding?.scope === relayPartition(origin ?? "", owner)
      ? binding
      : undefined;
  }
  /** Whether the agent stays running: it is the viewer's, and its community is
   * joined and not disconnected. A reconnect does not stop it. */
  private alive({ relay, owner }: AgentIdentity) {
    const origin = originOf(relay);
    const entry = origin ? this.bound.get(origin) : undefined;
    return (
      owner === this.communities.snapshot().viewer &&
      !!entry &&
      entry.relay.snapshot().status !== "disconnected"
    );
  }
  /** A running agent, in any community. */
  private agent(pubkey: string) {
    return this.state.running.find((agent) => agent.pubkey === pubkey);
  }
  /** The agent, while its community's session is live to run it in. */
  private ready(pubkey: string) {
    const agent = this.agent(pubkey);
    return agent && this.bindingOf(agent) ? agent : undefined;
  }

  /** Reads the agent list from native. Every change is made there first and
   * then read back here, so the list has one source. */
  private async refresh() {
    if (!this.native) return;
    const turn = ++this.listed;
    try {
      const identities = await this.native.list();
      // A newer list is on its way; this one may predate a change.
      if (turn !== this.listed) return;
      this.identities = identities;
      this.state = Object.freeze({ ...this.state, status: "ready" });
      // Settings whose agent is gone do nothing.
      const live = new Set(
        identities
          .filter((saved) => !saved.deleted)
          .map((saved) => saved.pubkey),
      );
      if (Object.keys(this.records).some((pubkey) => !live.has(pubkey))) {
        this.records = Object.fromEntries(
          Object.entries(this.records).filter(([pubkey]) => live.has(pubkey)),
        );
        writeRecords(this.storage, this.records);
      }
      // A deleted agent leaves its teams; the teams stay.
      if (
        this.teamList.some((team) =>
          team.members.some((pubkey) => !live.has(pubkey)),
        )
      )
        this.writeTeams(
          this.teamList.map((team) => ({
            ...team,
            members: team.members.filter((pubkey) => live.has(pubkey)),
          })),
        );
    } catch (error) {
      if (turn !== this.listed) return;
      this.state = Object.freeze({
        ...this.state,
        status: "error",
        error: message(error),
      });
    }
    this.watch();
    this.update();
    this.notify();
    this.sync();
  }

  /** Brings the relay in line with the saved identities: publishes each name
   * its community lacks, and finishes Delete where connected. Each step
   * is safe to repeat; what fails is tried again on the next refresh or connect. */
  private sync() {
    for (const [origin, { binding }] of this.bound) {
      if (!binding) continue;
      if (this.listings.has(origin)) this.list(origin, binding);
      else void this.readListings(origin, binding);
    }
    const native = this.native;
    for (const identity of this.identities)
      if (!identity.deleted)
        native
          ?.publishProfile(identity.pubkey)
          .catch((error) =>
            console.warn(
              `Agent ${identity.name} profile was not published`,
              error,
            ),
          );
      else {
        const binding = this.bindingOf(identity);
        if (binding) void this.cleanup(identity.pubkey, binding);
      }
  }
  /** As harness Delete does: leave every channel, then archive the identity so
   * it drops out of member lists and mention suggestions. The owner signs both,
   * so neither needs the deleted key. Nothing is final until each is confirmed. */
  private async cleanup(pubkey: string, binding: Binding) {
    if (this.cleaning.has(pubkey)) {
      this.cleaning.set(pubkey, true);
      return;
    }
    this.cleaning.set(pubkey, false);
    let failed = false;
    const signal = AbortSignal.any([
      binding.controller.signal,
      AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
    ]);
    const { session } = binding;
    try {
      await removeAgentFromChannels(session, pubkey, signal);
      const { archives } = session;
      if (archives.writable) {
        // The archive cache is not live; this needs a read started now.
        await archives.ensure();
        await archives.refresh();
        signal.throwIfAborted();
        const state = archives.state(pubkey);
        // An unfinished read says nothing, least of all "not archived".
        if (state === "unknown") throw new Error("Archive state is unknown");
        // Without an owner-attested profile the agent is not in the directory,
        // so there is nothing to hide (and no consent path to archive it with).
        const consent =
          state === "not-archived" && (await archives.consent(pubkey, signal));
        signal.throwIfAborted();
        if (consent) await archives.request("archive", pubkey, signal);
      }
      await deleteAgentRecord(session, binding.viewer, pubkey, signal);
      for (const origin of this.listings.keys()) this.unlist(origin, pubkey);
      await this.native?.forget(pubkey);
      await this.refresh();
    } catch (error) {
      failed = !binding.controller.signal.aborted;
      if (failed) console.warn("Deleted agent cleanup will be retried", error);
    } finally {
      const again = this.cleaning.get(pubkey);
      this.cleaning.delete(pubkey);
      if (failed && again) void this.cleanup(pubkey, binding);
    }
  }

  /** Connects the selected community, where agents are made, and each one
   * the viewer has an agent in, deleted ones included so their cleanup can
   * finish; lets go of the rest. */
  private watch() {
    const { viewer, selected } = this.communities.snapshot();
    const origins = new Set<string>();
    const shown = viewer && originOf(selected ?? "");
    if (shown) origins.add(shown);
    for (const identity of this.identities) {
      const origin = identity.owner === viewer && originOf(identity.relay);
      if (origin) origins.add(origin);
    }
    // Left, or left and joined again with a new session.
    for (const [origin, entry] of this.bound)
      if (!origins.has(origin) || this.communities.open(origin) !== entry.relay)
        this.unbind(origin);
    for (const origin of origins) {
      if (this.bound.has(origin)) continue;
      const relay = this.communities.open(origin);
      if (!relay) continue;
      this.bound.set(origin, {
        relay,
        stop: relay.subscribe(() => this.bind(origin)),
      });
      this.bind(origin);
    }
  }
  /** Tries each unselected community whose connection failed again, since
   * nobody is there to press its Retry; its agents wait on it. */
  private reconnect() {
    const selected = originOf(this.communities.snapshot().selected ?? "");
    const now = Date.now();
    for (const [origin, entry] of this.bound)
      if (
        origin !== selected &&
        entry.relay.snapshot().status === "error" &&
        now - (entry.retried ?? 0) >= RETRY_MS
      ) {
        entry.retried = now;
        entry.relay.retry();
      }
  }
  private unbind(origin: string) {
    const entry = this.bound.get(origin);
    this.bound.delete(origin);
    this.listings.delete(origin);
    this.edits.delete(origin);
    entry?.stop();
    entry?.binding?.stopLive();
    entry?.binding?.controller.abort();
  }
  private bind(origin: string) {
    const entry = this.bound.get(origin);
    if (!entry) return;
    const snapshot = entry.relay.snapshot();
    const live =
      snapshot.status === "ready" &&
      !snapshot.cached &&
      snapshot.scope &&
      snapshot.origin &&
      snapshot.viewer
        ? {
            scope: snapshot.scope,
            origin: snapshot.origin,
            viewer: snapshot.viewer,
            session: snapshot.session,
            controller: new AbortController(),
          }
        : undefined;
    const changed =
      entry.binding?.session !== live?.session ||
      entry.binding?.scope !== live?.scope;
    if (changed) {
      entry.binding?.stopLive();
      entry.binding?.controller.abort();
      this.listings.delete(origin);
      this.edits.delete(origin);
      entry.binding = live && {
        ...live,
        stopLive: this.listen(live.session, origin),
      };
    }
    // Disconnecting stops its agents even when no binding changed.
    this.update();
    // Its sync reads the community's agent records too.
    if (changed && entry.binding) this.sync();
  }

  /** Delivers the session's live events, and retries what failed whenever its
   * connection recovers, which happens within the same session. A subscription
   * that comes back, after a reconnect or a failed route, first sends its
   * recent history again: what in it is new since this listener started was
   * missed while it was down, and is delivered now (`seen` drops the rest).
   * Older history is catch-up's, not replay's. */
  private listen(session: RelaySession, origin: string) {
    let connected = session.live.snapshot().status === "connected";
    const since = seconds();
    const stopEvents = session.subscribeLive(
      (batch) => this.dispatch(batch, origin, since),
      { replay: true },
    );
    const stopStatus = session.live.subscribe(() => {
      const now = session.live.snapshot().status === "connected";
      if (now && !connected) this.sync();
      connected = now;
    });
    // A roster the relay confirms decides the events held for it.
    const stopRosters = session.channels.subscribeList?.(() =>
      this.releaseHeld(origin),
    );
    return () => {
      stopEvents();
      stopStatus();
      stopRosters?.();
    };
  }

  // Joins identities, records and the connections into the running and visible
  // agents, and keeps one runner per saved agent. Runners outlive edits and
  // reconnects; one is retired only when its agent is deleted, and its run is
  // aborted when the agent's type is replaced.
  private update() {
    const identities = this.identities.filter((identity) => !identity.deleted);
    const running: Agent[] = [];
    for (const identity of identities) {
      if (!this.alive(identity)) continue;
      const record = this.recordOf(identity);
      // Reuse the frozen agent while nothing visible changed, so subscribers see
      // a stable snapshot.
      const prior = this.agent(identity.pubkey);
      running.push(
        prior &&
          prior.name === identity.name &&
          prior.picture === identity.picture &&
          prior.attention === record.attention &&
          prior.skipped === (record.skipped ?? EMPTY) &&
          prior.timers === (record.timers ?? EMPTY) &&
          prior.attentionEnabled === (record.attentionEnabled === true) &&
          prior.config === record.config
          ? prior
          : this.view(identity, record),
      );
    }
    const selected = originOf(this.communities.snapshot().selected ?? "");
    const agents = [
      ...running.filter(
        (agent) => originOf(agent.relay) === selected && this.bindingOf(agent),
      ),
      ...this.listedAgents(selected),
    ];
    const types = new Map(this.types().map((type) => [type.key, type]));
    for (const [pubkey, runner] of this.runners)
      if (!identities.some((identity) => identity.pubkey === pubkey)) {
        this.retire(runner);
        this.runners.delete(pubkey);
      }
    for (const identity of identities) {
      const type = types.get(identity.type);
      const runner = this.runners.get(identity.pubkey);
      // Turning attention off voids the watch work it queued, even if it is
      // turned on again before that work would run.
      if (runner && this.records[identity.pubkey]?.attentionEnabled !== true) {
        runner.epoch++;
        runner.queue = runner.queue.filter(
          (job) => job.trigger.type !== "watch",
        );
      }
      if (!runner)
        this.runners.set(identity.pubkey, this.runner(identity, type));
      else if (runner.type !== type) {
        runner.controller.abort();
        runner.controller = new AbortController();
        runner.type = type;
        void this.drain(runner);
      }
    }
    const same = (next: readonly Agent[], prior: readonly Agent[]) =>
      next.length === prior.length &&
      next.every((agent, index) => agent === prior[index]);
    if (
      !same(agents, this.state.agents) ||
      !same(running, this.state.running)
    ) {
      this.state = Object.freeze({
        ...this.state,
        agents: Object.freeze(agents),
        running: Object.freeze(running),
      });
      this.notify();
    }
    // Resume runners whose queue paused while their community was not live,
    // and claim or release each agent as its community goes live or not, so a
    // copy of the app takes over without waiting for an event or tick.
    const ready = new Set(
      running.filter((agent) => this.bindingOf(agent)).map((a) => a.pubkey),
    );
    for (const runner of this.runners.values())
      if (
        runner.queue.length ||
        ready.has(runner.pubkey) !== this.connected.has(runner.pubkey)
      )
        void this.drain(runner);
    this.connected = ready;
  }
  private notify() {
    for (const listener of this.listeners) listener();
  }

  private runner(
    identity: AgentIdentity,
    type: RegisteredAgentType | undefined,
  ): Runner {
    return {
      pubkey: identity.pubkey,
      type,
      controller: new AbortController(),
      queue: [],
      running: false,
      windowStart: 0,
      admitted: 0,
      seen: new Set(),
      seenIn: new Map(),
      wrote: new Set(),
      held: new Map(),
      mayHold: true,
      epoch: 0,
      classifying: 0,
      classified: Promise.resolve(),
    };
  }
  private retire(runner: Runner) {
    this.localActivity.clear(undefined, runner.pubkey);
    runner.queue.length = 0;
    runner.held.clear();
    runner.controller.abort();
  }
  /** The runner's event watches for the agent's current attention. */
  private watches(runner: Runner, agent: Agent) {
    if (runner.compiled?.attention === agent.attention)
      return runner.compiled.watches;
    const watches: CompiledWatch[] = [];
    for (const object of Object.values(agent.attention)) {
      const watch = object.value;
      if (watch.type !== "event" || !watch.enabled) continue;
      const interest = agent.attention[`interest/${watch.interest_id}`]?.value;
      watches.push({
        slug: object.slug,
        watch,
        ...(interest?.type === "interest" ? { interest } : {}),
        ...(watch.filter ? { filter: compileFilter(watch.filter) } : {}),
      });
    }
    runner.compiled = { attention: agent.attention, watches };
    return watches;
  }

  /** Gives a community's live events, and replayed ones from `since` on, to
   * the agents in it. */
  private dispatch(batch: LiveBatch, origin: string, since: number) {
    for (const runner of this.runners.values()) {
      const agent = this.ready(runner.pubkey);
      if (!agent || originOf(agent.relay) !== origin || !runner.type?.run)
        continue;
      for (const event of batch.events) {
        if (batch.replay && event.created_at < since) continue;
        const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
        const seenIn = channel ? runner.seenIn.get(channel) : undefined;
        if (runner.seen.has(event.id) || seenIn?.has(event.id)) continue;
        bounded(runner.seen, event.id);
        if (channel) {
          const ids = seenIn ?? new Set<string>();
          if (!seenIn) runner.seenIn.set(channel, ids);
          bounded(ids, event.id, LIVE_REPLAY_LIMIT);
        }
        // An agent never hears itself; its own events keep reactions to them
        // from its watches.
        if (event.pubkey === agent.pubkey) {
          bounded(runner.wrote, event.id);
          continue;
        }
        this.deliver(runner, agent, event, batch.channelId);
      }
    }
  }
  /** Matches the held events of a community's agents again, as its rosters
   * change: one now confirmed wakes the watches it matches, or none. */
  private releaseHeld(origin: string) {
    for (const runner of this.runners.values()) {
      if (!runner.held.size) continue;
      const agent = this.ready(runner.pubkey);
      if (!agent || originOf(agent.relay) !== origin) continue;
      for (const [id, { event, channelId }] of [...runner.held]) {
        runner.held.delete(id);
        this.deliver(runner, agent, event, channelId);
      }
    }
  }
  private deliver(
    runner: Runner,
    agent: Agent,
    event: RelayEvent,
    channelId: string | undefined,
  ) {
    const triggers = this.heard(runner, agent, event);
    if (triggers === "held") {
      runner.held.set(event.id, { event, ...(channelId ? { channelId } : {}) });
      if (runner.held.size > HELD_LIMIT)
        runner.held.delete(runner.held.keys().next().value as string);
      return;
    }
    for (const trigger of triggers) {
      const job = {
        trigger,
        ...(channelId ? { channelId } : {}),
        ...(trigger.type === "watch"
          ? {
              matched: {
                object: agent.attention[trigger.slug] as AttentionObject,
                epoch: runner.epoch,
              },
            }
          : {}),
      };
      if (trigger.type === "watch" && trigger.watch.classifier)
        this.classified(runner, agent, { ...job, trigger });
      else this.enqueue(runner, job);
    }
  }
  /** Runs a matched watch's classifier, then queues the event if it passes.
   * The classifier runs after the watch's selectors and filter, and before the
   * event takes a queue slot, as in Janet. Without a key, or when it fails,
   * the event passes and its turn is told why. Results queue in the order the
   * events arrived, whichever call finishes first. */
  private classified(
    runner: Runner,
    agent: Agent,
    job: Job & { trigger: WatchTrigger },
  ) {
    const { trigger } = job;
    // Never bypassed: past the limit the event is dropped, like a full queue.
    if (runner.classifying >= CLASSIFY_LIMIT) {
      console.warn(`Agent ${agent.name} dropped an event to classify`);
      return;
    }
    runner.classifying++;
    const lifetime = runner.controller.signal;
    // Whether this runner, as it is now, should still act on the event.
    const live = () =>
      !lifetime.aborted &&
      this.runners.get(runner.pubkey) === runner &&
      this.stillCurrent(runner, job);
    const outcome = (async (): Promise<ClassifierOutcome | undefined> => {
      // A saved key is not known to be missing until its status is read.
      await this.jevStatus;
      const jev = this.jev;
      // While the key cannot be read, native is still asked: it may find one.
      if (!jev || this.state.classifierKey === "missing") return notRun();
      // Only the copy of the app that holds the agent sends its events out.
      if (!(await this.claim(runner)) || !live()) return undefined;
      const context = await this.context(agent, trigger.event);
      // Stopped or changed while its context was looked up: nothing is sent.
      if (!live()) return undefined;
      const { pass, result } = await classify(jev, {
        // Checked as non-null by the caller.
        classifier: trigger.watch.classifier as NonNullable<
          EventWatch["classifier"]
        >,
        event: trigger.event,
        author: {
          role: trigger.event.pubkey === agent.owner ? "owner" : "other",
          name: this.displayName(agent, trigger.event.pubkey),
        },
        context,
      });
      // The key was removed outside the app since it was read, the service
      // refused it, or native found one the failed status read could not.
      if (result.outcome === "not-run") this.setKey("missing");
      else if (result.outcome === "passed") this.setKey("saved");
      else if (result.reason === "unauthorized") this.setKey("refused");
      return pass ? result : undefined;
    })().catch((error) => {
      console.warn(`Agent ${agent.name} could not classify an event`, error);
      return undefined;
    });
    const previous = runner.classified;
    runner.classified = (async () => {
      try {
        await previous;
        const classifier = await outcome;
        // A retired or replaced runner keeps none of its work.
        if (
          classifier &&
          !lifetime.aborted &&
          this.runners.get(runner.pubkey) === runner
        )
          this.enqueue(runner, { ...job, trigger: { ...trigger, classifier } });
      } finally {
        runner.classifying--;
      }
    })();
  }
  /** The event's surroundings for the classifier, from what the app knows. */
  private async context(
    agent: Agent,
    event: RelayEvent,
  ): Promise<ClassifierContext> {
    const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
    const channels = this.bindingOf(agent)?.session.channels;
    const summary = channelId
      ? (channels?.list().channels.find((item) => item.id === channelId) ??
        channels?.get?.(channelId))
      : undefined;
    const parent = threadReference(event)?.parentId ?? null;
    let found: RelayEvent | undefined;
    if (parent)
      try {
        // Bounded: classified events release in order, so a stuck lookup
        // would hold back every later one.
        let timer: ReturnType<typeof setTimeout> | undefined;
        [found] = await Promise.race([
          this.require().query(agent.pubkey, [{ ids: [parent], limit: 1 }]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("The parent lookup timed out")),
              PARENT_LOOKUP_MS,
            );
          }),
        ]).finally(() => clearTimeout(timer));
      } catch {
        // The parent stays unknown; the classifier still runs.
      }
    return {
      channel: { name: summary?.name ?? null },
      thread: {
        is_reply: !!parent,
        parent: found
          ? {
              author: {
                role:
                  found.pubkey === agent.pubkey
                    ? "self"
                    : found.pubkey === agent.owner
                      ? "owner"
                      : "other",
                name: this.displayName(agent, found.pubkey),
              },
              content: excerpt(found.content),
            }
          : null,
      },
      mentions: mentionFacts(event.tags, agent.pubkey, agent.owner),
    };
  }
  private displayName(agent: Agent, pubkey: string) {
    return (
      this.bindingOf(agent)?.session.profiles?.snapshot().get(pubkey)?.name ??
      null
    );
  }
  /** What `event` wakes in the agent, or "held" while a watch it matches waits
   * for its channel's roster to be confirmed. */
  private heard(
    runner: Runner,
    agent: Agent,
    event: RelayEvent,
  ): Trigger[] | "held" {
    const wrote = (id: string) => runner.wrote.has(id);
    // Another of the owner's agents wakes it only by naming it, wherever: were a
    // watch enough, two agents replying to each other would never stop. The
    // claimed owner only narrows this; the type verifies it before answering.
    if (event.tags.some((tag) => tag[0] === "auth" && tag[1] === agent.owner))
      return CHAT_KINDS.includes(event.kind) && tagsAgent(event, agent.pubkey)
        ? [{ type: "mention", event }]
        : [];
    // Addressed events never reach a watch. Only conversation starts a run: not a
    // DM it cannot read yet, nor a reaction to its message.
    if (addressedTo(event, agent.pubkey, wrote))
      return CHAT_KINDS.includes(event.kind)
        ? [{ type: "mention", event }]
        : [];
    if (!agent.attentionEnabled) return [];
    const matches = this.watches(runner, agent).filter(({ watch, filter }) =>
      watchMatches(watch, event, filter),
    );
    if (!matches.length) return [];
    const member = this.member(agent, event);
    if (member === undefined) return "held";
    return member
      ? matches.map(({ filter: _, ...match }) => ({
          type: "watch",
          event,
          ...match,
        }))
      : [];
  }
  /** Whether the agent is in the event's channel, by its relay-signed roster.
   * The stream is the owner's, so a watch, even of "all", sees only what the
   * agent itself could read; an event with no channel, or whose roster is
   * unknown, wakes no watch. A roster only loaded from disk decides nothing
   * (undefined): the agent may have been removed or added since it was saved,
   * so the event waits until the relay confirms it. */
  private member(agent: Agent, event: RelayEvent): boolean | undefined {
    const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
    const channels = this.bindingOf(agent)?.session.channels;
    if (!channel || !channels) return false;
    const summary =
      channels.list().channels.find((item) => item.id === channel) ??
      channels.get?.(channel);
    if (summary?.cached) return undefined;
    return !!summary?.members?.includes(agent.pubkey);
  }
  /** The job as it should run now, or undefined when it should not run: a
   * watch's event is matched again against the agent's current attention, so
   * one turned off, disabled, removed, replaced or changed since it was
   * queued wakes nothing, even if it now matches again. */
  private current(runner: Runner, agent: Agent, job: Job): Job | undefined {
    const { trigger } = job;
    if (trigger.type !== "watch") return job;
    if (!agent.attentionEnabled) return undefined;
    if (
      !job.matched ||
      job.matched.epoch !== runner.epoch ||
      agent.attention[trigger.slug] !== job.matched.object
    )
      return undefined;
    const match = this.watches(runner, agent).find(
      ({ slug, watch, filter }) =>
        slug === trigger.slug && watchMatches(watch, trigger.event, filter),
    );
    if (!match) return undefined;
    const { filter: _, ...rest } = match;
    return {
      ...job,
      trigger: {
        type: "watch",
        event: trigger.event,
        ...rest,
        ...(trigger.classifier ? { classifier: trigger.classifier } : {}),
      },
    };
  }

  /** Whether `job`, already started, should still run: the rule `current()`
   * applies to a queued job, asked again for work a type queued itself. */
  private stillCurrent(runner: Runner, job: Job) {
    const agent = this.find(runner.pubkey);
    if (!agent) return false;
    const { trigger } = job;
    if (trigger.type === "mention") return true;
    if (trigger.type === "watch") return !!this.current(runner, agent, job);
    // A timer occurrence belongs to the object and epoch it fell due under:
    // attention off and on again, or a disable and rearm, voids it.
    const object = agent.attention[trigger.slug];
    return (
      agent.attentionEnabled &&
      !!job.matched &&
      job.matched.epoch === runner.epoch &&
      object === job.matched.object &&
      object.value.type === "timer" &&
      object.value.enabled
    );
  }

  // Spec schedule rules: occurrence k is due at armed_at + k × interval, at most one
  // runs when overdue, then the next is due interval after it ran. A timer with no
  // saved state counts what was already due as used (see timerState). Checked as a
  // run starts, so no timer has more than one occurrence waiting, and one removed,
  // disabled or expired meanwhile never runs. The longest-waiting timer runs first,
  // so one whose runs outlast its interval cannot hold back the others.
  private dueTimer(runner: Runner, agent: Agent): Job | undefined {
    // Off, timers keep their saved state; one overdue runs once when back on.
    if (!agent.attentionEnabled) return undefined;
    const now = seconds();
    const record = this.records[agent.pubkey] ?? blank(agent.pubkey);
    const prior = record.timers ?? EMPTY;
    let timers = prior;
    let next:
      | {
          slug: string;
          timer: TimerWatch;
          object: AttentionObject;
          state: TimerState;
        }
      | undefined;
    for (const object of Object.values(agent.attention)) {
      const timer = object.value;
      if (timer.type !== "timer" || !timer.enabled) continue;
      const saved = agent.timers[object.slug];
      const state = timerState(timer, saved, now);
      if (state !== saved) timers = { ...timers, [object.slug]: state };
      if (now < state.nextDue || timerSpent(timer, state, now)) continue;
      if (!next || state.nextDue < next.state.nextDue)
        next = { slug: object.slug, timer, object, state };
    }
    const ran = next && {
      ...next.state,
      used: next.state.used + 1,
      nextDue: now + next.timer.interval_secs,
    };
    if (next && ran) timers = { ...timers, [next.slug]: ran };
    if (timers !== prior)
      try {
        this.write({ ...record, timers });
      } catch (error) {
        // Unsaved, it would run again at once; it waits for storage instead.
        console.warn(`Agent ${agent.name} timer state was not saved`, error);
        return undefined;
      }
    if (!next || !ran) return undefined;
    const { slug, timer, object } = next;
    const interest = agent.attention[`interest/${timer.interest_id}`]?.value;
    return {
      trigger: {
        type: "timer",
        slug,
        timer,
        ...(interest?.type === "interest" ? { interest } : {}),
        spent: timerSpent(timer, ran, ran.nextDue),
      },
      matched: { object, epoch: runner.epoch },
    };
  }

  private enqueue(runner: Runner, job: Job) {
    const now = Date.now();
    if (now - runner.windowStart >= RATE_WINDOW_MS) {
      runner.windowStart = now;
      runner.admitted = 0;
    }
    if (runner.queue.length >= QUEUE_LIMIT || runner.admitted >= RATE_LIMIT) {
      if (runner.activityClaimed) {
        this.showWork(runner, job);
        job.work?.finish({
          ok: false,
          error:
            "Agent is busy and could not queue this request. Try again when it finishes.",
        });
      }
      console.warn(`Agent ${this.agent(runner.pubkey)?.name} dropped an event`);
      return;
    }
    runner.admitted++;
    if (runner.activityClaimed) this.showWork(runner, job);
    runner.queue.push(job);
    void this.drain(runner);
  }

  private showWork(runner: Runner, job: Job) {
    if (job.work || job.trigger.type !== "mention") return;
    const agent = this.agent(runner.pubkey);
    const scope = agent && this.bindingOf(agent)?.scope;
    const event = job.trigger.event;
    const channelId =
      job.channelId ?? event.tags.find(([key]) => key === "h")?.[1];
    if (!scope || !channelId) return;
    job.work = this.localActivity.begin({
      scope,
      agent: runner.pubkey,
      channelId,
      messageId: event.id,
      threadRootId: threadReference(event)?.rootId ?? event.id,
    });
  }

  // One run at a time per agent: events in arrival order, then a due timer.
  // Each job runs the agent as it is when the job starts. While its community's
  // session is not live the queue pauses and update() resumes it; a type that cannot run drops what is queued. A run that ignores
  // its deadline stops holding the queue when the deadline passes; it is not
  // otherwise fenced.
  private async drain(runner: Runner) {
    if (runner.running) return;
    runner.running = true;
    while (this.runners.get(runner.pubkey) === runner) {
      const agent = this.ready(runner.pubkey);
      const type = runner.type;
      const run = type?.run;
      // An agent this copy cannot run is left to another copy of the app.
      if (!agent || !type || !run) {
        if (agent) {
          this.localActivity.clear(undefined, runner.pubkey);
          runner.queue.length = 0;
        }
        await this.release(runner);
        // It may have come back into view, or gained its type, meanwhile.
        if (this.ready(runner.pubkey) !== agent || runner.type !== type)
          continue;
        break;
      }
      // Every copy of the app on this machine hears the same events; only the
      // one holding the agent runs them. Asked on every wake too, so a copy
      // takes over within a tick of the holder quitting or letting go.
      if (!(await this.claim(runner))) {
        this.localActivity.clear(undefined, runner.pubkey);
        runner.activityClaimed = false;
        runner.queue.length = 0;
        break;
      }
      // The agent or its type may have changed meanwhile.
      if (this.ready(runner.pubkey) !== agent || runner.type !== type) continue;
      runner.activityClaimed = true;
      for (const queued of runner.queue) this.showWork(runner, queued);
      const queued = runner.queue.shift();
      const job = queued
        ? this.current(runner, agent, queued)
        : this.dueTimer(runner, agent);
      if (queued && !job) continue;
      if (!job) break;
      const lifetime = runner.controller.signal;
      const signal = AbortSignal.any([
        lifetime,
        AbortSignal.timeout(type.timeoutMs ?? 60_000),
      ]);
      const handle: AgentHandle = Object.freeze({
        pubkey: agent.pubkey,
        name: agent.name,
        owner: agent.owner,
        publish: (event: AgentEventTemplate) => this.publish(runner, event),
        query: (filters: readonly object[]) =>
          this.require().query(agent.pubkey, filters),
        upload: (data: string, mime: string) =>
          this.require().upload(agent.pubkey, data, mime),
        media: (url: string) => this.require().media(agent.pubkey, url),
        remember: (slug: string, body: string, after: number) =>
          this.require().remember(agent.pubkey, slug, body, after),
        attention: this.attention(agent.pubkey),
      });
      const working = this.working(runner, job);
      const completion = Promise.resolve().then(async () => {
        const pick = await pickFor(job.trigger, agent, type);
        const team = teamPrompt(
          this.teamList,
          this.identities.filter((identity) => !identity.deleted),
          agent.pubkey,
        );
        signal.throwIfAborted();
        return run(
          Object.freeze({
            trigger: job.trigger,
            ...(job.channelId ? { channelId: job.channelId } : {}),
            agent: handle,
            config: agent.config,
            ...pick,
            ...(team ? { team } : {}),
            signal,
            workingUntil: working.hold,
            ignored: () => job.work?.remove(),
            acknowledged: () => job.work?.started(),
            superseded: () => job.work?.supersede(),
            step: (tool: string, target?: string) =>
              job.work?.step(tool, target),
            current: () => !lifetime.aborted && this.stillCurrent(runner, job),
          }),
        );
      });
      // Handover expiry releases the queue, never the actual work's outcome.
      void completion.then(
        () => working.release(),
        (error) => working.release({ ok: false, error: message(error) }),
      );
      try {
        await Promise.race([
          completion,
          new Promise<never>((_, reject) => {
            if (signal.aborted) reject(signal.reason);
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
        ]);
      } catch (error) {
        if (!lifetime.aborted)
          console.error(`Agent run failed: ${agent.name}`, error);
      }
    }
    runner.running = false;
  }

  /** Counts a run as working until it and everything it handed to
   * `workingUntil` have settled, however long that takes. A
   * mention run is shown typing on this device meanwhile; no public
   * activity is published. */
  private working(runner: Runner, { trigger, channelId, work }: Job) {
    work?.started();
    const event = trigger.type === "mention" ? trigger.event : undefined;
    const channel =
      event && (channelId ?? event.tags.find((tag) => tag[0] === "h")?.[1]);
    const done =
      event && channel
        ? [
            // STOPGAP(agent-local-typing): delete with local-typing.ts.
            typeLocally(
              () => {
                const relay = this.relay(runner.pubkey)?.snapshot();
                return relay?.status === "ready" ? relay.session : undefined;
              },
              runner.pubkey,
              event,
              channel,
            ),
          ]
        : [];
    let holds = 1;
    let outcome: WorkOutcome = { ok: true };
    const lifetime = runner.controller.signal;
    const stop = () => {
      if (holds < 0) return;
      holds = -1;
      lifetime.removeEventListener("abort", abort);
      for (const end of done) end();
    };
    const abort = () => {
      work?.remove();
      stop();
    };
    lifetime.addEventListener("abort", abort, { once: true });
    const release = (result?: unknown) => {
      if (holds <= 0) return;
      if (
        result &&
        typeof result === "object" &&
        "ok" in result &&
        result.ok === false
      ) {
        outcome = {
          ok: false,
          error:
            "error" in result
              ? String(result.error)
              : "Could not finish this request",
        };
      }
      if (--holds === 0) {
        work?.finish(outcome);
        stop();
      }
    };
    return {
      hold(pending: PromiseLike<unknown>) {
        if (holds <= 0) return;
        holds++;
        Promise.resolve(pending).then(release, (error) =>
          release({ ok: false, error: message(error) }),
        );
      },
      release,
    };
  }

  private async claim(runner: Runner) {
    try {
      runner.mayHold = (await this.native?.claim(runner.pubkey)) ?? false;
      return runner.mayHold;
    } catch (error) {
      runner.mayHold = true;
      // Answering twice beats not answering at all.
      console.warn(
        `Agent ${this.agent(runner.pubkey)?.name} was not claimed`,
        error,
      );
      return true;
    }
  }
  private async release(runner: Runner) {
    if (!runner.mayHold) return;
    runner.mayHold = false;
    await this.native
      ?.release(runner.pubkey)
      .catch((error) =>
        console.warn(`Agent ${runner.pubkey} was not released`, error),
      );
  }

  /** The agent's attention as its handle offers it. Reads the saved record
   * each call, so it is current however long the run lasts. */
  private attention(pubkey: string): AgentAttention {
    const record = () => {
      const identity = this.live(pubkey);
      if (!identity) throw new Error("No such agent on this device");
      return this.recordOf(identity);
    };
    return Object.freeze({
      enabled: () => record().attentionEnabled === true,
      classifier: () => this.classifier(),
      show: (slug: string, interest?: string) =>
        show(record(), slug, seconds(), interest),
      interests: (search?: string) => interestIds(record(), search),
      watches: (filter: WatchFilter = {}) =>
        watchSummaries(record(), filter, seconds()),
      write: async (
        slug: string,
        value: AttentionValue | null,
        options: WriteOptions,
      ) => {
        // The token is checked against the record as it is when the write
        // lands: a write that raced this one makes it check again, a few times.
        for (let attempt = 0; ; attempt++) {
          const before = record();
          const after = await checkedWrite(
            before,
            slug,
            value,
            options,
            seconds(),
          );
          if (record() !== before) {
            if (attempt < 3) continue;
            throw new AttentionError(
              "conflict",
              `${slug} is changing; show it again`,
            );
          }
          this.write(after);
          return show(after, slug, seconds());
        }
      },
    });
  }

  private require() {
    if (!this.native) throw new Error("Agents run only in the desktop app");
    return this.native;
  }
  private async publish(runner: Runner, event: AgentEventTemplate) {
    const signed = await this.require().publish(runner.pubkey, event);
    bounded(runner.wrote, signed.id);
    return signed;
  }
}
