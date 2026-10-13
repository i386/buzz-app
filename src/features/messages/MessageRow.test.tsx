// @vitest-environment jsdom
import { npubEncode } from "nostr-tools/nip19";
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
stubAvatarBrowserApis();
import { expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render as renderDom,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { messageCopyText } from "./message-copy";
import { profileTarget, profileActivityViewTarget } from "../profiles/target";
import { activityTarget } from "../agents/activity-target";
import { renderToStaticMarkup } from "react-dom/server";
import { foldMessages } from "../relay/fold";
import { keypair, message, signed, summary } from "../relay/testing";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { ConversationPresentation } from "../conversation/ConversationPresentation";
import { MessageRow } from "./MessageRow";
import { MessageManagement } from "./MessageManagement";
import type { ChannelMessage } from "../relay/contracts";
import type { UnreadCapability, UnreadSnapshot } from "../relay/unread";
import type { RelaySession } from "../relay/session";
import type { TypingEntry } from "../relay/typing";
import { LinkLabel } from "../../bundled/links/InlineLink";

const row: ChannelMessage = {
  id: "root",
  channelId: "channel",
  authorId: "author",
  content: "Root",
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 23,
};

it.each([false, true])(
  "carries agent-envelope appearance into avatar navigation: %s",
  (agentEnvelope) => {
    const authorId = "ab".repeat(32);
    const open = vi.fn(() => true);
    try {
      renderDom(
        <MessageRow
          row={{
            ...row,
            authorId,
            ...(agentEnvelope ? { agentEnvelope: true as const } : {}),
          }}
          profile={undefined}
          media={() => undefined}
          onOpenLink={open}
          canOpenLink={() => true}
          day={false}
          retry={undefined}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: `View ${authorId.slice(0, 10)} profile`,
        }),
      );
      expect(open).toHaveBeenCalledWith(
        profileTarget(authorId, { agent: agentEnvelope }),
        { rootId: "root" },
      );
    } finally {
      cleanup();
    }
  },
);

it("tells link handlers the thread a reply was opened from", () => {
  const open = vi.fn(() => true);
  const authorId = "ab".repeat(32);
  try {
    renderDom(
      <MessageRow
        row={{
          ...row,
          authorId,
          id: "reply",
          threadRootId: "thread",
          replyCount: 0,
        }}
        profile={undefined}
        media={() => undefined}
        onOpenLink={open}
        canOpenLink={() => true}
        day={false}
        retry={undefined}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: `View ${authorId.slice(0, 10)} profile`,
      }),
    );
    expect(open).toHaveBeenCalledWith(profileTarget(authorId), {
      rootId: "thread",
    });
  } finally {
    cleanup();
  }
});

