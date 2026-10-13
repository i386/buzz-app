import { useEffect, useState } from "react";
import type { RelaySession } from "../../features/relay/session";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import { useChannelWindow } from "../../features/relay/react";
import { ChannelTimeline } from "../../features/messages/ChannelTimeline";
import { ThreadPanel } from "../../features/messages/ThreadPanel";
import { MessageComposer } from "../../features/messages/MessageComposer";
import { MessageEditScope } from "../../features/messages/MessageEditScope";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./Inbox.module.css";

/** One selected conversation window and the same scoped composer used in Channels.
 * It preserves the canonical window and composer without owning a new reader. */
export function ChannelPreview({
  session,
  channelId,
  channelName,
  extensions,
  anchor,
  draft = false,
  onDraftSaved,
}: {
  session: RelaySession;
  channelId: string;
  channelName: string;
  extensions?: ConversationExtensions | undefined;
  anchor?: string | undefined;
  draft?: boolean;
  onDraftSaved?: () => void;
}) {
  const window = useChannelWindow(session.channels, channelId);
  const [sentId, setSentId] = useState<string>();
  const [inlineSignal, setInlineSignal] = useState<AbortSignal>();
  useEffect(() => {
    if (!anchor) return;
    const request = new AbortController();
    setInlineSignal(request.signal);
    return () => request.abort();
  }, [anchor]);
  const [opening, setOpening] = useState<{
    anchor: string;
    inTimeline: boolean;
  }>();
  useEffect(() => {
    if (
      !anchor ||
      opening?.anchor === anchor ||
      window.status === "idle" ||
      window.status === "loading"
    )
      return;
    // Same canonical decision as Channels: freeze this attempt after the head
    // settles; later live arrivals must not switch an exact reader's presentation.
    setOpening({
      anchor,
      inTimeline:
        window.status === "ready" &&
        window.freshness !== "cached" &&
        window.rows.some((row) => row.id === anchor && !row.threadRootId),
    });
  }, [anchor, opening, window]);
  const channel = session.channels.get?.(channelId);
  // Saved drafts open the current head without mutating canonical scroll intent.
  useEffect(() => {
    if (draft) session.channels.refresh?.(channelId);
  }, [session, channelId, draft]);
  // Cache clear can leave the selected window idle without remounting it.
  useEffect(() => {
    if (window.status === "idle") session.channels.ensure(channelId);
  }, [session, channelId, window.status]);
  if (anchor && opening?.anchor === anchor && !opening.inTimeline)
    return (
      <ThreadPanel
        session={session}
        scope={session.scope}
        extensions={extensions}
        channelId={channelId}
        channelName={channelName}
        messageId={anchor}
        revealSelected
        onOpenLink={() => false}
      />
    );
  return (
    <MessageEditScope>
      <section
        className={styles.previewFrame}
        aria-label="Conversation preview"
        data-reading-surface=""
      >
        <div className={styles.previewHistory}>
          {window.rows.length > 0 && (
            <ChannelTimeline
              extensions={extensions}
              queries={session}
              scope={session.scope}
              channelId={channelId}
              window={window}
              {...(draft ? { transient: true } : {})}
              revealMessageId={sentId}
              inlineTarget={
                anchor && inlineSignal && !inlineSignal.aborted
                  ? { messageId: anchor, signal: inlineSignal }
                  : undefined
              }
              onOpenLink={() => false}
            />
          )}
          {(window.status === "error" || window.error) && (
            <p className={styles.notice} role="alert">
              {window.error ?? "Could not load conversation."}
            </p>
          )}
          {(window.status === "error" || window.error) && (
            <div className={styles.notice}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => session.channels.refresh?.(channelId)}
              >
                Retry conversation
              </Button>
            </div>
          )}
          {window.status === "ready" &&
            !window.error &&
            !window.rows.length && (
              <p className={styles.notice} role="status">
                No messages yet.
              </p>
            )}
          {(window.status === "idle" || window.status === "loading") &&
            !window.error &&
            !window.rows.length && (
              <p className={styles.notice} role="status">
                Loading conversation…
              </p>
            )}
        </div>
        <MessageComposer
          session={session}
          scope={session.scope}
          extensions={extensions}
          channelId={channelId}
          channelName={channelName}
          label={
            channel?.channelType === "dm"
              ? `Message ${channelName}`
              : `Message #${channelName}`
          }
          sessionConversation={channel?.channelType === "session"}
          onSend={setSentId}
          onDraftSaved={onDraftSaved}
        />
      </section>
    </MessageEditScope>
  );
}
