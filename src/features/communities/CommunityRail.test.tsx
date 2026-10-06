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
import { afterEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SettingsCardsService } from "../settings/service";
import type { RelayData, RelaySnapshot } from "../relay/service";
import type { UnreadCapability } from "../relay/unread";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { CommunityRail } from "./CommunityRail";
import { MEMBERSHIP_SECTION } from "./CommunityRailItem";
import type { PurgeFailure } from "./device-state";
import { MEMBERSHIP_KIND, type Role } from "./roster";
import {
  createCommunities,
  type Communities,
  type ClientSnapshot,
} from "./service";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: ToastProvider });
const settingsCards = {
  subscribe: () => () => {},
  has: () => true,
};
const viewer = "a".repeat(64);
const relayKey = "f".repeat(64);
const primary = "https://primary.example";
const secondary = "https://secondary.example";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const accepted = () =>
  Response.json({ accepted: true, event_id: "1".repeat(64), message: "" });

/** A rail over two saved communities; only the selected one has a session. */
function harness({
  selected = primary,
  role = "owner" as Role,
  status = "ready" as RelaySnapshot["status"],
  capability = "frontier-sync" as UnreadCapability["sync"] extends () => {
    capability: infer C;
  }
    ? C
    : never,
  /** What the community's relay answers to the broker leave route. */
  leaveResponse = accepted as () => Response | Promise<Response>,
  /** Stores the service could not clear after forgetting the community. */
  leaveResidue = [] as PurgeFailure[],
  /** The service's own failure to save the device record, before it changes. */
  leaveError = undefined as Error | undefined,
  /** The relay signing key the session contract carries; null while offline. */
  relayAuthor = relayKey as string | null,
} = {}) {
  let snapshot: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    profile: { name: "", picture: "" },
    sync: { known: {}, outbox: [] },
    viewer,
    selected,
    memberships: [
      { id: primary, name: "Primary" },
      { id: secondary, name: "Secondary" },
    ],
  };
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const select = vi.fn((id: string | null) => {
    snapshot = { ...snapshot, selected: id };
    notify();
  });
  // Mirrors the service: the membership goes, and a left selection lands on
  // Personal space without the rail selecting anything. Only the save can
  // throw, and it does so before anything changes. The purge option is
  // recorded for the assertions on which outcomes clear device state.
  const leave = vi.fn(async (id: string) => {
    if (leaveError) throw leaveError;
    snapshot = {
      ...snapshot,
      memberships: snapshot.memberships.filter((m) => m.id !== id),
      selected: snapshot.selected === id ? null : snapshot.selected,
    };
    notify();
    return leaveResidue;
  });
  const read = vi.fn(async () => [
    {
      id: "e".repeat(64),
      kind: MEMBERSHIP_KIND,
      pubkey: relayKey,
      created_at: 1,
      content: "",
      sig: "",
      tags: [["-"], ["member", viewer, role]],
    },
  ]);
  const markAllChannelsRead = vi.fn(async () => []);
  const session = {
    relayAuthor: relayAuthor ?? undefined,
    read,
    unread: {
      sync: () => ({ capability }),
      subscribeSync: () => () => {},
      markAllChannelsRead,
    },
  };
  const connection = {
    status,
    generation: 1,
    scope: `${selected}:${viewer}`,
    viewer,
    session,
  } as unknown as RelaySnapshot;
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
  } as unknown as RelayData;
  const communities = {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    select,
    leave,
    relay,
  } as unknown as Communities;
  // The broker's session contract is deliberately unanswered: the rail holds
  // the session already and must not ask for it again.
  const fetch = vi.fn(async (url: string) => {
    const path = String(url);
    if (path === "/api/relay/register") return Response.json({});
    if (path.endsWith("/leave")) return leaveResponse();
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  const onOpenTarget = vi.fn();
  // The host's selection path: selects through the service, then navigates.
  const onSelect = vi.fn((id: string | null) => select(id));
  return {
    communities,
    select,
    leave,
    read,
    fetch,
    markAllChannelsRead,
    onOpenTarget,
    onSelect,
    leaveRequests: () =>
      fetch.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.endsWith("/leave")),
    update(change: Partial<ClientSnapshot>) {
      act(() => {
        snapshot = { ...snapshot, ...change };
        notify();
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
const items = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.textContent);
/** Session contract requests to the broker. The rail verifies the roster
 * against the relay authority its session already holds, so it makes none;
 * icon discovery is separate, and the native-only access check does not run
 * against the broker (see `CommunityRail.native.test.tsx`). */
const sessionRequests = (fetch: ReturnType<typeof vi.fn>) =>
  fetch.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.endsWith("/session"));

it("switches using the shared membership owner without acquiring other sessions on render", () => {
  const h = harness();
  render(<CommunityRail communities={h.communities} />);
  expect(h.select).not.toHaveBeenCalled();
  expect(
    screen.getByRole("navigation", { name: "Communities" }),
  ).toBeInTheDocument();
  expect(button("Primary")).toHaveAttribute("aria-current", "true");
  fireEvent.click(button("Secondary"));
  expect(h.select).toHaveBeenCalledWith(secondary);
  expect(button("Secondary")).toHaveAttribute("aria-current", "true");
  fireEvent.click(screen.getByRole("button", { name: "Personal space" }));
  expect(h.select).toHaveBeenCalledWith(null);
  expect(
    screen.getByRole("button", { name: "Personal space" }),
  ).toHaveAttribute("aria-current", "true");
  const add = screen.getByRole("button", { name: "Add a community" });
  fireEvent.click(add);
  expect(
    screen.getByRole("heading", { name: "Add a community" }),
  ).toBeInTheDocument();
  expect(h.select).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(button("Primary")).toBeInTheDocument();

  h.update({ memberships: [{ id: secondary, name: "Secondary" }] });
  expect(
    screen.queryByRole("button", { name: "Switch to Primary" }),
  ).not.toBeInTheDocument();
  // Without host navigation there is no Settings to open, so no roster was read
  // for a rail that only switches communities.
  expect(h.read).not.toHaveBeenCalled();
  expect(sessionRequests(h.fetch)).toEqual([]);
});

it("offers the original's actions on the selected community and only reads its roster", async () => {
  const h = harness();
  render(
    <CommunityRail
      communities={h.communities}
      onOpenTarget={h.onOpenTarget}
      settingsCards={settingsCards}
    />,
  );
  const menu = await openMenu("Primary");
  await within(menu).findByRole("menuitem", { name: "Invite to community" });
  expect(items(menu)).toEqual([
    "Mark all as read",
    "Copy community URL",
    "Invite to community",
    "Community settings",
    "Leave community",
  ]);
  expect(within(menu).getAllByRole("separator")).toHaveLength(2);
  expect(
    within(menu).getByRole("menuitem", { name: "Mark all as read" }),
  ).not.toHaveAttribute("aria-disabled");
  // Role comes from the relay-signed roster, exactly as the Membership card
  // reads it, verified against the authority the session already carries: the
  // read adds no session contract request to the connection.
  expect(h.read).toHaveBeenCalledWith(
    [{ kinds: [MEMBERSHIP_KIND], authors: [relayKey], limit: 1 }],
    expect.objectContaining({ fresh: true }),
  );
  expect(sessionRequests(h.fetch)).toEqual([]);
  expect(h.select).not.toHaveBeenCalled();
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  // An inactive community exposes the same menu without a session behind it.
  const reads = h.read.mock.calls.length;
  const inactive = await openMenu("Secondary");
  expect(items(inactive)).toEqual([
    "Mark all as read",
    "Copy community URL",
    "Community settings",
    "Leave community",
  ]);
  expect(within(inactive).getAllByRole("separator")).toHaveLength(2);
  const markAll = within(inactive).getByRole("menuitem", {
    name: "Mark all as read",
  });
  expect(markAll).toHaveAttribute("aria-disabled", "true");
  expect(markAll).toHaveAccessibleDescription(
    "Only the selected community can be marked as read.",
  );
  fireEvent.click(markAll);
  expect(h.markAllChannelsRead).not.toHaveBeenCalled();
  expect(h.read).toHaveBeenCalledTimes(reads);
  expect(sessionRequests(h.fetch)).toEqual([]);
  expect(h.select).not.toHaveBeenCalled();
});

it("offers no Invite and reads nothing while the session carries no relay authority", async () => {
  const h = harness({ relayAuthor: null });
  render(
    <CommunityRail
      communities={h.communities}
      onOpenTarget={h.onOpenTarget}
      settingsCards={settingsCards}
    />,
  );
  const menu = await openMenu("Primary");
  await act(async () => {});
  expect(items(menu)).toEqual([
    "Mark all as read",
    "Copy community URL",
    "Community settings",
    "Leave community",
  ]);
  // Without the session's authority there is nothing to verify a roster
  // against, and the broker is not asked to supply one.
  expect(h.read).not.toHaveBeenCalled();
  expect(sessionRequests(h.fetch)).toEqual([]);
});

it.each(["ContextMenu", "F10"])(
  "opens from the keyboard with %s and returns focus to the community",
  async (key) => {
    const h = harness();
    render(
      <CommunityRail
        communities={h.communities}
        onOpenTarget={h.onOpenTarget}
        settingsCards={settingsCards}
      />,
    );
    const target = button("Secondary");
    target.focus();
    fireEvent.keyDown(target, { key, shiftKey: key === "F10" });
    const menu = await screen.findByRole("menu", {
      name: "Actions for Secondary",
    });
    expect(h.select).not.toHaveBeenCalled();
    // Anchored beside the rail item, not at a cursor point.
    expect(menu).toHaveAttribute("data-side", "right");
    await waitFor(() =>
      expect(menu.contains(document.activeElement)).toBe(true),
    );
    fireEvent.keyDown(document.activeElement ?? menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(target));
  },
);

it("keeps the keyboard anchor when a synthesised contextmenu event re-enters the open", async () => {
  const h = harness();
  render(
    <CommunityRail
      communities={h.communities}
      onOpenTarget={h.onOpenTarget}
      settingsCards={settingsCards}
    />,
  );
  await waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
  const target = button("Primary");
  target.focus();
  fireEvent.keyDown(target, { key: "F10", shiftKey: true });
  const menu = await screen.findByRole("menu", { name: "Actions for Primary" });
  await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
  expect(menu).toHaveAttribute("data-side", "right");
  // Chromium and Firefox synthesise a contextmenu event for Shift+F10 unless the
  // keydown is cancelled; Base UI turns it into a second open request. The
  // menu is already open by then, so that request neither moves the anchor
  // to the synthesised pointer coordinates nor reads the roster a second time.
  fireEvent.contextMenu(target, { clientX: 20, clientY: 20 });
  await act(async () => {});
  expect(menu).toHaveAttribute("data-side", "right");
  expect(h.read).toHaveBeenCalledTimes(2);
  // A read scheduled by the re-entrant request would land after this flush.
  await act(async () => {});
  expect(h.read).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(document.activeElement ?? menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(target));
});

it("re-reads the roster for a keyboard open exactly as for a pointer open", async () => {
  const h = harness();
  render(
    <CommunityRail
      communities={h.communities}
      onOpenTarget={h.onOpenTarget}
      settingsCards={settingsCards}
    />,
  );
  // The selected community's roster is read once on mount.
  await waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
  const target = button("Primary");
  target.focus();
  fireEvent.keyDown(target, { key: "F10", shiftKey: true });
  const menu = await screen.findByRole("menu", { name: "Actions for Primary" });
  await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
  await within(menu).findByRole("menuitem", { name: "Invite to community" });
  fireEvent.keyDown(document.activeElement ?? menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await openMenu("Primary");
  await waitFor(() => expect(h.read).toHaveBeenCalledTimes(3));
});

it("returns focus after a pointer open to the field the right-click interrupted, not to the rail", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const h = harness();
  const ui = (composer: boolean) => (
    <>
      {composer && <input aria-label="Composer" />}
      <CommunityRail communities={h.communities} />
    </>
  );
  const { rerender } = render(ui(true));
  const composer = screen.getByRole("textbox", { name: "Composer" });
  const target = button("Primary");
  // Browsers focus the rail button on the right-click's mousedown, before the
  // contextmenu event opens the menu; jsdom only moves focus when asked to.
  const rightClick = () => {
    fireEvent.pointerDown(target, { button: 2 });
    target.focus();
    return openMenu("Primary");
  };
  composer.focus();
  const menu = await rightClick();
  expect(menu).toHaveAttribute("data-side", "bottom");
  expect(target).toHaveFocus();
  await user.click(
    within(menu).getByRole("menuitem", { name: "Copy community URL" }),
  );
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  // Right-clicking a community while typing must not leave the caret on the
  // rail, where the click itself put focus.
  await waitFor(() => expect(composer).toHaveFocus());
  expect(target).not.toHaveFocus();

  // A field gone by the time the menu closes cannot take focus back; Base UI's
  // default then lands on the rail button the right-click focused.
  composer.focus();
  const reopened = await rightClick();
  await waitFor(() =>
    expect(reopened.contains(document.activeElement)).toBe(true),
  );
  rerender(ui(false));
  expect(screen.queryByRole("textbox", { name: "Composer" })).toBeNull();
  fireEvent.keyDown(document.activeElement ?? reopened, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(target).toHaveFocus());
});

it("copies the canonical community origin and reports the outcome", async () => {
  const user = userEvent.setup();
  const write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error("denied"));
  const h = harness({ selected: secondary });
  render(<CommunityRail communities={h.communities} />);
  let menu = await openMenu("Primary");
  await user.click(
    within(menu).getByRole("menuitem", { name: "Copy community URL" }),
  );
  expect(write).toHaveBeenCalledWith(primary);
  const copied = await screen.findByText("Community URL copied.");
  expect(copied.closest(".buzz-toast")).not.toBeNull();
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  menu = await openMenu("Primary");
  await user.click(
    within(menu).getByRole("menuitem", { name: "Copy community URL" }),
  );
  await screen.findByText("Couldn’t copy the community URL.");
  expect(write).toHaveBeenCalledTimes(2);
  // Copying an inactive community's URL never acquired its session.
  expect(h.read).not.toHaveBeenCalled();
  expect(h.select).not.toHaveBeenCalled();
});

it("marks every channel read through the selected session and reports failures", async () => {
  const user = userEvent.setup();
  const h = harness();
  h.markAllChannelsRead
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error("disk full"));
  render(<CommunityRail communities={h.communities} />);
  let menu = await openMenu("Primary");
  await user.click(
    within(menu).getByRole("menuitem", { name: "Mark all as read" }),
  );
  expect(h.markAllChannelsRead).toHaveBeenCalledTimes(1);
  await screen.findByText("Marked all as read.");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  menu = await openMenu("Primary");
  await user.click(
    within(menu).getByRole("menuitem", { name: "Mark all as read" }),
  );
  await screen.findByText("Couldn’t mark everything as read.");
  expect(h.select).not.toHaveBeenCalled();
});

it.each([
  {
    name: "the connection is not ready",
    options: { status: "connecting" as const },
    note: "Waiting for Primary to connect.",
  },
  {
    name: "read state cannot sync",
    options: { capability: "unsupported" as const },
    note: "Read state can’t sync on this connection.",
  },
])("disables Mark all as read while $name", async ({ options, note }) => {
  const h = harness(options);
  render(<CommunityRail communities={h.communities} />);
  const menu = await openMenu("Primary");
  const markAll = within(menu).getByRole("menuitem", {
    name: "Mark all as read",
  });
  expect(markAll).toHaveAttribute("aria-disabled", "true");
  expect(markAll).toHaveAccessibleDescription(note);
  fireEvent.click(markAll);
  expect(h.markAllChannelsRead).not.toHaveBeenCalled();
});

it("opens Invites and Community settings scoped to the community", async () => {
  const user = userEvent.setup();
  const h = harness();
  render(
    <CommunityRail
      communities={h.communities}
      onOpenTarget={h.onOpenTarget}
      settingsCards={settingsCards}
    />,
  );
  let menu = await openMenu("Primary");
  await user.click(
    await within(menu).findByRole("menuitem", { name: "Invite to community" }),
  );
  expect(h.onOpenTarget).toHaveBeenLastCalledWith({
    version: 1,
    kind: "settings",
    section: MEMBERSHIP_SECTION,
    scope: { viewer, communityOrigin: primary },
  });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  // Settings for an inactive community: the scoped target selects it on the
  // way, so the rail itself neither selects nor connects.
  menu = await openMenu("Secondary");
  await user.click(
    within(menu).getByRole("menuitem", { name: "Community settings" }),
  );
  expect(h.onOpenTarget).toHaveBeenLastCalledWith({
    version: 1,
    kind: "settings",
    section: "profile",
    scope: { viewer, communityOrigin: secondary },
  });
  expect(h.onOpenTarget).toHaveBeenCalledTimes(2);
  expect(h.select).not.toHaveBeenCalled();
});

it.each([
  { role: "admin" as const, invites: true },
  { role: "member" as const, invites: false },
])(
  "shows Invite to community for a $role: $invites",
  async ({ role, invites }) => {
    const h = harness({ role });
    render(
      <CommunityRail
        communities={h.communities}
        onOpenTarget={h.onOpenTarget}
        settingsCards={settingsCards}
      />,
    );
    await waitFor(() => expect(h.read).toHaveBeenCalled());
    const menu = await openMenu("Primary");
    if (invites)
      await within(menu).findByRole("menuitem", {
        name: "Invite to community",
      });
    else {
      await within(menu).findByRole("menuitem", { name: "Community settings" });
      expect(
        within(menu).queryByRole("menuitem", { name: "Invite to community" }),
      ).toBeNull();
    }
  },
);

/** Opens the community's menu, picks Leave and waits for the confirmation. */
async function askToLeave(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  const menu = await openMenu(name);
  expect(items(menu).at(-1)).toBe("Leave community");
  await user.click(
    within(menu).getByRole("menuitem", { name: "Leave community" }),
  );
  const dialog = await screen.findByRole("alertdialog", {
    name: `Leave ${name}?`,
  });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  return dialog;
}
const confirmLeave = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: "Leave community" });