it("keeps plain agent presence without avatar activity, and omits human presence from messages", () => {
  const agentRow = { ...row, authorId: "a".repeat(64) };
  const subscribe = vi.fn(() => () => {});
  const status = vi.fn<() => "online" | "unknown">(() => "online");
  const channels = { channels: [], status: "ready" };
  let working = false;
  const activityListeners = new Set<() => void>();
  const session = {
    agentActivity: {
      snapshot: () => ({
        turns: working
          ? [
              {
                agent: agentRow.authorId,
                channelId: row.channelId,
                state: "working",
              },
            ]
          : [],
        typing: [],
      }),
      subscribe: (listener: () => void) => {
        activityListeners.add(listener);
        return () => {
          activityListeners.delete(listener);
        };
      },
    },
    presence: { subscribe, status, limited: () => false },
    messages: { report: undefined },
    channels: {
      subscribeList: () => () => {},
      list: () => channels,
    },
  } as unknown as RelaySession;
  const show = (agent: boolean) =>
    renderToStaticMarkup(
      <MessageRow
        row={agentRow}
        agentPubkeys={agent ? new Set([agentRow.authorId]) : undefined}
        session={session}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
  const agent = show(true);
  expect(agent).not.toContain("agent-motion-avatar");
  expect(agent).toContain('data-status="online"');
  expect(agent).toContain('data-avatar-shape="squircle"');
  expect(agent).toContain('aria-label="Agent, online"');
  const human = show(false);
  expect(human).not.toContain('data-status="online"');
  expect(human).not.toContain("data-compact");
  expect(status).toHaveBeenCalledTimes(1);
  const props = {
    row: agentRow,
    session,
    profile: undefined,
    media: () => undefined,
    onOpenLink: () => false,
    day: false,
    retry: undefined,
  };
  const mounted = renderDom(
    <MessageRow {...props} agentPubkeys={new Set([agentRow.authorId])} />,
  );
  expect(subscribe).toHaveBeenCalledWith(
    agentRow.authorId,
    expect.any(Function),
    false,
  );
  mounted.rerender(
    <MessageRow
      {...props}
      agentPubkeys={new Set([agentRow.authorId])}
      canOpenLink={() => true}
    />,
  );
  expect(
    screen.getByRole("button", { name: "View aaaaaaaaaa profile" }),
  ).toHaveAccessibleDescription(/^Presence: online\s*$/);
  act(() => {
    working = true;
    for (const listener of activityListeners) listener();
  });
  expect(
    screen.getByRole("button", { name: "View aaaaaaaaaa profile" }),
  ).toHaveAccessibleDescription("Presence: online");
  expect(document.querySelector(".agent-motion-avatar")).toBeNull();
  expect(document.querySelector('[data-status="online"]')).toBeInTheDocument();
  expect(activityListeners.size).toBe(0);
  act(() => {
    working = false;
    for (const listener of activityListeners) listener();
  });
  expect(
    screen.getByRole("button", { name: "View aaaaaaaaaa profile" }),
  ).toHaveAccessibleDescription(/^Presence: online\s*$/);
  mounted.unmount();
  status.mockReturnValue("unknown");
  const unknown = renderDom(<MessageRow {...props} canOpenLink={() => true} />);
  expect(
    screen.getByRole("button", { name: "View aaaaaaaaaa profile" }),
  ).not.toHaveAccessibleDescription();
  unknown.unmount();
  subscribe.mockClear();
  renderDom(<MessageRow {...props} />);
  expect(subscribe).not.toHaveBeenCalled();
  cleanup();
});
it.each(["bare", "angle", "markdown", "escaped"] as const)(
  "renders link contributions inside message prose, preserving punctuation and plain-link fallback (%s)",
  (format) => {
    const url = "https://github.com/block/buzz/issues/1234";
    const label =
      format === "markdown" || format === "escaped" ? "Repository" : url;
    const content = {
      bare: url,
      angle: `<${url}>`,
      markdown: `[Repository](${url})`,
      escaped: `[Repository]\\([${url}](${url}))`,
    }[format];
    const entry = {
      id: "link",
      title: "Link",
      key: "buzz.links/link",
      pluginId: "buzz.links",
      revision: "one",
      matches: () => true,
      component: ({ url }: { url: string }) => <LinkLabel href={url} />,
    };
    const render = (enabled: boolean) =>
      renderToStaticMarkup(
        <MessageRow
          row={{
            ...row,
            content: `Before ${content}. After`,
            replyCount: 0,
          }}
          profile={undefined}
          media={() => undefined}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
          extensions={{
            tools: { snapshot: () => [], subscribe: () => () => {} },
            inline: { snapshot: () => [], subscribe: () => () => {} },
            links: {
              snapshot: () => (enabled ? [entry] : []),
              subscribe: () => () => {},
            },
          }}
        />,
      );
    const enabled = render(true);
    expect(enabled).toContain(`href="${url}"`);
    expect(enabled).toContain('data-link-kind="github"');
    expect(enabled.replace(/<[^>]+>/g, "")).toContain(`Before ${label}. After`);
    expect(enabled).not.toContain("&lt;");
    expect(enabled).not.toContain("&gt;");
    expect(render(false)).not.toContain("data-link-kind");
    expect(render(false)).toContain(`>${label}</a>`);
  },
);

it.each([
  ["😀 🙏 👏", [], true],
  ["😀".repeat(40), [], true],
  [
    ":party: ".repeat(24),
    [{ shortcode: "party", url: "https://emoji.test/party.png" }],
    true,
  ],
  ["😀 🙏 👏 😄 hello", [], false],
  [":unknown: 😀", [], false],
  ["  \n  ", [], false],
] as const)(
  "keeps emoji-only message size independent of count: %s",
  (content, emoji, large) => {
    const html = renderToStaticMarkup(
      <MessageRow
        row={{ ...row, content, emoji }}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    expect(html.includes('data-single-emoji="true"')).toBe(large);
  },
);
function render(
  patch: Partial<UnreadSnapshot>,
  replies = 23,
  clickable = true,
  threadRootId?: string,
) {
  const snapshot = vi.fn(() => ({
    observedCount: null,
    manual: "none",
    ...patch,
  }));
  const unread = { snapshot } as unknown as UnreadCapability;
  const html = renderToStaticMarkup(
    <MessageRow
      row={{ ...row, replyCount: replies, threadRootId }}
      unread={unread}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
      onOpenThread={clickable ? () => {} : undefined}
    />,
  );
  return { html, snapshot };
}
it("renders the signed whole-thread total rather than only direct replies", () => {
  const author = keypair(),
    relay = keypair();
  const root = message(author, "channel", "Root", 1);
  const [folded] = foldMessages("channel", relay.pubkey, [
    root,
    summary(relay, "channel", root.id, {
      reply_count: 1,
      descendant_count: 3,
      participants: [author.pubkey],
    }),
  ]);
  if (!folded) throw new Error("Missing root");
  const html = renderToStaticMarkup(
    <MessageRow
      row={folded}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
      onOpenThread={() => {}}
    />,
  );
  expect(html).toContain('aria-label="View thread: 3 replies"');
  expect(html).toContain("3 replies</span>");
});
it("selects this thread, adds an accessible unread cue and preserves the total reply count", () => {
  const { html, snapshot } = render({ observedCount: 2 });
  expect(snapshot).toHaveBeenCalledExactlyOnceWith({
    kind: "thread",
    channelId: "channel",
    rootId: "root",
  });
  expect(html).toContain(
    'aria-label="View thread: 23 replies. Observed unread replies. Not an exact total."',
  );
  expect(html).toContain(
    'aria-hidden="true" title="Observed unread replies. Not an exact total."',
  );
  expect(html).toContain("23 replies</span>");
});
it.each([null, 0])(
  "omits the dot for %s observed replies, not a fabricated unread total",
  (observedCount) => {
    const { html } = render({ observedCount });
    expect(html).toContain('aria-label="View thread: 23 replies"');
    expect(html).not.toContain("title=");
  },
);
it("describes local manual intent and stale evidence honestly", () => {
  expect(render({ manual: "local-only", observedCount: 0 }).html).toContain(
    "Thread marked unread on this device only",
  );
  expect(render({ manual: "remote", observedCount: 0 }).html).toContain(
    "Thread marked unread",
  );
  expect(render({ observedCount: 1, freshness: "stale" }).html).toContain(
    "Observed unread replies; may be out of date",
  );
});
it("does not select unread for rows without a thread button", () => {
  expect(render({}, 0).snapshot).not.toHaveBeenCalled();
  expect(render({}, 23, false).snapshot).not.toHaveBeenCalled();
});

it("selects the opening root for a broadcast reply instead of its own row ID", () => {
  const { snapshot } = render({ observedCount: 1 }, 23, true, "original-root");
  expect(snapshot).toHaveBeenCalledExactlyOnceWith({
    kind: "thread",
    channelId: "channel",
    rootId: "original-root",
  });
});

it("renders exact identity controls only while a target can be opened", () => {
  const author = "a".repeat(64),
    recipient = "b".repeat(64);
  const renderProfile = (enabled: boolean) =>
    renderToStaticMarkup(
      <MessageRow
        row={{
          ...row,
          authorId: author,
          content: "Hello @Mic",
          mentions: [recipient],
        }}
        profile={{ name: "Author" }}
        participantProfiles={new Map([[recipient, { name: "Mic" }]])}
        media={() => undefined}
        onOpenLink={() => true}
        canOpenLink={() => enabled}
        day={false}
        retry={undefined}
      />,
    );
  const enabled = renderProfile(true);
  expect(enabled).toContain('aria-label="View Author profile"');
  expect(enabled).toContain('aria-label="View Mic profile"');
  expect(renderProfile(false)).not.toContain('aria-label="View Mic profile"');
  expect(renderProfile(false)).not.toContain(
    'aria-label="View Author profile"',
  );
  expect(renderProfile(false)).toContain("@Mic");
});

it.each(["~~~js\nconst delimiter = '~~~';\n@Mic\n~~~\nOutside @Mic"])(
  "only exposes the prose mention through MessageRow: %s",
  (content) => {
    const recipient = "b".repeat(64);
    const html = renderToStaticMarkup(
      <MessageRow
        row={{ ...row, content, mentions: [recipient] }}
        profile={undefined}
        participantProfiles={new Map([[recipient, { name: "Mic" }]])}
        media={() => undefined}
        onOpenLink={() => true}
        canOpenLink={() => true}
        day={false}
        retry={undefined}
      />,
    );
    expect(html.match(/aria-label="View Mic profile"/g)).toHaveLength(1);
    expect(html.indexOf('aria-label="View Mic profile"')).toBeGreaterThan(
      html.indexOf("Outside "),
    );
  },
);

it.each([9, 40002])(
  "does not manufacture profile bindings when kind %s images are removed",
  (kind) => {
    const author = keypair(),
      recipient = keypair(),
      relay = keypair();
    for (const content of [
      "@M![x][image]ic\n\n[image]: https://example.test/a.png",
      "@M![x](https://example.test/a.png)ic",
      "@M![x](http://example.test/a.png)ic",
      "@![x](https://example.test/a.png)Mic",
      "Hello @M![x](https://example.test/a.png)ic ![y](https://example.test/b.png)",
    ]) {
      const event = signed(author, {
        kind,
        content: kind === 40002 ? JSON.stringify({ content }) : content,
        tags: [
          ["h", "channel"],
          ["p", recipient.pubkey],
        ],
      });
      const [folded] = foldMessages("channel", relay.pubkey, [event]);
      if (!folded) throw new Error("missing message");
      expect(folded.content).toContain("@Mic");
      expect(folded.attachmentSeams?.length).toBeGreaterThan(0);
      expect(folded.mentions).toEqual([recipient.pubkey]);
      const html = renderToStaticMarkup(
        <MessageRow
          row={folded}
          profile={undefined}
          participantProfiles={new Map([[recipient.pubkey, { name: "Mic" }]])}
          media={() => undefined}
          onOpenLink={() => true}
          canOpenLink={() => true}
          day={false}
          retry={undefined}
        />,
      );
      expect(html).not.toContain('aria-label="View Mic profile"');
      expect(html).toContain("@Mic");
    }
    const [unchanged] = foldMessages("channel", relay.pubkey, [
      message(author, "channel", "@Mic  \n", 1),
    ]);
    expect(unchanged?.attachmentSeams).toBeUndefined();
  },
);

it("binds signed names beside removed attachments that cannot join them", () => {
  const author = keypair(),
    person = keypair(),
    agent = keypair(),
    namesake = keypair(),
    relay = keypair();
  const media = "https://relay.test/media/shot.png";
  const profiles = new Map([
    [person.pubkey, { name: "kalvin" }],
    [agent.pubkey, { name: "am", isAgent: true as const }],
    [namesake.pubkey, { name: "kalvin chau" }],
  ]);
  const render = (
    content: string,
    mentions: string[],
    tags: string[][] = [],
  ) => {
    const [folded] = foldMessages("channel", relay.pubkey, [
      message(author, "channel", content, 1, [
        ...mentions.map((pubkey) => ["p", pubkey]),
        ...tags,
      ]),
    ]);
    if (!folded) throw new Error("missing message");
    return renderToStaticMarkup(
      <MessageRow
        row={folded}
        profile={undefined}
        participantProfiles={profiles}
        media={() => undefined}
        onOpenLink={() => true}
        canOpenLink={() => true}
        day={false}
        retry={undefined}
      />,
    );
  };
  const chip = (kind: string, name: string) =>
    new RegExp(
      `data-mention-kind="${kind}"[^>]*aria-label="View ${name} profile"`,
    );
  expect(
    render(
      "@kalvin <https://github.com/block/buzz/pull/7904> :pray-for-stamp:\n![image](https://static.example/stamp.gif)",
      [person.pubkey],
    ),
  ).toMatch(chip("person", "kalvin"));
  expect(
    render(
      `@am i like the \`:ls\` feature\n\n![image.png](<${media}>)`,
      [agent.pubkey],
      [["imeta", `url ${media}`, "m image/png"]],
    ),
  ).toMatch(chip("agent", "am"));
  // Removal may end a name, but a longer name must not cross the seam.
  const joined = render("@kalvin![x](https://example.test/a.png) chau", [
    person.pubkey,
    namesake.pubkey,
  ]);
  expect(joined).toMatch(chip("person", "kalvin"));
  expect(joined).not.toContain("View kalvin chau profile");
});

it.each([9, 40002])(
  "preserves signed kind %s code indentation through fold and render",
  (kind) => {
    const author = keypair(),
      recipient = keypair(),
      relay = keypair();
    for (const content of ["    @Mic", "\t@Mic"]) {
      const event = signed(author, {
        kind,
        content: kind === 40002 ? JSON.stringify({ content }) : content,
        tags: [
          ["h", "channel"],
          ["p", recipient.pubkey],
        ],
      });
      const [folded] = foldMessages("channel", relay.pubkey, [event]);
      if (!folded) throw new Error("missing message");
      const html = renderToStaticMarkup(
        <MessageRow
          row={folded}
          profile={undefined}
          participantProfiles={new Map([[recipient.pubkey, { name: "Mic" }]])}
          media={() => undefined}
          onOpenLink={() => true}
          canOpenLink={() => true}
          day={false}
          retry={undefined}
        />,
      );
      expect(html).not.toContain('aria-label="View Mic profile"');
      expect(folded.content).toBe(content);
    }
  },
);

it.each([{ width: 1600, height: 900 }])(
  "uses fixed thumbnails regardless of image dimensions: %j",
  (dimensions) => {
    const html = renderToStaticMarkup(
      <MessageRow
        row={{
          ...row,
          attachments: [
            { url: "https://image.test/shot.png", kind: "image", dimensions },
          ],
        }}
        profile={undefined}
        media={(url) => url}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    expect(html).toContain('data-thumbnail="true"');
    expect(html).not.toContain("aspect-ratio:");
    expect(html).toContain('aria-label="Open image attachment"');
    expect(html).toContain('loading="lazy"');
  },
);

it.each([undefined, { width: 640, height: 400 }])(
  "keeps cached images silent and unfetched, but explains a live unavailable source (%j)",
  (dimensions) => {
    const media = vi.fn(() => undefined);
    const imageRow: ChannelMessage = {
      ...row,
      attachments: [
        {
          url: "https://image.test/unavailable.png",
          kind: "image",
          ...(dimensions ? { dimensions } : {}),
        },
      ],
    };
    const show = (cached: boolean) => {
      const list = {
        status: "ready",
        channels: [{ id: row.channelId, cached }],
      };
      const session = {
        messages: {},
        channels: { list: () => list, subscribeList: () => () => {} },
      } as unknown as RelaySession;
      return (
        <MessageRow
          row={imageRow}
          session={session}
          profile={undefined}
          media={media}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
        />
      );
    };
    const view = renderDom(show(true));
    try {
      const placeholder = view.container.querySelector(
        '[class*="attachmentImage"][aria-hidden="true"]',
      );
      expect(placeholder).not.toBeNull();
      expect(placeholder).toBeEmptyDOMElement();
      expect(placeholder).toHaveAttribute("data-thumbnail", "true");
      expect(placeholder).not.toHaveAttribute("style"); // Strip CSS owns fixed geometry.
      expect(view.container.querySelector("img, canvas, a[href]")).toBeNull();
      expect(screen.queryByText("Image unavailable")).not.toBeInTheDocument();
      view.rerender(show(false));
      expect(screen.getByRole("status")).toHaveTextContent("Image unavailable");
      expect(
        view.container.querySelector('[class*="attachmentImage"]'),
      ).toBeNull();
      expect(view.container.querySelector("img, canvas, a[href]")).toBeNull();
      expect(media).toHaveBeenCalledWith("https://image.test/unavailable.png");
    } finally {
      view.unmount();
    }
  },
);

it("does not bypass the session media resolver to paint an inaccessible attachment", () => {
  const media = vi.fn(() => undefined);
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          {
            url: "https://image.test/original.png",
            kind: "image",
            blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
          },
        ],
      }}
      profile={undefined}
      media={media}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(media).toHaveBeenCalledWith("https://image.test/original.png");
  expect(html).toContain("Image unavailable");
  expect(html).not.toContain("<canvas");
  expect(html).not.toContain("<img");
});

