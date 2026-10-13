import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import type { ComposerAccessoryProps } from "../../features/conversation/contracts";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import type { activityRecords } from "../../features/agents/activity-records";
import { activityTarget } from "../../features/agents/activity-target";
import { profileActivityViewTarget } from "../../features/profiles/target";
import { publicKeyLabels } from "../../shared/identity/public-key";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { XIcon } from "../../shared/design-system/icons";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { ShimmerText } from "../../shared/design-system/ui/ShimmerText";
import { TypingDots } from "../../shared/design-system/ui/TypingDots";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { currentActivity } from "./current-activity";
import { messageActivity } from "./message-activity";
import type { ActivityTurn } from "../../features/agents/activity";
import {
  requestWork,
  type RequestWork,
} from "../../features/agents/request-work";
import {
  localWorkLabel,
  type WorkStep,
} from "../../features/agents/local-activity";
import { useTypingReplacement } from "../../features/conversation/typing-presentation";
import styles from "./ActivityAccessory.module.css";

const noSubscribe = () => () => {};
/** Activity belongs to the exact triggering message, not the composer. */
export function ActivityAccessory(props: ComposerAccessoryProps) {
  const { session, channelId, message, canOpen } = props;
  const messageId = message?.id;
  // Every row mounts this; only rows with work subscribe to each activity
  // step, profile and choice change. Others read once and wait for work.
  const hasWork = useSyncExternalStore(
    session.agentActivity.subscribe,
    () =>
      !!messageId &&
      messageActivity(session.agentActivity.snapshot(), channelId, messageId)
        .length > 0,
  );
  const snapshot = useSyncExternalStore(
    hasWork ? session.agentActivity.subscribe : noSubscribe,
    session.agentActivity.snapshot,
  );
  const entries = useMemo(
    () =>
      messageId && hasWork
        ? messageActivity(snapshot, channelId, messageId)
        : [],
    [snapshot, channelId, messageId, hasWork],
  );
  const profiles = useSyncExternalStore(
    hasWork ? session.profiles.subscribe : noSubscribe,
    session.profiles.snapshot,
  );
  const choices = useSyncExternalStore(
    hasWork ? session.agentChoices.subscribe : noSubscribe,
    session.agentChoices.snapshot,
  );
  const resolveName = useChannelIdentityNames(session, channelId);
  const keys = entries.map((entry) => entry.agent);
  const identityKeys = keys.join(":");
  useEffect(() => {
    if (identityKeys)
      void session.profiles
        .ensure(identityKeys.split(":"), "background")
        .catch(() => {});
  }, [session.profiles, identityKeys]);
  const suffixes = publicKeyLabels(keys);
  const names = keys.map((key) =>
    resolveName(
      key,
      profiles.get(key)?.name ??
        choices.identities.find((row) => row.pubkey === key)?.name ??
        suffixes.get(key) ??
        "Agent",
    ),
  );
  const visible = entries.filter((entry) =>
    entry.lifecycle
      ? canOpen(profileActivityViewTarget(entry.agent) ?? "")
      : canOpen(activityTarget(entry.agent, channelId)),
  );
  const shown: Entry[] = visible.map((entry) => {
    const name = names[keys.indexOf(entry.agent)] ?? "Agent";
    return {
      agent: entry.agent,
      name:
        names.filter((value) => value === name).length > 1
          ? `${name} · ${suffixes.get(entry.agent)}`
          : name,
      picture: profiles.get(entry.agent)?.picture,
      working: entry.working,
      state: entry.state,
      reason: entry.reason,
      ...(entry.step ? { step: entry.step } : {}),
      lifecycle: entry.lifecycle,
      records: entry.selected.records,
      turns: entry.turns,
    };
  });
  // When work ends (not when access is revoked), keep the last bubble long
  // enough for the shared leave recipe, then remove it.
  const section = useRef<HTMLElement>(null);
  const retained = useRef<Entry[]>([]);
  const [leaving, setLeaving] = useState<Entry[] | null>(null);
  const ended = !entries.length;
  useLayoutEffect(() => {
    // Child closes its portal and restores focus before this subtree is inert.
    if (section.current) section.current.inert = !shown.length;
    if (shown.length) {
      retained.current = shown;
      if (leaving) setLeaving(null);
      return;
    }
    if (ended && retained.current.length) setLeaving(retained.current);
    retained.current = [];
  });
  useLayoutEffect(() => {
    if (!leaving) return;
    const animations = section.current?.getAnimations?.() ?? [];
    if (!animations.length) {
      setLeaving(null);
      return;
    }
    let live = true;
    const done = () => {
      if (live) setLeaving(null);
    };
    void Promise.all(animations.map((animation) => animation.finished)).then(
      done,
      done,
    );
    return () => {
      live = false;
    };
  }, [leaving]);
  // The render where work ends keeps the same element (from the last shown
  // entries) so the list never loses and regains its height mid-handoff.
  const bubble = shown.length
    ? shown
    : (leaving ?? (ended ? retained.current : []));
  if (!bubble.length) return null;
  return (
    <section
      ref={section}
      className={`${styles.root} buzz-arrive`}
      data-arrive="grow"
      data-leaving={shown.length ? undefined : ""}
      data-buzz-ui=""
      aria-label="Agent activity on this message"
      aria-hidden={shown.length ? undefined : true}
    >
      <div>
        {shown.map((entry) => (
          <TypingReplacement key={entry.agent} {...props} agent={entry.agent} />
        ))}
        <ActivityBubble
          key={`${channelId}:${message?.id ?? ""}`}
          {...props}
          entries={bubble}
          interactive={shown.length > 0}
        />
      </div>
    </section>
  );
}

