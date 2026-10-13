// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RegisteredPage } from "../../features/pages/service";
import { createServices, type AppServices } from "../services";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { AppShell } from "./AppShell";

vi.mock("../../bundled", () => ({ bundledPlugins: [] }));

// jsdom has no media queries or layout observers; responsive geometry is
// covered in browser tests.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
let services: AppServices | undefined;
afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
});

it("hides and shows the channel sidebar without re-rendering its content", async () => {
  const current = createServices();
  services = current;
  const renders = vi.fn();
  function Sidebar({ children }: { children: ReactNode }) {
    renders();
    return (
      <aside aria-label="Channel sidebar" className="shell-sidebar">
        {children}
      </aside>
    );
  }
  const sidebar = (pages: ReactNode) => <Sidebar>{pages}</Sidebar>;
  // Stable inputs, so only `selected` changes between the renders below.
  const pages: RegisteredPage[] = [
    {
      id: "channels",
      key: "buzz.channels/channels",
      pluginId: "buzz.channels",
      revision: "1",
      title: "Channels",
      component: () => null,
      primary: true,
    },
  ];
  const onSelect = () => {};
  const shell = (selected: string) => (
    <ToastProvider>
      <AppShell
        pages={pages}
        selected={selected}
        navigationAttempt=""
        onSelect={onSelect}
        tone="default"
        sidebar={sidebar}
        communities={current.communities}
        accountActions={current.accountActions}
      >
        content
      </AppShell>
    </ToastProvider>
  );
  const { rerender } = render(shell("buzz.channels/channels"));
  const content = screen.getByRole("complementary", {
    name: "Channel sidebar",
  });
  const navigation = document.getElementById("shell-navigation");
  const rendered = renders.mock.calls.length;
  const row = () => within(content).getByRole("button", { name: "Messages" });
  expect(row()).toHaveAttribute("aria-current", "page");

  for (const [label, hidden] of [
    ["Hide Channel sidebar", "true"],
    ["Show Channel sidebar", "false"],
    ["Hide Channel sidebar", "true"],
    ["Show Channel sidebar", "false"],
  ] as const) {
    await userEvent.click(screen.getByRole("button", { name: label }));
    expect(navigation).toHaveAttribute("aria-hidden", hidden);
  }
  expect(content).toBeInTheDocument();
  expect(renders).toHaveBeenCalledTimes(rendered);

  // A selection change still reaches the page rows the sidebar renders.
  rerender(shell("buzz.agents/agents"));
  expect(renders.mock.calls.length).toBeGreaterThan(rendered);
  expect(row()).not.toHaveAttribute("aria-current");
});