it("uses the agent squircle for both known agents and agent profiles", () => {
  const agent = "a".repeat(64);
  const media = vi.fn((url: string) => url);
  const html = renderToStaticMarkup(
    <MessageRow
      row={{ ...row, authorId: agent }}
      profile={{ name: "Carl", picture: "https://image.test/agent.png" }}
      agentPubkeys={new Set([agent])}
      media={media}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain('data-avatar-shape="squircle"');
  expect(media).toHaveBeenCalledWith("https://image.test/agent.png", "small");
  const profileOnly = renderToStaticMarkup(
    <MessageRow
      row={{ ...row, authorId: agent }}
      profile={{
        name: "Carl",
        picture: "https://image.test/agent.png",
        isAgent: true,
      }}
      media={media}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(profileOnly).toContain('data-avatar-shape="squircle"');
  expect(render({}, 0).html).toContain('data-avatar-shape="circle"');
});

it.each([9, 40002])(
  "renders kind %s author shape from the existing fold without profile/library evidence",
  (kind) => {
    const author = keypair(),
      relay = keypair();
    const [folded] = foldMessages("channel", relay.pubkey, [
      signed(author, {
        kind,
        content:
          kind === 40002 ? JSON.stringify({ content: "Reply" }) : "Reply",
        tags: [["h", "channel"]],
      }),
    ]);
    if (!folded) throw new Error("Missing row");
    const html = renderToStaticMarkup(
      <MessageRow
        row={folded}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    expect(html).toContain(
      `data-avatar-shape="${kind === 40002 ? "squircle" : "circle"}"`,
    );
  },
);

it("requests a small profile image without downsizing message attachments", () => {
  const media = vi.fn((url: string) => url);
  renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          { url: "https://image.test/attachment.png", kind: "image" },
        ],
      }}
      profile={{ name: "Author", picture: "https://image.test/avatar.png" }}
      media={media}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );

  expect(media).toHaveBeenCalledWith("https://image.test/avatar.png", "small");
  expect(media).toHaveBeenCalledWith("https://image.test/attachment.png");
});

it("renders generic file attachments as download cards", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          {
            url: "https://files.test/report.pdf",
            kind: "file",
            name: "report.pdf",
            size: 1536,
            mime: "application/pdf",
          },
        ],
      }}
      profile={undefined}
      media={(url) => `/api/relay/media?url=${encodeURIComponent(url)}`}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain(
    'href="/api/relay/media?url=https%3A%2F%2Ffiles.test%2Freport.pdf"',
  );
  expect(html).toContain('download="report.pdf"');
  expect(html).toContain('aria-label="Download report.pdf"');
  expect(html).toContain("report.pdf");
  expect(html).toContain("2 KB");
  expect(html).not.toContain("Open image attachment");
  expect(html).not.toContain("<img");
});

