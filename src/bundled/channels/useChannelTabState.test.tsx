// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, test } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { RegisteredPanel } from "../../features/panels/service";
import {
  panelTabId,
  type PanelOpening,
  useChannelTabState,
} from "./useChannelTabState";

import {
  setThreadPlacementPreference,
  threadPlacementPreference,
} from "../../features/messages/thread-preferences";
afterEach(() => {
  cleanup();
  setThreadPlacementPreference("side");
  localStorage.clear();
});

test("page remount restores each channel's tabs, selection and closed pane", () => {
  const session = {} as RelaySession;
  const mounted = renderHook(
    ({ channel }) => useChannelTabState(session, channel),
    { initialProps: { channel: "alpha" } },
  );
  act(() => {
    mounted.result.current.setTabs(() => [
      { id: "beta-tab", kind: "conversation", channelId: "beta" },
    ]);
    mounted.result.current.select("beta-tab");
    mounted.result.current.setPaneOpen(false);
  });
  mounted.rerender({ channel: "beta" });
  expect(mounted.result.current.tabs).toEqual([]);
  act(() =>
    mounted.result.current.setSettings({
      channelId: "beta",
    }),
  );
  mounted.unmount();
  const restored = renderHook(
    ({ channel }) => useChannelTabState(session, channel),
    { initialProps: { channel: "alpha" } },
  );
  expect(restored.result.current).toMatchObject({
    selected: "beta-tab",
    paneOpen: false,
    tabs: [{ id: "beta-tab", kind: "conversation", channelId: "beta" }],
  });
  restored.rerender({ channel: "beta" });
  expect(restored.result.current).toMatchObject({
    selected: "settings",
    paneOpen: true,
    settings: { channelId: "beta" },
  });
});

test("replacement sessions are isolated from retained state and old callbacks", () => {
  const first = {} as RelaySession;
  const second = {} as RelaySession;
  const mounted = renderHook(
    ({ session }) => useChannelTabState(session, "alpha"),
    { initialProps: { session: first } },
  );
  const oldSelect = mounted.result.current.select;
  act(() => oldSelect("old-tab"));
  mounted.rerender({ session: second });
  expect(mounted.result.current.selected).toBe("thread");
  act(() => oldSelect("late-old-tab"));
  expect(mounted.result.current.selected).toBe("thread");
  act(() => mounted.result.current.select("new-tab"));
  mounted.rerender({ session: first });
  expect(mounted.result.current.selected).toBe("late-old-tab");
});

test("closing and reopening settings starts a fresh view while hiding the pane retains it", () => {
  const session = {} as RelaySession;
  const mounted = renderHook(() => useChannelTabState(session, "alpha"));
  act(() => mounted.result.current.setSettings({ channelId: "alpha" }));
  const opening = mounted.result.current.settings;
  act(() => mounted.result.current.setPaneOpen(false));
  act(() => mounted.result.current.setPaneOpen(true));
  expect(mounted.result.current.settings).toBe(opening);
  act(() => mounted.result.current.setSettings({ channelId: "alpha" }));
  expect(mounted.result.current.settings).toBe(opening);
  act(() => mounted.result.current.setSettings(undefined));
  act(() => mounted.result.current.setSettings({ channelId: "alpha" }));
  expect(mounted.result.current.settings?.id).not.toBe(opening?.id);
});