type Entry = {
  agent: string;
  name: string;
  picture: string | undefined;
  working: boolean;
  state: RequestWork["state"];
  reason: string | undefined;
  step?: WorkStep;
  lifecycle: boolean;
  records: ReturnType<typeof activityRecords>;
  turns: readonly ActivityTurn[];
};

function ActivityBubble({
  entries,
  interactive,
  ...props
}: ComposerAccessoryProps & { entries: Entry[]; interactive: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (interactive) return;
    const active = trigger.current?.ownerDocument.activeElement;
    if (
      active &&
      (trigger.current?.contains(active) || popup.current?.contains(active))
    )
      props.onFocusedRemoval?.();
    setExpanded(false);
  }, [interactive, props.onFocusedRemoval]);
  const working = entries.some((entry) => entry.working);
  // Local work breathes until its first step ("Starting"), like the sidebar and thread.
  const starting = (entry: Entry) =>
    entry.lifecycle &&
    (entry.state === "waiting" || (entry.state === "working" && !entry.step));
  const waiting = entries.some(starting);
  const stepping = entries.some((entry) => entry.working && !starting(entry));

  const unknown = entries.some((entry) => !entry.lifecycle && !entry.working);
  const failed = entries.some(
    (entry) => entry.lifecycle && entry.state === "error",
  );
  const label = (entry: Entry) =>
    entry.lifecycle
      ? localWorkLabel({
          state:
            entry.state === "ended"
              ? "done"
              : entry.state === "unknown"
                ? "error"
                : entry.state,
          ...(entry.reason ? { error: entry.reason } : {}),
          ...(entry.step ? { step: entry.step } : {}),
        })
      : entry.working
        ? "working"
        : "status unknown";
  return (
    <PopoverRoot
      open={expanded}
      onOpenChange={(open) => setExpanded(interactive && open)}
    >
      <PopoverTrigger
        openOnHover
        onClick={(event) => {
          if (!interactive) {
            event.preventBaseUIHandler();
            return;
          }
          if (props.openThread?.()) {
            event.preventBaseUIHandler();
            setExpanded(false);
          }
        }}
        render={
          <Button
            ref={trigger}
            tabIndex={interactive ? undefined : -1}
            size="xs"
            variant="subtle"
            aria-label={`${props.openThread ? "Open thread" : "View agent activity"}: ${entries.map((entry) => `${entry.name}, ${label(entry)}`).join("; ")}`}
          >
            <AvatarStack
              items={entries.map((entry) => ({
                id: entry.agent,
                name: entry.name,
                src: entry.picture
                  ? props.session.media(entry.picture)
                  : undefined,
                shape: "squircle",
              }))}
            />
            {(working || waiting) && (
              <TypingDots state={stepping ? "working" : "waiting"} />
            )}
            {failed && <span>Could not finish</span>}
            {unknown && <span>Status unknown</span>}
          </Button>
        }
      />
      <PopoverPopup
        ref={popup}
        finalFocus={interactive ? undefined : false}
        side="top"
        padding="list"
        aria-label="Agent activity"
      >
        {expanded && (
          <div className={styles.previews}>
            {entries.map((entry) => {
              // Both open the agent's profile on its activity: a plugin
              // agent's own session tab, or the harness Activity tab.
              const target = profileActivityViewTarget(entry.agent);
              const preview = entry.working
                ? currentActivity(entry.records, entry.turns)
                : undefined;
              return (
                <div key={entry.agent} className={styles.row}>
                  <NavigationItem
                    aria-label={`View activity for ${entry.name}`}
                    disabled={!target || !props.canOpen(target)}
                    onClick={() => {
                      if (target && props.canOpen(target) && props.open(target))
                        setExpanded(false);
                    }}
                    icon={
                      <ActivityAvatar
                        session={props.session}
                        entry={entry}
                        size="small"
                      />
                    }
                    label={
                      <span
                        className={`text-body-sm ${styles.preview}`}
                        data-error={
                          entry.lifecycle && entry.state === "error"
                            ? ""
                            : undefined
                        }
                      >
                        <ShimmerText
                          active={
                            entry.lifecycle
                              ? entry.state === "working"
                              : entry.working
                          }
                        >
                          {entry.lifecycle
                            ? label(entry)
                            : !entry.working
                              ? "Activity interrupted or out of date"
                              : (preview?.title ??
                                "Waiting for activity details")}
                        </ShimmerText>
                        {preview?.detail && (
                          <span className={styles.detail}>
                            {preview.detail}
                          </span>
                        )}
                      </span>
                    }
                  />
                  {entry.lifecycle && entry.state === "error" ? (
                    <IconButton
                      size="xs"
                      aria-label={`Dismiss error from ${entry.name}`}
                      icon={<XIcon />}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (
                          props.message &&
                          props.session.agentActivity.dismissError?.(
                            entry.agent,
                            props.channelId,
                            props.message.id,
                          )
                        ) {
                          if (entries.length === 1) props.onFocusedRemoval?.();
                          setExpanded(entries.length > 1);
                        }
                      }}
                    />
                  ) : undefined}
                </div>
              );
            })}
          </div>
        )}
      </PopoverPopup>
    </PopoverRoot>
  );
}

