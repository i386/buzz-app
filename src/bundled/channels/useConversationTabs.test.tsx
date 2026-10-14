// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
import { afterEach, expect, it } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import type {
  PanelContext,
  Panels,
  RegisteredPanel,
} from "../../features/panels/service";
import { useChannelTabState } from "./useChannelTabState";
import { useConversationTabs } from "./useConversationTabs";

afterEach(cleanup);
it("retained offline tabs can close and open threads without activating connected plugins", () => {
  const channels = [
    { id: "alpha", name: "Alpha" },
    { id: "beta", name: "Beta" },
  ];
  const session = {
    viewer: "viewer",
    channels: {
      list: () => ({ channels }),
      window: () => ({
        rows: [{ id: "root", content: "Original message title" }],
      }),
    },
  } as unknown as RelaySession;
  const panel = { key: "activity", title: "Activity" } as RegisteredPanel;
  const available = [panel];
  const panels = {
    snapshot: () => available,
    subscribe: () => () => {},
    resolve: () => panel,
  } as unknown as Panels;
  const snapshot = { status: "connecting", session };
  const relay = { snapshot: () => snapshot } as unknown as RelayData;
  const h = renderHook(() => {
    const state = useChannelTabState(session, "alpha");
    const workspace = useConversationTabs({
      state,
      relay,
      session,
      panels,
      current: channels[0],
      channels,
      scope: "scope:viewer",
      conversationIcon: () => null,
      leadingIds: [],
      continuingVisit: true,
      isLive: () => false,
      openLink: () => false,
    });
    return { state, workspace };
  });
  const entry = { panel, channelId: "alpha", target: "activity" };
  act(() => h.result.current.workspace.open(entry));
  expect(h.result.current.workspace.items).toHaveLength(1);
  expect(
    h.result.current.workspace.openConversationLink("alpha", "activity"),
  ).toBe(false);
  act(() => h.result.current.workspace.closeTab(entry));
  expect(h.result.current.state.entries).toEqual([]);
  act(() =>
    h.result.current.workspace.openConversationThread("beta", "root", "root"),
  );
  expect(h.result.current.state.tabs).toHaveLength(1);
  act(() => h.result.current.state.openThreadTab("alpha", "reply", "hint"));
  act(() =>
    h.result.current.state.resolveThreadRoot("thread:alpha:hint", "root"),
  );
  expect(
    h.result.current.workspace.items.find(
      (tab) => tab.id === "thread:alpha:hint",
    )?.label,
  ).toBe("Original message title");
  const staleOpen = h.result.current.workspace.openConversationThread;
  h.unmount();
  act(() => staleOpen("beta", "another-root", "another-root"));
  const restored = renderHook(() => useChannelTabState(session, "alpha"));
  expect(restored.result.current.tabs).toHaveLength(2);
});

it("gives a panel the thread its link was opened from, retargeting a reopened tab", () => {
  const channels = [{ id: "alpha", name: "Alpha" }];
  const session = {
    viewer: "viewer",
    channels: { list: () => ({ channels }) },
  } as unknown as RelaySession;
  const panel = { key: "profile", title: "Profile" } as RegisteredPanel;
  const available = [panel];
  const panels = {
    snapshot: () => available,
    subscribe: () => () => {},
    resolve: () => panel,
  } as unknown as Panels;
  const snapshot = { status: "ready", session };
  const relay = { snapshot: () => snapshot } as unknown as RelayData;
  const h = renderHook(() =>
    useConversationTabs({
      state: useChannelTabState(session, "alpha"),
      relay,
      session,
      panels,
      current: channels[0],
      channels,
      scope: "scope:viewer",
      conversationIcon: () => null,
      leadingIds: [],
      continuingVisit: true,
      isLive: () => true,
      openLink: () => false,
    }),
  );
  const context = () => {
    const [item] = h.result.current.items;
    if (!item) throw new Error("no panel tab");
    return (item.content as { props: { context: PanelContext } }).props.context;
  };
  act(() => {
    h.result.current.openConversationLink("alpha", "buzz://profile", {
      rootId: "first",
    });
  });
  expect(context()).toMatchObject({ channelId: "alpha", rootId: "first" });
  act(() => {
    h.result.current.openConversationLink("alpha", "buzz://profile", {
      rootId: "second",
    });
  });
  expect(h.result.current.items).toHaveLength(1);
  expect(context()).toMatchObject({ rootId: "second" });
  act(() => {
    h.result.current.openConversationLink("alpha", "buzz://profile");
  });
  expect(context()).not.toHaveProperty("rootId");
});

