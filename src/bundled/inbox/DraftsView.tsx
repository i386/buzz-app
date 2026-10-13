import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import { ThreadPanel } from "../../features/messages/ThreadPanel";
import { ChannelPreview } from "./ChannelPreview";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { Navigation } from "../../features/navigation/controller";
import type { NavigationScope } from "../../features/navigation/targets";
import { selectProfiles } from "../../features/relay/profile-selection";
import { useIdentityNames } from "../../features/identity-names/react";
import { mentionDraft } from "../../features/messages/mention-draft";
import { clearAttachmentDraft } from "../../features/messages/attachment-draft";
import {
  clearView,
  draftCoordinates,
  listDraftViews,
  subscribeView,
} from "../../shared/view-state";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import {
  ArrowSquareOutIcon,
  ChatCircleIcon,
  TrashIcon,
  HashIcon,
  XIcon,
} from "../../shared/design-system/icons/index";
import styles from "./Inbox.module.css";
import { dmLabel } from "./dm-label";

export function DraftsView({
  session,
  scope,
  navigator,
  extensions,
  onEmptyRetire,
  toolbar,
  resizeHandle,
}: {
  session: RelaySession;
  scope: NavigationScope;
  navigator: Navigation;
  extensions?: ConversationExtensions | undefined;
  onEmptyRetire(): void;
  toolbar: ReactNode;
  resizeHandle?: ReactNode;
}) {
  const [revision, update] = useState(0);
  useEffect(
    () => subscribeView(session.scope, () => update((value) => value + 1)),
    [session],
  );
  const [selected, setSelected] = useState<string>();
  const invoking = useRef<{ key: string; row: HTMLButtonElement }>(undefined);
  const fallbackRow = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<HTMLButtonElement>(null);
  const visit = invoking.current;
  useLayoutEffect(() => {
    if (selected || !restoreFocus.current) return;
    const row = restoreFocus.current.isConnected
      ? restoreFocus.current
      : fallbackRow.current;
    restoreFocus.current = null;
    if (row) row.focus();
    else onEmptyRetire();
  }, [selected, onEmptyRetire]);
  // Keep an emptied selected draft mounted while its composer is being edited.
  // The composer owns draft contents and storage; Inbox only enumerates its scope.
  const saved = listDraftViews(
    session.scope,
    (value) => !!mentionDraft(value).text.trim(),
    selected,
  );
  const entries = saved.entries.flatMap(({ key, value }) => {
    const coordinates = draftCoordinates(key);
    return coordinates
      ? [{ key, draft: mentionDraft(value), coordinates }]
      : [];
  });
  void revision;
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const channels = list.channels;
  const [limit, setLimit] = useState(50);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const closeControl = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected) closeControl.current?.focus({ preventScroll: true });
  }, [selected]);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string>();
  // Selection owns editor lifetime, not the bounded list summary's eligibility.
  const coordinates = selected && draftCoordinates(selected);
  const active =
    selected && coordinates ? { key: selected, coordinates } : undefined;
  const channelFor = (channelId: string) =>
    channels.find(
      (item) =>
        item.id === channelId &&
        !item.cached &&
        !item.archived &&
        !item.readOnly &&
        item.members?.includes(scope.viewer),
    );
  const visible = entries.slice(0, limit);
  const profileKey = [
    ...new Set(
      [
        ...visible,
        ...(active && !visible.some((entry) => entry.key === active.key)
          ? [active]
          : []),
      ].flatMap(({ coordinates }) => {
        const channel = channelFor(coordinates.channelId);
        return channel?.channelType === "dm"
          ? (channel.participants?.slice(0, 3) ?? [])
          : [];
      }),
    ),
  ]
    .sort()
    .join(":");
  const profileIds = useMemo(
    () => (profileKey ? profileKey.split(":") : []),
    [profileKey],
  );
  const selection = useMemo(
    () => selectProfiles(session.profiles, profileIds),
    [session, profileIds],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const name = useIdentityNames(session.names);
  useEffect(() => {
    // An access/cache reset retires old profile work; a ready roster starts
    // a fresh bounded read for the visible DM destinations.
    void list.asOf;
    if (list.status === "ready" && profileIds.length)
      void session.profiles.ensure(profileIds, "background").catch(() => {});
  }, [session, profileIds, list.status, list.asOf]);
  const destination = (channel: ChannelSummary | undefined) => {
    if (!channel) return "Unavailable conversation";
    if (channel.channelType !== "dm") return `#${channel.name}`;
    return dmLabel(channel.participants, profiles, name);
  };
  const activeChannel = active
    ? channelFor(active.coordinates.channelId)
    : undefined;
  const title = !activeChannel
    ? "Unavailable conversation"
    : activeChannel.channelType === "dm"
      ? "Direct message"
      : activeChannel.name;
  const open = async () => {
    if (!active) return;
    const channel = channelFor(active.coordinates.channelId);
    if (!channel) {
      setError("This conversation is no longer available.");
      return;
    }
    try {
      const result = await navigator.open({
        version: 1,
        kind: "conversation",
        scope,
        channelId: channel.id,
        ...(active.coordinates.threadRootId
          ? {
              messageId: active.coordinates.threadRootId,
              threadRootId: active.coordinates.threadRootId,
            }
          : {}),
      });
      if (result.status === "failed")
        setError("Could not open the conversation. Try again.");
    } catch {
      setError("Could not open the conversation. Try again.");
    }
  };
  const originAction = (
    <IconButton
      size="sm"
      aria-label="Open in origin"
      title="Open in origin"
      onClick={() => void open()}
      icon={<ArrowSquareOutIcon size="1rem" aria-hidden="true" />}
    />
  );
  const retire = () => {
    // A saved-send callback belongs to this visit, not a later selection of
    // even the same key. Restore focus only after the surviving list commits.
    if (!visit || invoking.current !== visit) return;
    invoking.current = undefined;
    restoreFocus.current = visit.row;
    setSelected(undefined);
    setConfirmDelete(false);
    setError(undefined);
  };
  const remove = () => {
    if (!active || !confirmDelete) return;
    try {
      clearView(session.scope, active.key);
      clearAttachmentDraft(session, `${session.scope}:${active.key}`);
      retire();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not delete the draft. Try again.",
      );
    }
  };
  return (
    <div className={styles.workspace} data-selected={!!active || undefined}>
      {toolbar}
      <div className={styles.draftList}>
        {!entries.length && !saved.unavailable && !active && (
          <p role="status" className={styles.notice}>
            No drafts
          </p>
        )}
        <ul className={styles.list} aria-label="Drafts">
          {visible.map((entry) => {
            const channel = channelFor(entry.coordinates.channelId);
            const label = destination(channel);
            const dm = channel?.channelType === "dm";
            const first = dm ? channel.participants?.[0] : undefined;
            const artwork = first && profiles.get(first)?.picture;
            return (
              <li
                key={entry.key}
                className={styles.row}
                data-selected={selected === entry.key || undefined}
              >
                <NavigationItem
                  ref={entry === visible[0] ? fallbackRow : undefined}
                  aria-label={`Open draft for ${label}`}
                  selected={selected === entry.key}
                  icon={
                    dm && first ? (
                      <Avatar
                        size="default"
                        alt=""
                        fallback={label}
                        src={artwork ? session.media(artwork) : undefined}
                        shape={
                          profiles.get(first)?.isAgent ? "squircle" : "circle"
                        }
                      />
                    ) : (
                      <HashIcon size={20} aria-hidden="true" />
                    )
                  }
                  label={
                    <span className={styles.content}>
                      <strong
                        className={`text-label-sm text-standard ${styles.sender}`}
                      >
                        {label}
                      </strong>
                      <span className={styles.sourceLine}>
                        <span
                          className={`text-caption ${styles.source}`}
                          data-inbox-source=""
                        >
                          <span className={styles.sourceName}>
                            {entry.coordinates.threadRootId
                              ? "Reply"
                              : "Message"}{" "}
                            · {dm ? "DM" : "Channel"}
                          </span>
                        </span>
                      </span>
                      <span
                        className={`text-body text-subtle ${styles.preview}`}
                      >
                        {entry.draft.text}
                      </span>
                    </span>
                  }
                  onClick={(event) => {
                    if (invoking.current?.key !== entry.key)
                      invoking.current = {
                        key: entry.key,
                        row: event.currentTarget,
                      };
                    setSelected(entry.key);
                    setConfirmDelete(false);
                    setError(undefined);
                  }}
                />
              </li>
            );
          })}
        </ul>
        {!!saved.unavailable && (
          <p className={styles.notice} role="status">
            {saved.unavailable} saved drafts exceed the preview size limit. They
            remain in their conversations.
          </p>
        )}
        {saved.limited && (
          <p className={styles.notice} role="status">
            Showing the first 500 saved drafts. Other drafts remain in their
            conversations.
          </p>
        )}
        {entries.length > limit && (
          <div className={styles.notice}>
            <Button onClick={() => setLimit((value) => value + 50)}>
              Show more
            </Button>
          </div>
        )}
      </div>
      {active && (
        <section
          aria-label="Draft detail"
          className={styles.detail}
          onKeyDown={(event) => {
            if (
              event.key !== "Escape" ||
              event.defaultPrevented ||
              !event.currentTarget.contains(event.target as Node)
            )
              return;
            event.stopPropagation();
            retire();
          }}
        >
          {resizeHandle}
          <PanelHeader
            title={
              <PanelHeaderLabel
                title={title}
                icon={
                  activeChannel?.channelType === "dm" ? (
                    <ChatCircleIcon size="1rem" />
                  ) : (
                    <HashIcon size="1rem" />
                  )
                }
              />
            }
            actions={
              <>
                <IconButton
                  size="sm"
                  ref={deleteTrigger}
                  aria-label="Delete draft…"
                  title="Delete draft"
                  aria-expanded={confirmDelete}
                  onClick={() => setConfirmDelete(true)}
                  icon={<TrashIcon size="1rem" />}
                />
                {activeChannel && originAction}
                <IconButton
                  ref={closeControl}
                  size="sm"
                  aria-label="Close detail"
                  onClick={retire}
                  icon={<XIcon size="1rem" />}
                />
              </>
            }
          />
          <div className={styles.detailBody}>
            {error && !confirmDelete && (
              <p role="alert" className="text-body">
                {error}
              </p>
            )}
            <div className={styles.draftEditor}>
              {activeChannel ? (
                active.coordinates.threadRootId ? (
                  <ThreadPanel
                    key={active.key}
                    session={session}
                    scope={session.scope}
                    extensions={extensions}
                    channelId={activeChannel.id}
                    channelName={activeChannel.name}
                    messageId={active.coordinates.threadRootId}
                    requireReadyRoot
                    onDraftSaved={retire}
                    sessionConversation={
                      activeChannel.channelType === "session"
                    }
                    onOpenLink={() => false}
                  />
                ) : (
                  <ChannelPreview
                    key={active.key}
                    session={session}
                    extensions={extensions}
                    channelId={activeChannel.id}
                    channelName={
                      activeChannel.channelType === "dm"
                        ? `DM with ${destination(activeChannel)}`
                        : activeChannel.name
                    }
                    draft
                    onDraftSaved={retire}
                  />
                )
              ) : (
                <p role="status" className="text-body text-subtle">
                  This conversation is unavailable. Your draft is unchanged.
                </p>
              )}
            </div>
            {confirmDelete && (
              <AlertDialog
                title="Delete draft?"
                description="Delete this saved draft and its attachments on this device? This cannot be undone."
                onClose={() => setConfirmDelete(false)}
                // On deletion, retirement restores the surviving list control.
                // On cancel, Base UI restores the still-mounted delete trigger.
                finalFocus={() =>
                  invoking.current === visit ? deleteTrigger.current : false
                }
                actions={
                  <>
                    <Button size="sm" variant="destructive" onClick={remove}>
                      Delete draft
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmDelete(false)}
                    >
                      Cancel
                    </Button>
                  </>
                }
              >
                {error && (
                  <p role="alert" className="text-body text-danger">
                    {error}
                  </p>
                )}
              </AlertDialog>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
