// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { EventData, RelayEvent } from "../../features/relay/events";
import { createRelayReader } from "../../features/relay/reader";
import type { RelayData } from "../../features/relay/service";
import type { ReadTransport } from "../../features/relay/transport";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import type { Profile } from "../../features/relay/contracts";
import { AgentBrowse } from "./AgentBrowse";

afterEach(cleanup);

const echo = { key: "test/echo", title: "Echo" } as RegisteredAgentType;
const notes = { key: "test/notes", title: "Notes" } as RegisteredAgentType;
/** Import's props: one type, and an `agents` whose `port` resolves. */
const importing = (types: readonly RegisteredAgentType[] = [echo]) => ({
  agents: {
    port: vi.fn(async () => ({ pubkey: "e".repeat(64) }) as Agent),
  } as unknown as Agents & { port: ReturnType<typeof vi.fn> },
  types,
  onImported: vi.fn(),
});

const shared: EventData = {
  id: "ab".repeat(32),
  pubkey: "cd".repeat(32),
  created_at: 1,
  kind: 30175,
  tags: [
    ["d", "helper"],
    ["shared", "true"],
  ],
  content: JSON.stringify({
    display_name: "Shared helper",
    model: "test-model",
    system_prompt: "Help with tasks.",
  }),
};

/** A profile directory holding `known`, by pubkey. */
const directory = (known: Record<string, Profile> = {}) => {
  const snapshot = new Map(Object.entries(known));
  return {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    ensure: vi.fn(async () => {}),
  };
};

/** A ready community whose session reads through `read`. */
const community = (read: unknown, profiles = directory()) => {
  const snapshot = {
    status: "ready",
    generation: 1,
    origin: "https://relay.example",
    session: { read, media: () => undefined, profiles },
  };
  return {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RelayData;
};

it("browses shared agents and opens read-only details", async () => {
  const read = vi.fn().mockResolvedValue([shared]);
  render(<AgentBrowse relay={community(read)} {...importing()} />);
  expect(await screen.findByText("Shared helper")).toBeVisible();
  expect(screen.getByText("test-model")).toBeVisible();
  expect(read).toHaveBeenCalledWith([{ kinds: [30175], limit: 200 }], {
    signal: expect.any(AbortSignal),
  });
  fireEvent.click(screen.getByRole("button", { name: "View details" }));
  expect(
    await screen.findByRole("dialog", { name: "Shared helper" }),
  ).toBeVisible();
  expect(screen.getByText("Help with tasks.")).toBeVisible();
  // Unknown to the profile directory, the sharer shows as their short key.
  expect(screen.getByText("Shared by")).toBeVisible();
  expect(screen.getByText(/^npub…/)).toBeVisible();
});

it("asks to connect while no community is ready", () => {
  const snapshot = { status: "disconnected", generation: 0 };
  render(
    <AgentBrowse
      relay={
        {
          snapshot: () => snapshot,
          subscribe: () => () => {},
        } as unknown as RelayData
      }
      {...importing()}
    />,
  );
  expect(
    screen.getByText("Connect to a community to browse shared agents."),
  ).toBeVisible();
});

it("allows retrying a failed read without claiming the community is empty", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce([]);
  render(<AgentBrowse relay={community(read)} {...importing()} />);
  expect(
    screen.queryByText("No shared agents found in this community yet."),
  ).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  expect(
    await screen.findByText("No shared agents found in this community yet."),
  ).toBeVisible();
});

it("shrinks over-budget pages and preserves Load more and explicit retry", async () => {
  const events = Array.from({ length: 200 }, (_, index) => ({
    ...shared,
    id: index.toString(16).padStart(64, "0"),
    created_at: 200 - index,
    tags: [
      ["d", `helper-${Math.floor(index / 100)}`],
      ["shared", "true"],
    ],
    content: JSON.stringify({
      display_name: `Helper ${index}`,
      system_prompt: "x".repeat(48 * 1024),
    }),
  })) as RelayEvent[];
  let failNextPage = true;
  const query = vi.fn<ReadTransport["query"]>(async (filters) => {
    const filter = filters[0];
    if (!filter) throw new Error("Missing filter");
    if (filter.until !== undefined && failNextPage) {
      failNextPage = false;
      throw new Error("offline");
    }
    return events
      .filter(
        (event) =>
          filter.until === undefined || event.created_at < filter.until,
      )
      .slice(0, filter.limit);
  });
  const owned = createRelayReader({
    viewer: shared.pubkey,
    relayAuthor: "relay",
    media: () => undefined,
    query,
  });
  const view = render(
    <AgentBrowse relay={community(owned.reader.read)} {...importing()} />,
  );
  try {
    await screen.findByText("Helper 0");
    expect(
      query.mock.calls.slice(0, 2).map(([filters]) => filters[0]?.limit),
    ).toEqual([200, 100]);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Helper 100")).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: "View details" }),
    ).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
    expect(
      query.mock.calls.slice(2).map(([filters]) => filters[0]?.until),
    ).toEqual([101, 101]);
  } finally {
    view.unmount();
    owned.dispose();
  }
});

