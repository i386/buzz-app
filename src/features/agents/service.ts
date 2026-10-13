import { createLocalAgentActivity } from "./local-activity";
import { AgentRunners } from "./runner";
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
import { agentStorage } from "./state";
import { Service, type Context } from "@deepseek-ai/cordis";
import { npubEncode } from "nostr-tools/nip19";
import type { ComponentType, ReactNode } from "react";
import type { DefinedIcon } from "../../shared/design-system/icons";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";
import type { LocalAgentsSnapshot } from "./local";
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
import { relayPartition } from "../relay/partition";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import {
  parseSlug,
  type AttentionObject,
  type AttentionValue,
  type EventWatch,
  type Interest,
  type TimerState,
  type TimerWatch,
} from "./attention";
import type {
  ClassifierAvailability,
  Shown,
  WatchFilter,
  WatchSummary,
  WriteOptions,
} from "./attention-objects";
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
  persisted,
  readRecords,
  recordKey,
  readTeams,
  TEAMS_KEY,
  readUnfinished,
  setAttention,
  removeRecord,
  splitLegacyRecords,
  writeRecord,
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
export type AgentSettingsHost = Readonly<{
  /** A labelled Type control supplied only by the Agents build view. */
  typeControl?: (dirty: boolean) => ReactNode;
  /** Host-owned type change committed with the target type's settings draft. */
  pendingSave?: (config?: unknown) => Promise<void>;
}>;
/** What each of a type's settings tabs receives. A type writes only its own
 * config; the app owns the name and attention. */
/** The message's conversation a profile was opened from: its channel, and its
 * thread root when the message had one. Which session that is stays the type's
 * own rule. */
export type AgentConversation = Readonly<{
  channelId: string;
  rootId?: string;
}>;
export type AgentViewProps<Config = unknown> = {
  agent: Agent<Config>;
  /** Where the agent was opened from, when it was opened from a conversation. */
  conversation?: AgentConversation;
  /** Replaces the type's whole config. Spread `agent.config` to change one
   * field, or tabs that each save a part will erase each other's fields. A
   * hosted type's tabs save to its provider instead; for them this rejects. */
  save(config: Config): Promise<void>;
  /** Host identity/retype framing for a Settings tab. Other surfaces omit it. */
  settingsHost?: AgentSettingsHost;
};
/** What a type's part of the New agent dialog receives: the new agent's
 * starting config, from `defaults`, to fill in. The app owns its key, name and
 * picture around it. */
export type AgentCreateProps<Config = unknown> = {
  config: Config;
  onChange(config: Config): void;
  disabled: boolean;
};
export type AgentCreateModelMenuProps<Config = unknown> =
  AgentCreateProps<Config> & {
    /** Whether this provider is the create form's current selection. */
    active?: boolean;
    /** Opens Create's host-owned model-ID dialog after its menu closes. */
    requestCustomModel(
      initialValue: string,
      onChange: (model: string) => void,
    ): void;
  };
