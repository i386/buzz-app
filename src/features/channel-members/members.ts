import { archiveHides } from "../relay/identity-archives";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import type { LocalEvents } from "../relay/outbox";

const keyPattern = /^[0-9a-f]{64}$/;

/** The relay remains authoritative; never offer role changes or DM expansion. */
export function canAddMembers(session: RelaySession, channel?: ChannelSummary) {
  return !!(
    session.viewer &&
    session.outbox?.supports(9000) &&
    channel &&
    !channel.archived &&
    (channel.channelType === "stream" || channel.channelType === "forum") &&
    (channel.members?.includes(session.viewer) ||
      (channel.readOnly && !channel.private))
  );
}

/** A session share adds only to this session. It never opens ordinary Members UI
 * or inherits parent-channel membership. */
export function canShareSession(
  session: RelaySession,
  channel?: ChannelSummary,
) {
  return !!(
    session.viewer &&
    session.outbox?.supports(9000) &&
    channel?.channelType === "session" &&
    channel.private &&
    !channel.readOnly &&
    !channel.cached &&
    !channel.archived &&
    channel.members?.includes(session.viewer)
  );
}

/** Reuse the outbox's durable operation on retry, including an unknown result. */
function waitForAddition(outbox: LocalEvents, id: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let stop = () => {};
    const finish = (error?: Error) => {
      stop();
      signal.removeEventListener("abort", cancelled);
      error ? reject(error) : resolve();
    };
    const cancelled = () =>
      finish(
        new Error(
          "Member addition interrupted. Reopen Members to check its status.",
        ),
      );
    const inspect = () => {
      const item = outbox.snapshot().find((entry) => entry.event.id === id);
      // Delivery alone is not membership confirmation. Always verify the roster next.
      if (!item || item.delivery === "accepted" || item.delivery === "seen")
        finish();
      else if (item.delivery !== "sending")
        finish(
          new Error(
            item.error ?? "Addition is not confirmed. Retry to check again.",
          ),
        );
    };
    stop = outbox.subscribe(inspect);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
    else inspect();
  });
}

export type MemberAdditionIntent = {
  id?: string;
  confirmed?: boolean;
  dismissed?: boolean;
};

/** Explicit single-person intent. Membership truth and pending writes stay session-owned. */
export async function addChannelMember(
  session: RelaySession,
  channelId: string,
  pubkey: string,
  signal: AbortSignal,
  intent: MemberAdditionIntent = {},
  receipts: LocalEvents | undefined = session.outbox,
  sessionParticipant = false,
  allowSessionAgents = false,
) {
  if (!keyPattern.test(pubkey))
    throw new Error("Choose a valid person or agent.");
  const channel = () =>
    session.channels.list().channels.find((item) => item.id === channelId) ??
    session.channels.get?.(channelId);
  const check = () => {
    signal.throwIfAborted();
    if (
      !(sessionParticipant
        ? canShareSession(session, channel())
        : canAddMembers(session, channel()))
    )
      throw new Error(
        "This channel cannot add members right now. Refresh and try again.",
      );
    if (archiveHides(session.archives, pubkey, session.viewer))
      throw new Error(
        "Archived identities cannot be added. Choose someone else.",
      );
    if (
      sessionParticipant &&
      !allowSessionAgents &&
      (session.agentChoices
        .snapshot()
        .identities.some((agent) => agent.pubkey === pubkey) ||
        session.profiles.snapshot().get(pubkey)?.isAgent)
    )
      throw new Error("Add agents with the session agent picker instead.");
  };
  check();
  const outbox = session.outbox;
  if (!outbox) throw new Error("Member additions are unavailable.");
  await outbox.ready();
  check();
  // This existing session operation verifies the connected relay's signed roster.
  await session.workSessions.refreshMembership(channelId);
  check();
  const journal = receipts ?? outbox;
  // Only a roster-confirmed prior addition may be superseded by explicit Add.
  const fresh =
    intent.dismissed ||
    (intent.confirmed && !channel()?.members?.includes(pubkey));
  const pending = fresh
    ? undefined
    : journal
        .snapshot()
        .find(({ event, acknowledged }) =>
          intent.id
            ? event.id === intent.id
            : !acknowledged &&
              event.kind === 9000 &&
              event.tags.some(
                ([tag, value]) => tag === "h" && value === channelId,
              ) &&
              event.tags.some(
                ([tag, value]) => tag === "p" && value === pubkey,
              ) &&
              !event.tags.some(
                ([tag, value]) => tag === "role" && value !== "bot",
              ),
        );
  if (pending?.guarded && !channel()?.members?.includes(pubkey))
    throw new Error(
      "Retry this invitation from the agent’s profile so its eligibility can be checked.",
    );
  const recovery = { key: `member-add:${channelId}:${pubkey}`, value: "1" };
  if (pending && !pending.acknowledged)
    await outbox.recover(pending.event.id, recovery);
  check();
  if (channel()?.members?.includes(pubkey)) {
    if (!intent.id && pending) intent.id = pending.event.id;
    if (pending) await outbox.acknowledge(pending.event.id);
    check();
    intent.confirmed = true;
    return;
  }
  if (!fresh && intent.id && !pending)
    throw new Error(
      "The original addition receipt is unavailable. Refresh membership before trying again.",
    );
  if (
    pending?.delivery === "failed" &&
    Date.now() / 1000 - pending.event.created_at >= 15 * 60
  )
    throw new Error(
      "This addition expired. Remove its Not sent item in Outbox, then try again.",
    );
  const isAgent =
    session.agentChoices
      .snapshot()
      .identities.some((agent) => agent.pubkey === pubkey) ||
    session.profiles.snapshot().get(pubkey)?.isAgent;
  const id =
    pending?.event.id ??
    outbox.send(
      {
        kind: 9000,
        content: "",
        tags: [
          ["h", channelId],
          ["p", pubkey],
          ...(isAgent ? [["role", "bot"]] : []),
        ],
      },
      recovery,
    );
  if (pending?.delivery === "failed" || pending?.delivery === "unknown")
    outbox.retry(id);
  intent.id = id;
  intent.dismissed = false;
  intent.confirmed = false;
  await waitForAddition(journal, id, signal);
  check();
  await session.workSessions.refreshMembership(channelId);
  check();
  if (!channel()?.members?.includes(pubkey))
    throw new Error(
      "Addition is not confirmed in the member list yet. Retry to check again.",
    );
  await outbox.acknowledge(id);
  check();
  intent.confirmed = true;
}
