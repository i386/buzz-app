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
import { afterEach, expect, it, vi } from "vitest";
import { formatFullTimestamp } from "../../shared/datetime";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { createAgentMemories, type MemoryListing } from "./memory";
import { MemoryPanel } from "./MemoryPanel";
import type { Agent } from "./service";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const pubkey = "a".repeat(64);
const agent = { pubkey, name: "Ada" } as Agent;
const entry = (slug: string, body: string, createdAt = 1_700_000_000) => ({
  slug,
  body,
  eventId: "b".repeat(64),
  createdAt,
});

function setup(read: () => Promise<MemoryListing>) {
  const owner = createAgentMemories(vi.fn(read), "c".repeat(64), () => true);
  return {
    owner,
    memories: owner.capability,
    ...render(<MemoryPanel agent={agent} memories={owner.capability} />, {
      wrapper: ToastProvider,
    }),
  };
}

it("shows core first, then other memories in Markdown accordions", async () => {
  const user = userEvent.setup();
  setup(async () => ({
    entries: [
      entry("mem/notes", "Cold detail."),
      entry("core", "I am **Ada**.\n\nKeep it short."),
    ],
    partial: false,
  }));
  const intro = screen.getByText(
    "These memories help this agent maintain context. Core memories are always available; other memories are recalled as needed. Only the agent can update them.",
  );
  expect(intro.querySelector("code")).toBeNull();
  const core = await screen.findByRole("region", { name: "Core memories" });
  expect(
    within(core).getByRole("button", { name: "Refresh" }),
  ).toBeInTheDocument();
  const coreTrigger = within(core).getByRole("button", { name: "core" });
  expect(coreTrigger).toHaveAttribute("aria-expanded", "false");
  await user.click(within(core).getByText("core"));
  expect(coreTrigger).toHaveAttribute("aria-expanded", "true");
  expect(within(core).getByText("Ada").tagName).toBe("STRONG");
  const references = screen.getByRole("region", {
    name: "Memories",
  });
  expect(
    within(references).getByRole("button", { name: "mem/notes" }),
  ).toBeInTheDocument();
  expect(
    within(references).queryByTitle(formatFullTimestamp(1_700_000_000)),
  ).not.toBeInTheDocument();
  expect(within(references).getByText("Cold detail.")).toBeInTheDocument();
  expect(within(references).queryByText("core")).not.toBeInTheDocument();
});

it("shows a spinner while memories load", async () => {
  setup(() => new Promise<MemoryListing>(() => {}));
  const loading = await screen.findByRole("status", {
    name: "Loading memories",
  });
  expect(loading.querySelector("svg")).toHaveClass("motion-safe:animate-spin");
  expect(screen.queryByText("Loading memory…")).not.toBeInTheDocument();
});

it("sorts memories alphabetically or chronologically", async () => {
  const user = userEvent.setup();
  setup(async () => ({
    entries: [
      entry("core", "Core.", 400),
      entry("mem/alpha", "First.", 100),
      entry("mem/zulu", "Last.", 300),
      entry("mem/middle", "Middle.", 200),
    ],
    partial: false,
  }));
  const references = await screen.findByRole("region", {
    name: "Memories",
  });
  const core = screen.getByRole("region", { name: "Core memories" });
  const titles = () =>
    [
      ...references.querySelectorAll<HTMLButtonElement>(
        "button[aria-controls]",
      ),
    ].map((button) => button.textContent);
  expect(titles()).toEqual([
    expect.stringContaining("mem/alpha"),
    expect.stringContaining("mem/middle"),
    expect.stringContaining("mem/zulu"),
  ]);
  expect(
    within(references).queryByTitle(formatFullTimestamp(300)),
  ).not.toBeInTheDocument();
  expect(
    within(core).queryByTitle(formatFullTimestamp(400)),
  ).not.toBeInTheDocument();

  await user.click(
    within(core).getByRole("button", {
      name: "Organize memories",
    }),
  );
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Chronologically" }),
  );
  expect(titles()).toEqual([
    expect.stringContaining("mem/zulu"),
    expect.stringContaining("mem/middle"),
    expect.stringContaining("mem/alpha"),
  ]);
  expect(
    within(references).getByTitle(formatFullTimestamp(300)),
  ).toBeInTheDocument();
  expect(within(core).getByTitle(formatFullTimestamp(400))).toBeInTheDocument();
});

