import { pendingSessionDraft } from "../sessions/pending-start";
import { useConversationPresentation } from "../conversation/ConversationPresentation";
import { TypingPresentation } from "../conversation/typing-presentation";
import { useEffectEvent } from "react";
import { useMessageEditScope } from "./MessageEditScope";
import { useMessageDeletion } from "./MessageManagement";
import { animate, useReducedMotion } from "motion/react";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { SelectedMentionContext } from "./selected-mention-context";
import { DraftMentionRoster } from "./draft-mention-roster";
import {
  allowsOutsideMentions,
  archivedMention,
  mentionAdmission,
  pastedMentionRecipient,
} from "./mention-admission";
import { rememberMention } from "./mention-history";
import {
  readComposerSnapshot,
  composerMarkdownContext,
  markdownRanges,
} from "./composer-document";
import { useMessageEdit, lastEditableMessage } from "./useMessageEdit";
import { editMentionText } from "./message-edit";
import type { ChannelMessage } from "../relay/contracts";
import { FileDropOverlay } from "./FileDropOverlay";
import { useFileDrop } from "./use-file-drop";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { useNonmemberMentions } from "./useNonmemberMentions";
import { knownAgentPubkeys } from "../agents/known";
import { useKnownAgentPubkeys } from "../agents/use-known";
import { rememberAgentsPreference } from "./mention-preferences";
import { useAgentChoices } from "../agents/use-choices";
import { sessionRecipients } from "../sessions/recipients";
import { TypingIndicator } from "./TypingIndicator";
import {
  ArrowUpIcon,
  PaperclipIcon,
  PencilSimpleIcon,
  XIcon,
} from "../../shared/design-system/icons/index";
import { useVoiceCapture } from "./useVoiceCapture";
import { ComposerAttachments } from "./ComposerAttachments";
import { attachmentDraft, useAttachmentDraft } from "./attachment-draft";
import {
  sendInBackground,
  useBackgroundSendPending,
} from "./background-upload";
import { BackgroundUploadStatus } from "./BackgroundUploadStatus";
import type { UploadedAttachment } from "../relay/attachments";
import {
  useContext,
  useEffect,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { RelaySession } from "../relay/session";
import {
  readView,
  writeView,
  viewRevision,
  replaceView,
  subscribeView,
} from "../../shared/view-state";
import styles from "./Messages.module.css";
import { messageViewKey } from "./view-key";
import { isEmojiOnly, usesLargeEmojiPresentation } from "./emoji-size";
import {
  mentionDraft,
  followupDraft,
  type MentionDraft,
  type MentionRecipient,
} from "./mention-draft";
import { ComposerAccessories } from "../conversation/ComposerAccessories";
import { ComposerTools } from "../conversation/ComposerTools";
import { ComposerLinkDialog } from "./ComposerLinkDialog";
import { ComposerFormattingTools } from "./ComposerFormattingTools";
import { ComposerModels } from "./ComposerModels";
import type { MentionPicks } from "../relay/messages";
import type {
  ConversationExtensions,
  CompletionEdit,
  CompletionQuery,
  ComposerObservation,
  ComposerResource,
} from "../conversation/contracts";
import { ComposerCompletions } from "../conversation/ComposerCompletions";
import { useCompletionEditor } from "../conversation/useCompletionEditor";
import { formatMediaTime, mediaTimeReply } from "./media-timecode";
import { RichComposerInput } from "./RichComposerInput";
import { composerMarkdown } from "./composer-markdown";
import type {
  ComposerInputElement,
  ComposerLinkEdit,
  ComposerFormat,
} from "./composer-dom";

const noChannels: ReturnType<RelaySession["channels"]["list"]> = {
  status: "idle",
  channels: [],
};
const noChannelSnapshot = () => noChannels;
const noChannelSubscription = () => () => {};

type AcceptedDraft = {
  next: MentionDraft;
  revision: string | null | undefined;
};
// Failed post-acceptance cleanup survives composer remounts within this session.
// This is recovery evidence only, not another persistent draft inventory.
const acceptedDrafts = new WeakMap<RelaySession, Map<string, AcceptedDraft>>();
type RecoveredSend = {
  draft: MentionDraft;
  picks?: MentionPicks;
  preparationError?: unknown;
};
const recoveryListeners = new WeakMap<
  RelaySession,
  Map<string, Set<(recovered: RecoveredSend) => void>>
>();
// A recovery that no mounted composer consumed replays on remount. Only the
// unpersisted parts need it: the pick snapshot and a preparation failure. The
// saved draft and attachment store remain the owners of the recovered content.
const missedRecovery = new WeakMap<RelaySession, Map<string, RecoveredSend>>();
function takeMissedRecovery(session: RelaySession, key: string) {
  const byKey = missedRecovery.get(session);
  const recovered = byKey?.get(key);
  byKey?.delete(key);
  return recovered;
}
function notifyRecovered(
  session: RelaySession,
  key: string,
  recovered: RecoveredSend,
) {
  let byKey = missedRecovery.get(session);
  if (!byKey) {
    byKey = new Map();
    missedRecovery.set(session, byKey);
  }
  byKey.set(key, recovered);
  for (const listener of recoveryListeners.get(session)?.get(key) ?? [])
    listener(recovered);
}
function errorForRecovery(reason: unknown) {
  return reason instanceof Error
    ? reason.message
    : reason !== undefined
      ? String(reason)
      : undefined;
}
function subscribeRecovery(
  session: RelaySession,
  key: string,
  listener: (recovered: RecoveredSend) => void,
) {
  let byKey = recoveryListeners.get(session);
  if (!byKey) {
    byKey = new Map();
    recoveryListeners.set(session, byKey);
  }
  let listeners = byKey.get(key);
  if (!listeners) {
    listeners = new Set();
    byKey.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) byKey.delete(key);
  };
}
function recoveryFor(session: RelaySession) {
  let recovery = acceptedDrafts.get(session);
  if (!recovery) {
    recovery = new Map();
    acceptedDrafts.set(session, recovery);
  }
  return recovery;
}

export type MessageComposerProps = {
  extensions?: ConversationExtensions | undefined;
  scope: string;
  session: RelaySession;
  channelId: string;
  channelName: string;
  label?: string | undefined;
  placeholder?: string | undefined;
  sessionConversation?: boolean | undefined;
  personalConversation?: boolean | undefined;
  activityClickOpensPanel?: boolean | undefined;
  trailingTool?: ReactNode;
  inviteAgents?: boolean | undefined;
  onSend?: (id: string) => void;
  /** Inbox may retire only after saving the replacement or confirming no draft remains. */
  onDraftSaved?: (() => void) | undefined;
  /** Threads supply their own retained rows; channels use the shared window. */
  editMessages?: readonly ChannelMessage[] | undefined;
  onOpenLink?: ((target: string) => boolean) | undefined;
  canOpenLink?: ((target: string) => boolean) | undefined;
  threadRootId?: string;
  replyParentId?: string | undefined;
  replyContext?: ReactNode;
  mediaTimeSeconds?: number;
  clearMediaTime?(): void;
  /** Focus once when this conversation mounts, not when overlays close. */
  autoFocus?: boolean;
  focusRequest?: number;
  hideMediaTimeIndicator?: boolean;
  disabled?: boolean;
  /** A new conversation owns persistence and delivery before a channel exists. */
  submission?: {
    draftKey: string;
    initialDraft?: MentionDraft | string | undefined;
    /** A durable operation overrides disposable view state during recovery. */
    recoveredDraft?: MentionDraft | undefined;
    /** Confirm/retry an already submitted operation without fresh admission. */
    receiptOnly?: boolean;
    locked: boolean;
    disabled: boolean;
    submit: (draft: MentionDraft) => void;
  };
};