it("renders unavailable generic files without a download link", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          {
            url: "https://files.test/missing.pdf",
            kind: "file",
            mime: "application/pdf",
          },
        ],
      }}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain("PDF file");
  expect(html).toContain("File unavailable");
  expect(html).toContain('role="status"');
  const container = document.createElement("div");
  container.innerHTML = html;
  expect(container.querySelector("a")).toBeNull();
  expect(html).not.toContain("Open image attachment");
});

it("renders proxy audio attachments with an inline player", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          {
            url: "https://files.test/audio.mp3",
            kind: "audio",
            duration: 12,
          },
        ],
      }}
      profile={undefined}
      media={(url) => `/api/relay/media?url=${encodeURIComponent(url)}`}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain('aria-label="Play audio"');
  expect(html).toContain('aria-label="Seek audio"');
  const container = document.createElement("div");
  container.innerHTML = html;
  expect(container.querySelector("fieldset")?.textContent).toBe("00:00 00:12");
  expect(html).not.toContain("Download file");
});

it("renders external audio sources as open file cards", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          {
            url: "https://files.test/audio.mp3",
            kind: "audio",
            name: "audio.mp3",
          },
        ],
      }}
      profile={undefined}
      media={(url) => url}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain('aria-label="Open audio.mp3"');
  expect(html).toContain("Open file");
  expect(html).not.toContain('aria-label="Play audio"');
});

it("renders missing audio sources as unavailable file cards", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          {
            url: "https://files.test/audio.mp3",
            kind: "audio",
            mime: "audio/mpeg",
          },
        ],
      }}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain("MPEG file");
  expect(html).toContain("File unavailable");
  expect(html).toContain('role="status"');
  expect(html).not.toContain('aria-label="Play audio"');
});

it.each([9, 40002])(
  "preserves copied kind %s identities through resend, fold, and profile opening without adding recipients",
  (kind) => {
    const author = keypair(),
      relay = keypair();
    const people = [keypair(), keypair()];
    const profiles = new Map(
      people.map(({ pubkey }) => [pubkey, { name: "Morgan" }]),
    );
    const copies = people.map(({ pubkey }) => {
      const [original] = foldMessages("channel", relay.pubkey, [
        signed(author, {
          kind,
          content:
            kind === 40002
              ? JSON.stringify({ content: "Hello @Morgan" })
              : "Hello @Morgan",
          tags: [
            ["h", "channel"],
            ["p", pubkey],
          ],
        }),
      ]);
      if (!original) throw new Error("missing original");
      return messageCopyText(original, profiles, []);
    });
    const content = copies.join(" and ");
    const [resent] = foldMessages("channel", relay.pubkey, [
      signed(author, {
        kind,
        content: kind === 40002 ? JSON.stringify({ content }) : content,
        tags: [["h", "channel"]],
      }),
    ]);
    if (!resent) throw new Error("missing resent message");
    expect(resent.mentions).toEqual([]);
    expect(messageCopyText(resent, profiles, [])).toBe(content);
    const open = vi.fn((_target: string, _origin?: unknown) => true);
    try {
      renderDom(
        <MessageRow
          row={resent}
          profile={undefined}
          participantProfiles={profiles}
          media={() => undefined}
          onOpenLink={open}
          canOpenLink={() => true}
          day={false}
          retry={undefined}
        />,
      );
      const references = screen.getAllByRole("button", {
        name: "View Morgan profile",
      });
      expect(references).toHaveLength(2);
      references.forEach((reference) => {
        fireEvent.click(reference);
        expect(document.activeElement).toBe(reference);
      });
      expect(open.mock.calls).toEqual(
        people.map(({ pubkey }) => [
          profileTarget(pubkey),
          { rootId: resent.id },
        ]),
      );
      expect(resent.mentions).toEqual([]);
    } finally {
      cleanup();
    }
  },
);

it.each([
  { replyCount: 0, threadRootId: undefined, expected: false, count: 1 },
  { replyCount: 2, threadRootId: undefined, expected: true, count: 1 },
  { replyCount: 0, threadRootId: "parent", expected: true, count: 1 },
  { replyCount: 2, threadRootId: undefined, expected: true, count: 2 },
])(
  "passes known comment state from the chat photo to its viewer: $expected",
  ({ replyCount, threadRootId, expected, count }) => {
    const attachment = {
      kind: "image" as const,
      url: "https://fixture.test/photo.png",
    };
    const open = vi.fn();
    renderDom(
      <MessageRow
        row={{
          ...row,
          attachments:
            count === 1
              ? [attachment]
              : [
                  attachment,
                  { ...attachment, url: "https://fixture.test/second.png" },
                ],
          replyCount,
          ...(threadRootId ? { threadRootId } : {}),
        }}
        profile={undefined}
        media={(url) => url}
        onOpenLink={() => false}
        onOpenMediaReview={open}
        day={false}
        retry={undefined}
      />,
    );
    fireEvent.click(
      screen.getByRole("link", {
        name: count === 1 ? "Open image attachment" : "Open image 1 of 2",
      }),
      { detail: 1 },
    );
    expect(open).toHaveBeenCalledWith(row.id, attachment, 0, expected);
    cleanup();
  },
);

// The desktop opener's injected listener (tauri-plugin-opener 2.5.5) launches
// the system browser for any unprevented left click on an HTTP(S) anchor that
// targets `_blank` or carries Ctrl/Shift, skipping only Meta/Alt; a browser tab
// has none of the app's credentials for the raw attachment URL. Without a review
// host every activation must still open in-app, from the same media source that
// loaded the thumbnail.
it.each([
  ["plain", {}],
  ["Shift", { shiftKey: true }],
  ["Ctrl", { ctrlKey: true }],
  ["Cmd", { metaKey: true }],
])(
  "opens a photo in-app from its media source on a %s click when no review host is present",
  async (_, modifiers) => {
    const external: string[] = [];
    const opener = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.altKey
      )
        return;
      const anchor = event
        .composedPath()
        .find(
          (node): node is HTMLAnchorElement =>
            node instanceof HTMLAnchorElement,
        );
      if (
        !anchor?.href ||
        (anchor.target !== "_blank" && !event.ctrlKey && !event.shiftKey)
      )
        return;
      if (/^https?:$/.test(anchor.protocol)) external.push(anchor.href);
    };
    window.addEventListener("click", opener);
    const view = renderMessage({
      row: {
        ...row,
        attachments: [{ kind: "image", url: "https://relay.test/media/a.png" }],
      },
      media: (url) => `http://buzz-media.localhost/${encodeURIComponent(url)}`,
    });
    try {
      const source =
        "http://buzz-media.localhost/https%3A%2F%2Frelay.test%2Fmedia%2Fa.png";
      const thumbnail = screen.getByRole("link", {
        name: "Open image attachment",
      });
      // Middle click, drag and copy on the web yield the authenticated source.
      expect(thumbnail).toHaveAttribute("href", source);
      // The browser's own new-tab default, which the opener leaves to Cmd, is
      // also cancelled.
      expect(fireEvent.click(thumbnail, { detail: 1, ...modifiers })).toBe(
        false,
      );
      const dialog = screen.getByRole("dialog", { name: "Image attachment" });
      expect(
        within(dialog).getByRole("img", { name: "Attachment preview" }),
      ).toHaveAttribute("src", source);
      expect(external).toEqual([]);
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Close fullscreen viewer" }),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      // The modal boundary hands focus back on the next frame.
      await waitFor(() => expect(thumbnail).toHaveFocus());
    } finally {
      window.removeEventListener("click", opener);
      view.unmount();
    }
  },
);

it("retires the fullscreen image viewer when its retained row is suspended", () => {
  const tree = (active: boolean) => (
    <ConversationPresentation value={active}>
      <div hidden={!active} inert={!active}>
        <MessageRow
          row={{
            ...row,
            attachments: [{ kind: "image", url: "https://image.test/a.png" }],
          }}
          profile={undefined}
          media={(url) => url}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
        />
      </div>
    </ConversationPresentation>
  );
  try {
    const view = renderDom(tree(true));
    fireEvent.click(
      screen.getByRole("link", { name: "Open image attachment" }),
      { detail: 1 },
    );
    expect(
      screen.getByRole("dialog", { name: "Image attachment" }),
    ).toBeInTheDocument();
    view.rerender(tree(false));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    view.rerender(tree(true));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    cleanup();
  }
});

