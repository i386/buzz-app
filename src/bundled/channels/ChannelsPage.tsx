import { pendingSessionDraft } from "../../features/sessions/pending-start";
import type { Agents } from "../../features/agents/service";
import { NewSessionComposer } from "../../features/sessions/NewSessionComposer";
import { activityTarget } from "../../features/agents/activity-target";
import { useChannelNavigation } from "../../features/channel-navigation/ChannelNavigationState";
import { useConversationTabs } from "./useConversationTabs";
import tabStyles from "./ChannelTabs.module.css";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { useReturnHighlight } from "../../features/messages/use-return-highlight";
import { ChannelBody } from "./ChannelBody";
import { useChannelTabState } from "./useChannelTabState";
import { ChannelMembersDialog } from "./ChannelMembersDialog";
import { UsersIcon } from "../../shared/design-system/icons";
import { newSessionParent } from "../../features/channel-navigation/routes";
import { ChannelCanvasDialog } from "./ChannelCanvasDialog";
import { NewMessage } from "../../features/direct-messages/NewMessage";
import { Panel } from "../../shared/design-system/ui/Panel";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { ChannelHeaderMenu } from "./ChannelHeaderMenu";
import { ChannelSettingsPanel } from "./ChannelSettingsPanel";
import { ChannelJoinNotice } from "./ChannelJoinNotice";
import { ChannelLifecycleActions } from "./ChannelLifecycleActions";
import type { PageNavigation } from "../../features/navigation/service";
import type { Navigation } from "../../features/navigation/controller";
import {
  buzzLinkTarget,
  isBuzzLink,
  parseBuzzLink,
} from "../../features/navigation/buzz-links";
import { SessionMessageTarget } from "../../features/sessions/SessionMessageTarget";
import { SessionShare } from "../sessions/SessionShare";
import {
  SessionColumn,
  SessionHeading,
} from "../../features/sessions/SessionPresentation";
import { UnreadOptions } from "./UnreadBadge";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  SidebarRightIcon,
  PlugIcon,
  ChatCircleIcon,
  GearIcon,
} from "../../shared/design-system/icons/index";
import { channelIcon } from "../../features/channels/channel-icon";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import type { Panels } from "../../features/panels/service";
import type { PagesReader } from "../../features/pages/service";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
import { usePanelSplit } from "../../features/panels/usePanelSplit";
import { PanelDock } from "../../features/panels/PanelDock";
import { PanelFrame } from "../../features/panels/PanelFrame";
import { OutboxStatus } from "./OutboxStatus";
import { RelayTimings } from "./RelayTimings";
import { LiveStatus } from "./LiveStatus";
import { rejectUnhandledFileDrop } from "../../features/messages/use-file-drop";
import { MessageComposer } from "../../features/messages/MessageComposer";
import {
  MessageManagement,
  MessageManagementStatus,
} from "../../features/messages/MessageManagement";
import { MediaReviewViewer } from "../../features/messages/MediaReviewViewer";
import type { Attachment } from "../../features/relay/contracts";
import { readView, writeView, subscribeView } from "../../shared/view-state";
import { useChannelLabels } from "./useChannelLabels";
import { useComposerSent } from "./useComposerSent";
import { useSidebarPreferences } from "./useSidebarPreferences";
import styles from "./Channels.module.css";

export function ChannelsPage({
  extensions,
  relay,
  panels,
  pages,
  companion,
  navigation,
  navigator,
  agents,
}: {
  extensions?: ConversationExtensions | undefined;
  /** For adding a whole team of the owner's agents from the members dialog. */
  agents?: Agents | undefined;
  relay: RelayData;
  navigation?: PageNavigation | undefined;
  navigator?: Navigation | undefined;
  panels: Panels;
  pages: PagesReader;
  companion?: ReactNode;
}) {
  const session = useRelayConnection(relay);
  const registeredPages = useSyncExternalStore(
    pages.subscribe,
    pages.snapshot,
    pages.snapshot,
  );
  const sessionsEnabled = registeredPages.some(
    (page) => page.pluginId === "buzz.sessions",
  );
  const sessionNavigation = navigation?.forSession(relay, session);
  useEffect(() => {
    if (!navigation || !sessionNavigation) return;
    if (session.status === "disconnected" && navigation.target.kind === "page")
      sessionNavigation.complete({ status: "opened" });
    else if (session.status === "error" && !session.cached)
      sessionNavigation.complete({ status: "failed", reason: "unavailable" });
  }, [navigation, sessionNavigation, session.status, session.cached]);
  return (
    <section className={styles.root} aria-label="Channels">
      {session.status !== "ready" && !session.cached ? (
        <PanelFrame companion={companion}>
          <div className={styles.connect}>
            <div className={styles.connectIcon}>
              <PlugIcon size={30} />
            </div>
            <h1>Your channels, one conversation.</h1>
            <p>
              {session.status === "disconnected"
                ? "Use the left community rail to choose or add a community. Your profile and settings work without a community."
                : "Connection details and retry are in the sidebar. Your profile and settings work without a community."}
            </p>
          </div>
        </PanelFrame>
      ) : (
        <ChannelWorkspace
          extensions={extensions}
          key={`${session.scope ?? "disconnected"}:${session.generation}`}
          scope={session.scope ?? "disconnected"}
          cached={!!session.cached}
          queries={session.session}
          relay={relay}
          navigation={sessionNavigation}
          navigator={navigator}
          viewer={session.viewer}
          panels={panels}
          sessionsEnabled={sessionsEnabled}
          companion={companion}
          agents={agents}
        />
      )}
    </section>
  );
}