it("a keyboard move focuses the placed tab at once and never takes focus back later", async () => {
  const session = {
    viewer: "viewer",
    channels: { list: () => ({ channels: [] }), window: () => ({ rows: [] }) },
  } as unknown as RelaySession;
  const emptyPanels: RegisteredPanel[] = [];
  const panels = {
    snapshot: () => emptyPanels,
    subscribe: () => () => {},
  } as unknown as Panels;
  const relay = {
    snapshot: () => ({ status: "ready", session }),
  } as unknown as RelayData;
  const current = { id: "alpha", name: "Alpha" };
  const h = renderHook(() => {
    const state = useChannelTabState(session, "alpha");
    const workspace = useConversationTabs({
      state,
      relay,
      session,
      panels,
      current,
      channels: [current],
      scope: "scope:viewer",
      conversationIcon: () => null,
      leadingIds: [],
      continuingVisit: true,
      isLive: () => true,
      openLink: () => false,
    });
    return { state, workspace };
  });
  act(() => h.result.current.state.openThreadTab("alpha", "first", "first"));
  act(() => h.result.current.state.openThreadTab("alpha", "second", "second"));
  const strip = document.createElement("div");
  for (const item of h.result.current.workspace.items) {
    const tab = document.createElement("button");
    tab.setAttribute("role", "tab");
    tab.dataset.tabValue = item.id;
    strip.append(tab);
  }
  const elsewhere = document.createElement("button");
  document.body.append(strip, elsewhere);
  const moving = h.result.current.workspace.items[1];
  if (!moving || !("move" in moving)) throw new Error("expected a thread tab");
  act(() => moving.move?.(-1));
  expect(h.result.current.state.tabs.map((tab) => tab.id)).toEqual([
    "thread:alpha:second",
    "thread:alpha:first",
  ]);
  expect(document.activeElement).toBe(strip.lastElementChild);
  // The user moves on before the next frame; that frame must not undo it.
  elsewhere.focus();
  await new Promise((frame) => requestAnimationFrame(frame));
  expect(document.activeElement).toBe(elsewhere);
  strip.remove();
  elsewhere.remove();
});

it("the current verified read-only preview owns its thread host, but unrelated previews do not", () => {
  const current = { id: "preview", name: "Public", readOnly: true as const };
  const other = { id: "other", name: "Other public", readOnly: true as const };
  const session = {
    viewer: "viewer",
    channels: { list: () => ({ channels: [] }), window: () => ({ rows: [] }) },
  } as unknown as RelaySession;
  const emptyPanels: RegisteredPanel[] = [];
  const panels = {
    snapshot: () => emptyPanels,
    subscribe: () => () => {},
  } as unknown as Panels;
  const relay = {
    snapshot: () => ({ status: "ready", session }),
  } as unknown as RelayData;
  const h = renderHook(
    ({ cached }) => {
      const state = useChannelTabState(session, "preview");
      const workspace = useConversationTabs({
        state,
        relay,
        session,
        panels,
        current: { ...current, ...(cached ? { cached: true } : {}) },
        channels: [other],
        scope: "scope:viewer",
        conversationIcon: () => null,
        leadingIds: [],
        continuingVisit: true,
        isLive: () => true,
        openLink: () => false,
      });
      return { state, workspace };
    },
    { initialProps: { cached: false } },
  );
  act(() => h.result.current.state.openThreadTab("preview", "root", "root"));
  expect(h.result.current.workspace.hosts).toHaveLength(1);
  act(() => h.result.current.state.openThreadTab("other", "root", "root"));
  expect(h.result.current.workspace.hosts).toHaveLength(1);
  h.rerender({ cached: true });
  expect(h.result.current.workspace.hosts).toHaveLength(0);
});

