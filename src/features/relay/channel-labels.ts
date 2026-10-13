import { tag, type RelayEvent } from "./events.ts";

/** NIP-CL channel labels: grouping hints any channel admin can set. Never trust. */
export const MAX_CHANNEL_LABELS = 8;
const CHANNEL_TYPES = new Set(["stream", "forum", "dm", "workflow", "system"]);
const LABEL = /^[a-z0-9.:-]{1,64}$/;

/** Refusal for NIP-CL writes and lookups on a relay that does not advertise
 * `nip-cl`. Such a relay drops label tags, so nothing is sent. */
export function channelIdentityUnsupported(): Error {
  return new Error(
    "This community's relay does not support channel labels or system channels yet.",
  );
}

/** A label must not equal a channel type, so it cannot make a channel look like another type. */
export function validChannelLabel(value: unknown): value is string {
  return (
    typeof value === "string" && LABEL.test(value) && !CHANNEL_TYPES.has(value)
  );
}

/** Canonical label tags for kind:9007 and kind:9002: deduplicated, in caller order. */
export function channelLabelTags(labels: readonly string[]): string[][] {
  const unique = [...new Set(labels)];
  if (unique.length > MAX_CHANNEL_LABELS)
    throw new Error(`Use at most ${MAX_CHANNEL_LABELS} channel labels.`);
  for (const label of unique)
    if (!validChannelLabel(label))
      throw new Error(
        "Use channel labels of 1–64 characters from a-z, 0-9, '.', ':' and '-', other than a channel type name.",
      );
  return unique.map((label) => ["t", label]);
}

/** Relay-written identity facts on kind:39000–39003. The first `t` tag is the
 * channel type; later `t` tags are labels. `P` is the creator, `created_at`
 * (39000 only) is the creation time. */
export function channelIdentity(event: RelayEvent): Readonly<{
  type?: string;
  labels: readonly string[];
  creator?: string;
  createdAt?: number;
}> {
  const [type, ...labels] = event.tags.flatMap(([name, value]) =>
    name === "t" && typeof value === "string" ? [value] : [],
  );
  const creator = tag(event, "P");
  const created = tag(event, "created_at");
  const createdAt =
    created !== undefined && /^(?:0|[1-9]\d{0,15})$/.test(created)
      ? Number(created)
      : undefined;
  return Object.freeze({
    ...(type ? { type } : {}),
    labels: Object.freeze(labels.filter(validChannelLabel)),
    ...(creator && /^[0-9a-f]{64}$/.test(creator) ? { creator } : {}),
    ...(createdAt !== undefined && Number.isSafeInteger(createdAt)
      ? { createdAt }
      : {}),
  });
}

/** NIP-CL oldest-channel rule: lowest `created_at` tag, then lowest ID. A
 * channel without a creation time ranks after every channel that has one. */
export function compareChannelAge(
  a: Readonly<{ id: string; createdAt?: number | undefined }>,
  b: Readonly<{ id: string; createdAt?: number | undefined }>,
): number {
  if (a.createdAt !== b.createdAt) {
    if (a.createdAt === undefined) return 1;
    if (b.createdAt === undefined) return -1;
    return a.createdAt - b.createdAt;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
