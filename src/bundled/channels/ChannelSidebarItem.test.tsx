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
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { UnreadSnapshot } from "../../features/relay/unread";
import type { PresenceStatus } from "../../features/presence/presence";
import { ChannelSidebarItem } from "./ChannelSidebarItem";

afterEach(cleanup);

const noTyping = Object.freeze([]);

function owner(profiles = new Map<string, Profile>()) {
  const listeners = new Set<() => void>();
  let snapshot: UnreadSnapshot = {
    target: { kind: "channel", channelId: "alpha" },
    observedCount: 0,
    attentionCount: 0,
    coverage: "observed",
    freshness: "observed",
    manual: "none",
  };
  const activity = {
    channelId: "alpha",
    items: [],
    coverage: "observed",
    freshness: "observed",
  };
  const session = {
    channels: { prepare: vi.fn() },
    agentActivity: {
      subscribe: () => () => {},
      snapshot: () => ({
        status: "listening",
        records: [],
        turns: [
          {
            agent: "a".repeat(64),
            channelId: "alpha",
            turnId: "one",
            timestamp: Date.now(),
            state: "working",
          },
        ],
        typing: [],
        trimmed: 0,
      }),
    },
    media: (url: string) => `media:${url}`,
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
    },
    typing: { snapshot: () => noTyping, subscribe: () => () => {} },
    unread: {
      snapshot: () => snapshot,
      subscribe: (_target: unknown, listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      activity: () => activity,
      subscribeActivity: () => () => {},
    },
  } as unknown as RelaySession;
  return {
    session,
    profiles,
    listeners,
    unread(count: number, attentionCount = 0) {
      snapshot = { ...snapshot, observedCount: count, attentionCount };
      for (const listener of listeners) listener();
    },
  };
}

function itemProps(
  session: RelaySession,
  working: boolean,
  channel: ChannelSummary = {
    id: "alpha",
    name: "Alpha",
    channelType: "stream",
  },
) {
  return {
    channel,
    session,
    working,
    sessionsEnabled: true,
    selected: undefined,
    collapsed: false,
    onToggle: vi.fn(),
    draft: false,
    draftSelected: false,
    sessions: undefined,
    onSelect: vi.fn(),
    onNewSession: vi.fn(),
    onOpenThread: vi.fn(),
  };
}

it("keeps the DM identity avatar and shows only a separate thinking badge", () => {
  const agent = "a".repeat(64);
  const state = owner(new Map([[agent, { name: "Buzzy", isAgent: true }]]));
  render(
    <ChannelSidebarItem
      {...itemProps(state.session, true, {
        id: "alpha",
        name: "Buzzy",
        channelType: "dm",
        participants: [agent],
      })}
      profile={state.profiles.get(agent)}
    />,
  );
  expect(
    document.querySelectorAll("[data-dm-identity] .buzz-avatar"),
  ).toHaveLength(1);
  expect(
    document.querySelector("[data-dm-identity] .agent-motion-avatar"),
  ).toBeNull();
  expect(
    document.querySelector("[data-dm-identity] .badge-pill-root"),
  ).toBeNull();
  const badge = document.querySelector("[data-channel-working]");
  expect(badge).toHaveAttribute("aria-label", "Buzzy working in Buzzy");
  expect(badge?.querySelectorAll("[data-state=working] > span")).toHaveLength(
    3,
  );
  expect(badge?.closest("[data-dm-identity]")).toBeNull();
});

it.each([
  { name: "unread-only", working: false, unread: true },
  { name: "working-only", working: true, unread: false },
])(
  "keeps $name state in the shared indicator position",
  ({ working, unread }) => {
    const state = owner();
    render(<ChannelSidebarItem {...itemProps(state.session, working)} />);
    if (unread) act(() => state.unread(1, 1));
    const stack = document.querySelector("[data-channel-indicators]");
    if (!(stack instanceof HTMLElement))
      throw new Error("Missing indicator stack");
    expect(stack.querySelector("[data-channel-working]") !== null).toBe(
      working,
    );
    expect(stack.querySelector("[data-channel-priority]") !== null).toBe(
      unread,
    );
  },
);

