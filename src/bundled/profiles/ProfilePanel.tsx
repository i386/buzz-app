import { activityTarget } from "../../features/agents/activity-target";
import { PanelView } from "../../features/panels/PanelView";
import { contributionKey } from "../../features/conversation/ContributionBoundary";
import type { Panels, RegisteredPanel } from "../../features/panels/service";
import {
  usePanelTabHost,
  usePanelTabTitle,
} from "../../features/panels/PanelWorkspace";
import { useAgentOwnerEvidence } from "../../features/profiles/useAgentOwnerEvidence";
import { UserStatusDisplay } from "../../features/user-status/StatusDisplay";
import { ProfilePublicMetadata } from "./ProfilePublicMetadata";
import { relayOrigin } from "../../features/communities/destination";
import type { Navigation } from "../../features/navigation/controller";
import { ProfileChannels } from "./ProfileChannels";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import { usePresenceStatus } from "../../features/presence/react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { CopyIcon } from "../../shared/design-system/icons/index";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { AgentAvatar } from "../../features/agents/AgentAvatar";
import { useKnownAgentPubkeys } from "../../features/agents/use-known";
import { Button } from "../../shared/design-system/ui/Button";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { ProfileActivity } from "./ProfileActivity";
import type { PanelProps } from "../../features/panels/service";
import {
  profileActivityViewKey,
  profileAgentHint,
  profilePanelKey,
  profileTarget,
} from "../../features/profiles/target";
import { formatPublicKey } from "../../shared/identity/public-key";
import { selectProfiles } from "../../features/relay/profile-selection";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { ProfileAgentIdentity } from "./ProfileAgentIdentity";
import styles from "./Profiles.module.css";
import { AgentDelete } from "../../features/agents/AgentManage";
import { useAgent, useChannelChoices } from "../../features/agents/react";
import type { Agents } from "../../features/agents/service";
import { agentSections } from "../../features/agents/tabs";
import { useAgentSettingsHost } from "../agents/AgentSettingsHost";

const noSubscribe = () => () => {};
const emptyPanels: readonly RegisteredPanel[] = [];
const noPanels = () => emptyPanels;
const emptyAgentTypes = Object.freeze([]);

