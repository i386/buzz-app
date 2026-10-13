// FOUNDATION: Startup, navigation, contributed pages, and built-in Settings.
import { IdentitySetup } from "../features/identity/IdentitySetup";
import { MeSidebar } from "../bundled/me/MeSidebar";
import { ChannelSidebar } from "../features/channel-navigation/ChannelSidebar";
import { ChannelNavigationProvider } from "../features/channel-navigation/ChannelNavigationState";
import { AgentsContext } from "../features/agents/react";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import { Button } from "../shared/design-system/ui/Button";
import { UpdateNotice } from "../features/updates/UpdateNotice";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { registerAppShortcuts } from "./shortcuts";
import type { AppServices } from "./services";
import { Settings } from "./Settings";
import { SettingsSidebar } from "./SettingsSidebar";
import { RecoveryScreen } from "./RecoveryScreen";
import { PageView } from "../features/pages/PageView";
import { useAppNavigation } from "./navigation";
import { NavigationControls } from "./shell/NavigationControls";
import { registerNavigationShortcuts } from "./shortcuts";
import { AppShell } from "./shell/AppShell";
import {
  LaunchWindowControls,
  LoadingWindowHeader,
} from "./shell/LaunchWindowControls";
import { pagePresentation, shellPresentation } from "./shell/presentation";
import { usePanelLauncher } from "./shell/usePanelLauncher";
import { PanelLaunchers } from "./shell/PanelLaunchers";
import { PanelCard } from "../features/panels/PanelCard";
import { communityDestination } from "../features/communities/destination";
import { profileTarget } from "../features/profiles/target";
import { setLaunchReady } from "./launch";

export function App({ services }: { services: AppServices }) {
  const identity = services.identity;
  useEffect(() => {
    if (!identity) return;
    const update = () => {
      const status = identity.snapshot().status;
      if (status === "missing" || status === "error") setLaunchReady(true);
      else if (status === "loading") setLaunchReady(false);
    };
    update();
    return identity.subscribe(update);
  }, [identity]);
  return (
    <>
      <LaunchWindowControls />
      {services.identity ? (
        <IdentitySetup identity={services.identity}>
          <ConnectedApp services={services} />
        </IdentitySetup>
      ) : (
        <ConnectedApp services={services} />
      )}
    </>
  );
}