it("leaves an inactive community after confirming: the relay releases it before the device forgets it", async () => {
  const user = userEvent.setup();
  const h = harness();
  render(<CommunityRail communities={h.communities} />);
  const dialog = await askToLeave(user, "Secondary");
  expect(dialog).toHaveTextContent(
    "removes Secondary from this device along with its saved drafts and reading positions",
  );
  // Nothing is sent until the viewer confirms.
  expect(h.leaveRequests()).toEqual([]);
  expect(h.leave).not.toHaveBeenCalled();
  await user.click(confirmLeave(dialog));
  await screen.findByText("Left Secondary.");
  const route = `/api/relay/${encodeURIComponent(secondary)}/leave`;
  expect(h.leaveRequests()).toEqual([route]);
  expect(h.fetch).toHaveBeenCalledWith(
    route,
    expect.objectContaining({ method: "POST", body: "{}" }),
  );
  // The relay released the membership, so the device state goes with it.
  expect(h.leave).toHaveBeenCalledWith(secondary, { purge: true });
  const published =
    h.fetch.mock.invocationCallOrder[
      h.fetch.mock.calls.findIndex(([url]) => String(url) === route)
    ] ?? Infinity;
  expect(h.leave.mock.invocationCallOrder[0]).toBeGreaterThan(published);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(
    screen.queryByRole("button", { name: "Switch to Secondary" }),
  ).toBeNull();
  // The request went to the relay by origin; the community was never acquired
  // and the selection was never touched.
  expect(sessionRequests(h.fetch)).toEqual([]);
  expect(h.read).not.toHaveBeenCalled();
  expect(h.select).not.toHaveBeenCalled();
  expect(h.onSelect).not.toHaveBeenCalled();
  expect(button("Primary")).toHaveAttribute("aria-current", "true");
  // Focus follows the selection, which stayed put; Personal space is only
  // right when a left selection actually landed there.
  await waitFor(() => expect(button("Primary")).toHaveFocus());
  expect(
    screen.getByRole("button", { name: "Personal space" }),
  ).not.toHaveFocus();
});