it("shows the viewer's agents typing in the channel or its threads as working", () => {
  const agent = "b".repeat(64),
    human = "c".repeat(64),
    hinted = "e".repeat(64);
  const listeners = new Set<() => void>();
  let typing: readonly {
    channelId: string;
    threadRootId?: string;
    pubkey: string;
  }[] = [];
  const library = { identities: [{ pubkey: agent }] };
  const state = owner(
    new Map<string, Profile>([
      [agent, { name: "Pinky" }],
      [hinted, { name: "Brain", isAgent: true }],
    ]),
  );
  const session = {
    ...state.session,
    typing: {
      snapshot: () => typing,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    agentChoices: {
      snapshot: () => library,
      subscribe: () => () => {},
    },
  } as unknown as RelaySession;
  const set = (next: typeof typing) =>
    act(() => {
      typing = next;
      for (const listener of listeners) listener();
    });
  const view = render(<ChannelSidebarItem {...itemProps(session, false)} />);
  set([{ channelId: "alpha", pubkey: human }]);
  expect(document.querySelector("[data-channel-working]")).toBeNull();
  set([{ channelId: "alpha", threadRootId: "d".repeat(64), pubkey: agent }]);
  expect(
    screen.getByRole("img", { name: "Pinky working in Alpha" }),
  ).toBeInTheDocument();
  // Another person's agent only declares itself in its profile.
  set([{ channelId: "alpha", pubkey: hinted }]);
  expect(document.querySelector("[data-channel-working]")).toBeNull();
  set([{ channelId: "beta", pubkey: agent }]);
  expect(document.querySelector("[data-channel-working]")).toBeNull();
  // A working agent in its DM keeps the avatar instead of also showing typing.
  view.rerender(
    <ChannelSidebarItem
      {...itemProps(session, false, {
        id: "beta",
        name: "Pinky",
        channelType: "dm",
        participants: [agent],
      })}
    />,
  );
  expect(
    screen.getByRole("img", { name: "Pinky working in Pinky" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("img", { name: /typing/ })).toBeNull();
});

it("layers the working indicator above unread at the same position", () => {
  const state = owner();
  render(<ChannelSidebarItem {...itemProps(state.session, true)} />);
  act(() => state.unread(1, 1));
  const stack = document.querySelector("[data-channel-indicators]");
  const unread = stack?.querySelector("[data-channel-priority]");
  const working = stack?.querySelector("[data-channel-working]");
  expect(stack).toBeInTheDocument();
  expect(unread).toHaveAttribute("data-indicator-layer", "unread");
  expect(working).toHaveAttribute("data-indicator-layer", "working");
  expect(working?.compareDocumentPosition(unread as Node)).toBe(
    Node.DOCUMENT_POSITION_PRECEDING,
  );
});

it("keeps live unread updates and uses replacement session callbacks across row updates", async () => {
  const user = userEvent.setup(),
    first = owner(),
    second = owner();
  const onSelect = vi.fn(),
    replacement = vi.fn();
  const props = {
    channel: { id: "alpha", name: "Alpha", channelType: "stream" as const },
    session: first.session,
    working: false,
    selected: undefined,
    collapsed: false,
    onToggle: vi.fn(),
    draft: false,
    draftSelected: false,
    sessions: undefined,
    onSelect,
    onNewSession: vi.fn(),
    onOpenThread: vi.fn(),
  };
  const view = render(<ChannelSidebarItem {...props} />);
  const row = screen.getByRole("button", { name: "Alpha" });
  view.rerender(<ChannelSidebarItem {...props} />);
  act(() => first.unread(2));
  expect(
    screen.getByRole("img", { name: /2 observed unread/ }),
  ).toBeInTheDocument();
  await user.click(row);
  expect(onSelect).toHaveBeenCalledWith("alpha");
  view.rerender(
    <ChannelSidebarItem
      {...props}
      session={second.session}
      working
      selected="alpha"
      onSelect={replacement}
    />,
  );
  const activeRow = screen.getByRole("button", { name: /^Alpha/ });
  expect(activeRow).toHaveAttribute("aria-current", "page");
  expect(activeRow.querySelector("svg")).toHaveAttribute("width", "1rem");
  expect(activeRow.querySelector("svg")).toHaveAttribute("height", "1rem");
  expect(
    screen.getByRole("img", { name: /working in Alpha/ }),
  ).toBeInTheDocument();
  expect(first.listeners.size).toBe(0);
  expect(
    screen.queryByRole("img", { name: /observed unread/ }),
  ).not.toBeInTheDocument();
  act(() => second.unread(3));
  expect(
    screen.getByRole("img", { name: /3 observed unread/ }),
  ).toBeInTheDocument();
  await user.click(activeRow);
  expect(replacement).toHaveBeenCalledWith("alpha");
  expect(onSelect).toHaveBeenCalledTimes(1);
});

it("badges one-to-one DM avatars with live presence and sanitizes their media", () => {
  let status: PresenceStatus = "unknown";
  const presenceListeners = new Set<() => void>();
  const session = {
    ...owner().session,
    media: vi.fn((url: string) =>
      url.startsWith("https://") ? `/media?url=${url}` : undefined,
    ),
  };
  // Profile data is supplied by the page; presence is owned by the connected row.
  Object.defineProperties(session, {
    profiles: {
      get: () => {
        throw new Error("Unexpected profile acquisition");
      },
    },
    presence: {
      value: {
        status: () => status,
        limited: () => false,
        subscribe: (_pubkey: string, listener: () => void) => {
          presenceListeners.add(listener);
          return () => presenceListeners.delete(listener);
        },
      },
    },
  });
  const props = {
    channel: {
      id: "dm",
      name: "Alice",
      channelType: "dm" as const,
      participants: ["alice"],
    },
    session,
    working: false,
    selected: undefined,
    collapsed: false,
    onToggle: vi.fn(),
    draft: false,
    draftSelected: false,
    sessions: undefined,
    onSelect: vi.fn(),
    onNewSession: vi.fn(),
    onOpenThread: vi.fn(),
  };
  const view = render(<ChannelSidebarItem {...props} />);
  const row = screen.getByRole("button", { name: /^Alice$/ });
  expect(row.querySelector(".buzz-avatar")).toHaveTextContent("A");
  expect(row.querySelector(".buzz-avatar-status")).not.toHaveAttribute(
    "data-status",
  );
  act(() => {
    status = "away";
    for (const listener of presenceListeners) listener();
  });
  expect(row.querySelector(".buzz-avatar-status")).toHaveAttribute(
    "data-status",
    "away",
  );
  expect(row).toHaveAccessibleName("Alice");
  expect(row).toHaveAccessibleDescription("Presence: away");
  view.rerender(
    <ChannelSidebarItem
      {...props}
      profile={{
        name: "Alice",
        picture: "https://example.com/alice.png",
        isAgent: true,
      }}
    />,
  );
  expect(session.media).toHaveBeenLastCalledWith(
    "https://example.com/alice.png",
    "small",
  );
  const image = row.querySelector("img");
  expect(image).toHaveAttribute(
    "src",
    "/media?url=https://example.com/alice.png",
  );
  expect(image).toHaveAttribute("loading", "lazy");
  expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
  expect(row.querySelector(".buzz-avatar")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  if (!image) throw new Error("Avatar image is missing");
  fireEvent.error(image);
  expect(row.querySelector("img")).toBeNull();
  expect(row.querySelector(".buzz-avatar")).toHaveTextContent("A");
  view.rerender(
    <ChannelSidebarItem
      {...props}
      profile={{ name: "Alice", picture: "javascript:bad" }}
    />,
  );
  expect(row.querySelector("img")).toBeNull();
  expect(row.querySelector(".buzz-avatar")).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );
  view.rerender(<ChannelSidebarItem {...props} profile={undefined} />);
  expect(row.querySelector(".buzz-avatar")).toHaveTextContent("A");
  for (const participants of [[], ["alice", "bob"]]) {
    view.rerender(
      <ChannelSidebarItem
        {...props}
        channel={{ ...props.channel, participants }}
      />,
    );
    expect(row.querySelector(".buzz-avatar")).toBeNull();
    expect(row).not.toHaveAccessibleDescription();
    expect(row).toHaveAccessibleName("Alice");
    if (participants.length) {
      expect(
        row.querySelector("[title='2 other participants']"),
      ).toHaveTextContent("2");
    } else expect(row.querySelector("svg")).toBeInTheDocument();
  }
});

it.each(["ContextMenu", "F10"])(
  "opens the parent menu with %s without involving disclosure or child sessions",
  async (key) => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const onOpenMenu = vi.fn();
    const channel = {
      id: "alpha",
      name: "Alpha",
      channelType: "stream" as const,
    };
    render(
      <ChannelSidebarItem
        channel={channel}
        session={owner().session}
        working={false}
        selected={undefined}
        collapsed={false}
        onToggle={onToggle}
        draft={false}
        draftSelected={false}
        sessions={[{ id: "child", name: "Plan", channelType: "session" }]}
        onSelect={onSelect}
        onNewSession={vi.fn()}
        onOpenThread={vi.fn()}
        menuEnabled
        sectionKey="group:work"
        onOpenMenu={onOpenMenu}
      />,
    );
    const parent = screen.getByRole("button", { name: "Alpha" });
    fireEvent.keyDown(parent, { key, shiftKey: key === "F10" });
    expect(onOpenMenu).toHaveBeenCalledWith(
      channel,
      "group:work",
      parent.parentElement,
    );
    expect(onSelect).not.toHaveBeenCalled();
    const disclosure = screen.getByRole("button", {
      name: "Collapse sessions in Alpha",
    });
    const child = screen.getByRole("button", {
      name: "Plan, session in Alpha",
    });
    fireEvent.keyDown(disclosure, { key, shiftKey: key === "F10" });
    fireEvent.keyDown(child, { key, shiftKey: key === "F10" });
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
    const user = userEvent.setup();
    await user.click(disclosure);
    expect(onToggle).toHaveBeenCalledWith("session-children:alpha", false);
    expect(onSelect).not.toHaveBeenCalled();
    await user.click(child);
    expect(onSelect).toHaveBeenCalledWith("child");
  },
);

it.each(["Collapse sessions in Alpha", "Plan, session in Alpha"])(
  "retains focused %s across idle and working transitions",
  (name) => {
    const props = {
      ...itemProps(owner().session, false),
      sessions: [
        { id: "child", name: "Plan", channelType: "session" as const },
      ],
    };
    const view = render(<ChannelSidebarItem {...props} />);
    const control = screen.getByRole("button", { name });
    control.focus();
    for (const working of [true, false]) {
      view.rerender(<ChannelSidebarItem {...props} working={working} />);
      expect(screen.getByRole("button", { name })).toBe(control);
      expect(control).toHaveFocus();
    }
  },
);
