// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  conversationEvents,
  groupConversationEvents,
  loadConversationPage,
  type ConversationEntry,
} from "./conversation";
import { GitHubConversation } from "./GitHubConversation";
import type { GitHubDetails } from "./data";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
const url = "https://github.com/sample/project/pull/1";
const details: GitHubDetails = {
  title: "A change",
  state: "open",
  author: "author",
  authorUrl: "https://github.com/author",
  createdAt: "2026-10-01T12:00:00Z",
  body: "Summary\n\n## Full description",
  facts: [],
};
const response = (json: unknown, headers?: HeadersInit) =>
  new Response(JSON.stringify(json), { ...(headers ? { headers } : {}) });
const date = (hour: number) => `2026-10-01T${hour}:00:00Z`;
const entry = (
  id: number,
  fields: Partial<ConversationEntry> = {},
): ConversationEntry => ({
  id,
  author: "sample",
  body: "",
  createdAt: date(12),
  ...fields,
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("loads credential-free bounded sources and honors paging without following external destinations", async () => {
  const fetch = vi.fn(async () =>
    response(
      [
        {
          id: 1,
          user: { login: "reviewer" },
          state: "APPROVED",
          submitted_at: date(13),
          body: "",
        },
        { id: 2, state: "PENDING" },
      ],
      {
        link: '<https://api.github.com/repos/sample/project/pulls/1/reviews?per_page=30&page=2>; rel="next"',
      },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  const page = await loadConversationPage(url, "reviews", 1, signal);
  expect(page.next).toBe(2);
  expect(page.entries).toHaveLength(1);
  expect(page.entries[0]).toMatchObject({
    id: 1,
    createdAt: date(13),
    state: "APPROVED",
    body: "",
  });
  expect(fetch).toHaveBeenCalledWith(
    "https://api.github.com/repos/sample/project/pulls/1/reviews?per_page=30&page=1",
    {
      signal,
      credentials: "omit",
      headers: { Accept: "application/vnd.github.full+json" },
    },
  );
  fetch.mockImplementation(async () =>
    response([], { link: '<https://other.test/private?page=2>; rel="next"' }),
  );
  await expect(loadConversationPage(url, "reviews", 1, signal)).rejects.toThrow(
    "unexpected next-page",
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});
it.each([
  ["discussion", "issues/1/comments"],
  ["reviews", "pulls/1/reviews"],
] as const)(
  "accepts repository-ID paging for %s and rebuilds the trusted request",
  async (source, path) => {
    const first = {
      id: 1,
      created_at: date(13),
      submitted_at: date(13),
      body: "First page",
    };
    const fetch = vi.fn(async (target: string) =>
      target.includes("page=2")
        ? response([{ ...first, id: 2, body: "Second page" }])
        : response([first], {
            link: `<https://api.github.com/repositories/123456/${path}?per_page=30&page=2>; rel="next", <https://api.github.com/repositories/123456/${path}?per_page=30&page=4>; rel="last"`,
          }),
    );
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    const firstPage = await loadConversationPage(url, source, 1, signal);
    expect(firstPage.entries).toHaveLength(1);
    expect(firstPage.next).toBe(2);
    if (firstPage.next === undefined) throw new Error("Expected another page");
    const secondPage = await loadConversationPage(
      url,
      source,
      firstPage.next,
      signal,
    );
    expect(secondPage.entries[0]?.body).toBe("Second page");
    expect(secondPage.next).toBeUndefined();
    expect(fetch.mock.calls.map(([target]) => target)).toEqual([
      `https://api.github.com/repos/sample/project/${path}?per_page=30&page=1`,
      `https://api.github.com/repos/sample/project/${path}?per_page=30&page=2`,
    ]);
  },
);
it.each(["discussion", "reviews"] as const)(
  "rejects unexpected %s pagination without fetching it",
  async (source) => {
    const path = source === "reviews" ? "pulls/1/reviews" : "issues/1/comments";
    const valid = `https://api.github.com/repositories/123/${path}?page=2`;
    const links = [
      valid.replace("api.github.com", "other.test"),
      valid.replace("https:", "http:"),
      valid.replace("repositories/123", "repos/other/project"),
      valid.replace("repositories/123", "repositories/abc"),
      valid.replace("/1/", "/2/"),
      valid.replace(
        path,
        source === "reviews" ? "issues/1/comments" : "pulls/1/reviews",
      ),
      valid.replace("page=2", "page=1"),
      valid.replace("page=2", "page=3"),
      `${valid}&page=3`,
      `${valid}#fragment`,
      valid.replace("api.github.com", "user@api.github.com"),
    ];
    const fetch = vi.fn(async () => response([]));
    vi.stubGlobal("fetch", fetch);
    for (const link of links) {
      fetch.mockImplementation(async () =>
        response([], { link: `<${link}>; rel="next"` }),
      );
      await expect(
        loadConversationPage(url, source, 1, new AbortController().signal),
      ).rejects.toThrow("unexpected next-page");
    }
    expect(fetch).toHaveBeenCalledTimes(links.length);
  },
);
it("uses discussion creation time and omits unsafe avatars and unavailable dates", async () => {
  const fetch = vi.fn(async (_target: string) =>
    response([
      {
        id: 4,
        created_at: "bad",
        user: { login: "sample", avatar_url: "https://other.test/avatar" },
        body: null,
      },
      {
        id: 5,
        created_at: date(13),
        user: {
          login: "author",
          avatar_url: "https://avatars.githubusercontent.com/u/1",
        },
        body: "Comment",
      },
    ]),
  );
  vi.stubGlobal("fetch", fetch);
  const page = await loadConversationPage(
    url,
    "discussion",
    1,
    new AbortController().signal,
  );
  expect(fetch.mock.calls[0]?.[0]).toBe(
    "https://api.github.com/repos/sample/project/issues/1/comments?per_page=30&page=1",
  );
  expect(page.entries[0]).toMatchObject({
    createdAt: undefined,
    authorAvatar: undefined,
    body: "",
  });
  expect(page.entries[1]).toMatchObject({
    createdAt: date(13),
    authorAvatar: "https://avatars.githubusercontent.com/u/1",
    body: "Comment",
  });
});
it("orders discussion and submitted reviews chronologically with deterministic ties", () => {
  const events = conversationEvents(
    [entry(20, { createdAt: date(13) }), entry(21, { createdAt: date(14) })],
    [entry(10, { createdAt: date(14) }), entry(22, { createdAt: date(14) })],
  );
  expect(events.map((event) => event.key)).toEqual([
    "discussion-20",
    "review-10",
    "discussion-21",
    "review-22",
  ]);
});
it("omits only empty comment-only reviews while preserving summaries and bodyless decisions", () => {
  const reviews = [
    entry(10, { state: "COMMENTED", body: "" }),
    entry(11, { state: "COMMENTED", body: " \n\t " }),
    entry(12, { state: "COMMENTED", body: "Review summary" }),
    entry(13, {
      state: "COMMENTED",
      body: "![Evidence](https://raw.githubusercontent.com/sample/project/main/preview.png)",
    }),
    entry(14, { state: "APPROVED" }),
    entry(15, { state: "CHANGES_REQUESTED" }),
    entry(16, { state: "DISMISSED" }),
    entry(17, { state: "UNKNOWN" }),
  ];
  const events = conversationEvents([entry(20)], reviews);
  expect(events.map((event) => event.key)).toEqual([
    "review-12",
    "review-13",
    "review-14",
    "review-15",
    "review-16",
    "review-17",
    "discussion-20",
  ]);
  expect(reviews).toHaveLength(8);
});
it("keeps paging available when a page contains only omitted reviews", async () => {
  const fetch = vi.fn(async (target: string) => {
    if (!target.includes("/reviews?")) return response([]);
    return target.includes("page=2")
      ? response([
          {
            id: 11,
            state: "COMMENTED",
            submitted_at: date(14),
            user: { login: "summary-reviewer" },
            body: "Summary\n\n## Review details",
          },
        ])
      : response(
          [
            {
              id: 10,
              state: "COMMENTED",
              submitted_at: date(13),
              user: { login: "inline-only" },
              body: " \n ",
            },
          ],
          {
            link: '<https://api.github.com/repos/sample/project/pulls/1/reviews?per_page=30&page=2>; rel="next"',
          },
        );
  });
  vi.stubGlobal("fetch", fetch);
  render(<GitHubConversation details={details} url={url} />);
  const more = await screen.findByRole("button", { name: "Load more reviews" });
  expect(screen.queryByText("inline-only")).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(2);
  await userEvent.setup().click(more);
  await waitFor(() =>
    expect(
      screen.queryByText(/some sources are incomplete/),
    ).not.toBeInTheDocument(),
  );
  const review = screen.getByRole("group", { name: "Review comment" });
  expect(within(review).getByText("summary-reviewer")).toBeVisible();
  await userEvent
    .setup()
    .click(
      within(review).getByRole("button", { name: "Expand Review comment" }),
    );
  expect(screen.getByRole("heading", { name: "Review details" })).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(
    fetch.mock.calls.some(([target]) => target.includes("/pulls/1/comments")),
  ).toBe(false);
});
it("keeps description-only conversations quiet when all submitted reviews are omitted", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: string) =>
      response(
        target.includes("/reviews?")
          ? [{ id: 10, state: "COMMENTED", submitted_at: date(13), body: "" }]
          : [],
      ),
    ),
  );
  render(<GitHubConversation details={details} url={url} />);
  await waitFor(() =>
    expect(
      screen.queryByText(/some sources are incomplete/),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getAllByRole("group")).toHaveLength(1);
  expect(
    screen.queryByText(/No discussion comments|That’s it/),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("group", { name: "Description" }).parentElement,
  ).not.toHaveAttribute("data-has-events");
});
it("keeps source failures independent, retains pages during retry and fetches more only on request", async () => {
  let failReviews = true,
    failPageTwo = true;
  const fetch = vi.fn(async (target: string) => {
    if (target.includes("/reviews?"))
      return failReviews
        ? new Response(null, { status: 403 })
        : response([
            {
              id: 10,
              state: "APPROVED",
              submitted_at: date(14),
              user: { login: "reviewer" },
              body: "",
            },
          ]);
    if (target.includes("/issues/")) {
      if (target.includes("page=2"))
        return failPageTwo
          ? new Response(null, { status: 500 })
          : response([
              { id: 20, created_at: date(13), body: "First comment" },
              { id: 21, created_at: date(15), body: "Second comment" },
            ]);
      return response(
        [{ id: 20, created_at: date(13), body: "First comment" }],
        {
          link: '<https://api.github.com/repos/sample/project/issues/1/comments?per_page=30&page=2>; rel="next"',
        },
      );
    }
    return response([]);
  });
  vi.stubGlobal("fetch", fetch);
  render(<GitHubConversation details={details} url={url} />);
  const user = userEvent.setup();
  await screen.findByRole("button", { name: "Retry reviews" });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/some sources are incomplete/)).toBeVisible();
  expect(screen.queryByText("That’s it!")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Expand Description" }));
  expect(
    screen.getByRole("heading", { name: "Full description" }),
  ).toBeVisible();
  failReviews = false;
  await user.click(screen.getByRole("button", { name: "Retry reviews" }));
  const approval = await screen.findByRole("group", { name: "Approved" });
  expect(
    within(approval).queryByRole("button", { name: /Expand|Toggle/ }),
  ).not.toBeInTheDocument();
  expect(approval).not.toHaveTextContent("loaded code threads");
  await user.click(
    screen.getByRole("button", { name: "Load more discussion" }),
  );
  await screen.findByRole("button", { name: "Retry discussion" });
  expect(
    screen
      .getAllByText("First comment")
      .find((node) => !node.closest("[aria-hidden]")),
  ).toBeVisible();
  failPageTwo = false;
  await user.click(screen.getByRole("button", { name: "Retry discussion" }));
  await waitFor(() =>
    expect(
      screen
        .getAllByText("Second comment")
        .some((node) => !node.closest("[aria-hidden]")),
    ).toBe(true),
  );
  expect(
    screen.getAllByRole("button", { name: "Expand Comment" }),
  ).toHaveLength(2);
  expect(
    screen.queryByText(/some sources are incomplete/),
  ).not.toBeInTheDocument();
  expect(
    fetch.mock.calls
      .map(([target]) => target)
      .filter((target) => target.includes("/issues/")),
  ).toHaveLength(3);
});
it("fetches only discussion and reviews, keeps summary expansion independent and bodyless reviews without disclosures", async () => {
  const fetch = vi.fn(async (target: string) =>
    response(
      target.includes("/reviews?")
        ? [
            {
              id: 10,
              state: "DISMISSED",
              submitted_at: date(14),
              user: { login: "reviewer" },
              body: "  ",
            },
            {
              id: 11,
              state: "CHANGES_REQUESTED",
              submitted_at: date(15),
              user: { login: "another-reviewer" },
              body: "Summary\n\n## Full review",
            },
          ]
        : [
            {
              id: 20,
              created_at: date(13),
              user: { login: "contributor" },
              body: "Brief\n\n## Full comment",
            },
          ],
    ),
  );
  vi.stubGlobal("fetch", fetch);
  render(<GitHubConversation details={details} url={url} />);
  await waitFor(() =>
    expect(
      screen.queryByText(/some sources are incomplete/),
    ).not.toBeInTheDocument(),
  );
  expect(fetch.mock.calls.map(([target]) => target).sort()).toEqual([
    "https://api.github.com/repos/sample/project/issues/1/comments?per_page=30&page=1",
    "https://api.github.com/repos/sample/project/pulls/1/reviews?per_page=30&page=1",
  ]);
  const emptyReview = screen.getByRole("group", { name: "Review dismissed" });
  expect(
    within(emptyReview).queryByRole("button", { name: /Expand|Toggle/ }),
  ).not.toBeInTheDocument();
  expect(emptyReview).toHaveAttribute("data-bodyless", "true");
  expect(emptyReview).not.toHaveTextContent("No message provided");
  expect(screen.queryByText(/code threads/i)).not.toBeInTheDocument();
  const user = userEvent.setup();
  const description = screen.getByRole("button", {
    name: "Expand Description",
  });
  expect(description.querySelector("a")).toBeNull();
  await user.click(screen.getByRole("link", { name: "author" }));
  expect(description).toHaveAttribute("aria-expanded", "false");
  await user.click(screen.getByRole("button", { name: "Toggle Description" }));
  expect(description).toHaveAttribute("aria-expanded", "true");
  await user.click(description);
  expect(description).toHaveAttribute("aria-expanded", "false");
  await user.click(description);
  await user.click(screen.getByRole("button", { name: "Expand Comment" }));
  await user.click(
    screen.getByRole("button", { name: "Expand Changes requested" }),
  );
  for (const name of ["Full description", "Full comment", "Full review"])
    expect(screen.getByRole("heading", { name })).toBeVisible();
});
it("aborts all old sources, ignores late results and resets pages and expansion on PR changes", async () => {
  const pending: { resolve(response: Response): void; signal: AbortSignal }[] =
    [];
  vi.stubGlobal(
    "fetch",
    vi.fn((target: string, options: RequestInit) =>
      target.includes("/2/")
        ? Promise.resolve(response([]))
        : new Promise<Response>((resolve) =>
            pending.push({ resolve, signal: options.signal as AbortSignal }),
          ),
    ),
  );
  const view = render(<GitHubConversation details={details} url={url} />);
  await waitFor(() => expect(pending).toHaveLength(2));
  fireEvent.click(screen.getByRole("button", { name: "Expand Description" }));
  view.rerender(
    <GitHubConversation
      details={{ ...details, body: "New summary\n\n## New body" }}
      url={url.replace("/1", "/2")}
    />,
  );
  await waitFor(() =>
    expect(
      screen.queryByText(/some sources are incomplete/),
    ).not.toBeInTheDocument(),
  );
  expect(pending.every(({ signal }) => signal.aborted)).toBe(true);
  await act(async () => {
    for (const request of pending)
      request.resolve(response([{ id: 20, body: "Stale comment" }]));
  });
  expect(screen.queryByText("Stale comment")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Expand Description" }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(
    screen.queryByRole("heading", { name: "Full description" }),
  ).not.toBeInTheDocument();
});
it("keeps description usable while held sources load and removes source notices after completion", async () => {
  const finish: ((response: Response) => void)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>((resolve) => finish.push(resolve))),
  );
  render(<GitHubConversation details={{ ...details, body: "" }} url={url} />);
  await waitFor(() => expect(finish).toHaveLength(2));
  expect(screen.getAllByRole("status")).toHaveLength(2);
  expect(screen.queryByText("That’s it!")).not.toBeInTheDocument();
  expect(
    screen
      .getAllByText("No description provided")
      .find((node) => !node.closest("[aria-hidden]")),
  ).toBeVisible();
  await act(async () => {
    for (const resolve of finish) resolve(response([]));
  });
  expect(
    screen.queryByText(/No discussion comments|That’s it/),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("group", { name: "Description" }).parentElement,
  ).not.toHaveAttribute("data-has-events");
  expect(
    screen.queryByRole("region", { name: "Discussion" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("All pages loaded")).not.toBeInTheDocument();
  expect(screen.queryByText(/Conversation loaded/)).not.toBeInTheDocument();
  expect(screen.queryByText(/oldest first/)).not.toBeInTheDocument();
  expect(
    screen.queryByText(/some sources are incomplete/),
  ).not.toBeInTheDocument();
});

it("keeps more-page loading explicit and ignores late page results after switching PRs", async () => {
  let finish!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  let started = false;
  vi.stubGlobal(
    "fetch",
    vi.fn((target: string, options: RequestInit) => {
      if (target.includes("page=2")) {
        started = true;
        signal = options.signal as AbortSignal;
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      return Promise.resolve(
        response(
          target.includes("/issues/1/") ? [{ id: 20, body: "First page" }] : [],
          target.includes("/issues/1/")
            ? {
                link: '<https://api.github.com/repos/sample/project/issues/1/comments?per_page=30&page=2>; rel="next"',
              }
            : undefined,
        ),
      );
    }),
  );
  const view = render(<GitHubConversation details={details} url={url} />);
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: "Load more discussion" }));
  await waitFor(() => expect(started).toBe(true));
  const source = screen.getByRole("region", { name: "Discussion" });
  expect(within(source).getByRole("status")).toHaveTextContent(
    "Loading discussion",
  );
  expect(
    within(source).getByRole("button", { name: "Load more discussion" }),
  ).toHaveAttribute("aria-busy", "true");
  expect(
    screen
      .getAllByText("First page")
      .find((node) => !node.closest("[aria-hidden]")),
  ).toBeVisible();
  view.rerender(
    <GitHubConversation details={details} url={url.replace("/1", "/2")} />,
  );
  await waitFor(() =>
    expect(
      screen.queryByText(/some sources are incomplete/),
    ).not.toBeInTheDocument(),
  );
  expect(signal?.aborted).toBe(true);
  await act(async () => finish(response([{ id: 21, body: "Stale page two" }])));
  expect(screen.queryByText("Stale page two")).not.toBeInTheDocument();
  expect(screen.queryByText("First page")).not.toBeInTheDocument();
});