it("leaving the selected community leaves the landing to the host's snapshot effect; the rail selects nothing itself", async () => {
  const user = userEvent.setup();
  const h = harness();
  render(<CommunityRail communities={h.communities} onSelect={h.onSelect} />);
  const dialog = await askToLeave(user, "Primary");
  await user.click(confirmLeave(dialog));
  await screen.findByText("Left Primary.");
  // The service dropped the selection with the membership; the host reacts to
  // that snapshot (as it does to a removal synced from another device), so the
  // rail asks for no selection of its own.
  expect(h.leave).toHaveBeenCalledWith(primary, { purge: true });
  expect(h.onSelect).not.toHaveBeenCalled();
  expect(h.select).not.toHaveBeenCalled();
  const personal = screen.getByRole("button", { name: "Personal space" });
  expect(personal).toHaveAttribute("aria-current", "true");
  await waitFor(() => expect(personal).toHaveFocus());
});

it("cancelling the confirmation keeps the membership and returns focus to the community", async () => {
  const user = userEvent.setup();
  const h = harness();
  render(<CommunityRail communities={h.communities} />);
  let dialog = await askToLeave(user, "Secondary");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(button("Secondary")).toHaveFocus());
  // Escape cancels the same way.
  dialog = await askToLeave(user, "Secondary");
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(h.leaveRequests()).toEqual([]);
  expect(h.leave).not.toHaveBeenCalled();
  expect(button("Secondary")).toBeInTheDocument();
  expect(sessionRequests(h.fetch)).toEqual([]);
  expect(h.select).not.toHaveBeenCalled();
});

