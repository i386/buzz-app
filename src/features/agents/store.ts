// Device-local settings for agents: each agent's attention objects in the
// `agent-attention/v1` shape, one JSON blob its plugin type owns, and its timers'
// run state. Which agents exist, their type and name, and their keys live in
// native custody, never here; a record without an identity does nothing. A
// relay-backed store can replace this later without changing the record shape.
import {
  OBJECT_LIMIT,
  timerState,
  validateObject,
  type AttentionObject,
  type AttentionValue,
  type TimerState,
  type TimerWatch,
} from "./attention";

/** An object a reader cannot apply, kept as it was stored so it can be fixed. */
export type SkippedObject = Readonly<{
  slug: string;
  value: unknown;
  modifiedAt: number;
  problem: string;
}>;
export type AgentRecord = Readonly<{
  pubkey: string;
  /** Keyed by slug (`interest/<id>` or `watch/<id>`). */
  attention: Readonly<Record<string, AttentionObject>>;
  /** Stored objects that are invalid or over a limit. They do nothing, and stay
   * stored until they are fixed or removed. */
  skipped?: Readonly<Record<string, SkippedObject>>;
  /** Plugin-owned config. The host never reads it. */
  config: unknown;
  /** True when the owner turned attention on. Off, its watches and timers
   * stay stored but wake nothing, and the agent is not offered attention
   * tools. Absent means off, so an agent has no attention until its owner
   * turns it on. */
  attentionEnabled?: boolean;
  /** Run state of its timers, by slug. Not config, so it never leaves the device;
   * kept here so removing a timer or the agent removes its state with it. */
  timers?: Readonly<Record<string, TimerState>>;
}>;
type Stored = { version: 1; agents: Record<string, AgentRecord> };

/** Where records were kept, all in one value, before each had its own key. */
export const STORAGE_KEY = "buzz.agents.v1";
/** Each agent's record has its own key, so programs that run different
 * agents and share this storage never write over each other's records. */
export const RECORD_PREFIX = "buzz.agent.v1:";
export const recordKey = (pubkey: string) => `${RECORD_PREFIX}${pubkey}`;
const PUBKEY = /^[0-9a-f]{64}$/;
const group = (value: AttentionValue) =>
  value.type === "interest" ? "Interests" : "watches and timers";

/** Reads every record. An attention object a reader would not apply is skipped
 * and reported, never dropped. */
export function readRecords(storage: Storage): Record<string, AgentRecord> {
  const stored: Record<string, AgentRecord> = { ...legacyRecords(storage) };
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(RECORD_PREFIX)) continue;
    const record = parsed(storage.getItem(key));
    if (record) stored[key.slice(RECORD_PREFIX.length)] = record as AgentRecord;
  }
  const records: Record<string, AgentRecord> = {};
  for (const [pubkey, record] of Object.entries(stored)) {
    const read = readRecord(pubkey, record);
    if (read) records[pubkey] = read;
  }
  return records;
}

/** The agent's record as now stored, or undefined when it has none. */
export function readOne(
  storage: Storage,
  pubkey: string,
): AgentRecord | undefined {
  const record =
    parsed(storage.getItem(recordKey(pubkey))) ??
    legacyRecords(storage)[pubkey];
  return record ? readRecord(pubkey, record as AgentRecord) : undefined;
}

function parsed(text: string | null): unknown {
  try {
    return JSON.parse(text ?? "null");
  } catch {
    return undefined;
  }
}

function legacyRecords(storage: Storage): Record<string, AgentRecord> {
  const stored = parsed(storage.getItem(STORAGE_KEY));
  if (
    !stored ||
    typeof stored !== "object" ||
    (stored as Stored).version !== 1 ||
    typeof (stored as Stored).agents !== "object"
  )
    return {};
  return (stored as Stored).agents;
}