it("uses the opening avatar only, then verdict icons and shared feedback bubbles with explicit labels", async () => {
  const states = [
    "APPROVED",
    "CHANGES_REQUESTED",
    "COMMENTED",
    "DISMISSED",
    "UNKNOWN",
  ];
  const labels = [
    "Approved",
    "Changes requested",
    "Review comment",
    "Review dismissed",
    "Reviewed",
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: string) =>
      response(
        target.includes("/reviews?")
          ? states.map((state, index) => ({
              id: 10 + index,
              state,
              submitted_at: date(13 + index),
              user: { login: `reviewer-${index}` },
              body: "Review message",
            }))
          : target.includes("/issues/")
            ? [{ id: 20, user: { login: "commenter" }, body: "Discussion" }]
            : [],
      ),
    ),
  );
  const { container } = render(
    <GitHubConversation details={details} url={url} />,
  );
  await waitFor(() =>
    expect(
      screen.queryByText(/some sources are incomplete/),
    ).not.toBeInTheDocument(),
  );
  expect(container.querySelectorAll(".buzz-avatar")).toHaveLength(1);
  expect(
    screen
      .getByRole("group", { name: "Description" })
      .querySelector(".buzz-avatar"),
  ).not.toBeNull();
  const icons = states.map((state, index) => {
    const marker = container.querySelector(`[data-review-state="${state}"]`);
    expect(marker).not.toBeNull();
    if (!marker) throw new Error(`Missing ${state} marker`);
    const group = marker.closest<HTMLElement>('[role="group"]');
    if (!group) throw new Error(`Missing ${state} event`);
    expect(group).toHaveAttribute("aria-label", labels[index]);
    expect(
      within(group).getByText(labels[index] ?? "Reviewed"),
    ).toHaveAttribute(
      "title",
      "Submitted review event, not the PR’s current approval status",
    );
    const icon = marker.querySelector("svg");
    if (!icon) throw new Error(`Missing ${state} icon`);
    expect(icon).toHaveAttribute("aria-hidden", "true");
    return icon.innerHTML;
  });
  expect(new Set(icons.slice(0, 4)).size).toBe(4);
  expect(icons[4]).toBe(icons[2]);
  const comment = screen.getByRole("group", { name: "Comment" });
  expect(within(comment).getByText("Comment")).toBeVisible();
  expect(comment.querySelector(".buzz-avatar")).toBeNull();
  expect(comment.querySelector("svg")?.innerHTML).toBe(icons[2]);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Toggle Approved" }));
  expect(
    screen.getByRole("button", { name: "Expand Approved" }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(
    screen.getByRole("button", {
      name: "Expand Changes requested",
    }),
  ).toHaveAttribute("aria-expanded", "false");
});