it.each([
  {
    name: "the relay is unreachable",
    response: () => Response.json({ error: "upstream" }, { status: 503 }),
    toast: "Couldn’t leave Secondary. Check your connection and try again.",
  },
  {
    name: "the relay rejects the request for an unknown reason",
    response: () =>
      Response.json(
        { error: "invalid: database error: secret" },
        { status: 400 },
      ),
    toast: "Couldn’t leave Secondary. Check your connection and try again.",
  },
  {
    name: "the viewer owns the relay",
    response: () =>
      Response.json(
        { error: "invalid: relay owner cannot leave" },
        { status: 400 },
      ),
    toast: "The relay owner can’t leave Secondary.",
  },
  {
    name: "the request times out",
    response: () =>
      Promise.reject(new DOMException("timed out", "TimeoutError")),
    toast: "Couldn’t leave Secondary. Check your connection and try again.",
  },
])(
  "keeps the membership when $name and leaves the item usable",
  async ({ response, toast }) => {
    const user = userEvent.setup();
    const h = harness({ leaveResponse: response });
    render(<CommunityRail communities={h.communities} />);
    const dialog = await askToLeave(user, "Secondary");
    await user.click(confirmLeave(dialog));
    await screen.findByText(toast);
    expect(h.leaveRequests()).toHaveLength(1);
    expect(h.leave).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(button("Secondary")).toBeInTheDocument();
    await waitFor(() => expect(button("Secondary")).toHaveFocus());
    // The item is back to its resting label for a retry.
    const menu = await openMenu("Secondary");
    const item = within(menu).getByRole("menuitem", {
      name: "Leave community",
    });
    expect(item).not.toHaveAttribute("aria-disabled");
    expect(sessionRequests(h.fetch)).toEqual([]);
  },
);

