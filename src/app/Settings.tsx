import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { Header } from "../shared/design-system/ui/Header";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { Panel } from "../shared/design-system/ui/Panel";
import { NavigationItem } from "../shared/design-system/ui/NavigationItem";
import { NavigationSection } from "../shared/design-system/ui/NavigationSection";
import { Button } from "../shared/design-system/ui/Button";
import { SwitchPreferenceRow } from "../shared/design-system/ui/SwitchPreferenceRow";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { RecoveryScreen } from "./RecoveryScreen";
import styles from "./Settings.module.css";
import { SquaresFourIcon } from "../shared/design-system/icons/index";
import type { PluginManager } from "../plugins/manager";
import type { Communities, Membership } from "../features/communities/service";
import { PluginImport } from "./PluginImport";
import type { Identity } from "../features/identity/service";
import { ProfileSettings } from "./ProfileSettings";

import type { Appearance } from "../shared/theme/service";
import { AppearanceSettings } from "./AppearanceSettings";
import { NotificationSettings } from "./NotificationSettings";
import type { NotificationsService } from "../features/notifications/service";
import type { ShortcutsService } from "../features/shortcuts/service";
import type { ShortcutBindings } from "../features/shortcuts/preferences";
import { ShortcutSettings } from "./ShortcutSettings";
import { DeveloperSettings } from "./DeveloperSettings";
import { ArchiveSettings } from "./ArchiveSettings";
import { AgentSettings } from "./AgentSettings";
import type { SettingsCards } from "../features/settings/service";
import { OwnedContribution } from "../plugins/OwnedContribution";
import type { Updates } from "../features/updates/updates";
import { UpdateSettings } from "../features/updates/UpdateSettings";
import { CommunityDepartureSettings } from "./CommunityDepartureSettings";
import { developerMode, settingsSections } from "./settings-sections";