it("starts over from the first page in another community", async () => {
  const page = Array.from({ length: 200 }, (_, index) => ({
    ...shared,
    id: index.toString(16).padStart(64, "0"),
    created_at: 300 - index,
    tags: [
      ["d", `first-${index}`],
      ["shared", "true"],
    ],
    content: JSON.stringify({ display_name: `First ${index}` }),
  }));
  const first = vi.fn(async (filters: { until?: number }[]) =>
    filters[0]?.until === undefined ? page : [],
  );
  const second = vi.fn().mockResolvedValue([shared]);
  let snapshot = {
    status: "ready",
    generation: 1,
    origin: "https://one.example",
    session: { read: first, media: () => undefined, profiles: directory() },
  };
  const listeners = new Set<() => void>();
  const relay = {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as RelayData;
  render(<AgentBrowse relay={relay} {...importing()} />);
  await screen.findByText("First 0");
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(2));
  snapshot = {
    status: "ready",
    generation: 2,
    origin: "https://two.example",
    session: { read: second, media: () => undefined, profiles: directory() },
  };
  act(() => {
    for (const listener of listeners) listener();
  });
  expect(await screen.findByText("Shared helper")).toBeVisible();
  expect(screen.queryByText("First 0")).not.toBeInTheDocument();
  expect(second).toHaveBeenCalledExactlyOnceWith(
    [{ kinds: [30175], limit: 200 }],
    { signal: expect.any(AbortSignal) },
  );
});

it("names the sharer by their profile, with their key on hover", async () => {
  const read = vi.fn().mockResolvedValue([shared]);
  const profiles = directory({ [shared.pubkey]: { name: "Cora" } });
  render(<AgentBrowse relay={community(read, profiles)} {...importing()} />);
  fireEvent.click(await screen.findByRole("button", { name: "View details" }));
  const dialog = await screen.findByRole("dialog", { name: "Shared helper" });
  expect(within(dialog).getByText("Cora")).toBeVisible();
  expect(within(dialog).queryByText(/^npub…/)).not.toBeInTheDocument();
  expect(profiles.ensure).toHaveBeenCalledWith([shared.pubkey]);
  expect(within(dialog).getByText("test-model")).toBeVisible();
});

it("imports a shared agent through the import path, then hands back", async () => {
  const read = vi.fn().mockResolvedValue([
    {
      ...shared,
      content: JSON.stringify({
        display_name: "Shared helper",
        model: "test-model",
        system_prompt: "Help with tasks.",
        avatar_url: "https://example.test/helper.png",
      }),
    },
  ]);
  const props = importing();
  render(<AgentBrowse relay={community(read)} {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "View details" }));
  const dialog = await screen.findByRole("dialog", { name: "Shared helper" });
  expect(within(dialog).queryByLabelText("Import as")).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
  await vi.waitFor(() => expect(props.onImported).toHaveBeenCalledOnce());
  expect(props.agents.port).toHaveBeenCalledExactlyOnceWith({
    source: "shared",
    type: "test/echo",
    name: "Shared helper",
    picture: "https://example.test/helper.png",
    instructions: "Help with tasks.",
  });
});

it("imports as the chosen type, and keeps the dialog open with the error when it fails", async () => {
  const read = vi.fn().mockResolvedValue([shared]);
  const props = importing([echo, notes]);
  props.agents.port.mockRejectedValueOnce(
    new Error("Connect to a community first"),
  );
  render(<AgentBrowse relay={community(read)} {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "View details" }));
  const dialog = await screen.findByRole("dialog", { name: "Shared helper" });
  expect(
    within(dialog).getByRole("combobox", { name: "Import as" }),
  ).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Connect to a community first",
  );
  expect(props.onImported).not.toHaveBeenCalled();
  expect(props.agents.port).toHaveBeenCalledWith(
    expect.objectContaining({ source: "shared", type: "test/echo" }),
  );
});