const absent =
  "You were no longer a member of Secondary, so it was removed from this device.";
it.each([
  // The relay holds no membership, so nothing keyed to it is worth keeping.
  { error: "invalid: you are not a relay member", toast: absent, purge: true },
  {
    error: "invalid: relay membership is not enabled",
    toast: absent,
    purge: true,
  },
  {
    // The relay refuses a banned identity before any leave handler runs, so a
    // retry can do nothing while the ban lasts. Bans can be timed or lifted
    // and the relay keeps the membership meanwhile, so the device forgets the
    // community without purging the drafts and reading positions it would
    // reuse after a re-add, and the notice promises nothing permanent.
    error: "blocked: you are banned from this community",
    toast:
      "You’re currently banned from Secondary, so the leave was refused. It was removed from this device and can be added again by its URL if access is restored.",
    purge: false,
  },
])(
  "forgets a community whose relay answers $error and says so (purge: $purge)",
  async ({ error, toast, purge }) => {
    const user = userEvent.setup();
    const h = harness({
      leaveResponse: () => Response.json({ error }, { status: 400 }),
    });
    render(<CommunityRail communities={h.communities} />);
    const dialog = await askToLeave(user, "Secondary");
    await user.click(confirmLeave(dialog));
    const notice = await screen.findByText(toast);
    expect(notice.closest(".buzz-toast")).not.toBeNull();
    expect(notice.closest(".buzz-toast")).toHaveAttribute("data-type", "info");
    expect(h.leave).toHaveBeenCalledTimes(1);
    expect(h.leave).toHaveBeenCalledWith(secondary, { purge });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Switch to Secondary" }),
      ).toBeNull(),
    );
    expect(sessionRequests(h.fetch)).toEqual([]);
  },
);