it("lets a plugin page hide and show the shell sidebar", async () => {
  const current = createServices();
  services = current;
  const pages: RegisteredPage[] = [
    {
      id: "main",
      key: "example.plugin/main",
      pluginId: "example.plugin",
      revision: "1",
      title: "Beacon",
      component: () => null,
      primary: true,
    },
  ];
  render(
    <ToastProvider>
      <AppShell
        pages={pages}
        selected="example.plugin/main"
        navigationAttempt=""
        onSelect={() => {}}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
      >
        content
      </AppShell>
    </ToastProvider>,
  );

  const navigation = document.getElementById("shell-navigation");
  expect(
    within(screen.getByRole("navigation", { name: "Pages" })).getByRole(
      "button",
      { name: "Beacon" },
    ),
  ).toBeInTheDocument();
  expect(navigation).toHaveAttribute("data-sidebar-collapsible");
  await userEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
  expect(navigation).toHaveAttribute("aria-hidden", "true");
  expect(navigation).toHaveAttribute("inert");
  expect(screen.getByRole("button", { name: "Show sidebar" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(
    screen.queryByRole("navigation", { name: "Pages" }),
  ).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
  expect(navigation).toHaveAttribute("aria-hidden", "false");
  expect(navigation).not.toHaveAttribute("inert");
  expect(screen.getByRole("button", { name: "Hide sidebar" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(
    within(screen.getByRole("navigation", { name: "Pages" })).getByRole(
      "button",
      { name: "Beacon" },
    ),
  ).toBeInTheDocument();
});

it("does not make a non-primary plugin page's sidebar collapsible", () => {
  const current = createServices();
  services = current;
  const pages: RegisteredPage[] = [
    {
      id: "secondary",
      key: "example.plugin/secondary",
      pluginId: "example.plugin",
      revision: "1",
      title: "Secondary",
      component: () => null,
      primary: false,
    },
  ];
  render(
    <ToastProvider>
      <AppShell
        pages={pages}
        selected="example.plugin/secondary"
        navigationAttempt=""
        onSelect={() => {}}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
      >
        content
      </AppShell>
    </ToastProvider>,
  );

  expect(document.getElementById("shell-navigation")).not.toHaveAttribute(
    "data-sidebar-collapsible",
  );
  expect(
    screen.queryByRole("button", { name: "Hide sidebar" }),
  ).not.toBeInTheDocument();
});

it("keeps built-in sidebar controls available before page contributions load", () => {
  const current = createServices();
  services = current;
  const pages: RegisteredPage[] = [];
  const shell = (selected: string) => (
    <ToastProvider>
      <AppShell
        pages={pages}
        selected={selected}
        navigationAttempt=""
        onSelect={() => {}}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
      >
        content
      </AppShell>
    </ToastProvider>
  );
  const { rerender } = render(shell("buzz.channels/channels"));
  expect(
    screen.getByRole("button", { name: "Hide Channel sidebar" }),
  ).toHaveAttribute("aria-expanded", "true");

  rerender(shell("buzz.me/me"));
  expect(
    screen.getByRole("button", { name: "Hide Me sidebar" }),
  ).toHaveAttribute("aria-expanded", "true");
});

it("shows a primary plugin page's declared icon beside its nav label", () => {
  const current = createServices();
  services = current;
  const icon = "data:image/png;base64,iVBORbeacon";
  const pages: RegisteredPage[] = [
    {
      id: "main",
      key: "example.plugin/main",
      pluginId: "example.plugin",
      revision: "1",
      title: "Beacon",
      component: () => null,
      primary: true,
      icon,
    },
  ];
  render(
    <ToastProvider>
      <AppShell
        pages={pages}
        selected="example.plugin/main"
        navigationAttempt=""
        onSelect={() => {}}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
      >
        content
      </AppShell>
    </ToastProvider>,
  );
  const row = within(
    screen.getByRole("navigation", { name: "Pages" }),
  ).getByRole("button", { name: "Beacon" });
  const image = row.querySelector("img");
  expect(image).toBeInstanceOf(HTMLImageElement);
  expect(image).toHaveAttribute("src", icon);
});

it("contains a throwing page badge to its own nav row", () => {
  const current = createServices();
  services = current;
  const page = (id: string, title: string, badge?: () => ReactNode) => ({
    id,
    key: `example.plugin/${id}`,
    pluginId: "example.plugin",
    revision: "1",
    title,
    component: () => null,
    primary: true,
    ...(badge ? { badge } : {}),
  });
  const pages: RegisteredPage[] = [
    page("broken", "Broken", () => {
      throw new Error("broken badge");
    }),
    page("healthy", "Healthy", () => <span>3</span>),
  ];
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    render(
      <ToastProvider>
        <AppShell
          pages={pages}
          selected="example.plugin/broken"
          navigationAttempt=""
          onSelect={() => {}}
          tone="default"
          communities={current.communities}
          accountActions={current.accountActions}
        >
          content
        </AppShell>
      </ToastProvider>,
    );
    const nav = screen.getByRole("navigation", { name: "Pages" });
    expect(within(nav).getByRole("button", { name: /Broken/ })).toBeVisible();
    expect(
      within(nav).getByRole("button", { name: /Healthy/ }),
    ).toHaveTextContent("3");
    expect(screen.getByText("content")).toBeInTheDocument();
  } finally {
    error.mockRestore();
  }
});

it("partitions primary pages without duplicate links and preserves exact selection and removal", async () => {
  const current = createServices();
  services = current;
  const onSelect = vi.fn();
  const page = (
    id: string,
    placement?: RegisteredPage["placement"],
  ): RegisteredPage => ({
    id,
    key: `example/${id}`,
    pluginId: "example",
    revision: "one",
    title: id,
    primary: true,
    component: () => null,
    ...(placement ? { placement } : {}),
  });
  const pages = [
    page("Sidebar"),
    page("Topbar", "topbar"),
    page("Toolbar", "toolbar"),
    { ...page("Search only", "topbar"), primary: false },
  ];
  const shell = (entries = pages, selected = "example/Toolbar") => (
    <ToastProvider>
      <AppShell
        pages={entries}
        selected={selected}
        navigationAttempt=""
        onSelect={onSelect}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
      >
        content
      </AppShell>
    </ToastProvider>
  );
  const { rerender } = render(shell());
  for (const [name, landmark] of [
    ["Sidebar", "Pages"],
    ["Topbar", "Topbar pages"],
    ["Toolbar", "Toolbar pages"],
  ] as const) {
    expect(
      within(screen.getByRole("navigation", { name: landmark })).getByRole(
        name === "Topbar" ? "tab" : "button",
        { name },
      ),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole(name === "Topbar" ? "tab" : "button", { name }),
    ).toHaveLength(1);
  }
  expect(
    screen.queryByRole("button", { name: "Search only" }),
  ).not.toBeInTheDocument();
  const toolbar = screen.getByRole("button", { name: "Toolbar" });
  expect(toolbar).toHaveAttribute("aria-current", "page");
  expect(toolbar).not.toHaveAttribute("aria-expanded");
  expect(toolbar.querySelector("svg")).toBeInTheDocument();
  await userEvent.click(toolbar);
  expect(onSelect).toHaveBeenCalledWith("example/Toolbar");
  expect(document.getElementById("main-content")).toHaveFocus();
  rerender(shell(pages, "settings"));
  expect(toolbar).not.toHaveAttribute("aria-current");
  rerender(shell(pages.filter((p) => p.placement !== "toolbar")));
  expect(
    screen.queryByRole("navigation", { name: "Toolbar pages" }),
  ).not.toBeInTheDocument();
});

it("routes compact header pages through the labelled overflow with main focus handoff", async () => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  const current = createServices();
  services = current;
  const onSelect = vi.fn();
  render(
    <ToastProvider>
      <AppShell
        pages={[
          {
            id: "me",
            key: "buzz.me/me",
            pluginId: "buzz.me",
            revision: "one",
            title: "Me",
            primary: true,
            placement: "topbar",
            component: () => null,
          },
        ]}
        selected="buzz.me/me"
        navigationAttempt=""
        onSelect={onSelect}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
      >
        content
      </AppShell>
    </ToastProvider>,
  );
  expect(
    screen.queryByRole("navigation", { name: "Topbar pages" }),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "More pages" }));
  const nav = await screen.findByRole("navigation", { name: "Header pages" });
  const me = within(nav).getByRole("button", { name: "Me" });
  expect(me).toHaveAttribute("aria-current", "page");
  await userEvent.click(me);
  expect(onSelect).toHaveBeenCalledWith("buzz.me/me");
  expect(document.getElementById("main-content")).toHaveFocus();
});

it("falls back from a failed toolbar image and isolates toolbar badge errors", () => {
  const current = createServices();
  services = current;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    render(
      <ToastProvider>
        <AppShell
          pages={[
            {
              id: "icon",
              key: "example/icon",
              pluginId: "example",
              revision: "one",
              title: "Icon",
              primary: true,
              placement: "toolbar",
              icon: "data:image/png,broken",
              component: () => null,
              badge: () => {
                throw new Error("bad badge");
              },
            },
          ]}
          selected="example/icon"
          navigationAttempt=""
          onSelect={() => {}}
          tone="default"
          communities={current.communities}
          accountActions={current.accountActions}
        >
          content
        </AppShell>
      </ToastProvider>,
    );
    const button = screen.getByRole("button", { name: "Icon" });
    const image = button.querySelector("img");
    if (!image) throw new Error("Expected contributed page image");
    fireEvent.error(image);
    expect(button.querySelector("img")).toBeNull();
    expect(button.querySelector("svg")).toBeInTheDocument();
    expect(button).toBeEnabled();
  } finally {
    error.mockRestore();
  }
});

it("uses chrome tabs with manual keyboard selection, page linkage, and isolated badges", async () => {
  const current = createServices();
  services = current;
  const onSelect = vi.fn();
  const pages: RegisteredPage[] = ["Me", "Messages"].map((title) => ({
    id: title,
    key: `example/${title}`,
    pluginId: "example",
    revision: "one",
    title,
    primary: true,
    placement: "topbar",
    component: () => null,
    badge: () => <span>3 unread</span>,
  }));
  const shell = (selected: string, entries = pages) => (
    <ToastProvider>
      <AppShell
        pages={entries}
        selected={selected}
        navigationAttempt=""
        onSelect={onSelect}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
      >
        Page content
      </AppShell>
    </ToastProvider>
  );
  const { rerender } = render(shell("example/Messages"));
  const tabs = screen.getByRole("tablist", { name: "Topbar pages" });
  expect(tabs.parentElement).toHaveAttribute("data-variant", "chrome");
  const messages = within(tabs).getByRole("tab", {
    name: /Messages\s*3 unread/,
  });
  const me = within(tabs).getByRole("tab", { name: /Me\s*3 unread/ });
  expect(messages).toHaveAttribute("aria-selected", "true");
  expect(
    screen.getByRole("tabpanel", { name: /Messages\s*3 unread/ }),
  ).toHaveAttribute("id", messages.getAttribute("aria-controls"));
  messages.focus();
  await userEvent.keyboard("{ArrowLeft}");
  expect(me).toHaveFocus();
  expect(onSelect).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledWith("example/Me", { focus: "preserve" });
  rerender(shell("example/Me"));
  expect(me).toHaveFocus();
  expect(me).toHaveAttribute("aria-selected", "true");
  expect(
    screen.getByRole("tabpanel", { name: /Me\s*3 unread/ }),
  ).toHaveAttribute("id", me.getAttribute("aria-controls"));
  rerender(shell("settings"));
  expect(within(tabs).getAllByRole("tab", { selected: false })).toHaveLength(2);
  expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
  rerender(
    shell(
      "example/Me",
      pages.filter((page) => page.id !== "Me"),
    ),
  );
  expect(within(tabs).getAllByRole("tab", { selected: false })).toHaveLength(1);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    rerender(
      shell(
        "example/Me",
        pages.map((page) => ({
          ...page,
          badge: () => {
            throw new Error("bad badge");
          },
        })),
      ),
    );
    expect(within(tabs).getByRole("tab", { name: "Me" })).toBeEnabled();
  } finally {
    error.mockRestore();
  }
});