it("folds only consecutive older comments, preserving decisions and the latest event", () => {
  const events = conversationEvents(
    [
      entry(1, { createdAt: date(12) }),
      entry(3, { createdAt: date(14) }),
      entry(8, { createdAt: date(19) }),
      entry(9, { createdAt: date(20) }),
    ],
    [
      entry(2, { state: "COMMENTED", body: "A review", createdAt: date(13) }),
      entry(4, { state: "APPROVED", createdAt: date(15) }),
      entry(5, {
        author: "another-reviewer",
        state: "CHANGES_REQUESTED",
        createdAt: date(16),
      }),
      entry(6, {
        author: "dismissed-reviewer",
        state: "DISMISSED",
        createdAt: date(17),
      }),
      entry(7, { state: "UNKNOWN", createdAt: date(18) }),
    ],
  );
  const grouped = groupConversationEvents(events);
  expect(grouped.map((event) => event.kind)).toEqual([
    "history",
    "review",
    "review",
    "review",
    "review",
    "discussion",
    "discussion",
  ]);
  expect(grouped[0]).toMatchObject({ events: events.slice(0, 3) });
  expect(grouped.at(-1)).toBe(events.at(-1));
  const comments = events.filter((event) => event.kind === "discussion");
  expect(groupConversationEvents(comments)).toEqual([
    { key: comments[0]?.key, kind: "history", events: comments.slice(0, -1) },
    comments.at(-1),
  ]);
  expect(groupConversationEvents([])).toEqual([]);
  expect(groupConversationEvents(comments.slice(0, 1))).toEqual(
    comments.slice(0, 1),
  );
});