test("channel switches retire each visit's menu opening without copying retained tools", () => {
  const session = {} as RelaySession;
  const menu = {
    key: "usage",
    channelMenu: { label: "Usage" },
  } as RegisteredPanel;
  const tool = { key: "terminal" } as RegisteredPanel;
  const entry = (channelId: string, panel: RegisteredPanel): PanelOpening => ({
    channelId,
    panel,
    target: `${channelId}-${panel.key}`,
  });
  const alphaTool = entry("alpha", tool);
  const betaTool = entry("beta", tool);
  const alphaUsage = entry("alpha", menu);
  const betaUsage = entry("beta", menu);
  const mounted = renderHook(
    ({ channel }) => {
      const state = useChannelTabState(session, channel);
      // Same lifecycle as ChannelsPage: cleanup closes the departing visit.
      useEffect(() => state.retireMenuEntries, [state.retireMenuEntries]);
      return state;
    },
    { initialProps: { channel: "alpha" } },
  );
  act(() => {
    mounted.result.current.setEntries([alphaTool, alphaUsage]);
    mounted.result.current.select(panelTabId(alphaUsage));
  });
  mounted.rerender({ channel: "beta" });
  act(() => {
    mounted.result.current.setEntries([betaTool, betaUsage]);
    mounted.result.current.select(panelTabId(betaUsage));
  });
  mounted.rerender({ channel: "alpha" });
  expect(mounted.result.current.entries).toEqual([alphaTool]);
  expect(mounted.result.current.selected).toBe("thread");
  act(() => mounted.result.current.select(panelTabId(alphaTool)));
  mounted.rerender({ channel: "beta" });
  expect(mounted.result.current.entries).toEqual([betaTool]);
  expect(mounted.result.current.selected).toBe("thread");
  mounted.rerender({ channel: "alpha" });
  expect(mounted.result.current.entries).toEqual([alphaTool]);
  expect(mounted.result.current.selected).toBe(panelTabId(alphaTool));
});

test("Me and Messages retain independent workspaces for the same conversation", () => {
  const session = {} as RelaySession;
  const messages = renderHook(() => useChannelTabState(session, "alpha"));
  const me = renderHook(() => useChannelTabState(session, "alpha", "me"));
  act(() => {
    messages.result.current.setTabs(() => [
      {
        id: "messages-tab",
        kind: "thread",
        channelId: "alpha",
        messageId: "root",
      },
    ]);
    messages.result.current.select("messages-tab");
    me.result.current.setTabs(() => [
      { id: "me-tab", kind: "conversation", channelId: "beta" },
    ]);
    me.result.current.select("me-tab");
    me.result.current.setPaneOpen(false);
    me.result.current.retireMenuEntries();
  });
  expect(messages.result.current).toMatchObject({
    selected: "messages-tab",
    paneOpen: true,
    tabs: [{ id: "messages-tab" }],
  });
  me.unmount();
  const restored = renderHook(() => useChannelTabState(session, "alpha", "me"));
  expect(restored.result.current).toMatchObject({
    selected: "me-tab",
    paneOpen: false,
    tabs: [{ id: "me-tab" }],
  });
});

// Exercise the channel-owned open action through a mounted hook. This verifies
// the resulting user state, not React batching or notification counts.
test("opening a thread selects it, deduplicates its root and restores each channel", () => {
  const session = {} as RelaySession;
  const workspace = renderHook(
    ({ channel }) => useChannelTabState(session, channel),
    { initialProps: { channel: "alpha" } },
  );
  act(() => workspace.result.current.setPaneOpen(false));
  act(() =>
    workspace.result.current.openThreadTab(
      "alpha",
      "reply-a",
      "root-a",
      "reply",
    ),
  );
  expect(workspace.result.current).toMatchObject({
    selected: "thread:alpha:root-a",
    paneOpen: true,
    tabs: [{ id: "thread:alpha:root-a", replyRequest: 1 }],
  });
  act(() =>
    workspace.result.current.openThreadTab("alpha", "root-b", "root-b"),
  );
  act(() =>
    workspace.result.current.openThreadTab(
      "alpha",
      "reply-b",
      "root-a",
      "reply",
    ),
  );
  expect(workspace.result.current.tabs).toEqual([
    {
      id: "thread:alpha:root-a",
      kind: "thread",
      channelId: "alpha",
      messageId: "reply-b",
      replyRequest: 2,
      pane: "side",
    },
    {
      id: "thread:alpha:root-b",
      kind: "thread",
      channelId: "alpha",
      messageId: "root-b",
      replyRequest: undefined,
      pane: "side",
    },
  ]);
  expect(workspace.result.current.selected).toBe("thread:alpha:root-a");
  workspace.rerender({ channel: "beta" });
  expect(workspace.result.current.tabs).toEqual([]);
  workspace.rerender({ channel: "alpha" });
  expect(workspace.result.current.tabs).toHaveLength(2);
  expect(workspace.result.current.selected).toBe("thread:alpha:root-a");
  act(() =>
    workspace.result.current.openThreadTab("alpha", "reply-b", "root-a"),
  );
  expect(workspace.result.current.tabs[0]).toMatchObject({
    replyRequest: undefined,
  });
});