it.each(["peer", "own"] as const)(
  "lists Mark unread above Copy message for a managed %s message",
  async (author) => {
    const snapshot = { channels: [{ id: row.channelId }], status: "ready" };
    const operations: never[] = [];
    const session = {
      viewer: author === "own" ? row.authorId : "viewer",
      channels: { list: () => snapshot, subscribeList: () => () => {} },
      messages: { report: vi.fn(async () => {}) },
      profiles: { subscribe: () => () => {}, event: () => undefined },
      outbox: {
        supports: () => true,
        subscribe: () => () => {},
        observeSend: () => () => {},
        snapshot: () => operations,
      },
      unread: {
        subscribe: () => () => {},
        subscribeSync: () => () => {},
        snapshot: () => undefined,
        attention: () => ({ unread: false, forced: false, viewing: true }),
        following: () => false,
      },
    } as unknown as RelaySession;
    renderDom(
      <MessageManagement session={session} channelId={row.channelId}>
        <MessageRow
          row={{ ...row, threadRootId: "a".repeat(64) }}
          session={session}
          profile={undefined}
          media={() => undefined}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
        />
      </MessageManagement>,
    );
    try {
      fireEvent.click(
        screen.getByRole("button", { name: "More message actions" }),
      );
      await screen.findByRole("menu");
      expect(
        screen.getAllByRole("menuitem").map((item) => item.textContent),
      ).toEqual(
        author === "own"
          ? [
              "Mark unread",
              "Copy message",
              "Send to channel",
              "Edit message",
              "Delete message",
              "Follow thread",
              "Report",
            ]
          : ["Mark unread", "Copy message", "Follow thread", "Report"],
      );
    } finally {
      cleanup();
    }
  },
);

it.each(["sending", "failed"] as const)(
  "does not leave an orphan menu separator on a %s own message",
  async (delivery) => {
    const snapshot = { channels: [], status: "ready" };
    const session = {
      viewer: row.authorId,
      channels: { list: () => snapshot, subscribeList: () => () => {} },
      messages: {},
      unread: {
        subscribe: () => () => {},
        subscribeSync: () => () => {},
        snapshot: () => undefined,
        following: () => false,
      },
    } as unknown as RelaySession;
    renderDom(
      <MessageRow
        row={{ ...row, delivery }}
        session={session}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    try {
      fireEvent.click(
        screen.getByRole("button", { name: "More message actions" }),
      );
      await screen.findByRole("menu");
      expect(
        screen.getAllByRole("menuitem").map((item) => item.textContent),
      ).toEqual(["Copy message"]);
      expect(screen.queryByRole("separator")).toBeNull();
    } finally {
      cleanup();
    }
  },
);

// These contracts belong to the rendered row, rather than a shallow ThreadPanel fixture.
function renderMessage(
  patch: Partial<import("./MessageRow").MessageRowProps> = {},
) {
  return renderDom(
    <MessageRow
      row={row}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
      {...patch}
    />,
  );
}

it("rejects attachment URLs outside the shared safe-link policy", () => {
  const media = vi.fn((url: string) => url);
  const view = renderMessage({
    row: {
      ...row,
      attachments: [
        { url: "https://safe.test/a.png", kind: "image" },
        { url: "https://user:secret@unsafe.test/a.png", kind: "image" },
        { url: "http://unsafe.test/a.png", kind: "image" },
      ],
    },
    media,
  });
  try {
    const links = screen.getAllByRole("link", {
      name: "Open image attachment",
    });
    expect(media).toHaveBeenCalledExactlyOnceWith("https://safe.test/a.png");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://safe.test/a.png");
    expect(view.container.innerHTML).not.toContain("unsafe.test");
  } finally {
    view.unmount();
  }
});

it.each([true, false])(
  "renders a stripped timecode body with seeking available=%s",
  (canSeek) => {
    const seek = vi.fn();
    const view = renderMessage({
      row: { ...row, content: "⏱ 0:42 — **Change** the title" },
      ...(canSeek ? { onMediaTime: seek } : {}),
    });
    try {
      expect(screen.getByText("Change").tagName).toBe("STRONG");
      expect(view.container).toHaveTextContent("Change the title");
      expect(view.container.textContent?.match(/0:42/g)).toHaveLength(1);
      expect(view.container).not.toHaveTextContent("⏱");
      if (canSeek) {
        fireEvent.click(screen.getByRole("button", { name: "0:42" }));
        expect(seek).toHaveBeenCalledExactlyOnceWith(42);
      } else {
        expect(screen.queryByRole("button", { name: "0:42" })).toBeNull();
        expect(screen.getByText("0:42").tagName).toBe("SPAN");
      }
    } finally {
      view.unmount();
    }
  },
);

it.each([undefined, "canonical-root"])(
  "opens the selected row with canonical root %s and retains trigger focus",
  (threadRootId) => {
    const open = vi.fn();
    const view = renderMessage({
      row: { ...row, threadRootId },
      onOpenThread: open,
    });
    try {
      const trigger = screen.getByRole("button", {
        name: "View thread: 23 replies",
      });
      fireEvent.click(trigger);
      expect(trigger).toHaveFocus();
      expect(open).toHaveBeenCalledExactlyOnceWith(
        row.id,
        threadRootId ?? row.id,
      );
    } finally {
      view.unmount();
    }
  },
);

it("shows unbadged working-agent avatars and shared dots only while a known agent types in this thread", () => {
  // The viewer's own agents come from the library; no loaded row names them.
  // Another person's agent only declares itself in its profile.
  const agent = "a".repeat(64);
  const other = "b".repeat(64);
  const foreign = "c".repeat(64);
  const cached = new Map([[foreign, { name: "Stranger", isAgent: true }]]);
  const library = {
    identities: [
      { pubkey: agent, name: "Brain", avatar: "https://safe/brain" },
      { pubkey: other, name: "Pinky" },
    ],
  };
  const listeners = new Set<() => void>();
  let entries: readonly TypingEntry[] = [
    { channelId: row.channelId, threadRootId: row.id, pubkey: agent },
    { channelId: row.channelId, threadRootId: row.id, pubkey: "human" },
    { channelId: row.channelId, threadRootId: row.id, pubkey: foreign },
    { channelId: row.channelId, threadRootId: "elsewhere", pubkey: other },
    { channelId: row.channelId, pubkey: other },
  ];
  const channels = { channels: [], status: "ready" };
  const session = {
    channels: { list: () => channels, subscribeList: () => () => {} },
    messages: {},
    profiles: { snapshot: () => cached, subscribe: () => () => {} },
    agentChoices: { snapshot: () => library, subscribe: () => () => {} },
    typing: {
      snapshot: () => entries,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  } as unknown as RelaySession;
  const media = vi.fn(() => "https://proxy/brain");
  let view = renderMessage({ session, media, onOpenThread: () => {} });
  try {
    const working = screen.getByRole("button", {
      name: "View thread: 23 replies. Brain working",
    });
    const indicator = working.querySelector("[data-thread-working]");
    expect(indicator).not.toBeNull();
    expect(
      indicator?.querySelectorAll('[data-avatar-shape="squircle"]'),
    ).toHaveLength(1);
    expect(indicator?.querySelector("img")).toHaveAttribute(
      "src",
      "https://proxy/brain",
    );
    expect(media).toHaveBeenCalledWith("https://safe/brain", "small");
    expect(indicator?.querySelector(".buzz-avatar-status-dot")).toBeNull();
    expect(indicator?.querySelector("i")).toBeNull();
    act(() => {
      entries = [
        { channelId: row.channelId, threadRootId: row.id, pubkey: agent },
        { channelId: row.channelId, threadRootId: row.id, pubkey: other },
      ];
      for (const listener of listeners) listener();
    });
    expect(
      indicator?.querySelectorAll('[data-avatar-shape="squircle"]'),
    ).toHaveLength(2);
    expect(working).toHaveAccessibleName(
      "View thread: 23 replies. Brain, Pinky working",
    );
    act(() => {
      entries = [
        { channelId: row.channelId, threadRootId: row.id, pubkey: agent },
      ];
      for (const listener of listeners) listener();
    });
    expect(working.querySelector("[data-thread-working]")).not.toBeNull();
    expect(working).not.toHaveTextContent(/is working|agents are working/);
    view.unmount();
    const open = vi.fn();
    view = renderMessage({
      session,
      row: { ...row, replyCount: 0, participants: [] },
      onOpenThread: open,
    });
    const first = screen.getByRole("button", {
      name: "View thread: Brain is working",
    });
    expect(first).toHaveTextContent("View thread");
    expect(first).not.toHaveTextContent("is working");
    fireEvent.click(first);
    expect(open).toHaveBeenCalledExactlyOnceWith(row.id, row.id);
    act(() => {
      entries = [];
      for (const listener of listeners) listener();
    });
    expect(screen.queryByRole("button", { name: /^View thread:/ })).toBeNull();
    view.unmount();
    view = renderMessage({ session, onOpenThread: () => {} });
    const idle = screen.getByRole("button", {
      name: "View thread: 23 replies",
    });
    expect(idle.querySelector("[data-thread-working]")).toBeNull();
  } finally {
    view.unmount();
  }
});

it("bounds reply participants and projects artwork with fallback initials", () => {
  const media = vi.fn((url: string) =>
    url === "https://safe/avatar" ? "https://proxy/avatar" : undefined,
  );
  const view = renderMessage({
    row: { ...row, participants: ["p1", "p2", "p3", "p4", "p5"] },
    participantProfiles: new Map([
      ["p1", { name: "Alice", picture: "https://safe/avatar" }],
      ["p2", { name: "Brain", picture: "http://unsafe" }],
    ]),
    media,
    onOpenThread: () => {},
  });
  try {
    const trigger = screen.getByRole("button", {
      name: "View thread: 23 replies",
    });
    expect(
      [...trigger.querySelectorAll("[title]")].map((e) =>
        e.getAttribute("title"),
      ),
    ).toEqual(["Alice", "Brain", "p3"]);
    expect(trigger.querySelector("img")).toHaveAttribute(
      "src",
      "https://proxy/avatar",
    );
    expect(trigger.querySelectorAll("img")).toHaveLength(1);
    expect(trigger.querySelector('[title="Brain"]')).toHaveTextContent("B");
    expect(trigger.querySelector('[title="p3"]')).toHaveTextContent("P");
    expect(trigger).toHaveTextContent("+2");
    expect(media).toHaveBeenCalledWith("https://safe/avatar", "small");
    expect(media).toHaveBeenCalledWith("http://unsafe", "small");
  } finally {
    view.unmount();
  }
});

it.each([1, 2, 10])(
  "keeps all %i images reachable in a labelled strip",
  (count) => {
    const html = renderToStaticMarkup(
      <MessageRow
        row={{
          ...row,
          attachments: Array.from({ length: count }, (_, i) => ({
            kind: "image",
            url: `https://image.test/${i}.png`,
          })),
        }}
        profile={undefined}
        media={(url) => url}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    expect(html).toContain(
      `role="group" aria-label="${count} ${count === 1 ? "image" : "images"}"`,
    );
    expect(html.match(/data-thumbnail="true"/g)).toHaveLength(count);
    expect(html).toContain(`href="https://image.test/${count - 1}.png"`);
    const text = new DOMParser().parseFromString(html, "text/html").body
      .textContent;
    if (count === 1) expect(text).not.toContain("1 image");
    else expect(text).toContain(`${count} images`);
  },
);

it("preserves interleaved file order and counts unavailable images but not unsafe URLs", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          { kind: "image", url: "https://image.test/first.png" },
          { kind: "image", url: "javascript:alert(1)" },
          { kind: "image", url: "https://image.test/unavailable.png" },
          {
            kind: "file",
            url: "https://files.test/notes.md",
            name: "notes.md",
          },
          { kind: "image", url: "https://image.test/last.png" },
        ],
      }}
      profile={undefined}
      media={(url) => (url.includes("unavailable") ? undefined : url)}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain('role="group" aria-label="2 images"');
  expect(html).toContain('role="group" aria-label="1 image"');
  const text = new DOMParser().parseFromString(html, "text/html").body
    .textContent;
  expect(text).toContain("2 images");
  expect(text).not.toContain("1 image");
  expect(html).toContain("Image unavailable");
  expect(html).not.toContain("javascript:");
  expect(html.indexOf('href="https://image.test/first.png"')).toBeLessThan(
    html.indexOf('href="https://files.test/notes.md"'),
  );
  expect(html.indexOf('href="https://files.test/notes.md"')).toBeLessThan(
    html.indexOf('href="https://image.test/last.png"'),
  );
});

