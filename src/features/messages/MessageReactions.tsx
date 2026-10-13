import { useConversationPresentation } from "../conversation/ConversationPresentation";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { PreviewCard } from "../../shared/design-system/ui/PreviewCard";
import { ReactionDelivery, ReactionTool } from "../conversation/ReactionTool";
import { InlineText } from "../conversation/InlineText";
import type {
  ComposerTool,
  ContributionReader,
  InlineRenderer,
} from "../conversation/contracts";
import type {
  ChannelMessage,
  MessageReaction,
  Profile,
} from "../relay/contracts";
import type { CustomEmoji } from "../relay/emoji";
import type { RelaySession } from "../relay/session";
import type { OutgoingEvent } from "../relay/outbox";
import { selectProfiles } from "../relay/profile-selection";
import { recordReaction, useQuickReactions } from "./quick-reactions";
import { AnimatedReactionCount } from "./AnimatedReactionCount";
import styles from "./Messages.module.css";

type Props = {
  row: ChannelMessage;
  session: RelaySession;
  scope: string;
  disabled: boolean;
  tools: ContributionReader<ComposerTool>;
  inline: ContributionReader<InlineRenderer>;
};
/**
 * Who reacted is the pill's primary answer and people scan several pills in a
 * row, so the first hover opens quickly (as Slack does); once a preview is
 * open, moving along the row switches previews immediately.
 */
export const REACTION_PREVIEW_DELAY_MS = 100;
const noSubscribe = () => () => {};
const noOperations = Object.freeze([]);
const empty = () => noOperations;

function useReactionAction({ row, session, scope, disabled }: Props) {
  const presented = useConversationPresentation();
  const [error, setError] = useState<string>();
  const active = useRef(false);
  useLayoutEffect(() => {
    active.current = !disabled && presented;
  });
  useLayoutEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  const operations = useSyncExternalStore(
    session.outbox?.subscribe ?? noSubscribe,
    session.outbox?.snapshot ?? empty,
    session.outbox?.snapshot ?? empty,
  );
  const blocksToggle = (item: OutgoingEvent) =>
    ["sending", "failed", "unknown"].includes(item.delivery) &&
    session.messages.reactionTarget(item.event) === row.id;
  const busy = operations.some(blocksToggle);
  const toggle = (content: string, emoji?: CustomEmoji) => {
    if (!active.current || session.outbox?.snapshot().some(blocksToggle))
      return false;
    try {
      const group = row.reactions.find(
        (reaction) =>
          reaction.content === content && reaction.emoji?.url === emoji?.url,
      );
      const mine =
        group?.events.filter((event) => event.authorId === session.viewer) ??
        [];
      if (mine.length) session.messages.remove(mine.map((event) => event.id));
      else {
        session.messages.react(row.id, content, emoji);
        recordReaction(scope, content);
      }
      setError(undefined);
      return true;
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not update reaction. Try again.",
      );
      return false;
    }
  };
  return { toggle, disabled: disabled || busy, error };
}

function ReactionLabel({
  reaction,
  row,
  inline,
  session,
}: {
  reaction: MessageReaction;
  row: ChannelMessage;
  inline: ContributionReader<InlineRenderer>;
  session: RelaySession;
}) {
  return (
    <InlineText
      registry={inline}
      content={{ text: reaction.content, message: row, reaction }}
      media={session.media}
    />
  );
}

const catalogIndexes = new WeakMap<
  readonly CustomEmoji[],
  ReadonlyMap<string, CustomEmoji>
>();
/** Every row looks up its quick reactions on each render; index each catalog snapshot once. */
function catalogEmoji(entries: readonly CustomEmoji[], content: string) {
  if (!content.startsWith(":")) return undefined;
  let index = catalogIndexes.get(entries);
  if (!index) {
    index = new Map(entries.map((entry) => [`:${entry.shortcode}:`, entry]));
    catalogIndexes.set(entries, index);
  }
  return index.get(content.toLowerCase());
}