function ChannelWorkspace({
  extensions,
  queries,
  cached,
  relay,
  panels,
  scope,
  companion,
  navigation,
  navigator,
  viewer,
  agents,
}: {
  extensions?: ConversationExtensions | undefined;
  agents?: Agents | undefined;
  companion?: ReactNode;
  scope: string;
  navigation?: PageNavigation | undefined;
  navigator?: Navigation | undefined;
  viewer?: string | undefined;
  queries: RelaySession;
  cached: boolean;
  relay: RelayData;
  panels: Panels;
  sessionsEnabled: boolean;
}) {
  const composingMessage =
    navigation?.target.kind === "page" &&
    navigation.target.route?.params === "new-message";
  const list = useChannelList(queries.channels);
  const preferences = useSidebarPreferences(queries.sidebarPreferences);
  useEffect(() => {
    // Initial channel discovery cancels in-flight reads as it settles access.
    // Start the optional catalog afterward so opening Messages cannot strand it.
    if (list.status === "ready") queries.channelKit.ensure();
  }, [queries, list.status]);
  const [canvasOrigin, setCanvasOrigin] = useState<{
    channelId: string;
    navigation: PageNavigation | undefined;
  }>();
  const [composerFocus, setComposerFocus] = useState(0);
  // A visit applied by a header opening must not take that opening's focus.
  const [preservedVisit, setPreservedVisit] = useState<PageNavigation>();
  // A started join focuses the composer when membership makes it writable,
  // however that membership arrives. Opening another channel drops the intent.
  const [joiningChannel, setJoiningChannel] = useState<string>();
  const canvasTrigger = useRef<HTMLButtonElement>(null);
  const [membersChannel, setMembersChannel] = useState<string>();
  const membersTrigger = useRef<HTMLButtonElement>(null);
  const membersHeaderTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    void queries.emoji.ensure();
  }, [queries]);
  useEffect(() => {
    if (list.status === "ready") void queries.unread.ensure();
  }, [queries, list.status]);
  const available = useSyncExternalStore(
    panels.subscribe,
    panels.snapshot,
    panels.snapshot,
  );
  const [selected, setSelected] = useState<string | undefined>(() =>
    readView(scope, "selected-channel", undefined),
  );
  const handoff = useChannelNavigation();
  const draftParent =
    navigation?.target.kind === "page"
      ? newSessionParent(navigation.target.route?.params)
      : undefined;
  const clearPreparingDm = handoff?.clearPreparingDm;
  useEffect(() => {
    if (!composingMessage) clearPreparingDm?.();
    return () => clearPreparingDm?.();
  }, [composingMessage, clearPreparingDm]);
  const navigate = useCallback(
    (id: string) => {
      setSelected(id);
      writeView(scope, "selected-channel", id);
      if (navigator && viewer) {
        void navigator.open({
          version: 1,
          kind: "conversation",
          channelId: id,
          scope: {
            viewer,
            communityOrigin: scope.slice(0, -(viewer.length + 1)),
          },
        });
      }
    },
    [navigator, viewer, scope],
  );
  const select = useCallback(
    (id: string) => {
      navigate(id);
    },
    [navigate],
  );
  const threadTrigger = useRef<HTMLElement | null>(null);
  const [sent, setSent] = useState<{ channelId: string; id: string }>();
  const { channels, profiles } = useChannelLabels(
    list.channels,
    queries.profiles,
    queries.names,
  );
  const requestedChannel =
    draftParent ??
    (navigation?.target.kind === "conversation"
      ? navigation.target.channelId
      : undefined);
  const [resolved, setResolved] = useState<{
    request: PageNavigation;
    available: boolean;
  }>();
  const joinedRequest = list.channels.some(
    (channel) => channel.id === requestedChannel,
  );
  useEffect(() => {
    // Let initial membership discovery settle before resolving an omitted target.
    // A premature exact lookup publishes a one-channel list and starts readers
    // that the completing full roster then invalidates.
    if (
      cached ||
      !requestedChannel ||
      !navigation ||
      joinedRequest ||
      list.status === "idle" ||
      list.status === "loading" ||
      !queries.channels.resolve
    )
      return;
    const controller = new AbortController();
    void queries.channels
      .resolve([requestedChannel], {
        signal: AbortSignal.any([controller.signal, navigation.signal]),
        priority: "foreground",
      })
      .then(() => {
        if (!controller.signal.aborted && !navigation.signal.aborted)
          setResolved({ request: navigation, available: true });
      })
      .catch(() => {
        if (!controller.signal.aborted && !navigation.signal.aborted) {
          setResolved({ request: navigation, available: false });
          navigation.complete({ status: "failed", reason: "unavailable" });
        }
      });
    return () => controller.abort();
  }, [
    cached,
    requestedChannel,
    navigation,
    joinedRequest,
    queries,
    list.status,
  ]);
  const resolving =
    !!requestedChannel &&
    !joinedRequest &&
    !!queries.channels.resolve &&
    resolved?.request !== navigation;
  // Lifecycle completion must not reopen retained archived/hidden membership
  // through the mounted workspace's saved selection or first-channel fallback.
  const emptyDestination =
    navigation?.target.kind === "page" &&
    navigation.target.route?.params === "empty";
  const current = emptyDestination
    ? undefined
    : requestedChannel
      ? (channels.find((channel) => channel.id === requestedChannel) ??
        // Sidebar visibility is not access: retain a joined archived selection.
        list.channels.find((channel) => channel.id === requestedChannel) ??
        (resolved?.request === navigation && resolved?.available
          ? queries.channels.get?.(requestedChannel)
          : undefined))
      : (channels.find((channel) => channel.id === selected) ??
        channels.find((item) => item.channelType !== "session"));
  // Sidebar routing can update the same mounted page. Keep its saved default
  // aligned with the resolved conversation, not only page-local clicks.
  useEffect(() => {
    if (navigation?.target.kind !== "conversation" || !current) return;
    setSelected(current.id);
    writeView(scope, "selected-channel", current.id);
  }, [navigation?.target, current, scope]);
  useEffect(() => {
    if (!joiningChannel || !current) return;
    if (current.id !== joiningChannel) setJoiningChannel(undefined);
    else if (!current.readOnly) {
      setJoiningChannel(undefined);
      setComposerFocus((value) => value + 1);
    }
  }, [joiningChannel, current]);
  const CurrentChannelIcon = channelIcon(current);
  useEffect(() => {
    if (navigation?.signal.aborted) return;
    if (composingMessage) {
      navigation?.complete({ status: "opened" });
      return;
    }
    if (
      !cached &&
      requestedChannel &&
      !resolving &&
      list.status === "ready" &&
      !current
    )
      navigation?.complete({ status: "failed", reason: "unavailable" });
    if (!requestedChannel && !current && list.status === "ready")
      navigation?.complete({ status: "opened" });
    if (!requestedChannel && current && navigation && viewer) {
      // Resolve the saved default within this attempt, keeping its caller and deadline.
      navigation.resolve({
        version: 1,
        kind: "conversation",
        channelId: current.id,
        scope: {
          viewer,
          communityOrigin: scope.slice(0, -(viewer.length + 1)),
        },
      });
    }
  }, [
    cached,
    composingMessage,
    requestedChannel,
    resolving,
    current,
    list.status,
    navigation,
    viewer,
    scope,
  ]);
  const requestedMessage =
    navigation?.target.kind === "conversation"
      ? navigation.target.messageId
      : undefined;
  const requestedThread =
    navigation?.target.kind === "conversation"
      ? navigation.target.threadRootId
      : undefined;
  const membersRequested =
    navigation?.target.kind === "conversation" &&
    navigation.target.panel === "members";
  const membersOpen =
    (navigator ? membersRequested : membersChannel === current?.id) &&
    !!current &&
    current.channelType !== "session";
  useLayoutEffect(() => {
    // Sessions have no Members surface. Canonicalize an old/handwritten route
    // before a child reader can complete it, retaining its exact message address.
    if (
      !cached &&
      current &&
      !current.cached &&
      current.channelType === "session" &&
      navigation?.target.kind === "conversation" &&
      navigation.target.panel === "members" &&
      !navigation.signal.aborted
    ) {
      const { panel: _panel, ...target } = navigation.target;
      navigation.resolve(target);
    }
  }, [cached, current, navigation]);
  const currentId = current?.id;
  const pendingStart = useSyncExternalStore(
    useCallback((notify) => subscribeView(scope, notify), [scope]),
    () => (currentId ? pendingSessionDraft(scope, currentId) : undefined),
  );
  useEffect(() => {
    if (
      !pendingStart ||
      !current ||
      current.cached ||
      resolving ||
      navigation?.signal.aborted ||
      navigation?.target.kind !== "conversation"
    )
      return;
    // Recovery replaces the timeline, so it owns completion of the plain route.
    // An exact address cannot be claimed opened without revealing its message.
    navigation.complete(
      requestedMessage || requestedThread
        ? { status: "failed", reason: "unavailable" }
        : { status: "opened" },
    );
  }, [
    pendingStart,
    current,
    resolving,
    navigation,
    requestedMessage,
    requestedThread,
  ]);
  const canvasOpen =
    !!canvasOrigin &&
    canvasOrigin.channelId === currentId &&
    canvasOrigin.navigation === navigation &&
    !navigation?.signal.aborted;
  useEffect(() => {
    if (!canvasOpen) setCanvasOrigin(undefined);
  }, [canvasOpen]);
  useEffect(() => {
    setMembersChannel((id) => (id === currentId ? id : undefined));
  }, [currentId]);
  const setMembersOpen = (open: boolean) => {
    if (!navigator) {
      setMembersChannel(open ? currentId : undefined);
      return;
    }
    if (
      !navigation ||
      navigation.signal.aborted ||
      navigation.target.kind !== "conversation" ||
      navigation.target.channelId !== currentId ||
      navigator.snapshot().entry.id !== navigation.entryId
    )
      return;
    // A profile keeps this conversation; a DM already owns a different visit.
    // Modal cleanup must not overwrite that destination or its exact address.
    const { panel: _panel, ...target } = navigation.target;
    void navigator.open(open ? { ...target, panel: "members" } : target);
  };
  const openMembers = (trigger: HTMLButtonElement) => {
    membersTrigger.current = trigger;
    setMembersOpen(true);
  };
  const committedVisit = useRef<{
    currentId: string | undefined;
    queries: RelaySession;
  }>(undefined);
  const continuingVisit =
    committedVisit.current?.currentId === currentId &&
    committedVisit.current?.queries === queries;
  useLayoutEffect(() => {
    committedVisit.current = { currentId, queries };
  }, [currentId, queries]);
  const tabState = useChannelTabState(queries, currentId);
  const { settings, setSettings, retireMenuEntries } = tabState;
  useEffect(() => {
    if (!currentId || composingMessage || draftParent) return;
    // Retire this visit's reveal intent without discarding a new-DM handoff.
    return () => {
      setSent((previous) =>
        previous?.channelId === currentId ? undefined : previous,
      );
    };
  }, [currentId, composingMessage, draftParent]);

  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const [settingsFocus, requestSettingsFocus] = useState(0);
  const showingSettings =
    tabState.paneOpen &&
    !!settings &&
    settings.channelId === currentId &&
    tabState.selected === "settings";
  const closeSettings = () => {
    setSettings(undefined);
    afterClose("settings");
  };
  useEffect(() => {
    if (draftParent)
      navigation?.complete({ status: "failed", reason: "unavailable" });
  }, [draftParent, navigation]);
  const flatSession = current?.channelType === "session";
  const onComposerSend = useComposerSent(
    currentId,
    flatSession && !!requestedMessage,
    setSent,
    select,
  );
  const [exactOpening, setExactOpening] = useState<{
    request: PageNavigation;
    inTimeline: boolean;
  }>();
  useEffect(() => {
    if (
      cached ||
      current?.cached ||
      !navigation ||
      !requestedMessage ||
      (!flatSession && requestedThread === requestedMessage) ||
      !currentId ||
      navigation.signal.aborted
    )
      return;
    let selected = false;
    const choose = () => {
      if (selected || navigation.signal.aborted) return;
      const window = queries.channels.window(currentId);
      if (window.status === "idle" || window.status === "loading") return;
      selected = true;
      // Freeze the presentation for this attempt. An isolated lookup or later
      // live event must not move an already-opened thread into the timeline.
      setExactOpening({
        request: navigation,
        inTimeline:
          (flatSession || requestedThread !== requestedMessage) &&
          window.status === "ready" &&
          window.freshness !== "cached" &&
          window.rows.some(
            (row) =>
              row.id === requestedMessage && (flatSession || !row.threadRootId),
          ),
      });
    };
    const stop = queries.channels.subscribeWindow(currentId, choose);
    choose();
    return stop;
  }, [
    cached,
    current?.cached,
    navigation,
    requestedMessage,
    requestedThread,
    currentId,
    queries,
    flatSession,
  ]);
  // A live connection can still be confirming its restored membership. Keep
  // the pending intent; an exact reader cannot use display-only authority.
  const exact =
    cached || current?.cached
      ? undefined
      : !flatSession &&
          navigation &&
          requestedMessage &&
          requestedThread === requestedMessage
        ? { request: navigation, inTimeline: false }
        : exactOpening?.request === navigation
          ? exactOpening
          : undefined;
  // The route addresses a thread; its tab owns presentation, the route only
  // selects it and supplies the reveal request.
  const routedThread = useMemo(
    () =>
      !cached &&
      !flatSession &&
      current &&
      navigation &&
      requestedMessage &&
      exact &&
      !exact.inTimeline
        ? {
            channelId: current.id,
            messageId: requestedMessage,
            rootId: requestedThread ?? requestedMessage,
            navigation,
          }
        : undefined,
    [
      cached,
      flatSession,
      current,
      navigation,
      requestedMessage,
      requestedThread,
      exact,
    ],
  );
  const conversationIcon = (item: (typeof channels)[number]) => {
    const Icon = channelIcon(item);
    const person = item.participants?.[0];
    const picture = person ? profiles.get(person)?.picture : undefined;
    return item.channelType === "dm" ? (
      <span className={tabStyles.icon}>
        <Avatar
          alt=""
          fallback={item.name}
          size="fill"
          src={picture ? queries.media(picture) : null}
        />
      </span>
    ) : (
      <Icon size="1rem" />
    );
  };
  const channelConversation = useRef<HTMLDivElement>(null);
  const highlightReturn = useReturnHighlight(channelConversation, currentId);
  const returnFocus = useRef<
    { trigger: HTMLElement; channelId: string | undefined } | undefined
  >(undefined);
  useLayoutEffect(() => {
    const pending = returnFocus.current;
    if (!pending) return;
    if (pending.channelId !== currentId || !pending.trigger.isConnected) {
      returnFocus.current = undefined;
      return;
    }
    // The close commit gets one focus handoff, never a deferred request that
    // can override a later, unrelated tab selection.
    returnFocus.current = undefined;
    if (pending.trigger.closest('[inert], [hidden], [aria-hidden="true"]'))
      return;
    if (!document.querySelector('dialog[open], [aria-modal="true"]'))
      pending.trigger.focus({ preventScroll: true });
  });
  const secondary = useConversationTabs({
    state: tabState,
    relay,
    session: queries,
    panels,
    current,
    scope,
    channels,
    conversationIcon,
    extensions,
    leadingIds: settings ? ["settings"] : [],
    threadId: routedThread?.messageId,
    mainPane: true,
    routed: routedThread,
    onCloseThread: (tab, active) => {
      // Closing the addressed thread returns the route to its channel, so a
      // later Back/Forward visit is the only way to reopen it.
      if (
        routedThread?.channelId === tab.channelId &&
        routedThread.messageId === tab.messageId
      )
        select(tab.channelId);
      const trigger = threadTrigger.current;
      if (trigger) returnFocus.current = { trigger, channelId: currentId };
      if (active && tab.channelId === currentId) highlightReturn(tab.rootId);
    },
    onRetryNavigation: () => void navigator?.retry(),
    onOpenDrawer: () => setSettings(undefined),
    continuingVisit,
    navigationSignal: navigation?.signal,
    isLive: () => !destination.current.navigation?.signal.aborted,
    openLink: (url) => openLink(url, { fromThread: true }),
    fallbackFocus: settingsTrigger,
    eligible: (entry) =>
      !entry.panel.channelMenu ||
      !!(
        current &&
        current.id === entry.channelId &&
        !cached &&
        entry.panel.channelMenu.eligible(current, queries)
      ),
  });
  const {
    open,
    drawer,
    drawerContext,
    selectedTab,
    selectPanelTab,
    afterClose,
    panelTrigger,
    splitTrigger,
  } = secondary;
  useLayoutEffect(() => {
    // Navigation temporarily withdraws the old presentation while preparing
    // the next destination. That handoff must not dismiss saved thread tabs.
    if (!navigation || navigation.signal.aborted) return;
    if (draftParent || composingMessage) open(undefined);
    // Each visit is applied once: Back/Forward switch tabs, never close them,
    // and a closed tab is not reopened by a re-render of the same visit. A
    // message still resolving its placement waits rather than recording.
    if (routedThread || !requestedMessage || exact?.inTimeline) {
      tabState.enterVisit(
        `${navigation.entryId}:${routedThread ? "thread" : "channel"}`,
        routedThread,
      );
      if (navigation.focus === "preserve") setPreservedVisit(navigation);
    }
    const activity = handoff?.activityThread.current;
    if (
      activity &&
      activity.channelId === requestedChannel &&
      activity.messageId === requestedMessage &&
      activity.entryId === navigation?.entryId &&
      !activity.signal.aborted &&
      exact?.request === navigation
    ) {
      threadTrigger.current = activity.trigger;
      handoff.activityThread.current = undefined;
    }
    const activityAgent = handoff?.activityAgent.current;
    if (activityAgent && activityAgent.channelId === current?.id) {
      const target = activityTarget(
        activityAgent.agent,
        activityAgent.channelId,
      );
      const panel = panels.resolve(target);
      if (panel) {
        panelTrigger.current = activityAgent.trigger;
        open({ channelId: activityAgent.channelId, panel, target }, true);
      }
      handoff.activityAgent.current = undefined;
    }
  }, [
    draftParent,
    composingMessage,
    requestedMessage,
    navigation,
    requestedChannel,
    open,
    handoff?.activityThread,
    exact?.request,
    exact?.inTimeline,
    routedThread,
    tabState.enterVisit,
    handoff?.activityAgent,
    current?.id,
    panels,
    panelTrigger,
  ]);
  // Menu panels belong to one visit. Retire only this visit's keyed entries.
  useEffect(() => {
    if (!currentId) return;
    return () => retireMenuEntries();
  }, [currentId, retireMenuEntries]);
  const mounted = useRef(false);
  const channel = useRef(current?.id);
  useLayoutEffect(() => {
    channel.current = current?.id;
  }, [current?.id]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const openThread = useCallback(
    (messageId: string, threadRootId: string, intent?: "reply") => {
      if (!currentId) return;
      setSettings(undefined);
      threadTrigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      // Record where Back should return before this opening changes tabs.
      tabState.leaveVisit();
      // Retire transient details first; selecting the thread is the last word.
      open(undefined);
      // Every opening keeps existing work: a new thread adds a tab and an
      // open one is selected wherever it was placed.
      tabState.openThreadTab(currentId, messageId, threadRootId, intent);
      const target = navigator?.snapshot().entry.target;
      if (
        navigator &&
        viewer &&
        !(
          target?.kind === "conversation" &&
          target.channelId === currentId &&
          target.messageId === messageId &&
          target.threadRootId === threadRootId
        )
      )
        void navigator.open({
          version: 1,
          kind: "conversation",
          channelId: currentId,
          messageId,
          threadRootId,
          scope: {
            viewer,
            communityOrigin: scope.slice(0, -(viewer.length + 1)),
          },
        });
    },
    [
      currentId,
      navigator,
      viewer,
      scope,
      open,
      setSettings,
      tabState.openThreadTab,
      tabState.leaveVisit,
    ],
  );
  const mediaReviewTrigger = useRef<HTMLElement | null>(null);
  const [mediaReview, setMediaReview] = useState<{
    channelId: string;
    channelName: string;
    messageId: string;
    attachment: Attachment;
    initialTime: number;
    hasComments: boolean;
    entryId?: string | undefined;
  }>();
  // The current destination may be an authorized public preview, which is
  // intentionally absent from the joined-channel list.
  const showingMediaReview = current?.archived
    ? undefined
    : mediaReviewForDestination(mediaReview, current?.id, navigation?.entryId);
  useEffect(() => {
    if (mediaReview && !showingMediaReview) setMediaReview(undefined);
  }, [mediaReview, showingMediaReview]);
  // Timeline rows are memoized; their callbacks read the shown destination at
  // call time so a new navigation request does not rerender every row.
  const destination = useRef({ current, navigation });
  useLayoutEffect(() => {
    destination.current = { current, navigation };
  }, [current, navigation]);
  const openMediaReview = useCallback(
    (
      messageId: string,
      attachment: Attachment,
      initialTime: number,
      hasComments = false,
    ) => {
      const { current, navigation } = destination.current;
      if (!current) return;
      setSettings(undefined);
      mediaReviewTrigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setMediaReview({
        channelId: current.id,
        channelName: current.name,
        messageId,
        attachment,
        initialTime,
        hasComments,
        ...(navigation ? { entryId: navigation.entryId } : {}),
      });
    },
    [setSettings],
  );
  // Availability follows active contributions; dispatch still re-resolves at click time.
  const canOpenLink = useCallback(
    (target: string) =>
      available.some((candidate) => {
        try {
          return candidate.matches(target);
        } catch {
          return false;
        }
      }),
    [available],
  );
  const linkContext = useRef({
    channelId: currentId,
    routedThread: !!routedThread,
  });
  useLayoutEffect(() => {
    linkContext.current = {
      channelId: currentId,
      routedThread: !!routedThread,
    };
  }, [currentId, routedThread]);
  const openLink = useCallback(
    (
      url: string,
      {
        fromThread = false,
        returnFocus,
        rootId,
      }: {
        fromThread?: boolean;
        returnFocus?: HTMLElement | undefined;
        rootId?: string;
      } = {},
    ) => {
      const { current, navigation } = destination.current;
      const connection = relay.snapshot();
      if (
        !mounted.current ||
        channel.current !== current?.id ||
        connection.status !== "ready" ||
        connection.session !== queries ||
        navigation?.signal.aborted
      )
        return false;
      const parsed = parseBuzzLink(url);
      const linkedSession =
        parsed?.format === "legacy" &&
        !parsed.messageId &&
        queries.channels
          .list()
          .channels.find(
            (item) =>
              item.id === parsed.channelId &&
              item.channelType === "session" &&
              !item.cached &&
              !item.readOnly &&
              !item.archived &&
              item.members?.includes(queries.viewer ?? ""),
          );
      if (linkedSession && linkedSession.id !== current?.id) {
        const id = `conversation:${linkedSession.id}`;
        tabState.setTabs((tabs) =>
          tabs.some((tab) => tab.id === id)
            ? tabs
            : [
                ...tabs,
                { id, kind: "conversation", channelId: linkedSession.id },
              ],
        );
        tabState.select(id);
        return true;
      }
      if (isBuzzLink(url) && navigator && viewer) {
        const target = buzzLinkTarget(url, {
          viewer,
          communityOrigin: scope.slice(0, -(viewer.length + 1)),
        });
        // Internal panel targets also use buzz:. Only routable links belong
        // to the navigator; registered panels handle the remaining targets.
        if (target) {
          if (target.kind === "conversation" && target.messageId) {
            tabState.leaveVisit();
            threadTrigger.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
          }
          open(undefined);
          void navigator.open(target);
          return true;
        }
      }
      const candidate = panels.resolve(url);
      const context = linkContext.current;
      if (context.channelId && candidate) {
        setSettings(undefined);
        panelTrigger.current =
          returnFocus ??
          (document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null);
        // Thread-origin details cover the live thread instead of retiring it.
        if (!fromThread && context.routedThread) select(context.channelId);
        open(
          {
            channelId: context.channelId,
            ...(rootId && { rootId }),
            panel: candidate,
            target: url,
          },
          fromThread,
        );
        return true;
      }
      return false;
    },
    [
      panels,
      open,
      relay,
      queries,
      select,
      navigator,
      viewer,
      scope,
      setSettings,
      tabState,
      panelTrigger,
    ],
  );
  const hasChannelPanel =
    !composingMessage &&
    (settings || secondary.items.length > 0 || drawer.side);
  const hasPanel = companion || hasChannelPanel;
  const showingChannelPanel = tabState.paneOpen && hasChannelPanel;
  const showingPanel = companion || showingChannelPanel;
  const split = usePanelSplit();
  useEffect(() => {
    // Only an explicit settings click moves focus; restoring a visit does not.
    if (settingsFocus)
      split.ref.current
        ?.querySelector<HTMLElement>(
          '[data-panel-workspace] [data-tab-value="settings"]',
        )
        ?.focus({ preventScroll: true });
  }, [settingsFocus, split.ref]);
  const openCanvas = (trigger: HTMLButtonElement) => {
    canvasTrigger.current = trigger;
    if (currentId && !navigation?.signal.aborted)
      setCanvasOrigin({ channelId: currentId, navigation });
  };
  const settingsContent = (
    <ChannelSettingsPanel
      scope={scope}
      {...(current?.channelType !== "session" ? { openMembers } : {})}
      key={settings?.id}
      setupTools={
        current &&
        handoff &&
        !current.readOnly &&
        current.channelType !== "dm" && (
          <ChannelLifecycleActions
            key={`${current.id}:${!!current.archived}`}
            channelId={current.id}
            lifecycle={queries.channelLifecycle}
            choose={(action, trigger) =>
              handoff.openLifecycle(current, action, trigger)
            }
          />
        )
      }
      channel={current}
      details={queries.channelDetails}
      close={closeSettings}
    >
      <UnreadOptions session={queries} channelId={current?.id} />
      <LiveStatus
        live={queries.live}
        channelId={current?.id}
        partialRoster={list.coverage === "partial"}
        diagnostics
      />
      <p>
        {list.coverage === "partial" ? "Partial roster" : "Roster"} ·{" "}
        {channels.length} channels
      </p>
      <Button type="button" onClick={() => queries.channels.refreshList?.()}>
        Refresh channels
      </Button>
      {preferences.error && <p>Saved groups and stars: {preferences.error}</p>}
      {preferences.status !== "unsupported" && (
        <Button
          type="button"
          disabled={preferences.status === "loading"}
          onClick={preferences.reload}
        >
          Refresh groups and stars
        </Button>
      )}
      {current && (
        <Button
          type="button"
          onClick={() => queries.channels.refresh?.(current.id)}
        >
          Refresh messages
        </Button>
      )}
      {queries.outbox ? (
        <OutboxStatus outbox={queries.outbox} profiling={queries.profiling} />
      ) : (
        <RelayTimings profiling={queries.profiling} />
      )}
    </ChannelSettingsPanel>
  );
  // The channel conversation: a session column, or the first main-pane tab.
  const body = (
    <SessionColumn enabled={flatSession}>
      <MessageManagementStatus />
      {flatSession &&
      current &&
      navigation &&
      requestedMessage &&
      exact &&
      !exact.inTimeline ? (
        <SessionMessageTarget
          key={`${current.id}:${requestedMessage}`}
          session={queries}
          scope={scope}
          channelId={current.id}
          messageId={requestedMessage}
          navigation={navigation}
          extensions={extensions}
          onOpenLink={openLink}
          canOpenLink={canOpenLink}
          onLatest={() => select(current.id)}
          onRetry={() => {
            void navigator?.retry();
          }}
        />
      ) : current ? (
        <ChannelBody
          viewer={viewer}
          extensions={extensions}
          key={current.id}
          queries={queries}
          scope={scope}
          channelId={current.id}
          cached={cached}
          navigation={
            flatSession || !requestedMessage || exact?.inTimeline
              ? navigation
              : undefined
          }
          onOpenLink={openLink}
          canOpenLink={canOpenLink}
          onOpenThread={flatSession ? undefined : openThread}
          onOpenMediaReview={openMediaReview}
          revealMessageId={sent?.channelId === current.id ? sent.id : undefined}
        />
      ) : (
        <div
          className={styles.empty}
          data-buzz-launch-pending={
            resolving && !navigation?.signal.aborted ? "required" : undefined
          }
        >
          {resolving
            ? "Checking conversation access…"
            : "Select a channel to read it."}
        </div>
      )}
      {current?.readOnly && !current.cached && (
        <ChannelJoinNotice
          key={`join:${current.id}`}
          channelId={current.id}
          lifecycle={queries.channelLifecycle}
          joinable={
            !current.archived &&
            (current.channelType === "stream" ||
              current.channelType === "forum")
          }
          onJoin={() => setJoiningChannel(current.id)}
        />
      )}
      {!cached && (
        <LiveStatus
          live={queries.live}
          channelId={current?.id}
          partialRoster={list.coverage === "partial"}
          // Retry removes this focused control. Reuse the composer’s
          // explicit focus handoff instead of relying on browser Tab memory.
          onRetry={
            current ? () => setComposerFocus((value) => value + 1) : undefined
          }
        />
      )}
      {current && (
        <MessageComposer
          sessionConversation={current.channelType === "session"}
          extensions={extensions}
          key={`composer:${current.id}`}
          session={queries}
          scope={scope}
          channelId={current.id}
          channelName={current.name}
          autoFocus={
            // The bound request arrives after the composer's first render.
            (navigation?.focus ?? navigator?.snapshot().attempt.focus) !==
              "preserve" &&
            !current.readOnly &&
            !requestedMessage &&
            !requestedThread
          }
          onOpenLink={openLink}
          canOpenLink={canOpenLink}
          label={
            current.channelType === "session"
              ? "Message this session"
              : undefined
          }
          onSend={onComposerSend}
          focusRequest={composerFocus}
        />
      )}
    </SessionColumn>
  );
  const workspace = (
    <div ref={split.ref} style={split.style} className={styles.board}>
      {current && membersOpen && (
        <ChannelMembersDialog
          key={current.id}
          session={queries}
          channelId={current.id}
          close={() => setMembersOpen(false)}
          trigger={
            membersTrigger.current?.isConnected
              ? membersTrigger
              : membersHeaderTrigger
          }
          canOpenLink={canOpenLink}
          {...(agents ? { agents } : {})}
          onOpenLink={(url, returnFocus) => openLink(url, { returnFocus })}
          onOpenConversation={
            navigator && viewer
              ? (id) => openLink(`buzz://channel/${encodeURIComponent(id)}`)
              : undefined
          }
        />
      )}
      {current && !current.readOnly && canvasOpen && (
        <ChannelCanvasDialog
          key={`${scope}:${current.id}`}
          canvas={queries.canvas}
          profiles={queries.profiles}
          scope={scope}
          channelId={current.id}
          open={canvasOpen}
          onOpenChange={(open) => {
            if (!open) setCanvasOrigin(undefined);
          }}
          finalFocus={canvasTrigger}
        />
      )}
      <Panel as="article" aria-label="Conversation">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: file-drop fallback; the composer also provides a keyboard-accessible picker. */}
        <div
          className={`${styles.conversation}${flatSession ? ` ${styles.sessionConversation}` : ""}`}
          data-attachment-drop-zone=""
          onDragOver={rejectUnhandledFileDrop}
          onDrop={rejectUnhandledFileDrop}
        >
          {composingMessage ? (
            <NewMessage
              session={queries}
              scope={scope}
              extensions={extensions}
              onPreparing={(pubkeys) => handoff?.prepareDm(pubkeys)}
              onOpened={(channelId) => {
                handoff?.clearPreparingDm();
                select(channelId);
              }}
              onStarted={(channelId, id) => {
                handoff?.clearPreparingDm();
                setSent({ channelId, id });
                select(channelId);
              }}
            />
          ) : pendingStart && currentId ? (
            <NewSessionComposer
              key={pendingStart}
              personal={pendingStart === "me" || pendingStart.startsWith("me:")}
              standalone
              resumeDraftKey={pendingStart}
              sectionId={
                pendingStart.includes(":section:")
                  ? pendingStart.split(":section:")[1]
                  : undefined
              }
              session={queries}
              scope={scope}
              extensions={extensions}
              onStarted={select}
            />
          ) : draftParent ? (
            <p role="status" className={styles.empty}>
              Start new conversations from Me. Channel-nested sessions are no
              longer available.
            </p>
          ) : (
            <>
              {current?.channelType === "session" ? (
                <SessionHeading
                  channel={current}
                  actions={
                    <ChannelHeaderMenu
                      key={`channel-actions:${current.id}`}
                      channel={current}
                      session={queries}
                      origin={navigation?.signal}
                      trigger={settingsTrigger}
                      openDetails={() => {
                        drawer.close();
                        requestSettingsFocus((value) => value + 1);
                        setSettings({ channelId: current.id });
                      }}
                      openCanvas={openCanvas}
                    />
                  }
                >
                  <SessionShare
                    key={`${current.id}:${navigation?.entryId ?? ""}`}
                    session={queries}
                    channel={current}
                    signal={navigation?.signal}
                  />
                </SessionHeading>
              ) : null}
              {current?.channelType === "session" ? (
                body
              ) : (
                <div className={styles.mainWorkspace}>
                  <PanelWorkspace
                    main
                    drag={secondary.drag.main}
                    label="Channel tabs"
                    focusOnMount={false}
                    adoptSelection={preservedVisit}
                    value={secondary.selectedMain}
                    select={(id) =>
                      tabState.selectMain(
                        id === "conversation" ? undefined : id,
                      )
                    }
                    actions={
                      <>
                        {current && (
                          <IconButton
                            size="sm"
                            aria-label="Channel members"
                            title="Channel members"
                            aria-haspopup="dialog"
                            ref={membersHeaderTrigger}
                            aria-expanded={membersOpen}
                            onClick={(event) =>
                              openMembers(event.currentTarget)
                            }
                            icon={<UsersIcon size="1rem" aria-hidden="true" />}
                          />
                        )}
                        {drawer.launchers}
                        <ChannelHeaderMenu
                          key={`channel-actions:${currentId ?? "empty"}`}
                          channel={current}
                          session={queries}
                          origin={navigation?.signal}
                          trigger={settingsTrigger}
                          openDetails={() => {
                            drawer.close();
                            requestSettingsFocus((value) => value + 1);
                            setSettings({ channelId: currentId });
                          }}
                          openCanvas={openCanvas}
                          menuPanels={
                            current && !cached
                              ? available.filter((panel) =>
                                  panel.channelMenu?.eligible(current, queries),
                                )
                              : []
                          }
                          openMenuPanel={(panel) => {
                            const connection = relay.snapshot();
                            const channel = queries.channels
                              .list()
                              .channels.find((item) => item.id === currentId);
                            if (
                              connection.status !== "ready" ||
                              connection.cached ||
                              connection.session !== queries ||
                              !drawerContext ||
                              drawerContext.channelId !== channel?.id ||
                              !channel ||
                              channel.cached ||
                              channel.readOnly ||
                              !channel.members?.includes(
                                queries.viewer ?? "",
                              ) ||
                              !panels.snapshot().includes(panel) ||
                              !panel.channelMenu?.eligible(channel, queries)
                            )
                              return;
                            drawer.close();
                            panelTrigger.current = settingsTrigger.current;
                            open(
                              {
                                panel,
                                channelId: channel.id,
                                target: channel.id,
                                channelContext: drawerContext,
                              },
                              true,
                            );
                          }}
                        />
                        {current && (
                          <IconButton
                            ref={splitTrigger}
                            data-tab-pane-toggle=""
                            size="toolbar"
                            aria-label="Toggle tab pane"
                            title={
                              showingChannelPanel
                                ? "Close tab pane"
                                : "Open tab pane"
                            }
                            aria-expanded={!!showingChannelPanel}
                            disabled={!hasChannelPanel}
                            focusableWhenDisabled
                            onClick={() =>
                              tabState.setPaneOpen(!showingChannelPanel)
                            }
                            icon={
                              <SidebarRightIcon
                                size="1rem"
                                aria-hidden="true"
                              />
                            }
                          />
                        )}
                      </>
                    }
                    items={[
                      {
                        id: "conversation",
                        label: current?.name ?? "Channels",
                        icon:
                          current?.channelType === "dm" ? (
                            <ChatCircleIcon size="1rem" />
                          ) : (
                            <CurrentChannelIcon size="1rem" />
                          ),
                        content: (
                          <div
                            ref={channelConversation}
                            className={styles.conversation}
                          >
                            {body}
                          </div>
                        ),
                      },
                      ...secondary.mainItems,
                    ]}
                  />
                </div>
              )}
              {drawer.content}
            </>
          )}
        </div>
      </Panel>
      {showingMediaReview && (
        <MediaReviewViewer
          extensions={extensions}
          attachment={showingMediaReview.attachment}
          session={queries}
          scope={scope}
          channelId={showingMediaReview.channelId}
          channelName={showingMediaReview.channelName}
          messageId={showingMediaReview.messageId}
          initialTime={showingMediaReview.initialTime}
          hasComments={showingMediaReview.hasComments}
          restoreFocus={mediaReviewTrigger}
          onOpenLink={openLink}
          close={() => setMediaReview(undefined)}
        />
      )}
      {secondary.drag.feedback}
      {secondary.hosts}
      <p role="status" className="sr-only">
        {secondary.announcement}
      </p>
      <PanelDock
        open={!!showingPanel && !showingMediaReview}
        keepMounted={!!hasPanel && !tabState.paneOpen}
        className={styles.panelStack}
        resizeHandle={split.handle}
      >
        {hasPanel && !showingMediaReview && (
          <>
            {hasChannelPanel && (settings || secondary.items.length > 0) && (
              <div
                className={styles.retainedPanel}
                hidden={!!companion && !showingChannelPanel}
              >
                <PanelWorkspace
                  key={currentId}
                  drag={secondary.drag.side}
                  value={selectedTab}
                  focusOnMount={
                    !membersOpen && (continuingVisit || !!routedThread)
                  }
                  select={selectPanelTab}
                  items={[
                    ...(settings
                      ? [
                          {
                            id: "settings",
                            label: "Channel settings",
                            icon: <GearIcon size="1rem" />,
                            close: closeSettings,
                            content: settingsContent,
                          },
                        ]
                      : []),
                    ...secondary.items,
                  ]}
                />
              </div>
            )}
            {hasChannelPanel && drawer.side && (
              <div
                className={styles.retainedPanel}
                hidden={
                  showingSettings || (!!companion && !showingChannelPanel)
                }
              >
                {drawer.side}
              </div>
            )}
            {companion && (
              <div key="companion" className={styles.companion}>
                {companion}
              </div>
            )}
          </>
        )}
      </PanelDock>
    </div>
  );
  return (
    <MessageManagement session={queries} channelId={currentId}>
      {workspace}
    </MessageManagement>
  );
}

export function mediaReviewForDestination<
  T extends { channelId: string; entryId?: string | undefined },
>(
  review: T | undefined,
  channelId: string | undefined,
  entryId: string | undefined,
): T | undefined {
  return review &&
    review.channelId === channelId &&
    (review.entryId === undefined || review.entryId === entryId)
    ? review
    : undefined;
}
