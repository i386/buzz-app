// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { FolderSimpleIcon, GlobeIcon } from "../shared/design-system/icons";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { createCommunityMembership } from "../bundled/moderation/membership";
import {
  SettingsCardsService,
  type SettingsCard,
  type SettingsCards,
} from "../features/settings/service";
import type { ClientSnapshot } from "../features/communities/service";
import type { RelayData } from "../features/relay/service";
import type { Contribution } from "../plugins/contributions";

afterEach(cleanup);

function registry(initial: Contribution<SettingsCard>[]) {
  let entries: readonly Contribution<SettingsCard>[] = initial;
  const listeners = new Set<() => void>();
  const cards: SettingsCards = {
    snapshot: () => entries,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    register() {},
    retainVisibility: () => () => {},
    has: (key) => entries.some((entry) => entry.key === key),
    visibility: (key) => entries.some((entry) => entry.key === key),
  };
  return {
    cards,
    set(next: Contribution<SettingsCard>[]) {
      entries = next;
      for (const listener of listeners) listener();
    },
  };
}
const card = (
  id: string,
  title: string,
  group?: string,
  section?: "administration",
): Contribution<SettingsCard> =>
  Object.freeze({
    id,
    title,
    ...(group ? { group } : {}),
    ...(section ? { section } : {}),
    key: `example/${id}`,
    pluginId: "example",
    revision: "one",
    component: ({ community }) => (
      <p>
        {title} body{community ? ` for ${community.name}` : ""}
      </p>
    ),
  });
// Built-in sections have their own tests; this file covers plugin card placement.
for (const [path, name] of [
  ["./NotificationSettings", "NotificationSettings"],
  ["./AppearanceSettings", "AppearanceSettings"],
  ["./ShortcutSettings", "ShortcutSettings"],
  ["./ProfileSettings", "ProfileSettings"],
  ["./AgentSettings", "AgentSettings"],
  ["./DeveloperSettings", "DeveloperSettings"],
  ["../features/updates/UpdateSettings", "UpdateSettings"],
] as const)
  vi.doMock(path, () => ({ [name]: () => null }));
const { Settings } = await import("./Settings");
const { SettingsSidebar } = await import("./SettingsSidebar");
const { developerMode } = await import("./settings-sections");
const pluginState = {
  configuration: { status: "loading" },
  activation: {},
  busy: false,
  error: null,
  refreshError: null,
};
const communityState = {
  status: "ready",
  viewer: "ab".repeat(32),
  profile: { name: "Buzz User", picture: "" },
  memberships: [{ id: "primary", name: "Primary" }],
  selected: "primary",
};
const host = {
  plugins: { subscribe: () => () => {}, snapshot: () => pluginState },
  communities: {
    subscribe: () => () => {},
    snapshot: () => communityState,
  },
} as unknown as Parameters<typeof Settings>[0];

it("uses contributed icons in community and account navigation", () => {
  const { cards } = registry([
    { ...card("groups", "Personal groups"), icon: FolderSimpleIcon },
    { ...card("hosted", "Hosted communities", "Communities"), icon: GlobeIcon },
    card("other", "Other settings"),
  ]);
  render(<Settings {...host} cards={cards} />);
  expect(
    screen
      .getByRole("button", { name: "Personal groups" })
      .querySelector("svg"),
  ).toHaveClass("tabler-icon-folder");
  expect(
    screen
      .getByRole("button", { name: "Hosted communities" })
      .querySelector("svg"),
  ).toHaveClass("tabler-icon-world");
  expect(
    screen.getByRole("button", { name: "Other settings" }).querySelector("svg"),
  ).toHaveClass("tabler-icon-message-circle");
});

