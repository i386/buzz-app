import type { RelayData } from "../relay/service";

/** Whether a native agent's mention continues its owner's Me chat: one
 * channel-scoped conversation that posts at channel top level. Only the
 * owner's own placement in the agent's community counts; another member's
 * filing never does, and DMs keep their own routing. An unreadable placement
 * is unknown, not Messages, so the turn fails rather than guess, in Messages
 * channels too: its activity says why, and the next mention reads it again.
 * Callers freeze the answer for the turn it admits. */
export async function meChat(
  relay: () => RelayData | undefined,
  owner: string,
  channelId: string,
  signal: AbortSignal,
) {
  const snapshot = relay()?.snapshot();
  if (snapshot?.status !== "ready" || snapshot.viewer !== owner) return false;
  const { session, scope } = snapshot;
  if (
    session.channels.list().channels.find((row) => row.id === channelId)
      ?.channelType === "dm"
  )
    return false;
  const placement = session.mePlacement;
  const status = () => placement.snapshot().status;
  if (status() === "unavailable") return false;
  if (status() !== "ready") await placement.refresh();
  signal.throwIfAborted();
  const after = relay()?.snapshot();
  if (
    after?.status !== "ready" ||
    after.session !== session ||
    after.scope !== scope ||
    after.viewer !== owner
  )
    throw new Error(
      "The community changed before this was answered. Try again.",
    );
  if (status() !== "ready")
    throw new Error(
      `Couldn't read your Me chats to tell where to answer (${placement.snapshot().error ?? "not loaded"}). Try again.`,
    );
  return placement.has(channelId);
}
