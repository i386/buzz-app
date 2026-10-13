// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelKit } from "../../features/channel-templates/capability";
import type { KitEntry } from "../../features/channel-templates/model";
import type { RelayData } from "../../features/relay/service";
import { ChannelSetupSettings } from "./ChannelSetupSettings";

afterEach(cleanup);
const savedGroups = (names: string[]): KitEntry => ({
  eventId: "head",
  createdAt: 1,
  record: {
    version: 1,
    community: "https://relay.test",
    deleted: false,
    value: {
      type: "groups",
      id: "personal",
      assignments: {},
      groups: names.map((name) => ({ id: name, name, defaultTemplateId: "" })),
    },
  },
});
function fixture({
  entries = [],
  legacy = false,
  status = "ready",
}: {
  entries?: KitEntry[];
  legacy?: boolean;
  status?: ReturnType<ChannelKit["snapshot"]>["status"];
} = {}) {
  let state: ReturnType<ChannelKit["snapshot"]> = { status, entries };
  const listeners = new Set<() => void>();
  const kit: ChannelKit = {
    available: true,
    snapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ensure: vi.fn(),
    refresh: vi.fn(),
    save: vi.fn(),
  };
  const preferences = {
    status: "ready",
    data: {
      sections: legacy ? [{ id: "old", name: "OG group", order: 0 }] : [],
      assignments: {},
      starred: [],
      muted: [],
    },
  };
  const connection = {
    status: "ready",
    scope: "relay",
    generation: 1,
    session: {
      channelKit: kit,
      sidebarPreferences: {
        snapshot: () => preferences,
        subscribe: () => () => {},
      },
    },
  };
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
  } as unknown as RelayData;
  render(<ChannelSetupSettings relay={relay} active={() => true} />);
  return {
    kit,
    update(next: typeof state) {
      act(() => {
        state = next;
        for (const listener of listeners) listener();
      });
    },
  };
}

it.each([
  { entries: [], legacy: false, empty: true },
  { entries: [], legacy: true, empty: false },
  { entries: [savedGroups([])], legacy: true, empty: true },
  { entries: [savedGroups(["Work"])], legacy: false, empty: false },
  {
    entries: [
      {
        ...savedGroups([]),
        record: { ...savedGroups([]).record, deleted: true },
      },
    ],
    legacy: true,
    empty: false,
  },
])("shows emptiness from the active source: %j", ({ empty, ...options }) => {
  fixture(options);
  expect(
    screen.queryByRole("heading", { name: "No personal groups yet" }) !== null,
  ).toBe(empty);
  expect(
    screen.queryByRole("heading", { name: "Organize your channels" }) !== null,
  ).toBe(!empty);
});

it("waits for a settled catalog, preserves retry, and opens the existing manager without writing", async () => {
  const user = userEvent.setup();
  const { kit, update } = fixture({ status: "loading" });
  expect(
    screen.queryByRole("heading", { name: "No personal groups yet" }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Manage personal groups" }),
  ).toBeDisabled();
  update({ status: "error", entries: [], error: "Groups unavailable" });
  expect(screen.getByRole("status")).toHaveTextContent("Groups unavailable");
  expect(
    screen.queryByRole("heading", { name: "No personal groups yet" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "Reload groups" }));
  expect(kit.refresh).toHaveBeenCalledOnce();
  update({ status: "ready", entries: [] });
  expect(
    screen.getByRole("heading", { name: "No personal groups yet" }),
  ).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "Manage personal groups" }),
  );
  expect(screen.getByRole("dialog", { name: "Personal groups" })).toBeVisible();
  expect(screen.getByRole("button", { name: "New group" })).toBeVisible();
  expect(kit.save).not.toHaveBeenCalled();
});
