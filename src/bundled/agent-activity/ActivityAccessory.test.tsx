// @vitest-environment jsdom
import { createLocalAgentActivity } from "../../features/agents/local-activity";
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
import {
  ActivityAccessory,
  ActivityTypingReplacement,
} from "./ActivityAccessory";
import { TypingPresentation } from "../../features/conversation/typing-presentation";
import { TypingIndicator } from "../../features/messages/TypingIndicator";
import { createAgentActivity } from "../../features/agents/activity";
import { createAgentLibrary } from "../../features/agents/library";
import type { RelaySession } from "../../features/relay/session";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const A = "b".repeat(64),
  B = "c".repeat(64),
  viewer = "a".repeat(64),
  root = "1".repeat(64),
  next = "2".repeat(64);
function fixture(local?: ReturnType<typeof createLocalAgentActivity>) {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
  let generation = 0,
    serial = 0;
  const activity = createAgentActivity(
    true,
    (g) => {
      generation = g ?? 0;
    },
    () => true,
    undefined,
    undefined,
    undefined,
    local ? { source: local.reader, scope: "test" } : undefined,
  );
  const release = activity.queries.activate();
  const live = {
    status: "connected" as const,
    routes: [
      { id: "observer", status: "live" as const, replay: "unknown" as const },
    ],
  };
  activity.state(live);
  const profiles = new Map([
    [A, { name: "Blossom", isAgent: true }],
    [B, { name: "Bubbles", isAgent: true }],
  ]);
  const session = {
    viewer,
    presence: {
      subscribe: () => () => {},
      status: () => "online",
      limited: () => false,
    },
    agentActivity: activity.queries,
    agentChoices: createAgentLibrary(undefined).queries,
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: vi.fn(async () => {}),
    },
    live: { retry: () => activity.state(live) },
    media: () => undefined,
  } as unknown as RelaySession;
  const send = (
    agent: string,
    turnId: string,
    seq: number,
    kind: string,
    payload: unknown = {},
  ) =>
    act(() => {
      activity.receive(
        {
          id: (++serial).toString(16).padStart(64, "0"),
          agent,
          createdAt: Math.floor(Date.now() / 1000),
          plaintext: JSON.stringify({
            kind,
            turnId,
            channelId: "c",
            sessionId: "S",
            seq,
            timestamp: new Date().toISOString(),
            payload,
          }),
        },
        generation,
      );
    });
  const open = vi.fn(() => true);
  const props = {
    session,
    scope: "test",
    channelId: "c",
    threadRootId: root,
    message: {
      id: root,
      channelId: "c",
      authorId: viewer,
      createdAt: 1,
      content: "Request",
      mentions: [],
      attachments: [],
      reactions: [],
      participants: [],
      replyCount: 0,
    },
    canOpen: () => true,
    open,
  };
  return {
    activity,
    release,
    send,
    props,
    live,
    profiles,
    dispose: () => {
      release();
      activity.dispose();
    },
  };
}

it("shows one bubble with one avatar per agent across multiple turns, removing only the settled agent", () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "a1", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(A, "a2", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(B, "b1", 1, "turn_started", { triggeringEventIds: [root] });
    expect(
      screen.getAllByRole("button", { name: /View agent activity/ }),
    ).toHaveLength(1);
    expect(screen.getAllByTitle("Blossom")).toHaveLength(1);
    expect(screen.getAllByTitle("Bubbles")).toHaveLength(1);
    expect(view.container.querySelector(".buzz-avatar-status-dot")).toBeNull();
    f.send(A, "a1", 2, "turn_completed");
    expect(
      screen.getByRole("button", { name: /View agent activity: Blossom/ }),
    ).toBeInTheDocument();
    f.send(A, "a2", 2, "turn_completed");
    expect(
      screen.queryByRole("button", { name: /Blossom/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /View agent activity: Bubbles/ }),
    ).toBeInTheDocument();
    f.send(B, "b1", 2, "turn_completed");
    expect(
      screen.queryByLabelText("Agent activity on this message"),
    ).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});
it("does not show sibling thread work and reports lost freshness without pretending completion", () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "other", 1, "turn_started", { triggeringEventIds: [next] });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    f.send(B, "here", 1, "turn_started", { triggeringEventIds: [root] });
    act(() => vi.advanceTimersByTime(31000));
    expect(
      screen.getByRole("button", { name: /View agent activity: Bubbles/ }),
    ).toHaveTextContent("Status unknown");
    f.send(B, "here", 2, "turn_completed");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});
