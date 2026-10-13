// What an agent's turns read of its community on a standalone host: every read
// is made as the agent, through its own signed requests, so a turn sees only
// what the agent may see.
import type { BuzzClient, Filter } from "../buzz-mcp/client";
import type { AgentReads, ChannelFacts } from "../features/agents/reads";
import {
  type EventData,
  eventsDto,
  newer,
  type RelayEvent,
} from "../features/relay/events";

const tagOf = (event: EventData, name: string) =>
  event.tags.find((tag) => tag[0] === name)?.[1];
const newest = (events: readonly EventData[], kind: number) =>
  events
    .filter((event) => event.kind === kind)
    .sort((a, b) => b.created_at - a.created_at)[0];

/** Channel metadata's name: its content body overrides the tag. */
function channelName(event: EventData) {
  try {
    const body = JSON.parse(event.content) as { name?: unknown };
    if (typeof body?.name === "string" && body.name) return body.name;
  } catch {}
  return tagOf(event, "name") || undefined;
}

const abortable = <T>(work: Promise<T>, signal?: AbortSignal) => {
  if (!signal) return work;
  signal.throwIfAborted();
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    ),
  ]);
};

/** The key the community signs workflow messages with: its NIP-11 `self`, as
 * the app reads it (`connectNativeTransport`). */
export async function relaySelf(relay: string) {
  const response = await fetch(relay.replace(/^ws/, "http"), {
    headers: { accept: "application/nostr+json" },
  });
  if (!response.ok)
    throw new Error(`Community information: ${response.status}`);
  const self = ((await response.json()) as { self?: unknown } | null)?.self;
  if (typeof self !== "string" || !/^[a-f0-9]{64}$/.test(self))
    throw new Error("The community did not give its identity");
  return self;
}

export function agentReads(
  client: BuzzClient,
  scope: string,
  self: () => Promise<string> = () => relaySelf(scope),
): AgentReads {
  // Signed profiles, verified as read; names come from them.
  const profiles = new Map<string, RelayEvent>();
  const names = new Map<string, string>();
  const channels = new Map<string, string>();
  // Until the community gives its key, only the owner's own mentions count,
  // as in the app before it connects. A failed read is tried again later.
  let authority: string | undefined;
  let asking = false;
  const ask = () => {
    if (asking) return;
    asking = true;
    self().then(
      (key) => {
        authority = key;
      },
      () => {
        asking = false;
      },
    );
  };
  ask();
  return Object.freeze({
    scope,
    connection: client,
    async channel(id: string): Promise<ChannelFacts | undefined> {
      const events = eventsDto([
        ...(await client.query([
          { kinds: [39000], "#d": [id], limit: 1 },
          { kinds: [39002], "#d": [id], limit: 1 },
        ])),
      ]);
      const metadata = newest(events, 39000);
      const roster = newest(events, 39002);
      if (!metadata && !roster) return undefined;
      const name = metadata && channelName(metadata);
      if (name) channels.set(id, name);
      return {
        ...(name ? { name } : {}),
        dm: !!metadata?.tags.some((tag) => tag[0] === "t" && tag[1] === "dm"),
        members: [
          ...new Set(
            roster?.tags.flatMap(([name, value]) =>
              name === "p" && value && /^[0-9a-f]{64}$/.test(value)
                ? [value]
                : [],
            ) ?? [],
          ),
        ].sort(),
      };
    },
    read: (filters, signal) =>
      abortable(
        client
          .query(filters as readonly Filter[])
          .then((events) => eventsDto([...events])),
        signal,
      ),
    async profiles(pubkeys: readonly string[]) {
      const missing = pubkeys.filter((pubkey) => !profiles.has(pubkey));
      if (!missing.length) return;
      const events = eventsDto([
        ...(await client.query([
          { kinds: [0], authors: missing, limit: missing.length },
        ])),
      ]);
      for (const event of events) {
        if (event.kind !== 0 || !missing.includes(event.pubkey)) continue;
        const previous = profiles.get(event.pubkey);
        if (newer(previous, event) === previous) continue;
        profiles.set(event.pubkey, event);
        try {
          const profile = JSON.parse(event.content) as Record<string, unknown>;
          const name = profile.display_name || profile.name;
          if (typeof name === "string" && name) names.set(event.pubkey, name);
          else names.delete(event.pubkey);
        } catch {
          names.delete(event.pubkey);
        }
      }
    },
    name: (pubkey: string) => names.get(pubkey),
    profile: (pubkey: string) => profiles.get(pubkey),
    channelName: (id: string) => channels.get(id),
    workflowAuthority: () => {
      if (!authority) ask();
      return authority;
    },
    // The client skips entries it cannot decrypt, so it cannot show that a
    // listing is complete; a turn then never takes a missing core as none.
    memoryListing: async (signal: AbortSignal) => ({
      entries: await abortable(client.memories(), signal),
      partial: true,
    }),
    // Me chats are the owner's own filing, which only the owner's connection
    // reads; as the agent, a mention keeps its thread, as in the app when the
    // owner is not the one signed in.
    meChat: async () => false,
  });
}
