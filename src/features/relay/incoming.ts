import type { RelayEvent } from "./events";
/** Verified live-route message only. Not an activity feed, replay, or read intent. */
export type IncomingMessage = Readonly<{
  channelId: string;
  messageId: string;
  createdAt: number;
  authorId: string;
  workflowOwnerId?: string | undefined;
  /** At most 4,096 source characters for a preview, not the complete message. */
  previewContent: string;
  /** Signed `audience` tag: `agents` is coordination between agents. */
  audience?: "agents";
}>;
export type IncomingListener = (messages: readonly IncomingMessage[]) => void;
/** Verified live-phase events from one delivery. `channelId` is the route's channel
 * when the wire scope was unambiguous; global routes (profiles, #p hints) omit it. */
export type LiveBatch = Readonly<{
  events: readonly RelayEvent[];
  channelId?: string;
}>;
export type LiveListener = (batch: LiveBatch) => void;