it("keeps audio and video players between their original image runs", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          { kind: "image", url: "https://image.test/first.png" },
          {
            kind: "audio",
            url: "https://files.test/voice.mp3",
            name: "voice.mp3",
          },
          {
            kind: "video",
            url: "https://files.test/demo.mp4",
            name: "demo.mp4",
          },
          { kind: "image", url: "https://image.test/last.png" },
        ],
      }}
      profile={undefined}
      media={(url) => `/api/relay/media?url=${encodeURIComponent(url)}`}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html.match(/role="group" aria-label="1 image"/g)).toHaveLength(2);
  expect(html).toContain("<audio");
  expect(html).toContain("<video");
  const first = html.indexOf(
    'href="/api/relay/media?url=https%3A%2F%2Fimage.test%2Ffirst.png"',
  );
  const last = html.indexOf(
    'href="/api/relay/media?url=https%3A%2F%2Fimage.test%2Flast.png"',
  );
  expect(first).toBeGreaterThan(-1);
  expect(first).toBeLessThan(html.indexOf("<audio"));
  expect(html.indexOf("<audio")).toBeLessThan(html.indexOf("<video"));
  expect(html.indexOf("<video")).toBeLessThan(last);
});

it.each([true, false])(
  "uses the shared small avatar without shrinking profile controls (clickable=%s)",
  (clickable) => {
    const props = {
      row: { ...row, authorId: "a".repeat(64) },
      profile: undefined,
      media: () => undefined,
      onOpenLink: () => false,
      canOpenLink: () => clickable,
      day: false,
      retry: undefined,
      layout: "thread" as const,
    };
    const view = renderDom(<MessageRow {...props} compactAvatar />);
    expect(view.container.querySelector(".buzz-avatar")).toHaveAttribute(
      "data-size",
      "small",
    );
    if (clickable) {
      expect(
        view.getByRole("button", { name: "View aaaaaaaaaa profile" }),
      ).toHaveAttribute("data-size", "sm");
    }
    view.rerender(<MessageRow {...props} />);
    expect(view.container.querySelector(".buzz-avatar")).toHaveAttribute(
      "data-size",
      clickable ? "fill" : "default",
    );
    view.unmount();
  },
);

it("plays native audio and voice notes through the authenticated scheme", () => {
  for (const name of [undefined, "voice note.m4a"]) {
    const html = renderToStaticMarkup(
      <MessageRow
        row={{
          ...row,
          attachments: [
            {
              url: "https://relay.test/media/audio",
              kind: "audio",
              ...(name ? { name } : {}),
            },
          ],
        }}
        profile={undefined}
        media={() =>
          `buzz-media://localhost/${encodeURIComponent(`https://relay.test/media/${"a".repeat(64)}.m4a`)}`
        }
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    expect(html).toContain(`aria-label="Play ${name ?? "audio"}"`);
    expect(html).toContain("<audio");
    expect(html).not.toContain("Open file");
  }
});

it("never mounts an audio player for a native lookalike", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [{ url: "https://relay.test/audio", kind: "audio" }],
      }}
      profile={undefined}
      media={() =>
        `buzz-media://evil.test/${encodeURIComponent(`https://relay.test/media/${"a".repeat(64)}.m4a`)}`
      }
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).not.toContain("<audio");
  expect(html).toContain("File unavailable");
});

