import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { Reminder, Reminders } from "../../features/relay/reminders";
import type { Navigation } from "../../features/navigation/controller";
import { useChannelList } from "../../features/relay/react";
import { selectProfiles } from "../../features/relay/profile-selection";
import { useIdentityNames } from "../../features/identity-names/react";
import { messagePreview } from "../../features/notifications/content";
import { formatPublicKey } from "../../shared/identity/public-key";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import {
  AlarmIcon,
  ArrowSquareOutIcon,
  CheckIcon,
  DotsThreeIcon,
  XIcon,
} from "../../shared/design-system/icons/index";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import {
  MenuIcon,
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuSeparator,
  MenuTrailing,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import {
  TIME_PRESETS,
  dueLabel,
  endOfToday,
  formatDue,
  groupReminders,
  navigableTarget,
  presetHint,
} from "./model";
import { scopeOf, useReminders } from "./react";
import styles from "./Reminders.module.css";

type Clock = { subscribe(listener: () => void): () => void; read(): number };

export function RemindersPage({
  relay,
  navigator,
  clock,
}: {
  relay: RelayData;
  navigator: Navigation;
  clock: Clock;
}) {
  const { connection, reminders, state } = useReminders(relay);
  const now = useSyncExternalStore(clock.subscribe, clock.read, clock.read);
  const [error, setError] = useState<string>();
  // The store whose Retry read is pending; a replaced store's never counts.
  const [retrying, setRetrying] = useState<Reminders>();
  const page = useRef<HTMLDivElement>(null);
  const retryFocus = useRef(false);
  const retryButton = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    // Capture ownership before removal, not after focus has fallen to body.
    return () => {
      retryFocus.current = document.activeElement === button;
    };
  }, []);
  const scope = scopeOf(connection);
  const groups = groupReminders(state.reminders, now, endOfToday());
  const done = groups.find((group) => group.label === "Done");
  const active = groups.filter((group) => group !== done);
  const run = (action: Promise<unknown>) => {
    setError(undefined);
    action.catch(() =>
      setError("The reminder could not be updated. Try again."),
    );
  };
  const open = (reminder: Reminder) => {
    const target = navigableTarget(reminder);
    if (!target || !scope) return;
    void navigator
      .open({
        version: 1,
        kind: "conversation",
        scope,
        channelId: target.channelId,
        messageId: target.eventId,
      })
      .then((result) => {
        if (result.status === "failed")
          setError("This message could not be opened.");
      });
  };
  const status = !reminders
    ? connection.status === "error"
      ? (connection.error ?? "Could not connect.")
      : "Connect to a community to see your reminders."
    : state.status === "loading" && !state.hydrated
      ? "Loading reminders…"
      : undefined;
  // Any failed read, first or later, keeps Retry up beside whatever list we
  // have until a read succeeds; live arrivals never clear it.
  const failed =
    reminders && state.error !== undefined && state.status !== "loading";
  // Retry stays mounted, busy and focusable, while its own store's read is
  // pending.
  const busy = reminders !== undefined && retrying === reminders;
  const showRetry = failed || busy;
  const retry = (reminders: Reminders) => {
    setRetrying(reminders);
    void reminders
      .refresh()
      .finally(() =>
        setRetrying((current) => (current === reminders ? undefined : current)),
      );
  };
  // When Retry goes away while it had focus, the page takes it, unless the user
  // moved on or another control claimed focus in the same commit.
  useLayoutEffect(() => {
    if (showRetry || !retryFocus.current) return;
    retryFocus.current = false;
    if (document.activeElement === document.body) page.current?.focus();
  }, [showRetry]);
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Reminders">
        <div ref={page} tabIndex={-1} data-buzz-ui="" className={styles.page}>
          <PanelHeader
            title={
              <PanelHeaderLabel
                title="Reminders"
                icon={<AlarmIcon size="1rem" />}
              />
            }
          />
          {error && (
            <p role="alert" className={styles.notice}>
              {error}
            </p>
          )}
          {reminders && showRetry && (
            <div role="alert" className={styles.notice}>
              <p>Some reminders could not be loaded.</p>
              <Button
                ref={retryButton}
                loading={busy}
                onClick={() => retry(reminders)}
              >
                Retry reminders
              </Button>
            </div>
          )}
          {status || !reminders ? (
            <p role="status" className={styles.notice}>
              {status}
            </p>
          ) : (failed && !state.hydrated && !state.reminders.length) ||
            connection.status !== "ready" ? null : (
            <ReminderSections
              session={connection.session}
              reminders={reminders}
              active={active}
              done={done?.reminders}
              now={now}
              open={scope ? open : undefined}
              run={run}
            />
          )}
        </div>
      </FullPageSurface>
    </div>
  );
}

