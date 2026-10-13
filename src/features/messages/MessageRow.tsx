import { AgentAvatar } from "../agents/AgentAvatar";
import {
  TypingPresentation,
  useReplacedTypers,
} from "../conversation/typing-presentation";
import { breathing, localActivity } from "../agents/local-activity";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import {
  ArrowRightIcon,
  LightningIcon,
} from "../../shared/design-system/icons";
import { messagePreviewText } from "../conversation/message-preview-text";
import { profileMentionParts } from "./profile-mentions";
import { addressedMessage } from "./audience-address";
import { WorkflowByline } from "./WorkflowByline";
import { threadWorkingAgents } from "../agents/thread-working";
import { TypingDots } from "../../shared/design-system/ui/TypingDots";
import { ComposerAccessories } from "../conversation/ComposerAccessories";
import { useConversationPresentation } from "../conversation/ConversationPresentation";
import { MessageLink } from "../conversation/MessageLink";
import { DayDivider, MessageTimestamp } from "./MessageTimestamp";
import { activityTarget } from "../agents/activity-target";
import { useChannelIdentityNames } from "../identity-names/react";
import { Button } from "../../shared/design-system/ui/Button";
import { ReplySummary } from "./ReplySummary";
import { usePresenceStatus } from "../presence/react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  memo,
  useMemo,
  useId,
  useRef,
  useState,
  useEffect,
  useCallback,
  useSyncExternalStore,
  type FocusEvent,
  type ReactNode,
} from "react";
import { useListedChannel } from "../relay/listed-channel";
import type { RelaySession } from "../relay/session";
import type { UnreadCapability } from "../relay/unread";
import { MediaAttachment, type MediaPlayback } from "./MediaAttachment";
import { parseMediaTimeReply } from "./media-timecode";
import { profileTarget, profileActivityViewTarget } from "../profiles/target";
import { MessageBody } from "../conversation/MessageBody";
import { InlineText } from "../conversation/InlineText";
import type { ConversationExtensions } from "../conversation/contracts";
import {
  ContributionBoundary,
  contributionKey,
} from "../conversation/ContributionBoundary";
import type { ChannelMessage, Profile } from "../relay/contracts";
import { AttachmentImage } from "./AttachmentImage";
import { DeliveryNotice } from "./DeliveryNotice";
import { AttachmentView } from "../conversation/AttachmentView";
import { AudioAttachment } from "./AudioAttachment";
import { isNativeMediaSource, isProxySource } from "./attachment-source";
import { FileAttachment } from "./FileAttachment";
import { useReferenceDirectory } from "./ReferenceText";
import { MessageMarkdown } from "./MessageMarkdown";
import { safeMessageUrl } from "../relay/message-content";
import styles from "./Messages.module.css";
import { usesLargeEmojiPresentation } from "./emoji-size";
import { MessageReactionControls, MessageReactions } from "./MessageReactions";

