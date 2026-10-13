import type { ReactNode } from "react";
import { communityDestination } from "../../features/communities/destination";
import { nativeRelayStaff } from "../../features/relay-staff/native";
import type { SettingsCard } from "../../features/settings/service";
import type { PluginModule } from "../../plugins/api";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import { SCREENS, type Screen } from "./Console";
import { ProfilesContext } from "./people";
import { RelayStaff } from "./RelayStaff";
import { createStaff, type Staff } from "./staff";

/** The Settings group for every relay-wide staff entry. */
export const GROUP = "Relay admin";

export const inject = ["relay", "settingsCards", "communityReader"];
export const apply: PluginModule["apply"] = (ctx) => {
  const reader = ctx.communityReader;
  const staff = createStaff(nativeRelayStaff(), () => {
    const { selected, viewer } = reader.snapshot();
    if (!selected || !viewer) return null;
    try {
      return { relay: communityDestination(selected).url, signer: viewer };
    } catch {
      return null;
    }
  });
  ctx.effect(() => reader.subscribe(staff.refresh));
  for (const card of cards(staff, (node) => (
    <WithProfiles relay={ctx.relay}>{node}</WithProfiles>
  )))
    ctx.settingsCards.register(card);
};

/**
 * One Settings entry per screen, all sharing `staff`, so a held write and its
 * request id outlive moving between entries. Staff is for operators only.
 */
export function cards(
  staff: Staff,
  wrap: (node: ReactNode) => ReactNode,
): SettingsCard[] {
  return (Object.keys(SCREENS) as Screen[]).map((screen) => ({
    id: screen,
    title: SCREENS[screen].title,
    icon: SCREENS[screen].icon,
    group: GROUP,
    visibility: {
      snapshot: screen === "staff" ? staff.operatorVisible : staff.visible,
      subscribe: staff.subscribe,
      ensure: staff.ensure,
    },
    component: ({ active }) =>
      wrap(<RelayStaff staff={staff} screen={screen} active={active} />),
  }));
}

/** Names come from the connected community's profiles; reconnecting replaces them. */
function WithProfiles({
  relay,
  children,
}: {
  relay: RelayData;
  children: ReactNode;
}) {
  const { session } = useRelayConnection(relay);
  return (
    <ProfilesContext.Provider value={session.profiles}>
      {children}
    </ProfilesContext.Provider>
  );
}