export function ProfilePanel({
  panels,
  relay,
  target,
  context,
  navigation,
  agents,
  close,
}: PanelProps & {
  panels?: Panels;
  relay: RelayData;
  navigation?: Navigation;
  /** Agents show their type's tabs. */
  agents?: Agents;
}) {
  const connection = useRelayConnection(relay);
  const activityKey = profileActivityViewKey(target);
  const pubkey = profilePanelKey(target) ?? activityKey;
  if (!pubkey) return <p>Unsupported profile.</p>;
  if (connection.status !== "ready")
    return <p>Connect to a community to view this profile.</p>;
  return (
    <ProfileDetails
      key={`${connection.scope}:${connection.generation}:${pubkey}:${activityKey ? "activity" : "info"}`}
      initialTab={activityKey ? "activity" : "info"}
      panels={panels}
      session={connection.session}
      pubkey={pubkey}
      agentHint={profileAgentHint(target) || !!activityKey}
      context={context}
      navigation={navigation}
      agents={agents}
      scope={connection.scope}
      viewer={connection.viewer}
      close={close}
    />
  );
}
function ProfileDetails({
  panels,
  initialTab,
  agentHint,
  session,
  pubkey,
  context,
  navigation,
  agents,
  scope,
  viewer,
  close,
}: {
  agents: Agents | undefined;
  panels: Panels | undefined;
  initialTab: "info" | "activity";
  agentHint: boolean;
  session: RelaySession;
  pubkey: string;
  context: PanelProps["context"];
  navigation: Navigation | undefined;
  scope: string | undefined;
  viewer: string | undefined;
  close(): void;
}) {
  const selection = useMemo(
    () => selectProfiles(session.profiles, [pubkey]),
    [session.profiles, pubkey],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const profile = profiles.get(pubkey);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [attempt, retry] = useState(0);
  const [copyStatus, setCopyStatus] = useState("");
  const [tab, setTab] = useState<
    "info" | "activity" | "channels" | `agent:${string}`
  >(initialTab);
  // An agent's sections come from its type and the app, not the harness.
  const plugin = useAgent(agents, pubkey);
  const agentTypes = useSyncExternalStore(
    agents?.subscribe ?? noSubscribe,
    agents?.types ?? (() => emptyAgentTypes),
    () => emptyAgentTypes,
  );
  const settings = useAgentSettingsHost({
    agents,
    agent: plugin?.agent,
    type: plugin?.type,
    types: agentTypes,
  });
  const channelChoices = useChannelChoices(
    plugin ? session.channels : undefined,
  );
  const available = useSyncExternalStore(
    panels?.subscribe ?? noSubscribe,
    panels?.snapshot ?? noPanels,
    noPanels,
  );
  const sections =
    settings.agent && agents
      ? agentSections({
          agents,
          agent: settings.agent,
          type: settings.type,
          channels: channelChoices,
          conversation: context && {
            channelId: context.channelId,
            ...(context.rootId && { rootId: context.rootId }),
          },
          ...(settings.settingsHost
            ? { settingsHost: settings.settingsHost }
            : {}),
        })
      : [];
  // Opened for activity, a plugin agent shows its type's own first tab (its
  // sessions) until the reader picks a tab; harness agents keep Activity.
  const [activityRequested, setActivityRequested] = useState(
    initialTab === "activity",
  );
  const requestedTab =
    activityRequested && tab === "activity" && sections[0]
      ? sections[0].value
      : tab;
  const section = sections.find((item) => item.value === requestedTab);
  const activity = activityTarget(pubkey, context?.channelId);
  const resolvedActivity = panels?.resolve(activity);
  const activityPanel =
    resolvedActivity &&
    available.includes(resolvedActivity) &&
    context?.canOpen(activity)
      ? resolvedActivity
      : undefined;
  const tabHost = usePanelTabHost();
  const tabbed = !!tabHost;
  const region = useRef<HTMLElement>(null);
  const messageAttempt = useRef<AbortController>(undefined);
  const [openingMessage, setOpeningMessage] = useState(false);
  const [messageError, setMessageError] = useState("");
  useEffect(() => {
    if (!tabbed) region.current?.focus();
    // Target, viewer and community changes remount this view (see key above).
    return () => messageAttempt.current?.abort();
  }, [tabbed]);
  // Each target/session owns this completion; shared data work remains session-owned.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is explicit recovery.
  useEffect(() => {
    let active = true;
    setStatus("loading");
    void session.profiles.ensure([pubkey]).then(
      () => {
        if (active) setStatus("ready");
      },
      () => {
        if (active) setStatus("error");
      },
    );
    return () => {
      active = false;
    };
  }, [session, pubkey, attempt]);
  const agentPubkeys = useKnownAgentPubkeys(session, profiles);
  const presence = usePresenceStatus(session.presence, pubkey, true);
  const knownAgent = agentPubkeys.has(pubkey);
  // Navigation can conservatively identify an agent; it grants no private control.
  const displayAgent = knownAgent || agentHint;
  const ownership = useAgentOwnerEvidence(
    session,
    knownAgent ? pubkey : undefined,
    attempt,
  );
  const verifiedOwner = ownership.owner;
  useEffect(() => {
    if (!activityPanel && !sections.length)
      setTab((current) => (current === "activity" ? "info" : current));
  }, [activityPanel, sections.length]);
  const selectedTab =
    (requestedTab === "activity" && !activityPanel) ||
    (requestedTab.startsWith("agent:") && !section)
      ? "info"
      : requestedTab;
  let communityOrigin: string | undefined;
  if (scope && viewer && scope.endsWith(`:${viewer}`)) {
    try {
      communityOrigin = relayOrigin(scope.slice(0, -(viewer.length + 1)));
    } catch {
      // This session has no usable navigation scope.
    }
  }
  const npub = profileTarget(pubkey)?.slice(6) ?? pubkey;
  const identityName = useChannelIdentityNames(session, context?.channelId);
  const name = identityName(
    pubkey,
    profile?.name ??
      (displayAgent ? "Unknown agent" : (formatPublicKey(pubkey) ?? pubkey)),
  );
  const picture = profile?.picture
    ? (session.media(profile.picture) ?? null)
    : null;
  const tabAvatar = useMemo(
    () => (
      <Avatar
        src={picture}
        alt=""
        fallback={name}
        size="fill"
        shape={knownAgent ? "squircle" : "circle"}
      />
    ),
    [picture, name, knownAgent],
  );
  usePanelTabTitle(name, tabAvatar);
  // As in New message, a known agent needs this community's ready native control.
  const messageable = () =>
    !displayAgent ||
    session.agentChoices
      .snapshot()
      .identities.some((agent) => agent.managed && agent.pubkey === pubkey);
  const canMessage =
    session.directMessages.available &&
    !!navigation &&
    !!viewer &&
    !!communityOrigin &&
    viewer !== pubkey &&
    messageable();
  async function openMessage() {
    if (
      messageAttempt.current ||
      !navigation ||
      !viewer ||
      !communityOrigin ||
      !messageable()
    )
      return;
    const controller = new AbortController();
    messageAttempt.current = controller;
    setOpeningMessage(true);
    setMessageError("");
    try {
      const channelId = await session.directMessages.open(
        [pubkey],
        controller.signal,
      );
      if (controller.signal.aborted) return;
      void navigation.open({
        version: 1,
        kind: "conversation",
        channelId,
        scope: { viewer, communityOrigin },
      });
    } catch (reason) {
      if (!controller.signal.aborted)
        setMessageError(
          reason instanceof Error
            ? reason.message
            : "Could not open the conversation. Try again.",
        );
    } finally {
      messageAttempt.current = undefined;
      if (!controller.signal.aborted) setOpeningMessage(false);
    }
  }
  return (
    <section
      ref={region}
      data-buzz-ui=""
      aria-label="Profile details"
      tabIndex={-1}
      className={styles.root}
    >
      <div className={styles.profileContents}>
        <div className={styles.identity}>
          <div className={styles.portrait}>
            <AgentAvatar
              session={session}
              agentPubkey={pubkey}
              channelId={context?.channelId}
              src={picture}
              alt={`${name} avatar`}
              fallback={name}
              size="fill"
              shape={displayAgent ? "squircle" : "circle"}
              statusBadge={presence === "unknown" ? undefined : presence}
            />
          </div>
          <div className="min-w-0">
            <h2 className="text-heading">{name}</h2>
            {presence !== "unknown" && (
              <p className="text-body-sm text-secondary">
                {
                  { online: "Active", away: "Away", offline: "Offline" }[
                    presence
                  ]
                }
              </p>
            )}
          </div>
        </div>
        <Tabs
          value={selectedTab}
          onValueChange={(value) => {
            setActivityRequested(false);
            setTab(value);
          }}
          items={[
            { value: "info", label: "Info" },
            ...sections.map(({ value, label }) => ({ value, label })),
            { value: "channels", label: "Channels" },
            ...(displayAgent && activityPanel
              ? [{ value: "activity" as const, label: "Activity" }]
              : []),
          ]}
          label="Profile sections"
          variant="panel"
          renderPanel={(selected) => (
            <div className={styles.tabContent}>
              {selected === "activity" && activityPanel ? (
                <PanelView
                  key={contributionKey(activityPanel)}
                  panel={activityPanel}
                  target={activity}
                  context={context}
                  close={close}
                />
              ) : selected.startsWith("agent:") ? (
                sections.find((item) => item.value === selected)?.render()
              ) : selected === "info" ? (
                <>
                  <UserStatusDisplay session={session} userId={pubkey} />
                  {canMessage && (
                    <div>
                      <Button
                        size="compact"
                        loading={openingMessage}
                        onClick={() => void openMessage()}
                      >
                        Message
                      </Button>
                      {messageError && <p role="alert">{messageError}</p>}
                    </div>
                  )}
                  {profile?.about && (
                    <p className={styles.about}>{profile.about}</p>
                  )}
                  {plugin && agents && plugin.agent.place !== "elsewhere" && (
                    <div>
                      <AgentDelete
                        agents={agents}
                        agent={plugin.agent}
                        onRemoved={close}
                      />
                    </div>
                  )}
                  {knownAgent && (
                    <ProfileActivity
                      onViewActivity={
                        activityPanel ? () => setTab("activity") : undefined
                      }
                      session={session}
                      pubkey={pubkey}
                      context={context}
                    />
                  )}
                  <div className={styles.publicKey}>
                    <div className={styles.keyHeading}>
                      <h3 className="text-body">Public key</h3>
                      <Button
                        size="compact"
                        variant="ghost"
                        aria-label="Copy npub"
                        onClick={() => {
                          setCopyStatus("");
                          void Promise.resolve()
                            .then(() => navigator.clipboard.writeText(npub))
                            .then(
                              () => setCopyStatus("Public key copied."),
                              () =>
                                setCopyStatus(
                                  "Could not copy. Select the public key above to copy it.",
                                ),
                            );
                        }}
                      >
                        <CopyIcon size={16} aria-hidden="true" />
                        Copy
                      </Button>
                    </div>
                    <code className="font-mono text-mono">{npub}</code>
                    <span role="status" className={styles.feedback}>
                      {copyStatus}
                    </span>
                  </div>
                  {knownAgent && verifiedOwner && (
                    <ProfileAgentIdentity
                      session={session}
                      owner={verifiedOwner}
                      viewer={viewer}
                      context={context}
                    />
                  )}
                  <ProfilePublicMetadata nip05={profile?.nip05} />
                  {!profile &&
                    (status === "loading" ? (
                      <p role="status">Loading profile…</p>
                    ) : (
                      <p role={status === "error" ? "alert" : undefined}>
                        {status === "error"
                          ? "Could not load this profile."
                          : "No profile metadata is available in this community."}
                      </p>
                    ))}
                  {((!profile && status !== "loading") || ownership.failed) && (
                    <Button
                      size="compact"
                      onClick={() => retry((value) => value + 1)}
                    >
                      Retry profile
                    </Button>
                  )}
                </>
              ) : (
                <ProfileChannels
                  session={session}
                  pubkey={pubkey}
                  navigation={navigation}
                  communityOrigin={communityOrigin}
                  viewer={viewer}
                />
              )}
            </div>
          )}
        />
      </div>
    </section>
  );
}