it("reports a device that could not finish forgetting a left community without blaming the connection, naming the storage error", async () => {
  const user = userEvent.setup();
  const h = harness({
    // The service's wrapped save failure, with the storage error as its cause.
    leaveError: new Error(
      "Could not save this community on this device. Try again.",
      { cause: new Error("Setting the value exceeded the quota.") },
    ),
  });
  render(<CommunityRail communities={h.communities} onSelect={h.onSelect} />);
  const dialog = await askToLeave(user, "Secondary");
  await user.click(confirmLeave(dialog));
  // A store that never saves would otherwise show the identical promise on
  // every attempt; the storage error's own words tell the viewer why.
  const notice = await screen.findByText(
    "Left Secondary, but this device couldn’t finish cleaning up (Setting the value exceeded the quota). Leave it again to finish.",
  );
  expect(notice.closest(".buzz-toast")).toHaveAttribute("data-type", "error");
  expect(
    screen.queryByText(
      "Couldn’t leave Secondary. Check your connection and try again.",
    ),
  ).toBeNull();
  // The relay released the membership; only the device record failed, so the
  // community stays in the rail for the retry that reaches the absent path.
  expect(h.leaveRequests()).toHaveLength(1);
  expect(h.leave).toHaveBeenCalledWith(secondary, { purge: true });
  expect(h.onSelect).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(button("Secondary")).toBeInTheDocument();
  await waitFor(() => expect(button("Secondary")).toHaveFocus());
});

it("falls back to the save failure's own message when it carries no cause", async () => {
  const user = userEvent.setup();
  const h = harness({ leaveError: new Error("Storage is read-only.") });
  render(<CommunityRail communities={h.communities} />);
  const dialog = await askToLeave(user, "Secondary");
  await user.click(confirmLeave(dialog));
  await screen.findByText(
    "Left Secondary, but this device couldn’t finish cleaning up (Storage is read-only). Leave it again to finish.",
  );
  expect(button("Secondary")).toBeInTheDocument();
});

