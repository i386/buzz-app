import { useRef, useState } from "react";
import type {
  Attachment,
  ChannelSummary,
} from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import { MessageComposer } from "../../features/messages/MessageComposer";
import {
  MessageManagement,
  MessageManagementStatus,
} from "../../features/messages/MessageManagement";
import { ThreadPanel } from "../../features/messages/ThreadPanel";
import type { MessageLinkOrigin } from "../../features/messages/MessageRow";
import { MediaReviewViewer } from "../../features/messages/MediaReviewViewer";
import { rejectUnhandledFileDrop } from "../../features/messages/use-file-drop";
import { ChannelBody } from "./ChannelBody";
import {
  SessionColumn,
  SessionHeading,
} from "../../features/sessions/SessionPresentation";
import type { ConversationTab as Tab } from "./useChannelTabState";
import type { PageNavigation } from "../../features/navigation/service";
import styles from "./ChannelTabs.module.css";

type ConversationTabProps = {
  tab: Tab;
  active: boolean;
  focusOnMount?: boolean;
  channel: ChannelSummary;
  session: RelaySession;
  scope: string;
  extensions?: ConversationExtensions | undefined;
  openLink(target: string, origin?: MessageLinkOrigin): boolean;
  canOpenLink(target: string): boolean;
  openThread(messageId: string, rootId: string, intent?: "reply"): void;
  close(): void;
  /** The current route's request, only for the thread it addresses. */
  navigation?: PageNavigation | undefined;
  onRetryNavigation?: (() => void) | undefined;
  onResolvedRoot?: ((rootId: string) => void) | undefined;
  onDifferentThread?: ((requested: string, kept: string) => void) | undefined;
};
/** Each secondary conversation retains its own editing and media-review scope. */
export function ConversationTab({
  tab,
  active,
  focusOnMount = true,
  channel,
  session,
  scope,
  extensions,
  openLink,
  canOpenLink,
  openThread,
  close,
  navigation,
  onRetryNavigation,
  onResolvedRoot,
  onDifferentThread,
}: ConversationTabProps) {
  // A saved reply intent belongs to the previous visit, not this restoration.
  const restoredTab = useRef(focusOnMount ? undefined : tab);
  const sessionConversation = channel.channelType === "session";
  const [sent, setSent] = useState<string>();
  const [media, setMedia] = useState<{
    messageId: string;
    attachment: Attachment;
    seconds: number;
    hasComments: boolean;
  }>();
  const mediaTrigger = useRef<HTMLElement | null>(null);
  const openMedia = (
    messageId: string,
    attachment: Attachment,
    seconds: number,
    hasComments = false,
  ) => {
    mediaTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setMedia({ messageId, attachment, seconds, hasComments });
  };
  return (
    <MessageManagement session={session} channelId={channel.id} active={active}>
      <section
        data-attachment-drop-zone=""
        onDragOver={rejectUnhandledFileDrop}
        onDrop={rejectUnhandledFileDrop}
        className={styles.conversation}
        aria-label={`Conversation in ${channel.name}`}
      >
        <MessageManagementStatus />
        {sessionConversation && <SessionHeading channel={channel} />}
        {tab.kind === "thread" ? (
          <ThreadPanel
            sessionConversation={sessionConversation}
            active={active}
            session={session}
            scope={scope}
            channelId={channel.id}
            channelName={channel.name}
            messageId={tab.messageId}
            navigation={navigation}
            retainThread
            tabbed
            onRetryNavigation={onRetryNavigation}
            onResolvedRoot={onResolvedRoot}
            onDifferentThread={onDifferentThread}
            replyRequest={
              tab === restoredTab.current ? undefined : tab.replyRequest
            }
            extensions={extensions}
            close={close}
            onOpenLink={openLink}
            canOpenLink={canOpenLink}
            onOpenMediaReview={openMedia}
          />
        ) : (
          <SessionColumn enabled={sessionConversation}>
            <ChannelBody
              queries={session}
              scope={scope}
              channelId={channel.id}
              viewer={session.viewer}
              cached={!!channel.cached}
              extensions={extensions}
              onOpenLink={openLink}
              canOpenLink={canOpenLink}
              onOpenThread={openThread}
              onOpenMediaReview={openMedia}
              revealMessageId={sent}
            />
            <MessageComposer
              sessionConversation={sessionConversation}
              label={sessionConversation ? "Message this session" : undefined}
              session={session}
              scope={scope}
              channelId={channel.id}
              channelName={channel.name}
              extensions={extensions}
              onOpenLink={openLink}
              canOpenLink={canOpenLink}
              onSend={setSent}
            />
          </SessionColumn>
        )}
        {media && (
          <MediaReviewViewer
            session={session}
            scope={scope}
            channelId={channel.id}
            channelName={channel.name}
            extensions={extensions}
            messageId={media.messageId}
            attachment={media.attachment}
            initialTime={media.seconds}
            hasComments={media.hasComments}
            restoreFocus={mediaTrigger}
            onOpenLink={openLink}
            close={() => setMedia(undefined)}
          />
        )}
      </section>
    </MessageManagement>
  );
}
