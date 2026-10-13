// @vitest-environment jsdom
import { expect, it } from "vitest";
import {
  ChatCircleIcon,
  UserIcon,
  UsersIcon,
} from "../shared/design-system/icons/index";
import type { SettingsCard } from "../features/settings/service";
import type { Contribution } from "../plugins/contributions";
import {
  developerMode,
  isBuiltInSettingsSection,
  settingsSections,
} from "./settings-sections";

const card = (
  key: string,
  extra: Partial<SettingsCard> = {},
): Contribution<SettingsCard> => {
  const [pluginId = "", id = ""] = key.split("/");
  return {
    id,
    key,
    pluginId,
    revision: "one",
    title: key,
    component: () => null,
    ...extra,
  };
};
const cards = [
  card("example/groups"),
  card("other/groups"),
  card("example/membership", { section: "administration" }),
  card("example/hosted", { group: "Communities" }),
];
const primary = { id: "primary", name: "Primary" };
const app = [
  "appearance",
  "notifications",
  "shortcuts",
  "agents",
  "plugins",
  "updates",
];
const development = developerMode
  ? [["development", "Development", ["developer"]]]
  : [];
const outline = (model: ReturnType<typeof settingsSections>) =>
  model.groups.map((group) => [
    group.id,
    group.label,
    group.sections.map((section) => section.id),
  ]);

it.each([
  [
    "a selected community",
    primary,
    "profile",
    [
      [
        "community",
        "Primary",
        ["profile", "example/groups", "other/groups", "leave-community"],
      ],
      ["administration", "Administration", ["example/membership"]],
      ["group:Communities", "Communities", ["example/hosted"]],
      ["app", "App", app],
      ...development,
    ],
  ],
  [
    "Personal",
    undefined,
    "appearance",
    [
      ["group:Communities", "Communities", ["example/hosted"]],
      ["app", "App", ["profile", ...app]],
      ...development,
    ],
  ],
])(
  "orders Settings groups and defaults for %s",
  (_, community, initial, groups) => {
    const model = settingsSections(cards, community);
    expect(outline(model)).toEqual(groups);
    expect(model.defaultSection).toBe(initial);
    expect(model.sections.map((section) => section.id)).toEqual(
      groups.flatMap(([, , ids]) => ids),
    );
  },
);

it("leaves contributed group icons to each presentation", () => {
  const icons = Object.fromEntries(
    settingsSections(cards, primary).sections.map((section) => [
      section.id,
      section.icon,
    ]),
  );
  expect(icons).toMatchObject({
    profile: UserIcon,
    "example/groups": ChatCircleIcon,
    "example/membership": UsersIcon,
    "example/hosted": undefined,
  });
});

it("classifies built-in sections apart from plugin card keys", () => {
  for (const id of ["profile", "leave-community", ...app])
    expect(isBuiltInSettingsSection(id)).toBe(true);
  expect(isBuiltInSettingsSection("developer")).toBe(developerMode);
  for (const id of ["example/groups", "Profile", "", "administration"])
    expect(isBuiltInSettingsSection(id)).toBe(false);
});
