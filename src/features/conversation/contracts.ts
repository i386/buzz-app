// FOUNDATION: Preview conversation contribution contract; data and delivery stay session-owned.
import type { ComponentType } from "react";
import type { Contribution, MatchOrder } from "../../plugins/contributions";
import type { VoiceRecording } from "../relay/voice-media";
import type { Attachment, ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";

/** Editor-independent reference to plugin content. Not an access grant or recipient. */
export type ComposerResource = Readonly<{ uri: string; label: string }>;
export type ComposerToolProps = Readonly<{
  session: RelaySession;
  scope: string;
  channelId: string;
  threadRootId?: string | undefined;
  /** Sessions may offer library agents; the host confirms channel admission before sending. */
  inviteAgents?: boolean | undefined;
  disabled: boolean;
  /** False after removal, destination change, read-only state or a rejected edit. */
  insertText(text: string): boolean;
  /** Atomically insert display text and explicit notification intent at the caret.
   * Prose never resolves to identities. Membership is checked by session delivery.
   * Like insertText, this command is revoked with the tool/destination lifetime. */
  insertMention(recipient: Readonly<{ pubkey: string; name: string }>): boolean;
  /** All-or-nothing insertion of a saved selection as individual mentions. */
  insertMentions(
    recipients: readonly Readonly<{ pubkey: string; name: string }>[],
  ): boolean;
  /** Atomically insert a host-owned inline resource at the caret. The host validates
   * the link, escapes the label and sends exactly `[label](uri)` there; the draft
   * keeps it after tool removal. Otherwise returns the host's user-facing reason. */
  insertResource(resource: ComposerResource): true | string;
  capture?(
    component: ComponentType<ComposerCaptureProps>,
  ): (() => void) | false;
  focus(): void;
}>;
export type ComposerCaptureProps = Readonly<{
  accept(recording: VoiceRecording): boolean;
  cancel(): void;
}>;
export type AttachmentRendererProps = Readonly<{
  attachment: Attachment;
  source: string;
  onRemove?: (() => void) | undefined;
}>;
export type AttachmentRenderer = Readonly<{
  id: string;
  title: string;
  matches(attachment: Attachment): boolean;
  component: ComponentType<AttachmentRendererProps>;
}>;
export type ReactionToolProps = Readonly<{
  session: RelaySession;
  scope: string;
  disabled: boolean;
  /** Host-owned reaction intent; revoked when the tool or target is removed. */
  select(emoji: string): boolean;
}>;
export type ComposerTool = Readonly<{
  id: string;
  title: string;
  /** Lower values appear first; defaults to zero. Equal values sort by contribution key. */
  order?: number;
  component: ComponentType<ComposerToolProps>;
  /** Optional emoji-only chooser for the message reaction row. */
  reactionComponent?: ComponentType<ReactionToolProps>;
}>;
export type InlineContent = Readonly<{
  text: string;
  message: ChannelMessage;
  reaction?: ChannelMessage["reactions"][number] | undefined;
}>;
export type InlineRange = Readonly<{ start: number; end: number }>;
export type InlineRenderer = Readonly<{
  id: string;
  title: string;
  /** UTF-16 ranges within this plain-text segment. Links are never offered. */
  matches(content: InlineContent): readonly InlineRange[];
  component: ComponentType<{
    text: string;
    content: InlineContent;
    media(url: string): string | undefined;
  }>;
}>;
/** Link presentation only. The host retains the anchor, destination and activation. */
export type LinkRenderer = Readonly<{
  id: string;
  title: string;
  matches(url: string): boolean;
  /** Claim strength when several renderers match a URL; see `MatchOrder`. */
  order?: MatchOrder | undefined;
  className?: string | undefined;
  component: ComponentType<{ url: string }>;
}>;
export type ContributionReader<T> = Readonly<{
  snapshot(): readonly Contribution<T>[];
  subscribe(listener: () => void): () => void;
}>;
export type ComposerAccessoryProps = Readonly<{
  session: RelaySession;
  scope: string;
  channelId: string;
  threadRootId?: string | undefined;
  /** Present only for message-placed accessories; the exact triggering row. */
  message?: ChannelMessage;
  /** Host-owned thread navigation from a timeline message, even before replies.
   * Absent inside the thread. False after this contribution or message retires. */
  openThread?: (() => boolean) | undefined;
  /** Return keyboard focus to a stable host control when a focused accessory retires. */
  onFocusedRemoval?: (() => void) | undefined;
  /** Presentation only; the host re-resolves targets. No editor or access grant. */
  canOpen(target: string): boolean;
  /** False after contribution removal or the originating composer retires. */
  open(target: string): boolean;
}>;
export type ComposerAccessory = Readonly<{
  /** Defaults to the composer. Message accessories render beside reactions. */
  placement?: "composer" | "message";
  id: string;
  title: string;
  order?: number;
  component: ComponentType<ComposerAccessoryProps>;
}>;
/** A whole message body, not an inline Markdown segment. No data or delivery ownership. */
export type MessageRenderer = Readonly<{
  id: string;
  title: string;
  matches(message: ChannelMessage): boolean;
  component: ComponentType<{ message: ChannelMessage }>;
}>;
/** One ⋯ menu entry for a message. The host owns the menu, focus and row lifetime. */
export type MessageAction = Readonly<{
  id: string;
  title: string;
  icon?: ComponentType;
  matches(message: ChannelMessage, session: RelaySession): boolean;
  /** Mounted by the row after the menu closes; call close() to dismiss. */
  component: ComponentType<{
    message: ChannelMessage;
    session: RelaySession;
    close(): void;
  }>;
  /**
   * Optional presentation beside the message timestamp, such as a state mark.
   * Rendered only while `matches` passes: hiding the menu entry hides the mark.
   */
  marker?: ComponentType<{ message: ChannelMessage; session: RelaySession }>;
}>;
export type ConversationExtensions = Readonly<{
  attachments?: ContributionReader<AttachmentRenderer>;
  messages?: ContributionReader<MessageRenderer>;
  actions?: ContributionReader<MessageAction>;
  accessories?: ContributionReader<ComposerAccessory>;
  tools: ContributionReader<ComposerTool>;
  inline: ContributionReader<InlineRenderer>;
  completions?: ContributionReader<ComposerCompletion>;
  links?: ContributionReader<LinkRenderer>;
}>;

/** Immutable host-issued evidence, scoped to one live editor observation. */
export type ComposerObservation = Readonly<{
  revision: number;
  text: string;
  start: number;
  end: number;
}>;
export type CompletionContext = Pick<
  ComposerToolProps,
  "session" | "scope" | "channelId" | "threadRootId" | "inviteAgents"
>;
export type CompletionQuery = Readonly<{
  start: number;
  end: number;
  query: string;
}>;
export type CompletionEdit =
  | Readonly<{ text: string; mention?: never; mentions?: never }>
  | Readonly<{
      mention: Readonly<{ pubkey: string; name: string }>;
      text?: never;
      mentions?: never;
    }>
  | Readonly<{
      mentions: readonly Readonly<{ pubkey: string; name: string }>[];
      text?: never;
      mention?: never;
    }>;
export type CompletionSuggestion = Readonly<{
  id: string;
  label: string;
  detail?: string;
  /** Decorative presentation only; the host owns option semantics and interaction. */
  preview?: import("react").ReactNode;
  edit: CompletionEdit;
  /** Keep an installed identity in place after eligibility is revoked. */
  disabled?: string | undefined;
  /** Final synchronous evidence check; false never falls through to sending. */
  canSelect?: ((key: string) => boolean) | undefined;
}>;
export type CompletionResult = Readonly<{
  items: readonly CompletionSuggestion[];
  /** Provider-verified unique exact match across its uncapped candidate set. */
  spaceId?: string | undefined;
  status?: string;
  /** Optional explicit recovery. A new query or disposal revokes this action. */
  retry?: () => void;
}>;
export type ComposerCompletionProps = CompletionContext &
  Readonly<{
    observation: ComposerObservation;
    query: CompletionQuery;
    /** Publishes only for this query/lifetime; returns false after revocation.
     * Cleanup of the returned disposer withdraws that exact publication. */
    publish(result: CompletionResult): (() => void) | false;
  }>;
export type ComposerCompletion = Readonly<{
  id: string;
  title: string;
  order?: number;
  /** Pure syntax matcher. Host prefers the closest trigger; order/key break ties. */
  match(
    observation: ComposerObservation,
    context: CompletionContext,
  ): CompletionQuery | null;
  component: ComponentType<ComposerCompletionProps>;
}>;
