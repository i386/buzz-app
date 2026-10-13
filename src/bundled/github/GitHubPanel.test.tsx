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
import { afterEach, assert, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { GitHubPanel } from "./index";
import styles from "./GitHub.module.css";

assert.exists(styles.additions);
assert.exists(styles.deletions);
assert.exists(styles.branch);
assert.exists(styles.branchLabel);
const additionsClass = styles.additions;
const deletionsClass = styles.deletions;
const branchClass = styles.branch;
const branchLabelClass = styles.branchLabel;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([
  ["open", false, false, "open"],
  ["open", true, false, "Draft"],
  ["closed", true, false, "closed"],
  ["closed", true, true, "Merged"],
])(
  "presents PR state with terminal states before draft: %s, draft=%s, merged=%s",
  async (state, draft, merged, label) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            title: "A small improvement",
            state,
            draft,
            merged,
            additions: 174,
            deletions: 28,
            changed_files: 6,
          }),
        ),
      ),
    );
    render(
      <GitHubPanel
        target="https://github.com/example/project/pull/1"
        close={() => {}}
      />,
    );
    await screen.findByRole("heading", { name: "A small improvement #1" });
    expect(screen.getByText(label)).toHaveAttribute(
      "data-pr-state",
      label.toLowerCase(),
    );
    expect(screen.getByText(label).querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    const changes = screen.getByText("Changes").parentElement;
    if (!changes) throw new Error("Missing Changes row");
    expect(changes.querySelector("dd")).toHaveTextContent("+174 / −28");
    expect(within(changes).getByText("+174")).toHaveClass(additionsClass);
    expect(within(changes).getByText("−28")).toHaveClass(deletionsClass);
  },
);

it("preserves zero counts and leaves an open issue neutral", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "A small improvement",
          state: "open",
          additions: 0,
          deletions: 0,
        }),
      ),
    ),
  );
  render(
    <GitHubPanel
      target="https://github.com/example/project/issues/1"
      close={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "A small improvement" });
  expect(screen.getByText("open")).not.toHaveAttribute("data-pr-state");
  expect(screen.getByText("+0")).toHaveClass(additionsClass);
  expect(screen.getByText("−0")).toHaveClass(deletionsClass);
});

it("links branch labels to their own repositories and preserves unavailable branches", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "A fork contribution",
          state: "open",
          head: {
            label: "contributor:fix/small detail",
            ref: "fix/small detail",
            repo: { full_name: "contributor/project" },
          },
          base: {
            label: "example:main",
            ref: "main",
            repo: { full_name: "example/project" },
          },
        }),
      ),
    ),
  );
  const { unmount } = render(
    <GitHubPanel
      target="https://github.com/example/project/pull/1"
      close={() => {}}
    />,
  );
  const head = await screen.findByRole("link", {
    name: "contributor:fix/small detail",
  });
  expect(head).toHaveAttribute(
    "href",
    "https://github.com/contributor/project/tree/fix/small%20detail",
  );
  expect(head).toHaveClass(branchClass);
  expect(screen.getByRole("link", { name: "main" })).toHaveClass(branchClass);
  expect(head).toHaveAttribute("target", "_blank");
  expect(head).toHaveAttribute("rel", "noreferrer");
  expect(screen.getByRole("link", { name: "main" })).toHaveAttribute(
    "href",
    "https://github.com/example/project/tree/main",
  );
  unmount();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "An unavailable branch",
          head: { label: "contributor:deleted", ref: "deleted", repo: null },
          base: { label: "example:main" },
        }),
      ),
    ),
  );
  render(
    <GitHubPanel
      target="https://github.com/example/project/pull/2"
      close={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "An unavailable branch #2" });
  const deleted = screen.getByText("contributor:deleted");
  expect(deleted).toBeVisible();
  expect(deleted).toHaveClass(branchLabelClass);
  expect(deleted).not.toHaveClass(branchClass);
  expect(screen.getByText("example:main")).toHaveClass(branchLabelClass);
  expect(deleted.parentElement).toHaveTextContent(
    "contributor:deleted → example:main",
  );
  expect(
    screen.queryByRole("link", { name: "contributor:deleted" }),
  ).not.toBeInTheDocument();
});

it("links the author login to their external GitHub profile", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "A small improvement",
          user: { login: "tellaho" },
        }),
      ),
    ),
  );
  render(
    <GitHubPanel
      target="https://github.com/example/project/pull/1"
      close={() => {}}
    />,
  );
  const authors = await screen.findAllByRole("link", { name: "tellaho" });
  const author = authors.find(
    (link) => link.parentElement?.textContent === "by tellaho",
  );
  expect(authors).toHaveLength(2);
  expect(author).toHaveAttribute("href", "https://github.com/tellaho");
  expect(author).toHaveAttribute("target", "_blank");
  expect(author).toHaveAttribute("rel", "noreferrer");
  expect(author?.parentElement).toHaveTextContent("by tellaho");
});