// Placement is one channel-owned list: a move reorders or crosses panes
// without changing the tab's identity, and selection follows it.
test("moving a thread reorders it within a pane and across panes", () => {
  const session = {} as RelaySession;
  const h = renderHook(() => useChannelTabState(session, "alpha"));
  act(() => {
    h.result.current.openThreadTab("alpha", "a", "a");
    h.result.current.openThreadTab("alpha", "b", "b");
    h.result.current.openThreadTab("alpha", "c", "c");
  });
  const ids = () => h.result.current.tabs.map((tab) => tab.id);
  act(() => h.result.current.moveTab("thread:alpha:c", "side", 0));
  expect(ids()).toEqual(["thread:alpha:c", "thread:alpha:a", "thread:alpha:b"]);
  expect(h.result.current.selected).toBe("thread:alpha:c");
  act(() => h.result.current.moveTab("thread:alpha:a", "main", 0));
  expect(
    h.result.current.tabs.find((tab) => tab.id === "thread:alpha:a"),
  ).toMatchObject({ pane: "main" });
  expect(h.result.current.mainSelected).toBe("thread:alpha:a");
  // Reopening a moved thread selects it where it now lives.
  act(() => h.result.current.openThreadTab("alpha", "a", "a", "reply"));
  expect(
    h.result.current.tabs.find((tab) => tab.id === "thread:alpha:a"),
  ).toMatchObject({ pane: "main", replyRequest: 1 });
  act(() => h.result.current.moveTab("thread:alpha:a", "side", 1));
  expect(ids()).toEqual(["thread:alpha:c", "thread:alpha:a", "thread:alpha:b"]);
  expect(h.result.current.mainSelected).toBeUndefined();
  expect(h.result.current.selected).toBe("thread:alpha:a");
  // A visit's own "select" keeps a pending reply focus request.
  act(() => h.result.current.openThreadTab("alpha", "a", "a", "select"));
  expect(
    h.result.current.tabs.find((tab) => tab.id === "thread:alpha:a"),
  ).toMatchObject({ replyRequest: 1 });
});

// A link's root hint is not identity: the reader's verified root merges a
// duplicate into the tab that already holds the thread.
test("a tab opened from a wrong hint merges into the verified thread's tab", () => {
  const session = {} as RelaySession;
  const h = renderHook(() => useChannelTabState(session, "alpha"));
  act(() => h.result.current.openThreadTab("alpha", "root", "root"));
  act(() => h.result.current.moveTab("thread:alpha:root", "main", 0));
  act(() => h.result.current.openThreadTab("alpha", "reply", "wrong-hint"));
  expect(h.result.current.tabs).toHaveLength(2);
  act(() =>
    h.result.current.resolveThreadRoot("thread:alpha:wrong-hint", "root"),
  );
  expect(h.result.current.tabs).toEqual([
    expect.objectContaining({
      id: "thread:alpha:root",
      messageId: "reply",
      pane: "main",
      rootId: "root",
    }),
  ]);
  expect(h.result.current.mainSelected).toBe("thread:alpha:root");
  // Later openings by either identity select the same tab.
  act(() => h.result.current.openThreadTab("alpha", "root", "root"));
  expect(h.result.current.tabs).toHaveLength(1);
});

test.each(["side", "main"] as const)(
  "late root confirmation in %s preserves newer selection and closed panes",
  (pane) => {
    const session = {} as RelaySession;
    const h = renderHook(() => useChannelTabState(session, "alpha"));
    act(() => h.result.current.openThreadTab("alpha", "root", "root"));
    act(() => h.result.current.resolveThreadRoot("thread:alpha:root", "root"));
    act(() =>
      h.result.current.openThreadTab("alpha", "reply", "guess", "select", pane),
    );
    act(() =>
      h.result.current.openThreadTab("alpha", "other", "other", "select", pane),
    );
    act(() => h.result.current.setPaneOpen(false));
    act(() => h.result.current.resolveThreadRoot("thread:alpha:guess", "root"));
    expect(h.result.current.paneOpen).toBe(false);
    expect(
      pane === "main"
        ? h.result.current.mainSelected
        : h.result.current.selected,
    ).toBe("thread:alpha:other");
    expect(
      h.result.current.tabs.find((tab) => tab.id === "thread:alpha:root"),
    ).toMatchObject({ messageId: "root" });
  },
);

