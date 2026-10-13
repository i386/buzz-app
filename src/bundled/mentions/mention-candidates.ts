import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { MentionRecipient } from "../../features/messages/mention-draft";
import { knownAgentPubkeys } from "../../features/agents/known";
import {
  allowsOutsideMentions,
  mentionAdmission,
} from "../../features/messages/mention-admission";

/** The viewer's agents offered outside a stream or forum when the viewer can add members. */
function availableMentionAgents(
  channel: ChannelSummary | undefined,
  agents: readonly { pubkey: string; name: string }[],
  canInvite: boolean | undefined,
) {
  return channel?.members &&
    (channel.channelType === "stream" || channel.channelType === "forum") &&
    canInvite
    ? agents.filter((agent) => !channel.members?.includes(agent.pubkey))
    : [];
}

/** Row detail for an outside choice. Nobody can be added to a DM. */
export function outsideMentionDetail(
  channel: Pick<ChannelSummary, "channelType"> | undefined,
) {
  return channel?.channelType === "dm"
    ? "Not in DM · Will not be notified"
    : "Not in channel · Choose whether to add when you send";
}

/** What the chooser offers. The host admits recipients itself (mention-admission). No reads or writes. */
export function mentionCandidates(
  session: RelaySession,
  channelId: string,
  inviteAgents = false,
  roster?: readonly MentionRecipient[],
  directory: readonly (MentionRecipient & { isAgent?: true })[] = [],
) {
  const channel = session.channels
    .list()
    .channels.find((c) => c.id === channelId);
  const members = roster?.map((p) => p.pubkey) ?? channel?.members ?? [];
  const memberKeys = new Set(members);
  const agents = session.agentChoices.snapshot().identities;
  const profiles = session.profiles.snapshot();
  const known = knownAgentPubkeys(profiles, {
    definitions: [],
    identities: agents,
  });
  const choices = new Map<string, MentionRecipient>();
  for (const person of roster ??
    (inviteAgents && channel?.channelType !== "dm"
      ? agents
      : availableMentionAgents(
          channel,
          agents,
          session.outbox?.supports(9000),
        )))
    choices.set(person.pubkey, { pubkey: person.pubkey, name: person.name });
  if (!roster && !inviteAgents && allowsOutsideMentions(channel))
    for (const person of directory) choices.set(person.pubkey, person);
  for (const pubkey of members)
    choices.set(pubkey, {
      pubkey,
      name:
        profiles.get(pubkey)?.name ||
        choices.get(pubkey)?.name ||
        pubkey.slice(0, 12),
    });
  // Offer only what the composer will accept.
  const admits = mentionAdmission(session, channelId, inviteAgents, roster);
  return [...choices.values()]
    .filter((p) => admits(p.pubkey))
    .map((recipient) => ({
      recipient,
      member: memberKeys.has(recipient.pubkey),
      agent:
        known.has(recipient.pubkey) ||
        directory.some((p) => p.pubkey === recipient.pubkey && p.isAgent),
      owned:
        !!session.viewer &&
        profiles.get(recipient.pubkey)?.ownerPubkey === session.viewer,
      managed: agents.some((a) => a.pubkey === recipient.pubkey && a.managed),
      aliases: [
        ...new Set(
          [
            profiles.get(recipient.pubkey)?.name ||
              directory.find((person) => person.pubkey === recipient.pubkey)
                ?.name ||
              roster?.find((person) => person.pubkey === recipient.pubkey)
                ?.name,
            ...agents
              .filter((a) => a.pubkey === recipient.pubkey)
              .map((a) => a.name),
          ].filter((name): name is string => !!name),
        ),
      ],
    }));
}