// The real state -> workspace -> Tabs boundary owns repeat-open feedback.
// CSS paint is inspected in-browser; here we protect triggering and lifetime.
it.each(["side", "main"] as const)(
  "identifies a reopened %s thread repeatedly without remounting its editor or replaying on history restore",
  async (pane) => {
    const user = userEvent.setup();
    const current = { id: "alpha", name: "Alpha" };
    const session = {
      viewer: "viewer",
      channels: { window: () => ({ rows: [] }) },
    } as unknown as RelaySession;
    const available: RegisteredPanel[] = [];
    const panels = {
      snapshot: () => available,
      subscribe: () => () => {},
    } as unknown as Panels;
    const relay = {
      snapshot: () => ({ status: "ready", session }),
    } as unknown as RelayData;
    function Fixture() {
      const state = useChannelTabState(session, "alpha");
      const workspace = useConversationTabs({
        state,
        relay,
        session,
        panels,
        current,
        channels: [current],
        scope: "scope:viewer",
        conversationIcon: () => null,
        leadingIds: [],
        continuingVisit: true,
        isLive: () => true,
        openLink: () => false,
        mainPane: true,
      });
      const items = pane === "main" ? workspace.mainItems : workspace.items;
      return (
        <>
          <button
            type="button"
            onClick={() =>
              state.openThreadTab("alpha", "root", "root", "select", pane)
            }
          >
            Open thread
          </button>
          <button
            type="button"
            onClick={() =>
              state.enterVisit("history", {
                channelId: "alpha",
                messageId: "root",
                rootId: "root",
              })
            }
          >
            Restore history
          </button>
          <PanelWorkspace
            main={pane === "main"}
            value={
              pane === "main"
                ? (state.mainSelected ?? "conversation")
                : state.selected
            }
            select={pane === "main" ? state.selectMain : state.select}
            items={[
              ...items.map((item) => ({
                ...item,
                content: <input aria-label="Retained reply" />,
              })),
              { id: "other", label: "Other", content: null },
            ]}
          />
        </>
      );
    }
    const mount = () =>
      render(
        <StrictMode>
          <Fixture />
        </StrictMode>,
      );
    const mounted = mount();
    const open = screen.getByRole("button", { name: "Open thread" });
    fireEvent.click(open);
    const tab = screen.getByRole("tab", { name: "Thread · Alpha" });
    const cue = () => tab.querySelector(".buzz-tabs-attention");
    expect(cue()).toBeNull();
    const editor = screen.getByRole("textbox", { name: "Retained reply" });
    fireEvent.change(editor, { target: { value: "Keep my reply" } });
    editor.focus();
    fireEvent.click(open);
    const first = cue();
    expect(first).not.toBeNull();
    expect(editor).toHaveFocus();
    fireEvent.click(open);
    expect(cue()).not.toBe(first);
    expect(screen.getByRole("tab", { name: "Thread · Alpha" })).toBe(tab);
    expect(screen.getByRole("textbox", { name: "Retained reply" })).toBe(
      editor,
    );
    expect(editor).toHaveValue("Keep my reply");
    const activeCue = cue();
    if (!activeCue) throw new Error("Expected repeat-open feedback");
    fireEvent.animationEnd(activeCue);
    expect(cue()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restore history" }));
    expect(cue()).toBeNull();
    const other = screen.getByRole("tab", { name: "Other" });
    await user.click(other);
    expect(other).toHaveAttribute("aria-selected", "true");
    await user.click(tab);
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(cue()).toBeNull();
    expect(other.querySelector(".buzz-tabs-attention")).toBeNull();
    // Retained session counters are not a new request when the page remounts.
    mounted.unmount();
    mount();
    expect(
      screen
        .getByRole("tab", { name: "Thread · Alpha" })
        .querySelector(".buzz-tabs-attention"),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open thread" }));
    expect(
      screen
        .getByRole("tab", { name: "Thread · Alpha" })
        .querySelector(".buzz-tabs-attention"),
    ).not.toBeNull();
  },
);