it("says when some saved data outlived the purge", async () => {
  const user = userEvent.setup();
  const h = harness({
    leaveResidue: [{ store: "outbox", error: new Error("blocked") }],
  });
  render(<CommunityRail communities={h.communities} />);
  const dialog = await askToLeave(user, "Secondary");
  await user.click(confirmLeave(dialog));
  const notice = await screen.findByText(
    "Left Secondary. Some saved data couldn’t be cleared.",
  );
  expect(notice.closest(".buzz-toast")).toHaveAttribute("data-type", "success");
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Switch to Secondary" }),
    ).toBeNull(),
  );
});

it("shows the leave in flight on the dialog and the menu item until the relay answers", async () => {
  const user = userEvent.setup();
  let release!: (response: Response) => void;
  const h = harness({
    leaveResponse: () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  });
  render(<CommunityRail communities={h.communities} />);
  const dialog = await askToLeave(user, "Secondary");
  const confirm = confirmLeave(dialog);
  await user.click(confirm);
  await waitFor(() => expect(h.leaveRequests()).toHaveLength(1));
  expect(confirm).toHaveAttribute("aria-busy", "true");
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  // Closing is refused while the request runs.
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.getByRole("alertdialog")).toBe(dialog);
  // The modal hides the rail from assistive tech; should the menu open
  // regardless, its item reports the flight and does not start another request.
  fireEvent.contextMenu(
    screen.getByRole("button", { name: "Switch to Secondary", hidden: true }),
    { clientX: 20, clientY: 20 },
  );
  const menu = await screen.findByRole("menu", {
    name: "Actions for Secondary",
    hidden: true,
  });
  const item = within(menu).getByRole("menuitem", {
    name: "Leaving…",
    hidden: true,
  });
  expect(item).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(item);
  expect(h.leaveRequests()).toHaveLength(1);
  release(accepted());
  await screen.findByText("Left Secondary.");
  expect(h.leave).toHaveBeenCalledTimes(1);
});

it("leaving the selected community lands on Personal space, and the last one leaves only Personal space and Add", async () => {
  const user = userEvent.setup();
  const h = harness();
  render(<CommunityRail communities={h.communities} />);
  let dialog = await askToLeave(user, "Primary");
  await user.click(confirmLeave(dialog));
  await screen.findByText("Left Primary.");
  expect(h.leave).toHaveBeenCalledWith(primary, { purge: true });
  const personal = screen.getByRole("button", { name: "Personal space" });
  expect(personal).toHaveAttribute("aria-current", "true");
  await waitFor(() => expect(personal).toHaveFocus());
  // The service owns the fallback; the rail itself selected nothing.
  expect(h.select).not.toHaveBeenCalled();

  dialog = await askToLeave(user, "Secondary");
  await user.click(confirmLeave(dialog));
  await screen.findByText("Left Secondary.");
  const rail = screen.getByRole("navigation", { name: "Communities" });
  await waitFor(() =>
    expect(
      within(rail)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Personal space", "Add a community"]),
  );
  expect(h.leaveRequests()).toEqual([
    `/api/relay/${encodeURIComponent(primary)}/leave`,
    `/api/relay/${encodeURIComponent(secondary)}/leave`,
  ]);
});

it("says that the community list is not synced while uploads wait, and why", async () => {
  const user = userEvent.setup();
  const h = harness();
  const op = {
    operationId: "0f3d6b1e-6d2a-4f5b-9c1e-2a7d8e9f0a1b",
    url: "wss://primary.example",
    expectedRevision: 0,
    removed: false,
  };
  h.update({ sync: { known: {}, outbox: [op] } });
  render(<CommunityRail communities={h.communities} />);
  // No sync owner has reported (no Builderlab plugin, no configured service,
  // or a browser build): the queue is nobody's promise, so nothing is said.
  expect(screen.queryByRole("status")).toBeNull();
  // An owner that is signed out: signing in is what would drain the queue.
  h.update({ syncStatus: { phase: "signed-out", pending: 1 } });
  const status = screen.getByRole("status");
  expect(status).toHaveTextContent(
    "Community list not synced. Sign in to Builderlab to sync your community list.",
  );
  await user.hover(status);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Sign in to Builderlab to sync your community list.",
  );
  for (const [syncStatus, reason] of [
    [{ phase: "syncing", pending: 1 }, "Syncing your community list…"],
    [
      { phase: "pending", pending: 1 },
      "Changes to your community list are waiting to sync.",
    ],
    [
      {
        phase: "error",
        pending: 1,
        error: "Builderlab can’t save more communities for this account.",
      },
      "Builderlab can’t save more communities for this account.",
    ],
  ] as const) {
    h.update({ syncStatus });
    expect(screen.getByRole("status")).toHaveTextContent(reason);
  }
  // The acknowledged upload leaves nothing to say.
  h.update({
    sync: { known: { [op.url]: { revision: 1, removed: false } }, outbox: [] },
    syncStatus: { phase: "synced", pending: 0 },
  });
  expect(screen.queryByRole("status")).toBeNull();
  // An account bound to another key cannot take this list even with an empty queue.
  h.update({ syncStatus: { phase: "needs-binding", pending: 0 } });
  expect(screen.getByRole("status")).toHaveTextContent(
    "Link this device’s identity to your Builderlab account in Hosted communities",
  );
  expect(
    screen.getByRole("navigation", { name: "Communities" }),
  ).toContainElement(screen.getByRole("status"));
  // The owner withdrawing its report (plugin disabled) withdraws the indicator.
  h.update({ syncStatus: undefined, sync: { known: {}, outbox: [op] } });
  expect(screen.queryByRole("status")).toBeNull();
});