/** Safe to retarget through ordinary props; callers do not own internal remount keys. */
export function MessageComposer(props: MessageComposerProps) {
  const key = `${props.submission?.draftKey ?? ""}:${messageViewKey(
    props.session,
    props.scope,
    props.channelId,
    props.threadRootId,
  )}`;
  return (
    <TypingPresentation active key={key}>
      {props.personalConversation ? (
        <PersonalComposer {...props} />
      ) : (
        <Composer {...props} />
      )}
    </TypingPresentation>
  );
}

function PersonalComposer(props: MessageComposerProps) {
  const choices = useAgentChoices(props.session, true, true);
  return (
    <DraftMentionRoster.Provider value={choices.selectable}>
      <Composer {...props} />
      {choices.error && (
        <p role="alert">
          {choices.error}{" "}
          <Button onClick={() => void props.session.agentChoices.refresh()}>
            Retry agents
          </Button>
        </p>
      )}
    </DraftMentionRoster.Provider>
  );
}

function sameAttachmentSelection(
  left: readonly { id: string }[],
  right: readonly { id: string }[],
) {
  return (
    left.length === right.length &&
    left.every((item, index) => item.id === right[index]?.id)
  );
}

function Composer({
  session,
  extensions,
  scope,
  channelId,
  channelName,
  label: customLabel,
  placeholder,
  onSend,
  onDraftSaved,
  editMessages,
  onOpenLink,
  canOpenLink,
  threadRootId,
  replyParentId,
  replyContext,
  mediaTimeSeconds,
  clearMediaTime,
  autoFocus = false,
  focusRequest,
  hideMediaTimeIndicator = false,
  disabled: requestedDisabled = false,
  submission,
  sessionConversation,
  personalConversation = false,
  activityClickOpensPanel = false,
  inviteAgents = false,
  trailingTool,
}: MessageComposerProps) {
  const active = useConversationPresentation();
  const list = useSyncExternalStore(
    session.channels?.get || sessionConversation
      ? session.channels.subscribeList
      : noChannelSubscription,
    session.channels?.get || sessionConversation
      ? session.channels.list
      : noChannelSnapshot,
    session.channels?.get || sessionConversation
      ? session.channels.list
      : noChannelSnapshot,
  );
  const readOnly =
    !submission &&
    !!session.channels?.get &&
    !list.channels.some(
      (channel) =>
        channel.id === channelId && !channel.readOnly && !channel.archived,
    );
  const cached = !!list.channels.find((channel) => channel.id === channelId)
    ?.cached;
  const disabled = requestedDisabled || readOnly;
  const [sending, setSending] = useState(false);
  const sendAttempt = useRef<AbortController | null>(null);
  useLayoutEffect(() => () => sendAttempt.current?.abort(), []);
  useLayoutEffect(() => {
    if (disabled || !active) sendAttempt.current?.abort();
  }, [disabled, active]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retargeting invalidates an in-flight send, not the root-keyed draft.
  useLayoutEffect(() => () => sendAttempt.current?.abort(), [replyParentId]);
  const inputId = useId();
  const draftKey =
    submission?.draftKey ??
    (threadRootId
      ? `draft:${channelId}:thread:${threadRootId}`
      : `draft:${channelId}`);
  const [admitting, setAdmitting] = useState(false);
  const admission = useRef(false);
  const live = useRef(true);
  const permitted = useRef(!disabled);
  permitted.current = !disabled && active;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const parentChannelId = list.channels.find(
    (item) => item.id === channelId,
  )?.parentChannelId;
  const mentionRoster = useContext(DraftMentionRoster);
  const agentChoices =
    inviteAgents || !!sessionConversation || personalConversation;
  const recoveryKey = `${scope}:${draftKey}`;
  const sendPending = useBackgroundSendPending(session, recoveryKey);
  const [accepted, setAccepted] = useState(() => {
    if (submission) return;
    const recovery = recoveryFor(session);
    const pending = recovery.get(recoveryKey);
    const current = viewRevision(scope, draftKey);
    if (pending && current !== undefined && current !== pending.revision) {
      recovery.delete(recoveryKey); // Deleted or replaced while unmounted.
      return;
    }
    return pending;
  });
  const revision = useRef(viewRevision(scope, draftKey));
  const dirty = useRef(false);
  const writing = useRef(false);
  const [conflict, setConflict] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);
  const [value, updateDraft] = useState(() =>
    mentionDraft(
      accepted?.next ??
        submission?.recoveredDraft ??
        readView<unknown>(scope, draftKey, submission?.initialDraft ?? ""),
    ),
  );
  const draft = value.text;
  const valueRef = useRef(value);
  // Model and effort picked for mentioned agents' next run; cleared by each send.
  const [picks, setPicks] = useState<MentionPicks>({});
  const caret = useRef<number | undefined>(undefined);
  const input = useRef<ComposerInputElement>(null);
  const focusOnMount = useRef(
    autoFocus && !disabled && typeof document !== "undefined"
      ? document.activeElement
      : undefined,
  );
  useEffect(() => {
    // A navigation/dialog owner may restore focus during this commit. Let that
    // explicit handoff win over the conversation's default initial focus.
    if (!focusOnMount.current) return;
    const focus = () => {
      const previous = focusOnMount.current;
      if (
        !previous ||
        (previous !== document.activeElement &&
          (previous.isConnected || document.activeElement !== document.body))
      )
        return;
      const editor = input.current;
      if (!editor || editor.closest("[inert]")) return;
      // A conversation can finish loading behind an already-focused dialog,
      // menu, or open popup trigger. Its default focus must not interrupt that
      // explicit owner: moving focus away also dismisses non-modal menus.
      const owner = document.activeElement?.closest(
        'dialog[open], [aria-modal="true"], [role="menu"], [data-popup-open]',
      );
      if (owner && !owner.contains(editor)) return;
      const end = editor.value.length;
      editor.focus();
      if (document.activeElement !== editor) return;
      editor.setSelectionRange(end, end);
      // Effect replay recreates the editor; retain this successful focus handoff.
      focusOnMount.current = editor;
    };
    const inertAncestor = input.current?.closest("[inert]");
    if (inertAncestor) {
      const observer = new MutationObserver(() => {
        if (!inertAncestor.hasAttribute("inert")) {
          observer.disconnect();
          focus();
        }
      });
      observer.observe(inertAncestor, {
        attributes: true,
        attributeFilter: ["inert"],
      });
      return () => observer.disconnect();
    }
    focus();
  }, []);
  const nonmembers = useNonmemberMentions(session, channelId, () => {
    if (permitted.current) input.current?.focus();
  });
  useEffect(() => {
    if (focusRequest) input.current?.focus();
  }, [focusRequest]);
  const restoreSelection = useRef<{ start: number; end: number } | undefined>(
    undefined,
  );
  const [linkEdit, setLinkEdit] = useState<ComposerLinkEdit | null>(null);
  if (!active && linkEdit) setLinkEdit(null);
  const [activeFormats, setActiveFormats] = useState<readonly ComposerFormat[]>(
    [],
  );
  const saveDraft = (next: MentionDraft) => {
    if (JSON.stringify(next) === JSON.stringify(valueRef.current)) return false;
    valueRef.current = next;
    updateDraft(next);
    if (!editing.target) {
      if (submission) writeView(scope, draftKey, next);
      else {
        dirty.current = true;
        if (!conflict && !accepted) persist(next);
      }
    }
    return true;
  };
  function persist(next: MentionDraft, expected = revision.current) {
    writing.current = true;
    const result = replaceView(scope, draftKey, expected, next);
    writing.current = false;
    if (result === "saved") revision.current = JSON.stringify(next);
    setConflict(result === "changed");
    setStorageFailed(result === "failed");
    return result;
  }
  const [error, setError] = useState<string>();
  const [attachmentError, setAttachmentError] = useState<string>();
  const focusRestoredDraft = useRef(false);
  const beforeEdit = useRef<
    { value: MentionDraft; restore(): void } | undefined
  >(undefined);
  const editing = useMessageEdit(session, () => {
    const saved = beforeEdit.current;
    if (!saved) return;
    valueRef.current = saved.value;
    updateDraft(saved.value);
    saved.restore();
    focusRestoredDraft.current = true;
    beforeEdit.current = undefined;
    setError(undefined);
    caret.current = undefined;
    setLinkEdit(null);
    completion.invalidate();
  });
  const editScope = useMessageEditScope();
  const editableRows = () =>
    editMessages ??
    editScope?.exactRows?.() ??
    (threadRootId
      ? []
      : (session.channels.window?.(channelId).rows ?? [])
    ).filter((row) => sessionConversation || !row.threadRootId);
  const editDisabled =
    disabled ||
    !!list.channels.find((channel) => channel.id === channelId)?.archived ||
    !!list.channels.find((channel) => channel.id === channelId)?.readOnly;
  const editingDisabled =
    disabled ||
    admitting ||
    sending ||
    !!accepted ||
    !!submission?.locked ||
    (editing.target && (editing.locked || editDisabled)) ||
    false;
  const label = editing.target
    ? "Edit message"
    : (customLabel ??
      (threadRootId ? "Reply to thread" : `Message #${channelName}`));
  const attachments = useAttachmentDraft(
    session,
    `${scope}:${draftKey}`,
    channelId,
  );
  const picker = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const canAttach = !submission && !!session.attachments;
  const voice = useVoiceCapture(
    attachments.store,
    !active || editingDisabled || !!editing.target || !canAttach,
    setAttachmentError,
  );
  useEffect(() => {
    if (disabled) attachments.store.cancel();
    else attachments.store.resume();
  }, [disabled, attachments.store]);
  const dragging = useFileDrop(
    form,
    active &&
      canAttach &&
      !editingDisabled &&
      !editing.target &&
      !voice.capturing,
    attachFiles,
  );
  function attachFiles(files: readonly File[]) {
    if (
      !permitted.current ||
      editingDisabled ||
      voice.isCapturing() ||
      !files.length
    )
      return;
    if (editing.target) {
      setAttachmentError("Finish editing before attaching new files.");
      return;
    }
    if (!canAttach) {
      setAttachmentError(
        submission
          ? "Create this conversation before attaching files."
          : "Uploads are unavailable on this connection.",
      );
      return;
    }
    try {
      attachments.store.add(files);
      setAttachmentError(undefined);
    } catch (reason) {
      setAttachmentError(
        reason instanceof Error ? reason.message : "Could not attach files.",
      );
    }
  }
  const outbox = session.outbox;
  const emojiCatalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  const largeEmojiDraft = usesLargeEmojiPresentation(
    draft,
    emojiCatalog.entries,
  );
  const completion = useCompletionEditor(
    input,
    active && !editingDisabled && !!outbox?.supports(9),
  );
  function loadSaved(raw: string | null) {
    let next: MentionDraft;
    try {
      next = mentionDraft(JSON.parse(raw ?? "null"));
    } catch {
      next = mentionDraft("");
    }
    revision.current = raw;
    dirty.current = false;
    valueRef.current = next;
    updateDraft(next);
    input.current?.reset(next);
    completion.invalidate();
    setLinkEdit(null);
    restoreSelection.current = undefined;
    caret.current = undefined;
    setConflict(false);
    setStorageFailed(false);
  }
  // Picks belong to the recovered revision alone. They return whenever the
  // composer holds it unedited, never to a later edit that keeps a conflict.
  const reconcileDraft = useEffectEvent(
    (restored?: MentionDraft, recoveredPicks?: MentionPicks) => {
      if (submission || editing.target || writing.current) return;
      if (accepted) {
        // The recovered revision can precede attachment adoption. The explicit
        // recovery notification below reconciles the mounted owner afterward.
        if (recoveryFor(session).get(recoveryKey) === accepted) return;
        const current = viewRevision(scope, draftKey);
        if (current !== undefined) {
          setAccepted(undefined);
          loadSaved(current);
          if (restored && current === JSON.stringify(restored))
            setPicks(recoveredPicks ?? {});
        }
        return;
      }
      const current = viewRevision(scope, draftKey);
      if (current === undefined) return;
      const recovering = !!restored && current === JSON.stringify(restored);
      if (current === revision.current) {
        // The storage listener usually loads the recovered revision before
        // its notification arrives.
        if (recovering && !dirty.current) setPicks(recoveredPicks ?? {});
        return;
      }
      // An explicit successful recovery may replace only the cleared follow-up,
      // never a meaningful unsaved edit. Ordinary external revisions keep their
      // conflict behavior.
      if (
        recovering &&
        !valueRef.current.text.trim() &&
        !valueRef.current.recipients.length &&
        !composerMarkdown(valueRef.current).trim() &&
        !sendAttempt.current
      )
        loadSaved(current);
      else if (dirty.current || sendAttempt.current) {
        setConflict(true);
        return;
      } else loadSaved(current);
      if (recovering) setPicks(recoveredPicks ?? {});
    },
  );
  const editingDraft = !!editing.target;
  const deferredRecovery = useRef<RecoveredSend | undefined>(undefined);
  useEffect(() => {
    if (submission) return;
    const stop = subscribeView(scope, () => reconcileDraft());
    // Reconcile changes while message-edit mode or mounting paused this listener.
    reconcileDraft(
      deferredRecovery.current?.draft,
      deferredRecovery.current?.picks,
    );
    if (!editingDraft && deferredRecovery.current) {
      takeMissedRecovery(session, recoveryKey);
      setError(errorForRecovery(deferredRecovery.current.preparationError));
      deferredRecovery.current = undefined;
    }
    return stop;
  }, [scope, submission, editingDraft, session, recoveryKey]);
  const receiveRecovery = useEffectEvent((recovered: RecoveredSend) => {
    if (editing.target) deferredRecovery.current = recovered;
    reconcileDraft(recovered.draft, recovered.picks);
    if (!editing.target) {
      takeMissedRecovery(session, recoveryKey);
      setError(errorForRecovery(recovered.preparationError));
    }
  });
  useEffect(() => {
    const stop = subscribeRecovery(session, recoveryKey, (recovered) =>
      receiveRecovery(recovered),
    );
    // Recovery may have completed between unmount and this subscription. Replay
    // only if its saved caption still owns the draft; never attach an old error
    // to a replacement written while the composer was away.
    const missed = missedRecovery.get(session)?.get(recoveryKey);
    if (missed) {
      if (viewRevision(scope, draftKey) === JSON.stringify(missed.draft))
        receiveRecovery(missed);
      else takeMissedRecovery(session, recoveryKey);
    }
    return stop;
  }, [session, recoveryKey, scope, draftKey]);
  function resolveDraft(keep: boolean) {
    const current = viewRevision(scope, draftKey);
    if (current === undefined) {
      setStorageFailed(true);
      return;
    }
    if (keep) {
      dirty.current = true;
      persist(valueRef.current, current);
    } else loadSaved(current);
  }
  function finishDraft(pending: AcceptedDraft) {
    if (recoveryFor(session).get(recoveryKey) !== pending) {
      reconcileDraft();
      return;
    }
    const result = persist(pending.next, pending.revision);
    // No stale sent text needs cleanup if nothing was saved and absence is
    // still readable. Keep the normal save attempt for remembered-agent drafts.
    if (
      result === "failed" &&
      (pending.revision !== null || viewRevision(scope, draftKey) !== null)
    )
      return;
    recoveryFor(session).delete(recoveryKey);
    setAccepted(undefined);
    if (result === "changed") {
      // Another editor owns this revision. Acceptance cannot erase its work.
      const current = viewRevision(scope, draftKey);
      if (current !== undefined) loadSaved(current);
      return;
    }
    dirty.current = result === "failed" && !!pending.next.text.trim();
    // An unsaved prefill stays editable here with the ordinary save warning.
    if (!dirty.current) onDraftSaved?.();
  }
  useEffect(() => {
    if (outbox?.supports(9)) void session.emoji.ensure();
  }, [session, outbox]);
  useLayoutEffect(() => {
    // Delivery closes while the input is still disabled. Focus only after React
    // has committed the restored, editable draft; preserve its saved selection.
    if (focusRestoredDraft.current) {
      focusRestoredDraft.current = false;
      input.current?.focus();
    }
    if (restoreSelection.current) {
      const { start, end } = restoreSelection.current;
      input.current?.focus();
      input.current?.setSelectionRange(start, end);
      restoreSelection.current = undefined;
      return;
    }
    if (caret.current === undefined) return;
    input.current?.focus();
    input.current?.setSelectionRange(caret.current, caret.current);
    caret.current = undefined;
  });
  const requestDeletion = useMessageDeletion();
  const startEdit = useEffectEvent((row: ChannelMessage) => {
    if (
      !permitted.current ||
      editingDisabled ||
      editDisabled ||
      submission ||
      !input.current
    )
      return;
    const current = editableRows().find((item) => item.id === row.id);
    if (!current || !lastEditableMessage(session, [current])) {
      setError("This message is no longer available to edit.");
      return;
    }
    if (editing.target) {
      setError("Finish or cancel your current edit first.");
      input.current.focus();
      return;
    }
    completion.invalidate();
    beforeEdit.current = {
      value: valueRef.current,
      restore: input.current.checkpoint(),
    };
    const next = mentionDraft(editing.start(current));
    valueRef.current = next;
    updateDraft(next);
    input.current.reset(next);
    setLinkEdit(null);
    caret.current = next.text.length;
    setError(undefined);
  });
  useEffect(() => {
    if (!editScope) return;
    const start = (row: ChannelMessage) => startEdit(row);
    editScope.current = start;
    editScope.input.current = input.current;
    return () => {
      if (editScope.current === start) {
        editScope.current = undefined;
        editScope.input.current = null;
      }
    };
  }, [editScope]);
  function insert(
    text: string,
    recipient?: MentionRecipient,
    range?: CompletionQuery,
    terminator?: ":",
  ) {
    if (
      !permitted.current ||
      editingDisabled ||
      !outbox?.supports(9) ||
      !input.current?.isConnected ||
      // DOM props are committed before child layout effects; closures can still
      // carry the preceding render's enabled state during that interval.
      input.current.disabled ||
      input.current.readOnly ||
      typeof text !== "string"
    )
      return false;
    // Edits replace prose; they do not change the original notification recipients.
    if (editing.target && recipient) {
      text = editMentionText(recipient);
      recipient = undefined;
    }
    if (
      recipient &&
      !mentionAdmission(
        session,
        channelId,
        agentChoices,
        mentionRoster,
      )(recipient.pubkey)
    ) {
      setError(
        "This recipient is no longer available. Remove it or refresh choices.",
      );
      return false;
    }
    if (recipient && valueRef.current.recipients.length >= 32) {
      setError("Choose at most 32 recipients");
      return false;
    }
    completion.invalidate();
    if (!input.current.insertText(text, recipient, range, terminator)) {
      setError("Message is too long to insert text");
      return false;
    }
    if (recipient) rememberMention(session, channelId, recipient.pubkey);
    setError(undefined);
    return true;
  }
  function insertMention(recipient: MentionRecipient) {
    if (
      !recipient ||
      typeof recipient.pubkey !== "string" ||
      !/^[0-9a-f]{64}$/.test(recipient.pubkey) ||
      typeof recipient.name !== "string" ||
      !recipient.name.trim()
    )
      return false;
    return insert(`@${recipient.name} `, recipient);
  }
  function insertMentions(
    recipients: readonly MentionRecipient[],
    range?: CompletionQuery,
  ) {
    if (
      !Array.isArray(recipients) ||
      !recipients.length ||
      recipients.some(
        (person) =>
          !person ||
          typeof person.pubkey !== "string" ||
          !/^[0-9a-f]{64}$/.test(person.pubkey) ||
          typeof person.name !== "string" ||
          !person.name.trim(),
      )
    )
      return false;
    const unique = [
      ...new Map(recipients.map((person) => [person.pubkey, person])).values(),
    ];
    if (unique.length > 32) {
      setError("Choose at most 32 recipients");
      return false;
    }
    if (
      !permitted.current ||
      editingDisabled ||
      !outbox?.supports(9) ||
      !input.current?.isConnected ||
      input.current.disabled ||
      input.current.readOnly
    )
      return false;
    // Message edits only add references, never new notification intent.
    if (editing.target)
      return insert(unique.map(editMentionText).join(""), undefined, range);
    const admits = mentionAdmission(
      session,
      channelId,
      agentChoices,
      mentionRoster,
    );
    if (unique.some((person) => !admits(person.pubkey))) {
      setError(
        "A team member is no longer available. Refresh choices before trying again.",
      );
      return false;
    }
    const text = unique.map((person) => `@${person.name} `).join("");
    if (!input.current.insertText(text, unique, range)) {
      setError(
        "The team would exceed the message length or 32-recipient limit. Nothing was added.",
      );
      return false;
    }
    completion.invalidate();
    for (const person of unique)
      rememberMention(session, channelId, person.pubkey);
    setError(undefined);
    return true;
  }
  function insertResource(resource: ComposerResource): true | string {
    if (
      !permitted.current ||
      editingDisabled ||
      !outbox?.supports(9) ||
      !input.current?.isConnected
    )
      return "The message can't be edited right now";
    completion.invalidate();
    return input.current.insertResource(resource);
  }
  function replaceCompletion(
    edit: CompletionEdit,
    query: CompletionQuery,
    observation: ComposerObservation,
    key?: string,
  ) {
    if (
      !completion.valid(observation) ||
      valueRef.current.text !== observation.text
    )
      return false;
    // A typed terminator (Space, the closing emoji colon) stays literal in code.
    if (key === " " || key === ":") {
      const doc = readComposerSnapshot(valueRef.current.document);
      const context = doc
        ? composerMarkdownContext(doc)
        : { text: observation.text, protected: [] };
      if (
        [...context.protected, ...markdownRanges(context.text).literal].some(
          (r) => query.start < r.end && query.end > r.start,
        )
      )
        return false;
    }
    if ("mentions" in edit && edit.mentions)
      return insertMentions(edit.mentions, query);
    if ("mention" in edit && edit.mention)
      return insert(`@${edit.mention.name} `, edit.mention, query);
    return (
      typeof edit.text === "string" &&
      insert(
        `${edit.text}${isEmojiOnly(edit.text, emojiCatalog.entries) ? "" : " "}`,
        undefined,
        query,
        key === ":" ? key : undefined,
      )
    );
  }
  const currentAdmission = () =>
    live.current &&
    permitted.current &&
    !sendAttempt.current?.signal.aborted &&
    session.channels.list().channels.find((item) => item.id === channelId)
      ?.parentChannelId === parentChannelId &&
    (!personalConversation || session.mePlacement.has(channelId));
  async function prepareRecipients(explicit: readonly string[]) {
    const channel = await session.workSessions.refreshMembership(channelId);
    if (!currentAdmission())
      throw new Error("The session changed. Review its channel and retry.");
    const recipients = personalConversation
      ? [...explicit]
      : [
          ...sessionRecipients(
            channel,
            session.profiles.snapshot(),
            session.agentChoices.snapshot(),
            session.viewer,
            explicit,
          ),
        ];
    const missing = recipients.filter((key) => !channel.members?.includes(key));
    if (missing.length) {
      // Classification no longer depends on inventory; refresh before admission.
      await session.agentChoices.refresh();
      if (!currentAdmission())
        throw new Error("The session changed. Review its channel and retry.");
      if (
        personalConversation &&
        missing.some(
          (key) =>
            !session.agentChoices
              .snapshot()
              .selectable.some((agent) => agent.pubkey === key),
        )
      )
        throw new Error("Only your available agents can be mentioned in Me.");
      await session.workSessions.addAgents(
        channelId,
        missing,
        currentAdmission,
      );
      if (!currentAdmission())
        throw new Error("The session changed. Review its channel and retry.");
    }
    return recipients;
  }
  function requireCompletedSessionStart() {
    if (pendingSessionDraft(scope, channelId))
      throw new Error(
        "Finish setting up this conversation in Me before sending messages.",
      );
  }
  async function send() {
    if (!permitted.current || voice.isCapturing()) return;
    if (editing.target) {
      if (editDisabled || editing.locked) return;
      if (!valueRef.current.text.trim()) {
        if (editing.target.attachments.length) {
          setError(
            "Keep attachment links unchanged. To remove this message, use Delete message.",
          );
          return;
        }
        if (requestDeletion && session.outbox?.supports(5)) {
          const checkpoint = beforeEdit.current;
          requestDeletion(editing.target, (focus) => {
            if (beforeEdit.current !== checkpoint) return;
            editing.close();
            focusRestoredDraft.current = focus;
          });
        }
        return;
      }
      editing.save(
        composerMarkdown(valueRef.current),
        editableRows().find((row) => row.id === editing.target?.id),
      );
      return;
    }
    if (
      disabled ||
      accepted ||
      conflict ||
      admission.current ||
      submission?.disabled ||
      (!submission && (input.current?.readOnly || input.current?.disabled)) ||
      (!draft.trim() && !attachments.items.length) ||
      attachments.blocked ||
      sendPending ||
      sendAttempt.current ||
      !outbox
    )
      return;
    const recovering = !submission && recoveryFor(session).get(recoveryKey);
    if (recovering) {
      setAccepted(recovering);
      valueRef.current = recovering.next;
      updateDraft(recovering.next);
      input.current?.reset(recovering.next);
      return;
    }
    if (!submission && viewRevision(scope, draftKey) !== revision.current) {
      setConflict(true);
      return;
    }
    const savedRevision = revision.current;
    const attempt = new AbortController();
    sendAttempt.current = attempt;
    const captured = valueRef.current;
    const capturedAttachments = attachments.store.snapshot();
    const capturedPicks = picks;
    try {
      if (submission?.receiptOnly) {
        submission.submit(captured);
        return;
      }
      if (captured.recipients.some((p) => archivedMention(session, p.pubkey)))
        throw new Error(
          "A selected recipient is archived. Remove it before sending.",
        );
      if (
        personalConversation &&
        captured.recipients.some(
          (person) =>
            !session.agentChoices
              .snapshot()
              .selectable.some((agent) => agent.pubkey === person.pubkey),
        )
      )
        throw new Error(
          "Only your available agents can be mentioned in Me. Remove the unavailable recipient and retry.",
        );
      if (submission) {
        submission.submit(captured);
        return;
      }
      requireCompletedSessionStart();
      let references: readonly string[] = [];
      let recipients = captured.recipients.map((item) => item.pubkey);
      if (sessionConversation || personalConversation) {
        admission.current = true;
        setAdmitting(true);
        recipients = await prepareRecipients(recipients);
      } else if (recipients.length) {
        const channel = session.channels
          .list()
          .channels.find((item) => item.id === channelId);
        if (channel?.members && allowsOutsideMentions(channel)) {
          const missing = captured.recipients.filter(
            (person) => !channel.members?.includes(person.pubkey),
          );
          if (missing.length && channel?.channelType === "dm") {
            // Nobody can be added to a DM, so there is no choice to offer:
            // outside people become references without a prompt.
            references = missing.map((person) => person.pubkey);
            recipients = recipients.filter((key) => !references.includes(key));
          } else if (missing.length) {
            setSending(true);
            setError(undefined);
            const decision = await nonmembers.prepare(
              missing,
              attempt.signal,
              () =>
                valueRef.current === captured &&
                sameAttachmentSelection(
                  attachments.store.snapshot(),
                  capturedAttachments,
                ) &&
                permitted.current,
            );
            if (decision === null) return;
            references = decision;
            recipients = recipients.filter((key) => !references.includes(key));
          }
        }
      }
      attempt.signal.throwIfAborted();
      if (attachments.store.snapshot().some((item) => item.status === "error"))
        return;
      if (
        valueRef.current !== captured ||
        !sameAttachmentSelection(
          attachments.store.snapshot(),
          capturedAttachments,
        )
      )
        return;
      if (viewRevision(scope, draftKey) !== savedRevision) {
        setConflict(true);
        return;
      }
      const content =
        threadRootId && mediaTimeSeconds !== undefined
          ? mediaTimeReply(mediaTimeSeconds, composerMarkdown(captured))
          : composerMarkdown(captured);
      const agents = knownAgentPubkeys(
        session.profiles.snapshot(),
        session.agentChoices.snapshot(),
      );
      const next = followupDraft(
        rememberAgentsPreference()
          ? captured.recipients.filter(
              (item) =>
                agents.has(item.pubkey) &&
                recipients.includes(item.pubkey) &&
                !archivedMention(session, item.pubkey),
            )
          : [],
      );
      // Only agents still notified by this message are asked for a model or effort.
      const sentPicks: MentionPicks = Object.fromEntries(
        Object.entries(capturedPicks).filter(([key]) =>
          recipients.includes(key),
        ),
      );
      const tuned = Object.keys(sentPicks).length > 0;
      // Destination and content are fixed here; a background send never retargets.
      const publish = (uploaded: readonly UploadedAttachment[]) => {
        requireCompletedSessionStart();
        return threadRootId
          ? session.messages.reply(
              channelId,
              threadRootId,
              content,
              recipients,
              uploaded,
              ...(replyParentId || references.length || tuned
                ? [replyParentId]
                : []),
              ...(references.length || tuned ? [references] : []),
              ...(tuned ? [sentPicks] : []),
            )
          : references.length || tuned
            ? session.messages.send(
                channelId,
                content,
                recipients,
                uploaded,
                undefined,
                references,
                ...(tuned ? [sentPicks] : []),
              )
            : session.messages.send(channelId, content, recipients, uploaded);
      };
      let id: string | undefined;
      if (capturedAttachments.length) {
        const followup = JSON.stringify(next);
        sendInBackground(
          session,
          recoveryKey,
          channelId,
          capturedAttachments,
          (uploaded) => {
            const sent = publish(uploaded);
            if (live.current) onSend?.(sent);
          },
          (files, preparationError) => {
            // Only the original saved draft or the untouched follow-up can be
            // restored. A later edit belongs to its author, not this job.
            const current = viewRevision(scope, draftKey);
            const capturedRevision = JSON.stringify(captured);
            const cleared = (raw: string | null | undefined) => {
              if (!raw) return false;
              try {
                const draft = mentionDraft(JSON.parse(raw));
                return (
                  !draft.text.trim() &&
                  !draft.recipients.length &&
                  !composerMarkdown(draft).trim()
                );
              } catch {
                return false;
              }
            };
            if (
              live.current &&
              !cleared(JSON.stringify(valueRef.current)) &&
              (valueRef.current.text !== next.text ||
                JSON.stringify(valueRef.current.recipients) !==
                  JSON.stringify(next.recipients)) &&
              JSON.stringify(valueRef.current) !== capturedRevision
            )
              return "conflict";
            if (
              current !== savedRevision &&
              current !== followup &&
              current !== capturedRevision &&
              !(
                cleared(current) &&
                (!live.current || cleared(JSON.stringify(valueRef.current)))
              ) &&
              !(
                live.current &&
                current === JSON.stringify(valueRef.current) &&
                valueRef.current.text === next.text &&
                JSON.stringify(valueRef.current.recipients) ===
                  JSON.stringify(next.recipients)
              )
            )
              return "conflict";
            const target = attachmentDraft(session, recoveryKey, channelId);
            if (target.snapshot().length) return "conflict";
            if (
              current !== capturedRevision &&
              replaceView(scope, draftKey, current, captured) !== "saved"
            )
              return false;
            if (!target.adopt(files)) return false;
            recoveryFor(session).delete(recoveryKey);
            // The whole captured pick set returns with the whole draft; the
            // recipient filter above applies again on the next send.
            notifyRecovered(session, recoveryKey, {
              draft: captured,
              picks: capturedPicks,
              preparationError,
            });
            return true;
          },
          attachments.store,
        );
      } else id = publish([]);
      const pending = { next, revision: savedRevision };
      recoveryFor(session).set(recoveryKey, pending);
      setAccepted(pending);
      attachments.store.clear();
      completion.invalidate();
      clearMediaTime?.();
      const changed = JSON.stringify(next) !== JSON.stringify(valueRef.current);
      valueRef.current = next;
      updateDraft(next);
      setPicks({});
      // An unchanged prefill may not render. Do not leave a caret command for
      // the next keystroke to consume after inserting its first character.
      caret.current = changed ? next.text.length : undefined;
      input.current?.reset(next);
      input.current?.focus();
      if (!changed)
        input.current?.setSelectionRange(next.text.length, next.text.length);
      setError(undefined);
      if (id) onSend?.(id);
      finishDraft(pending);
    } catch (reason) {
      if (live.current && !attempt.signal.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      admission.current = false;
      if (sendAttempt.current === attempt) {
        sendAttempt.current = null;
        if (live.current) {
          setSending(false);
          setAdmitting(false);
        }
      }
    }
  }
  const readingOnly = !outbox?.supports(9) && !cached;
  const context = (
    <div className={styles.composerContext}>
      {!cached && !submission && (
        <TypingIndicator
          clickOpensPanel={activityClickOpensPanel}
          session={session}
          channelId={channelId}
          threadRootId={threadRootId}
          canOpenActivity={canOpenLink}
          openActivity={onOpenLink}
        />
      )}
      {extensions?.accessories && (
        <ComposerAccessories
          registry={extensions.accessories}
          session={session}
          scope={scope}
          channelId={channelId}
          threadRootId={threadRootId}
          canOpen={(target) => canOpenLink?.(target) ?? false}
          open={(target) => onOpenLink?.(target) ?? false}
        />
      )}
    </div>
  );
  const renderLeadingTools = (tools: ReactNode) => (
    <>
      <div className={styles.composerLeadingTools}>
        {tools}
        {!!value.recipients.length && (
          <RecipientAvatars
            session={session}
            recipients={value.recipients}
            disabled={editingDisabled}
            remove={(pubkey) => input.current?.removeRecipient(pubkey)}
          />
        )}
      </div>
      {canAttach && (
        <>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            aria-label="Choose attachments"
            onChange={(event) => {
              attachFiles(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = "";
            }}
          />
          <IconButton
            size="sm"
            type="button"
            aria-label="Attach files"
            title="Attach files"
            disabled={editingDisabled || !!editing.target}
            onClick={() => picker.current?.click()}
            icon={<PaperclipIcon size={16} />}
          />
        </>
      )}
    </>
  );
  if (readingOnly)
    return (
      <>
        {context}
        <footer className={styles.composer}>
          This relay connection supports reading only.
        </footer>
      </>
    );
  return (
    <SelectedMentionContext.Provider value={value.recipients}>
      {context}
      {active && nonmembers.dialog}
      <form
        ref={form}
        className={styles.composer}
        data-file-drag={dragging || undefined}
        data-editing={!!editing.target || undefined}
        onKeyDown={(event) => {
          if (
            editing.target &&
            event.key === "Escape" &&
            !event.defaultPrevented &&
            !event.nativeEvent.isComposing &&
            event.nativeEvent.keyCode !== 229 &&
            !completion.composing.current
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (!editing.busy) editing.close();
          }
        }}
        onPasteCapture={(event) => {
          const files = Array.from(event.clipboardData.items)
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null);
          if (!files.length) return;
          event.preventDefault();
          event.stopPropagation();
          attachFiles(files);
        }}
        aria-label={
          editing.target
            ? "Edit message"
            : threadRootId
              ? "Reply to thread"
              : `Send a message to ${channelName}`
        }
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {editing.target && (
          <div className={styles.composerEditHeader}>
            <PencilSimpleIcon size={18} />
            <span>Editing message</span>
            <IconButton
              type="button"
              size="sm"
              aria-label={editing.locked ? "Close edit" : "Cancel edit"}
              disabled={editing.busy}
              onClick={editing.close}
              icon={<XIcon size={18} />}
            />
          </div>
        )}
        <label className="sr-only" htmlFor={inputId}>
          {label}
        </label>
        {active && extensions?.completions && (
          <ComposerCompletions
            registry={extensions.completions}
            editor={completion}
            input={input}
            session={session}
            scope={scope}
            channelId={channelId}
            threadRootId={threadRootId}
            inviteAgents={agentChoices && !editing.target}
            replace={replaceCompletion}
            resolved={value}
          />
        )}
        <BackgroundUploadStatus session={session} focusTarget={input} />
        {dragging && <FileDropOverlay composer={form} />}
        {attachmentError && (
          <ToastNotice
            title="Could not attach file"
            description={attachmentError}
            onDismiss={() => setAttachmentError(undefined)}
          />
        )}
        <div className={styles.composerContent}>
          {!editing.target && (
            <ComposerAttachments
              media={session.media}
              renderers={extensions?.attachments}
              items={attachments.items}
              disabled={editingDisabled}
              remove={(id) => {
                const item = attachments.items.find(
                  (candidate) => candidate.id === id,
                );
                attachments.store.remove(id);
                if (item?.status === "error" && item.error === error)
                  setError(undefined);
              }}
              retry={(id) => {
                const item = attachments.items.find(
                  (candidate) => candidate.id === id,
                );
                attachments.store.retry(id);
                if (item?.status === "error" && item.error === error)
                  setError(undefined);
              }}
            />
          )}
          <div className={styles.composerInput}>
            <RichComposerInput
              ref={input}
              id={inputId}
              disabled={editingDisabled}
              value={draft}
              draft={value}
              session={session}
              scope={scope}
              channelId={channelId}
              extensions={extensions}
              emoji={emojiCatalog.entries}
              onDraftChange={(next) => {
                saveDraft(next);
                completion.observe(true);
              }}
              onFormatsChange={setActiveFormats}
              onEditLink={setLinkEdit}
              // Pasted identity links notify admitted recipients under their
              // current names; edits never add recipients. Send still asks
              // before adding someone outside the channel.
              acceptRecipient={(pubkey) =>
                editing.target
                  ? null
                  : pastedMentionRecipient(
                      session,
                      channelId,
                      pubkey,
                      agentChoices,
                      mentionRoster,
                    )
              }
              data-single-emoji={largeEmojiDraft || undefined}
              data-emoji-images-only={
                (largeEmojiDraft &&
                  /^\s*(?::[a-z0-9_-]{1,64}:\s*)+$/i.test(draft)) ||
                undefined
              }
              // Choosing this conversation's tab resumes typing here.
              data-tab-focus=""
              maxLength={16000}
              aria-label={label}
              placeholder={placeholder ?? label}
              onFocus={() => completion.observe(true)}
              onBlur={() => {
                completion.invalidate();
              }}
              onSelect={() => {
                completion.observe();
              }}
              onCompositionStart={() => {
                completion.composing.current = true;
                completion.invalidate();
              }}
              onCompositionEnd={() => {
                completion.composing.current = false;
                completion.observe(true);
              }}
              onKeyDown={(event) => {
                if (
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229 ||
                  completion.composing.current
                )
                  return;
                if (
                  event.shiftKey &&
                  ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
                ) {
                  completion.invalidate();
                  return;
                }
                if (completion.keys.current?.(event)) return;
                if (
                  event.key === "ArrowUp" &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.repeat &&
                  !event.defaultPrevented &&
                  !editingDisabled &&
                  !editDisabled &&
                  !submission &&
                  !editing.target &&
                  event.currentTarget.value === "" &&
                  !valueRef.current.recipients.length &&
                  !attachments.items.length
                ) {
                  const target = lastEditableMessage(session, editableRows());
                  if (target) {
                    event.preventDefault();
                    startEdit(target);
                  }
                  return;
                }
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey
                ) {
                  event.preventDefault();
                  // Holding Enter must not send after an empty list item exits.
                  if (event.repeat) return;
                  if (
                    activeFormats.includes("bullet_list") ||
                    activeFormats.includes("ordered_list")
                  ) {
                    event.currentTarget.insertLineBreak();
                    return;
                  }
                  send();
                }
              }}
            />
          </div>
        </div>
        {!editing.target && replyContext}
        {!editing.target &&
          threadRootId &&
          mediaTimeSeconds !== undefined &&
          !hideMediaTimeIndicator && (
            <div className={styles.mediaComposerAnchor}>
              <span>Commenting at {formatMediaTime(mediaTimeSeconds)}</span>
              <IconButton
                size="compact"
                type="button"
                onClick={clearMediaTime}
                aria-label="Remove video time"
                icon={<XIcon size={13} />}
              />
            </div>
          )}
        {voice.element}
        <div className={styles.composerActions} hidden={voice.capturing}>
          {active && (
            <ComposerFormattingTools
              disabled={editingDisabled}
              activeFormats={activeFormats}
              toggleFormat={(format) => input.current?.toggleFormat(format)}
              editLink={() => {
                const edit = input.current?.editLink();
                if (edit) setLinkEdit(edit);
              }}
            >
              {extensions ? (
                <ComposerTools
                  registry={extensions.tools}
                  capture={voice.begin}
                  renderLeading={renderLeadingTools}
                  session={session}
                  scope={scope}
                  channelId={channelId}
                  threadRootId={threadRootId}
                  disabled={editingDisabled}
                  inviteAgents={agentChoices && !editing.target}
                  insertText={(text) => insert(text)}
                  insertMention={insertMention}
                  insertMentions={insertMentions}
                  insertResource={insertResource}
                  focus={() => input.current?.focus()}
                />
              ) : (
                renderLeadingTools(null)
              )}
            </ComposerFormattingTools>
          )}
          {active && !editing.target && trailingTool}
          {active &&
            !editing.target &&
            !submission &&
            !!value.recipients.length && (
              <ComposerModels
                pubkeys={value.recipients.map((item) => item.pubkey)}
                value={picks}
                disabled={editingDisabled}
                onChange={setPicks}
              />
            )}
          <IconButton
            variant={
              draft.trim() || attachments.items.length ? "primary" : "ghost"
            }
            size="toolbar"
            type="submit"
            aria-label={editing.target ? "Save changes" : "Send message"}
            title={editing.target ? "Save changes" : "Send message"}
            disabled={
              disabled ||
              (!editing.target && (!!accepted || conflict || sendPending)) ||
              (!!editing.target && (editing.locked || editDisabled)) ||
              admitting ||
              sending ||
              submission?.disabled ||
              (!editing.target && attachments.blocked) ||
              (!draft.trim() &&
                !attachments.items.length &&
                !(
                  editing.target &&
                  requestDeletion &&
                  session.outbox?.supports(5)
                ))
            }
            icon={<ArrowUpIcon size={16} />}
          />
        </div>
        {(error || editing.error) && (
          <p role="alert">{error ?? editing.error}</p>
        )}
        {!editing.target &&
          !submission &&
          (accepted || conflict || storageFailed) && (
            <div>
              <p role="alert">
                {accepted
                  ? "Message accepted. Could not update the saved draft. Retry cleanup before sending again."
                  : conflict
                    ? "This draft changed elsewhere. Your edits are kept here; choose which draft to keep."
                    : "Could not save this draft on this device. Your edits are kept here."}
              </p>
              {accepted ? (
                <Button type="button" onClick={() => finishDraft(accepted)}>
                  Retry draft cleanup
                </Button>
              ) : conflict ? (
                <>
                  <Button type="button" onClick={() => resolveDraft(false)}>
                    Load saved draft
                  </Button>
                  <Button type="button" onClick={() => resolveDraft(true)}>
                    Keep my draft
                  </Button>
                </>
              ) : (
                <Button type="button" onClick={() => persist(valueRef.current)}>
                  Retry draft save
                </Button>
              )}
            </div>
          )}
        {editing.retryable && (
          <>
            <p role="status">Your edit is still in the outbox.</p>
            <Button
              type="button"
              disabled={editDisabled}
              onClick={editing.retry}
            >
              Retry edit
            </Button>
          </>
        )}
        {(error || editing.error) && emojiCatalog.status === "error" && (
          <Button
            type="button"
            disabled={editingDisabled}
            onClick={() => {
              void session.emoji.refresh().then(() => {
                if (
                  input.current?.isConnected &&
                  session.emoji.snapshot().status === "ready"
                ) {
                  setError(undefined);
                  editing.clearError();
                }
              });
            }}
          >
            Retry message preparation
          </Button>
        )}
      </form>
      {active && linkEdit && (
        <ComposerLinkDialog
          edit={linkEdit}
          input={input}
          finalFocus={() => (permitted.current ? input.current : false)}
          disabled={editingDisabled}
          close={() => setLinkEdit(null)}
        />
      )}
    </SelectedMentionContext.Provider>
  );
}