it("keeps namesakes as separate exact identities", () => {
  const f = fixture();
  f.profiles.set(B, { name: "Blossom", isAgent: true });
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "a", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(B, "b", 1, "turn_started", { triggeringEventIds: [root] });
    const avatars = screen.getAllByTitle(/Blossom/);
    expect(avatars).toHaveLength(2);
    expect(avatars[0]?.getAttribute("title")).not.toBe(
      avatars[1]?.getAttribute("title"),
    );
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("previews only live scoped actions and retains profile navigation", () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "old", 1, "turn_started", { triggeringEventIds: [root] });
    const thought = (text: string) => ({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text },
        },
      },
    });
    f.send(A, "old", 2, "acp_read", thought("Old thought"));
    f.send(A, "old", 3, "turn_completed");
    f.send(A, "new", 1, "turn_started", { triggeringEventIds: [root] });
    fireEvent.click(
      screen.getByRole("button", { name: /View agent activity/ }),
    );
    expect(
      screen.getByText("Waiting for activity details"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Old thought")).not.toBeInTheDocument();
    f.send(A, "new", 2, "acp_read", thought("Current thought"));
    expect(screen.getByText("Current thought")).toBeInTheDocument();
    f.send(B, "sibling", 1, "turn_started", { triggeringEventIds: [next] });
    f.send(B, "sibling", 2, "acp_read", thought("Private sibling thought"));
    expect(
      screen.queryByText("Private sibling thought"),
    ).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(31000));
    expect(
      screen.getByText("Activity interrupted or out of date"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Current thought")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "View activity for Blossom" }),
    );
    expect(f.props.open).toHaveBeenCalledExactlyOnceWith(
      `buzz:profile?agent=${A}&tab=activity`,
    );
  } finally {
    view.unmount();
    f.dispose();
  }
});
it("removes the whole popup when access is revoked", () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "a", 1, "turn_started", { triggeringEventIds: [root] });
    fireEvent.click(
      screen.getByRole("button", { name: /View agent activity/ }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    view.rerender(<ActivityAccessory {...f.props} canOpen={() => false} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("makes the compact avatar and tool preview one action, retaining the popup when opening fails", () => {
  const f = fixture();
  f.props.open.mockReturnValue(false);
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "a", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(A, "a", 2, "acp_read", {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "read",
          title: "buzz-dev-mcp__read_file",
          status: "in_progress",
          rawInput: { path: "/project/file.ts" },
        },
      },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /View agent activity/ }),
    );
    const popup = within(
      screen.getByRole("dialog", { name: "Agent activity" }),
    );
    expect(popup.getAllByRole("button")).toHaveLength(1);
    for (const text of [
      "Agent activity",
      "Latest reported activity for this message.",
      "Blossom",
      "View activity",
      "Close",
    ])
      expect(popup.queryByText(text, { exact: true })).not.toBeInTheDocument();
    const row = popup.getByRole("button", {
      name: "View activity for Blossom",
    });
    expect(row).toHaveTextContent("Read file · Running");
    expect(row.querySelector(".buzz-avatar")).not.toBeNull();
    fireEvent.click(popup.getByText("file.ts"));
    expect(f.props.open).toHaveBeenCalledExactlyOnceWith(
      `buzz:profile?agent=${A}&tab=activity`,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    view.rerender(
      <ActivityAccessory
        {...f.props}
        canOpen={(target) => !target.startsWith("buzz:profile?")}
      />,
    );
    expect(row).toBeDisabled();
    fireEvent.click(row);
    expect(f.props.open).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("keeps main's unassociated work visible, replacing it only for a linked message in this thread", () => {
  const f = fixture();
  const typing = [{ pubkey: A, channelId: "c", threadRootId: root }];
  const session = {
    ...f.props.session,
    typing: { snapshot: () => typing, subscribe: () => () => {} },
  } as unknown as RelaySession;
  const props = { ...f.props, session };
  const ui = (replacement: boolean) => (
    <TypingPresentation active>
      {/* MessageRow gives each row its own presentation scope. */}
      <TypingPresentation active>
        <ActivityAccessory {...props} />
      </TypingPresentation>
      {replacement && <ActivityTypingReplacement {...props} />}
      <TypingIndicator session={session} channelId="c" threadRootId={root} />
    </TypingPresentation>
  );
  const view = render(ui(true));
  try {
    f.send(A, "unlinked", 1, "turn_liveness");
    expect(
      screen.getByRole("button", { name: "Activity: Blossom working" }),
    ).toBeInTheDocument();
    f.send(A, "sibling", 1, "turn_started", { triggeringEventIds: [next] });
    expect(
      screen.getByRole("button", { name: "Activity: Blossom working" }),
    ).toBeInTheDocument();
    f.send(A, "here", 1, "turn_started", { triggeringEventIds: [root] });
    expect(
      screen.getByRole("button", {
        name: "View agent activity: Blossom, working",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Activity: Blossom working" }),
    ).not.toBeInTheDocument();
    view.rerender(ui(false));
    expect(
      screen.getByRole("button", { name: "Activity: Blossom working" }),
    ).toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("shows local receipt and failure without requiring an ACP transcript, and opens the agent profile", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    let work!: ReturnType<typeof local.begin>;
    act(() => {
      work = local.begin({
        scope: "test",
        channelId: "c",
        threadRootId: root,
        messageId: root,
        agent: A,
      });
    });
    const bubble = screen.getByRole("button", {
      name: "View agent activity: Blossom, Received · waiting to start",
    });
    expect(bubble.querySelector('[data-state="waiting"]')).not.toBeNull();
    act(() => work.started());
    expect(bubble).toHaveAccessibleName(
      "View agent activity: Blossom, Starting",
    );
    expect(bubble.querySelector('[data-state="waiting"]')).not.toBeNull();
    act(() => work.step("Read", "notes.txt"));
    expect(bubble).toHaveAccessibleName(
      "View agent activity: Blossom, Reading notes.txt",
    );
    expect(bubble.querySelector('[data-state="working"]')).not.toBeNull();
    act(() => work.finish({ ok: false, error: "Provider unavailable" }));
    expect(bubble).toHaveTextContent("Could not finish");
    expect(bubble.querySelector("[data-state]")).toBeNull();
    fireEvent.click(bubble);
    expect(screen.getByText("Provider unavailable")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "View activity for Blossom" }),
    );
    expect(f.props.open).toHaveBeenCalledExactlyOnceWith(
      `buzz:profile?agent=${A}&tab=activity`,
    );
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("dismisses only that agent's error on this message, without changing other work", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const onFocusedRemoval = vi.fn();
  const view = render(
    <ActivityAccessory {...f.props} onFocusedRemoval={onFocusedRemoval} />,
  );
  const begin = (agent: string, messageId: string) =>
    local.begin({
      scope: "test",
      channelId: "c",
      threadRootId: root,
      messageId,
      agent,
    });
  try {
    act(() => {
      begin(A, root).finish({
        ok: false,
        error: "Provider unavailable after a long and detailed reason",
      });
      begin(A, next).finish({ ok: false, error: "Elsewhere" });
      begin(B, root).step("Read", "notes.txt");
    });
    fireEvent.click(
      screen.getByRole("button", { name: /View agent activity/ }),
    );
    expect(
      screen.getByText("Provider unavailable after a long and detailed reason")
        .parentElement,
    ).toHaveAttribute("data-error");
    expect(
      screen.queryByRole("button", { name: "Dismiss error from Bubbles" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss error from Blossom" }),
    );
    expect(f.props.open).not.toHaveBeenCalled();
    expect(onFocusedRemoval).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "View activity for Bubbles" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "View activity for Blossom" }),
    ).toBeNull();
    expect(
      local.reader
        .work()
        .filter((row) => row.agent === A)
        .map((row) => [row.messageId, row.state, row.dismissed]),
    ).toEqual([
      // The outcome remains as settled evidence; only its display is hidden.
      [root, "error", true],
      [next, "error", undefined],
    ]);
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("moves focus out when dismissing the last error removes the bubble", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const onFocusedRemoval = vi.fn();
  const view = render(
    <ActivityAccessory {...f.props} onFocusedRemoval={onFocusedRemoval} />,
  );
  try {
    act(() => {
      local
        .begin({
          scope: "test",
          channelId: "c",
          threadRootId: root,
          messageId: root,
          agent: A,
        })
        .finish({ ok: false, error: "Provider unavailable" });
    });
    fireEvent.click(
      screen.getByRole("button", { name: /View agent activity/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss error from Blossom" }),
    );
    expect(onFocusedRemoval).toHaveBeenCalledOnce();
    expect(screen.queryByText("Provider unavailable")).toBeNull();
  } finally {
    view.unmount();
    f.dispose();
  }
});