function ReminderSections({
  session,
  reminders,
  active,
  done,
  now,
  open,
  run,
}: {
  session: RelaySession;
  reminders: Reminders;
  active: readonly { label: string; reminders: Reminder[] }[];
  done: readonly Reminder[] | undefined;
  now: number;
  open: ((reminder: Reminder) => void) | undefined;
  run(action: Promise<unknown>): void;
}) {
  const all = [...active.flatMap((group) => group.reminders), ...(done ?? [])];
  const authorKey = [
    ...new Set(all.flatMap((item) => item.target?.authorPubkey || [])),
  ]
    .sort()
    .join(":");
  const authorIds = useMemo(
    () => (authorKey ? authorKey.split(":") : []),
    [authorKey],
  );
  const { channels } = useChannelList(session.channels);
  const profiles = useProfiles(session, authorIds);
  const name = useIdentityNames(session.names);
  const row = (reminder: Reminder) => {
    const target = reminder.target;
    const channel = target?.channelId
      ? channels.find((item) => item.id === target.channelId)
      : undefined;
    const author = target?.authorPubkey;
    const profile = author ? profiles.get(author) : undefined;
    const sender = author
      ? name(
          author,
          profile?.name ?? formatPublicKey(author) ?? "Unknown sender",
          channel?.members,
        )
      : "Reminder";
    const context =
      channel?.channelType === "dm"
        ? "Direct message"
        : channel?.name
          ? `#${channel.name}`
          : undefined;
    return (
      <ReminderRow
        key={reminder.id}
        reminder={reminder}
        reminders={reminders}
        now={now}
        sender={sender}
        context={context}
        avatar={
          author ? (
            <Avatar
              alt=""
              fallback={sender}
              src={
                profile?.picture ? session.media(profile.picture) : undefined
              }
              shape={profile?.isAgent ? "squircle" : "circle"}
            />
          ) : (
            <Avatar
              alt=""
              fallback="Reminder"
              fallbackContent={<AlarmIcon size={18} />}
              shape="squircle"
            />
          )
        }
        open={
          open && navigableTarget(reminder) ? () => open(reminder) : undefined
        }
        run={run}
      />
    );
  };
  return (
    <div className={styles.sections}>
      {active.length ? (
        active.map((group) => (
          <section
            key={group.label}
            aria-label={group.label}
            className={styles.group}
          >
            <InlineHeader
              title={group.label}
              actions={
                <span className="text-caption text-subtle">
                  {group.reminders.length}
                </span>
              }
            />
            <ul className={styles.list}>{group.reminders.map(row)}</ul>
          </section>
        ))
      ) : (
        <EmptyState
          icon={<AlarmIcon size={24} />}
          title={done ? "You're all caught up" : "No reminders yet"}
          description="Choose Remind me from any message's menu to bring it back here when it matters."
        />
      )}
      {done && (
        <section aria-label="Done" className={styles.group}>
          <Accordion
            variant="form"
            items={[
              {
                value: "done",
                title: `Done · ${done.length}`,
                content: <ul className={styles.list}>{done.map(row)}</ul>,
              },
            ]}
          />
        </section>
      )}
    </div>
  );
}

