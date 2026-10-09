// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { httpReadError } from "../relay/errors";
import type { RelayData, RelaySnapshot } from "../relay/service";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { nativeIdentityEnabled } from "../identity/service";
import * as communityApi from "./api";
import { CommunityRail } from "./CommunityRail";
import type { Communities, ClientSnapshot } from "./service";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("unexpected native call");
  }),
  isTauri: () => true,
}));

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: ToastProvider });
const settingsCards = {
  subscribe: () => () => {},
  has: () => true,
};
const viewer = "a".repeat(64);
const primary = "https://primary.example";
const secondary = "https://secondary.example";

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubEnv("VITE_BUZZ_LIVE", "");
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("offers native owners invites while keeping unsupported read sync disabled", async () => {
  expect(nativeIdentityEnabled()).toBe(true);
  const snapshot: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    profile: { name: "", picture: "" },
    sync: { known: [], outbox: [] },
    viewer,
    selected: primary,
    memberships: [{ id: primary, name: "Primary" }],
  };
  const relayAuthor = "f".repeat(64);
  const read = vi.fn(async () => [
    {
      id: "e".repeat(64),
      kind: 13534,
      pubkey: relayAuthor,
      created_at: 1,
      content: "",
      sig: "",
      tags: [["-"], ["member", viewer, "owner"]],
    },
  ]);
  const markAllChannelsRead = vi.fn(async () => []);
  const connection = {
    status: "ready",
    generation: 1,
    scope: `${primary}:${viewer}`,
    viewer,
    session: {
      relayAuthor,
      read,
      unread: {
        // Native builds have no read-state host, so the capability never syncs.
        sync: () => ({ capability: "unsupported" }),
        subscribeSync: () => () => {},
        markAllChannelsRead,
      },
    },
  } as unknown as RelaySnapshot;
  const communities = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    select: vi.fn(),
    relay: {
      snapshot: () => connection,
      subscribe: () => () => {},
    } as unknown as RelayData,
  } as unknown as Communities;
  const onOpenTarget = vi.fn();
  render(
    <CommunityRail
      communities={communities}
      onOpenTarget={onOpenTarget}
      settingsCards={settingsCards}
    />,
  );
  fireEvent.contextMenu(
    screen.getByRole("button", { name: "Switch to Primary" }),
    {
      clientX: 20,
      clientY: 20,
    },
  );
  const menu = await screen.findByRole("menu", { name: "Actions for Primary" });
  await within(menu).findByRole("menuitem", { name: "Community settings" });
  const invite = await within(menu).findByRole("menuitem", {
    name: "Invite to community",
  });
  expect(invite).not.toHaveAttribute("aria-disabled");
  const markAll = within(menu).getByRole("menuitem", {
    name: "Mark all as read",
  });
  expect(markAll).toHaveAttribute("aria-disabled", "true");
  expect(markAll).toHaveAccessibleDescription(
    "Read state can’t sync on this connection.",
  );
  expect(read).toHaveBeenCalledWith(
    [{ kinds: [13534], authors: [relayAuthor], limit: 1 }],
    expect.objectContaining({ fresh: true }),
  );
  // Leaving is offered in native builds too, always as the last action.
  const actions = within(menu).getAllByRole("menuitem");
  expect(actions.at(-1)).toHaveTextContent("Leave community");
  expect(actions.at(-1)).not.toHaveAttribute("aria-disabled");
  fireEvent.click(invite);
  expect(onOpenTarget).toHaveBeenCalledWith({
    version: 1,
    kind: "settings",
    section: "buzz.moderation/membership",
    scope: { viewer, communityOrigin: primary },
  });
});

/** Two saved communities with no session: the access check needs none. */
function harness() {
  let snapshot: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    profile: { name: "", picture: "" },
    sync: { known: [], outbox: [] },
    viewer,
    selected: primary,
    memberships: [
      { id: primary, name: "Primary" },
      { id: secondary, name: "Secondary" },
    ],
  };
  const listeners = new Set<() => void>();
  const connection = {
    status: "connecting",
    generation: 1,
    scope: `${primary}:${viewer}`,
    viewer,
  } as unknown as RelaySnapshot;
  const communities = {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    select: vi.fn(),
    leave: vi.fn(),
    relay: {
      snapshot: () => connection,
      subscribe: () => () => {},
    } as unknown as RelayData,
  } as unknown as Communities;
  return {
    communities,
    update(change: Partial<ClientSnapshot>) {
      act(() => {
        snapshot = { ...snapshot, ...change };
        for (const listener of listeners) listener();
      });
    },
  };
}
const button = (name: string) =>
  screen.getByRole("button", { name: `Switch to ${name}` });