it.each([
  [
    {
      commit: { message: "A commit", author: { name: "Sample Author" } },
      owner: { login: "someone-else" },
    },
    "Sample Author",
  ],
  [{ user: { login: "invalid/profile" } }, "invalid/profile"],
])(
  "does not invent a profile for raw or invalid authors",
  async (data, name) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(data))),
    );
    render(
      <GitHubPanel
        target="https://github.com/example/project/commit/abcdef1"
        close={() => {}}
      />,
    );
    await screen.findByText(`by ${name}`);
    expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
  },
);

it("links the PR owner and repository and moves its number to the title", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ title: "A small improvement" })),
      ),
  );
  render(
    <GitHubPanel
      target="https://github.com/block/buzz-app/pull/629"
      close={() => {}}
    />,
  );
  const owner = screen.getByRole("link", { name: "block" });
  const repository = screen.getByRole("link", { name: "buzz-app" });
  expect(owner).toHaveAttribute("href", "https://github.com/block");
  expect(repository).toHaveAttribute(
    "href",
    "https://github.com/block/buzz-app",
  );
  for (const link of [owner, repository]) {
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  }
  const identity = screen.getByText("Pull request", {
    selector: "small",
  }).parentElement;
  expect(identity).toHaveTextContent("block / buzz-appPull request");
  expect(identity).not.toHaveTextContent("#629");
  const title = await screen.findByRole("heading", {
    name: "A small improvement #629",
  });
  expect(within(title).getByText("#629")).toBeVisible();
  const titleLink = within(title).getByRole("link", {
    name: "A small improvement #629",
  });
  expect(titleLink).toHaveAttribute(
    "href",
    "https://github.com/block/buzz-app/pull/629",
  );
  expect(titleLink).toHaveAttribute("target", "_blank");
  expect(titleLink).toHaveAttribute("rel", "noreferrer");
  expect(
    screen.queryByRole("link", { name: "Open on GitHub" }),
  ).not.toBeInTheDocument();
});

it.each([
  ["https://github.com/example/project", "Repository project"],
  ["https://github.com/example/project/issues/2", "Issue #2"],
  ["https://github.com/example/project/commit/abcdef1", "Commit abcdef1"],
])(
  "preserves the non-PR identity and title for %s",
  async (target, identity) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ title: "GitHub object" })),
        ),
    );
    render(<GitHubPanel target={target} close={() => {}} />);
    expect(screen.getByText(identity)).toBeVisible();
    expect(screen.getByText("example/project")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "example" }),
    ).not.toBeInTheDocument();
    await screen.findByRole("heading", { name: "GitHub object" });
    expect(
      screen.getByRole("link", { name: "Open on GitHub" }),
    ).toHaveAttribute("href", target);
  },
);