/** PR 1's quick-control slot. The emoji contribution continues to own its picker. */
export function MessageReactionControls(props: Props) {
  const { row, session, scope, inline, tools } = props;
  const catalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  const shortcuts = useQuickReactions(scope, catalog.entries);
  const action = useReactionAction(props);
  const select = (content: string) =>
    action.toggle(content, catalogEmoji(catalog.entries, content));
  return (
    <>
      {shortcuts.map((content) => {
        const emoji = catalogEmoji(catalog.entries, content);
        const mine = row.reactions.some(
          (reaction) =>
            reaction.content === content &&
            reaction.emoji?.url === emoji?.url &&
            reaction.events.some((event) => event.authorId === session.viewer),
        );
        return (
          <span key={content} className={styles.quickReaction}>
            <IconButton
              size="sm"
              variant="ghost"
              disabled={action.disabled}
              aria-label={`${mine ? "Remove" : "React with"} ${content}`}
              aria-pressed={mine}
              onClick={() => select(content)}
              icon={
                <span
                  className={styles.quickReactionGlyph}
                  data-emoji={emoji ? undefined : content}
                >
                  {emoji && (
                    <ReactionLabel
                      row={row}
                      inline={inline}
                      session={session}
                      reaction={{ content, emoji, events: [] }}
                    />
                  )}
                </span>
              }
            />
          </span>
        );
      })}
      <ReactionTool
        registry={tools}
        session={session}
        scope={scope}
        messageId={row.id}
        disabled={action.disabled}
        select={select}
        showDelivery={false}
      />
      {action.error && <span role="alert">{action.error}</span>}
    </>
  );
}

function ReactionGlyph({
  reaction,
  session,
}: {
  reaction: MessageReaction;
  session: RelaySession;
}) {
  const source = reaction.emoji ? session.media(reaction.emoji.url) : undefined;
  const [failed, setFailed] = useState<string>();
  return source && source !== failed ? (
    <img
      className={styles.reactionCustomEmoji}
      src={source}
      alt=""
      draggable={false}
      onError={() => setFailed(source)}
    />
  ) : (
    <span
      className={
        reaction.emoji
          ? styles.reactionFallbackEmoji
          : styles.reactionNativeEmoji
      }
      aria-hidden="true"
    >
      {reaction.emoji ? `:${reaction.emoji.shortcode}:` : reaction.content}
    </span>
  );
}

function ReactionPill({
  reaction,
  session,
  profiles,
  disabled,
  unavailable,
  toggle,
  onFocusedRemoval,
  previewDelay,
  previewSlide,
  previewOpen,
  onPreviewChange,
}: {
  reaction: MessageReaction;
  session: RelaySession;
  profiles?: ReadonlyMap<string, Profile> | undefined;
  disabled: boolean;
  unavailable: boolean;
  toggle(content: string, emoji?: CustomEmoji): boolean;
  onFocusedRemoval?: (() => void) | undefined;
  previewDelay: number;
  previewSlide: "left" | "right" | undefined;
  previewOpen: boolean;
  onPreviewChange(open: boolean): void;
}) {
  const [name, setName] = useState(reaction.content);
  const authors = [...new Set(reaction.events.map((event) => event.authorId))];
  const authorIds = authors.slice().sort().join(":");
  const reactorProfiles = useMemo(
    () =>
      selectProfiles(session.profiles, authorIds ? authorIds.split(":") : []),
    [session.profiles, authorIds],
  );
  const loadedReactors = useSyncExternalStore(
    reactorProfiles.subscribe,
    reactorProfiles.snapshot,
    reactorProfiles.snapshot,
  );
  const mine = authors.includes(session.viewer ?? "");
  const users = [
    ...(mine ? ["You"] : []),
    ...authors
      .filter((author) => author !== session.viewer)
      .map(
        (author) =>
          loadedReactors.get(author)?.name ??
          profiles?.get(author)?.name ??
          author.slice(0, 10),
      ),
  ];
  const revealName = () => {
    void session.profiles.ensure(authors, "background").catch(() => {});
    if (reaction.emoji) return;
    void import("./reaction-name").then(({ reactionName }) =>
      setName(reactionName(reaction.content)),
    );
  };
  return (
    <span className={styles.reactionPillWrap}>
      <PreviewCard
        side="top"
        open={previewOpen}
        delay={previewDelay}
        className={[
          styles.reactionPreview,
          previewSlide === "left" && styles.reactionPreviewSlideLeft,
          previewSlide === "right" && styles.reactionPreviewSlideRight,
        ]
          .filter(Boolean)
          .join(" ")}
        onOpenChange={onPreviewChange}
        trigger={
          <button
            type="button"
            className={styles.reactionChip}
            data-reaction={reaction.content}
            aria-label={`${reaction.content}: ${authors.length} ${authors.length === 1 ? "person" : "people"}${mine ? ", including you" : ""}`}
            aria-pressed={mine}
            aria-disabled={unavailable}
            disabled={disabled}
            onMouseEnter={revealName}
            onFocus={revealName}
            onClick={(event) => {
              if (unavailable) return;
              const losesFocus =
                mine &&
                authors.length === 1 &&
                event.currentTarget === document.activeElement;
              if (toggle(reaction.content, reaction.emoji) && losesFocus)
                onFocusedRemoval?.();
            }}
          >
            <ReactionGlyph reaction={reaction} session={session} />
            <AnimatedReactionCount value={authors.length} />
          </button>
        }
      >
        <span className={styles.reactionPreviewEmoji}>
          <ReactionGlyph reaction={reaction} session={session} />
          <span className={styles.reactionPreviewName}>{name}</span>
        </span>
        <span className={styles.reactionPreviewNames}>{users.join(", ")}</span>
      </PreviewCard>
    </span>
  );
}