async function openMenu(name: string) {
  fireEvent.contextMenu(button(name), { clientX: 20, clientY: 20 });
  return await screen.findByRole("menu", { name: `Actions for ${name}` });
}
/** The item's hint, which carries the access check's answer beside the name. */
async function hint(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.hover(button(name));
  const tooltip = await screen.findByRole("tooltip");
  return {
    tooltip,
    async close() {
      await user.unhover(button(name));
      await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    },
  };
}
const profile = {} as Awaited<ReturnType<typeof communityApi.inspectProfile>>;

it("shows which saved communities refuse this identity or cannot be reached, and keeps every one", async () => {
  const user = userEvent.setup();
  // The one signed read per community, answered as the relay taxonomy does.
  const inspect = vi
    .spyOn(communityApi, "inspectProfile")
    .mockImplementation(async (id) => {
      if (id === primary) throw httpReadError(403);
      if (id === secondary) throw new Error("ECONNREFUSED");
      return profile;
    });
  const h = harness();
  render(<CommunityRail communities={h.communities} />);
  await waitFor(() =>
    expect(inspect.mock.calls.map(([id]) => id).sort()).toEqual([
      primary,
      secondary,
    ]),
  );
  expect(inspect).toHaveBeenCalledWith(primary);
  const refused = await hint(user, "Primary");
  await waitFor(() =>
    expect(refused.tooltip).toHaveTextContent("Primary · Access refused"),
  );
  await refused.close();
  let menu = await openMenu("Primary");
  expect(
    within(menu).getByText("This community’s relay refused your identity."),
  ).toHaveClass("buzz-menu-note");
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual(["Mark all as read", "Copy community URL", "Leave community"]);
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  const down = await hint(user, "Secondary");
  await waitFor(() =>
    expect(down.tooltip).toHaveTextContent("Secondary · Unreachable"),
  );
  await down.close();
  menu = await openMenu("Secondary");
  expect(
    within(menu).getByText("Can’t reach this community right now."),
  ).toHaveClass("buzz-menu-note");
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  // Neither answer removed anything or touched the device record.
  expect(button("Primary")).toHaveAttribute("aria-current", "true");
  expect(button("Secondary")).toBeInTheDocument();
  expect(h.communities.leave).not.toHaveBeenCalled();
  expect(h.communities.select).not.toHaveBeenCalled();
});

it("re-checks only refused or unreachable communities on returning to the window, and every one on coming back online", async () => {
  const user = userEvent.setup();
  let refuse = true;
  const inspect = vi
    .spyOn(communityApi, "inspectProfile")
    .mockImplementation(async (id) => {
      if (id === primary && refuse) throw httpReadError(401);
      return profile;
    });
  const h = harness();
  render(<CommunityRail communities={h.communities} />);
  const refused = await hint(user, "Primary");
  await waitFor(() =>
    expect(refused.tooltip).toHaveTextContent("Primary · Access refused"),
  );
  await waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
  // A membership change reads only what this pass has not read yet.
  h.update({ memberships: [{ id: primary, name: "Primary" }] });
  h.update({
    memberships: [
      { id: primary, name: "Primary" },
      { id: secondary, name: "Secondary" },
    ],
  });
  await act(async () => {});
  expect(inspect).toHaveBeenCalledTimes(2);
  // Back to the window: the one that read fine is not asked again, so a
  // return from another app is not a round trip per saved community.
  let visibility: DocumentVisibilityState = "hidden";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
  fireEvent(document, new Event("visibilitychange"));
  await act(async () => {});
  expect(inspect).toHaveBeenCalledTimes(2);
  visibility = "visible";
  fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => expect(inspect).toHaveBeenCalledTimes(3));
  expect(inspect.mock.calls.at(-1)?.[0]).toBe(primary);
  await act(async () => {});
  expect(inspect).toHaveBeenCalledTimes(3);
  expect(refused.tooltip).toHaveTextContent("Primary · Access refused");
  // Online again: every saved community is read, and the answer follows.
  refuse = false;
  fireEvent(window, new Event("online"));
  await waitFor(() => expect(refused.tooltip).toHaveTextContent(/^Primary$/));
  expect(inspect.mock.calls.map(([id]) => id).sort()).toEqual([
    primary,
    primary,
    primary,
    secondary,
    secondary,
  ]);
  await refused.close();
  const menu = await openMenu("Primary");
  expect(within(menu).queryByText(/relay refused|Can’t reach/)).toBeNull();
});