it("does not discover saved community icons without a relay host", async () => {
  const viewer = "e".repeat(64);
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Local", picture: "" },
      memberships: [{ id: "https://saved.example", name: "Saved" }],
      selected: "https://saved.example",
    }),
  );
  const ctx = new Context();
  vi.stubGlobal("fetch", vi.fn());
  const communities = createCommunities(
    ctx,
    false,
    undefined,
    "",
    undefined,
    Promise.resolve(viewer),
  );
  try {
    await waitFor(() => expect(communities.snapshot().status).toBe("ready"));
    render(<CommunityRail communities={communities} />);
    expect(
      screen.getByRole("button", { name: "Switch to Saved" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add a community" }));
    expect(
      screen.getByText(/connecting to communities is not available/),
    ).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    cleanup();
    await ctx.fiber.dispose();
  }
});

it("removes the Invite shortcut with its Settings contribution and restores it on re-enable", async () => {
  const h = harness();
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const cards = new SettingsCardsService(root);
  const register = () =>
    root
      .extend({ pluginOwner: { id: "buzz.moderation", revision: "bundled" } })
      .plugin((ctx) => {
        ctx.settingsCards.register({
          id: "membership",
          title: "Membership",
          component: () => null,
          visibility: {
            snapshot: () => false,
            subscribe: () => () => {},
            ensure: () => () => {},
          },
        });
      });
  try {
    render(
      <CommunityRail
        communities={h.communities}
        onOpenTarget={h.onOpenTarget}
        settingsCards={cards}
      />,
    );
    const menu = await openMenu("Primary");
    expect(
      within(menu).queryByRole("menuitem", { name: "Invite to community" }),
    ).toBeNull();
    expect(h.read).not.toHaveBeenCalled();
    let fiber: ReturnType<typeof register>;
    await act(async () => {
      fiber = register();
      await fiber.await();
    });
    await within(menu).findByRole("menuitem", { name: "Invite to community" });
    await act(async () => {
      await fiber.dispose();
    });
    expect(
      within(menu).queryByRole("menuitem", { name: "Invite to community" }),
    ).toBeNull();
    expect(
      within(menu).getByRole("menuitem", { name: "Community settings" }),
    ).toBeInTheDocument();
    expect(h.onOpenTarget).not.toHaveBeenCalled();
    await act(async () => {
      fiber = register();
      await fiber.await();
    });
    fireEvent.click(
      await within(menu).findByRole("menuitem", {
        name: "Invite to community",
      }),
    );
    expect(h.onOpenTarget).toHaveBeenCalledWith({
      version: 1,
      kind: "settings",
      section: MEMBERSHIP_SECTION,
      scope: { viewer, communityOrigin: primary },
    });
  } finally {
    cleanup();
    await root.fiber.dispose();
  }
});

it("opens a deep-link invite on Personal space without claiming until the user continues", async () => {
  const t = harness();
  t.update({ selected: null });
  const onInviteClose = vi.fn();
  render(
    <CommunityRail
      communities={t.communities}
      invite={{
        community: "https://invited.example",
        code: "v2.invite",
        requestId: 1,
      }}
      onInviteClose={onInviteClose}
      onSelect={t.onSelect}
    />,
  );
  expect(screen.getByLabelText("Relay URL")).toHaveValue(
    "https://invited.example",
  );
  expect(
    t.fetch.mock.calls.some(([url]) => String(url).includes("/claim")),
  ).toBe(false);
  expect(t.select).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(onInviteClose).toHaveBeenCalledWith(1);
  expect(t.select).not.toHaveBeenCalled();
});