it("copies a memory from its action or context menu", async () => {
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  setup(async () => ({
    entries: [entry("core", "Complete **Markdown** body.")],
    partial: false,
  }));
  const core = await screen.findByRole("region", { name: "Core memories" });
  const actions = within(core).getByRole("button", {
    name: "Actions for core",
  });

  await user.click(actions);
  await user.click(await screen.findByRole("menuitem", { name: "Copy name" }));
  expect(write).toHaveBeenLastCalledWith("core");
  expect(screen.getByText("Memory name copied.")).toBeVisible();

  await user.click(actions);
  await user.click(
    await screen.findByRole("menuitem", { name: "Copy full body" }),
  );
  expect(write).toHaveBeenLastCalledWith("Complete **Markdown** body.");
  expect(screen.getByText("Memory body copied.")).toBeVisible();

  write.mockRejectedValueOnce(new Error("denied"));
  await user.click(actions);
  await user.click(
    await screen.findByRole("menuitem", { name: "Copy full body" }),
  );
  expect(screen.getByText("Couldn’t copy the memory body.")).toBeVisible();

  fireEvent.contextMenu(within(core).getByRole("button", { name: "core" }));
  expect(
    await screen.findByRole("menuitem", { name: "Copy name" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("menuitem", { name: "Copy ID" }),
  ).not.toBeInTheDocument();
});

it("says when the agent has no memory yet", async () => {
  setup(async () => ({ entries: [], partial: false }));
  expect(await screen.findByText(/No core memory yet/)).toBeInTheDocument();
  expect(screen.getByText("No memories yet.")).toBeInTheDocument();
});

it("shows memories from the first month in weeks", async () => {
  const user = userEvent.setup();
  const now = new Date(2026, 9, 24, 12).getTime() / 1_000;
  vi.spyOn(Date, "now").mockReturnValue(now * 1_000);
  setup(async () => ({
    entries: [entry("core", "Remember.", now - 21 * 24 * 60 * 60)],
    partial: false,
  }));
  const core = await screen.findByRole("region", { name: "Core memories" });
  await user.click(
    within(core).getByRole("button", {
      name: "Organize memories",
    }),
  );
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Chronologically" }),
  );
  expect(await screen.findByText("3 weeks ago")).toBeInTheDocument();
});

it("shows memories from the second month as one month ago", async () => {
  const user = userEvent.setup();
  const now = new Date(2026, 9, 24, 12).getTime() / 1_000;
  vi.spyOn(Date, "now").mockReturnValue(now * 1_000);
  setup(async () => ({
    entries: [entry("core", "Remember.", now - 45 * 24 * 60 * 60)],
    partial: false,
  }));
  const core = await screen.findByRole("region", { name: "Core memories" });
  await user.click(
    within(core).getByRole("button", {
      name: "Organize memories",
    }),
  );
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Chronologically" }),
  );
  expect(await screen.findByText("1 month ago")).toBeInTheDocument();
});

it("reports a failed read and reads again on refresh", async () => {
  const user = userEvent.setup();
  let fail = true;
  setup(async () => {
    if (fail) throw new Error("offline");
    return { entries: [entry("core", "Back.")], partial: false };
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Memory couldn't be read.",
  );
  fail = false;
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText("Back.")).toBeInTheDocument();
});

it("keeps the core-memory actions visible while refreshing", async () => {
  const user = userEvent.setup();
  let reads = 0;
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  setup(async () => {
    reads += 1;
    if (reads > 1) await pending;
    return {
      entries: [
        entry("core", "Remember."),
        entry("mem/alpha", "Alpha."),
        entry("mem/beta", "Beta."),
      ],
      partial: false,
    };
  });
  const core = await screen.findByRole("region", { name: "Core memories" });
  await user.click(within(core).getByRole("button", { name: "Refresh" }));
  expect(reads).toBe(2);
  expect(
    within(core).getByRole("button", { name: "Refresh" }),
  ).toBeInTheDocument();
  expect(
    within(core).getByRole("button", {
      name: "Organize memories",
    }),
  ).toBeInTheDocument();
  expect(within(core).getByRole("button", { name: "Refresh" })).toHaveAttribute(
    "data-refreshing",
    "true",
  );
  expect(
    within(core).getByRole("button", { name: "Refresh" }).querySelector("svg"),
  ).toHaveClass("animate-spin");
  expect(
    core.querySelector("[data-memory-list][data-refreshing='true']"),
  ).toHaveClass("opacity-50");
  release();
});

it("shows nothing to read without a session", () => {
  render(<MemoryPanel agent={agent} memories={undefined} />);
  expect(screen.getByText("Memory isn't available here.")).toBeInTheDocument();
});

it("clears displayed plaintext when its session invalidates the view", async () => {
  const user = userEvent.setup();
  const { owner } = setup(async () => ({
    entries: [entry("core", "I am Ada.")],
    partial: false,
  }));
  await screen.findByText("I am Ada.");
  const trigger = screen.getByRole("button", { name: "core" });
  await user.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");

  owner.clear();

  expect(await screen.findByText("Memory isn't loaded.")).toBeInTheDocument();
  expect(screen.queryByText("I am Ada.")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "core" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Actions for core" }),
  ).not.toBeInTheDocument();
});

it("holds one revocable memory view until the panel unmounts", async () => {
  const { memories, unmount } = setup(async () => ({
    entries: [entry("core", "I am Ada.")],
    partial: false,
  }));
  await screen.findByText("I am Ada.");
  // The panel retains one of the session's four views while it retains text.
  const views = Array.from({ length: 3 }, () => memories.open(pubkey));
  expect(() => memories.open(pubkey)).toThrow("Memory views unavailable");
  for (const view of views) view.dispose();
  unmount();
  expect(() => memories.open(pubkey)).not.toThrow();
});