test("a selected hidden provisional tab merges without switching the main pane", () => {
  const session = {} as RelaySession;
  const h = renderHook(() => useChannelTabState(session, "alpha"));
  act(() =>
    h.result.current.openThreadTab("alpha", "root", "root", "select", "main"),
  );
  act(() => h.result.current.resolveThreadRoot("thread:alpha:root", "root"));
  act(() =>
    h.result.current.openThreadTab("alpha", "other", "other", "select", "main"),
  );
  act(() => h.result.current.openThreadTab("alpha", "reply", "guess"));
  act(() => h.result.current.setPaneOpen(false));
  act(() => h.result.current.resolveThreadRoot("thread:alpha:guess", "root"));
  expect(h.result.current.mainSelected).toBe("thread:alpha:other");
  expect(h.result.current.paneOpen).toBe(false);
});

test.each(["side", "main"] as const)(
  "wrong-root diversion preserves the %s pane despite the opposite default and resolves into the actual owner",
  (pane) => {
    const otherPane = pane === "side" ? "main" : "side";
    setThreadPlacementPreference(otherPane);
    const session = {} as RelaySession;
    const h = renderHook(() => useChannelTabState(session, "alpha"));
    act(() =>
      h.result.current.openThreadTab("alpha", "x", "x", "select", pane),
    );
    act(() => h.result.current.resolveThreadRoot("thread:alpha:x", "x"));
    act(() =>
      h.result.current.openThreadTab("alpha", "y", "y", "select", otherPane),
    );
    act(() => h.result.current.resolveThreadRoot("thread:alpha:y", "y"));
    act(() =>
      h.result.current.openThreadTab("alpha", "reply-y", "x", "select", pane),
    );
    act(() => h.result.current.divertThread("thread:alpha:x", "reply-y", "x"));
    expect(
      h.result.current.tabs.find((tab) => tab.id === "thread:alpha:x"),
    ).toMatchObject({ messageId: "x", rootId: "x", pane });
    expect(
      h.result.current.tabs.find((tab) => tab.id === "thread:alpha:reply-y"),
    ).toMatchObject({ messageId: "reply-y", pane });
    expect(
      pane === "side"
        ? h.result.current.selected
        : h.result.current.mainSelected,
    ).toBe("thread:alpha:reply-y");
    // An already-open verified destination still keeps its own placement.
    act(() => h.result.current.resolveThreadRoot("thread:alpha:reply-y", "y"));
    expect(h.result.current.tabs).toHaveLength(2);
    expect(
      otherPane === "main"
        ? h.result.current.mainSelected
        : h.result.current.selected,
    ).toBe("thread:alpha:y");
    expect(
      h.result.current.tabs.find((tab) => tab.id === "thread:alpha:y"),
    ).toMatchObject({ messageId: "reply-y", pane: otherPane });
    const tabs = h.result.current.tabs;
    act(() => h.result.current.divertThread("thread:alpha:x", "reply-y", "x"));
    expect(h.result.current.tabs).toBe(tabs);
    expect(threadPlacementPreference()).toBe(otherPane);
  },
);

test("verified identity takes precedence over a tab's original hint id", () => {
  const session = {} as RelaySession;
  const h = renderHook(() => useChannelTabState(session, "alpha"));
  act(() => h.result.current.openThreadTab("alpha", "reply-y", "x"));
  act(() => h.result.current.resolveThreadRoot("thread:alpha:x", "y"));
  act(() => h.result.current.openThreadTab("alpha", "x", "x"));
  expect(h.result.current.tabs).toHaveLength(2);
  expect(new Set(h.result.current.tabs.map((tab) => tab.id)).size).toBe(2);
  expect(h.result.current.tabs[0]).toMatchObject({
    messageId: "reply-y",
    rootId: "y",
  });
});