it.each([500])(
  "keeps the PR title and prominent external recovery action usable after API failure %s",
  async (status) => {
    const target = "https://github.com/block/buzz-app/pull/629#issuecomment-1";
    let finish!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetch = vi
      .fn()
      .mockReturnValueOnce(response)
      .mockImplementation(
        async (input: string) =>
          new Response(
            JSON.stringify(
              input === "https://api.github.com/repos/block/buzz-app/pulls/629"
                ? { title: "Recovered PR" }
                : [],
            ),
          ),
      );
    vi.stubGlobal("fetch", fetch);
    render(<GitHubPanel target={target} close={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    expect(
      screen.queryByRole("link", { name: "Open on Github" }),
    ).not.toBeInTheDocument();
    const titleLink = screen.getByRole("link", { name: "Pull request #629" });
    expect(titleLink).toHaveAttribute("href", target);
    finish(new Response(null, { status }));
    const alert = await screen.findByRole("alert");
    expect(titleLink).toBeVisible();
    const external = within(alert).getByRole("link", {
      name: "Open on Github",
    });
    const retry = within(alert).getByRole("button", { name: "Retry" });
    expect(external).toHaveAttribute("href", target);
    expect(external).toHaveAttribute("target", "_blank");
    expect(external).toHaveAttribute("rel", "noreferrer");
    expect(external).toHaveAttribute("data-variant", "prominent");
    expect(retry).toHaveAttribute("data-variant", "subtle");
    expect(external.nextElementSibling).toBe(retry);
    fireEvent.click(retry);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    await screen.findByRole("heading", { name: "Recovered PR #629" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open on Github" }),
    ).not.toBeInTheDocument();
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/block/buzz-app/pulls/629",
    );
  },
);

it.each([
  ["reviews", "#issuecomment-123", "Approved", "pullrequestreview-789"],
  ["discussion", "#pullrequestreview-123", "Comment", "issuecomment-456"],
])(
  "copies the selected %s permalink with input fragment '%s' without changing the PR title URL",
  async (_source, inputFragment, label, expectedFragment) => {
    const user = userEvent.setup();
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();
    const base = "https://github.com/sample/project/pull/1";
    const target = `${base}${inputFragment}`;
    const fetch = vi.fn(async (destination: string) => {
      let data: unknown;
      if (destination.includes("/comments?")) {
        data = [
          {
            id: 456,
            created_at: "2026-10-01T13:00:00Z",
            body: "Neutral comment",
            user: { login: "reader" },
          },
        ];
      } else if (destination.includes("/reviews?")) {
        data = [
          {
            id: 789,
            submitted_at: "2026-10-01T14:00:00Z",
            state: "APPROVED",
            body: "",
            user: { login: "reviewer" },
          },
        ];
      } else {
        data = { title: "Neutral PR", state: "open", body: "Summary" };
      }
      return new Response(JSON.stringify(data));
    });
    vi.stubGlobal("fetch", fetch);
    render(
      <ToastProvider>
        <GitHubPanel target={target} close={() => {}} />
      </ToastProvider>,
    );
    const row = await screen.findByRole("group", { name: label });
    await waitFor(() =>
      expect(
        screen.queryByText(/some sources are incomplete/),
      ).not.toBeInTheDocument(),
    );
    const title = screen.getByRole("link", { name: "Neutral PR #1" });
    expect(title).toHaveAttribute("href", target);
    fireEvent.contextMenu(
      within(row).getByText(label === "Comment" ? "reader" : "reviewer"),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Copy link" }),
    );
    await screen.findByText("Comment link copied");
    expect(write).toHaveBeenCalledExactlyOnceWith(
      `${base}#${expectedFragment}`,
    );
    expect(title).toHaveAttribute("href", target);
    expect(fetch.mock.calls.map(([destination]) => destination).sort()).toEqual(
      [
        "https://api.github.com/repos/sample/project/issues/1/comments?per_page=30&page=1",
        "https://api.github.com/repos/sample/project/pulls/1",
        "https://api.github.com/repos/sample/project/pulls/1/reviews?per_page=30&page=1",
      ],
    );
  },
);

it("renders the settled conversation in Discussion without mounting or requesting checks", async () => {
  const pending: ((response: Response) => void)[] = [];
  const fetch = vi.fn((target: string) => {
    if (target.endsWith("/pulls/1"))
      return Promise.resolve(
        new Response(
          JSON.stringify({
            title: "Discussion only",
            body: "Summary\n\n## Details",
            head: { sha: "head-sha" },
            updated_at: "2026-10-02T23:57:00Z",
          }),
        ),
      );
    return new Promise<Response>((resolve) => pending.push(resolve));
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <GitHubPanel
      target="https://github.com/sample/project/pull/1"
      close={() => {}}
    />,
  );
  await waitFor(() => expect(pending).toHaveLength(2));
  expect(
    screen.getByRole("region", { name: "Pull request conversation" }),
  ).toHaveTextContent(/some sources are incomplete/);
  await act(async () => {
    for (const resolve of pending) resolve(new Response("[]"));
  });
  await waitFor(() =>
    expect(
      screen.queryByText(/some sources are incomplete/),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("tab", { name: "Discussion" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("tabpanel", { name: "Discussion" })).toContainElement(
    screen.getByRole("region", { name: "Pull request conversation" }),
  );
  expect(screen.getByRole("tab", { name: "Checks" })).toHaveAttribute(
    "aria-selected",
    "false",
  );
  const hiddenChecks = document.getElementById(
    screen.getByRole("tab", { name: "Checks" }).getAttribute("aria-controls") ??
      "",
  );
  expect(hiddenChecks).not.toBeVisible();
  expect(hiddenChecks).toBeEmptyDOMElement();
  expect(
    screen.queryByText("Checks", { selector: "dt" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(/checks on the PR head commit/),
  ).not.toBeInTheDocument();
  expect(fetch.mock.calls.map(([target]) => target).sort()).toEqual([
    "https://api.github.com/repos/sample/project/issues/1/comments?per_page=30&page=1",
    "https://api.github.com/repos/sample/project/pulls/1",
    "https://api.github.com/repos/sample/project/pulls/1/reviews?per_page=30&page=1",
  ]);
  expect(
    screen.getByText("Last updated").parentElement?.querySelector("time"),
  ).toHaveAttribute("datetime", "2026-10-02T23:57:00Z");
  fireEvent.click(screen.getByRole("button", { name: "Expand Description" }));
  expect(screen.getByRole("heading", { name: "Details" })).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(3);
});