it("opens the exact source thread from a shared message", () => {
  const open = vi.fn(() => true);
  const rootId = "a".repeat(64);
  try {
    renderDom(
      <MessageRow
        row={{ ...row, sentFromThread: { rootId } }}
        profile={undefined}
        media={() => undefined}
        onOpenLink={open}
        day={false}
        retry={undefined}
      />,
    );
    fireEvent.click(screen.getByRole("link", { name: "Thread" }));
    expect(open).toHaveBeenCalledWith(
      `buzz://message?channel=channel&id=${rootId}&thread=${rootId}`,
      { rootId: "root" },
    );
  } finally {
    cleanup();
  }
});

it.each(["own", "other", "root", "pending", "archived", "read-only"])(
  "offers Send to channel only for a writable authored reply: %s",
  async (scenario) => {
    const snapshot = {
      channels: [
        {
          id: row.channelId,
          archived: scenario === "archived",
          readOnly: scenario === "read-only",
        },
      ],
      status: "ready",
    };
    const send = vi.fn();
    const getThreadRoot = vi.fn(() => row);
    const session = {
      viewer: row.authorId,
      channels: { list: () => snapshot, subscribeList: () => () => {} },
      messages: { sendToChannel: send },
      outbox: { supports: () => true },
      unread: {
        subscribe: () => () => {},
        subscribeSync: () => () => {},
        snapshot: () => undefined,
        following: () => false,
      },
    } as unknown as RelaySession;
    const reply: ChannelMessage = {
      ...row,
      threadRootId: scenario === "root" ? undefined : "a".repeat(64),
      authorId: scenario === "other" ? "other" : row.authorId,
      ...(scenario === "pending" ? { delivery: "sending" as const } : {}),
    };
    try {
      renderDom(
        <MessageRow
          row={reply}
          getThreadRoot={getThreadRoot}
          session={session}
          profile={undefined}
          media={() => undefined}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
        />,
        { wrapper: ToastProvider },
      );
      fireEvent.click(
        screen.getByRole("button", { name: "More message actions" }),
      );
      await screen.findByRole("menu");
      const item = screen.queryByRole("menuitem", { name: "Send to channel" });
      expect(!!item).toBe(scenario === "own");
      expect(getThreadRoot).not.toHaveBeenCalled();
      if (item) {
        fireEvent.click(item);
        expect(getThreadRoot).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledWith(reply, row);
      }
    } finally {
      cleanup();
    }
  },
);

it("dismisses an unsubmitted report when its retained row is suspended", async () => {
  const report = vi.fn(async () => {});
  const session = {
    messages: { report },
    channels: {},
    unread: {
      subscribe: () => () => {},
      subscribeSync: () => () => {},
      snapshot: () => undefined,
      following: () => false,
    },
  } as unknown as RelaySession;
  const tree = (active: boolean) => (
    <ToastProvider>
      <ConversationPresentation value={active}>
        <div hidden={!active} inert={!active}>
          <MessageRow
            row={row}
            profile={undefined}
            media={() => undefined}
            onOpenLink={() => false}
            day={false}
            retry={undefined}
            session={session}
          />
        </div>
      </ConversationPresentation>
    </ToastProvider>
  );
  try {
    const view = renderDom(tree(true));
    fireEvent.click(
      screen.getByRole("button", { name: "More message actions" }),
    );
    const reportItem = await screen.findByRole("menuitem", { name: "Report" });
    expect(reportItem.previousElementSibling).toHaveAttribute(
      "role",
      "separator",
    );
    fireEvent.click(reportItem);
    expect(
      await screen.findByRole("dialog", { name: "Report message" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Unsubmitted note" },
    });
    view.rerender(tree(false));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    view.rerender(tree(true));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(report).not.toHaveBeenCalled();
  } finally {
    cleanup();
  }
});

it("presents automation, links the owner and discloses the separate relay signer", async () => {
  const ownerId = "ab".repeat(32),
    signer = "cd".repeat(32);
  const open = vi.fn(() => true);
  try {
    renderMessage({
      row: {
        ...row,
        authorId: ownerId,
        signerId: signer,
        workflowOwnerId: ownerId,
      },
      profile: { name: "Wes" },
      participantProfiles: new Map([[ownerId, { name: "Wes" }]]),
      onOpenLink: open,
      canOpenLink: () => true,
    });
    expect(screen.getByText("Workflow")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "View workflow owner Wes profile" }),
    );
    expect(open).toHaveBeenCalledWith(profileTarget(ownerId), {
      rootId: "root",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Workflow message details" }),
    );
    expect(
      await screen.findByText(/the owner did not sign this message/),
    ).toBeTruthy();
    expect(
      screen.getByText("Signed by the relay").nextElementSibling,
    ).toHaveTextContent(npubEncode(signer));
    expect(
      screen.getByText("Owner public key").nextElementSibling,
    ).toHaveTextContent(npubEncode(ownerId));
    expect(
      screen.queryByRole("button", { name: "View Relay profile" }),
    ).toBeNull();
  } finally {
    cleanup();
  }
});

it("contains a broken plugin message action to its own contribution", () => {
  const listeners = new Set<() => void>();
  const entry = (
    id: string,
    marker: () => React.ReactNode,
    matches = () => true,
  ) => ({
    id,
    title: id,
    key: `test.plugin/${id}`,
    pluginId: "test.plugin",
    revision: "one",
    matches,
    icon: marker,
    component: () => null,
    marker,
  });
  const broken = () => {
    throw new Error("broken contribution");
  };
  const healthy = entry("healthy", () => <span>healthy marker</span>);
  let actions = [
    entry(
      "throwing-matcher",
      () => <span>never</span>,
      () => broken(),
    ),
    entry("throwing-marker", broken),
    healthy,
  ];
  const store = {
    snapshot: () => actions,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  const swap = (next: typeof actions) => {
    actions = next;
    act(() => {
      for (const listener of listeners) listener();
    });
  };
  const none: never[] = [];
  const channelList = { channels: [], status: "ready" };
  const session = {
    viewer: "viewer",
    presence: {
      subscribe: () => () => {},
      status: () => "unknown",
      limited: () => false,
    },
    messages: { report: undefined },
    channels: { subscribeList: () => () => {}, list: () => channelList },
  } as unknown as RelaySession;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    renderDom(
      <MessageRow
        row={{ ...row, replyCount: 0 }}
        session={session}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
        extensions={{
          tools: { snapshot: () => none, subscribe: () => () => {} },
          inline: { snapshot: () => none, subscribe: () => () => {} },
          actions: store,
        }}
      />,
    );
    expect(screen.getByText("Root")).toBeInTheDocument();
    expect(screen.getByText("healthy marker")).toBeInTheDocument();
    expect(screen.queryByText("never")).toBeNull();
    // Disabling and re-enabling is a fresh installation with a fresh boundary.
    swap([healthy]);
    swap([entry("throwing-marker", () => <span>fixed marker</span>), healthy]);
    expect(screen.getByText("fixed marker")).toBeInTheDocument();
    expect(screen.getByText("healthy marker")).toBeInTheDocument();
  } finally {
    error.mockRestore();
    cleanup();
  }
});