/** Presentation stays host-owned even when the optional mention tool is disabled. */
function RecipientAvatars({
  session,
  recipients,
  disabled,
  remove,
}: {
  session: RelaySession;
  recipients: readonly MentionRecipient[];
  disabled: boolean;
  remove(pubkey: string): void;
}) {
  const reduceMotion = useReducedMotion();
  const enter = useCallback(
    (node: HTMLButtonElement | null) => {
      if (
        !node ||
        document.documentElement.hasAttribute("data-keyboard-navigation") ||
        reduceMotion
      )
        return;
      const animation = animate(
        node,
        { transform: ["scale(0.9)", "scale(1)"] },
        { type: "spring", duration: 0.24, bounce: 0.15 },
      );
      return () => animation.stop();
    },
    [reduceMotion],
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const agentPubkeys = useKnownAgentPubkeys(session, profiles);
  const unique = [
    ...new Map(recipients.map((item) => [item.pubkey, item])).values(),
  ];
  return (
    <section
      className={styles.mentionRecipients}
      aria-label="Explicit mentions"
    >
      {unique.map((recipient) => {
        const profile = profiles.get(recipient.pubkey);
        return (
          <IconButton
            key={recipient.pubkey}
            type="button"
            size="toolbar"
            ref={enter}
            data-mention-recipient=""
            data-avatar-shape={
              agentPubkeys.has(recipient.pubkey) ? "squircle" : "circle"
            }
            title={`Remove explicit mention of ${recipient.name} (${recipient.pubkey.slice(0, 8)})`}
            aria-label={`Remove mention ${recipient.name} ${recipient.pubkey}`}
            disabled={disabled}
            onClick={() => remove(recipient.pubkey)}
            icon={
              <span
                className={styles.mentionRecipientArtwork}
                data-avatar-shape={
                  agentPubkeys.has(recipient.pubkey) ? "squircle" : "circle"
                }
                aria-hidden="true"
              >
                <Avatar
                  alt=""
                  fallback={recipient.name}
                  src={session.media(profile?.picture ?? "", "small")}
                  size="small"
                  shape={
                    agentPubkeys.has(recipient.pubkey) ? "squircle" : "circle"
                  }
                />
                <span className={styles.mentionRecipientRemove}>
                  <XIcon size={16} />
                </span>
              </span>
            }
          />
        );
      })}
    </section>
  );
}