export function Settings({
  cards,
  plugins,
  communities,
  identity,
  appearance,
  shortcuts,
  shortcutBindings,
  notifications,
  updates,
  navigation,
  onSection,
  navigationPane = false,
  onDeparturePending,
}: {
  cards: SettingsCards;
  plugins: PluginManager;
  communities: Communities;
  identity?: Identity | undefined;
  appearance: Appearance;
  shortcuts: ShortcutsService;
  shortcutBindings: ShortcutBindings;
  notifications: NotificationsService;
  updates: Updates;
  navigation?:
    | import("../features/navigation/service").PageNavigation
    | undefined;
  onSection?: (section: string) => void;
  navigationPane?: boolean;
  onDeparturePending?: (pending: boolean) => void;
}) {
  useEffect(() => cards.retainVisibility(), [cards]);
  const contributed = useSyncExternalStore(cards.subscribe, cards.snapshot);
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const selectedCommunity = client.memberships.find(
    (membership) => membership.id === client.selected,
  );
  // Local removal drops the saved membership before session disposal/purge
  // settles. Retain only this action's context so its modal can finish.
  const [departure, setDeparture] = useState<{
    community: Membership;
    viewer: string | undefined;
  } | null>(null);
  const departureCommunity =
    departure?.viewer === client.viewer
      ? (departure?.community ?? selectedCommunity)
      : selectedCommunity;
  const { groups, sections, defaultSection } = useMemo(
    () => settingsSections(contributed, departureCommunity),
    [contributed, departureCommunity],
  );
  const [selected, setSelected] = useState(defaultSection);
  useEffect(() => {
    if (
      departure &&
      (selected !== "leave-community" ||
        departure.viewer !== client.viewer ||
        (client.selected !== null &&
          client.selected !== departure.community.id))
    )
      setDeparture(null);
  }, [client.selected, client.viewer, departure, selected]);
  const requestedSection =
    navigation?.target.kind === "settings"
      ? (navigation.target.section ?? defaultSection)
      : undefined;
  useEffect(() => {
    if (
      requestedSection &&
      sections.some((section) => section.id === requestedSection)
    )
      setSelected(requestedSection);
    else if (!sections.some((section) => section.id === selected)) {
      setSelected(defaultSection);
      if (requestedSection === selected) onSection?.(defaultSection);
    }
  }, [defaultSection, onSection, requestedSection, selected, sections]);
  useEffect(() => {
    if (requestedSection === selected)
      navigation?.complete({ status: "opened" });
  }, [navigation, requestedSection, selected]);
  const { configuration, activation, busy, error, refreshError } =
    useSyncExternalStore(plugins.subscribe, plugins.snapshot);
  const ready = configuration.status === "ready" ? configuration : undefined;
  const catalog = ready?.catalog;
  const externalPluginsPaused = ready?.externalPluginsPaused;
  return (
    <div
      className={`${styles.root} ${navigationPane ? styles.navigationPane : ""}`}
    >
      <Panel
        aria-label={navigationPane ? "Settings" : undefined}
        aria-labelledby={navigationPane ? undefined : "settings-title"}
      >
        <div className={styles.layout}>
          <aside className={styles.sidebar}>
            <div className={styles.sidebarHeader}>
              <h1 id="settings-title" className="m-0 text-label">
                Settings
              </h1>
            </div>
            <nav aria-label="Settings sections" className={styles.navigation}>
              {groups.map((group) => (
                <NavigationSection key={group.id} label={group.label}>
                  {group.sections.map(({ id, label, icon: Icon }) => (
                    <NavigationItem
                      label={label}
                      icon={Icon && <Icon aria-hidden="true" size={18} />}
                      selected={selected === id}
                      type="button"
                      key={id}
                      aria-current={selected === id ? "page" : undefined}
                      onClick={(event) => {
                        event.currentTarget.focus();
                        if (onSection) onSection(id);
                        else setSelected(id);
                      }}
                    />
                  ))}
                </NavigationSection>
              ))}
            </nav>
          </aside>
          <div className={`${styles.detail} buzz-settings-page`}>
            {navigationPane && <h1 className="sr-only">Settings</h1>}
            <div hidden={selected !== "notifications"}>
              <NotificationSettings
                notifications={notifications}
                active={selected === "notifications"}
              />
            </div>
            <div hidden={selected !== "appearance"}>
              <AppearanceSettings
                appearance={appearance}
                active={selected === "appearance"}
              />
            </div>
            <div hidden={selected !== "shortcuts"}>
              <ShortcutSettings
                shortcuts={shortcuts}
                bindings={shortcutBindings}
                plugins={plugins}
              />
            </div>
            <div hidden={selected !== "agents"}>
              <AgentSettings
                archive={
                  <ArchiveSettings
                    relay={communities.relay}
                    community={selectedCommunity?.name}
                    active={selected === "agents"}
                  />
                }
                active={selected === "agents"}
              />
            </div>
            <div hidden={selected !== "updates"}>
              <UpdateSettings
                updates={updates}
                active={selected === "updates"}
              />
            </div>
            {contributed.map(
              (card) =>
                selected === card.key && (
                  <OwnedContribution
                    key={card.key}
                    entry={card}
                    registry={cards}
                  >
                    {(entry, active) => {
                      const Card = entry.component;
                      return (
                        <Card
                          active={active}
                          {...(!card.group && selectedCommunity
                            ? { community: selectedCommunity }
                            : {})}
                        />
                      );
                    }}
                  </OwnedContribution>
                ),
            )}
            {departureCommunity && selected === "leave-community" && (
              <CommunityDepartureSettings
                key={`${client.viewer}:${departureCommunity.id}`}
                communities={communities}
                community={departureCommunity}
                onPending={(pending) => {
                  onDeparturePending?.(pending);
                  setDeparture(
                    pending
                      ? { community: departureCommunity, viewer: client.viewer }
                      : null,
                  );
                }}
                onRemoved={() => {
                  if (onSection) onSection("profile");
                  else setSelected("profile");
                }}
              />
            )}
            <div hidden={selected !== "profile"}>
              <ProfileSettings
                key={`${client.viewer}:${selectedCommunity?.id ?? "local"}`}
                communities={communities}
                community={selectedCommunity}
                identity={identity}
                active={selected === "profile"}
              />
            </div>
            {developerMode && (
              <div hidden={selected !== "developer"}>
                <DeveloperSettings relay={communities.relay} />
              </div>
            )}
            <div hidden={selected !== "plugins"}>
              <section aria-labelledby="plugin-settings-title">
                <Header
                  id="plugin-settings-title"
                  title="Plugins"
                  subtitle={
                    !plugins.imports
                      ? "Open the desktop app to load plugins from a folder or Git repository."
                      : undefined
                  }
                />
                {catalog ? (
                  <PluginImport
                    plugins={plugins}
                    catalog={catalog}
                    busy={busy}
                    authorizeGit={async (repository) => {
                      const connection = communities.relay.snapshot();
                      return connection.status === "ready"
                        ? ((await connection.session.authorizeGit?.(
                            repository,
                          )) ?? null)
                        : null;
                    }}
                  />
                ) : configuration.status === "recovery" ? (
                  <RecoveryScreen plugins={plugins} />
                ) : (
                  <p role="status">
                    Plugin settings are unavailable. Profile and Appearance
                    still work.
                  </p>
                )}
                <div className="overflow-hidden">
                  <div>
                    {externalPluginsPaused && (
                      <p role="status" className="text-body-sm text-subtle">
                        External plugins are paused for this launch. Your saved
                        enabled settings are unchanged; you can still manage
                        plugins here.
                      </p>
                    )}
                    {selected === "plugins" && refreshError && (
                      <ToastNotice
                        title="Plugin settings couldn’t refresh"
                        description={`Showing the last available configuration; retrying automatically. ${refreshError}`}
                      />
                    )}
                    {selected === "plugins" && error && (
                      <ToastNotice
                        title="Plugin change wasn’t confirmed"
                        description={`Check the current settings before trying again. ${error}`}
                        onDismiss={plugins.dismissError}
                        closeLabel="Dismiss"
                      />
                    )}
                  </div>
                  <SettingsGroup>
                    {catalog?.plugins.map((plugin) => {
                      const id = plugin.manifest.id;
                      const running = activation[id];
                      const failure =
                        plugin.error ??
                        (running?.revision === plugin.revision
                          ? running.error
                          : null);
                      return (
                        <article className="py-1" key={id}>
                          {/* Channels is required and has no enable/disable control. */}
                          {id === "buzz.channels" ? (
                            <PreferenceRow
                              icon={<SquaresFourIcon size={20} />}
                              title={plugin.manifest.name}
                              trailing={
                                <span className="text-body-sm text-subtle">
                                  Required
                                </span>
                              }
                            />
                          ) : (
                            <SwitchPreferenceRow
                              icon={<SquaresFourIcon size={20} />}
                              label={plugin.manifest.name}
                              aria-label={`Enable ${plugin.manifest.name}`}
                              checked={plugin.enabled}
                              readOnly={busy}
                              aria-disabled={busy}
                              onClick={(event) => event.currentTarget.focus()}
                              onCheckedChange={() => {
                                if (busy) return;
                                void plugins.change(
                                  plugin.enabled ? "disable" : "enable",
                                  id,
                                );
                              }}
                            />
                          )}
                          {failure && (
                            <p role="alert" className="error text-body-sm">
                              {failure}
                            </p>
                          )}
                          <div className="actions items-center">
                            {plugin.previous && (
                              <Button
                                type="button"
                                disabled={
                                  busy || !!plugin.rollbackBlockedReason
                                }
                                onClick={() => plugins.change("rollback", id)}
                              >
                                Roll back
                              </Button>
                            )}
                            {plugin.rollbackBlockedReason && (
                              <span className="text-body-sm text-muted">
                                {plugin.rollbackBlockedReason}
                              </span>
                            )}
                            {plugin.reloadable && !plugin.enabled && (
                              <Button
                                type="button"
                                disabled={busy}
                                onClick={() => plugins.reload(id)}
                              >
                                Reload
                              </Button>
                            )}
                            {plugin.source === "external" && (
                              <Button
                                type="button"
                                variant="destructive"
                                disabled={busy}
                                onClick={() => plugins.change("remove", id)}
                              >
                                Delete
                              </Button>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </SettingsGroup>
                </div>
              </section>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}