// Back/Forward restore each visit's selected tabs and never close a thread.
test("revisiting a history entry restores its selection without closing threads", () => {
  const session = {} as RelaySession;
  const h = renderHook(() => useChannelTabState(session, "alpha"));
  act(() => h.result.current.enterVisit("one:channel"));
  act(() => h.result.current.select("detail"));
  act(() => h.result.current.setPaneOpen(false));
  // Opening a thread changes selection before its visit arrives.
  act(() => h.result.current.leaveVisit());
  act(() => h.result.current.openThreadTab("alpha", "root", "root"));
  const routed = { channelId: "alpha", messageId: "root", rootId: "root" };
  act(() => h.result.current.enterVisit("two:thread", routed));
  expect(h.result.current.selected).toBe("thread:alpha:root");
  act(() => h.result.current.enterVisit("one:channel"));
  expect(h.result.current.selected).toBe("detail");
  expect(h.result.current.paneOpen).toBe(false);
  expect(h.result.current.tabs).toHaveLength(1);
  // Re-entering the same visit (a remount) changes nothing.
  act(() => h.result.current.select("other"));
  act(() => h.result.current.enterVisit("one:channel"));
  expect(h.result.current.selected).toBe("other");
  act(() => h.result.current.enterVisit("two:thread", routed));
  expect(h.result.current.selected).toBe("thread:alpha:root");
});

test("Back restores an empty side pane as hidden while retaining the later thread", () => {
  const session = {} as RelaySession;
  const h = renderHook(() => useChannelTabState(session, "alpha"));
  act(() => h.result.current.enterVisit("channel"));
  act(() => h.result.current.leaveVisit());
  act(() =>
    h.result.current.enterVisit("link", {
      channelId: "alpha",
      messageId: "root",
      rootId: "root",
    }),
  );
  expect(h.result.current.paneOpen).toBe(true);
  act(() => h.result.current.enterVisit("channel"));
  expect(h.result.current.paneOpen).toBe(false);
  expect(h.result.current.tabs).toHaveLength(1);
});

test("new ordinary and routed threads follow the device choice; existing tabs and moves do not", () => {
  const session = {} as RelaySession;
  const mounted = renderHook(() => useChannelTabState(session, "alpha"));
  act(() => mounted.result.current.openThreadTab("alpha", "one", "one"));
  expect(mounted.result.current.tabs[0]).toMatchObject({ pane: "side" });
  act(() => setThreadPlacementPreference("main"));
  act(() => mounted.result.current.openThreadTab("alpha", "two", "two"));
  expect(mounted.result.current.tabs[1]).toMatchObject({ pane: "main" });
  act(() => mounted.result.current.openThreadTab("alpha", "one", "one"));
  expect(mounted.result.current.tabs[0]).toMatchObject({ pane: "side" });
  act(() =>
    mounted.result.current.enterVisit("link", {
      channelId: "alpha",
      messageId: "three",
      rootId: "three",
    }),
  );
  expect(mounted.result.current.tabs[2]).toMatchObject({ pane: "main" });
  act(() => mounted.result.current.moveTab("thread:alpha:two", "side", 0));
  expect(threadPlacementPreference()).toBe("main");
});

test("the returned state keeps its identity across unrelated re-renders", () => {
  const session = {} as RelaySession;
  const mounted = renderHook(
    ({ channel }) => useChannelTabState(session, channel),
    { initialProps: { channel: "alpha" } },
  );
  const initial = mounted.result.current;
  mounted.rerender({ channel: "alpha" });
  expect(mounted.result.current).toBe(initial);
  act(() => mounted.result.current.select("beta-tab"));
  const selected = mounted.result.current;
  expect(selected).not.toBe(initial);
  expect(selected.selected).toBe("beta-tab");
  expect(selected.select).toBe(initial.select);
  mounted.rerender({ channel: "beta" });
  expect(mounted.result.current).not.toBe(selected);
});
