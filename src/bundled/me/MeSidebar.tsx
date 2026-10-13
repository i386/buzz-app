import { useSyncExternalStore, type ComponentProps } from "react";
import { useChannelNavigation } from "../../features/channel-navigation/ChannelNavigationState";
import { ChannelActivityPopover } from "../channels/ChannelActivityPopover";
import { useWorkingAgents } from "../channels/useWorkingAgents";
import { WorkingAgentsBadge } from "../channels/WorkingAgentsBadge";
import channelStyles from "../channels/Channels.module.css";
import { sessionLinkTarget } from "../sessions/SessionsPage";
import { SidebarFrame } from "../../features/channel-navigation/SidebarFrame";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  RecoveryNotice,
  useRecoveryShown,
} from "../../features/relay/RecoveryNotice";
import type { Navigation } from "../../features/navigation/controller";
import type { OpenTarget } from "../../features/navigation/targets";
import { useMePlacement } from "../../features/sessions/personal";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { SessionSections } from "../sessions/SessionSections";
import { readChannelSidebarWidth } from "../channels/useSidebarView";
import { UnreadBadge } from "../channels/UnreadBadge";
import { meSelection, meTarget } from "./routes";
import styles from "../sessions/SessionsWorkspace.module.css";

type Props = { relay: RelayData; navigator: Navigation; target: OpenTarget };
export function MeSidebar({ relay, navigator, target }: Props) {
  const connection = useRelayConnection(relay);
  const scope = connection.scope ?? "disconnected";
  const width = readChannelSidebarWidth(scope);
  return (
    <div className="shell-sidebar-default" style={{ width }}>
      <SidebarFrame label="Me sidebar">
        {connection.status === "ready" ? (
          <PersonalHistory
            key={`${scope}:${connection.generation}`}
            session={connection.session}
            scope={scope}
            navigator={navigator}
            target={target}
          />
        ) : (
          <p role="status">Connect to a community to see your conversations.</p>
        )}
      </SidebarFrame>
    </div>
  );
}

function PersonalHistory({
  session,
  scope,
  navigator,
  target,
}: {
  session: RelaySession;
  scope: string;
  navigator: Navigation;
  target: OpenTarget;
}) {
  const list = useChannelList(session.channels);
  const placement = useMePlacement(session);
  const recoveryShown = useRecoveryShown(session.recovery);
  const selected = meSelection(target);
  const handoff = useChannelNavigation();
  const workingIds = useSyncExternalStore(
    session.agentActivity.subscribeWorking,
    session.agentActivity.workingSnapshot,
    session.agentActivity.workingSnapshot,
  );
  const workingChannels = new Set<string>(JSON.parse(workingIds));
  const openMessage = (channelId: string, messageId?: string) => {
    if (handoff && handoff.session !== session) return;
    const destination = sessionLinkTarget(
      messageId
        ? `buzz://message?channel=${channelId}&id=${messageId}`
        : `buzz://channel/${channelId}`,
      scope,
      session.viewer,
    );
    if (destination) void navigator.open(destination);
  };
  const openAgentActivity = (channelId: string, agent: string) => {
    if (!handoff || handoff.session !== session) return;
    const intent = {
      channelId,
      agent,
      trigger: document.querySelector<HTMLElement>(
        `[data-me-channel-id="${CSS.escape(channelId)}"]`,
      ),
    };
    handoff.activityAgent.current = intent;
    void navigator.open(meTarget(scope, channelId)).then(() => {
      if (handoff.activityAgent.current === intent)
        handoff.activityAgent.current = undefined;
    });
  };
  const conversations = list.channels
    .filter((item) => !item.archived && placement.ids.includes(item.id))
    .sort(
      (a, b) =>
        (b.lastActivityAt ?? b.updatedAt ?? 0) -
          (a.lastActivityAt ?? a.updatedAt ?? 0) || a.id.localeCompare(b.id),
    );
  return (
    <nav
      className={`${styles.sidebar} ${styles.history}`}
      aria-label="Me conversations"
    >
      <SessionSections
        personal
        visit={navigator.snapshot().attempt.signal}
        session={session}
        scope={scope}
        sessions={conversations.map((item) => ({
          id: item.id,
          title: item.name,
        }))}
        onShared={(id) => {
          const destination = sessionLinkTarget(
            `buzz://channel/${id}`,
            scope,
            session.viewer,
          );
          if (destination) void navigator.open(destination);
        }}
        onNew={(sectionId) =>
          void navigator.open(meTarget(scope, "new", sectionId))
        }
        renderSession={(item) => (
          <MeConversationRow
            key={item.id}
            session={session}
            id={item.id}
            title={item.title}
            selected={selected === item.id}
            working={workingChannels.has(item.id)}
            onSelect={() => void navigator.open(meTarget(scope, item.id))}
            onOpenThread={(thread) =>
              openMessage(thread.channelId, thread.rootId)
            }
            onOpenWorkingAgent={(id, _agent, messageId) => {
              if (messageId) openMessage(id, messageId);
              else void navigator.open(meTarget(scope, id));
            }}
            onOpenAgentActivity={openAgentActivity}
          />
        )}
      />
      {list.status === "loading" && <p role="status">Loading conversations…</p>}
      {list.status === "error" && !recoveryShown && (
        <p role="alert">{list.error}</p>
      )}
      {/* The channel list and Me placement recover through one automatic
          owner; its notice is the single Retry. */}
      <RecoveryNotice recovery={session.recovery} />
      {placement.status !== "ready" && !recoveryShown && (
        <p role="status">{placement.error ?? "Loading Me placement…"}</p>
      )}
      {!conversations.length &&
        list.status === "ready" &&
        placement.status === "ready" && (
          <p className={styles.listMessage}>
            Start a conversation with your agents.
          </p>
        )}
    </nav>
  );
}

function MeConversationRow({
  session,
  id,
  title,
  selected,
  working,
  onSelect,
  onOpenThread,
  onOpenWorkingAgent,
  onOpenAgentActivity,
}: {
  session: RelaySession;
  id: string;
  title: string;
  selected: boolean;
  working: boolean;
  onSelect: () => void;
} & Pick<
  ComponentProps<typeof ChannelActivityPopover>,
  "onOpenThread" | "onOpenWorkingAgent" | "onOpenAgentActivity"
>) {
  const { agents, agentProfiles, waiting } = useWorkingAgents(
    session,
    id,
    working,
  );
  return (
    <ChannelActivityPopover
      session={session}
      channelId={id}
      channelName={title}
      agents={agents}
      agentProfiles={agentProfiles}
      onOpenThread={onOpenThread}
      {...(onOpenWorkingAgent ? { onOpenWorkingAgent } : {})}
      {...(onOpenAgentActivity ? { onOpenAgentActivity } : {})}
      trigger={
        <NavigationItem
          type="button"
          selected={selected}
          data-me-channel-id={id}
          aria-current={selected ? "page" : undefined}
          onClick={onSelect}
          label={
            <span className={styles.sessionRow}>
              <UnreadBadge session={session} channelId={id} label={title} />
            </span>
          }
          trailing={
            <span
              className={channelStyles.indicatorStack}
              data-me-working-indicator=""
            >
              <WorkingAgentsBadge
                agents={agents}
                profiles={agentProfiles}
                channelName={title}
                waiting={waiting}
              />
            </span>
          }
        />
      }
    />
  );
}