function readRecord(
  pubkey: string,
  record: AgentRecord | undefined,
): AgentRecord | undefined {
  if (!PUBKEY.test(pubkey) || record?.pubkey !== pubkey) return undefined;
  const attention: Record<string, AttentionObject> = {};
  const skipped: Record<string, SkippedObject> = {};
  const counts = { Interests: 0, "watches and timers": 0 };
  const entries = Object.entries(record.attention ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const [slug, object] of entries) {
    const modifiedAt = Number.isSafeInteger(object?.modifiedAt)
      ? object.modifiedAt
      : 0;
    let problem =
      object?.slug === slug
        ? validateObject(slug, object.value)
        : "Stored under another slug";
    if (!problem) {
      const kind = group(object.value);
      if (++counts[kind] > OBJECT_LIMIT)
        problem = `Over the limit of ${OBJECT_LIMIT} ${kind}`;
    }
    if (problem)
      skipped[slug] = { slug, value: object?.value, modifiedAt, problem };
    else attention[slug] = { slug, value: object.value, modifiedAt };
  }
  const timers: Record<string, TimerState> = {};
  for (const [slug, state] of Object.entries(record.timers ?? {}))
    if (
      attention[slug]?.value.type === "timer" &&
      [state?.armedAt, state?.nextDue, state?.used].every(Number.isSafeInteger)
    )
      timers[slug] = state;
  return {
    pubkey,
    attention,
    skipped,
    config: record.config,
    timers,
    ...(record.attentionEnabled === true ? { attentionEnabled: true } : {}),
  };
}

type Saving = { saved?: (key?: string) => Promise<void> };

/** Settles once `key`'s value in `storage`, or without a key every value it
 * holds, is saved: agent storage files (state.ts) save after they are set,
 * other storage as it is set. */
export function persisted(storage: Storage, key?: string): Promise<void> {
  const { saved } = storage as Saving;
  return typeof saved === "function"
    ? saved.call(storage, key)
    : Promise.resolve();
}

/** Runs `then` once these keys' values are saved: at once for storage that
 * saves as it is set, else later, and not at all if one failed. A move that
 * removes its source this way never leaves no saved copy. */
export function afterSaved(
  storage: Storage,
  keys: readonly string[],
  then: () => void,
  failed: (error: unknown) => void,
) {
  if (typeof (storage as Saving).saved !== "function") return then();
  void Promise.all(keys.map((key) => persisted(storage, key))).then(
    then,
    failed,
  );
}

/** Moves records from the old value that held every agent into one key per
 * agent, then removes it. Only that move writes many records at once: after
 * it, each save writes only its own agent's key, so a program that runs
 * other agents from the same storage keeps its changes. */
export function splitLegacyRecords(
  storage: Storage,
  records: Readonly<Record<string, AgentRecord>>,
) {
  if (storage.getItem(STORAGE_KEY) === null) return;
  for (const record of Object.values(records)) writeRecord(storage, record);
  // The shared value goes only once every record is saved: until then it is
  // the only saved copy, and a record of an agent's own wins when both are.
  afterSaved(
    storage,
    Object.keys(records).map(recordKey),
    () => storage.removeItem(STORAGE_KEY),
    (error) => console.error("Agent records were not split", error),
  );
}

/** Removes an agent's record. */
export function removeRecord(storage: Storage, pubkey: string) {
  storage.removeItem(recordKey(pubkey));
}

/** Saves one record, when it changed. */
export function writeRecord(
  storage: Storage,
  { skipped, ...record }: AgentRecord,
) {
  // Skipped objects go back where they were read from, so a later reader that
  // can apply them still finds them.
  const text = JSON.stringify({
    ...record,
    attention: {
      ...Object.fromEntries(
        Object.values(skipped ?? {}).map(({ problem: _, ...object }) => [
          object.slug,
          object,
        ]),
      ),
      ...record.attention,
    },
  });
  const key = recordKey(record.pubkey);
  if (storage.getItem(key) !== text) storage.setItem(key, text);
}

/** Replaces or deletes (`value: null`) one attention object, after validating it
 * and the count limits. A timer keeps its run state while its `armed_at` is
 * unchanged, as Janet's do: a new interval applies from its next run, and
 * enabling it again runs at most one overdue occurrence. A new `armed_at` (a
 * rearm) sets a new deadline, one interval after it, and keeps the occurrences
 * already used. Only a timer with no saved state counts what was already due.
 * `schedule` overrides that for a timer: `rearm` always sets the new deadline,
 * even at the same `armed_at`, and `restart` also gives it a fresh budget, as
 * the owner's "Run again" does. */