it("contains a throwing plugin action icon and opened component", async () => {
  const broken = () => {
    throw new Error("broken contribution");
  };
  const entry = (
    id: string,
    icon: () => React.ReactNode,
    component: () => React.ReactNode,
  ) => ({
    id,
    title: id,
    key: `test.plugin/${id}`,
    pluginId: "test.plugin",
    revision: "one",
    matches: () => true,
    icon,
    component,
  });
  const actions = [
    entry("Broken icon", broken, () => null),
    entry("Broken component", () => <span>ok icon</span>, broken),
  ];
  const none: never[] = [];
  const empty = { snapshot: () => none, subscribe: () => () => {} };
  const channelList = { channels: [], status: "ready" };
  const session = {
    viewer: "viewer",
    presence: {
      subscribe: () => () => {},
      status: () => "unknown",
      limited: () => false,
    },
    unread: {
      subscribe: () => () => {},
      subscribeSync: () => () => {},
      snapshot: () => undefined,
      following: () => false,
    },
    messages: { report: undefined },
    channels: { subscribeList: () => () => {}, list: () => channelList },
  } as unknown as RelaySession;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    renderDom(
      <MessageRow
        row={{ ...row, replyCount: 0 }}
        session={session}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
        extensions={{
          tools: empty,
          inline: empty,
          actions: { snapshot: () => actions, subscribe: () => () => {} },
        }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "More message actions" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Broken icon" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /Broken component/ }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(screen.getByText("Root")).toBeInTheDocument();
  } finally {
    error.mockRestore();
    cleanup();
  }
});

it("keeps a plugin action dialog closed when its plugin is reinstalled with the same key", async () => {
  const listeners = new Set<() => void>();
  const entry = () => ({
    id: "remind",
    title: "Remind",
    key: "test.plugin/remind",
    pluginId: "test.plugin",
    revision: "one",
    matches: () => true,
    component: () => <span>action dialog</span>,
  });
  let actions = [entry()];
  const swap = (next: typeof actions) => {
    actions = next;
    act(() => {
      for (const listener of listeners) listener();
    });
  };
  const none: never[] = [];
  const empty = { snapshot: () => none, subscribe: () => () => {} };
  const channelList = { channels: [], status: "ready" };
  const session = {
    viewer: "viewer",
    presence: {
      subscribe: () => () => {},
      status: () => "unknown",
      limited: () => false,
    },
    unread: {
      subscribe: () => () => {},
      subscribeSync: () => () => {},
      snapshot: () => undefined,
      following: () => false,
    },
    messages: { report: undefined },
    channels: { subscribeList: () => () => {}, list: () => channelList },
  } as unknown as RelaySession;
  try {
    renderDom(
      <MessageRow
        row={{ ...row, replyCount: 0 }}
        session={session}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
        extensions={{
          tools: empty,
          inline: empty,
          actions: {
            snapshot: () => actions,
            subscribe(listener: () => void) {
              listeners.add(listener);
              return () => void listeners.delete(listener);
            },
          },
        }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "More message actions" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remind" }));
    expect(await screen.findByText("action dialog")).toBeInTheDocument();
    swap([]);
    expect(screen.queryByText("action dialog")).toBeNull();
    swap([entry()]);
    expect(screen.queryByText("action dialog")).toBeNull();
  } finally {
    cleanup();
  }
});

it("shows a message for agents as one line from its author to whom it addresses", () => {
  const agent = keypair();
  const rivet = "b".repeat(64);
  const tagged = (audience: string, content: string) =>
    foldMessages("channel", keypair().pubkey, [
      signed(agent, {
        kind: 9,
        content,
        created_at: 5,
        tags: [
          ["h", "channel"],
          ["p", rivet],
          ["audience", audience],
        ],
      }),
    ])[0] as ChannelMessage;
  expect(tagged("everyone", "hi").audience).toBeUndefined();
  expect(tagged("unknown", "hi").audience).toBeUndefined();
  const quiet = tagged(
    "agents",
    "@Rivet, **run** the suite\n\nThen report back to @Rivet.",
  );
  expect(quiet.audience).toBe("agents");
  try {
    renderDom(
      <MessageRow
        row={quiet}
        profile={{ name: "Morgarita" }}
        participantProfiles={new Map([[rivet, { name: "Rivet" }]])}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    const line = screen.getByRole("button", {
      name: "Morgarita to Rivet: **run** the suite…",
    });
    expect(line).toHaveAttribute("aria-expanded", "false");
    // Reveal focuses the scroll anchor with tabIndex -1; on the button, that
    // would take the only toggle out of the Tab order.
    expect(line).not.toHaveAttribute("data-message-id");
    expect(line.parentElement).toHaveAttribute("data-message-id");
    expect(screen.queryByText(/Then report back/)).toBeNull();
    fireEvent.click(line);
    expect(line).toHaveAttribute("aria-expanded", "true");
    // The body keeps later mentions but drops the one the line shows.
    expect(screen.getByText(/Then report back/)).toBeInTheDocument();
    expect(screen.queryByText("@Rivet,")).toBeNull();
    expect(screen.getByText("run").tagName).toBe("STRONG");
    // Anywhere in the open box folds it back.
    fireEvent.click(screen.getByText(/Then report back/));
    expect(line).toHaveAttribute("aria-expanded", "false");
  } finally {
    cleanup();
  }
});

it("keeps an agents message that opens with prose, or is only a mention, as written", () => {
  const rivet = "b".repeat(64);
  const line = (content: string) => {
    try {
      renderDom(
        <MessageRow
          row={{ ...row, content, mentions: [rivet], audience: "agents" }}
          profile={{ name: "Morgarita" }}
          participantProfiles={new Map([[rivet, { name: "Rivet" }]])}
          media={() => undefined}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
        />,
      );
      return screen.getByRole("button").getAttribute("aria-label");
    } finally {
      cleanup();
    }
  };
  expect(line("thanks @Rivet")).toBe("Morgarita: thanks @Rivet");
  expect(line("@Rivet")).toBe("Morgarita: @Rivet");
});

it.each([
  "available",
  "human",
  "activity disabled",
  "profiles disabled",
  "retired",
])(
  "message activity action respects exact agent and active destinations: %s",
  async (mode) => {
    const author = "ab".repeat(32);
    let retired = false;
    const target = profileActivityViewTarget(author);
    const raw = activityTarget(author, row.channelId);
    const open = vi.fn();
    const canOpen = (value: string) =>
      !retired &&
      !(mode === "activity disabled" && value === raw) &&
      !(mode === "profiles disabled" && value === target);
    try {
      renderDom(
        <MessageRow
          row={{
            ...row,
            authorId: author,
            ...(mode !== "human" ? { agentEnvelope: true as const } : {}),
          }}
          profile={undefined}
          media={() => undefined}
          onOpenLink={open}
          canOpenLink={canOpen}
          day={false}
          retry={undefined}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: "More message actions" }),
      );
      await screen.findByRole("menu");
      if (mode === "available" || mode === "retired") {
        const item = screen.getByRole("menuitem", { name: "View activity" });
        expect(item.querySelector(".buzz-menu-icon svg")).toBeInTheDocument();
        expect(screen.queryByRole("separator")).not.toBeInTheDocument();
        retired = mode === "retired";
        fireEvent.click(item);
        if (retired) expect(open).not.toHaveBeenCalled();
        else expect(open).toHaveBeenCalledWith(target);
      } else
        expect(
          screen.queryByRole("menuitem", { name: "View activity" }),
        ).not.toBeInTheDocument();
    } finally {
      cleanup();
    }
  },
);

it("keeps agent and human emoji reactions ordinary, without treating them as activity", () => {
  const agent = { id: "agent-reaction", authorId: "agent" };
  const human = { id: "human-reaction", authorId: "human" };
  const reactions = [
    { content: "👀", events: [agent, human] },
    { content: "💬", events: [agent] },
    { content: "✅", events: [agent] },
  ];
  try {
    const view = renderDom(
      <MessageRow
        row={{ ...row, reactions }}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
        agentPubkeys={new Set(["agent"])}
        participantProfiles={
          new Map([["agent", { name: "Other agent", isAgent: true }]])
        }
      />,
    );
    expect(view.container.textContent).toContain("👀 2");
    expect(view.container.textContent).toContain("💬 1");
    expect(view.container.textContent).toContain("✅ 1");
    expect(
      screen.queryByRole("img", { name: "Other agent working" }),
    ).toBeNull();
  } finally {
    cleanup();
  }
});
