import { useChannelNavigation } from "../../features/channel-navigation/ChannelNavigationState";
import { activityTarget } from "../../features/agents/activity-target";
import { useConversationTabs } from "../channels/useConversationTabs";
import { useChannelTabState } from "../channels/useChannelTabState";
import { useChannelLabels } from "../channels/useChannelLabels";
import panelStyles from "../../features/panels/Panels.module.css";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
import { PanelDock } from "../../features/panels/PanelDock";
import { PanelFrame } from "../../features/panels/PanelFrame";
import { usePanelSplit } from "../../features/panels/usePanelSplit";
import type { Panels } from "../../features/panels/service";
import { SidebarRightIcon } from "../../shared/design-system/icons";
import { channelIcon } from "../../features/channels/channel-icon";
import channelStyles from "../channels/Channels.module.css";
import { SessionShare } from "./SessionShare";
import { ChannelMembersButton } from "../channels/ChannelMembersDialog";
import { pendingSessionDraft } from "../../features/sessions/pending-start";
import { RenameSession } from "../../features/sessions/RenameSession";
import { WorkspaceSettings } from "../../features/sessions/WorkspaceSettings";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuIcon,
} from "../../shared/design-system/ui/Menu";
import {
  DotsThreeIcon,
  GearIcon,
  PencilSimpleIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { useRecoveryShown } from "../../features/relay/RecoveryNotice";
import { ChatCircleIcon } from "../../shared/design-system/icons/index";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { PageNavigation } from "../../features/navigation/service";
import { useMePlacement } from "../../features/sessions/personal";
import { meSelection, meSection, meTarget } from "../me/routes";
import { subscribeView } from "../../shared/view-state";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type { Navigation } from "../../features/navigation/controller";
import {
  buzzLinkTarget,
  isBuzzLink,
} from "../../features/navigation/buzz-links";
import {
  useChannelList,
  useChannelWindow,
  useRelayConnection,
} from "../../features/relay/react";
import {
  MessageManagement,
  MessageManagementStatus,
} from "../../features/messages/MessageManagement";
import { ChannelTimeline } from "../../features/messages/ChannelTimeline";
import { rejectUnhandledFileDrop } from "../../features/messages/use-file-drop";
import { MessageComposer } from "../../features/messages/MessageComposer";
import { NewSessionComposer } from "../../features/sessions/NewSessionComposer";
import {
  SessionColumn,
  SessionHeading,
} from "../../features/sessions/SessionPresentation";
import styles from "../../features/sessions/Sessions.module.css";

export function SessionsPage({
  relay,
  panels,
  companion,
  extensions,
  navigator,
  navigation,
}: {
  relay: RelayData;
  panels: Panels;
  companion?: ReactNode;
  extensions: ConversationExtensions;
  navigator?: Navigation | undefined;
  navigation?: PageNavigation | undefined;
}) {
  const connection = useRelayConnection(relay);
  return connection.status === "ready" ? (
    <LiveSessions
      key={`${connection.scope}:${connection.generation}`}
      relay={relay}
      panels={panels}
      companion={companion}
      session={connection.session}
      scope={connection.scope ?? ""}
      extensions={extensions}
      navigator={navigator}
      navigation={navigation?.forSession(relay, connection)}
    />
  ) : (
    <PanelFrame companion={companion}>
      <section className={styles.empty} aria-label="Me">
        <ChatCircleIcon size={28} />
        <h1>Me</h1>
        <p>
          {connection.status === "connecting"
            ? "Connecting to your community…"
            : "Connect to a community to work with your agents."}
        </p>
        {connection.status === "error" && (
          <>
            <p role="alert">{connection.error ?? "The connection failed."}</p>
            <Button type="button" onClick={relay.retry}>
              Retry connection
            </Button>
          </>
        )}
      </section>
    </PanelFrame>
  );
}

function LiveSessions({
  relay,
  panels,
  companion,
  session,
  scope,
  extensions,
  navigator,
  navigation,
}: {
  relay: RelayData;
  panels: Panels;
  companion?: ReactNode;
  session: RelaySession;
  scope: string;
  extensions: ConversationExtensions;
  navigator?: Navigation | undefined;
  navigation?: PageNavigation | undefined;
}) {
  const list = useChannelList(session.channels);
  const placement = useMePlacement(session);
  const selected = meSelection(navigation?.target);
  const newSection = meSection(navigation?.target);
  const pendingDraft = useSyncExternalStore(
    useCallback((notify) => subscribeView(scope, notify), [scope]),
    () =>
      selected !== "new" ? pendingSessionDraft(scope, selected) : undefined,
  );
  const selectedSession = list.channels.find((item) => item.id === selected);
  const select = (id: string) => {
    void navigator?.open(meTarget(scope, id));
  };
  if (selected === "new" || pendingDraft)
    return (
      <PanelFrame companion={companion}>
        <NewSessionComposer
          personal={
            !pendingDraft ||
            pendingDraft === "me" ||
            pendingDraft.startsWith("me:")
          }
          standalone
          focusRequest={
            navigation?.focus === "preserve" ? 0 : (navigation?.signal ?? 0)
          }
          key={pendingDraft ?? newSection ?? "unfiled"}
          resumeDraftKey={pendingDraft}
          sectionId={
            pendingDraft?.includes(":section:")
              ? pendingDraft.split(":section:")[1]
              : newSection
          }
          extensions={extensions}
          session={session}
          scope={scope}
          onStarted={(id) => {
            if (navigation?.signal.aborted) return;
            if (!session.mePlacement.has(id)) {
              const target = meTarget(scope);
              if (target.kind === "page" && target.scope)
                void navigator?.open({
                  version: 1,
                  kind: "conversation",
                  scope: target.scope,
                  channelId: id,
                });
            } else select(id);
          }}
        />
      </PanelFrame>
    );
  if (selectedSession)
    return (
      <SessionWork
        relay={relay}
        panels={panels}
        companion={companion}
        key={`${selectedSession.id}:${navigation?.entryId ?? ""}`}
        session={session}
        scope={scope}
        channel={selectedSession}
        navigation={navigation}
        extensions={extensions}
        navigator={navigator}
      />
    );
  return (
    <PanelFrame companion={companion}>
      <section className={styles.empty}>
        {placement.status !== "ready" ? (
          <p role="status">{placement.error ?? "Loading Me placement…"}</p>
        ) : list.status === "loading" ? (
          <p role="status">Loading your conversation…</p>
        ) : (
          <>
            <p>
              This conversation isn’t in your Me workspace. Open it in Messages.
            </p>
            {selectedSession && (
              <Button
                onClick={() => {
                  const target = meTarget(scope);
                  if (target.kind === "page" && target.scope)
                    void navigator?.open({
                      version: 1,
                      kind: "conversation",
                      scope: target.scope,
                      channelId: selected,
                    });
                }}
              >
                Open in Messages
              </Button>
            )}
            <Button
              onClick={() => {
                session.channels.refreshList?.();
              }}
            >
              Retry
            </Button>
          </>
        )}
      </section>
    </PanelFrame>
  );
}

function SessionWork({
  relay,
  panels,
  companion,
  session,
  scope,
  channel,
  extensions,
  parentName,
  navigator,
  navigation,
}: {
  relay: RelayData;
  panels: Panels;
  companion?: ReactNode;
  session: RelaySession;
  scope: string;
  channel: ChannelSummary;
  extensions: ConversationExtensions;
  parentName?: string | undefined;
  navigation?: PageNavigation | undefined;
  navigator?: Navigation | undefined;
}) {
  const window = useChannelWindow(session.channels, channel.id);
  const recoveryShown = useRecoveryShown(session.recovery);
  const [sent, setSent] = useState<string>();
  const [renameOpen, setRenameOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const placement = useMePlacement(session);
  const inMe = placement.ids.includes(channel.id);
  const list = useChannelList(session.channels);
  const { channels } = useChannelLabels(
    list.channels,
    session.profiles,
    session.names,
  );
  const tabState = useChannelTabState(session, channel.id, "me");
  const mounted = useRef(false);
  const continuing = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    continuing.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const secondary = useConversationTabs({
    state: tabState,
    relay,
    session,
    panels,
    current: channel,
    scope,
    channels,
    extensions,
    leadingIds: [],
    continuingVisit: continuing.current,
    navigationSignal: navigation?.signal,
    isLive: () => !navigation?.signal.aborted,
    openLink: (url) => openLink(url),
    conversationIcon: (item) => {
      const Icon = channelIcon(item);
      return <Icon size="1rem" />;
    },
  });
  const { drawer, splitTrigger } = secondary;
  const handoff = useChannelNavigation();
  const { open, panelTrigger } = secondary;
  useLayoutEffect(() => {
    const intent = handoff?.activityAgent.current;
    if (
      !intent ||
      intent.channelId !== channel.id ||
      navigation?.signal.aborted
    )
      return;
    const target = activityTarget(intent.agent, intent.channelId);
    const panel = panels.resolve(target);
    if (panel) {
      panelTrigger.current = intent.trigger;
      open({ channelId: intent.channelId, panel, target }, true);
    }
    handoff.activityAgent.current = undefined;
  }, [handoff, channel.id, navigation, panels, open, panelTrigger]);

  const canOpenLink = (url: string) =>
    !!panels.resolve(url) ||
    (!!navigator && !!sessionLinkTarget(url, scope, session.viewer));
  function openLink(url: string) {
    const connection = relay.snapshot();
    if (
      !mounted.current ||
      navigation?.signal.aborted ||
      connection.status !== "ready" ||
      connection.session !== session
    )
      return false;
    const target = sessionLinkTarget(url, scope, session.viewer);
    if (target) {
      if (!navigator) return false;
      void navigator.open(target);
      return true;
    }
    const panel = panels.resolve(url);
    if (!panel) return false;
    secondary.panelTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    secondary.open({ channelId: channel.id, panel, target: url });
    return true;
  }
  useEffect(
    () => () => tabState.retireMenuEntries(),
    [tabState.retireMenuEntries],
  );
  const split = usePanelSplit();
  const hasTabs = secondary.items.length > 0;
  const hasLocalPanel = hasTabs || !!drawer.side;
  const showingPanel = tabState.paneOpen && hasLocalPanel;
  const workspace = (
    <div className={channelStyles.root}>
      <div ref={split.ref} style={split.style} className={channelStyles.board}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: pane file-drop fallback; the composer provides a keyboard-accessible picker. */}
        <div
          className={styles.work}
          data-attachment-drop-zone=""
          onDragOver={rejectUnhandledFileDrop}
          onDrop={rejectUnhandledFileDrop}
        >
          <SessionHeading channel={channel} parentName={parentName}>
            <ChannelMembersButton session={session} channelId={channel.id} />
            {drawer.launchers}
            <SessionShare
              session={session}
              channel={channel}
              direct
              signal={navigation?.signal}
              onShared={() => {
                if (navigation?.signal.aborted) return;
                const target = sessionLinkTarget(
                  `buzz://channel/${channel.id}`,
                  scope,
                  session.viewer,
                );
                if (target) void navigator?.open(target);
              }}
            />
            <MenuRoot>
              <MenuTrigger
                render={(props) => (
                  <IconButton
                    {...props}
                    size="toolbar"
                    aria-label="Session actions"
                    title="Session actions"
                    icon={<DotsThreeIcon size="1rem" aria-hidden="true" />}
                  />
                )}
              />
              <MenuPopup aria-label="Session actions" align="end">
                <MenuItem
                  disabled={
                    !!channel.readOnly || !session.channelDetails?.available
                  }
                  onClick={() => setRenameOpen(true)}
                >
                  <MenuIcon>
                    <PencilSimpleIcon size={16} />
                  </MenuIcon>
                  Rename
                </MenuItem>
                <MenuItem
                  disabled={!!channel.readOnly || !session.canvas.available}
                  onClick={() => setSettingsOpen(true)}
                >
                  <MenuIcon>
                    <GearIcon size={16} />
                  </MenuIcon>
                  Session settings…
                </MenuItem>
              </MenuPopup>
            </MenuRoot>
            {!showingPanel && (
              <span className={panelStyles.paneToggle}>
                <IconButton
                  ref={splitTrigger}
                  data-tab-pane-toggle=""
                  size="toolbar"
                  aria-label="Toggle tab pane"
                  title={showingPanel ? "Close tab pane" : "Open tab pane"}
                  aria-expanded={!!showingPanel}
                  icon={<SidebarRightIcon size="1rem" />}
                  disabled={!hasLocalPanel}
                  focusableWhenDisabled
                  onClick={() => tabState.setPaneOpen(!showingPanel)}
                />
              </span>
            )}
          </SessionHeading>
          {renameOpen && (
            <RenameSession
              key={channel.id}
              session={session}
              id={channel.id}
              name={channel.name}
              close={() => setRenameOpen(false)}
            />
          )}
          {settingsOpen && (
            <WorkspaceSettings
              key={channel.id}
              session={session}
              scope={scope}
              target={{ kind: "session", id: channel.id, name: channel.name }}
              close={() => setSettingsOpen(false)}
            />
          )}
          {placement.status !== "ready" && (
            <p role="status">{placement.error ?? "Loading Me placement…"}</p>
          )}
          {!inMe && placement.status === "ready" && (
            <div role="status">
              <p>This conversation is in Messages.</p>
              {navigator && (
                <Button
                  onClick={() => openLink(`buzz://channel/${channel.id}`)}
                >
                  Open in Messages
                </Button>
              )}
            </div>
          )}
          <SessionColumn enabled={false}>
            <MessageManagementStatus />
            <div className={styles.timeline}>
              {window.status === "error" &&
              !window.rows.length &&
              !recoveryShown ? (
                <div className={styles.empty} role="alert">
                  <p>{window.error}</p>
                  <Button
                    type="button"
                    onClick={() => session.channels.ensure(channel.id)}
                  >
                    Retry messages
                  </Button>
                </div>
              ) : window.status !== "ready" && !window.rows.length ? (
                <p className={styles.empty} role="status">
                  Loading messages…
                </p>
              ) : (
                <ChannelTimeline
                  historyControl="scroll"
                  extensions={extensions}
                  queries={session}
                  viewer={session.viewer}
                  scope={scope}
                  channelId={channel.id}
                  window={window}
                  revealMessageId={sent}
                  onOpenLink={openLink}
                  canOpenLink={canOpenLink}
                />
              )}
            </div>
            <MessageComposer
              sessionConversation
              activityClickOpensPanel
              personalConversation={placement.status !== "ready" || inMe}
              onSend={setSent}
              extensions={extensions}
              session={session}
              scope={scope}
              channelId={channel.id}
              channelName={channel.name}
              label="Message your agents"
              disabled={
                !!channel.archived ||
                window.status !== "ready" ||
                placement.status !== "ready"
              }
              onOpenLink={openLink}
              canOpenLink={canOpenLink}
            />
          </SessionColumn>
          {drawer.content}
        </div>
        <PanelDock
          open={!!companion || !!showingPanel}
          keepMounted={hasLocalPanel && !tabState.paneOpen}
          className={channelStyles.panelStack}
          resizeHandle={split.handle}
        >
          {hasTabs && (
            <div
              className={channelStyles.retainedPanel}
              hidden={!!companion && !showingPanel}
            >
              {secondary.drag.feedback}
              {secondary.hosts}
              <PanelWorkspace
                drag={secondary.drag.side}
                actions={
                  <IconButton
                    data-tab-pane-toggle=""
                    data-highlight-expanded="false"
                    variant="subtle"
                    size="toolbar"
                    aria-label="Toggle tab pane"
                    title="Close tab pane"
                    aria-expanded={true}
                    onClick={secondary.closePane}
                    icon={<SidebarRightIcon size="1rem" aria-hidden="true" />}
                  />
                }
                value={secondary.selectedTab}
                select={secondary.selectPanelTab}
                items={secondary.items}
                focusOnMount={continuing.current}
              />
            </div>
          )}
          {drawer.side && (
            <div
              className={channelStyles.retainedPanel}
              hidden={!!companion && !showingPanel}
            >
              {drawer.side}
            </div>
          )}
          {companion && (
            <div key="companion" className={channelStyles.companion}>
              {companion}
            </div>
          )}
        </PanelDock>
      </div>
    </div>
  );
  return (
    <MessageManagement session={session} channelId={channel.id}>
      {workspace}
    </MessageManagement>
  );
}

export function sessionLinkTarget(
  url: string,
  scope: string,
  viewer: string | undefined,
): ReturnType<typeof buzzLinkTarget> {
  if (!viewer || !isBuzzLink(url)) return null;
  return buzzLinkTarget(url, {
    viewer,
    communityOrigin: scope.slice(0, -(viewer.length + 1)),
  });
}