export function setAttention(
  record: AgentRecord,
  slug: string,
  value: AttentionValue | null,
  now = Math.floor(Date.now() / 1000),
  schedule?: "rearm" | "restart",
): AgentRecord {
  const prior = record.attention[slug]?.value;
  const { [slug]: _, ...rest } = record.attention;
  const { [slug]: __, ...skipped } = record.skipped ?? {};
  const { [slug]: state, ...timers } = record.timers ?? {};
  if (value === null) return { ...record, attention: rest, skipped, timers };
  const problem = validateObject(slug, value);
  if (problem) throw new Error(problem);
  const kind = group(value);
  if (
    !prior &&
    Object.values(rest).filter((object) => group(object.value) === kind)
      .length >= OBJECT_LIMIT
  )
    throw new Error(`An agent can have at most ${OBJECT_LIMIT} ${kind}`);
  const kept =
    value.type === "timer"
      ? {
          ...timers,
          [slug]:
            state && prior?.type === "timer"
              ? rearmed(value, state, schedule)
              : timerState(value, undefined, now),
        }
      : timers;
  return {
    ...record,
    attention: { ...rest, [slug]: { slug, value, modifiedAt: now } },
    skipped,
    timers: kept,
  };
}

/** A group of the owner's agents and the text its members share. Membership
 * lives only here: an agent records nothing about its teams. */
export type Team = Readonly<{
  id: string;
  name: string;
  instructions: string;
  /** Agent pubkeys, in the order shown. */
  members: readonly string[];
}>;
export const TEAMS_KEY = "buzz.agents.teams.v1";

/** Reads every team, skipping any that is not one. */
export function readTeams(storage: Storage): readonly Team[] {
  let stored: unknown;
  try {
    stored = JSON.parse(storage.getItem(TEAMS_KEY) ?? "null");
  } catch {
    return [];
  }
  const teams =
    (stored as { version?: unknown; teams?: unknown } | null)?.version === 1
      ? (stored as { teams: unknown }).teams
      : undefined;
  if (!Array.isArray(teams)) return [];
  return teams.flatMap((team: Partial<Team> | null) =>
    typeof team?.id === "string" &&
    typeof team.name === "string" &&
    typeof team.instructions === "string" &&
    Array.isArray(team.members)
      ? [
          {
            id: team.id,
            name: team.name,
            instructions: team.instructions,
            members: team.members.filter((member) => PUBKEY.test(member)),
          },
        ]
      : [],
  );
}

export function writeTeams(storage: Storage, teams: readonly Team[]) {
  storage.setItem(TEAMS_KEY, JSON.stringify({ version: 1, teams }));
}

/** A hosted agent its provider made whose setup has not finished. Kept so
 * Finish setup continues it instead of the provider making another. */
export type Unfinished = Readonly<{
  pubkey: string;
  /** The agent type's key, `pluginId/typeId`. */
  type: string;
  name: string;
  /** Its `wss://` community. */
  relay: string;
  owner: string;
  /** The HTTPS image URL it was made with, listed once it is set up. */
  picture?: string;
}>;
export const UNFINISHED_KEY = "buzz.agents.unfinished.v1";

/** Reads every unfinished setup, skipping any that is not one. */
export function readUnfinished(storage: Storage): readonly Unfinished[] {
  let stored: unknown;
  try {
    stored = JSON.parse(storage.getItem(UNFINISHED_KEY) ?? "null");
  } catch {
    return [];
  }
  const agents =
    (stored as { version?: unknown } | null)?.version === 1
      ? (stored as { agents: unknown }).agents
      : undefined;
  if (!Array.isArray(agents)) return [];
  return agents.flatMap((agent: Partial<Unfinished> | null) =>
    PUBKEY.test(agent?.pubkey ?? "") &&
    PUBKEY.test(agent?.owner ?? "") &&
    typeof agent?.type === "string" &&
    typeof agent.name === "string" &&
    typeof agent.relay === "string"
      ? [
          {
            pubkey: agent.pubkey as string,
            type: agent.type,
            name: agent.name,
            relay: agent.relay,
            owner: agent.owner as string,
            ...(typeof agent.picture === "string"
              ? { picture: agent.picture }
              : {}),
          },
        ]
      : [],
  );
}

export function writeUnfinished(
  storage: Storage,
  agents: readonly Unfinished[],
) {
  storage.setItem(UNFINISHED_KEY, JSON.stringify({ version: 1, agents }));
}

/** `state` for the edited `timer`: unchanged unless it was rearmed. */
function rearmed(
  timer: TimerWatch,
  state: TimerState,
  schedule?: "rearm" | "restart",
): TimerState {
  if (!schedule && state.armedAt === timer.armed_at) return state;
  return {
    armedAt: timer.armed_at,
    nextDue: timer.armed_at + timer.interval_secs,
    used: schedule === "restart" ? 0 : state.used,
  };
}
