// Saved catch-up progress for event watches of kind 9 only, as Janet keeps it:
// one stream for each watch and channel, read a page at a time from the
// newest event to the oldest. Only the progress is saved, never an event.
import type { Agent } from "./service";
import type { EventData, ReadFilter } from "../relay/events";

export const CATCH_UP_KEY = "buzz.agents.catch-up.v1";
/** Events in one read, as Janet's catch-up pages are. */
export const CATCH_UP_PAGE = 16;

/** Every kind 9 event of the stream created at or before `through` was
 * delivered. While a window (`through`, `upper`] is being read, `cursor` is
 * the oldest event of the last page delivered, so a restart goes on below it. */
export type Checkpoint = Readonly<{
  through: number;
  upper?: number;
  cursor?: Readonly<{ until: number; before_id: string }>;
}>;
export type Checkpoints = Readonly<Record<string, Checkpoint>>;
/** One watch's history in one channel, or in every channel it may read. */
export type Stream = Readonly<{
  key: string;
  slug: string;
  channel?: string;
  since: number;
  enabled: boolean;
}>;

const time = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const ID = /^[0-9a-f]{64}$/;

export function readCheckpoints(storage: Storage): Checkpoints {
  let stored: unknown;
  try {
    stored = JSON.parse(storage.getItem(CATCH_UP_KEY) ?? "null");
  } catch {
    return {};
  }
  const streams =
    (stored as { version?: unknown; streams?: unknown } | null)?.version === 1
      ? (stored as { streams: unknown }).streams
      : undefined;
  if (!streams || typeof streams !== "object") return {};
  const checkpoints: Record<string, Checkpoint> = {};
  for (const [key, value] of Object.entries(streams)) {
    const { through, upper, cursor } = (value ?? {}) as Checkpoint;
    if (
      !time(through) ||
      (upper !== undefined && !(time(upper) && upper > through))
    )
      continue;
    const valid =
      cursor === undefined ||
      (upper !== undefined &&
        time(cursor.until) &&
        cursor.until > through &&
        cursor.until <= upper &&
        ID.test(cursor.before_id));
    if (!valid) continue;
    checkpoints[key] = {
      through,
      ...(upper !== undefined ? { upper } : {}),
      ...(cursor
        ? { cursor: { until: cursor.until, before_id: cursor.before_id } }
        : {}),
    };
  }
  return checkpoints;
}

export function writeCheckpoints(storage: Storage, checkpoints: Checkpoints) {
  storage.setItem(
    CATCH_UP_KEY,
    JSON.stringify({ version: 1, streams: checkpoints }),
  );
}

/** The agent's streams: one for each channel of each event watch whose kinds
 * are exactly [9], enabled or not. Other kinds have reconnect replay only, as
 * in Janet. */
export function streamsOf(agent: Pick<Agent, "pubkey" | "attention">) {
  const streams: Stream[] = [];
  for (const { slug, value } of Object.values(agent.attention)) {
    if (value.type !== "event") continue;
    if (value.kinds.length !== 1 || value.kinds[0] !== 9) continue;
    for (const channel of value.channels === "all"
      ? [undefined]
      : value.channels)
      streams.push({
        key: JSON.stringify([agent.pubkey, slug, channel ?? null]),
        slug,
        ...(channel ? { channel } : {}),
        since: value.since,
        enabled: value.enabled,
      });
  }
  return streams;
}
/** The read for the stream's next page, or undefined once it is read through
 * `upper`. A window read only in part goes on below its cursor, up to its own
 * upper bound, which may be older than `upper`. */
export function nextPage(
  stream: Stream,
  saved: Checkpoint | undefined,
  upper: number,
): { filter: ReadFilter; window: number; checkpoint: Checkpoint } | undefined {
  const checkpoint = saved ?? { through: stream.since - 1 };
  const floor = Math.max(stream.since, checkpoint.through + 1);
  const window = checkpoint.upper ?? upper;
  if (floor > window) return undefined;
  return {
    window,
    checkpoint,
    filter: {
      kinds: [9],
      ...(stream.channel ? { "#h": [stream.channel] } : {}),
      since: floor,
      until: checkpoint.cursor?.until ?? window,
      ...(checkpoint.cursor ? { before_id: checkpoint.cursor.before_id } : {}),
      limit: CATCH_UP_PAGE,
    },
  };
}

/** The checkpoint after `page`, which `read` returned for `filter`: below its
 * oldest event, or, after an empty page, through the whole window. The relay
 * returns the newest first, ties by id ascending; a page that does not move
 * below the cursor is refused, so a bad relay cannot loop catch-up. */
export function afterPage(
  { filter, window, checkpoint }: NonNullable<ReturnType<typeof nextPage>>,
  page: readonly Pick<EventData, "id" | "created_at">[],
): Checkpoint {
  if (!page.length) return { through: window };
  const last = page.at(-1) as Pick<EventData, "id" | "created_at">;
  const until = filter.until as number;
  const below =
    last.created_at < until ||
    (last.created_at === until &&
      (filter.before_id === undefined || last.id > filter.before_id));
  if (!below || last.created_at < (filter.since as number))
    throw new Error("The relay returned a page out of order");
  return {
    through: checkpoint.through,
    upper: window,
    cursor: { until: last.created_at, before_id: last.id },
  };
}