function ConnectedApp({ services }: { services: AppServices }) {
  const { plugins } = services;
  const startup = useSyncExternalStore(plugins.subscribe, plugins.startup);
  const route = useAppNavigation(services);
  const launcher = usePanelLauncher(services.panels, startup === "ready");
  const client = useSyncExternalStore(
    services.communities.subscribe,
    services.communities.snapshot,
  );
  const invite = useSyncExternalStore(
    services.invites.subscribe,
    services.invites.snapshot,
  );
  // A queued link cannot be presented under a different identity.
  useEffect(() => {
    if (invite && client.viewer && invite.viewer !== client.viewer)
      services.invites.clear();
  }, [invite, client.viewer, services.invites]);
  const connection = useSyncExternalStore(
    services.relay.subscribe,
    services.relay.snapshot,
  );
  const restoring = client.status === "loading" || !!connection.restoring;
  const settings = route.target.kind === "settings";
  const retryFocus = useRef<string | undefined>(undefined);
  // A passive effect runs after the destination's own mount focus, so this
  // only fills in when focus would otherwise be left on the body.
  useEffect(() => {
    if (!retryFocus.current) return;
    if (retryFocus.current === route.state.attempt.id && !settings && restoring)
      return;
    if (
      retryFocus.current === route.state.attempt.id &&
      document.activeElement === document.body
    )
      document.getElementById("main-content")?.focus({ preventScroll: true });
    retryFocus.current = undefined;
  }, [restoring, settings, route.state.attempt]);
  const terminal =
    startup === "recovery" ||
    route.state.status === "failed" ||
    (!route.state.ingress && !!route.failure);
  const launchReady =
    settings ||
    terminal ||
    (!restoring && startup !== "loading" && !route.waiting);
  useEffect(
    () => setLaunchReady(launchReady, terminal),
    [launchReady, terminal],
  );
  const select = route.select;
  useEffect(
    () =>
      registerAppShortcuts(
        services.shortcuts,
        services.appearance,
        () => {
          void services.navigation.open({ version: 1, kind: "settings" });
          document.getElementById("main-content")?.focus();
        },
        true,
      ),
    [services],
  );
  useEffect(
    () => registerNavigationShortcuts(services.shortcuts, services.navigation),
    [services],
  );
  const presentation = route.page
    ? pagePresentation(route.page)
    : shellPresentation.settings;
  const selectedPanel = launcher.selected;
  const companion = selectedPanel && (
    <PanelCard
      key={launcher.openingId}
      ref={launcher.panelRef}
      panel={selectedPanel}
      target={launcher.target ?? ""}
      close={launcher.close}
    />
  );
  // Personal space has no community profile to view; the panel needs a session.
  const ownProfile =
    client.selected && client.viewer ? profileTarget(client.viewer) : undefined;
  const pageOwnsCompanion = !!route.page?.companion;
  // Keep the parser launch surface through local bootstrap, not network refresh.
  if (!settings && restoring)
    return document.getElementById("buzz-launch") ? null : (
      <div className="buzz-launch" role="status" aria-label="Opening Buzz">
        <LoadingWindowHeader />
        <picture>
          <source
            media="(prefers-reduced-motion: reduce)"
            srcSet="/buzz-mark.svg"
          />
          <img src="/buzz-loading-mark.svg" alt="Buzz" width="72" height="72" />
        </picture>
      </div>
    );
  return (
    <ToastProvider
      portalContainer={document.getElementById("buzz-toast-root") ?? undefined}
    >
      <ChannelNavigationProvider relay={services.relay}>
        <AgentsContext.Provider value={services.agents}>
          <AppShell
            sidebar={(pageNavigation) =>
              settings ? (
                <SettingsSidebar
                  cards={services.settingsCards}
                  communities={services.communities}
                  {...(route.target.kind === "settings" && route.target.section
                    ? { selected: route.target.section }
                    : {})}
                  onBack={route.leaveSettings}
                  onSection={(section) => {
                    const client = services.communities.snapshot();
                    void services.navigation.open({
                      version: 1,
                      kind: "settings",
                      section,
                      ...(client.viewer && client.selected
                        ? {
                            scope: {
                              viewer: client.viewer,
                              communityOrigin: communityDestination(
                                client.selected,
                              ).url,
                            },
                          }
                        : { scope: null }),
                    });
                  }}
                />
              ) : route.selected === "buzz.me/me" ? (
                <MeSidebar
                  relay={services.relay}
                  navigator={services.navigation}
                  target={route.target}
                />
              ) : (
                <ChannelSidebar
                  relay={services.relay}
                  navigator={services.navigation}
                  agents={services.agents}
                  target={route.target}
                  meEnabled={route.pages.some(
                    (page) => page.key === "buzz.me/me",
                  )}
                  sessionsEnabled={route.pages.some(
                    (page) => page.pluginId === "buzz.sessions",
                  )}
                >
                  {pageNavigation}
                </ChannelSidebar>
              )
            }
            navigationControls={
              <NavigationControls navigation={services.navigation} />
            }
            onCommunitySelect={(id) => {
              const recovering =
                services.navigation.snapshot().ingress &&
                services.navigation.snapshot().retryable;
              services.communities.select(id);
              if (!recovering) select("buzz.channels/channels");
            }}
            // A scoped Settings target selects its community on the way.
            onOpenTarget={(target) => void services.navigation.open(target)}
            communities={services.communities}
            invite={invite?.viewer === client.viewer ? invite : undefined}
            onInviteClose={services.invites.clear}
            settingsCards={services.settingsCards}
            accountActions={services.accountActions}
            onProfile={
              ownProfile && launcher.canOpen(ownProfile)
                ? (trigger) => launcher.open(ownProfile, trigger)
                : undefined
            }
            searchServices={services}
            launchers={
              <PanelLaunchers
                panels={launcher.available}
                selected={selectedPanel}
                launch={launcher.launch}
              />
            }
            companion={pageOwnsCompanion ? undefined : companion}
            pages={startup === "ready" ? route.pages : []}
            selected={route.selected}
            navigationAttempt={route.state.attempt.id}
            onSelect={select}
            tone={presentation.tone}
            workspace={
              startup === "ready" && route.page?.layout === "workspace"
            }
          >
            <UpdateNotice updates={services.updates} />
            {startup === "recovery" && !settings ? (
              <RecoveryScreen plugins={plugins} />
            ) : (!route.state.ingress && route.failure) ||
              route.state.status === "failed" ? (
              <div role="alert" className="notice">
                <h1>This destination couldn’t open</h1>
                <p>
                  {(route.state.reason ?? route.failure) === "denied"
                    ? "This target needs its original account and an already joined community."
                    : route.state.ingress && !route.state.retryable
                      ? "This link is invalid or unsupported."
                      : "The destination is unavailable or isn’t supported yet. Your target has been kept for retry."}
                </p>
                {(!route.state.ingress || route.state.retryable) && (
                  <Button
                    type="button"
                    onClick={(event) => {
                      const focused =
                        event.currentTarget === document.activeElement;
                      const before = services.navigation.snapshot().attempt.id;
                      route.retry();
                      // Retry can remove this control and briefly unmount the
                      // shell; hand focus to main only once it has fallen away.
                      const after = services.navigation.snapshot().attempt.id;
                      retryFocus.current =
                        focused && after !== before ? after : undefined;
                    }}
                  >
                    Retry navigation
                  </Button>
                )}
                <Button type="button" onClick={() => select("settings")}>
                  Open Settings
                </Button>
              </div>
            ) : route.waiting ? (
              <p role="status">Opening destination…</p>
            ) : settings ? (
              <Settings
                plugins={plugins}
                cards={services.settingsCards}
                communities={services.communities}
                identity={services.identity}
                appearance={services.appearance}
                shortcuts={services.shortcuts}
                shortcutBindings={services.shortcutBindings}
                notifications={services.notifications}
                updates={services.updates}
                navigation={route.request}
                navigationPane
                onSection={(section) => {
                  const client = services.communities.snapshot();
                  void services.navigation.open({
                    version: 1,
                    kind: "settings",
                    section,
                    ...(client.viewer && client.selected
                      ? {
                          scope: {
                            viewer: client.viewer,
                            communityOrigin: communityDestination(
                              client.selected,
                            ).url,
                          },
                        }
                      : { scope: null }),
                  });
                }}
              />
            ) : startup === "loading" ? (
              <p role="status">Opening destination…</p>
            ) : route.page ? (
              <PageView
                page={route.page}
                navigation={route.request}
                companion={pageOwnsCompanion ? companion : undefined}
                companionOpening={
                  pageOwnsCompanion ? launcher.opening : undefined
                }
              />
            ) : null}
          </AppShell>
        </AgentsContext.Provider>
      </ChannelNavigationProvider>
    </ToastProvider>
  );
}
