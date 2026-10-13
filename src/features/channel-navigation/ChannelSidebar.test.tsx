// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi, assert } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { createRelaySession } from "../relay/session";
import { createSidebarPreferencesStore } from "../relay/sidebar-preferences-store";
import type {
  SidebarGroups,
  SidebarPreferences,
} from "../relay/sidebar-preferences";
import type { RelayData, RelaySnapshot } from "../relay/service";
import type { ChannelList } from "../relay/contracts";
import type { Navigation } from "../navigation/controller";
import { createRef, type ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { ChannelHeaderMenu } from "../../bundled/channels/ChannelHeaderMenu";
import { ChannelSidebar } from "./ChannelSidebar";
import { buzzLinkTarget } from "../navigation/buzz-links";
import { ChannelNavigationProvider } from "./ChannelNavigationState";
import { readView, writeView } from "../../shared/view-state";
import styles from "../../bundled/channels/Channels.module.css";

const { rowRender, menuRender } = vi.hoisted(() => ({
  rowRender: vi.fn(),
  menuRender: vi.fn(),
}));
// Observe the real row below ChannelSidebarItem's production memo boundary.
// React hooks, the parent, the item and the row implementation remain real.
vi.mock("../../bundled/channels/ChannelSidebarRow", async (original) => {
  const actual =
    await original<typeof import("../../bundled/channels/ChannelSidebarRow")>();
  return {
    ...actual,
    ChannelSidebarRow: (
      props: Parameters<typeof actual.ChannelSidebarRow>[0],
    ) => {
      rowRender(props);
      return <actual.ChannelSidebarRow {...props} />;
    },
  };
});
// Observe the real row menu provider and popup the same way.
vi.mock("../../shared/design-system/ui/Menu", async (original) => {
  const actual =
    await original<typeof import("../../shared/design-system/ui/Menu")>();
  return {
    ...actual,
    ContextMenuRoot: (props: Parameters<typeof actual.ContextMenuRoot>[0]) => {
      menuRender("root", props);
      return <actual.ContextMenuRoot {...props} />;
    },
    MenuPopup: (props: Parameters<typeof actual.MenuPopup>[0]) => {
      menuRender("popup", props);
      return <actual.MenuPopup {...props} />;
    },
  };
});
beforeEach(() => {
  // jsdom has no layout; browser journeys own geometry. Only supply the API.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function fixture(
  sidebarPreferences?: ReturnType<
    typeof createSidebarPreferencesStore
  >["queries"],
  status: RelaySnapshot["status"] = "ready",
  initialChannels: ChannelList["channels"] = [
    { id: "alpha", name: "alpha", channelType: "stream" },
    { id: "beta", name: "beta", channelType: "stream" },
    { id: "gamma", name: "gamma", channelType: "stream" },
  ],
) {
  const owner = createRelaySession(null);
  owners.push(owner);
  let list: ChannelList = {
    status: "ready",
    channels: initialChannels.map((channel) => ({
      space: "collaborative",
      ...channel,
    })),
  };
  const listeners = new Set<() => void>();
  const live = {
    ...owner.session.live.snapshot(),
    roster: { state: "verified" as const },
  };
  const session = {
    ...owner.session,
    ...(sidebarPreferences ? { sidebarPreferences } : {}),
    live: { ...owner.session.live, snapshot: () => live },
    channels: {
      ...owner.session.channels,
      list: () => list,
      ensureList() {},
      subscribeList(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  // Like the store: changed summaries are replaced, the rest keep identity.
  const publish = (
    id: string,
    change: Partial<ChannelList["channels"][number]>,
  ) =>
    act(() => {
      list = {
        ...list,
        channels: list.channels.map((channel) =>
          channel.id === id ? { ...channel, ...change } : channel,
        ),
      };
      for (const listener of listeners) listener();
    });
  const snapshot: RelaySnapshot = {
    status,
    ...(status === "ready"
      ? { scope: "https://relay.test:viewer", viewer: "viewer" }
      : {}),
    generation: 1,
    session,
  };
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    async clearCache() {},
  } satisfies RelayData;
  const navigator = {
    open: vi.fn().mockResolvedValue({ status: "opened" }),
  } as unknown as Navigation;
  const view = (
    id: string,
    sessionsEnabled = true,
    pages: ReactNode = (
      <nav aria-label="Pages">
        <button type="button">Projects</button>
      </nav>
    ),
  ) => (
    <ToastProvider>
      <ChannelNavigationProvider relay={relay}>
        <ChannelSidebar
          relay={relay}
          navigator={navigator}
          target={{
            version: 1,
            kind: "conversation",
            channelId: id,
            scope: { viewer: "viewer", communityOrigin: "https://relay.test" },
          }}
          sessionsEnabled={sessionsEnabled}
        >
          {pages}
        </ChannelSidebar>
      </ChannelNavigationProvider>
    </ToastProvider>
  );
  return { view, navigator, snapshot, list, session, publish };
}

it("does not rebuild unchanged rows on channel switches or plugin toggles", async () => {
  const h = fixture();
  const mounted = render(h.view("alpha"));
  await screen.findByRole("button", { name: "gamma" });
  rowRender.mockClear();
  menuRender.mockClear();
  mounted.rerender(h.view("beta"));
  expect(rowRender.mock.calls.map(([props]) => props.channel.id)).not.toContain(
    "gamma",
  );
  // Unchanged rows keep their menu provider and popup behind the memo too.
  expect(
    menuRender.mock.calls.filter(([, props]) =>
      String(props["aria-label"] ?? "").includes("gamma"),
    ),
  ).toEqual([]);
  expect(
    menuRender.mock.calls.filter(([kind]) => kind === "root"),
  ).toHaveLength(rowRender.mock.calls.length);
  expect(screen.getByRole("button", { name: "beta" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(screen.getByRole("button", { name: "alpha" })).not.toHaveAttribute(
    "aria-current",
  );
  const alpha = rowRender.mock.calls.find(
    ([props]) => props.channel.id === "alpha",
  )?.[0];
  expect(alpha).toBeDefined();
  // Plugin toggles cannot restore nested-session creation.
  rowRender.mockClear();
  mounted.rerender(h.view("beta", false));
  alpha.onNewSession("alpha");
  expect(h.navigator.open).not.toHaveBeenCalled();
  // Ordinary selection still uses the current session and navigator.
  fireEvent.click(screen.getByRole("button", { name: "gamma" }));
  expect(h.navigator.open).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "conversation", channelId: "gamma" }),
  );
});

it("rebuilds only the changed row on a list publish and never starts nested sessions", async () => {
  const h = fixture();
  render(h.view("alpha"));
  await screen.findByRole("button", { name: "gamma" });
  const alpha = rowRender.mock.calls
    .filter(([props]) => props.channel.id === "alpha")
    .pop()?.[0];
  rowRender.mockClear();
  h.publish("beta", { preview: "hello" });
  expect(rowRender.mock.calls.map(([props]) => props.channel.id)).toEqual([
    "beta",
  ]);
  // The callbacks alpha kept must still see the published list.
  h.publish("gamma", { readOnly: true });
  alpha.onNewSession("gamma");
  expect(h.navigator.open).not.toHaveBeenCalled();
  alpha.onNewSession("beta");
  expect(h.navigator.open).not.toHaveBeenCalled();
});

it("copies a channel link that opens the same channel", async () => {
  const writeText = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("denied"));
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  const h = fixture();
  render(h.view("alpha"));
  const copy = async () => {
    fireEvent.keyDown(await screen.findByRole("button", { name: "beta" }), {
      key: "ContextMenu",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy link" }));
  };
  await copy();
  expect(await screen.findByText("Link copied.")).toBeInTheDocument();
  const [link] = writeText.mock.calls[0] ?? [];
  expect(link).toBe("buzz://channel/beta");
  expect(
    buzzLinkTarget(link, {
      viewer: "a".repeat(64),
      communityOrigin: "https://relay.test",
    }),
  ).toMatchObject({ kind: "conversation", channelId: "beta" });
  await copy();
  expect(
    await screen.findByText("Couldn’t copy the link."),
  ).toBeInTheDocument();
});

it("offers DMs a Move conversation menu and relocates them into a saved group", async () => {
  const saved: SidebarPreferences = {
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: {},
    starred: [],
    muted: [],
  };
  let assignments: Record<string, string> = {};
  const read = vi.fn(async () => ({ ...saved, assignments }));
  const write = vi.fn(
    async (intent: { channelId: string; sectionId?: string }) => {
      const changedAssignments = intent.sectionId
        ? { ...assignments, [intent.channelId]: intent.sectionId }
        : Object.fromEntries(
            Object.entries(assignments).filter(
              ([id]) => id !== intent.channelId,
            ),
          );
      assignments = changedAssignments;
      return { sections: saved.sections, assignments };
    },
  );
  const star = vi.fn(async () => []);
  const preferences = createSidebarPreferencesStore(read, true, write, star);
  await preferences.queries.ensure();
  const h = fixture(preferences.queries, "ready", [
    { id: "alpha", name: "alpha", channelType: "stream" },
    { id: "dm", name: "Alice", channelType: "dm" },
  ]);
  const user = userEvent.setup();
  try {
    render(h.view("alpha"));
    await screen.findByRole("button", { name: "Alice" });
    const row = screen.getByRole("button", { name: "Alice" });
    fireEvent.keyDown(row, { key: "ContextMenu" });
    await user.hover(
      await screen.findByRole("menuitem", { name: "Move conversation" }),
    );
    expect(
      await screen.findByRole("menuitemradio", { name: "Direct messages" }),
    ).toBeChecked();
    await screen.findByRole("menuitemradio", { name: "Work" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Work" }));
    await waitFor(() =>
      expect(write).toHaveBeenCalledWith(
        { channelId: "dm", sectionId: "work" },
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() => {
      expect(
        document.querySelector('[data-sidebar-section="group:work"]'),
      ).toContainElement(screen.getByRole("button", { name: "Alice" }));
      expect(
        document.querySelector('[data-sidebar-section="dms"]'),
      ).not.toContainElement(screen.queryByRole("button", { name: "Alice" }));
    });
    fireEvent.keyDown(screen.getByRole("button", { name: "Alice" }), {
      key: "ContextMenu",
    });
    await user.hover(
      await screen.findByRole("menuitem", { name: "Move conversation" }),
    );
    expect(
      await screen.findByRole("menuitemradio", { name: "Work" }),
    ).toBeChecked();
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "Direct messages" }),
    );
    await waitFor(() => {
      expect(
        document.querySelector('[data-sidebar-section="dms"]'),
      ).toContainElement(screen.getByRole("button", { name: "Alice" }));
      expect(
        document.querySelector('[data-sidebar-section="group:work"]'),
      ).not.toContainElement(screen.queryByRole("button", { name: "Alice" }));
    });
    expect(write).toHaveBeenLastCalledWith(
      { channelId: "dm" },
      expect.any(AbortSignal),
    );
    expect(star).toHaveBeenLastCalledWith(
      { channelId: "dm", starred: false },
      expect.any(AbortSignal),
    );
  } finally {
    preferences.dispose();
  }
});

async function failedMoveFixture() {
  const data: SidebarPreferences = {
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: { beta: "work" },
    starred: [],
    muted: [],
  };
  const read = vi.fn(async () => data);
  const write = vi.fn(async () => {
    throw new Error("offline");
  });
  const star = vi.fn(async () => []);
  const owner = createSidebarPreferencesStore(read, true, write, star);
  const prefs = owner.queries;
  await prefs.ensure();
  await expect(prefs.assign("beta")).rejects.toThrow("offline");
  const h = fixture(prefs);
  const mounted = render(h.view("alpha"));
  const notice = await screen.findByRole("alert");
  expect(notice).toHaveTextContent("Couldn’t save the move for beta. offline");
  return { ...h, owner, prefs, read, write, star, data, notice, mounted };
}

it("explains and disables unavailable move retries, then enables them after preference recovery", async () => {
  const h = await failedMoveFixture();
  try {
    h.read.mockRejectedValueOnce(new Error("refresh failed"));
    await act(() => h.prefs.refresh());
    const retry = within(h.notice).getByRole("button", { name: "Retry move" });
    expect(retry).toBeDisabled();
    expect(h.notice).toHaveTextContent(
      "Refresh saved sidebar preferences before retrying this move.",
    );
    // Direct/stale callers also publish their rejection, not just a rejected promise.
    await act(async () => {
      await expect(h.prefs.retryMove("beta")).rejects.toThrow(
        "refresh saved sidebar preferences before retrying",
      );
    });
    expect(h.notice).not.toHaveTextContent("offline");
    expect(h.notice).toHaveTextContent("Sidebar group moves are unavailable");
    expect(h.write).toHaveBeenCalledOnce();
    expect(h.star).not.toHaveBeenCalled();
    await act(() => h.prefs.refresh());
    expect(retry).toBeEnabled();
    expect(h.notice).not.toHaveTextContent(
      "Refresh saved sidebar preferences before retrying this move.",
    );
  } finally {
    h.owner.dispose();
  }
});

it.each(["ready", "error"] as const)(
  "keeps the supplied page navigation while the relay is %s",
  (status) => {
    const h = fixture(undefined, status);
    render(h.view("alpha"));
    const pages = screen.getByRole("navigation", { name: "Pages" });
    expect(
      within(pages).getByRole("button", { name: "Projects" }),
    ).toBeVisible();
    expect(pages.closest(`.${styles.destinations}`)).not.toBeNull();
  },
);

it.each(["ready", "connecting"] as const)(
  "omits the page destinations wrapper when the shell passes none while %s",
  (status) => {
    const h = fixture(undefined, status);
    const { container } = render(h.view("alpha", true, null));
    expect(screen.queryByRole("navigation", { name: "Pages" })).toBeNull();
    expect(container.querySelector(`.${styles.destinations}`)).toBeNull();
    expect(screen.getByRole("img", { name: "Buzz" })).toBeInTheDocument();
  },
);

it.each([true, false])(
  "uses only the invoking section for placement (group: %s)",
  async (fromGroup) => {
    const preferences = createSidebarPreferencesStore(
      async () => ({
        sections: [{ id: "laptop", name: "Laptop", icon: "💻", order: 0 }],
        assignments: { beta: "laptop" },
        starred: [],
        muted: [],
      }),
      true,
      async () => ({
        sections: [{ id: "laptop", name: "Laptop", icon: "💻", order: 0 }],
        assignments: {},
      }),
      async () => [],
    );
    await preferences.queries.ensure();
    const h = fixture(preferences.queries);
    const create = vi.fn(async () => "new-channel");
    h.session.channelKit = {
      ...h.session.channelKit,
      available: true,
      ensure() {},
    };
    h.session.channelCreation = {
      ...h.session.channelCreation,
      available: true,
      create,
    };
    try {
      render(h.view("beta"));
      await screen.findByRole("button", { name: /Laptop/ });
      // An active grouped channel must not make the general Channels + inherit it.
      const header = screen.getByRole("button", {
        name: fromGroup ? /Laptop/ : "More actions for Channels",
      }).parentElement;
      assert.exists(header);
      fireEvent.click(
        within(header).getByRole("button", { name: "Create channel" }),
      );
      expect(
        screen.queryByRole("combobox", { name: "Destination group" }),
      ).not.toBeInTheDocument();
      const title = fromGroup
        ? "Create a channel in Laptop"
        : "Create a channel";
      expect(screen.getByRole("dialog")).toHaveAccessibleName(title);
      if (fromGroup)
        expect(
          screen
            .getByRole("dialog")
            .querySelector(".buzz-dialog-step [data-sidebar-group-icon]"),
        ).toHaveTextContent("💻");
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
        target: { value: "New laptop channel" },
      });
      fireEvent.click(
        within(screen.getByRole("dialog", { name: title })).getByRole(
          "button",
          {
            name: "Create channel",
          },
        ),
      );
      await waitFor(() =>
        expect(create).toHaveBeenCalledWith({
          name: "New laptop channel",
          visibility: "open",
          ...(fromGroup
            ? {
                setup: {
                  agents: [],
                  canvas: "",
                  templateId: "",
                  groupId: "laptop",
                },
              }
            : {}),
        }),
      );
    } finally {
      preferences.dispose();
    }
  },
);

it("rejects a deferred header Create section after its navigation origin retires", async () => {
  const preferences = createSidebarPreferencesStore(
    async () => ({
      sections: [],
      assignments: {},
      starred: [],
      muted: [],
    }),
    true,
    vi.fn(async () => ({ sections: [], assignments: {} })),
    vi.fn(async () => []),
  );
  await preferences.queries.ensure();
  const h = fixture(preferences.queries);
  const origin = new AbortController();
  const user = userEvent.setup();
  render(
    h.view(
      "alpha",
      true,
      <ChannelHeaderMenu
        channel={h.list.channels[0]}
        session={h.session}
        origin={origin.signal}
        trigger={createRef<HTMLButtonElement>()}
        openDetails={() => {}}
        openCanvas={() => {}}
      />,
    ),
  );
  await user.click(screen.getByRole("button", { name: "Channel actions" }));
  await user.hover(
    await screen.findByRole("menuitem", { name: "Move channel" }),
  );
  const create = await screen.findByRole("menuitem", { name: "Create new…" });
  // Hold only the deferred handoff after the menu is ready, not a timing delay.
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  fireEvent.click(create);
  expect(frames.length).toBeGreaterThan(0);
  act(() => {
    origin.abort();
    for (const frame of frames.splice(0)) frame(0);
  });
  expect(
    screen.queryByRole("dialog", { name: "Create new section" }),
  ).not.toBeInTheDocument();
  expect(preferences.queries.snapshot().data?.sections).toEqual([]);
  preferences.dispose();
});

it("clears only the removed section's collapsed intent after confirmation, never on cancel or failure", async () => {
  const user = userEvent.setup();
  const current: SidebarPreferences = {
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: { beta: "work" },
    starred: [],
    muted: [],
  };
  let resolve!: (value: SidebarGroups) => void;
  const pending = new Promise<SidebarGroups>((yes) => {
    resolve = yes;
  });
  const remove = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockReturnValueOnce(pending);
  const preferences = createSidebarPreferencesStore(
    async () => current,
    true,
    async () => current,
    async () => [],
    undefined,
    undefined,
    async () => ({}),
    undefined,
    remove,
  );
  try {
    await preferences.queries.ensure();
    const h = fixture(preferences.queries);
    const scope = h.snapshot.scope;
    assert.exists(scope);
    writeView(scope, "channel-sidebar", {
      collapsed: ["group:work", "dms"],
      scrollTop: 0,
      width: 287,
    });
    const mounted = render(h.view("alpha"));
    const open = async () => {
      await user.click(
        await screen.findByRole("button", { name: "More actions for Work" }),
      );
      await user.click(
        await screen.findByRole("menuitem", { name: "Remove section" }),
      );
      return screen.getByRole("dialog", { name: "Remove Work?" });
    };
    let dialog = await open();
    expect(dialog).toHaveAccessibleDescription(
      "1 channel will move back to Channels. This does not delete any channels.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(remove).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText("Work").closest("details"),
    ).not.toHaveAttribute("open");
    dialog = await open();
    await user.click(
      within(dialog).getByRole("button", { name: "Remove section" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "offline",
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    mounted.unmount();
    expect(readView(scope, "channel-sidebar", {})).toMatchObject({
      collapsed: ["group:work", "dms"],
      width: 287,
    });
    const retry = render(h.view("alpha"));
    dialog = await open();
    await user.click(
      within(dialog).getByRole("button", { name: "Remove section" }),
    );
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
    expect(dialog).toBeVisible();
    expect(readView(scope, "channel-sidebar", {})).toMatchObject({
      collapsed: ["group:work", "dms"],
    });
    await act(async () => {
      resolve({ sections: [], assignments: {} });
      await pending;
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    retry.unmount();
    expect(readView(scope, "channel-sidebar", {})).toMatchObject({
      collapsed: ["dms"],
      width: 287,
    });
  } finally {
    resolve?.({ sections: [], assignments: {} });
    preferences.dispose();
  }
});
it.each([true, false])(
  "does not nest existing sessions when plugin enabled=%s",
  async (enabled) => {
    const h = fixture();
    h.publish("beta", { channelType: "session", parentChannelId: "alpha" });
    render(h.view("alpha", enabled));
    await screen.findByRole("button", { name: "gamma" });
    expect(
      screen.queryByRole("button", { name: /sessions in alpha/ }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /beta, session/ })).toBeNull();
    expect(
      rowRender.mock.calls.every(
        ([props]) => !props.sessions.length && !props.draft,
      ),
    ).toBe(true);
  },
);

it.each([true, false])(
  "legacy session row uses verified lifecycle permissions (owner=%s)",
  async (owner) => {
    const h = fixture();
    h.publish("beta", { channelType: "session", private: true });
    const load = vi.fn(async () => ({
      channelId: "beta",
      channelType: "stream" as const,
      canArchive: owner,
      canUnarchive: false,
      canDelete: owner,
      canLeave: !owner,
      canHide: false,
    }));
    const run = vi.fn();
    h.session.channelLifecycle = {
      ...h.session.channelLifecycle,
      available: true,
      load,
      run,
    };
    render(h.view("beta"));
    const row = await screen.findByRole("button", { name: "beta" });
    const user = userEvent.setup();
    row.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    const menu = await screen.findByRole("menu", { name: "Actions for beta" });
    await within(menu).findByRole("menuitem", {
      name: owner ? "Delete channel" : "Leave channel",
    });
    expect(
      !!within(menu).queryByRole("menuitem", { name: "Archive channel" }),
    ).toBe(owner);
    expect(
      !!within(menu).queryByRole("menuitem", { name: "Delete channel" }),
    ).toBe(owner);
    expect(load).toHaveBeenCalledWith("beta", expect.any(AbortSignal));
    expect(run).not.toHaveBeenCalled();
  },
);