it("places merge at its real time rather than forcing it after post-merge comments", () => {
  const events = conversationEvents(
    [entry(1, { createdAt: date(13) }), entry(2, { createdAt: date(18) })],
    [entry(3, { state: "APPROVED", createdAt: date(14) })],
    {
      ...details,
      mergedAt: date(17),
      mergedBy: "maintainer",
      mergedByUrl: "https://github.com/maintainer",
    },
  );
  expect(events.map((event) => event.key)).toEqual([
    "discussion-1",
    "review-3",
    "merge",
    "discussion-2",
  ]);
  expect(events[2]?.message).toMatchObject({
    author: "maintainer",
    createdAt: date(17),
    authorUrl: "https://github.com/maintainer",
  });
  expect(conversationEvents([], [], details)).toEqual([]);
  expect(
    conversationEvents([entry(1)], [], { ...details, mergedAt: date(17) }).at(
      -1,
    )?.kind,
  ).toBe("merge");
});

it("expands mixed history in place without fetching and keeps merge at the higher level", async () => {
  const fetch = vi.fn(async (target: string) =>
    response(
      target.includes("/reviews?")
        ? [
            {
              id: 10,
              state: "COMMENTED",
              body: "Review summary",
              user: { login: "reviewer" },
              submitted_at: date(14),
            },
            {
              id: 11,
              state: "APPROVED",
              body: "",
              user: { login: "maintainer" },
              submitted_at: date(16),
            },
          ]
        : [
            {
              id: 20,
              body: "First discussion",
              user: { login: "contributor" },
              created_at: date(13),
            },
            {
              id: 21,
              body: "Second discussion",
              user: { login: "contributor" },
              created_at: date(15),
            },
          ],
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const view = render(
    <GitHubConversation
      details={{ ...details, mergedAt: date(17), mergedBy: "maintainer" }}
      url={url}
    />,
  );
  await waitFor(() =>
    expect(
      screen.queryByText(/some sources are incomplete/),
    ).not.toBeInTheDocument(),
  );
  const trigger = screen.getByRole("button", {
    name: "Show 4 earlier messages",
  });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(
    screen.queryByRole("group", { name: "Comment" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("group", { name: "Approved" }),
  ).not.toBeInTheDocument();
  const merge = screen.getByRole("group", { name: "Merged" });
  expect(merge).toHaveAttribute("data-bodyless", "true");
  expect(within(merge).queryByRole("button")).not.toBeInTheDocument();
  const user = userEvent.setup();
  trigger.focus();
  await user.keyboard("{Enter}");
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(trigger).toHaveAccessibleName("Hide 4 earlier messages");
  expect(trigger).toHaveTextContent("Hide earlier messages");
  expect(trigger).not.toHaveTextContent("4 earlier messages");
  expect(trigger).not.toHaveTextContent("contributor");
  expect(trigger).toHaveFocus();
  expect(
    document.getElementById(trigger.getAttribute("aria-controls") ?? ""),
  ).toBeInTheDocument();
  expect(screen.getAllByRole("group", { name: "Comment" })).toHaveLength(2);
  expect(screen.getByRole("group", { name: "Review comment" })).toBeVisible();
  const approval = screen.getByRole("group", { name: "Approved" });
  expect(approval).toBeVisible();
  expect(approval.parentElement).not.toBe(merge.parentElement);
  expect(within(approval).getByText("maintainer")).toBeVisible();
  expect(approval.querySelector("time")).toHaveAttribute("datetime", date(16));
  expect(
    screen
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-label")),
  ).toEqual([
    "Description",
    "Comment",
    "Review comment",
    "Comment",
    "Approved",
    "Merged",
  ]);
  expect(fetch).toHaveBeenCalledTimes(2);
  await user.keyboard(" ");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(trigger).toHaveAccessibleName("Show 4 earlier messages");
  expect(trigger).toHaveTextContent("4 earlier messages");
  expect(trigger).toHaveFocus();
  expect(
    screen.queryByRole("group", { name: "Approved" }),
  ).not.toBeInTheDocument();
  view.rerender(
    <GitHubConversation details={details} url={url.replace("/1", "/2")} />,
  );
  await waitFor(() =>
    expect(
      screen.queryByText(/some sources are incomplete/),
    ).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole("button", { name: "Show 3 earlier messages" }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(
    screen.queryByRole("group", { name: "Merged" }),
  ).not.toBeInTheDocument();
});

it("retains an expanded run and source recovery while another page appends a newer comment", async () => {
  let fail = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: string) => {
      if (target.includes("/reviews?")) return response([]);
      if (target.includes("page=2"))
        return fail
          ? new Response(null, { status: 500 })
          : response([{ id: 22, body: "Newest", created_at: date(19) }]);
      return response(
        [
          { id: 20, body: "First", created_at: date(13) },
          { id: 21, body: "Second", created_at: date(14) },
        ],
        {
          link: '<https://api.github.com/repos/sample/project/issues/1/comments?per_page=30&page=2>; rel="next"',
        },
      );
    }),
  );
  render(
    <GitHubConversation
      details={{ ...details, mergedAt: date(17) }}
      url={url}
    />,
  );
  const more = await screen.findByRole("button", {
    name: "Load more discussion",
  });
  const trigger = screen.getByRole("button", {
    name: "Show 2 earlier messages",
  });
  fireEvent.click(trigger);
  fireEvent.click(more);
  const retry = await screen.findByRole("button", { name: "Retry discussion" });
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(screen.getAllByRole("group", { name: "Comment" })).toHaveLength(2);
  fail = false;
  fireEvent.click(retry);
  await waitFor(() =>
    expect(
      screen.queryByText(/some sources are incomplete/),
    ).not.toBeInTheDocument(),
  );
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  const afterMerge = screen.getByRole("button", {
    name: "Show 1 message after merge",
  });
  expect(afterMerge).toHaveAttribute("aria-expanded", "false");
  expect(screen.getAllByRole("group", { name: "Comment" })).toHaveLength(2);
  fireEvent.click(afterMerge);
  expect(screen.getAllByRole("group").at(-1)).toHaveTextContent("Newest");
  expect(screen.getAllByRole("group", { name: "Comment" })).toHaveLength(3);
});

it("folds pre-merge conversation and post-merge comments separately, preserving post-merge decisions", () => {
  const events = conversationEvents(
    [entry(2, { createdAt: date(13) }), entry(5, { createdAt: date(19) })],
    [
      entry(1, { state: "CHANGES_REQUESTED", createdAt: date(12) }),
      entry(3, { state: "APPROVED", createdAt: date(14) }),
      entry(4, { state: "CHANGES_REQUESTED", createdAt: date(18) }),
    ],
    { ...details, mergedAt: date(17) },
  );
  const grouped = groupConversationEvents(events);
  expect(grouped).toEqual([
    { key: events[0]?.key, kind: "history", events: events.slice(0, 3) },
    ...events.slice(3, 5),
    {
      key: "discussion-5",
      kind: "history",
      events: [events[5]],
      afterMerge: true,
    },
  ]);
  const mergeOnly = conversationEvents([], [], {
    ...details,
    mergedAt: date(17),
  });
  expect(groupConversationEvents(mergeOnly)).toEqual(mergeOnly);
});

it("keeps pre-merge approval-only stretches visible but still folds superseded change requests", () => {
  for (const reviews of [
    [entry(1, { state: "APPROVED", createdAt: date(13) })],
    [
      entry(1, { state: "APPROVED", createdAt: date(13) }),
      entry(2, { author: "another", state: "APPROVED", createdAt: date(14) }),
    ],
  ]) {
    const events = conversationEvents([], reviews, {
      ...details,
      mergedAt: date(17),
    });
    expect(groupConversationEvents(events)).toEqual(events);
  }
  const request = conversationEvents(
    [],
    [entry(1, { state: "CHANGES_REQUESTED", createdAt: date(13) })],
    { ...details, mergedAt: date(17) },
  );
  expect(groupConversationEvents(request)).toEqual([
    { key: "review-1", kind: "history", events: [request[0]] },
    request[1],
  ]);
  const comments = conversationEvents([entry(1)], [], {
    ...details,
    mergedAt: date(17),
  });
  expect(groupConversationEvents(comments)).toEqual(comments);
});

it("keeps approval milestones on either side of folded conversation stretches", () => {
  const events = conversationEvents(
    [entry(2, { createdAt: date(13) }), entry(3, { createdAt: date(14) })],
    [
      entry(1, { state: "APPROVED", createdAt: date(12) }),
      entry(4, { state: "APPROVED", createdAt: date(15) }),
      entry(5, { state: "UNKNOWN", createdAt: date(16) }),
      entry(6, { state: "APPROVED", createdAt: date(17) }),
    ],
    { ...details, mergedAt: date(18) },
  );
  expect(groupConversationEvents(events)).toEqual([
    { key: "review-1", kind: "history", events: events.slice(0, 4) },
    ...events.slice(4),
  ]);
});

it("folds even the newest post-merge comment, but not unknown-time comments or new verdicts", () => {
  for (const kind of ["discussion", "review"]) {
    const comment = entry(1, {
      state: "COMMENTED",
      body: "Follow-up",
      createdAt: date(18),
    });
    const events = conversationEvents(
      kind === "discussion" ? [comment] : [],
      kind === "review" ? [comment] : [],
      { ...details, mergedAt: date(17) },
    );
    expect(groupConversationEvents(events)).toEqual([
      events[0],
      {
        key: events[1]?.key,
        kind: "history",
        events: [events[1]],
        afterMerge: true,
      },
    ]);
  }
  const events = conversationEvents(
    [
      entry(1, { createdAt: date(18) }),
      entry(2, { createdAt: date(19) }),
      entry(4, { createdAt: undefined }),
    ],
    [entry(3, { state: "CHANGES_REQUESTED", createdAt: date(20) })],
    { ...details, mergedAt: date(17) },
  );
  expect(groupConversationEvents(events)).toEqual([
    events[0],
    events[1],
    {
      key: "discussion-1",
      kind: "history",
      events: events.slice(2, 4),
      afterMerge: true,
    },
    events[4],
  ]);
});

it("keeps each reviewer's latest verdict and does not treat a comment as superseding it", () => {
  const events = conversationEvents(
    [entry(6, { createdAt: date(18) })],
    [
      entry(1, {
        author: "Alice",
        state: "CHANGES_REQUESTED",
        createdAt: date(12),
      }),
      entry(2, {
        author: "Bob",
        state: "CHANGES_REQUESTED",
        createdAt: date(13),
      }),
      entry(3, { author: "alice", state: "APPROVED", createdAt: date(14) }),
      entry(4, {
        author: "Bob",
        state: "COMMENTED",
        body: "Still checking",
        createdAt: date(15),
      }),
      entry(5, { author: "Carol", state: "APPROVED", createdAt: date(16) }),
    ],
  );
  expect(groupConversationEvents(events)).toEqual([
    { key: "review-1", kind: "history", events: [events[0]] },
    ...events.slice(1),
  ]);
  const revised = conversationEvents(
    [],
    [
      entry(1, { state: "APPROVED", createdAt: date(13) }),
      entry(2, { state: "CHANGES_REQUESTED", createdAt: date(14) }),
    ],
  );
  expect(groupConversationEvents(revised)).toEqual([
    { key: "review-1", kind: "history", events: [revised[0]] },
    revised[1],
  ]);
});

it("does not infer supersession from missing actors, missing times or tied timestamps", () => {
  const reviews = [
    entry(1, { author: "", state: "CHANGES_REQUESTED", createdAt: date(12) }),
    entry(2, { author: "", state: "APPROVED", createdAt: date(13) }),
    entry(3, { state: "CHANGES_REQUESTED", createdAt: undefined }),
    entry(4, { state: "APPROVED", createdAt: date(14) }),
    entry(5, { state: "CHANGES_REQUESTED", createdAt: date(14) }),
  ];
  const events = conversationEvents([], reviews);
  expect(groupConversationEvents(events)).toEqual(events);
  const merged = conversationEvents([], reviews, {
    ...details,
    mergedAt: date(13),
  });
  const grouped = groupConversationEvents(merged);
  expect(grouped.find((event) => event.key === "review-1")).toMatchObject({
    kind: "history",
  });
  expect(grouped.find((event) => event.key === "review-2")).toBe(
    merged.find((event) => event.key === "review-2"),
  );
  expect(grouped.find((event) => event.key === "review-3")).toBe(
    merged.find((event) => event.key === "review-3"),
  );
});

it.each([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
  "PENDING",
  "UNKNOWN",
  undefined,
])(
  "accounts for %s reviews in pre-merge history without guessing unknown states",
  (state) => {
    const events = conversationEvents(
      [entry(1, { createdAt: date(12) })],
      [entry(2, { state, body: "Review summary", createdAt: date(13) })],
      { ...details, mergedAt: date(17) },
    );
    const known = [
      "APPROVED",
      "CHANGES_REQUESTED",
      "COMMENTED",
      "DISMISSED",
    ].includes(state ?? "");
    expect(groupConversationEvents(events)).toEqual(
      known
        ? [
            {
              key: "discussion-1",
              kind: "history",
              events: events.slice(0, 2),
            },
            events[2],
          ]
        : events,
    );
  },
);

it.each(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"])(
  "folds a dismissed review superseded by %s from the same reviewer",
  (state) => {
    const events = conversationEvents(
      [],
      [
        entry(1, {
          author: "Reviewer",
          state: "DISMISSED",
          createdAt: date(12),
        }),
        entry(2, { author: "reviewer", state, createdAt: date(13) }),
      ],
    );
    expect(groupConversationEvents(events)).toEqual([
      { key: "review-1", kind: "history", events: [events[0]] },
      events[1],
    ]);
  },
);

it.each(["APPROVED", "CHANGES_REQUESTED"])(
  "folds an earlier %s when the same reviewer has a later dismissed review",
  (state) => {
    const events = conversationEvents(
      [],
      [
        entry(1, { state, createdAt: date(12) }),
        entry(2, { state: "DISMISSED", createdAt: date(13) }),
      ],
    );
    expect(groupConversationEvents(events)).toEqual([
      { key: "review-1", kind: "history", events: [events[0]] },
      events[1],
    ]);
  },
);

it.each(["COMMENTED", "PENDING", "UNKNOWN", undefined])(
  "does not infer dismissal supersession from a later %s review",
  (state) => {
    const events = conversationEvents(
      [],
      [
        entry(1, { state: "DISMISSED", createdAt: date(12) }),
        entry(2, { state, body: "Review summary", createdAt: date(13) }),
      ],
    );
    expect(groupConversationEvents(events)).toEqual(events);
  },
);

it("does not hide dismissals with missing times, tied times or unproven actors", () => {
  for (const reviews of [
    [
      entry(1, { state: "DISMISSED", createdAt: undefined }),
      entry(2, { state: "APPROVED", createdAt: date(13) }),
    ],
    [
      entry(1, { state: "DISMISSED", createdAt: date(13) }),
      entry(2, { state: "APPROVED", createdAt: date(13) }),
    ],
    [
      entry(1, { author: "", state: "DISMISSED", createdAt: date(12) }),
      entry(2, { author: "", state: "APPROVED", createdAt: date(13) }),
    ],
    [
      entry(1, { state: "DISMISSED", createdAt: date(12) }),
      entry(2, { author: "another", state: "APPROVED", createdAt: date(13) }),
    ],
  ]) {
    const events = conversationEvents([], reviews);
    expect(groupConversationEvents(events)).toEqual(events);
  }
  const events = conversationEvents(
    [],
    [entry(1, { state: "DISMISSED", createdAt: date(17) })],
    { ...details, mergedAt: date(17) },
  );
  expect(groupConversationEvents(events)).toEqual(events);
});

it("keeps post-merge dismissed reviews and unknown states visible", () => {
  const events = conversationEvents(
    [],
    [
      entry(1, { state: "DISMISSED", createdAt: date(18) }),
      entry(2, { state: "UNKNOWN", createdAt: date(19) }),
    ],
    { ...details, mergedAt: date(17) },
  );
  expect(groupConversationEvents(events)).toEqual(events);
});

it("folds a lone pre-merge dismissal but keeps unknown reviews visible", () => {
  const events = conversationEvents(
    [],
    [
      entry(1, { state: "DISMISSED", createdAt: date(13) }),
      entry(2, { state: "UNKNOWN", createdAt: date(14) }),
    ],
    { ...details, mergedAt: date(17) },
  );
  expect(groupConversationEvents(events)).toEqual([
    { key: "review-1", kind: "history", events: [events[0]] },
    ...events.slice(1),
  ]);
});

it.each(["CHANGES_REQUESTED", "DISMISSED"])(
  "restores the original %s body on singular history expansion",
  async (state) => {
    const label =
      state === "DISMISSED" ? "Review dismissed" : "Changes requested";
    const user = userEvent.setup();
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();
    const fetch = vi.fn(async (target: string) =>
      response(
        target.includes("/reviews?")
          ? [
              {
                id: 1,
                state,
                submitted_at: date(13),
                user: { login: "reviewer" },
                body: "Please fix the boundary\n\n## Review detail",
              },
            ]
          : [],
      ),
    );
    vi.stubGlobal("fetch", fetch);
    render(
      <ToastProvider>
        <GitHubConversation
          details={{ ...details, mergedAt: date(17) }}
          url={url}
        />
      </ToastProvider>,
    );
    await waitFor(() =>
      expect(
        screen.queryByText(/some sources are incomplete/),
      ).not.toBeInTheDocument(),
    );
    const trigger = screen.getByRole("button", {
      name: "Show 1 earlier message",
    });
    expect(trigger).toHaveTextContent("1 earlier message");
    expect(
      screen.queryByRole("group", { name: label }),
    ).not.toBeInTheDocument();
    await user.click(trigger);
    const verdict = screen.getByRole("group", { name: label });
    await waitFor(() =>
      expect(within(verdict).getByText("reviewer")).toBeVisible(),
    );
    expect(verdict.querySelector("time")).toHaveAttribute("datetime", date(13));
    await user.click(
      within(verdict).getByRole("button", { name: `Expand ${label}` }),
    );
    expect(
      screen.getByRole("heading", { name: "Review detail" }),
    ).toBeVisible();
    await user.click(
      within(verdict).getByRole("button", { name: "Copy link" }),
    );
    expect(write).toHaveBeenCalledWith(`${url}#pullrequestreview-1`);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);

it("renders a lone approval directly and expands post-merge follow-up without requests", async () => {
  const fetch = vi.fn(async (target: string) =>
    response(
      target.includes("/reviews?")
        ? [
            {
              id: 1,
              state: "APPROVED",
              submitted_at: date(13),
              user: { login: "reviewer" },
              body: "",
            },
          ]
        : [
            {
              id: 2,
              created_at: date(18),
              user: { login: "reader" },
              body: "After merge\n\n## Follow-up detail",
            },
          ],
    ),
  );
  vi.stubGlobal("fetch", fetch);
  render(
    <GitHubConversation
      details={{ ...details, mergedAt: date(17), mergedBy: "maintainer" }}
      url={url}
    />,
  );
  await waitFor(() =>
    expect(
      screen.queryByText(/some sources are incomplete/),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("group", { name: "Approved" })).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /earlier/ }),
  ).not.toBeInTheDocument();
  const trigger = screen.getByRole("button", {
    name: "Show 1 message after merge",
  });
  expect(trigger).toHaveTextContent("1 message after merge");
  expect(
    screen.queryByRole("group", { name: "Comment" }),
  ).not.toBeInTheDocument();
  const user = userEvent.setup();
  trigger.focus();
  await user.keyboard("{Enter}");
  expect(trigger).toHaveAccessibleName("Hide 1 message after merge");
  expect(trigger).toHaveTextContent("Hide messages after merge");
  const comment = screen.getByRole("group", { name: "Comment" });
  expect(comment.querySelector("time")).toHaveAttribute("datetime", date(18));
  await user.click(
    within(comment).getByRole("button", { name: "Expand Comment" }),
  );
  expect(
    screen.getByRole("heading", { name: "Follow-up detail" }),
  ).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(2);
});

function copyFixture() {
  const fetch = vi.fn(async (target: string) =>
    response(
      target.includes("/reviews?")
        ? [
            {
              id: 42,
              submitted_at: date(13),
              state: "CHANGES_REQUESTED",
              user: { login: "reviewer" },
              body: "Review summary\n\n## Review body",
            },
          ]
        : [
            {
              id: 43,
              created_at: date(14),
              user: { login: "contributor" },
              body: "Discussion summary\n\n## Comment body",
            },
          ],
    ),
  );
  vi.stubGlobal("fetch", fetch);
  render(
    <ToastProvider>
      <GitHubConversation details={details} url={url} />
    </ToastProvider>,
  );
  return fetch;
}

it("copies a discussion permalink without toggling the accordion or fetching", async () => {
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const fetch = copyFixture();
  const message = await screen.findByRole("group", {
    name: "Comment",
  });
  const disclosure = within(message).getByRole("button", {
    name: "Expand Comment",
  });
  const actions = within(message).getByRole("button", {
    name: "Comment actions",
  });
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
  expect(actions.closest("[data-menu-action]")).not.toBeNull();
  expect(actions).toHaveAttribute("data-icon-size", "xs");
  expect(actions).not.toHaveAttribute("title");
  expect(actions).not.toHaveAttribute("aria-describedby");
  await user.click(actions);
  await user.click(await screen.findByRole("menuitem", { name: "Copy link" }));
  await screen.findByText("Comment link copied");
  expect(write).toHaveBeenCalledWith(`${url}#issuecomment-43`);
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await user.click(disclosure);
  expect(
    within(message).queryByRole("button", { name: "Comment actions" }),
  ).toBeNull();
  expect(screen.getByRole("heading", { name: "Comment body" })).toBeVisible();
  await user.click(within(message).getByRole("button", { name: "Copy link" }));
  expect(screen.queryByRole("menu")).toBeNull();
  await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
  expect(disclosure).toHaveAttribute("aria-expanded", "true");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(
    within(screen.getByRole("group", { name: "Description" })).queryByRole(
      "button",
      { name: "Comment actions" },
    ),
  ).toBeNull();
});

it("shares review copying and retry feedback between right-click and button menus", async () => {
  const user = userEvent.setup();
  const write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValueOnce();
  copyFixture();
  const message = await screen.findByRole("group", {
    name: "Changes requested",
  });
  const disclosure = within(message).getByRole("button", {
    name: "Expand Changes requested",
  });
  const actions = within(message).getByRole("button", {
    name: "Comment actions",
  });
  fireEvent.contextMenu(disclosure);
  await user.click(await screen.findByRole("menuitem", { name: "Copy link" }));
  await screen.findByText(
    "Couldn’t copy the link. Try again from the comment actions.",
  );
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await user.click(actions);
  await user.click(await screen.findByRole("menuitem", { name: "Copy link" }));
  await screen.findByText("Comment link copied");
  expect(write).toHaveBeenCalledTimes(2);
  expect(write).toHaveBeenLastCalledWith(`${url}#pullrequestreview-42`);
  expect(
    screen.queryByText(
      "Couldn’t copy the link. Try again from the comment actions.",
    ),
  ).toBeNull();
});

it("retries failed direct copying from the expanded message", async () => {
  const user = userEvent.setup();
  const write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValueOnce();
  const fetch = copyFixture();
  const message = await screen.findByRole("group", { name: "Comment" });
  const disclosure = within(message).getByRole("button", {
    name: "Expand Comment",
  });
  await user.click(disclosure);
  const copy = within(message).getByRole("button", {
    name: "Copy link",
  });
  await user.click(copy);
  await screen.findByText(
    "Couldn’t copy the link. Try again from the comment actions.",
  );
  await user.click(copy);
  await screen.findByText("Comment link copied");
  expect(write).toHaveBeenCalledTimes(2);
  expect(write).toHaveBeenLastCalledWith(`${url}#issuecomment-43`);
  expect(disclosure).toHaveAttribute("aria-expanded", "true");
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("opens both menus by keyboard and restores focus without changing disclosure", async () => {
  const user = userEvent.setup();
  copyFixture();
  const message = await screen.findByRole("group", {
    name: "Comment",
  });
  const disclosure = within(message).getByRole("button", {
    name: "Expand Comment",
  });
  disclosure.focus();
  await user.keyboard("{Shift>}{F10}{/Shift}");
  await screen.findByRole("menuitem", { name: "Copy link" });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(disclosure).toHaveFocus());
  const actions = within(message).getByRole("button", {
    name: "Comment actions",
  });
  actions.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("menuitem", { name: "Copy link" });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(actions).toHaveFocus());
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
});

it("prevents duplicate writes across both menus while the clipboard is pending", async () => {
  const user = userEvent.setup();
  let finish!: () => void;
  const write = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  copyFixture();
  const message = await screen.findByRole("group", {
    name: "Comment",
  });
  const actions = within(message).getByRole("button", {
    name: "Comment actions",
  });
  await user.click(actions);
  await user.click(await screen.findByRole("menuitem", { name: "Copy link" }));
  try {
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    fireEvent.contextMenu(
      within(message).getByRole("button", { name: "Expand Comment" }),
    );
    const item = await screen.findByRole("menuitem", {
      name: "Copy link",
    });
    expect(item).toHaveAttribute("aria-disabled", "true");
    await user.click(item);
    expect(write).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    await user.click(
      within(message).getByRole("button", { name: "Expand Comment" }),
    );
    const directCopy = within(message).getByRole("button", {
      name: "Copy link",
    });
    expect(directCopy).toHaveAttribute("aria-busy", "true");
    await user.click(directCopy);
    expect(write).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => finish());
  }
  await screen.findByText("Comment link copied");
});

// Explicit gates expose focus during in-flight recovery rather than relying on timing.
it.each(["discussion"] as const)(
  "retains %s Retry focus through deferred repeated failure",
  async (source) => {
    const user = userEvent.setup();
    let finish: ((response: Response) => void) | undefined;
    let calls = 0;
    const fetch = vi.fn((target: string) => {
      if (!target.includes("/comments?")) return Promise.resolve(response([]));
      calls++;
      if (calls === 1)
        return Promise.resolve(new Response("", { status: 500 }));
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    vi.stubGlobal("fetch", fetch);
    render(<GitHubConversation details={details} url={url} />);
    const retry = await screen.findByRole("button", {
      name: `Retry ${source}`,
    });
    retry.focus();
    await user.keyboard("{Enter}");
    try {
      await waitFor(() => expect(finish).toBeDefined());
      expect(retry).toHaveFocus();
      expect(retry).toHaveAttribute("aria-busy", "true");
      await user.keyboard("{Enter}");
      expect(calls).toBe(2);
    } finally {
      await act(async () => finish?.(new Response("", { status: 500 })));
    }
    expect(await screen.findByRole("button", { name: `Retry ${source}` })).toBe(
      retry,
    );
    expect(retry).toHaveFocus();
    expect(retry).not.toHaveAttribute("aria-busy", "true");
  },
);
it.each([
  ["discussion", false],
  ["discussion", true],
] as const)(
  "hands off %s focus only when the completed source action still owns it (moved=%s)",
  async (source, moved) => {
    const user = userEvent.setup();
    let finish: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((target: string) => {
        if (!target.includes("/comments?"))
          return Promise.resolve(response([]));
        if (target.includes("page=2"))
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        return Promise.resolve(
          response(
            [
              {
                id: 1,
                created_at: date(13),
                submitted_at: date(13),
                body: "One",
              },
            ],
            {
              link: `<https://api.github.com/repositories/123/issues/1/comments?per_page=30&page=2>; rel="next"`,
            },
          ),
        );
      }),
    );
    render(<GitHubConversation details={details} url={url} />);
    const more = await screen.findByRole("button", {
      name: `Load more ${source}`,
    });
    const description = screen.getByRole("button", {
      name: "Expand Description",
    });
    more.focus();
    await user.keyboard("{Enter}");
    try {
      await waitFor(() => expect(finish).toBeDefined());
      expect(more).toHaveFocus();
      expect(more).toHaveAttribute("aria-busy", "true");
      if (moved) {
        await user.tab({ shift: true });
        expect(more).not.toHaveFocus();
        description.focus();
      }
    } finally {
      await act(async () =>
        finish?.(
          response([
            {
              id: 2,
              created_at: date(14),
              submitted_at: date(14),
              body: "Two",
            },
          ]),
        ),
      );
    }
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: `Load more ${source}` }),
      ).not.toBeInTheDocument(),
    );
    expect(
      moved
        ? description
        : screen.getByRole("region", { name: "Pull request conversation" }),
    ).toHaveFocus();
  },
);