it.each([false, true])(
  "keeps Messages selected for a child without losing exact navigation (compact: %s)",
  async (compact) => {
    vi.stubGlobal("matchMedia", (media: string) => ({
      media,
      matches: compact,
      addEventListener() {},
      removeEventListener() {},
    }));
    const current = createServices();
    services = current;
    const onSelect = vi.fn();
    const entries: RegisteredPage[] = [
      { key: "buzz.me/me", title: "Me", placement: "topbar" },
      { key: "buzz.channels/channels", title: "Channels", placement: "topbar" },
      { key: "buzz.inbox/inbox", title: "Inbox", placement: "sidebar" },
      { key: "example/top", title: "Top", placement: "topbar" },
      { key: "example/tool", title: "Tool", placement: "toolbar" },
    ].map((entry) => ({
      ...entry,
      placement: entry.placement as "topbar" | "sidebar" | "toolbar",
      id: entry.key.slice(entry.key.indexOf("/") + 1),
      pluginId: entry.key.slice(0, entry.key.indexOf("/")),
      revision: "one",
      primary: true,
      component: () => null,
    }));
    const shell = (selected: string, pages = entries) => (
      <ToastProvider>
        <AppShell
          pages={pages}
          selected={selected}
          navigationAttempt=""
          onSelect={onSelect}
          tone="default"
          communities={current.communities}
          accountActions={current.accountActions}
        >
          <p>Child content</p>
        </AppShell>
      </ToastProvider>
    );
    const { rerender } = render(shell("buzz.inbox/inbox"));
    if (compact)
      await userEvent.click(
        screen.getByRole("button", { name: "Show navigation" }),
      );
    const inbox = within(
      screen.getByRole("navigation", { name: "Pages" }),
    ).getByRole("button", { name: "Inbox" });
    expect(inbox).toHaveAttribute("aria-current", "page");
    if (compact)
      await userEvent.click(screen.getByRole("button", { name: "More pages" }));
    const nav = screen.getByRole("navigation", {
      name: compact ? "Header pages" : "Topbar pages",
    });
    const role = compact ? "button" : "tab";
    const messages = within(nav).getByRole(role, { name: "Messages" });
    if (compact) {
      expect(messages).toHaveAttribute("aria-current", "true");
      expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
      await userEvent.click(messages);
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(
        "buzz.channels/channels",
      );
      expect(document.getElementById("main-content")).toHaveFocus();
      return;
    }
    expect(messages).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel", { name: "Messages" });
    expect(panel).toHaveAttribute("id", messages.getAttribute("aria-controls"));
    expect(panel).toHaveAttribute("aria-labelledby", messages.id);
    expect(panel).toHaveTextContent("Child content");
    await userEvent.click(messages);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("buzz.channels/channels", {
      focus: "preserve",
    });
    expect(messages).toHaveFocus();
    onSelect.mockClear();
    rerender(shell("buzz.channels/channels"));
    await userEvent.click(messages);
    expect(onSelect).not.toHaveBeenCalled();
    rerender(shell("example/top"));
    expect(within(nav).getByRole("tab", { name: "Top" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    rerender(shell("example/tool"));
    expect(
      within(nav).queryByRole("tab", { selected: true }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tool" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    rerender(shell("buzz.me/me"));
    expect(within(nav).getByRole("tab", { name: "Me" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    rerender(shell("settings"));
    expect(
      within(nav).queryByRole("tab", { selected: true }),
    ).not.toBeInTheDocument();
    rerender(
      shell(
        "buzz.inbox/inbox",
        entries.filter((entry) => entry.key !== "buzz.inbox/inbox"),
      ),
    );
    expect(
      within(nav).queryByRole("tab", { selected: true }),
    ).not.toBeInTheDocument();
  },
);