function useProfiles(session: RelaySession, ids: readonly string[]) {
  const selection = useMemo(
    () => selectProfiles(session.profiles, ids),
    [session, ids],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  useEffect(() => {
    if (ids.length)
      void session.profiles.ensure(ids, "background").catch(() => {});
  }, [session, ids]);
  return profiles;
}

function ReminderRow({
  reminder,
  reminders,
  now,
  sender,
  context,
  avatar,
  open,
  run,
}: {
  reminder: Reminder;
  reminders: Reminders;
  now: number;
  sender: string;
  context: string | undefined;
  avatar: ReactNode;
  open: (() => void) | undefined;
  run(action: Promise<unknown>): void;
}) {
  const id = useId();
  const pending = reminder.status === "pending";
  const overdue =
    pending && reminder.notBefore !== undefined && reminder.notBefore <= now;
  const preview = reminder.target?.preview
    ? messagePreview(reminder.target.preview)
    : reminder.note;
  const note = reminder.target?.preview ? reminder.note : undefined;
  const due =
    pending && reminder.notBefore !== undefined ? (
      <time
        id={`${id}-due`}
        className={`text-caption ${styles.due}`}
        data-overdue={overdue || undefined}
        dateTime={new Date(reminder.notBefore * 1000).toISOString()}
        title={formatDue(reminder.notBefore)}
      >
        <AlarmIcon size={12} aria-hidden="true" />
        {dueLabel(reminder.notBefore, now)}
      </time>
    ) : reminder.status === "done" ? (
      <span id={`${id}-due`} className="text-caption text-subtle">
        Done {relativeTimestamp(reminder.createdAt, now)}
      </span>
    ) : null;
  const snoozeItems = TIME_PRESETS.map((preset) => (
    <MenuItem
      key={preset.label}
      onClick={() => run(reminders.snooze(reminder.id, preset.at()))}
    >
      {preset.label}
      <MenuTrailing>{presetHint(preset.at(), now)}</MenuTrailing>
    </MenuItem>
  ));
  const label = (
    <span className={styles.content}>
      <span className={styles.heading}>
        <strong className={`text-label-sm text-standard ${styles.sender}`}>
          {sender}
        </strong>
        {context && (
          <span className={`text-caption ${styles.source}`}>{context}</span>
        )}
        {due}
      </span>
      {preview && (
        <span
          id={`${id}-preview`}
          className={`text-body ${pending ? "text-standard" : "text-subtle"} ${styles.preview}`}
        >
          {preview}
        </span>
      )}
      {note && (
        <span
          id={`${id}-note`}
          className={`text-caption text-subtle ${styles.note}`}
        >
          {note}
        </span>
      )}
    </span>
  );
  return (
    <li className={styles.row} data-status={reminder.status}>
      <div className={styles.rowSurface}>
        {open ? (
          <NavigationItem
            aria-label={`Open message from ${sender}`}
            aria-describedby={[
              preview && `${id}-preview`,
              note && `${id}-note`,
              due && `${id}-due`,
            ]
              .filter(Boolean)
              .join(" ")}
            icon={avatar}
            label={label}
            onClick={open}
          />
        ) : (
          <div className={styles.static}>
            {avatar}
            {label}
          </div>
        )}
        <span className={styles.rowActions}>
          {pending && (
            <IconButton
              aria-label={`Mark done: ${sender}`}
              title="Mark done"
              icon={<CheckIcon size={16} aria-hidden="true" />}
              onClick={() => run(reminders.complete(reminder.id))}
            />
          )}
          <MenuRoot>
            <MenuTrigger
              render={
                <IconButton
                  aria-label={`${pending ? "Snooze" : "Remind me again"}: ${sender}`}
                  title={pending ? "Snooze" : "Remind me again"}
                  icon={<AlarmIcon size={16} aria-hidden="true" />}
                />
              }
            />
            <MenuPopup align="end">{snoozeItems}</MenuPopup>
          </MenuRoot>
          {(open || pending) && (
            <MenuRoot>
              <MenuTrigger
                render={
                  <IconButton
                    aria-label={`More actions: ${sender}`}
                    title="More actions"
                    icon={<DotsThreeIcon size={16} aria-hidden="true" />}
                  />
                }
              />
              <MenuPopup align="end">
                {open && (
                  <MenuItem onClick={open}>
                    <MenuIcon>
                      <ArrowSquareOutIcon size={16} />
                    </MenuIcon>
                    Open message
                  </MenuItem>
                )}
                {open && pending && <MenuSeparator />}
                {pending && (
                  <MenuItem
                    tone="danger"
                    onClick={() => run(reminders.cancel(reminder.id))}
                  >
                    <MenuIcon>
                      <XIcon size={16} />
                    </MenuIcon>
                    Cancel reminder
                  </MenuItem>
                )}
              </MenuPopup>
            </MenuRoot>
          )}
        </span>
      </div>
    </li>
  );
}