export type AgentTab<Config = unknown> = Readonly<{
  id: string;
  title: string;
  /** Lets the Agents build view place host-owned Type controls in this tab. */
  role?: "settings";
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
/** Why a classified watch's event passed without a classifier answer. */
export type ClassifierSkip = Readonly<{
  outcome: "not-run";
  reason: string;
}>;
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
      /** Set when the watch has a classifier that did not run. The event
       * passes rather than lose a match to an unavailable model, and the
       * agent is told why. */
      classifier?: ClassifierSkip;
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
export type AgentMigrationSetting = Readonly<{
  id: string;
  label: string;
  isOverride: boolean;
  /** Matching keys mean this override has the same effect after migration. */
  unchangedKey?: string;
}>;
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
export type AgentProviderSnapshot = Readonly<{
  readiness: "checking" | "ready" | "attention";
  /** Action-oriented menu copy for direct recovery or recovery guidance. */
  attentionLabel?: string;
  /** Installation and sign-in work must be cancelled before its dialog closes. */
  blocking?: boolean;
}>;
export type AgentProvider = Readonly<{
  snapshot(): AgentProviderSnapshot;
  subscribe(listener: () => void): () => void;
  /** Refreshes device-wide readiness without changing installation or auth. */
  check(): void | Promise<void>;
  /** Handles the current attention state directly; absent opens DialogBody. */
  attentionAction?: (() => void) | undefined;
  /** Provider-owned recovery/progress controls and optional saved defaults. */
  DialogBody: ComponentType<{ onClose(): void }>;
}>;
export type AgentType<Config = unknown> = {
  id: string;
  title: string;
  description?: string;
  /** Decorative design-system mark shown with this type in host-owned choices. */
  icon?: DefinedIcon;
  /** A new agent's starting config and attention objects. */
  defaults(): Readonly<{
    config: Config;
    attention?: Readonly<Record<string, AttentionValue>>;
  }>;
  /** A brought-over agent's config: `config` from `defaults` with whatever of
   * `carry` the type has a place for. Without it, all of `carry` stays behind. */
  adopt?(carry: Carry, config: Config): Config;
  /** What of `config` another type may adopt when the agent changes type.
   * Without it, all of its settings stay behind. */
  carry?(config: Config): Carry;
  /** Describes harness settings for a type-change preview. Rendered labels
   * never determine migration behavior. */
  describeMigration?(config: Config): readonly AgentMigrationSetting[];
  /** Brief runtime consequence of leaving this type. */
  migrationWarning?: string;
  /** One short line under the agent's name, e.g. its model; defaults to the title. */
  summary?(agent: Agent<Config>): string;
  /** A read-only glance shown when the agent is selected in the grid. */
  Peek?: ComponentType<AgentPeekProps<Config>>;
  /** The type's choices in the New agent dialog, such as model and
   * instructions; the new agent starts with the config it settles on. */
  Create?: ComponentType<AgentCreateProps<Config>>;
  /** Model rows contributed to this type's submenu in the New agent dialog. */
  CreateModelMenu?: ComponentType<AgentCreateModelMenuProps<Config>>;
  /** Non-default model detail appended to this type's New agent trigger. */
  createModelLabel?(config: Config): string | undefined;
  /** Device-wide readiness and management. Agents supplies the menu row,
   * provider identity, modal framing and focus behavior. */
  provider?: AgentProvider;
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
export type RetypePreview = Readonly<{
  /** Destination settings after applying the target type's migration policy. */
  config: unknown;
  moved: readonly (keyof Carry)[];
  dropped: readonly (keyof Carry)[];
  settings: readonly Readonly<{
    id: string;
    label: string;
    outcome: "reset" | "dropped";
  }>[];
}>;
export type AgentsSnapshot = Readonly<{
  status: "unavailable" | "loading" | "ready" | "error";
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
  /** Where agent types keep what they save for an agent, such as its
   * sessions. Every program that runs this machine's agents shares it, so
   * keep each agent's state under its own key. */
  readonly storage: Storage;
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
  /** Previews the destination config and transferable settings the same
   * migration used by `retype` will produce, without changing the agent. */
  previewRetype(pubkey: string, type: string): RetypePreview;
  /** Makes it an agent of `type`, keeping its identity and attention. Its new
   * config is the type's defaults with whatever the old type carries and the
   * new one adopts, or the reviewed destination draft; returns what of the old
   * config stayed behind. Refused mid-turn. */
  retype(
    pubkey: string,
    type: string,
    change?: Readonly<{ config: unknown }>,
  ): Promise<readonly (keyof Carry)[]>;
  /** Deletes its key at once. Leaving its channels and archiving it follow in
   * the background whenever its community is open. A hosted agent is archived,
   * leaves its channels and is removed from its provider before this resolves.
   * One on another device is deleted there. */
  remove(pubkey: string): Promise<void>;
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

/** Bounds one cleanup attempt, whose relay steps otherwise wait on the outbox. */
const CLEANUP_TIMEOUT_MS = 60_000;
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
export { fromOwner } from "./owner-attestation";

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

export class AgentsService extends Service implements Agents {
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
  private readonly runners: AgentRunners;
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
    readonly storage: Storage = agentStorage(),
    private readonly authorize: (
      pubkey: string,
      signal: AbortSignal,
    ) => Promise<NipOaAuthorization> = prepareRemoteAgentAuthorization,
    localActivity = createLocalAgentActivity(),
  ) {
    super(ctx, "agents");
    this.contributions = createContributions<AgentType>(ctx);
    migrateAgentStorage(storage);
    this.records = readRecords(storage);
    splitLegacyRecords(storage, this.records);
    this.unfinished = Object.freeze(readUnfinished(storage));
    this.teamList = Object.freeze(readTeams(storage));
    this.state = Object.freeze({
      status: native ? "loading" : "unavailable",
      agents: [],
      running: [],
      teams: this.teamList,
    });
    this.runners = new AgentRunners({
      ready: (pubkey) => this.ready(pubkey),
      agent: (pubkey) => this.agent(pubkey),
      find: (pubkey) => this.find(pubkey),
      member: (agent, event) => this.member(agent, event),
      scope: (agent) => this.bindingOf(agent)?.scope,
      saved: (pubkey) => this.records[pubkey],
      record: (pubkey) => {
        const identity = this.live(pubkey);
        if (!identity) throw new Error("No such agent on this device");
        return this.recordOf(identity);
      },
      // A failed save logs; the run's memory keeps it from running again.
      write: (record) => {
        void this.write(record).catch((error) =>
          console.warn(`Agent ${record.pubkey} state was not saved`, error),
        );
      },
      team: (pubkey) =>
        teamPrompt(
          this.teamList,
          this.identities.filter((identity) => !identity.deleted),
          pubkey,
        ),
      classifier: () => this.classifier(),
      custody: native,
      activity: localActivity,
      typing: (pubkey, event, channel) =>
        // STOPGAP(agent-local-typing): delete with local-typing.ts.
        typeLocally(
          () => {
            const relay = this.relay(pubkey)?.snapshot();
            return relay?.status === "ready" ? relay.session : undefined;
          },
          pubkey,
          event,
          channel,
        ),
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
      // Wakes each runner, which starts any timer that is due.
      const tick = setInterval(() => {
        this.runners.tick();
        this.reconnect();
      }, TIMER_TICK_MS);
      return () => {
        clearInterval(tick);
        // A list still being read is stale: it must not reopen communities.
        this.listed++;
        for (const stop of stops) stop();
        for (const origin of [...this.bound.keys()]) this.unbind(origin);
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
      const listed = recordPicture(picture);
      if (picture && !listed)
        console.warn(`Agent ${name.trim()} picture is not an HTTPS image URL`);
      return this.provision(type, remote, name.trim(), listed);
    }
    return this.add(
      type,
      async (native, destination, owner) => ({
        agent: await native.create(destination, owner, type, name.trim()),
      }),
      { config, picture },
    );
  }
  /** Whether watch classifiers can run on this device. */
  private classifier = (): ClassifierAvailability => "unavailable";

  /** Has the provider make the agent, then sets it up. From here on it is
   * kept, unfinished until set up, so a failure never makes a second one. */
  private async provision(
    type: string,
    remote: RemoteAgentType,
    name: string,
    picture: string | undefined,
  ) {
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
      {
        pubkey,
        type,
        name,
        relay: community,
        owner: binding.viewer,
        ...(picture ? { picture } : {}),
      },
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
    const { picture } = setup;
    await this.writeListing(origin, binding, {
      pubkey,
      name: setup.name,
      ...(picture ? { picture } : {}),
      runtime: setup.type,
      prior: this.rowOf(origin, pubkey)?.prior,
    });
    this.writeUnfinished(this.unfinished.filter((entry) => entry !== setup));
    const agent = this.find(pubkey);
    if (!agent) throw new Error("The agent was set up in another community");
    // Listed with its picture either way; its own profile is the provider's.
    if (picture)
      await remote
        .profile({
          pubkey,
          community: setup.relay,
          name: setup.name,
          picture,
          signal,
        })
        .catch((error: unknown) =>
          console.warn(`Agent ${setup.name} picture was not published`, error),
        );
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
      await this.write(record);
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
    if (change.config !== undefined && this.runners.transitioning(pubkey))
      throw new Error(`${identity.name}'s provider is already changing`);
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
      await this.write(record);
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

  async retype(
    pubkey: string,
    type: string,
    change?: Readonly<{ config: unknown }>,
  ) {
    const identity = this.live(pubkey);
    if (!this.native || !identity)
      throw new Error("No such agent on this device");
    const kinds = new Map(this.types().map((kind) => [kind.key, kind]));
    const kind = kinds.get(type);
    if (!kind) throw new Error("That agent type is not available");
    if (kind.remote)
      throw new Error("A hosted provider cannot take over a local agent key");
    if (type === identity.type) return [];
    const native = this.native;
    return this.runners.retype(pubkey, identity.name, async () => {
      const { adopted, preview } = this.retypePlan(
        identity,
        kinds.get(identity.type),
        kind,
      );
      await native.setType(pubkey, type);
      try {
        const nextRecord = {
          ...this.recordOf(identity),
          config: change ? change.config : adopted,
        };
        // Only this agent's key: others may be another program's to change.
        writeRecord(this.storage, nextRecord);
        await persisted(this.storage, recordKey(pubkey));
        // Publish the in-memory pair only after its config is durable.
        this.records = { ...this.records, [pubkey]: nextRecord };
        this.identities = this.identities.map((saved) =>
          saved.pubkey === pubkey ? { ...saved, type } : saved,
        );
        this.update();
      } catch (error) {
        try {
          await native.setType(pubkey, identity.type);
        } catch (rollback) {
          throw new AggregateError(
            [error, rollback],
            `Could not save or restore ${identity.name}'s provider`,
          );
        }
        throw error;
      }
      await this.refresh();
      return preview.dropped;
    });
  }

  previewRetype(pubkey: string, type: string): RetypePreview {
    const identity = this.live(pubkey);
    if (!this.native || !identity)
      throw new Error("No such agent on this device");
    const kinds = new Map(this.types().map((kind) => [kind.key, kind]));
    const kind = kinds.get(type);
    if (!kind) throw new Error("That agent type is not available");
    if (kind.remote)
      throw new Error("A hosted provider cannot take over a local agent key");
    if (type === identity.type)
      return {
        config: this.recordOf(identity).config,
        moved: [],
        dropped: [],
        settings: [],
      };
    return this.retypePlan(identity, kinds.get(identity.type), kind).preview;
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
    await this.writeTeams(
      id
        ? this.teamList.map((saved) => (saved.id === id ? team : saved))
        : [...this.teamList, team],
    );
    return team;
  }

  async removeTeam(id: string) {
    await this.writeTeams(this.teamList.filter((team) => team.id !== id));
  }

  /** Saves the teams; memory changes once storage has taken them, and the
   * promise settles once they are saved. */
  private writeTeams(teams: readonly Team[]) {
    writeTeams(this.storage, teams);
    this.teamList = Object.freeze(teams);
    this.state = Object.freeze({ ...this.state, teams: this.teamList });
    this.notify();
    return persisted(this.storage, TEAMS_KEY);
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
            ...(setup.picture ? { picture: setup.picture } : {}),
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

  /** Saves one record; memory changes once storage has taken it, and the
   * promise settles once it is saved. A failed save keeps memory as it is:
   * an agent's timers must not run again because their progress was lost. */
  private write(record: AgentRecord) {
    // Only this agent's key: others may be another program's to change.
    writeRecord(this.storage, record);
    this.records = { ...this.records, [record.pubkey]: record };
    this.update();
    return persisted(this.storage, recordKey(record.pubkey));
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
  private retypePlan(
    identity: AgentIdentity,
    source: RegisteredAgentType | undefined,
    kind: RegisteredAgentType,
  ) {
    const record = this.recordOf(identity);
    const carry = source?.carry?.(record.config) ?? {};
    const { config } = kind.defaults();
    const adopted = kind.adopt ? kind.adopt(carry, config) : config;
    const kept = kind.carry?.(adopted) ?? {};
    const keys = (Object.keys(carry) as (keyof Carry)[]).filter(
      (key) => carry[key] !== undefined,
    );
    const moved = keys.filter((key) => kept[key] === carry[key]);
    const dropped = keys.filter((key) => kept[key] !== carry[key]);
    const destinationSettings = new Map(
      kind.describeMigration?.(adopted).map((setting) => [setting.id, setting]),
    );
    const settings =
      source
        ?.describeMigration?.(record.config)
        .filter((setting) => setting.isOverride)
        .flatMap((setting) => {
          const next = destinationSettings.get(setting.id);
          if (
            next &&
            setting.unchangedKey !== undefined &&
            setting.unchangedKey === next.unchangedKey
          )
            return [];
          return [
            {
              id: setting.id,
              label: setting.label,
              outcome: next ? ("reset" as const) : ("dropped" as const),
            },
          ];
        }) ?? [];
    return {
      record,
      adopted,
      preview: {
        config: adopted,
        moved,
        dropped,
        settings,
      },
    };
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
   * then read back here, so the list has one source; Retry reads it again. */
  async refresh() {
    if (!this.native) return;
    const turn = ++this.listed;
    try {
      const identities = await this.native.list();
      // A newer list is on its way; this one may predate a change.
      if (turn !== this.listed) return;
      this.identities = identities;
      // A read that succeeds ends the failure the last one reported.
      const { error: _, ...state } = this.state;
      this.state = Object.freeze({ ...state, status: "ready" });
      // Settings whose agent is gone do nothing.
      const live = new Set(
        identities
          .filter((saved) => !saved.deleted)
          .map((saved) => saved.pubkey),
      );
      const gone = Object.keys(this.records).filter(
        (pubkey) => !live.has(pubkey),
      );
      if (gone.length) {
        for (const pubkey of gone) removeRecord(this.storage, pubkey);
        this.records = Object.fromEntries(
          Object.entries(this.records).filter(([pubkey]) => live.has(pubkey)),
        );
      }
      // A deleted agent leaves its teams; the teams stay.
      if (
        this.teamList.some((team) =>
          team.members.some((pubkey) => !live.has(pubkey)),
        )
      )
        void this.writeTeams(
          this.teamList.map((team) => ({
            ...team,
            members: team.members.filter((pubkey) => live.has(pubkey)),
          })),
        ).catch((error) => console.warn("Agent teams were not saved", error));
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
   * connection recovers, which happens within the same session. */
  private listen(session: RelaySession, origin: string) {
    let connected = session.live.snapshot().status === "connected";
    const stopEvents = session.subscribeLive((batch) =>
      this.runners.dispatch(batch, (agent) => originOf(agent.relay) === origin),
    );
    const stopStatus = session.live.subscribe(() => {
      const now = session.live.snapshot().status === "connected";
      if (now && !connected) this.sync();
      connected = now;
    });
    return () => {
      stopEvents();
      stopStatus();
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
          prior.type === identity.type &&
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
    this.runners.reconcile(
      identities,
      new Map(this.types().map((type) => [type.key, type])),
    );
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
    this.runners.resume(
      new Set(
        running.filter((agent) => this.bindingOf(agent)).map((a) => a.pubkey),
      ),
    );
  }
  private notify() {
    for (const listener of this.listeners) listener();
  }
  /** Whether the agent is in the event's channel, by its relay-signed roster.
   * The stream is the owner's, so a watch, even of "all", sees only what the
   * agent itself could read; an event with no channel, or whose roster is
   * unknown, wakes no watch. */
  private member(agent: Agent, event: RelayEvent) {
    const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
    const channels = this.bindingOf(agent)?.session.channels;
    if (!channel || !channels) return false;
    const summary =
      channels.list().channels.find((item) => item.id === channel) ??
      channels.get?.(channel);
    return !!summary?.members?.includes(agent.pubkey);
  }
}