/** Message-linked work replaces the composer control; unassociated work keeps
 * main's existing presentation rather than disappearing without a bubble. */
export function ActivityTypingReplacement(props: ComposerAccessoryProps) {
  const activity = useSyncExternalStore(
    props.session.agentActivity.subscribe,
    props.session.agentActivity.snapshot,
  );
  const ids = [
    ...(props.threadRootId ? [props.threadRootId] : []),
    ...(activity.local ?? [])
      .filter(
        (request) =>
          request.channelId === props.channelId &&
          (!props.threadRootId ||
            (request.threadRootId ?? request.messageId) === props.threadRootId),
      )
      .map((request) => request.messageId),
    ...activity.turns.flatMap((turn) =>
      turn.channelId === props.channelId
        ? (turn.requests ?? [])
            .filter(
              (request) =>
                !props.threadRootId ||
                request.threadRootId === props.threadRootId,
            )
            .map((request) => request.messageId)
        : [],
    ),
  ];
  const agents = requestWork(activity, props.channelId, ids);
  return (
    <>
      {agents.map(({ agent }) => (
        <TypingReplacement key={agent} {...props} agent={agent} />
      ))}
    </>
  );
}
function TypingReplacement({
  session,
  channelId,
  threadRootId,
  agent,
}: ComposerAccessoryProps & { agent: string }) {
  useTypingReplacement(
    { session, channelId, threadRootId, pubkey: agent },
    true,
  );
  return null;
}

function ActivityAvatar({
  session,
  entry,
  size = "compact",
}: Pick<ComposerAccessoryProps, "session"> & {
  entry: Entry;
  size?: "compact" | "small";
}) {
  return (
    <Avatar
      src={entry.picture ? session.media(entry.picture) : null}
      alt={entry.name}
      fallback={entry.name}
      size={size}
      shape="squircle"
    />
  );
}