/** Always mounted under the message so failed add/remove operations stay recoverable. */
export function MessageReactions(
  props: Props & {
    onFocusedRemoval?: () => void;
    profiles?: ReadonlyMap<string, Profile>;
  },
) {
  const active = useConversationPresentation();
  const { row, session, scope, tools } = props;
  const reactions = row.reactions;
  const action = useReactionAction(props);
  const catalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  const [pointerInRow, setPointerInRow] = useState(false);
  const [preview, setPreview] = useState<{
    key: string | null;
    index: number;
    fromIndex: number | undefined;
  }>();
  if (!active && preview) setPreview(undefined);
  if (!active && pointerInRow) setPointerInRow(false);
  const select = (content: string) => {
    return action.toggle(content, catalogEmoji(catalog.entries, content));
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: This groups reactions, not form fields.
    <div
      className={styles.reactions}
      data-testid="reaction-row"
      role="group"
      aria-label="Reactions"
      onMouseEnter={() => setPointerInRow(true)}
      onMouseLeave={() => {
        setPointerInRow(false);
        setPreview(undefined);
      }}
    >
      {active &&
        reactions.map((reaction, index) => {
          const key = JSON.stringify([reaction.content, reaction.emoji?.url]);
          const slideFrom =
            preview?.key === key ? preview.fromIndex : preview?.index;
          const previewSlide =
            pointerInRow && slideFrom !== undefined && slideFrom !== index
              ? index > slideFrom
                ? "right"
                : "left"
              : undefined;
          return (
            <ReactionPill
              key={key}
              reaction={reaction}
              session={session}
              profiles={props.profiles}
              disabled={props.disabled}
              unavailable={action.disabled}
              toggle={action.toggle}
              onFocusedRemoval={props.onFocusedRemoval}
              previewDelay={
                pointerInRow && preview ? 0 : REACTION_PREVIEW_DELAY_MS
              }
              previewOpen={preview?.key === key}
              previewSlide={previewSlide}
              onPreviewChange={(open) =>
                setPreview((current) =>
                  open
                    ? {
                        key,
                        index,
                        fromIndex:
                          current?.key === key
                            ? current.fromIndex
                            : current?.index,
                      }
                    : current?.key === key
                      ? { ...current, key: null }
                      : current,
                )
              }
            />
          );
        })}
      {active && reactions.length > 0 && !props.disabled && (
        <span
          className={styles.inlineReactionTool}
          data-testid="inline-add-reaction"
        >
          <ReactionTool
            registry={tools}
            session={session}
            scope={scope}
            messageId={row.id}
            disabled={action.disabled}
            select={select}
            showDelivery={false}
          />
        </span>
      )}
      {action.error && <span role="alert">{action.error}</span>}
      <ReactionDelivery session={session} messageId={row.id} />
    </div>
  );
}
