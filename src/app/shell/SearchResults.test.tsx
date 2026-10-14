// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createRef, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { type Filter, matchFilter } from "nostr-tools";
import { npubEncode } from "nostr-tools/nip19";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import { eventDto } from "../../features/relay/events";
import { ReadError } from "../../features/relay/errors";
import {
  keypair,
  message,
  metadata,
  profile,
  roster,
  scriptedTransport,
  signed,
} from "../../features/relay/testing";
import type { LiveCallbacks } from "../../features/relay/live";
import { SearchResults } from "./SearchResults";
import {
  readSearchUsage,
  recordChoice,
  recordVisit,
} from "../../features/search/usage";
import { ChatCircleIcon } from "../../shared/design-system/icons/index";

// jsdom lacks scrollIntoView; the palette reveals its typed-text selection.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it("opens with a conversation action and recent channels in activity order", async () => {
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "older", "older", 1700000000),
    roster(relay, "older", [viewer.pubkey]),
    metadata(relay, "latest", "latest", 1700000100),
    roster(relay, "latest", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const changeScope = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query=""
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        currentChannelId="older"
        onScopeChange={changeScope}
        openConversation={() => {}}
      />,
    );
    const action = await screen.findByRole("option", {
      name: /Search in older/,
    });
    const recent = within(
      screen.getByRole("group", { name: "Recent activity" }),
    );
    const [first, second] = recent.getAllByRole("option");
    expect(first).toHaveTextContent("latest");
    expect(second).toHaveTextContent("older");
    fireEvent.click(action);
    expect(changeScope).toHaveBeenCalledExactlyOnceWith("older");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("ranks typed channel names and selects the best one for Enter", async () => {
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  // Weak matches come first in list order and exceed the eight-row limit.
  const names = [
    ...Array.from({ length: 8 }, (_, index) => `xlar-${index}`),
    "the-lar",
    "lar-crew",
    "lar",
  ];
  const discovery = names.flatMap((name, index) => [
    metadata(relay, name, name, 1700000000 + index),
    roster(relay, name, [viewer.pubkey]),
  ]);
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const open = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="lar"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        currentChannelId="xlar-0"
        onScopeChange={() => {}}
        openConversation={open}
      />,
    );
    const channels = await screen.findByRole("group", { name: "Channels" });
    await waitFor(() =>
      expect(within(channels).getAllByRole("option")).toHaveLength(8),
    );
    expect(
      within(channels)
        .getAllByRole("option")
        .slice(0, 4)
        .map((option) => option.textContent),
    ).toEqual([
      expect.stringMatching(/^lar/),
      expect.stringMatching(/^lar-crew/),
      expect.stringMatching(/^the-lar/),
      expect.stringMatching(/^xlar-/),
    ]);
    // The scope action follows named results, so it is not selected first.
    const groups = screen
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-label"));
    expect(groups.indexOf("This conversation")).toBeGreaterThan(
      groups.indexOf("Channels"),
    );
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      within(channels).getAllByRole("option")[0]?.id,
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(open).toHaveBeenCalledExactlyOnceWith("lar");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("fuzzy-matches channel names after substring matches, word starts first", async () => {
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const names = [
    "big-grape",
    "buzz-github-prs",
    "debug-pr",
    "general",
    "ops-bgp",
  ];
  const discovery = names.flatMap((name, index) => [
    metadata(relay, name, name, 1700000000 + index),
    roster(relay, name, [viewer.pubkey]),
  ]);
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const open = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="bgp"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={open}
      />,
    );
    const channels = await screen.findByRole("group", { name: "Channels" });
    // The substring match leads. Initials ("b"uzz-"g"ithub-"p"rs) come next,
    // then names that merely hold the letters in order. "general" has no "b".
    await waitFor(() =>
      expect(
        within(channels)
          .getAllByRole("option")
          .map((option) => option.textContent?.split(/[A-Z]/)[0]),
      ).toEqual([
        "ops-bgp",
        "buzz-github-prs",
        expect.stringMatching(/^(big-grape|debug-pr)$/),
        expect.stringMatching(/^(big-grape|debug-pr)$/),
      ]),
    );
    // The matched letters are underlined, and only those letters.
    const marks = (name: string) =>
      [
        ...within(channels)
          .getByRole("option", { name: new RegExp(`^${name}`) })
          .querySelectorAll("mark"),
      ].map((mark) => mark.textContent);
    expect(marks("ops-bgp")).toEqual(["bgp"]);
    expect(marks("buzz-github-prs")).toEqual(["b", "g", "p"]);
    expect(marks("debug-pr")).toEqual(["b", "g", "p"]);
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(open).toHaveBeenCalledExactlyOnceWith("ops-bgp");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("leads with the group holding the best match and ranks archived channels after live ties", async () => {
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "space", "team-workspace", 1700000000),
    roster(relay, "space", [viewer.pubkey]),
    signed(relay, {
      kind: 39000,
      created_at: 1700000001,
      content: "",
      tags: [
        ["d", "old"],
        ["t", "stream"],
        ["name", "work-old"],
        ["archived", "true"],
      ],
    }),
    roster(relay, "old", [viewer.pubkey]),
    metadata(relay, "log", "work-log", 1700000002),
    roster(relay, "log", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      return discovery.filter((event) =>
        filters.some((filter) => filter.kinds?.includes(event.kind)),
      );
    },
  });
  const work = vi.fn();
  const page = (label: string, run = () => {}) => ({
    key: label,
    label,
    icon: ChatCircleIcon,
    run,
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="work"
        onQueryChange={() => {}}
        input={createRef()}
        // PageSearch ranks pages before they arrive here.
        pages={[page("Work", work), page("Workflows")]}
        openConversation={() => {}}
      />,
    );
    const channels = await screen.findByRole("group", { name: "Channels" });
    await waitFor(() =>
      expect(within(channels).getAllByRole("option")).toHaveLength(3),
    );
    expect(
      within(channels)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      expect.stringMatching(/^work-log/),
      expect.stringMatching(/^work-old/),
      expect.stringMatching(/^team-workspace/),
    ]);
    const groups = screen
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-label"));
    expect(groups.slice(0, 2)).toEqual(["Pages", "Channels"]);
    const pages = screen.getByRole("group", { name: "Pages" });
    expect(
      within(pages)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Work", "Workflows"]);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    expect(work).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("shows the real read failure, retains conversation choices, and retries to an exact message", async () => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "crew", "wes-crew"),
    roster(relay, "crew", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      if (filters.some((filter) => filter.search !== undefined))
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const open = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="wes-cr"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={open}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    const request = wire.next();
    expect(request.filters).toEqual([
      {
        kinds: [40002, 40008, 9], // The real reader canonicalizes set order.
        search: "wes-cr",
        search_mode: "prefix",
        limit: 20,
      },
    ]);
    await act(async () =>
      request.fail(new ReadError("unavailable", "Relay read timed out")),
    );
    expect(
      screen.getByText(/Message search couldn’t finish: Relay read timed out/),
    ).toBeVisible();
    expect(screen.getByRole("option", { name: /wes-crew/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry messages" }));
    expect(screen.queryByText(/Message search couldn’t finish/)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    const hit = message(viewer, "crew", "wes-crew exact message", 1700000001);
    await act(async () => wire.next().respond([hit]));
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    // Typed text selects the first result; the late message sits below it.
    expect(
      screen.getByRole("option", { name: /^wes-crew(?! exact)/ }),
    ).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(
      screen.getByRole("option", { name: /wes-crew exact message/ }),
    ).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(open).toHaveBeenCalledExactlyOnceWith("crew", hit.id);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("scopes conversation search at the relay and discards out-of-scope hits", async () => {
  vi.useFakeTimers();
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey]),
    metadata(relay, "other", "other"),
    roster(relay, "other", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      if (filters.some((filter) => filter.search !== undefined))
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const changeScope = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="scope"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        scopedChannelId="crew"
        onScopeChange={changeScope}
        openConversation={() => {}}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(180));
    const request = wire.next();
    expect(request.filters).toEqual([
      {
        kinds: [40002, 40008, 9],
        search: "scope",
        search_mode: "prefix",
        limit: 20,
        "#h": ["crew"],
      },
    ]);
    await act(async () =>
      request.respond([
        message(viewer, "crew", "scope match", 1700000001),
        message(viewer, "other", "scope elsewhere", 1700000002),
      ]),
    );
    expect(screen.getByRole("option", { name: /scope match/ })).toBeVisible();
    expect(
      screen.queryByRole("option", { name: /scope elsewhere/ }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /Remove .* search scope/ }),
    );
    expect(changeScope).toHaveBeenCalledExactlyOnceWith();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(["metadata", "denial"])(
  "does not resurrect displayed public hits after %s loss and regrant",
  async (loss) => {
    vi.useFakeTimers();
    const relay = keypair(),
      viewer = keypair();
    const hit = message(viewer, "open", "crew public result", 1700000000);
    let live: LiveCallbacks | undefined;
    const metadata = (privateChannel: boolean, created_at: number) =>
      signed(relay, {
        kind: 39000,
        created_at,
        content: "",
        tags: [
          ["d", "open"],
          ["name", "Public"],
          [privateChannel ? "private" : "public"],
        ],
      });
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      async query(filters) {
        return filters.some((filter) => filter.search)
          ? [hit]
          : filters.some((filter) => filter.kinds?.includes(39000))
            ? [metadata(false, 1700000000)]
            : [];
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    try {
      render(
        <SearchResults
          session={owner.session}
          query="crew"
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openConversation={() => {}}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(180);
      });
      expect(
        screen.getByRole("option", { name: /crew public result/ }),
      ).toBeVisible();
      const before = owner.session.channels.list();
      act(() => {
        if (loss === "denial")
          live?.denied("open", "restricted: not a channel member");
        else live?.receive([metadata(true, 1700000001)]);
        const denied = owner.session.channels.list();
        expect(denied).not.toBe(before);
        expect(denied.channels).toBe(before.channels);
        live?.receive([metadata(false, 1700000002)]);
      });
      expect(
        screen.queryByRole("option", { name: /crew public result/ }),
      ).toBeNull();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("does not reveal a revoked public hit queued before React commits its result", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const hit = message(viewer, "open", "crew queued result", 1700000000);
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live: LiveCallbacks | undefined;
  const publicEvent = (created_at: number) =>
    signed(relay, {
      kind: 39000,
      created_at,
      content: "",
      tags: [["d", "open"], ["public"]],
    });
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      if (filters.some((filter) => filter.search))
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        filters.some((filter) => filter.kinds?.includes(39000))
          ? [publicEvent(1700000000)]
          : [],
      );
    },
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    await act(async () => {
      wire.next().respond([hit]);
      // Drain the finite reader and palette's promise callback, without a React commit.
      await vi.advanceTimersByTimeAsync(0);
      live?.denied("open", "restricted: not a channel member");
      live?.receive([publicEvent(1700000001)]);
    });
    expect(
      screen.queryByRole("option", { name: /crew queued result/ }),
    ).toBeNull();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(["", "Crew"])(
  "explains cold conversation loading without redundant banners (query=%s)",
  async (query) => {
    const relay = keypair();
    const viewer = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const discovery = [
      metadata(relay, "crew", "Crew"),
      roster(relay, "crew", [viewer.pubkey]),
    ];
    const owner = createRelaySession({
      ...wire.transport,
      query(filters, signal) {
        return filters.some((filter) => filter.kinds?.includes(39002))
          ? wire.transport.query(filters, signal)
          : Promise.resolve(discovery);
      },
    });
    try {
      render(
        <SearchResults
          session={owner.session}
          query={query}
          onQueryChange={() => {}}
          input={createRef()}
          pages={[
            {
              key: "settings",
              label: "Settings",
              icon: ChatCircleIcon,
              run() {},
            },
          ]}
          openConversation={() => {}}
        />,
      );
      const pending = wire.next();
      expect(owner.session.channels.list().status).toBe("loading");
      expect(screen.getByRole("option", { name: /Settings/ })).toBeVisible();
      if (query) {
        expect(screen.getByText("Loading joined conversations…")).toBeVisible();
        expect(screen.queryByText("Loading recent conversations…")).toBeNull();
      } else {
        expect(screen.getByText("Loading recent conversations…")).toBeVisible();
        expect(screen.queryByText("Loading joined conversations…")).toBeNull();
      }
      await act(async () => pending.respond(discovery));
      expect(await screen.findByRole("option", { name: /Crew/ })).toBeVisible();
      expect(screen.queryByText("Loading joined conversations…")).toBeNull();
      expect(screen.getByRole("option", { name: /Settings/ })).toBeVisible();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("does not announce conversation enrichment over retained search choices", () => {
  const owner = createRelaySession(null);
  const session = {
    ...owner.session,
    channels: {
      ...owner.session.channels,
      list: () => list,
      ensureList() {},
    },
  };
  const list = {
    status: "loading" as const,
    channels: [{ id: "crew", name: "Crew", channelType: "stream" as const }],
  };
  try {
    render(
      <SearchResults
        session={session}
        query="Crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    expect(screen.getByRole("option", { name: /Crew/ })).toBeVisible();
    expect(screen.queryByText("Loading joined conversations…")).toBeNull();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(["stream", "forum", "session"] as const)(
  "finds joined archived %s channels by name without putting them in Recent activity",
  async (channelType) => {
    const relay = keypair(),
      viewer = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const discovery = [
      signed(relay, {
        kind: 39000,
        created_at: 1700000000,
        content: "",
        tags: [
          ["d", "archive"],
          ["t", channelType === "session" ? "stream" : channelType],
          ...(channelType === "session"
            ? [["private"], ["about", "Buzz session (buzz.sessions/v1)"]]
            : []),
          ["name", "Past project"],
          ["archived", "true"],
        ],
      }),
      roster(relay, "archive", [viewer.pubkey]),
      metadata(relay, "active", "Current project"),
      roster(relay, "active", [viewer.pubkey]),
    ];
    const owner = createRelaySession({
      ...wire.transport,
      async query(filters) {
        return discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        );
      },
    });
    const open = vi.fn();
    const props = {
      session: owner.session,
      onQueryChange: () => {},
      input: createRef<HTMLInputElement>(),
      pages: [],
      openConversation: open,
    };
    try {
      const mounted = render(<SearchResults {...props} query="" />);
      await screen.findByRole("option", { name: /Current project/ });
      expect(owner.session.channels.get?.("archive")?.channelType).toBe(
        channelType,
      );
      expect(screen.queryByRole("option", { name: /Past project/ })).toBeNull();
      mounted.rerender(<SearchResults {...props} query="Past" />);
      fireEvent.click(
        await screen.findByRole("option", {
          name: /Past project/,
        }),
      );
      expect(screen.getByText("Archived channel")).toBeTruthy();
      expect(open).toHaveBeenCalledExactlyOnceWith("archive");
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it.each([
  { channelType: "stream", readOnly: true },
  { channelType: "forum", readOnly: true },
  { channelType: "session", readOnly: true },
  { channelType: "dm" },
] as const)(
  "does not surface archived nonmember or non-channel destinations: %j",
  (state) => {
    const owner = createRelaySession(null);
    const snapshot = {
      status: "ready" as const,
      channels: [
        {
          id: "excluded",
          name: "Past project",
          archived: true as const,
          ...state,
        },
      ],
    };
    const session = {
      ...owner.session,
      channels: {
        ...owner.session.channels,
        list: () => snapshot,
        ensureList() {},
      },
    };
    try {
      render(
        <SearchResults
          session={session}
          query="Past"
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openConversation={() => {}}
        />,
      );
      expect(screen.queryByRole("option", { name: /Past project/ })).toBeNull();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("finds active public channels the viewer has not joined without adding them to the joined list", async () => {
  const relay = keypair();
  const viewer = keypair();
  const other = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const open = [
    ["public", ""],
    ["t", "stream"],
  ];
  const discovery = [
    metadata(relay, "joined", "crew-chat", 1700000000, open),
    roster(relay, "joined", [viewer.pubkey]),
    metadata(relay, "lobby", "crew-lobby", 1700000000, open),
    roster(relay, "lobby", [other.pubkey]),
    metadata(relay, "secret", "crew-secret", 1700000000, [
      ["private", ""],
      ["t", "stream"],
    ]),
    metadata(relay, "old", "crew-old", 1700000000, [
      ...open,
      ["archived", "true"],
    ]),
    metadata(relay, "dm", "crew-dm", 1700000000, [
      ["public", ""],
      ["hidden", ""],
      ["t", "dm"],
    ]),
    // Only relay-signed metadata is channel authority.
    metadata(other, "forged", "crew-forged", 1700000000, open),
  ];
  const reads: unknown[] = [];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      reads.push(filters);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={openConversation}
      />,
    );
    const lobby = await screen.findByRole("option", { name: /crew-lobby/ });
    expect(lobby).toHaveTextContent("Public channel · not joined");
    const group = within(screen.getByRole("group", { name: "Channels" }));
    expect(
      group.getAllByRole("option").map((option) => option.textContent),
    ).toEqual([
      expect.stringContaining("crew-chat"),
      expect.stringContaining("crew-lobby"),
    ]);
    for (const hidden of ["crew-secret", "crew-old", "crew-dm", "crew-forged"])
      expect(
        screen.queryByRole("option", { name: new RegExp(hidden) }),
      ).toBeNull();
    // The match resolved through exact signed metadata and the viewer roster.
    expect(reads).toContainEqual([
      expect.objectContaining({ kinds: [39000], "#d": ["lobby"] }),
      expect.objectContaining({
        kinds: [39002],
        "#d": ["lobby"],
        "#p": [viewer.pubkey],
      }),
    ]);
    expect(owner.session.channels.get?.("lobby")).toMatchObject({
      readOnly: true,
      name: "crew-lobby",
    });
    expect(
      owner.session.channels.list().channels.map((channel) => channel.id),
    ).toEqual(["joined"]);
    fireEvent.click(lobby);
    expect(openConversation).toHaveBeenCalledExactlyOnceWith("lobby");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("returns keyboard focus to search when channel lookup retries, through repeated failure and recovery", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const relay = keypair();
  const viewer = keypair();
  const other = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const open = [
    ["public", ""],
    ["t", "stream"],
  ];
  const discovery = [
    metadata(relay, "joined", "other-chat", 1700000000, open),
    roster(relay, "joined", [viewer.pubkey]),
    metadata(relay, "lobby", "crew-lobby", 1700000000, open),
    roster(relay, "lobby", [other.pubkey]),
  ];
  let failures = 2;
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      // Only the public-channel page read fails; exact lookups still succeed.
      if (
        failures > 0 &&
        filters.some(
          (filter) => filter.kinds?.includes(39000) && !filter["#d"],
        ) &&
        !filters.some((filter) => filter.kinds?.includes(39002))
      ) {
        failures--;
        return Promise.reject(new Error("Relay read timed out"));
      }
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={openConversation}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    for (let attempt = 0; attempt < 2; attempt++) {
      const retry = await screen.findByRole("button", {
        name: "Retry channels",
      });
      retry.focus();
      fireEvent.click(retry);
      expect(
        screen.queryByRole("button", { name: "Retry channels" }),
      ).toBeNull();
      expect(input).toHaveFocus();
    }
    const lobby = await screen.findByRole("option", { name: /crew-lobby/ });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(lobby).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(openConversation).toHaveBeenCalledExactlyOnceWith("lobby");
  } finally {
    cleanup();
    owner.dispose();
  }
});

function usageSession(
  names: readonly string[],
  publicNames: readonly string[] = [],
) {
  const relay = keypair();
  const viewer = keypair();
  const other = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const open = [
    ["public", ""],
    ["t", "stream"],
  ];
  const discovery = [
    ...names.flatMap((name, index) => [
      metadata(relay, name, name, 1700000000 + index),
      roster(relay, name, [viewer.pubkey]),
    ]),
    ...publicNames.flatMap((name) => [
      metadata(relay, name, name, 1700000000, open),
      roster(relay, name, [other.pubkey]),
    ]),
  ];
  return createRelaySession({
    ...wire.transport,
    query(filters) {
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
}

const usage = `wss://relay.example:${"a".repeat(64)}`;
const optionNames = (group: string) =>
  within(screen.getByRole("group", { name: group }))
    .getAllByRole("option")
    .map((option) => option.textContent?.split(/Conversation|Public/)[0]);

it("puts the earlier choice for typed text first, unless another name is exact", async () => {
  localStorage.clear();
  recordChoice(usage, "wo", "channel:team-work");
  const owner = usageSession(["work", "team-work", "workshop"]);
  const open = vi.fn();
  const props = {
    session: owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLElement>(),
    pages: [],
    openConversation: open,
    usageScope: usage,
  };
  try {
    const { rerender } = render(<SearchResults {...props} query="wor" />);
    await waitFor(() =>
      expect(optionNames("Channels")).toEqual([
        "team-work",
        "work",
        "workshop",
      ]),
    );
    const combobox = screen.getByRole("combobox", { name: "Search Buzz" });
    fireEvent.keyDown(combobox, { key: "Enter" });
    expect(open).toHaveBeenLastCalledWith("team-work");
    // Typing a channel's whole name opens that channel.
    rerender(<SearchResults {...props} query="work" />);
    expect(optionNames("Channels")).toEqual(["work", "team-work", "workshop"]);
    fireEvent.keyDown(combobox, { key: "Enter" });
    expect(open).toHaveBeenLastCalledWith("work");
    // Each choice is remembered for the text that led to it.
    const remembered = readSearchUsage(usage);
    const all = new Set(["channel:work", "channel:team-work"]);
    expect(remembered.pick("work", all)).toBe("channel:work");
    expect(remembered.pick("wor", all)).toBe("channel:team-work");
  } finally {
    cleanup();
    owner.dispose();
    localStorage.clear();
  }
});

it("puts a remembered public channel first, even past eight joined matches", async () => {
  localStorage.clear();
  recordChoice(usage, "wo", "channel:team-work");
  const joined = Array.from({ length: 8 }, (_, n) => `work-${n + 1}`);
  const owner = usageSession(joined, ["team-work"]);
  try {
    render(
      <SearchResults
        session={owner.session}
        query="wo"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[
          {
            key: "Workflows",
            label: "Workflows",
            icon: ChatCircleIcon,
            run() {},
          },
        ]}
        openConversation={() => {}}
        usageScope={usage}
      />,
    );
    // The group leads because of the remembered row, so that row leads it.
    await waitFor(() => expect(optionNames("Channels")[0]).toBe("team-work"));
    expect(optionNames("Channels")).toHaveLength(8);
    expect(
      screen
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-label"))
        .slice(0, 2),
    ).toEqual(["Channels", "Pages"]);
  } finally {
    cleanup();
    owner.dispose();
    localStorage.clear();
  }
});

it("lets frequent visits lift a match past a slightly better one, not a much better one", async () => {
  localStorage.clear();
  for (let visit = 0; visit < 20; visit++) {
    recordVisit(usage, "channel:the-lar");
    recordVisit(usage, "channel:xlarx");
  }
  const owner = usageSession(["xlarx", "the-lar", "lar-crew"]);
  try {
    render(
      <SearchResults
        session={owner.session}
        query="lar"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
        usageScope={usage}
      />,
    );
    // Word start beats prefix with usage; a busy substring match does not.
    await waitFor(() =>
      expect(optionNames("Channels")).toEqual(["the-lar", "lar-crew", "xlarx"]),
    );
  } finally {
    cleanup();
    owner.dispose();
    localStorage.clear();
  }
});

it("keeps the remembered choice selected when a better match arrives late", async () => {
  localStorage.clear();
  recordChoice(usage, "wor", "Workflows");
  const owner = usageSession([], ["wor"]);
  const workflows = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="wor"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[
          {
            key: "Workflows",
            label: "Workflows",
            icon: ChatCircleIcon,
            run: workflows,
          },
        ]}
        openConversation={() => {}}
        usageScope={usage}
      />,
    );
    const page = screen.getByRole("option", { name: "Workflows" });
    expect(page).toHaveAttribute("aria-selected", "true");
    // The relay's exact public match leads its group above Pages, later.
    await screen.findByRole("option", { name: /^wor/ });
    expect(
      screen
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-label"))
        .slice(0, 2),
    ).toEqual(["Channels", "Pages"]);
    expect(page).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    expect(workflows).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    owner.dispose();
    localStorage.clear();
  }
});

it("translates combined operators into a single server-ranked scoped read and opens the match", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      if (filters.some((filter) => filter.search !== undefined))
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        [
          metadata(relay, "crew", "crew"),
          roster(relay, "crew", [viewer.pubkey]),
        ].filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const open = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="deploy in:#crew from:@alice after:2024-01-15 before:2024-02-01"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={open}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(180));
    const users = wire.next();
    expect(users.filters).toEqual([
      { kinds: [0], search: "alice", search_mode: "prefix", limit: 40 },
    ]);
    await act(async () =>
      users.respond([profile(alice, { display_name: "Alice" })]),
    );
    const request = wire.next();
    expect(request.filters).toEqual([
      {
        kinds: [40002, 40008, 9],
        search: "deploy",
        search_mode: "prefix",
        limit: 20,
        "#h": ["crew"],
        authors: [alice.pubkey],
        since: Math.floor(new Date(2024, 0, 15).getTime() / 1000),
        until: Math.floor(new Date(2024, 1, 1).getTime() / 1000) - 1,
      },
    ]);
    const hit = message(alice, "crew", "deploy matched", 1700000001);
    await act(async () => request.respond([hit]));
    fireEvent.click(screen.getByRole("option", { name: /deploy matched/ }));
    expect(open).toHaveBeenCalledExactlyOnceWith("crew", hit.id);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("does not read messages for punctuation-only operands after normalization", async () => {
  const relay = keypair(),
    viewer = keypair();
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(9)))
        reads.push(filters as Filter[]);
      return Promise.resolve([]);
    },
  });
  const props = {
    session: owner.session,
    onQueryChange: vi.fn(),
    input: createRef<HTMLInputElement>(),
    pages: [],
    openConversation: vi.fn(),
  };
  try {
    const view = render(<SearchResults {...props} query="in:#" />);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 240)));
    expect(reads).toHaveLength(0);
    view.rerender(<SearchResults {...props} query="from:. " />);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 240)));
    expect(reads).toHaveLength(0);
    view.rerender(<SearchResults {...props} query="in:# after:2024-01-15" />);
    await waitFor(() => expect(reads).toHaveLength(1));
    expect(reads[0]).toEqual([
      expect.objectContaining({
        since: Math.floor(new Date(2024, 0, 15).getTime() / 1000),
      }),
    ]);
    expect(reads[0]?.[0]).not.toHaveProperty("search");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("runs operator-only date and author searches without a text predicate", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const channel = "crew";
  const before = message(alice, channel, "before the cutoff", 1700000001);
  const after = message(alice, channel, "after the cutoff", 1800000001);
  const discovery = [
    metadata(relay, channel, "Wes"),
    roster(relay, channel, [viewer.pubkey]),
  ];
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([profile(alice, { display_name: "Alice" })]);
      if (filters.some((filter) => filter.kinds?.includes(9))) {
        reads.push(filters as Filter[]);
        return Promise.resolve(
          [before, after].filter((event) =>
            filters.some((filter) => matchFilter(filter as Filter, event)),
          ),
        );
      }
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  const props = {
    session: owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openConversation: () => {},
  };
  try {
    const mounted = render(
      <SearchResults
        {...props}
        query="before:2026-10-01"
        scopedChannelId={channel}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /before the cutoff/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: /after the cutoff/ }),
    ).toBeNull();
    expect(reads.at(-1)).toEqual([
      expect.objectContaining({
        "#h": [channel],
        until: Math.floor(new Date(2026, 9, 1).getTime() / 1000) - 1,
      }),
    ]);
    expect(reads.at(-1)?.[0]).not.toHaveProperty("search");
    mounted.rerender(
      <SearchResults
        {...props}
        query="after:2026-10-01"
        scopedChannelId={channel}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /after the cutoff/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: /before the cutoff/ }),
    ).toBeNull();
    mounted.rerender(<SearchResults {...props} query="from:alice " />);
    expect(
      await screen.findByRole("option", { name: /after the cutoff/ }),
    ).toBeVisible();
    expect(reads.at(-1)).toEqual([
      expect.objectContaining({ authors: [alice.pubkey] }),
    ]);
    expect(reads.at(-1)?.[0]).not.toHaveProperty("search");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(["from:ba", "from:@ba"])(
  "%s opens the same prefix picker and never reads messages before identity selection",
  async (query) => {
    const relay = keypair(),
      viewer = keypair(),
      human = keypair();
    const reads: Filter[][] = [];
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query(filters) {
        if (filters.some((filter) => filter.kinds?.includes(9)))
          reads.push(filters as Filter[]);
        if (filters.some((filter) => filter.kinds?.includes(0)))
          return Promise.resolve([profile(human, { display_name: "Baxen" })]);
        return Promise.resolve([]);
      },
    });
    const change = vi.fn();
    try {
      render(
        <SearchResults
          session={owner.session}
          query={query}
          onQueryChange={change}
          input={createRef()}
          pages={[]}
          openConversation={() => {}}
        />,
      );
      const people = within(screen.getByRole("group", { name: "People" }));
      const choice = await people.findByRole("option", { name: /Baxen/ });
      expect(reads).toHaveLength(0);
      fireEvent.click(choice);
      expect(change).toHaveBeenCalledWith(`from:${human.pubkey} `);
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("requests a bounded prefix page before declaring a short name absent", async () => {
  const relay = keypair(),
    viewer = keypair(),
    wes = keypair();
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0))) {
        reads.push(filters as Filter[]);
        return Promise.resolve([profile(wes, { display_name: "Wes" })]);
      }
      return Promise.resolve([]);
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="from:@we"
        onQueryChange={vi.fn()}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    expect(await screen.findByRole("option", { name: /Wes/ })).toBeVisible();
    expect(reads).toContainEqual([
      { kinds: [0], search: "we", search_mode: "prefix", limit: 40 },
    ]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(["from:we"])(
  "%s retains a confirmed channel member when global prefix lookup fails",
  async (query) => {
    const relay = keypair(),
      viewer = keypair(),
      wes = keypair();
    const channel = "crew";
    const discovery = [
      metadata(relay, channel, "crew"),
      roster(relay, channel, [viewer.pubkey, wes.pubkey]),
    ];
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query(filters) {
        if (filters.some((filter) => filter.search === "we"))
          return Promise.reject(new Error("prefix lookup unavailable"));
        if (filters.some((filter) => filter.kinds?.includes(0)))
          return Promise.resolve([profile(wes, { display_name: "Wes" })]);
        return Promise.resolve(
          discovery.filter((event) =>
            filters.some((filter) => matchFilter(filter as Filter, event)),
          ),
        );
      },
    });
    const change = vi.fn();
    try {
      render(
        <SearchResults
          session={owner.session}
          query={query}
          onQueryChange={change}
          scopedChannelId={channel}
          input={createRef()}
          pages={[]}
          openConversation={() => {}}
        />,
      );
      const choice = await within(
        screen.getByRole("group", { name: "People" }),
      ).findByRole("option", { name: /Wes/ });
      fireEvent.click(choice);
      expect(change).toHaveBeenCalledWith(`from:${wes.pubkey} `);
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("distinguishes an unavailable global author lookup from no matching people", async () => {
  const relay = keypair(),
    viewer = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.search === "we"))
        return Promise.reject(new Error("prefix lookup unavailable"));
      return Promise.resolve([]);
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="from:@we"
        onQueryChange={vi.fn()}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    expect(
      await screen.findByText(
        "People search is unavailable. Try a longer name.",
      ),
    ).toBeVisible();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("offers a bounded from:@ picker with distinct identities and selects an exact author", async () => {
  const relay = keypair(),
    viewer = keypair(),
    first = keypair(),
    second = keypair();
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey]),
  ];
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([
          profile(first, { display_name: "Baxen" }),
          profile(second, { display_name: "Baxen" }),
        ]);
      if (filters.some((filter) => filter.kinds?.includes(9))) {
        reads.push(filters as Filter[]);
        return Promise.resolve([
          message(second, "crew", "chosen author", 1700000010),
        ]);
      }
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  const change = vi.fn();
  try {
    const mounted = render(
      <SearchResults
        session={owner.session}
        query="from:@baxen"
        onQueryChange={change}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    const people = within(screen.getByRole("group", { name: "People" }));
    expect(await people.findAllByRole("option")).toHaveLength(2);
    expect(reads).toHaveLength(0);
    mounted.rerender(
      <SearchResults
        session={owner.session}
        query="from:baxen"
        onQueryChange={change}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    const ambiguous = within(
      await screen.findByRole("group", { name: "People" }),
    );
    expect(await ambiguous.findAllByRole("option")).toHaveLength(2);
    expect(reads).toHaveLength(0);
    fireEvent.click(ambiguous.getAllByRole("option")[1] as HTMLElement);
    expect(change).toHaveBeenCalledWith(`from:${second.pubkey} `);
    mounted.rerender(
      <SearchResults
        session={owner.session}
        query={`from:${second.pubkey} `}
        onQueryChange={change}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /chosen author/ }),
    ).toBeVisible();
    expect(reads.at(-1)).toEqual([
      expect.objectContaining({ authors: [second.pubkey] }),
    ]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("finds and resolves authors by name words, sending the relay the typed accents", async () => {
  const relay = keypair(),
    viewer = keypair(),
    zoe = keypair(),
    other = keypair();
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey]),
  ];
  const reads: Filter[][] = [];
  const searches: string[] = [];
  const people = [
    profile(zoe, { display_name: "Zoë" }),
    profile(other, { display_name: "Mary Zoë" }),
  ];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      const search = filters.find((filter) => filter.kinds?.includes(0))
        ?.search as string | undefined;
      if (search !== undefined) {
        searches.push(search);
        // Like the relay's `simple` text index: lowercase word prefixes,
        // with no accent folding.
        return Promise.resolve(
          people.filter((event) =>
            String(JSON.parse(event.content).display_name)
              .toLowerCase()
              .split(/[^\p{L}\p{N}]+/u)
              .some((word) => word.startsWith(search)),
          ),
        );
      }
      if (filters.some((filter) => filter.kinds?.includes(9))) {
        reads.push(filters as Filter[]);
        return Promise.resolve([]);
      }
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  const props = {
    session: owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openConversation: () => {},
  };
  try {
    const mounted = render(<SearchResults {...props} query="from:@Zoë" />);
    const group = within(screen.getByRole("group", { name: "People" }));
    // The exact name first, then a later word that matches.
    await waitFor(() =>
      expect(
        group.getAllByRole("option").map((option) => option.textContent),
      ).toEqual([
        expect.stringContaining("Zoë"),
        expect.stringContaining("Mary Zoë"),
      ]),
    );
    mounted.rerender(<SearchResults {...props} query="from:Zoë " />);
    await waitFor(() =>
      expect(reads.at(-1)).toEqual([
        expect.objectContaining({ authors: [zoe.pubkey] }),
      ]),
    );
    // Folding is local only; the relay sees what the user typed.
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.every((search) => search === "zoë")).toBe(true);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("prioritizes people, separates agents, shows profile avatars, and excludes archived identities", async () => {
  const relay = keypair(),
    viewer = keypair(),
    human = keypair(),
    agent = keypair(),
    archived = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([
          profile(agent, {
            display_name: "Agent",
            is_agent: true,
            picture: "https://example.com/agent.png",
          }),
          profile(archived, { display_name: "Archived", is_agent: true }),
          profile(human, {
            display_name: "Alice",
            picture: "https://example.com/human.png",
          }),
        ]);
      return Promise.resolve([]);
    },
  });
  const session = {
    ...owner.session,
    archives: {
      ...owner.session.archives,
      state: (key: string) =>
        key === archived.pubkey ? ("archived" as const) : ("active" as const),
    },
  } as typeof owner.session;
  try {
    render(
      <SearchResults
        session={session}
        query="from:@a"
        onQueryChange={vi.fn()}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    const people = within(screen.getByRole("group", { name: "People" }));
    const person = await people.findByRole("option", { name: /Alice/ });
    expect(person).toBeVisible();
    expect(
      person.querySelector('img[src="https://example.com/human.png"]'),
    ).not.toBeNull();
    const agents = within(screen.getByRole("group", { name: "Agents" }));
    const choice = await agents.findByRole("option", { name: /Agent/ });
    expect(choice).toBeVisible();
    expect(
      choice.querySelector('img[src="https://example.com/agent.png"]'),
    ).not.toBeNull();
    expect(agents.queryByRole("option", { name: /Archived/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Archived/ })).toBeNull();
    expect(
      [...document.querySelectorAll('[role="option"]')].indexOf(person),
    ).toBeLessThan(
      [...document.querySelectorAll('[role="option"]')].indexOf(choice),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("opens the identity picker for bare from: without an unfiltered message read", async () => {
  const relay = keypair(),
    viewer = keypair(),
    human = keypair();
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(9)))
        reads.push(filters as Filter[]);
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([profile(human, { display_name: "Alice" })]);
      return Promise.resolve([]);
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="from:"
        onQueryChange={vi.fn()}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    expect(screen.getByRole("group", { name: "People" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "Most relevant" })).toBeNull();
    expect(reads).toHaveLength(0);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([
  "from:baxen deploy",
  "from:@baxen ",
  "deploy from:baxen after:2024-01-15",
])(
  "resolves a completed ambiguous %s without losing surrounding query text",
  async (query) => {
    const relay = keypair(),
      viewer = keypair(),
      first = keypair(),
      second = keypair();
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query(filters) {
        if (filters.some((filter) => filter.kinds?.includes(0)))
          return Promise.resolve([
            profile(first, { display_name: "Baxen" }),
            profile(second, { display_name: "Baxen" }),
          ]);
        return Promise.resolve([]);
      },
    });
    const change = vi.fn();
    try {
      render(
        <SearchResults
          session={owner.session}
          query={query}
          onQueryChange={change}
          input={createRef()}
          pages={[]}
          openConversation={() => {}}
        />,
      );
      const people = within(
        await screen.findByRole("group", { name: "People" }),
      );
      expect(await people.findAllByRole("option")).toHaveLength(2);
      fireEvent.click(people.getAllByRole("option")[1] as HTMLElement);
      expect(change).toHaveBeenCalledWith(
        query.replace(/from:@?baxen/i, `from:${second.pubkey}`),
      );
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

// A full first page can hide an exact namesake past the cap.
const alexSession = (
  exact: ReturnType<typeof keypair>,
  page: readonly ReturnType<typeof profile>[],
) => {
  const relay = keypair(),
    viewer = keypair();
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([
          profile(exact, { display_name: "Alex" }),
          ...page,
        ]);
      if (filters.some((filter) => filter.kinds?.includes(9)))
        reads.push(filters as Filter[]);
      return Promise.resolve([]);
    },
  });
  return { owner, reads };
};
const alexandras = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    profile(keypair(), { display_name: `Alexandra ${index}` }),
  );

it.each([
  ["a full prefix page", () => alexandras(39), 12],
  ["exact namesakes", () => [profile(keypair(), { display_name: "Alex" })], 2],
])(
  "asks which author a completed from: name means with %s",
  async (_, page, shown) => {
    const exact = keypair();
    const { owner, reads } = alexSession(exact, page());
    const change = vi.fn();
    const props = {
      session: owner.session,
      onQueryChange: change,
      input: createRef<HTMLInputElement>(),
      pages: [],
      openConversation: () => {},
    };
    try {
      const mounted = render(<SearchResults {...props} query="from:Alex " />);
      const people = within(
        await screen.findByRole("group", { name: "People" }),
      );
      expect(await people.findAllByRole("option")).toHaveLength(shown);
      // The picker follows the resolver's completed lookup.
      expect(reads).toEqual([]);
      fireEvent.click(
        people.getByRole("option", {
          name: new RegExp(exact.pubkey.slice(0, 12)),
        }),
      );
      expect(change).toHaveBeenCalledWith(`from:${exact.pubkey} `);
      mounted.rerender(
        <SearchResults {...props} query={`from:${exact.pubkey} `} />,
      );
      await waitFor(() =>
        expect(reads.at(-1)).toEqual([
          expect.objectContaining({ authors: [exact.pubkey] }),
        ]),
      );
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("resolves one exact from: name in a partial prefix page", async () => {
  const exact = keypair();
  const { owner, reads } = alexSession(exact, alexandras(38));
  try {
    render(
      <SearchResults
        session={owner.session}
        query="from:Alex "
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    await waitFor(() =>
      expect(reads.at(-1)).toEqual([
        expect.objectContaining({ authors: [exact.pubkey] }),
      ]),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([
  ["resolves it", false],
  ["reports a profile namesake as ambiguous", true],
])("completing an agent's own name with Space %s", async (_, namesake) => {
  const relay = keypair(),
    viewer = keypair(),
    agent = keypair(),
    human = keypair();
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([
          profile(agent, { display_name: "Legacy Bee" }),
          ...(namesake ? [profile(human, { display_name: "Jose" })] : []),
        ]);
      if (filters.some((filter) => filter.kinds?.includes(9)))
        reads.push(filters as Filter[]);
      return Promise.resolve([]);
    },
  });
  const source = owner.session.agentChoices;
  const choices = {
    ...source.snapshot(),
    identities: [{ pubkey: agent.pubkey, name: "José", managed: true }],
    selectable: [{ pubkey: agent.pubkey, name: "José", managed: true }],
  };
  const session = {
    ...owner.session,
    agentChoices: {
      ...source,
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: () => {},
    },
  } as typeof owner.session;
  const props = {
    session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openConversation: () => {},
  };
  try {
    const mounted = render(<SearchResults {...props} query="from:jose" />);
    // The picker offers the agent by its own name.
    expect(
      await within(
        await screen.findByRole("group", { name: "Agents" }),
      ).findByRole("option"),
    ).toBeVisible();
    mounted.rerender(<SearchResults {...props} query="from:jose " />);
    if (!namesake) {
      await waitFor(() =>
        expect(reads.at(-1)).toEqual([
          expect.objectContaining({ authors: [agent.pubkey] }),
        ]),
      );
    } else {
      // Both keys are offered; neither is searched silently.
      await waitFor(() =>
        expect(
          within(screen.getByRole("group", { name: "People" })).getAllByRole(
            "option",
          ),
        ).toHaveLength(1),
      );
      expect(
        within(screen.getByRole("group", { name: "Agents" })).getAllByRole(
          "option",
        ),
      ).toHaveLength(1);
      expect(reads).toEqual([]);
    }
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("adds a late shared agent without another keystroke or prefix read", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair(),
    agent = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query() {
      return [];
    },
  });
  const reads = vi.fn(async () => []);
  const source = owner.session.agentChoices;
  const listeners = new Set<() => void>();
  let choices = source.snapshot();
  const session = {
    ...owner.session,
    read: reads,
    agentChoices: {
      ...source,
      snapshot: () => choices,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      retain: () => () => {},
      ensure: () => {},
    },
  } as typeof owner.session;
  try {
    render(
      <SearchResults
        session={session}
        query="from:late"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    expect(reads).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("group", { name: "Agents" })).toBeNull();
    act(() => {
      choices = {
        ...choices,
        identities: [
          { pubkey: agent.pubkey, name: "Late Agent", managed: false },
        ],
        selectable: [
          { pubkey: agent.pubkey, name: "Late Agent", managed: false },
        ],
      };
      for (const listener of listeners) listener();
    });
    expect(
      within(screen.getByRole("group", { name: "Agents" })).getByRole(
        "option",
        { name: /Late Agent/ },
      ),
    ).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    expect(reads).toHaveBeenCalledTimes(1);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([
  ["from:alice", "from:bob", ""],
  [
    "deploy in:crew after:2026-10-01 from:alice",
    "deploy in:crew after:2026-10-01 from:bob",
    "deploy in:crew after:2026-10-01 ",
  ],
])(
  "replaces author chip in %s without leaking or restoring its filter",
  async (initial, typed, remaining) => {
    const relay = keypair(),
      viewer = keypair(),
      alice = keypair(),
      bob = keypair();
    const reads: Filter[][] = [];
    const changes: string[] = [];
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query(filters) {
        if (filters.some((filter) => filter.kinds?.includes(0)))
          return Promise.resolve([
            profile(alice, { display_name: "Alice" }),
            profile(bob, { display_name: "Bob" }),
          ]);
        if (filters.some((filter) => filter.kinds?.includes(9)))
          reads.push(filters as Filter[]);
        return Promise.resolve(
          [
            metadata(relay, "crew", "crew"),
            roster(relay, "crew", [viewer.pubkey]),
          ].filter((event) =>
            filters.some((filter) => matchFilter(filter as Filter, event)),
          ),
        );
      },
    });
    function Search() {
      const [query, setQuery] = useState(initial);
      return (
        <SearchResults
          session={owner.session}
          query={query}
          onQueryChange={(next) => {
            changes.push(next);
            setQuery(next);
          }}
          input={createRef()}
          pages={[]}
          openConversation={() => {}}
        />
      );
    }
    try {
      render(<Search />);
      fireEvent.click(
        await within(screen.getByRole("group", { name: "People" })).findByRole(
          "option",
          { name: /Alice/ },
        ),
      );
      const input = screen.getByRole("combobox", { name: "Search Buzz" });
      expect(
        screen.getByRole("button", { name: "Remove author Alice" }),
      ).toBeVisible();
      fireEvent.change(input, {
        target: { value: typed },
      });
      fireEvent.click(
        await within(screen.getByRole("group", { name: "People" })).findByRole(
          "option",
          { name: /Bob/ },
        ),
      );
      expect(
        screen.queryByRole("button", { name: "Remove author Alice" }),
      ).toBeNull();
      expect(input).toHaveValue(remaining);
      expect((input as HTMLInputElement).value).not.toContain(alice.pubkey);
      await waitFor(() =>
        expect(reads.at(-1)?.[0]).toMatchObject({ authors: [bob.pubkey] }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Remove author Bob" }),
      );
      expect(input).toHaveValue(remaining);
      expect((input as HTMLInputElement).value).not.toContain(alice.pubkey);
      expect((input as HTMLInputElement).value).not.toContain(bob.pubkey);
      expect(changes.at(-1)).toBe(remaining);
      if (remaining) {
        await waitFor(() =>
          expect(reads.at(-1)?.[0]).not.toHaveProperty("authors"),
        );
      }
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("renders from:<author chip> without exposing the signed operand in the input", async () => {
  const relay = keypair(),
    viewer = keypair(),
    human = keypair();
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([profile(human, { display_name: "Wes" })]);
      if (filters.some((filter) => filter.kinds?.includes(9)))
        reads.push(filters as Filter[]);
      return Promise.resolve([]);
    },
  });
  function Search() {
    const [query, setQuery] = useState("from:@wes");
    return (
      <SearchResults
        session={owner.session}
        query={query}
        onQueryChange={setQuery}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />
    );
  }
  try {
    render(<Search />);
    fireEvent.click(
      await within(screen.getByRole("group", { name: "People" })).findByRole(
        "option",
        { name: /Wes/ },
      ),
    );
    const chip = screen.getByRole("button", { name: "Remove author Wes" });
    expect(chip).toHaveTextContent("from:@Wes");
    expect(chip).toHaveAttribute("title", npubEncode(human.pubkey));
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(chip.closest(".buzz-input-group")).toContainElement(input);
    await waitFor(() =>
      expect(reads.at(-1)?.[0]).toMatchObject({ authors: [human.pubkey] }),
    );
    fireEvent.change(input, { target: { value: "before:" } });
    fireEvent.click(
      within(screen.getByRole("group", { name: "Dates" })).getByRole("option", {
        name: /Yesterday/,
      }),
    );
    expect(chip).toBeVisible();
    expect((input as HTMLInputElement).value).toMatch(
      /^before:\d{4}-\d{2}-\d{2} ?$/,
    );
    expect((input as HTMLInputElement).value).not.toContain(human.pubkey);
    await waitFor(() =>
      expect(reads.at(-1)?.[0]).toMatchObject({ authors: [human.pubkey] }),
    );
    fireEvent.change(input, { target: { value: "deploy" } });
    expect(input).toHaveValue("deploy");
    expect(chip).toBeVisible();
    await waitFor(() =>
      expect(reads.at(-1)?.[0]).toMatchObject({
        authors: [human.pubkey],
        search: "deploy",
      }),
    );
    fireEvent.click(chip);
    expect(
      screen.queryByRole("button", { name: "Remove author Wes" }),
    ).toBeNull();
    expect(input).toHaveValue("deploy");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("keeps both exact authors selectable ahead of a crowded prefix page", async () => {
  const relay = keypair(),
    viewer = keypair(),
    first = keypair(),
    second = keypair();
  const prefixes = Array.from({ length: 12 }, () => keypair());
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(9)))
        reads.push(filters as Filter[]);
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([
          ...prefixes.map((person, index) =>
            profile(person, { display_name: `Samantha ${index}` }),
          ),
          profile(first, { display_name: "Sam" }),
          profile(second, { display_name: "Sam" }),
        ]);
      return Promise.resolve([]);
    },
  });
  const change = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="from:sam deploy"
        onQueryChange={change}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    const people = within(await screen.findByRole("group", { name: "People" }));
    await waitFor(() => expect(people.getAllByRole("option")).toHaveLength(12));
    for (const pubkey of [first.pubkey, second.pubkey]) {
      expect(
        people.getByRole("option", { name: new RegExp(pubkey.slice(0, 12)) }),
      ).toBeVisible();
    }
    expect(reads).toHaveLength(0);
    fireEvent.click(
      people.getByRole("option", {
        name: new RegExp(second.pubkey.slice(0, 12)),
      }),
    );
    expect(change).toHaveBeenCalledExactlyOnceWith(
      `from:${second.pubkey} deploy`,
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("keeps a person visible when agent candidates exceed the picker cap", async () => {
  const relay = keypair(),
    viewer = keypair(),
    human = keypair();
  const agents = Array.from({ length: 12 }, () => keypair());
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([
          ...agents.map((agent) =>
            profile(agent, { display_name: "Agent", is_agent: true }),
          ),
          profile(human, { display_name: "Alice" }),
        ]);
      return Promise.resolve([]);
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="from:a"
        onQueryChange={vi.fn()}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    expect(
      await within(screen.getByRole("group", { name: "People" })).findByRole(
        "option",
        { name: /Alice/ },
      ),
    ).toBeVisible();
    expect(screen.getAllByRole("option")).toHaveLength(12);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("retains a member of the in: channel when global author lookup fails", async () => {
  const relay = keypair(),
    viewer = keypair(),
    wes = keypair();
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey, wes.pubkey]),
  ];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.search === "we"))
        return Promise.reject(new Error("prefix lookup unavailable"));
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([profile(wes, { display_name: "Wes" })]);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="in:#crew from:we"
        onQueryChange={vi.fn()}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    expect(
      await within(screen.getByRole("group", { name: "People" })).findByRole(
        "option",
        { name: /Wes/ },
      ),
    ).toBeVisible();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("shows only the requested date suggestions and inserts local calendar dates", async () => {
  const relay = keypair(),
    viewer = keypair();
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  const change = vi.fn();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 5, 12));
  try {
    render(
      <SearchResults
        session={owner.session}
        query="after:"
        onQueryChange={change}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    const dates = within(screen.getByRole("group", { name: "Dates" }));
    expect(
      dates.getAllByRole("option").map((option) => option.textContent),
    ).toEqual([
      "Today2026-10-05",
      "Yesterday2026-10-04",
      "This week2026-10-05",
      "Last week2026-09-28",
      "This month2026-10-01",
    ]);
    fireEvent.click(dates.getByRole("option", { name: /Last week/ }));
    expect(change).toHaveBeenCalledWith("after:2026-09-28 ");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("never widens a search when a name or channel operator is unresolved", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      if (filters.some((filter) => filter.search !== undefined))
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        [
          metadata(relay, "crew", "crew"),
          roster(relay, "crew", [viewer.pubkey]),
        ].filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  try {
    const { rerender } = render(
      <SearchResults
        session={owner.session}
        query="deploy from:@missing"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        scopedChannelId="crew"
        openConversation={() => {}}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(180));
    const users = wire.next();
    expect(users.filters[0]?.kinds).toEqual([0]);
    await act(async () => users.respond([]));
    expect(
      wire.pending.filter((request) =>
        request.filters.some((filter) => filter.kinds?.includes(9)),
      ),
    ).toHaveLength(0);
    for (const request of wire.pending.splice(0)) request.respond([]);
    rerender(
      <SearchResults
        session={owner.session}
        query="deploy in:#missing"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(
      wire.pending.filter((request) =>
        request.filters.some((filter) => filter.kinds?.includes(9)),
      ),
    ).toHaveLength(0);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(["private", "missing"])(
  "revalidates a retained public preview before an in: search when metadata becomes %s",
  async (change) => {
    const relay = keypair(),
      viewer = keypair();
    const id = "12345678-1234-1234-1234-123456789abc";
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const publicMeta = metadata(relay, id, "Public", 1700000000, [
      ["public", ""],
    ]);
    const privateMeta = metadata(relay, id, "Private", 1700000001, [
      ["private", ""],
    ]);
    let current = publicMeta;
    let revoked = false;
    const scopedReads: Filter[][] = [];
    let exactReads = 0;
    const owner = createRelaySession({
      ...wire.transport,
      async query(filters) {
        if (filters.some((filter) => filter.search !== undefined)) {
          scopedReads.push(filters as Filter[]);
          return [message(viewer, id, "stale secret hit", 1700000002)];
        }
        if (filters.some((filter) => filter["#d"]?.includes(id))) {
          exactReads++;
          return revoked
            ? change === "missing"
              ? []
              : [current]
            : [publicMeta];
        }
        return [publicMeta].filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        );
      },
    });
    try {
      const props = {
        session: owner.session,
        onQueryChange: () => {},
        input: createRef<HTMLInputElement>(),
        pages: [],
        openConversation: () => {},
      };
      const mounted = render(<SearchResults {...props} query="Public" />);
      await screen.findByRole("option", {
        name: /Public channel · not joined/,
      });
      expect(owner.session.channels.get?.(id)?.readOnly).toBe(true);
      const beforeRevalidation = exactReads;
      scopedReads.length = 0;
      vi.useFakeTimers();
      current = privateMeta;
      revoked = true;
      mounted.rerender(<SearchResults {...props} query={`secret in:${id}`} />);
      await act(async () => vi.advanceTimersByTimeAsync(180));
      expect(exactReads).toBeGreaterThan(beforeRevalidation);
      expect(scopedReads).toHaveLength(0);
      expect(owner.session.channels.get?.(id)).toBeUndefined();
      expect(
        screen.queryByRole("option", { name: /stale secret hit/ }),
      ).toBeNull();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("resolves an exact public name beyond eight preceding substring matches and reports page coverage", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const names = [
    "a-dev",
    "b-dev",
    "c-dev",
    "d-dev",
    "android-dev",
    "backend-dev",
    "core-dev",
    "data-dev",
    "dev",
  ];
  const discovery = names.map((name) =>
    metadata(relay, name, name, 1700000000, [
      ["public", ""],
      ["t", "stream"],
    ]),
  );
  // A full first page means an exact-name miss outside it cannot be declared exhaustive.
  for (let i = 0; i < 491; i++)
    discovery.push(
      metadata(relay, `extra-${i}`, `extra-${i}`, 1700000000, [
        ["public", ""],
        ["t", "stream"],
      ]),
    );
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      if (filters.some((filter) => filter.search !== undefined)) {
        reads.push(filters as Filter[]);
        return [message(viewer, "dev", "deploy found", 1700000001)];
      }
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="deploy in:#dev"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /deploy found/ }),
    ).toBeVisible();
    expect(reads).toContainEqual([
      expect.objectContaining({ "#h": ["dev"], search: "deploy" }),
    ]);
    expect(
      screen.getByText(
        "Public channel results include only the first page of channels.",
      ),
    ).toBeVisible();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("keeps a pending in: lookup pending, then retries its failure and resumes scoped search", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "dev", "dev", 1700000000, [["public", ""]]),
  ];
  let failLookup!: (error: Error) => void;
  let lookupStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    lookupStarted = resolve;
  });
  const pending = new Promise<typeof discovery>((_resolve, reject) => {
    failLookup = reject;
  });
  let failures = 1;
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      if (filters.some((filter) => filter.search !== undefined)) {
        reads.push(filters as Filter[]);
        return Promise.resolve([
          message(viewer, "dev", "deploy found", 1700000001),
        ]);
      }
      if (
        filters.some(
          (filter) => filter.kinds?.includes(39000) && !filter["#d"],
        ) &&
        failures-- > 0
      ) {
        lookupStarted();
        return pending;
      }
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="deploy in:#dev"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    await started;
    expect(screen.getByText("Searching messages…")).toBeVisible();
    expect(
      screen.queryByText("No matching messages in accessible conversations."),
    ).toBeNull();
    await act(async () => failLookup(new Error("network down")));
    expect(
      await screen.findByText(
        /Public channel search couldn’t finish: network down/,
      ),
    ).toBeVisible();
    expect(screen.getByText("Message search is unavailable.")).toBeVisible();
    expect(reads).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry channels" }));
    expect(
      await screen.findByRole("option", { name: /deploy found/ }),
    ).toBeVisible();
    expect(reads).toContainEqual([expect.objectContaining({ "#h": ["dev"] })]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("matches an in: operator against the rendered DM participant label", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "dm", "opaque", 1700000000, [
      ["t", "dm"],
      ["private", ""],
    ]),
    roster(relay, "dm", [viewer.pubkey, alice.pubkey]),
    profile(alice, { name: "Alice" }),
  ];
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      if (filters.some((filter) => filter.search !== undefined)) {
        reads.push(filters as Filter[]);
        return [message(alice, "dm", "deploy to Alice", 1700000001)];
      }
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="deploy in:alice"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /deploy to Alice/ }),
    ).toBeVisible();
    expect(reads).toContainEqual([expect.objectContaining({ "#h": ["dm"] })]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("treats bare in:# as no channel operator", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      if (filters.some((filter) => filter.search !== undefined)) {
        reads.push(filters as Filter[]);
        return [message(viewer, "crew", "hello world", 1700000001)];
      }
      return [
        metadata(relay, "crew", "crew"),
        roster(relay, "crew", [viewer.pubkey]),
      ].filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="hello in:#"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /hello world/ }),
    ).toBeVisible();
    expect(reads).toContainEqual([
      expect.not.objectContaining({ "#h": expect.anything() }),
    ]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([true, false])(
  "only shows relay-attested workflow ownership in ranked search (relay signer: %s), keeping from: signer-based",
  async (relaySigned) => {
    vi.useFakeTimers();
    const relay = keypair(),
      viewer = keypair(),
      workflowOwner = keypair();
    const signer = relaySigned ? relay : keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const owner = createRelaySession({
      ...wire.transport,
      archiveAuthority: relay.pubkey,
      query(filters, signal) {
        if (filters.some((filter) => filter.search !== undefined))
          return wire.transport.query(filters, signal);
        return Promise.resolve(
          [
            metadata(relay, "crew", "crew"),
            roster(relay, "crew", [viewer.pubkey]),
            profile(workflowOwner, { display_name: "Workflow owner" }),
            profile(signer, { display_name: "Actual signer" }),
          ].filter((event) =>
            filters.some((filter) => filter.kinds?.includes(event.kind)),
          ),
        );
      },
    });
    const open = vi.fn();
    try {
      render(
        <SearchResults
          session={owner.session}
          query={`deploy in:#crew from:${signer.pubkey} `}
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openConversation={open}
        />,
      );
      await act(async () => vi.advanceTimersByTimeAsync(180));
      const request = wire.next();
      expect(request.filters[0]?.authors).toEqual([signer.pubkey]);
      const hit = eventDto(
        message(signer, "crew", "deploy automated", 1700000001, [
          ["buzz:workflow", "true"],
          ["buzz:workflow-owner", workflowOwner.pubkey],
        ]),
      );
      await act(async () => request.respond([hit]));
      const option = screen.getByRole("option", { name: /deploy automated/ });
      if (relaySigned) {
        expect(option).toHaveTextContent("Workflow · owned by Workflow owner");
      } else {
        expect(option).toHaveTextContent("Actual signer");
        expect(option).not.toHaveTextContent("Workflow");
      }
      fireEvent.click(option);
      expect(open).toHaveBeenCalledExactlyOnceWith("crew", hit.id);
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);