it("keeps grouped cards available without a selected community", () => {
  const { cards } = registry([
    card("hosted", "Hosted communities", "Communities"),
    card("groups", "Personal groups"),
  ]);
  const noCommunityState = { ...communityState, selected: null };
  render(
    <Settings
      {...host}
      communities={
        {
          subscribe: () => () => {},
          snapshot: () => noCommunityState,
        } as unknown as Parameters<typeof Settings>[0]["communities"]
      }
      cards={cards}
    />,
  );
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  expect(nav).toHaveTextContent("Communities");
  fireEvent.click(screen.getByRole("button", { name: "Profile" }));
  expect(screen.getByRole("button", { name: "Profile" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(
    screen.getByRole("button", { name: "Hosted communities" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Personal groups" })).toBeNull();
});

it("shows administration only within a selected community", () => {
  const membership = card(
    "membership",
    "Membership",
    undefined,
    "administration",
  );
  const { cards } = registry([membership]);
  const view = render(<Settings {...host} cards={cards} />);
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  expect(nav).toHaveTextContent("Primary");
  expect(nav).toHaveTextContent("Administration");
  fireEvent.click(screen.getByRole("button", { name: "Membership" }));
  expect(screen.getByText("Membership body for Primary")).toBeVisible();

  const noCommunityState = { ...communityState, selected: null };
  const noCommunity = {
    subscribe: () => () => {},
    snapshot: () => noCommunityState,
  } as unknown as Parameters<typeof Settings>[0]["communities"];
  view.rerender(<Settings {...host} communities={noCommunity} cards={cards} />);
  expect(nav).not.toHaveTextContent("Administration");
  expect(screen.queryByRole("button", { name: "Membership" })).toBeNull();
  expect(screen.queryByText("Membership body")).toBeNull();
});

it("gives contributed cards their own community sections and retires removed cards", async () => {
  const { cards, set } = registry([
    card("hosted", "Hosted communities", "Communities"),
    card("groups", "Personal groups"),
  ]);
  const complete = vi.fn(() => true);
  const onSection = vi.fn();
  render(
    <Settings
      {...host}
      cards={cards}
      navigation={
        {
          target: {
            version: 1,
            kind: "settings",
            section: "example/hosted",
          },
          complete,
        } as never
      }
      onSection={onSection}
    />,
  );
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  expect(nav).toHaveTextContent("Primary");
  expect(nav).toHaveTextContent("Communities");
  expect(await screen.findByText("Hosted communities body")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Hosted communities" }),
  ).toHaveAttribute("aria-current", "page");
  expect(screen.queryByText("Personal groups body")).toBeNull();
  expect(complete).toHaveBeenLastCalledWith({ status: "opened" });

  act(() => set([card("groups", "Personal groups")]));
  await waitFor(() => expect(onSection).toHaveBeenLastCalledWith("profile"));
  expect(screen.queryByText("Hosted communities body")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(nav).not.toHaveTextContent("Hosted communities");
  expect(screen.getByRole("button", { name: "Profile" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
});

it("keeps same-id community cards from different plugins distinct", () => {
  const { cards } = registry([
    card("groups", "Example groups"),
    {
      ...card("groups", "Other groups"),
      key: "other/groups",
      pluginId: "other",
    },
  ]);
  render(<Settings {...host} cards={cards} />);
  fireEvent.click(screen.getByRole("button", { name: "Other groups" }));
  expect(screen.getByText("Other groups body for Primary")).toBeVisible();
  expect(screen.queryByText("Example groups body for Primary")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Example groups" }),
  ).not.toHaveAttribute("aria-current");
});

it("keeps Administration hidden after applying a verified ordinary-member roster", async () => {
  const viewer = "a".repeat(64);
  const relayAuthor = "f".repeat(64);
  let resolveRoster!: (events: unknown[]) => void;
  const roster = new Promise<unknown[]>((resolve) => {
    resolveRoster = resolve;
  });
  const membership = createCommunityMembership({
    snapshot: () => ({
      status: "ready",
      generation: 1,
      scope: `https://primary.example:${viewer}`,
      viewer,
      session: {
        relayAuthor,
        read: () => roster,
        profiles: { ensure: vi.fn(async () => {}) },
      },
    }),
    subscribe: () => () => {},
  } as unknown as RelayData);
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const cards = new SettingsCardsService(root);
  const scope = root.extend({
    pluginOwner: { id: "moderation", revision: "one" },
  });
  const fiber = scope.plugin((ctx) => {
    ctx.settingsCards.register({
      id: "membership",
      title: "Membership",
      section: "administration",
      visibility: {
        snapshot: () => {
          const state = membership.snapshot();
          return (
            state.status === "ready" &&
            (state.role === "owner" || state.role === "admin")
          );
        },
        subscribe: membership.subscribe,
        ensure: membership.ensure,
      },
      component: () => <p>Membership body</p>,
    });
  });
  await fiber.await();
  render(<Settings {...host} cards={cards} />);
  expect(membership.snapshot().status).toBe("loading");

  resolveRoster([
    {
      id: "1".repeat(64),
      kind: 13534,
      pubkey: relayAuthor,
      created_at: 1,
      content: "",
      sig: "",
      tags: [["member", viewer, "member"]],
    },
  ]);
  await waitFor(() =>
    expect(membership.snapshot()).toMatchObject({
      status: "ready",
      role: "member",
      refreshing: false,
    }),
  );

  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  expect(nav).not.toHaveTextContent("Administration");
  expect(screen.queryByRole("button", { name: "Membership" })).toBeNull();
  await fiber.dispose();
  membership.dispose();
  await root.fiber.dispose();
});

it.each(["primary", null])(
  "presents the same Settings groups in both navigations (%s)",
  (selected) => {
    const { cards } = registry([
      card("groups", "Example groups"),
      card("membership", "Membership", undefined, "administration"),
      card("hosted", "Hosted communities", "Communities"),
    ]);
    const state = { ...communityState, selected };
    const connection = { scope: "settings-parity-test" };
    const communities = {
      subscribe: () => () => {},
      snapshot: () => state,
      relay: {
        subscribe: () => () => {},
        snapshot: () => connection,
      },
    } as unknown as Parameters<typeof Settings>[0]["communities"];
    render(<Settings {...host} communities={communities} cards={cards} />);
    render(
      <SettingsSidebar
        cards={cards}
        communities={communities}
        onBack={() => {}}
        onSection={() => {}}
      />,
    );
    const [standalone, shell] = screen.getAllByRole("navigation", {
      name: "Settings sections",
    });
    const outline = (nav: HTMLElement) =>
      [...nav.querySelectorAll("section")].map((group) => [
        group.querySelector("h2")?.textContent,
        [...group.querySelectorAll("button")].map(
          (button) => button.textContent,
        ),
        [...group.querySelectorAll("button[aria-current]")].map(
          (button) => button.textContent,
        ),
      ]);
    expect(outline(standalone as HTMLElement)).toEqual(
      outline(shell as HTMLElement),
    );
    expect(outline(standalone as HTMLElement).map(([label]) => label)).toEqual([
      ...(selected ? ["Primary", "Administration"] : []),
      "Communities",
      "App",
      ...(developerMode ? ["Development"] : []),
    ]);
    // Existing presentations differ only in the contributed-group icon.
    const hosted = (nav: HTMLElement) =>
      within(nav).getByRole("button", { name: "Hosted communities" });
    expect(hosted(standalone as HTMLElement).querySelector("svg")).toBeNull();
    expect(hosted(shell as HTMLElement).querySelector("svg")).not.toBeNull();
  },
);

it("retains departure confirmation until local cleanup settles", async () => {
  let client: ClientSnapshot = {
    ...communityState,
    status: "ready",
    relayAvailable: true,
  };
  const listeners = new Set<() => void>();
  let finish!: () => void;
  const cleanupFinished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const leave = vi.fn(async () => {
    client = { ...client, selected: null, memberships: [] };
    for (const listener of listeners) listener();
    await cleanupFinished;
    return [];
  });
  const { cards } = registry([]);
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <Settings
        {...host}
        cards={cards}
        communities={{
          ...host.communities,
          subscribe: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          snapshot: () => client,
          leave,
        }}
      />
    </ToastProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Leave or remove" }));
  await user.click(
    screen.getByRole("button", { name: "Remove from this device" }),
  );
  try {
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Remove from this device",
      }),
    );
    await waitFor(() => expect(leave).toHaveBeenCalledOnce());
    expect(client.memberships).toEqual([]);
    expect(screen.getByRole("alertdialog")).toBeVisible();
    expect(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Cancel",
      }),
    ).toBeDisabled();
  } finally {
    await act(async () => finish());
  }
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.getByRole("button", { name: "Profile" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(screen.queryByRole("button", { name: "Leave or remove" })).toBeNull();
  expect(
    screen.getByText(
      "Primary was removed from this device. Your membership wasn’t changed. You can add it again later.",
    ),
  ).toBeVisible();
});
