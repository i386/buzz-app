import { memo, useEffect, useId, useLayoutEffect } from "react";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { PageNavigation } from "../../features/navigation/service";
import type { Attachment } from "../../features/relay/contracts";
import { useChannelWindow } from "../../features/relay/react";
import { clientMetrics } from "../../features/developer/client-metrics";
import { ChannelTimeline } from "../../features/messages/ChannelTimeline";
import type { MessageLinkOrigin } from "../../features/messages/MessageRow";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./Channels.module.css";

export const ChannelBody = memo(function ChannelBody({
  cached,
  viewer,
  extensions,
  scope,
  queries,
  channelId,
  onOpenLink,
  canOpenLink,
  revealMessageId,
  onOpenThread,
  onOpenMediaReview,
  navigation,
}: {
  extensions?: ConversationExtensions | undefined;
  scope: string;
  queries: RelaySession;
  cached: boolean;
  viewer?: string | undefined;
  channelId: string;
  navigation?: PageNavigation | undefined;
  onOpenLink(url: string, origin?: MessageLinkOrigin): boolean;
  canOpenLink?: ((target: string) => boolean) | undefined;
  revealMessageId?: string | undefined;
  onOpenThread?:
    | ((messageId: string, threadRootId: string, intent?: "reply") => void)
    | undefined;
  onOpenMediaReview(
    messageId: string,
    attachment: Attachment,
    seconds: number,
    hasComments?: boolean,
  ): void;
}) {
  // ChannelWorkspace already keys this lifetime by viewer/scope/generation.
  const continuityKey = useId();
  const window = useChannelWindow(queries.channels, channelId);
  useLayoutEffect(() => {
    clientMetrics.channelMounted(channelId);
    return () => clientMetrics.channelUnmounted(channelId);
  }, [channelId]);
  const newest = window.rows.at(-1)?.id;
  const settled = window.status === "ready" || window.status === "error";
  useLayoutEffect(() => {
    // Repeat calls for the same open are ignored; only the first rows count.
    // Any row counts as content, since a saved scroll position may keep the
    // newest one unmounted.
    if (newest)
      clientMetrics.channelRendered(
        channelId,
        () =>
          !!document.querySelector(
            `[data-channel-timeline="${CSS.escape(channelId)}"] [data-message-id]`,
          ),
      );
    else if (settled) clientMetrics.channelEmpty(channelId);
  }, [channelId, newest, settled]);
  useEffect(() => {
    // Only the normalized conversation attempt can acknowledge its channel.
    // A warm child effect runs before the parent's default resolution effect.
    if (
      navigation?.target.kind !== "conversation" ||
      navigation.target.messageId
    )
      return;
    if (window.status === "ready") navigation?.complete({ status: "opened" });
    else if (!cached && window.status === "error")
      navigation?.complete({ status: "failed", reason: "unavailable" });
  }, [cached, navigation, window.status]);
  if (window.status === "error" && !window.rows.length)
    return (
      <div
        className={`${styles.empty} ${styles.timelinePlaceholder}`}
        role="alert"
      >
        <p>{window.error}</p>
        <Button
          type="button"
          onClick={() => queries.channels.ensure(channelId)}
        >
          Retry messages
        </Button>
      </div>
    );
  if (window.status !== "ready" && !window.rows.length)
    return (
      <div
        className={`${styles.empty} ${styles.timelinePlaceholder}`}
        role="status"
        data-buzz-launch-pending={!cached ? "required" : undefined}
      >
        Loading messages…
      </div>
    );
  return (
    <ChannelTimeline
      continuityKey={continuityKey}
      viewer={viewer}
      extensions={extensions}
      scope={scope}
      channelId={channelId}
      queries={queries}
      window={window}
      launchPending={
        !cached &&
        !window.error &&
        (window.status === "idle" ||
          window.status === "loading" ||
          (window.status === "ready" && window.freshness === "cached"))
      }
      onOpenLink={onOpenLink}
      canOpenLink={canOpenLink}
      {...(onOpenThread ? { onOpenThread } : {})}
      onOpenMediaReview={onOpenMediaReview}
      revealMessageId={revealMessageId}
      navigation={navigation}
    />
  );
});