import {
  MessageManagementItems,
  MessageReadStateItem,
} from "./MessageManagement";
import { MessageActionBar } from "./MessageActionBar";
import { FlagIcon, ListBulletsIcon } from "../../shared/design-system/icons";
import {
  MenuIcon,
  MenuItem,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { ReportMessageDialog } from "./ReportMessageDialog";
import { messageCopyLink, messageCopyText } from "./message-copy";

export type MessageLinkOrigin = Readonly<{ rootId: string }>;
export type MessageRowProps = {
  row: ChannelMessage;
  getThreadRoot?: (() => ChannelMessage | undefined) | undefined;
  session?: RelaySession | undefined;
  scope?: string | undefined;
  unread?: UnreadCapability | undefined;
  extensions?: ConversationExtensions | undefined;
  profile: Profile | undefined;
  participantProfiles?: ReadonlyMap<string, Profile> | undefined;
  agentPubkeys?: ReadonlySet<string> | undefined;
  canOpenLink?: ((target: string) => boolean) | undefined;
  media(url: string, size?: "small"): string | undefined;
  /** Receives the thread the link was opened from: the row's root, or the row. */
  onOpenLink(url: string, origin?: MessageLinkOrigin): boolean;
  day: boolean;
  retry: ((id: string) => void) | undefined;
  /** Pins this row in a virtualized list; returns the release. */
  keepMounted?: ((messageId: string) => () => void) | undefined;
  onOpenThread?:
    | ((messageId: string, threadRootId: string, intent?: "reply") => void)
    | undefined;
  onReply?: ((messageId: string) => void) | undefined;
  quickControls?: ReactNode;
  overflowItems?: ReactNode;
  layout?: "timeline" | "thread" | "continuation";
  compactAvatar?: boolean;
  mediaMode?: "inline" | "thread";
  mediaSeekTo?: number;
  mediaSeekRequest?: number;
  onMediaPlayback?: (playback: MediaPlayback) => void;
  onMediaTime?: (seconds: number) => void;
  onOpenMediaReview?: (
    messageId: string,
    attachment: ChannelMessage["attachments"][number],
    seconds: number,
    hasComments?: boolean,
  ) => void;
};

// Engines skip horizontal focus scrolling for a target that is already partly
// visible: Blink sets the partial-visibility behaviour to no-scroll in
// Element::UpdateSelectionOnFocus, and WebKit keeps its 32px legacy horizontal
// visibility threshold for focus reveals. Only scrollIntoView() opts out of
// both, so a thumbnail whose far edge is clipped keeps focus without ever
// coming fully into view. Reveal it within the strip's scroll-padding.
//
// Keyboard focus only. React's onFocus is the bubbling focusin, so it also
// fires for pointer focus, and Chromium focuses a link on mousedown (WebKit
// does not): revealing there would slide the strip under a held pointer before
// mouseup, so the press lands on a neighbour or on padding, and the strip
// visibly jumps on every click of a clipped tile. DESIGN.md wants pointer
// focus quiet, so gate on html[data-keyboard-navigation] like the composer and
// the floating action bar. useKeyboardFocusVisibility sets that attribute in
// a capturing keydown listener, which runs before Tab's default action moves
// focus, and clears it on the capturing pointerdown that precedes mousedown,
// so a Tab reveal still runs and a press never does.
function revealFocusedThumbnail(event: FocusEvent<HTMLDivElement>) {
  const strip = event.currentTarget;
  const target = event.target;
  if (
    !(target instanceof HTMLElement) ||
    target === strip ||
    !document.documentElement.hasAttribute("data-keyboard-navigation")
  )
    return;
  const style = getComputedStyle(strip);
  const bounds = strip.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  const start =
    bounds.left +
    strip.clientLeft +
    (Number.parseFloat(style.scrollPaddingInlineStart) || 0);
  const end =
    bounds.left +
    strip.clientLeft +
    strip.clientWidth -
    (Number.parseFloat(style.scrollPaddingInlineEnd) || 0);
  if (rect.right > end) strip.scrollLeft += rect.right - end;
  else if (rect.left < start) strip.scrollLeft -= start - rect.left;
}

const FullMessageRow = memo(function MessageRow(
  props: MessageRowProps & { shownRow?: ChannelMessage },
) {
  return props.session && props.scope && props.extensions?.accessories ? (
    <TypingPresentation
      active
      key={`${props.scope}:${props.row.channelId}:${props.row.id}`}
    >
      <MessageRowContent {...props} />
    </TypingPresentation>
  ) : (
    <MessageRowContent {...props} />
  );
});
function MessageRowContent({
  row,
  shownRow,
  getThreadRoot,
  session,
  scope,
  unread,
  extensions,
  profile,
  media,
  onOpenLink,
  canOpenLink,
  day,
  retry,
  keepMounted,
  onOpenThread,
  onReply,
  quickControls,
  overflowItems,
  participantProfiles,
  layout = "timeline",
  compactAvatar = false,
  mediaMode = "inline",
  mediaSeekTo,
  mediaSeekRequest,
  onMediaPlayback,
  onMediaTime,
  onOpenMediaReview,
  agentPubkeys,
}: MessageRowProps & {
  /** The message as its body shows, when that differs from `row`. */
  shownRow?: ChannelMessage;
}) {
  const resolveName = useChannelIdentityNames(session, row.channelId);
  const directory = useReferenceDirectory(session, participantProfiles);
  const reactions = row.reactions;
  const threadUnread = useThreadUnread(
    row.replyCount > 0 && onOpenThread ? unread : undefined,
    row.channelId,
    row.threadRootId ?? row.id,
  );
  const { agents: threadAgents, waiting: threadWaiting } = useThreadAgents(
    onOpenThread && (row.replyCount > 0 || !row.threadRootId)
      ? session
      : undefined,
    row.channelId,
    row.threadRootId ?? row.id,
    row.id,
    row.threadRootId,
  );
  const rootId = row.threadRootId ?? row.id;
  const openLink = useCallback(
    (url: string) => onOpenLink(url, { rootId }),
    [onOpenLink, rootId],
  );
  const channels = session?.channels;
  const listed = useListedChannel(
    channels,
    row.channelId,
    (channel) => !!channel,
  );
  const cached = useListedChannel(
    channels,
    row.channelId,
    (channel) => !!channel?.cached,
  );
  const archived = useListedChannel(
    channels,
    row.channelId,
    (channel) => !!channel?.archived,
  );
  const readOnly = useListedChannel(
    channels,
    row.channelId,
    (channel) => !!channel?.readOnly,
  );
  const unreadLabel =
    threadUnread?.manual === "local-only"
      ? "Thread marked unread on this device only"
      : threadUnread?.manual === "remote"
        ? "Thread marked unread"
        : (threadUnread?.observedCount ?? 0) > 0
          ? `Observed unread replies${threadUnread?.freshness === "stale" ? "; may be out of date" : ""}. Not an exact total.`
          : undefined;
  const workingLabel = threadAgents.length
    ? `${threadAgents
        .map(({ pubkey, name }) => resolveName(pubkey, name))
        .join(", ")} ${threadWaiting ? "waiting" : "working"}`
    : undefined;
  const firstThreadAgent = threadAgents[0];
  const threadWorkingLabel =
    threadAgents.length === 1 && firstThreadAgent
      ? `${resolveName(firstThreadAgent.pubkey, firstThreadAgent.name)} is ${threadWaiting ? "waiting" : "working"}`
      : `${threadAgents.length} agents are ${threadWaiting ? "waiting" : "working"}`;
  const name = resolveName(
    row.authorId,
    profile?.name ?? row.authorId.slice(0, 10),
  );
  const workflowOwnerName = row.workflowOwnerId
    ? resolveName(
        row.workflowOwnerId,
        directory.profiles.get(row.workflowOwnerId)?.name ??
          `${row.workflowOwnerId.slice(0, 10)}…`,
      )
    : undefined;
  const picture = profile?.picture
    ? media(profile.picture, "small")
    : undefined;
  const target = profileTarget(row.authorId, {
    agent: !!(row.agentEnvelope || agentPubkeys?.has(row.authorId)),
  });
  const clickable = target && canOpenLink?.(target);
  const activityView = profileActivityViewTarget(row.authorId);
  const canViewActivity =
    !!(
      row.agentEnvelope ||
      agentPubkeys?.has(row.authorId) ||
      profile?.isAgent
    ) &&
    activityView &&
    canOpenLink?.(activityView) &&
    canOpenLink(activityTarget(row.authorId, row.channelId));
  const activityItem = canViewActivity && (
    <MenuItem
      onClick={() => {
        if (
          canOpenLink?.(activityView) &&
          canOpenLink(activityTarget(row.authorId, row.channelId))
        )
          onOpenLink(activityView);
      }}
    >
      <MenuIcon>
        <ListBulletsIcon />
      </MenuIcon>
      View activity
    </MenuItem>
  );
  const avatarShape =
    row.agentEnvelope || agentPubkeys?.has(row.authorId) || profile?.isAgent
      ? "squircle"
      : "circle";
  const presence = usePresenceStatus(
    !row.workflowOwnerId && avatarShape === "squircle"
      ? session?.presence
      : undefined,
    row.authorId,
  );
  const presenceId = useId();
  const shown = shownRow ?? row;
  const timeReply = shown.diff ? undefined : parseMediaTimeReply(shown.content);
  const displayRow = timeReply
    ? { ...shown, content: timeReply.content }
    : shown;
  const emojiOnly = usesLargeEmojiPresentation(displayRow.content, row.emoji);
  const canReact = !!(
    extensions &&
    session &&
    scope &&
    session.outbox?.supports(7) &&
    session.outbox.supports(5) &&
    (!session.channels.get || listed) &&
    !archived &&
    !readOnly
  );
  const rowRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const active = useConversationPresentation();
  const [reporting, setReporting] = useState<"open" | "sent">();
  const registeredActions = useSyncExternalStore(
    extensions?.actions?.subscribe ?? noSubscribe,
    extensions?.actions?.snapshot ?? noActions,
    extensions?.actions?.snapshot ?? noActions,
  );
  const actions = session
    ? registeredActions.filter((action) => {
        try {
          return action.matches(row, session);
        } catch {
          return false; // A broken optional action leaves the menu usable.
        }
      })
    : [];
  // The instance, not its key: a reinstalled plugin must not reopen a dialog.
  const [openAction, setOpenAction] = useState<(typeof actions)[number]>();
  const opened =
    openAction && actions.includes(openAction) ? openAction : undefined;
  useEffect(() => {
    if (openAction && !opened) setOpenAction(undefined);
  }, [openAction, opened]);
  const keepAlive = reporting !== undefined || !!opened;
  // The dialog, pending submit and notice live in this row; eviction loses them.
  useEffect(() => {
    const release = keepAlive ? keepMounted?.(row.id) : undefined;
    // Dialog focus restoration runs in a microtask after unmount; releasing a
    // task later lets restored focus keep the row mounted instead.
    return release && (() => void setTimeout(release));
  }, [keepAlive, keepMounted, row.id]);
  const keepRowMounted = useMemo(
    () => keepMounted && (() => keepMounted(row.id)),
    [keepMounted, row.id],
  );
  const report =
    !row.membership &&
    (!row.delivery || ["accepted", "seen"].includes(row.delivery))
      ? session?.messages.report
      : undefined;
  const reportItem = report && (
    <>
      <MenuSeparator />
      <MenuItem
        disabled={reporting === "open"}
        onClick={() => setReporting("open")}
      >
        <MenuIcon>
          <FlagIcon />
        </MenuIcon>
        Report
      </MenuItem>
    </>
  );
  const actionItems = actions.map((action) => (
    <MenuItem key={action.key} onClick={() => setOpenAction(action)}>
      {action.icon && (
        <MenuIcon>
          <ContributionBoundary key={contributionKey(action)} fallback={null}>
            <action.icon />
          </ContributionBoundary>
        </MenuIcon>
      )}
      {action.title}
    </MenuItem>
  ));
  // Keep mixed attachments in sender order; only adjacent images share a strip.
  const attachmentGroups: ChannelMessage["attachments"][number][][] = [];
  for (const attachment of row.attachments) {
    if (!safeMessageUrl(attachment.url)) continue;
    const previous = attachmentGroups.at(-1);
    if (
      (attachment.kind === "image" || attachment.kind === "file") &&
      previous?.[0]?.kind === attachment.kind
    )
      previous.push(attachment);
    else attachmentGroups.push([attachment]);
  }
  const body = row.diff ? (
    <div>
      <p className="text-label-sm">{row.diff.filePath || "Diff"}</p>
      {row.diff.description && (
        <p className="text-body-sm">{row.diff.description}</p>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: The raw scroll region preserves preformatted text and needs keyboard access. */}
      <pre
        className={styles.rawDiff}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The raw scroll owner must support keyboard scrolling.
        tabIndex={0}
        role="region"
        aria-label="Raw diff"
      >
        {row.content || "No diff content"}
      </pre>
      {row.diff.truncated && (
        <p className="text-body-sm">
          Diff truncated. View the full diff at the source repository.
        </p>
      )}
    </div>
  ) : (
    <MessageMarkdown
      directory={directory}
      session={session}
      scope={scope}
      row={displayRow}
      extensions={extensions}
      media={media}
      onOpenLink={openLink}
      canOpenLink={canOpenLink}
      participantProfiles={participantProfiles}
      largeEmoji={emojiOnly}
    />
  );
  return (
    <div data-message-id={row.id}>
      {day && <DayDivider createdAt={row.createdAt} />}
      <div ref={rowRef} className={styles.message} data-layout={layout}>
        {layout === "continuation" ? (
          <span className={styles.messageGutter}>
            <MessageTimestamp createdAt={row.createdAt} compact />
          </span>
        ) : row.workflowOwnerId ? (
          <Avatar
            alt="Workflow"
            fallback="Workflow"
            fallbackContent={<LightningIcon size={20} />}
            shape="squircle"
            size={
              compactAvatar
                ? "small"
                : layout === "timeline"
                  ? "large"
                  : "default"
            }
          />
        ) : clickable ? (
          <IconButton
            size={layout === "timeline" ? "default" : "sm"}
            shape="round"
            aria-label={`View ${name} profile`}
            aria-describedby={presence !== "unknown" ? presenceId : undefined}
            onClick={(event) => {
              event.currentTarget.focus();
              openLink(target);
            }}
            icon={
              <>
                <Avatar
                  src={picture}
                  alt=""
                  fallback={name}
                  size={compactAvatar ? "small" : "fill"}
                  shape={avatarShape}
                  statusBadge={presence === "unknown" ? undefined : presence}
                />
                {presence !== "unknown" && (
                  <span className="sr-only select-none" id={presenceId}>
                    Presence: {presence}
                  </span>
                )}
              </>
            }
          />
        ) : (
          <span className={compactAvatar ? styles.nestedAvatar : "contents"}>
            <Avatar
              src={picture}
              alt={
                presence === "unknown"
                  ? ""
                  : avatarShape === "squircle"
                    ? "Agent"
                    : `${name} avatar`
              }
              fallback={name}
              size={
                compactAvatar
                  ? "small"
                  : layout === "timeline"
                    ? "large"
                    : "default"
              }
              shape={avatarShape}
              statusBadge={presence === "unknown" ? undefined : presence}
            />
          </span>
        )}
        <div className={styles.messageBody}>
          {opened && session && (
            <ContributionBoundary key={contributionKey(opened)} fallback={null}>
              <opened.component
                message={row}
                session={session}
                close={() => setOpenAction(undefined)}
              />
            </ContributionBoundary>
          )}
          {report && reporting === "open" && (
            <ReportMessageDialog
              report={(type, note) => report(row.id, type, note)}
              close={(submitted) =>
                setReporting(submitted ? "sent" : undefined)
              }
              finalFocus={menuTrigger}
            />
          )}
          {active && reporting === "sent" && (
            <ToastNotice
              tone="success"
              timeout={5000}
              title="Report submitted to community moderators"
              onDismiss={() => setReporting(undefined)}
            />
          )}
          <div className={styles.messageHeader}>
            {!row.membership && (
              <MessageActionBar
                rowRef={rowRef}
                menuTriggerRef={menuTrigger}
                messageId={row.id}
                onReply={
                  (onReply ? () => onReply(row.id) : undefined) ??
                  (onOpenThread
                    ? () =>
                        onOpenThread(
                          row.threadRootId ?? row.id,
                          row.threadRootId ?? row.id,
                          "reply",
                        )
                    : undefined)
                }
                replyDisabled={
                  !!(
                    row.delivery && !["accepted", "seen"].includes(row.delivery)
                  ) ||
                  archived ||
                  (!!session?.channels.get && (!listed || readOnly))
                }
                onSendToChannel={
                  session &&
                  listed &&
                  !archived &&
                  !readOnly &&
                  row.threadRootId &&
                  row.authorId === session.viewer &&
                  !row.agentEnvelope &&
                  !row.diff &&
                  (!row.delivery ||
                    ["accepted", "seen"].includes(row.delivery)) &&
                  session.outbox?.supports(9)
                    ? () => {
                        session.messages.sendToChannel(row, getThreadRoot?.());
                      }
                    : undefined
                }
                link={messageCopyLink(row, scope)}
                copyText={() =>
                  messageCopyText(row, directory.profiles, directory.agents)
                }
                quickControls={
                  quickControls ??
                  (canReact && session && scope && extensions ? (
                    <MessageReactionControls
                      row={row}
                      session={session}
                      scope={scope}
                      tools={extensions.tools}
                      inline={extensions.inline}
                      disabled={
                        !!row.delivery &&
                        !["accepted", "seen"].includes(row.delivery)
                      }
                    />
                  ) : undefined)
                }
                leadingItems={
                  session ? (
                    <MessageReadStateItem row={row} session={session} />
                  ) : undefined
                }
                overflowItems={
                  <>
                    {overflowItems ??
                      (session ? (
                        <MessageManagementItems row={row} session={session} />
                      ) : undefined)}
                    {actionItems}
                    {activityItem}
                    {reportItem}
                  </>
                }
              />
            )}
            {/* Screen-reader text stays out of selections: the clipboard carries
                what the reader saw, so a continuation copies without a byline. */}
            <div
              className={
                layout === "continuation"
                  ? "sr-only select-none"
                  : styles.byline
              }
            >
              {row.workflowOwnerId && workflowOwnerName ? (
                <WorkflowByline
                  ownerId={row.workflowOwnerId}
                  ownerName={workflowOwnerName}
                  signer={row.signerId ?? row.authorId}
                  canOpenLink={canOpenLink}
                  onOpenLink={openLink}
                />
              ) : (
                <strong className={styles.author}>{name}</strong>
              )}
              {layout !== "continuation" && (
                <MessageTimestamp createdAt={row.createdAt} />
              )}
              {session &&
                actions.map(
                  (action) =>
                    action.marker && (
                      <ContributionBoundary
                        key={contributionKey(action)}
                        fallback={null}
                      >
                        <action.marker message={row} session={session} />
                      </ContributionBoundary>
                    ),
                )}
            </div>
          </div>
          {row.sentFromThread && (
            <div className={styles.sentFromThread}>
              Sent from{" "}
              <MessageLink
                url={`buzz://message?${new URLSearchParams({ channel: row.channelId, id: row.sentFromThread.rootId, thread: row.sentFromThread.rootId })}`}
                registry={extensions?.links}
                session={session}
                scope={scope}
                onOpenLink={openLink}
                label={
                  row.sentFromThread.excerpt
                    ? `Thread — ${row.sentFromThread.excerpt}`
                    : "Thread"
                }
              />
            </div>
          )}
          {timeReply && (
            <span className={styles.mediaTimeLink}>
              {onMediaTime ? (
                <Button
                  size="sm"
                  type="button"
                  onClick={() => onMediaTime(timeReply.anchor.seconds)}
                >
                  {timeReply.label}
                </Button>
              ) : (
                <span>{timeReply.label}</span>
              )}
            </span>
          )}
          {extensions?.messages ? (
            <MessageBody registry={extensions.messages} message={row}>
              {body}
            </MessageBody>
          ) : (
            body
          )}
          <DeliveryNotice row={row} retry={retry} />
          {attachmentGroups.map((group) => {
            const images = group[0]?.kind === "image";
            const files = group[0]?.kind === "file";
            const items = group.map((attachment, index) => {
              const url = safeMessageUrl(attachment.url);
              if (!url) return null;
              const source = media(url);
              if (attachment.kind === "file")
                return (
                  <FileAttachment
                    key={url}
                    attachment={{ ...attachment, url }}
                    source={source}
                    onOpenLink={openLink}
                  />
                );
              if (attachment.kind === "audio") {
                if (
                  source &&
                  (isProxySource(source) || isNativeMediaSource(source))
                )
                  return extensions?.attachments ? (
                    <AttachmentView
                      key={url}
                      registry={extensions.attachments}
                      attachment={{ ...attachment, url }}
                      source={source}
                      fallback={
                        <AudioAttachment
                          attachment={{ ...attachment, url }}
                          source={source}
                        />
                      }
                    />
                  ) : (
                    <AudioAttachment
                      key={url}
                      attachment={{ ...attachment, url }}
                      source={source}
                    />
                  );
                return (
                  <FileAttachment
                    key={url}
                    attachment={{ ...attachment, url }}
                    source={source}
                    onOpenLink={openLink}
                  />
                );
              }
              if (attachment.kind === "image") {
                return (
                  <AttachmentImage
                    key={url}
                    attachment={{ ...attachment, url }}
                    source={source}
                    cached={cached}
                    thumbnail
                    keepMounted={keepRowMounted}
                    label={
                      group.length > 1
                        ? `Open image ${index + 1} of ${group.length}`
                        : "Open image attachment"
                    }
                    {...(onOpenMediaReview
                      ? {
                          onOpenReview: (item, seconds) =>
                            onOpenMediaReview(
                              row.id,
                              item,
                              seconds,
                              row.replyCount > 0 ||
                                (!!row.threadRootId &&
                                  row.threadRootId !== row.id),
                            ),
                        }
                      : {})}
                  />
                );
              }
              return (
                <MediaAttachment
                  key={url}
                  attachment={{ ...attachment, url }}
                  media={media}
                  mode={mediaMode}
                  {...(attachment.kind === "video" && mediaSeekTo !== undefined
                    ? {
                        seekTo: mediaSeekTo,
                        ...(mediaSeekRequest !== undefined
                          ? { seekRequest: mediaSeekRequest }
                          : {}),
                      }
                    : {})}
                  {...(onMediaPlayback ? { onPlayback: onMediaPlayback } : {})}
                  {...(onOpenMediaReview
                    ? {
                        onOpenReview: (item, seconds) =>
                          onOpenMediaReview(
                            row.id,
                            item,
                            seconds,
                            row.replyCount > 0 ||
                              (!!row.threadRootId &&
                                row.threadRootId !== row.id),
                          ),
                      }
                    : {})}
                />
              );
            });
            return images ? (
              <div className={styles.imageGroup} key={group[0]?.url}>
                {/* biome-ignore lint/a11y/useSemanticElements: This labels related media links, not a fieldset of form controls. */}
                <div
                  className={styles.imageStrip}
                  role="group"
                  aria-label={`${group.length} ${group.length === 1 ? "image" : "images"}`}
                  onFocus={revealFocusedThumbnail}
                >
                  {items}
                </div>
                {group.length > 1 && (
                  <div className={styles.imageCount}>{group.length} images</div>
                )}
              </div>
            ) : files ? (
              <div className={styles.fileGroup} key={group[0]?.url}>
                {items}
              </div>
            ) : (
              items
            );
          })}
          {active && session && scope && extensions?.accessories && (
            <ComposerAccessories
              registry={extensions.accessories}
              session={session}
              scope={scope}
              channelId={row.channelId}
              threadRootId={row.threadRootId}
              message={row}
              onFocusedRemoval={() =>
                menuTrigger.current?.focus({ preventScroll: true })
              }
              openThread={
                onOpenThread
                  ? () => {
                      onOpenThread(row.id, row.threadRootId ?? row.id);
                      return true;
                    }
                  : undefined
              }
              canOpen={canOpenLink ?? (() => false)}
              open={onOpenLink}
            />
          )}
          {session && scope && extensions ? (
            <MessageReactions
              onFocusedRemoval={() => menuTrigger.current?.focus()}
              row={row}
              session={session}
              scope={scope}
              tools={extensions.tools}
              inline={extensions.inline}
              profiles={directory.profiles}
              disabled={
                !canReact ||
                (!!row.delivery && !["accepted", "seen"].includes(row.delivery))
              }
            />
          ) : (
            reactions.length > 0 && (
              <div className={`${styles.reactions} ${styles.reactionFallback}`}>
                {reactions.map((reaction) => (
                  <span
                    key={JSON.stringify([
                      reaction.content,
                      reaction.emoji?.url,
                    ])}
                  >
                    {extensions ? (
                      <InlineText
                        registry={extensions.inline}
                        content={{
                          text: reaction.content,
                          message: row,
                          reaction,
                        }}
                        media={media}
                      />
                    ) : (
                      reaction.content
                    )}{" "}
                    {
                      new Set(reaction.events.map((event) => event.authorId))
                        .size
                    }
                  </span>
                ))}
              </div>
            )
          )}
          {(row.replyCount > 0 ||
            (!row.threadRootId && threadAgents.length > 0)) &&
            onOpenThread && (
              <Button
                variant="ghost"
                size="sm"
                data-thread-summary=""
                data-first-participant-shape={
                  agentPubkeys?.has(row.participants[0] ?? "")
                    ? "squircle"
                    : "circle"
                }
                type="button"
                aria-label={
                  row.replyCount > 0
                    ? `View thread: ${row.replyCount} ${row.replyCount === 1 ? "reply" : "replies"}${unreadLabel ? `. ${unreadLabel}` : ""}${workingLabel ? `. ${workingLabel}` : ""}`
                    : `View thread: ${threadWorkingLabel}`
                }
                onClick={(event) => {
                  event.currentTarget.focus();
                  onOpenThread(row.id, row.threadRootId ?? row.id);
                }}
              >
                {row.replyCount > 0 && (
                  <ReplySummary
                    count={row.replyCount}
                    participants={row.participants}
                    profiles={participantProfiles}
                    agentPubkeys={agentPubkeys}
                    resolveName={resolveName}
                    media={media}
                    unreadLabel={unreadLabel}
                  />
                )}
                {threadAgents.length > 0 && (
                  <span
                    className={`${styles.threadWorking} buzz-arrive`}
                    data-thread-working=""
                    aria-hidden="true"
                  >
                    {threadAgents.slice(0, 2).map((agent) => {
                      const name = resolveName(agent.pubkey, agent.name);
                      return (
                        <Avatar
                          key={agent.pubkey}
                          src={
                            agent.avatar ? media(agent.avatar, "small") : null
                          }
                          alt=""
                          fallback={name}
                          size="compact"
                          shape="squircle"
                        />
                      );
                    })}
                    {threadAgents.length > 2 && (
                      <span>+{threadAgents.length - 2}</span>
                    )}
                    <TypingDots state={threadWaiting ? "waiting" : "working"} />
                  </span>
                )}
                {threadAgents.length > 0 && row.replyCount === 0 && (
                  <span>View thread</span>
                )}
              </Button>
            )}
        </div>
      </div>
    </div>
  );
}
/** Coordination between agents reads as one quiet line in time order: who
 * wrote it, who it is for, and its first paragraph. Opening the line shows
 * the whole message. The mentions it opens with become the line's recipients,
 * so they are not repeated in its text. */
export const MessageRow = memo(function AudienceMessageRow(
  props: MessageRowProps,
) {
  return props.row.audience === "agents" ? (
    <AgentsMessageRow {...props} />
  ) : (
    <FullMessageRow {...props} />
  );
});

function AgentsMessageRow(props: MessageRowProps) {
  const { row, session, media, participantProfiles, agentPubkeys } = props;
  const [open, setOpen] = useState(false);
  const resolveName = useChannelIdentityNames(session, row.channelId);
  const directory = useReferenceDirectory(session, participantProfiles);
  const { recipients, body } = useMemo(
    () =>
      addressedMessage(
        row,
        profileMentionParts(row, directory.profiles, directory.agents),
      ),
    [row, directory.profiles, directory.agents],
  );
  const person = (pubkey: string, profile: Profile | undefined) => {
    const name = resolveName(pubkey, profile?.name ?? pubkey.slice(0, 10));
    const agent =
      agentPubkeys?.has(pubkey) ||
      !!profile?.isAgent ||
      directory.agents.some((item) => item.pubkey === pubkey);
    return {
      pubkey,
      name,
      picture: profile?.picture ? media(profile.picture, "small") : undefined,
      shape: agent ? ("squircle" as const) : ("circle" as const),
    };
  };
  const author = person(row.authorId, props.profile);
  const to = recipients.map((pubkey) =>
    person(pubkey, directory.profiles.get(pubkey)),
  );
  const preview = messagePreviewText(body.content);
  const avatar = (who: typeof author) => (
    <span key={who.pubkey} className={styles.audienceAvatar} title={who.name}>
      <AgentAvatar
        session={session}
        agentPubkey={who.pubkey}
        channelId={row.channelId}
        src={who.picture}
        alt=""
        fallback={who.name}
        size="fill"
        shape={who.shape}
      />
    </span>
  );
  return (
    <div
      className={styles.audienceRow}
      data-audience="agents"
      data-open={open || undefined}
    >
      {props.day && <DayDivider createdAt={row.createdAt} />}
      {/* Open, the message starts beside its addresses and the whole entry
          stays highlighted, so it reads as one box that folds back. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: folding by click is a pointer shortcut; the line's button folds it from the keyboard. */}
      <div
        className={styles.audienceEntry}
        // Collapsed, the entry stands in for the message as a scroll anchor.
        // Not the button: revealing an anchor takes it out of the Tab order.
        data-message-id={open ? undefined : row.id}
        // Open, a click anywhere in the box folds it, except on its own
        // controls and links or at the end of a text selection.
        onClick={(event) => {
          const target = event.target as Element;
          if (
            !open ||
            !event.currentTarget.contains(target) ||
            target.closest(
              "a, button, input, textarea, select, summary, [role='button'], [role='menuitem'], [contenteditable='true']",
            ) ||
            !target.ownerDocument.getSelection()?.isCollapsed
          )
            return;
          setOpen(false);
        }}
      >
        <button
          type="button"
          data-buzz-ui=""
          className={styles.audienceLine}
          aria-expanded={open}
          aria-label={`${author.name}${to.length ? ` to ${to.map((who) => who.name).join(", ")}` : ""}: ${preview}`}
          onClick={() => setOpen(!open)}
        >
          {avatar(author)}
          {to.length > 0 && (
            <>
              <ArrowRightIcon
                size={12}
                aria-hidden="true"
                className={styles.audienceArrow}
              />
              {to.map(avatar)}
            </>
          )}
          {!open && (
            <>
              <span className={styles.audiencePreview}>{preview}</span>
              <MessageTimestamp createdAt={row.createdAt} />
            </>
          )}
        </button>
        {open && (
          <div className={styles.audienceBody}>
            <FullMessageRow
              {...props}
              shownRow={body}
              day={false}
              layout="continuation"
            />
          </div>
        )}
      </div>
    </div>
  );
}

// Subscribe only for mounted thread buttons. Evidence and reading remain session-owned;
// rendering a row must not initiate per-thread reads or acknowledge unseen replies.
function useThreadUnread(
  unread: UnreadCapability | undefined,
  channelId: string,
  rootId: string,
) {
  const subscribe = useCallback(
    (listener: () => void) =>
      unread?.subscribe({ kind: "thread", channelId, rootId }, listener) ??
      (() => {}),
    [unread, channelId, rootId],
  );
  const get = useCallback(
    () => unread?.snapshot({ kind: "thread", channelId, rootId }),
    [unread, channelId, rootId],
  );
  return useSyncExternalStore(subscribe, get, get);
}
const noSubscribe = () => () => {};
const none: readonly never[] = [];
const noActions = () => none;
const noLibrary = () => undefined;
// Confirmed lifecycle evidence wins; legacy agents retain public typing fallback.
// A joined-key snapshot keeps unrelated typing from re-rendering the row. Like
// the sidebar, only the viewer's own agents count: the library is read while
// someone types here, so an agent no loaded row names yet is still recognized.
function useThreadAgents(
  session: RelaySession | undefined,
  channelId: string,
  rootId: string,
  messageId: string,
  messageThreadRootId: string | undefined,
) {
  const represented = useReplacedTypers(
    session,
    channelId,
    messageThreadRootId,
  );
  const get = () =>
    session?.typing
      .snapshot()
      .filter(
        (entry) =>
          entry.channelId === channelId && entry.threadRootId === rootId,
      )
      .map((entry) => entry.pubkey)
      .join(",") ?? "";
  const keys = useSyncExternalStore(
    session?.typing.subscribe ?? noSubscribe,
    get,
    get,
  );
  // Subscribe to this thread's working agents, not every activity step.
  const getWork = () => {
    const activity = session?.agentActivity?.snapshot();
    const typers = threadWorkingAgents(
      activity,
      keys ? keys.split(",") : [],
      channelId,
      rootId,
      { messageId, agents: represented },
    );
    const local = localActivity(
      {
        local: (activity?.local ?? []).filter(
          (row) => row.messageId !== messageId || !represented.has(row.agent),
        ),
      },
      channelId,
      rootId,
    );
    const waiting =
      typers.length > 0 && typers.every((agent) => breathing(local.get(agent)));
    return `${waiting ? "waiting" : "working"}:${typers.join(",")}`;
  };
  const work = useSyncExternalStore(
    session?.agentActivity?.subscribe ?? noSubscribe,
    getWork,
    getWork,
  );
  const [state, joined = ""] = work.split(/:(.*)/s);
  const typers = joined ? joined.split(",") : [];
  const hasWork = typers.length > 0;
  const getLibrary = (hasWork && session?.agentChoices.snapshot) || noLibrary;
  const library = useSyncExternalStore(
    (hasWork && session?.agentChoices.subscribe) || noSubscribe,
    getLibrary,
    getLibrary,
  );
  return {
    agents:
      library?.identities.filter(({ pubkey }) => typers.includes(pubkey)) ?? [],
    waiting: state === "waiting",
  };
}
