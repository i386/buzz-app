import { attachmentMessage, type UploadedAttachment } from "./attachments";
import { validReactionContent, type CustomEmoji } from "./emoji";
import type { EventTemplate } from "nostr-tools";
import type { ChannelMessage } from "./contracts";
import { messageAuthor } from "./fold";
import { threadReference } from "./thread-reference";
import type { EventData } from "./events";
import type { Outbox, OutboxRecovery } from "./outbox";

/** Owner authorization is supplied only after the agent's signed profile is verified. */
export type AgentOwnerAuthorization = Readonly<{
  agentId: string;
  ownerId: string;
}>;

/** NIP-56 types accepted by the Buzz relay for message reports. */
export const REPORT_TYPES = [
  "spam",
  "profanity",
  "nudity",
  "impersonation",
  "malware",
  "illegal",
  "other",
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
/** `["effort", agentPubkey, level]` and `["model", agentPubkey, model]`: what
 * a mentioned agent's owner asks of its next run. Only the owner is honoured. */
export const EFFORT_TAG = "effort";
export const MODEL_TAG = "model";
export type RunPick = Readonly<{ model?: string; effort?: string }>;
/** The model and effort picked for each mentioned agent, by pubkey. */
export type MentionPicks = Readonly<Record<string, RunPick>>;

/** Domain convenience only. Delivery and read reconciliation remain session-owned. */
export function createMessages(
  outbox: Outbox | undefined,
  viewer: string | undefined,
  find: (id: string) => EventData | undefined,
  emojiTags: (content: string) => string[][],
  validateMentions: (channelId: string, pubkeys: readonly string[]) => void,
  canParticipate: (channelId: string) => boolean = () => true,
  relayOrigin?: string,
  /** Resolves on relay OK. Reports are never echoed, so they bypass the outbox. */
  publishReport?: (template: EventTemplate) => Promise<void>,
  /** Explicit relay NIP-11 self; never inferred from contacts or a displayed row. */
  signingAuthority?: string,
) {
  const writer = (kind: number, channelId: string) => {
    if (!canParticipate(channelId))
      throw new Error("Join the conversation before posting");
    if (!outbox?.supports(kind))
      throw new Error("This connection cannot publish that operation");
    return outbox;
  };
  const ownedMessage = (event: EventData) =>
    !!viewer && messageAuthor(event, signingAuthority) === viewer;
  const text = (content: string) => {
    const value = content.trim();
    if (!value) throw new Error("Message is empty");
    return value;
  };
  const mentionTags = (channelId: string, pubkeys: readonly string[]) => {
    if (
      pubkeys.length > 32 ||
      pubkeys.some((key) => !/^[0-9a-f]{64}$/.test(key))
    )
      throw new Error("Choose at most 32 valid mention recipients");
    const unique = [...new Set(pubkeys)];
    validateMentions(channelId, unique);
    return unique.map((key) => ["p", key]);
  };
  const referenceTags = (pubkeys: readonly string[]) => {
    if (
      pubkeys.length > 32 ||
      pubkeys.some((key) => !/^[0-9a-f]{64}$/.test(key))
    )
      throw new Error("Choose at most 32 valid mention references");
    return [...new Set(pubkeys)].map((key) => ["mention", key]);
  };
  const pickTags = (mentions: readonly string[], picks: MentionPicks) =>
    Object.entries(picks).flatMap(([key, { model, effort }]) => {
      if (
        !mentions.includes(key) ||
        (model !== undefined && !/^[\w.:[\]-]{1,64}$/.test(model)) ||
        (effort !== undefined && !/^[a-z0-9-]{1,32}$/.test(effort))
      )
        throw new Error("A model or effort applies only to a mentioned agent");
      return [
        ...(model === undefined ? [] : [[MODEL_TAG, key, model]]),
        ...(effort === undefined ? [] : [[EFFORT_TAG, key, effort]]),
      ];
    });
  return Object.freeze({
    send(
      channelId: string,
      content: string,
      mentions: readonly string[] = [],
      attachments: readonly UploadedAttachment[] = [],
      recovery?: OutboxRecovery,
      references: readonly string[] = [],
      picks: MentionPicks = {},
    ) {
      if (!channelId) throw new Error("A channel is required");
      const message = attachmentMessage(content, attachments, relayOrigin);
      return writer(9, channelId).send(
        {
          kind: 9,
          content: text(message.content),
          tags: [
            ["h", channelId],
            ...mentionTags(channelId, mentions),
            ...referenceTags(references),
            ...pickTags(mentions, picks),
            ...emojiTags(content),
            ...message.tags,
          ],
        },
        ...(recovery ? [recovery] : []),
      );
    },
    /** Copy an authored reply as a fresh top-level event, preserving its displayed semantics. */
    sendToChannel(row: ChannelMessage, root?: ChannelMessage) {
      const original = find(row.id);
      const thread = original && threadReference(original);
      if (original?.kind !== 9 || !thread)
        throw new Error("Load a thread reply before sending it to the channel");
      if (!ownedMessage(original) || row.authorId !== viewer)
        throw new Error("Only your own messages can be sent to the channel");
      const channelId = original.tags.find(([name]) => name === "h")?.[1];
      if (
        !channelId ||
        channelId !== row.channelId ||
        row.threadRootId !== thread.rootId ||
        (row.delivery && !["accepted", "seen"].includes(row.delivery))
      )
        throw new Error(
          "Reload the thread reply before sending it to the channel",
        );
      const attachmentSource = find(row.attachmentSourceId ?? row.id);
      if (
        !attachmentSource ||
        !ownedMessage(attachmentSource) ||
        (attachmentSource.id !== original.id &&
          (attachmentSource.kind !== 40003 ||
            !attachmentSource.tags.some(
              ([name, id]) => name === "e" && id === row.id,
            ) ||
            attachmentSource.tags.some(
              ([name, id]) => name === "h" && id !== channelId,
            )))
      )
        throw new Error("Reload the message attachments before sending");
      // The mounted thread supplies its reconciled root, including edits/deletions.
      // Never fall back to the raw retained event, which may contain superseded text.
      const excerpt =
        root?.id === thread.rootId && root.channelId === channelId
          ? Array.from(
              root.content
                .replace(/\|\|[\s\S]*?(?:\|\||$)/g, " ")
                .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
                .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
                .replace(/(?:https?:\/\/|buzz:\/\/)\S+/g, " ")
                .replace(/[`*_~>#|]/g, " ")
                .replace(/\s+/g, " ")
                .trim(),
            )
          : [];
      const label =
        excerpt.length > 64
          ? `${excerpt.slice(0, 63).join("")}…`
          : excerpt.join("");
      const content = row.sourceContent ?? row.content;
      return writer(9, channelId).send({
        kind: 9,
        content: text(
          content.trim()
            ? content
            : row.attachments.map((attachment) => attachment.url).join("\n"),
        ),
        tags: [
          ["h", channelId],
          ["buzz:sent-from-thread", thread.rootId, ...(label ? [label] : [])],
          // Sharing does not notify the original recipients again. Preserve display binding only.
          ...referenceTags(
            row.edited
              ? []
              : [...row.mentions, ...(row.mentionReferences ?? [])],
          ),
          ...(row.emoji ?? []).map((emoji) => [
            "emoji",
            emoji.shortcode,
            emoji.url,
          ]),
          ...attachmentSource.tags.filter(
            ([name]) => name === "imeta" || name === "link-preview",
          ),
        ],
      });
    },
    reply(
      channelId: string,
      rootId: string,
      content: string,
      mentions: readonly string[] = [],
      attachments: readonly UploadedAttachment[] = [],
      parentId: string = rootId,
      references: readonly string[] = [],
      picks: MentionPicks = {},
    ) {
      if (!channelId) throw new Error("A channel is required");
      if (!/^[0-9a-f]{64}$/.test(rootId))
        throw new Error("A valid thread root is required");
      if (!/^[0-9a-f]{64}$/.test(parentId))
        throw new Error("A valid reply parent is required");
      const message = attachmentMessage(content, attachments, relayOrigin);
      return writer(9, channelId).send({
        kind: 9,
        content: text(message.content),
        tags: [
          ["h", channelId],
          ...(parentId === rootId ? [] : [["e", rootId, "", "root"]]),
          ["e", parentId, "", "reply"],
          ...mentionTags(channelId, mentions),
          ...referenceTags(references),
          ...pickTags(mentions, picks),
          ...emojiTags(content),
          ...message.tags,
        ],
      });
    },
    /** Supply the current folded attachmentSourceId, or the row ID for original media. */
    edit(messageId: string, content: string, attachmentSourceId: string) {
      const original = find(messageId);
      if (!original || ![9, 40002].includes(original.kind))
        throw new Error("Load the message before editing it");
      if (!ownedMessage(original))
        throw new Error("Only your own messages can be edited");
      const channelId = original.tags.find((tag) => tag[0] === "h")?.[1];
      if (!channelId) throw new Error("Message has no channel");
      // The displayed fold owns edit/deletion precedence. Resolve its provenance,
      // never silently resurrect the original attachments if evidence was evicted.
      const attachmentSource = find(attachmentSourceId);
      if (
        !attachmentSource ||
        (attachmentSource.id !== original.id &&
          (attachmentSource.kind !== 40003 ||
            !ownedMessage(attachmentSource) ||
            !attachmentSource.tags.some(
              ([name, id]) => name === "e" && id === messageId,
            ) ||
            attachmentSource.tags.some(
              ([name, id]) => name === "h" && id !== channelId,
            ) ||
            !attachmentSource.tags.some(([name]) => name === "imeta")))
      )
        throw new Error("Reload the message before editing its attachments.");
      return writer(40003, channelId).send({
        kind: 40003,
        content: text(content),
        tags: [
          ["h", channelId],
          ["e", messageId],
          ...attachmentSource.tags.filter((tag) => tag[0] === "imeta"),
          ...emojiTags(content),
        ],
      });
    },
    react(messageId: string, content: string, emoji?: CustomEmoji) {
      const original = find(messageId);
      if (!original || ![9, 40002, 40008].includes(original.kind))
        throw new Error("Load the message before reacting to it");
      const channelId = original.tags.find((tag) => tag[0] === "h")?.[1];
      if (!channelId) throw new Error("Message has no channel");
      const value = text(content);
      if (!validReactionContent(value)) throw new Error("Reaction is too long");
      return writer(7, channelId).send({
        kind: 7,
        content: value,
        tags: [
          ["h", channelId],
          ["e", messageId],
          ...(emoji && value.toLowerCase() === `:${emoji.shortcode}:`
            ? [["emoji", emoji.shortcode, emoji.url]]
            : emojiTags(value)),
        ],
      });
    },
    remove(
      eventIds: readonly string[],
      authorization?: AgentOwnerAuthorization,
    ) {
      const ids = [...new Set(eventIds)];
      if (!ids.length || ids.length > 100)
        throw new Error("Choose between 1 and 100 events to remove");
      const originals = ids.map((id) => {
        const event = find(id);
        if (!event || ![7, 9, 40002].includes(event.kind))
          throw new Error("Load the message or reaction before removing it");
        const agentOwnerRemoval =
          !!viewer &&
          event.kind !== 7 &&
          messageAuthor(event, signingAuthority) === authorization?.agentId &&
          authorization.ownerId === viewer;
        if (
          event.kind === 7
            ? event.pubkey !== viewer
            : !ownedMessage(event) && !agentOwnerRemoval
        )
          throw new Error(
            "Only your own messages and reactions can be removed",
          );
        return event;
      });
      const channel = (event: EventData) =>
        event.tags.find(([name]) => name === "h")?.[1] ??
        (event.kind === 7
          ? find(
              event.tags.find(([name]) => name === "e")?.[1] ?? "",
            )?.tags.find(([name]) => name === "h")?.[1]
          : undefined);
      const first = originals[0];
      const channelId = first ? channel(first) : undefined;
      if (!channelId || originals.some((event) => channel(event) !== channelId))
        throw new Error("Removal must belong to one loaded conversation");
      return writer(5, channelId).send({
        kind: 5,
        content: "",
        tags: [
          ["h", channelId],
          ...ids.map((id) => ["e", id]),
          ...[...new Set(originals.map((event) => event.kind))].map((kind) => [
            "k",
            String(kind),
          ]),
        ],
      });
    },
    /** Undefined when this connection cannot publish reports. */
    report: publishReport
      ? (messageId: string, type: ReportType, note = "") => {
          const original = find(messageId);
          if (!original || ![9, 40002, 40008].includes(original.kind))
            return Promise.reject(
              new Error("Load the message before reporting it"),
            );
          if (!REPORT_TYPES.includes(type))
            return Promise.reject(new Error("Choose a report reason"));
          return publishReport({
            kind: 1984,
            content: note.trim(),
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ["p", original.pubkey],
              ["e", messageId, type],
            ],
          });
        }
      : undefined,
    reactionTarget(event: Pick<EventData, "kind" | "tags">) {
      const target = event.tags.find(([name]) => name === "e")?.[1];
      if (event.kind === 7) return target;
      if (event.kind !== 5 || !target) return undefined;
      const original = find(target);
      return original?.kind === 7
        ? original.tags.find(([name]) => name === "e")?.[1]
        : undefined;
    },
    retry(id: string) {
      outbox?.retry(id);
    },
  });
}
