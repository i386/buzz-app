// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarSection } from "./SidebarSection";

afterEach(cleanup);
function Section({
  sort,
}: {
  sort?: {
    value: "alpha" | "recent";
    change: (value: "alpha" | "recent") => void;
  };
} = {}) {
  const [open, setOpen] = useState(true);
  const [revision, setRevision] = useState(0);
  return (
    <>
      <SidebarSection
        sectionKey="channels"
        title="Channels"
        open={open}
        onToggle={setOpen}
        newMessage={() => {}}
        sort={sort}
      >
        <button type="button">General</button>
      </SidebarSection>
      <button type="button" onClick={() => setRevision(revision + 1)}>
        Update {revision}
      </button>
    </>
  );
}
it("keeps section actions independent of disclosure and supports menu keyboard dismissal", async () => {
  const user = userEvent.setup();
  render(<Section />);
  expect(screen.getByRole("button", { name: "General" })).toBeVisible();
  const trigger = screen.getByRole("button", {
    name: "More actions for Channels",
  });
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Collapse section" }),
  );
  expect(
    screen.getByLabelText("Channels").closest("details"),
  ).not.toHaveAttribute("open");
  await user.click(trigger);
  await waitFor(() => expect(screen.getByRole("menu")).toHaveFocus());
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
  expect(trigger).toHaveFocus();
  await user.click(screen.getByLabelText("Channels"));
  expect(screen.getByRole("button", { name: "General" })).toBeVisible();
});
it("keeps one controlled actions menu, closes it after sorting, and restores trigger focus", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(<Section sort={{ value: "alpha", change }} />);
  const trigger = screen.getByRole("button", {
    name: "More actions for Channels",
  });
  expect(screen.queryByRole("button", { name: "Sort Channels" })).toBeNull();
  await user.click(trigger);
  const actions = await screen.findByRole("menu", {
    name: "More actions for Channels",
  });
  expect(actions).toHaveTextContent("Sort");
  expect(actions).toHaveTextContent("Collapse section");
  await user.keyboard("{ArrowDown}{ArrowRight}");
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Recent" }),
  );
  expect(change).toHaveBeenCalledWith("recent");
  await waitFor(() => expect(actions).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
});

it("orders header actions before section rows for keyboard navigation", async () => {
  const user = userEvent.setup();
  render(<Section />);
  const summary = screen.getByLabelText("Channels");
  summary.focus();
  await user.tab();
  expect(
    screen.getByRole("button", { name: "More actions for Channels" }),
  ).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "New message" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "General" })).toHaveFocus();
});
it("retains an expansion requested by an offscreen unread cue on subsequent renders", async () => {
  const user = userEvent.setup();
  render(<Section />);
  const summary = screen.getByLabelText("Channels");
  await user.click(summary);
  const details = summary.closest("details");
  if (!details) throw new Error("Missing section disclosure");
  fireEvent.click(summary);
  await user.click(screen.getByRole("button", { name: "Update 0" }));
  expect(details).toHaveAttribute("open");
  expect(screen.getByRole("button", { name: "General" })).toBeVisible();
});

it("offers confirmed removal for custom sections", async () => {
  const user = userEvent.setup();
  const remove = vi.fn();
  render(
    <SidebarSection
      sectionKey="group:work"
      title="Work"
      open
      onToggle={() => {}}
      onRemove={remove}
      channelCount={1}
    >
      <button type="button">General</button>
    </SidebarSection>,
  );
  await user.click(
    screen.getByRole("button", { name: "More actions for Work" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Remove section" }),
  );
  const confirmation = screen.getByRole("dialog", { name: "Remove Work?" });
  expect(confirmation).toHaveAccessibleDescription(
    "1 channel will move back to Channels. This does not delete any channels.",
  );
  expect(remove).not.toHaveBeenCalled();
  await user.click(
    within(confirmation).getByRole("button", { name: "Cancel" }),
  );
  expect(remove).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "More actions for Work" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Remove section" }),
  );
  await user.click(
    within(screen.getByRole("dialog", { name: "Remove Work?" })).getByRole(
      "button",
      { name: "Remove section" },
    ),
  );
  expect(remove).toHaveBeenCalledOnce();
});

it("holds confirmation while removing, shows failure, and permits explicit retry", async () => {
  const user = userEvent.setup();
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, no) => {
    reject = no;
  });
  const remove = vi
    .fn()
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce(undefined);
  render(
    <SidebarSection
      sectionKey="group:work"
      title="Work"
      open
      onToggle={() => {}}
      onRemove={remove}
    >
      <button type="button">General</button>
    </SidebarSection>,
  );
  await user.click(
    screen.getByRole("button", { name: "More actions for Work" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Remove section" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Remove Work?" });
  try {
    await user.click(
      within(dialog).getByRole("button", { name: "Remove section" }),
    );
    await waitFor(() => expect(remove).toHaveBeenCalledOnce());
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "waiting for confirmation",
    );
    await user.keyboard("{Escape}");
    expect(dialog).toBeVisible();
  } finally {
    reject(new Error("Publication not confirmed"));
  }
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Publication not confirmed",
  );
  // The modal deliberately makes the retained sidebar aria-hidden.
  expect(screen.getByText("General", { exact: true })).toBeVisible();
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
  await user.click(
    within(dialog).getByRole("button", { name: "Remove section" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(remove).toHaveBeenCalledTimes(2);
});
it.each(["Cancel", "Escape"])(
  "restores section focus after failure then %s",
  async (dismiss) => {
    const user = userEvent.setup();
    const remove = vi
      .fn()
      .mockRejectedValue(new Error("Publication not confirmed"));
    render(
      <SidebarSection
        sectionKey="group:work"
        title="Work"
        open
        onToggle={() => {}}
        onRemove={remove}
      >
        <button type="button">General</button>
      </SidebarSection>,
    );
    const trigger = screen.getByRole("button", {
      name: "More actions for Work",
    });
    await user.click(trigger);
    await user.click(
      await screen.findByRole("menuitem", { name: "Remove section" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Remove Work?" });
    await user.click(
      within(dialog).getByRole("button", { name: "Remove section" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Publication not confirmed",
    );
    if (dismiss === "Cancel")
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    else await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(remove).toHaveBeenCalledOnce();
  },
);

it("never offers removal for built-in sections even when a callback is supplied", async () => {
  const user = userEvent.setup();
  const remove = vi.fn();
  render(
    <SidebarSection
      sectionKey="channels"
      title="Channels"
      open
      onToggle={() => {}}
      onRemove={remove}
    >
      <button type="button">General</button>
    </SidebarSection>,
  );
  await user.click(
    screen.getByRole("button", { name: "More actions for Channels" }),
  );
  await screen.findByRole("menuitem", { name: "Collapse section" });
  expect(screen.queryByRole("menuitem", { name: "Remove section" })).toBeNull();
  expect(remove).not.toHaveBeenCalled();
});

it.each([0, 2])(
  "describes %s channels in removal confirmation",
  async (count) => {
    const user = userEvent.setup();
    render(
      <SidebarSection
        sectionKey="group:work"
        title="Work"
        open
        onToggle={() => {}}
        onRemove={() => {}}
        channelCount={count}
      >
        <span>Rows</span>
      </SidebarSection>,
    );
    await user.click(
      screen.getByRole("button", { name: "More actions for Work" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Remove section" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Remove Work?" }),
    ).toHaveAccessibleDescription(
      `${count} channels will move back to Channels. This does not delete any channels.`,
    );
  },
);
