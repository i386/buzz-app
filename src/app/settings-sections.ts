// One Settings section policy for the standalone and shell presentations and
// route classification. Visibility and authorization stay with settingsCards.
import {
  BellIcon,
  ChatCircleIcon,
  DownloadIcon,
  KeyboardIcon,
  PaletteIcon,
  RobotIcon,
  SignOutIcon,
  SquaresFourIcon,
  UserIcon,
  UsersIcon,
  WrenchIcon,
} from "../shared/design-system/icons/index";
import type { SettingsCard } from "../features/settings/service";
import type { Contribution } from "../plugins/contributions";

type Community = { name: string };
export type SettingsSection = {
  id: string;
  label: string;
  /** Contributed groups leave the icon to each presentation. */
  icon?: typeof UserIcon;
};
export type SettingsGroup = {
  id: string;
  label: string;
  sections: readonly SettingsSection[];
};

// DEV alone is not enough: packaged desktop builds load a production bundle
// from tauri://localhost, so the hostname check excludes them too.
export const developerMode =
  import.meta.env.DEV &&
  /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);

const profile: SettingsSection = {
  id: "profile",
  label: "Profile",
  icon: UserIcon,
};
const app: readonly SettingsSection[] = [
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "notifications", label: "Notifications", icon: BellIcon },
  { id: "shortcuts", label: "Shortcuts", icon: KeyboardIcon },
  { id: "agents", label: "Agents", icon: RobotIcon },
  { id: "plugins", label: "Plugins", icon: SquaresFourIcon },
  { id: "updates", label: "Updates", icon: DownloadIcon },
];
const developer: SettingsSection = {
  id: "developer",
  label: "Developer",
  icon: WrenchIcon,
};
const departure: SettingsSection = {
  id: "leave-community",
  label: "Leave or remove",
  icon: SignOutIcon,
};
const builtIn = new Set(
  [profile, departure, ...app, ...(developerMode ? [developer] : [])].map(
    ({ id }) => id,
  ),
);

/** Host-owned sections; any other section is a plugin card contribution key. */
export const isBuiltInSettingsSection = (id: string) => builtIn.has(id);

export function settingsSections(
  cards: readonly Contribution<SettingsCard>[],
  community: Community | undefined,
) {
  const section = (
    card: Contribution<SettingsCard>,
    icon?: typeof UserIcon,
  ): SettingsSection => {
    const resolvedIcon = card.icon ?? icon;
    return {
      id: card.key,
      label: card.title,
      ...(resolvedIcon ? { icon: resolvedIcon } : {}),
    };
  };
  const administration = community
    ? cards
        .filter((card) => card.section === "administration")
        .map((card) => section(card, UsersIcon))
    : [];
  const groups: SettingsGroup[] = [
    ...(community
      ? [
          {
            id: "community",
            label: community.name,
            sections: [
              profile,
              ...cards
                .filter((card) => !card.group && !card.section)
                .map((card) => section(card, ChatCircleIcon)),
              departure,
            ],
          },
        ]
      : []),
    ...(administration.length > 0
      ? [
          {
            id: "administration",
            label: "Administration",
            sections: administration,
          },
        ]
      : []),
    ...[...new Set(cards.flatMap((card) => card.group ?? []))].map((label) => ({
      id: `group:${label}`,
      label,
      sections: cards
        .filter((card) => card.group === label)
        .map((card) => section(card)),
    })),
    {
      id: "app",
      label: "App",
      sections: [...(community ? [] : [profile]), ...app],
    },
    ...(developerMode
      ? [{ id: "development", label: "Development", sections: [developer] }]
      : []),
  ];
  return {
    groups,
    sections: groups.flatMap((group) => group.sections),
    defaultSection: community ? "profile" : "appearance",
  };
}