function stubScrollIntoView() {
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scroll,
  });
  return {
    scroll,
    [Symbol.dispose]: () => {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    },
  };
}
const anchoredRow = (key: string) =>
  document.querySelector<HTMLElement>(`[data-event-key="${key}"]`);

it("reveals the linked comment inside a folded run in full, then moves to a later anchor without fetching", async () => {
  using stub = stubScrollIntoView();
  const fetch = vi.fn(async (target: string) =>
    response(
      target.includes("/reviews?")
        ? [
            {
              id: 10,
              state: "COMMENTED",
              body: "Review summary",
              user: { login: "reviewer" },
              submitted_at: date(14),
            },
          ]
        : [
            {
              id: 20,
              body: "First discussion",
              user: { login: "contributor" },
              created_at: date(13),
            },
            {
              id: 21,
              body: "Second discussion",
              user: { login: "contributor" },
              created_at: date(15),
            },
          ],
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const merged = { ...details, mergedAt: date(17), mergedBy: "maintainer" };
  const view = render(
    <GitHubConversation
      details={merged}
      url={url}
      anchor={{ kind: "discussion", id: "21" }}
    />,
  );
  const trigger = await screen.findByRole("button", {
    name: "Hide 3 earlier messages",
  });
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  const second = anchoredRow("discussion-21");
  if (!second) throw new Error("Missing anchored row");
  await waitFor(() => expect(second).toHaveFocus());
  expect(second).toHaveAttribute("data-anchored", "true");
  expect(second).toHaveAttribute("tabindex", "-1");
  expect(second).toHaveAccessibleName("Comment");
  expect(
    within(second).getByRole("button", { name: "Expand Comment" }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(
    within(second)
      .getAllByText("Second discussion")
      .find((node) => !node.closest("[aria-hidden]")),
  ).toBeVisible();
  expect(stub.scroll).toHaveBeenCalledExactlyOnceWith({
    block: "end",
    behavior: "instant",
  });
  expect(stub.scroll.mock.contexts[0]).toBe(second);
  const first = anchoredRow("discussion-20");
  expect(first).not.toHaveAttribute("data-anchored");
  expect(first).not.toHaveAttribute("tabindex");
  expect(
    within(first ?? document.body).getByRole("button", {
      name: "Expand Comment",
    }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText(/linked comment/)).not.toBeInTheDocument();
  // A rerender without an anchor change neither scrolls nor refocuses.
  const outside = document.createElement("button");
  document.body.append(outside);
  outside.focus();
  view.rerender(
    <GitHubConversation
      details={merged}
      url={url}
      anchor={{ kind: "discussion", id: "21" }}
    />,
  );
  await act(async () => {});
  expect(outside).toHaveFocus();
  expect(stub.scroll).toHaveBeenCalledOnce();
  view.rerender(
    <GitHubConversation
      details={merged}
      url={url}
      anchor={{ kind: "review", id: "10" }}
    />,
  );
  const review = anchoredRow("review-10");
  if (!review) throw new Error("Missing review row");
  await waitFor(() => expect(review).toHaveFocus());
  expect(review).toHaveAttribute("data-anchored", "true");
  expect(second).not.toHaveAttribute("data-anchored");
  expect(stub.scroll).toHaveBeenCalledTimes(2);
  expect(stub.scroll.mock.contexts[1]).toBe(review);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(fetch).toHaveBeenCalledTimes(2);
  outside.remove();
});

it("reveals the linked comment once both sources answer, surviving the run regrouping an earlier review causes", async () => {
  using stub = stubScrollIntoView();
  let finishReviews!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn((target: string) =>
      target.includes("/reviews?")
        ? new Promise<Response>((resolve) => {
            finishReviews = resolve;
          })
        : Promise.resolve(
            response([
              { id: 20, body: "First discussion", created_at: date(13) },
              { id: 21, body: "Second discussion", created_at: date(15) },
            ]),
          ),
    ),
  );
  render(
    <GitHubConversation
      details={{ ...details, mergedAt: date(17), mergedBy: "maintainer" }}
      url={url}
      anchor={{ kind: "discussion", id: "21" }}
    />,
  );
  const early = await waitFor(() => {
    const element = anchoredRow("discussion-21");
    if (!element) throw new Error("Discussion not loaded yet");
    return element;
  });
  expect(
    screen.getByRole("button", { name: "Hide 2 earlier messages" }),
  ).toHaveAttribute("aria-expanded", "true");
  await waitFor(() => expect(finishReviews).toBeDefined());
  // Reviews are still pending, so the row may yet move; the reveal waits.
  expect(stub.scroll).not.toHaveBeenCalled();
  expect(early).not.toHaveFocus();
  await act(async () =>
    finishReviews(
      response([
        {
          id: 9,
          state: "COMMENTED",
          body: "Early review",
          user: { login: "reviewer" },
          submitted_at: date(12),
        },
      ]),
    ),
  );
  // The run now starts at the review, so React mounted a fresh row for the comment.
  const row = anchoredRow("discussion-21");
  if (!row) throw new Error("Missing anchored row");
  expect(row).not.toBe(early);
  await waitFor(() => expect(row).toHaveFocus());
  expect(row).toHaveAttribute("data-anchored", "true");
  expect(
    screen.getByRole("button", { name: "Hide 3 earlier messages" }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(stub.scroll).toHaveBeenCalledOnce();
  expect(stub.scroll.mock.contexts[0]).toBe(row);
});

it("keeps the top of a linked comment taller than its scroller visible", async () => {
  using stub = stubScrollIntoView();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    height: 400,
  } as DOMRect);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: string) =>
      response(
        target.includes("/reviews?")
          ? []
          : [{ id: 20, body: "Long comment", user: { login: "reader" } }],
      ),
    ),
  );
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  Object.defineProperty(scroller, "clientHeight", { value: 300 });
  document.body.append(scroller);
  try {
    render(
      <GitHubConversation
        details={details}
        url={url}
        anchor={{ kind: "discussion", id: "20" }}
      />,
      { container: scroller },
    );
    const row = await waitFor(() => {
      const element = anchoredRow("discussion-20");
      if (!element) throw new Error("Not loaded yet");
      return element;
    });
    await waitFor(() => expect(row).toHaveFocus());
    expect(stub.scroll).toHaveBeenCalledExactlyOnceWith({
      block: "start",
      behavior: "instant",
    });
  } finally {
    scroller.remove();
  }
});

it("offers GitHub for a linked comment outside the loaded conversation and reveals it once a later page loads", async () => {
  using stub = stubScrollIntoView();
  let finishReviews!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn((target: string) => {
      if (target.includes("/reviews?"))
        return new Promise<Response>((resolve) => {
          finishReviews = resolve;
        });
      if (target.includes("page=2"))
        return Promise.resolve(response([{ id: 21, body: "Second page" }]));
      return Promise.resolve(
        response([{ id: 20, body: "First page" }], {
          link: '<https://api.github.com/repos/sample/project/issues/1/comments?per_page=30&page=2>; rel="next"',
        }),
      );
    }),
  );
  const view = render(
    <GitHubConversation
      details={details}
      url={url}
      anchor={{ kind: "review", id: "30" }}
    />,
  );
  await screen.findByRole("button", { name: "Load more discussion" });
  // The review source has not answered yet, so the comment is not known to be missing.
  expect(screen.queryByText(/linked comment/)).not.toBeInTheDocument();
  await act(async () =>
    finishReviews(
      response([
        {
          id: 30,
          state: "COMMENTED",
          body: "",
          user: { login: "reviewer" },
          submitted_at: date(14),
        },
      ]),
    ),
  );
  const notice = screen.getByRole("status", { name: "" });
  expect(notice).toHaveTextContent(
    "The linked comment isn’t in the loaded conversation.",
  );
  expect(
    within(notice).getByRole("link", { name: "Open it on GitHub" }),
  ).toHaveAttribute("href", `${url}#pullrequestreview-30`);
  expect(document.querySelector("[data-anchored]")).toBeNull();
  view.rerender(
    <GitHubConversation
      details={details}
      url={url}
      anchor={{ kind: "discussion", id: "21" }}
    />,
  );
  expect(
    screen.getByRole("link", { name: "Open it on GitHub" }),
  ).toHaveAttribute("href", `${url}#issuecomment-21`);
  expect(stub.scroll).not.toHaveBeenCalled();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Load more discussion" }));
  const row = await waitFor(() => {
    const element = anchoredRow("discussion-21");
    if (!element) throw new Error("Second page not revealed yet");
    return element;
  });
  await waitFor(() => expect(row).toHaveFocus());
  expect(row).toHaveAttribute("data-anchored", "true");
  expect(stub.scroll).toHaveBeenCalledOnce();
  expect(screen.queryByText(/linked comment/)).not.toBeInTheDocument();
});
