// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { Agents } from "../../features/agents/service";
import { channelTemplates } from "../../features/channel-templates/local";
import { CreateChannelDialog } from "./CreateChannelDialog";

let store = createRelaySession(null);
const setupProps = () => ({
  session: store.session,
  destinations: [],
  initialGroup: "",
  groupsReady: true,
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  store.dispose();
  store = createRelaySession(null);
});

it("shows description immediately with Name focused and creates an ongoing open channel", async () => {
  const user = userEvent.setup();
  const onCreate = vi.fn(async () => {});
  const onOpenChange = vi.fn();
  render(
    <CreateChannelDialog
      {...setupProps()}
      open
      onOpenChange={onOpenChange}
      onCreate={onCreate}
    />,
  );
  expect(
    screen.getByRole("dialog", { name: "Create a channel" }),
  ).not.toHaveAccessibleDescription();
  expect(screen.getByRole("textbox", { name: "Description" })).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue("");
  expect(
    screen.queryByRole("button", { name: "Add a description" }),
  ).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus(),
  );
  expect(screen.queryByText("Optional")).not.toBeInTheDocument();
  expect(screen.getByText("Duration")).toHaveClass("sr-only");
  expect(screen.getByRole("radiogroup", { name: "Duration" })).toBeVisible();
  expect(screen.getByRole("radio", { name: /Ongoing/ })).toBeChecked();
  const privateSwitch = screen.getByRole("switch", { name: "Private" });
  const privateLabel = screen.getByText("Private", { selector: "label" });
  expect(privateSwitch).not.toBeChecked();
  expect(
    privateSwitch.compareDocumentPosition(privateLabel) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Cancel" }),
  ).not.toBeInTheDocument();
  await user.type(screen.getByRole("textbox", { name: "Name" }), "  launch  ");
  await user.tab();
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveFocus();
  await user.type(
    screen.getByRole("textbox", { name: "Description" }),
    "  Release planning  ",
  );
  await user.click(screen.getByRole("button", { name: "Create channel" }));
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith({
      name: "launch",
      description: "Release planning",
      visibility: "open",
    }),
  );
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("creates a private temporary channel and reports a rejected request", async () => {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  const onCreate = vi.fn(async () => {
    throw new Error("Creation rejected");
  });
  render(
    <CreateChannelDialog
      {...setupProps()}
      open
      onOpenChange={onOpenChange}
      onCreate={onCreate}
    />,
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "ops");
  await user.click(screen.getByRole("radio", { name: /Temporary/ }));
  await user.click(screen.getByText("Private", { selector: "label" }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Create channel" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Creation rejected",
  );
  expect(onCreate).toHaveBeenCalledWith({
    name: "ops",
    visibility: "private",
    ttlSeconds: 604800,
  });
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(screen.getByRole("radio", { name: /Temporary/ })).toBeChecked();
  expect(screen.getByRole("switch", { name: "Private" })).toBeChecked();
});

it("keeps the visible draft when a pending creation fails", async () => {
  const user = userEvent.setup();
  let rejectCreation!: (reason: Error) => void;
  const onCreate = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectCreation = reject;
      }),
  );
  const onOpenChange = vi.fn();
  const dialog = (pending?: {
    name: string;
    description: string;
    visibility: "private";
    ttlSeconds: number;
  }) => (
    <CreateChannelDialog
      {...setupProps()}
      open
      pending={pending}
      onOpenChange={onOpenChange}
      onCreate={onCreate}
    />
  );
  const view = render(dialog());
  await user.type(screen.getByRole("textbox", { name: "Name" }), "ops");
  await user.type(
    screen.getByRole("textbox", { name: "Description" }),
    "Incident response",
  );
  await user.click(screen.getByRole("radio", { name: /Temporary/ }));
  await user.click(screen.getByText("Private", { selector: "label" }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Create channel" }));
  await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());

  view.rerender(
    dialog({
      name: "ops",
      description: "Incident response",
      visibility: "private",
      ttlSeconds: 604800,
    }),
  );
  view.rerender(dialog());
  rejectCreation(new Error("Creation rejected"));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Creation rejected",
  );
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("ops");
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
    "Incident response",
  );
  expect(screen.getByRole("radio", { name: /Temporary/ })).toBeChecked();
  expect(screen.getByRole("switch", { name: "Private" })).toBeChecked();
});

it("blocks edits during creation without applying disabled control styles", async () => {
  const user = userEvent.setup();
  let finishCreation!: () => void;
  const onCreate = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishCreation = resolve;
      }),
  );
  const onOpenChange = vi.fn();
  render(
    <CreateChannelDialog
      {...setupProps()}
      open
      onOpenChange={onOpenChange}
      onCreate={onCreate}
    />,
  );
  const name = screen.getByRole("textbox", { name: "Name" });
  const privateSwitch = screen.getByRole("switch", { name: "Private" });
  await user.type(name, "launch");
  await user.click(screen.getByRole("button", { name: "Create channel" }));
  const form = document.getElementById("create-channel-form");
  await waitFor(() => expect(form).toHaveAttribute("inert"));
  expect(form).toHaveAttribute("aria-busy", "true");
  expect(name).not.toBeDisabled();
  expect(privateSwitch).not.toBeDisabled();
  expect(privateSwitch).toHaveAttribute("aria-disabled", "true");
  await user.click(privateSwitch);
  expect(privateSwitch).not.toBeChecked();
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Create a channel");
  try {
    await user.keyboard("{Escape}");
    await user.click(
      document.querySelector(".buzz-dialog-backdrop") as Element,
    );
    expect(
      screen.getByRole("button", { name: "Close channel creation" }),
    ).toBeDisabled();
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Create a channel");
    expect(onOpenChange).not.toHaveBeenCalled();
  } finally {
    finishCreation();
  }
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
});

it("restores an unconfirmed channel draft after closing and reopening", () => {
  const pending = {
    name: "release-notes",
    description: "Updates for the team",
    visibility: "private" as const,
    ttlSeconds: 604800,
  };
  const onOpenChange = vi.fn();
  const onCreate = vi.fn(async () => {});
  const { rerender } = render(
    <CreateChannelDialog
      {...setupProps()}
      open
      pending={pending}
      onOpenChange={onOpenChange}
      onCreate={onCreate}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
    "release-notes",
  );
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
    "Updates for the team",
  );
  expect(screen.getByRole("radio", { name: /Temporary/ })).toBeChecked();
  expect(screen.getByRole("switch", { name: "Private" })).toBeChecked();

  rerender(
    <CreateChannelDialog
      {...setupProps()}
      open={false}
      pending={pending}
      onOpenChange={onOpenChange}
      onCreate={onCreate}
    />,
  );
  rerender(
    <CreateChannelDialog
      {...setupProps()}
      open
      pending={pending}
      onOpenChange={onOpenChange}
      onCreate={onCreate}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
    "release-notes",
  );
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
    "Updates for the team",
  );
});

it("resumes frozen setup with the plugin off and unavailable catalogs without recalculating it", async () => {
  const user = userEvent.setup();
  const pending = {
    name: "Recovery",
    visibility: "private" as const,
    setup: {
      agents: ["ab".repeat(32)],
      canvas: "# Frozen plan",
      groupId: "removed-group",
      templateId: "unavailable",
    },
  };
  const onCreate = vi.fn(async () => {});
  render(
    <CreateChannelDialog
      {...setupProps()}
      groupsReady={false}
      open
      pending={pending}
      onOpenChange={() => {}}
      onCreate={onCreate}
    />,
  );
  expect(
    screen.getByRole("region", { name: "Channel setup summary" }),
  ).toHaveTextContent("1 selected agent.");
  expect(document.body.textContent).not.toContain("ab".repeat(32));
  expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
  expect(
    screen.queryByRole("button", {
      name: "Review / customize teams, agents & Canvas",
    }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Retry channel" }));
  await waitFor(() => expect(onCreate).toHaveBeenCalledWith(pending));
});

it.each([
  ["\u0085# \u0085#Release\u0085", "Release"],
  ["\ufeffRelease\ufeff", "\ufeffRelease\ufeff"],
])(
  "passes the relay-canonical name for %j to creation",
  async (value, expected) => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {});
    render(
      <CreateChannelDialog
        {...setupProps()}
        open
        onOpenChange={() => {}}
        onCreate={onCreate}
      />,
    );
    const name = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "### " } });
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription(/Enter a channel name/);
    expect(
      screen.getByRole("button", { name: "Create channel" }),
    ).toBeDisabled();
    fireEvent.change(name, { target: { value } });
    await user.click(screen.getByRole("button", { name: "Create channel" }));
    expect(onCreate).toHaveBeenCalledWith({
      name: expected,
      visibility: "open",
    });
  },
);
it("uses connected description validation without confusing the reserved marker with length", async () => {
  const user = userEvent.setup();
  render(
    <CreateChannelDialog
      {...setupProps()}
      open
      onOpenChange={() => {}}
      onCreate={async () => {}}
    />,
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "notes");
  const description = screen.getByRole("textbox", { name: "Description" });
  fireEvent.change(description, {
    target: { value: "Buzz session (reserved)" },
  });
  expect(description).toHaveAccessibleDescription(
    /that text is used by Buzz for work sessions/,
  );
  expect(screen.getByRole("button", { name: "Create channel" })).toBeDisabled();
  fireEvent.change(description, { target: { value: "x".repeat(1001) } });
  expect(description).toHaveValue("x".repeat(1000));
  expect(description).toHaveAccessibleDescription("1,000 of 1,000 characters");
  expect(screen.getByRole("button", { name: "Create channel" })).toBeEnabled();
});

it("steps the temporary duration, preserves it across Ongoing, and submits only on Create", async () => {
  const user = userEvent.setup();
  const onCreate = vi.fn(async () => {});
  render(
    <CreateChannelDialog
      {...setupProps()}
      open
      onOpenChange={() => {}}
      onCreate={onCreate}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Increase duration" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("radio", { name: "Temporary" }),
  ).toHaveAccessibleDescription("Cleans up without activity.");
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Short lived");
  await user.click(screen.getByRole("radio", { name: "Temporary" }));
  await waitFor(() =>
    expect(
      screen.getByText("after 7 days", { selector: "strong" }),
    ).toBeVisible(),
  );
  const shorter = screen.getByRole("button", { name: "Decrease duration" });
  const longer = screen.getByRole("button", { name: "Increase duration" });
  await user.click(shorter);
  await waitFor(() =>
    expect(
      screen.getByText("after 1 day", { selector: "strong" }),
    ).toBeVisible(),
  );
  expect(shorter).toBeDisabled();
  await user.click(longer);
  await waitFor(() =>
    expect(
      screen.getByText("after 7 days", { selector: "strong" }),
    ).toBeVisible(),
  );
  await user.click(longer);
  await waitFor(() =>
    expect(
      screen.getByText("after 2 weeks", { selector: "strong" }),
    ).toBeVisible(),
  );
  expect(longer).toBeDisabled();
  await user.click(shorter);
  await waitFor(() =>
    expect(
      screen.getByText("after 7 days", { selector: "strong" }),
    ).toBeVisible(),
  );
  await user.click(shorter);
  await user.click(screen.getByRole("radio", { name: "Ongoing" }));
  expect(
    screen.queryByRole("button", { name: "Increase duration" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("radio", { name: "Temporary" }));
  await waitFor(() =>
    expect(
      screen.getByText("after 1 day", { selector: "strong" }),
    ).toBeVisible(),
  );
  expect(onCreate).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Create channel" }));
  expect(onCreate).toHaveBeenCalledExactlyOnceWith({
    name: "Short lived",
    visibility: "open",
    ttlSeconds: 86400,
  });
});

it("shows the exact frozen custom duration without allowing adjustment or changing retry", async () => {
  const user = userEvent.setup();
  const pending = {
    name: "Recovery",
    visibility: "open" as const,
    ttlSeconds: 3600,
  };
  const onCreate = vi.fn(async () => {});
  render(
    <CreateChannelDialog
      {...setupProps()}
      open
      pending={pending}
      onOpenChange={() => {}}
      onCreate={onCreate}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByText("after 1 hour", { selector: "strong" }),
    ).toBeVisible(),
  );
  const longer = screen.getByRole("button", { name: "Increase duration" });
  expect(longer).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Decrease duration" }),
  ).toBeDisabled();
  await user.click(longer);
  await user.click(screen.getByRole("button", { name: "Retry channel" }));
  expect(onCreate).toHaveBeenCalledExactlyOnceWith(pending);
});

it("confirms both privacy directions in the same modal and preserves the entire creation draft", async () => {
  const user = userEvent.setup();
  const onCreate = vi.fn(async () => {});
  const onOpenChange = vi.fn();
  render(
    <CreateChannelDialog
      {...setupProps()}
      open
      onOpenChange={onOpenChange}
      onCreate={onCreate}
    />,
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Draft");
  await user.type(
    screen.getByRole("textbox", { name: "Description" }),
    "Keep this",
  );
  await user.click(screen.getByRole("radio", { name: "Temporary" }));
  await user.click(screen.getByRole("button", { name: "Increase duration" }));
  const dialog = screen.getByRole("dialog");
  for (const initialPrivate of [false, true]) {
    for (const dismissal of ["Cancel", "Escape", "Close"]) {
      await user.click(screen.getByText("Private", { selector: "label" }));
      expect(screen.getByRole("dialog")).toBe(dialog);
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(dialog).toHaveAccessibleName(
        initialPrivate ? "Make channel public?" : "Make channel private?",
      );
      const consequence = initialPrivate
        ? "Everyone in this community will be able to view this channel’s full history."
        : "Only channel members will have access.";
      expect(dialog).toHaveAccessibleDescription(consequence);
      await waitFor(() => expect(screen.getByText(consequence)).toBeVisible());
      expect(
        screen.getByText(consequence).closest(".buzz-dialog-body"),
      ).toHaveAttribute("data-footer-gap", "compact");
      expect(
        screen.queryByText(/This choice takes effect/),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
      const remember = screen.getByRole("checkbox", {
        name: "Don’t show me this again",
      });
      expect(remember).not.toBeChecked();
      await user.click(remember);
      expect(
        screen.queryByRole("textbox", { name: "Name" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Create channel" }),
      ).not.toBeInTheDocument();
      if (dismissal === "Escape") await user.keyboard("{Escape}");
      else
        await user.click(
          screen.getByRole("button", {
            name: dismissal === "Close" ? "Back to channel creation" : "Cancel",
          }),
        );
      expect(dialog).toHaveAccessibleName("Create a channel");
      expect(screen.getByRole("switch", { name: "Private" })).toHaveFocus();
      expect(screen.getByRole("switch", { name: "Private" })).toHaveAttribute(
        "aria-checked",
        String(initialPrivate),
      );
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
        "Draft",
      );
      expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
        "Keep this",
      );
      expect(
        screen.getByRole("radio", { name: "Temporary" }),
      ).toHaveAccessibleDescription(
        "Cleans up after 2 weeks without activity.",
      );
      expect(onOpenChange).not.toHaveBeenCalled();
    }
    await user.click(screen.getByRole("switch", { name: "Private" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("switch", { name: "Private" })).toHaveFocus();
    expect(screen.getByRole("switch", { name: "Private" })).toHaveAttribute(
      "aria-checked",
      String(!initialPrivate),
    );
    expect(onCreate).not.toHaveBeenCalled();
  }
  await user.click(screen.getByRole("button", { name: "Create channel" }));
  expect(onCreate).toHaveBeenCalledExactlyOnceWith({
    name: "Draft",
    description: "Keep this",
    visibility: "open",
    ttlSeconds: 1209600,
  });
});

it("drops confirmation when frozen recovery arrives and retries only its original request", async () => {
  const user = userEvent.setup();
  const onCreate = vi.fn(async () => {});
  const pending = {
    name: "Frozen",
    visibility: "open" as const,
    ttlSeconds: 3600,
  };
  const props = {
    ...setupProps(),
    open: true,
    onOpenChange: vi.fn(),
    onCreate,
  };
  const view = render(<CreateChannelDialog {...props} />);
  await user.click(screen.getByRole("switch", { name: "Private" }));
  view.rerender(<CreateChannelDialog {...props} pending={pending} />);
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Create a channel");
  const privacy = screen.getByRole("switch", { name: "Private" });
  expect(privacy).toHaveAttribute("aria-disabled", "true");
  await user.click(privacy);
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Create a channel");
  expect(privacy).not.toBeChecked();
  await user.click(screen.getByRole("button", { name: "Retry channel" }));
  expect(onCreate).toHaveBeenCalledExactlyOnceWith(pending);
});

it("discards the unsaved privacy step and draft when creation closes and reopens", async () => {
  const user = userEvent.setup();
  const props = {
    ...setupProps(),
    open: true,
    onOpenChange: vi.fn(),
    onCreate: vi.fn(async () => {}),
  };
  const view = render(<CreateChannelDialog {...props} />);
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Draft");
  await user.click(screen.getByRole("switch", { name: "Private" }));
  view.rerender(<CreateChannelDialog {...props} open={false} />);
  view.rerender(<CreateChannelDialog {...props} />);
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Create a channel");
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
  expect(screen.getByRole("switch", { name: "Private" })).not.toBeChecked();
  expect(props.onCreate).not.toHaveBeenCalled();
});

it.each(["work", ""])(
  "derives the title and fixed destination from the opening group %j",
  async (initialGroup) => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {});
    render(
      <CreateChannelDialog
        {...setupProps()}
        open
        onOpenChange={() => {}}
        onCreate={onCreate}
        initialGroup={initialGroup}
        destinations={[{ id: "work", name: "Work", icon: "📚" }]}
      />,
    );
    const title = initialGroup
      ? "Create a channel in Work"
      : "Create a channel";
    expect(screen.getByRole("dialog")).toHaveAccessibleName(title);
    expect(
      screen.queryByRole("combobox", { name: "Destination group" }),
    ).not.toBeInTheDocument();
    if (initialGroup)
      expect(
        screen
          .getByRole("dialog")
          .querySelector(".buzz-dialog-step [data-sidebar-group-icon]"),
      ).toHaveTextContent("📚");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Notes");
    await user.click(screen.getByRole("switch", { name: "Private" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName(title);
    await user.click(screen.getByRole("button", { name: "Create channel" }));
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      name: "Notes",
      visibility: "private",
      ...(initialGroup
        ? {
            setup: {
              agents: [],
              canvas: "",
              templateId: "",
              groupId: initialGroup,
            },
          }
        : {}),
    });
  },
);

it.each([true, false])(
  "does not silently change a missing or loading opening group (ready: %s)",
  async (groupsReady) => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {});
    const props = {
      ...setupProps(),
      open: true,
      onOpenChange: vi.fn(),
      onCreate,
      initialGroup: "work",
      groupsReady,
    };
    const view = render(<CreateChannelDialog {...props} destinations={[]} />);
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Notes");
    await user.click(screen.getByRole("button", { name: "Create channel" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      groupsReady
        ? "This group is no longer available. Close this dialog and create from another sidebar group or Channels."
        : "Wait for saved sidebar groups to load, then try again.",
    );
    expect(onCreate).not.toHaveBeenCalled();
    view.rerender(
      <CreateChannelDialog
        {...props}
        groupsReady
        destinations={[{ id: "work", name: "Work" }]}
      />,
    );
    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      "Create a channel in Work",
    );
    await user.click(screen.getByRole("button", { name: "Create channel" }));
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        setup: expect.objectContaining({ groupId: "work" }),
      }),
    );
  },
);

it("does not relabel an ungrouped frozen retry with the group used to reopen it", async () => {
  const user = userEvent.setup();
  const onCreate = vi.fn(async () => {});
  const pending = { name: "Frozen", visibility: "open" as const };
  render(
    <CreateChannelDialog
      {...setupProps()}
      open
      onOpenChange={() => {}}
      onCreate={onCreate}
      pending={pending}
      initialGroup="work"
      destinations={[{ id: "work", name: "Work" }]}
    />,
  );
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Create a channel");
  await user.click(screen.getByRole("button", { name: "Retry channel" }));
  expect(onCreate).toHaveBeenCalledExactlyOnceWith(pending);
});

it.each(["backdrop", "Escape", "Close"])(
  "guards dirty Create dismissal via %s and only discards explicitly",
  async (dismissal) => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onCreate = vi.fn(async () => {});
    render(
      <CreateChannelDialog
        {...setupProps()}
        open
        onOpenChange={onOpenChange}
        onCreate={onCreate}
      />,
    );
    const dismiss = async () => {
      if (dismissal === "backdrop")
        await user.click(
          document.querySelector(".buzz-dialog-backdrop") as Element,
        );
      else if (dismissal === "Escape") await user.keyboard("{Escape}");
      else
        await user.click(
          screen.getByRole("button", { name: "Close channel creation" }),
        );
    };
    await dismiss();
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    onOpenChange.mockClear();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Draft");
    const dialog = screen.getByRole("dialog");
    for (const back of ["Keep editing", "Escape", "backdrop", "Close"]) {
      await dismiss();
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(screen.getAllByRole("dialog")).toEqual([dialog]);
      expect(dialog).toHaveAccessibleName("Discard changes?");
      expect(
        screen.getByRole("button", { name: "Keep editing" }),
      ).toHaveFocus();
      if (back === "Escape") await user.keyboard("{Escape}");
      else if (back === "backdrop")
        await user.click(
          document.querySelector(".buzz-dialog-backdrop") as Element,
        );
      else
        await user.click(
          screen.getByRole("button", {
            name: back === "Close" ? "Back to channel creation" : back,
          }),
        );
      expect(dialog).toHaveAccessibleName("Create a channel");
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
        "Draft",
      );
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
      expect(onOpenChange).not.toHaveBeenCalled();
    }
    await dismiss();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(onCreate).not.toHaveBeenCalled();
  },
);

it.each(["Name", "Description", "Private", "Temporary"])(
  "protects Create edits to %s and closes a reverted draft without confirmation",
  async (field) => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <CreateChannelDialog
        {...setupProps()}
        open
        onOpenChange={onOpenChange}
        onCreate={async () => {}}
      />,
    );
    if (field === "Name" || field === "Description")
      await user.type(screen.getByRole("textbox", { name: field }), "draft");
    else if (field === "Temporary")
      await user.click(screen.getByRole("radio", { name: field }));
    else {
      await user.click(screen.getByRole("switch", { name: "Private" }));
      await user.click(screen.getByRole("button", { name: "Continue" }));
    }
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Discard changes?");
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    if (field === "Name" || field === "Description")
      await user.clear(screen.getByRole("textbox", { name: field }));
    else if (field === "Temporary")
      await user.click(screen.getByRole("radio", { name: "Ongoing" }));
    else {
      await user.click(screen.getByRole("switch", { name: "Private" }));
      await user.click(screen.getByRole("button", { name: "Continue" }));
    }
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  },
);

it("does not offer to discard frozen recovery when it arrives during confirmation", async () => {
  const user = userEvent.setup();
  const props = {
    ...setupProps(),
    open: true,
    onOpenChange: vi.fn(),
    onCreate: vi.fn(async () => {}),
  };
  const view = render(<CreateChannelDialog {...props} />);
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Draft");
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Discard changes?");
  const pending = { name: "Frozen", visibility: "open" as const };
  view.rerender(<CreateChannelDialog {...props} pending={pending} />);
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Create a channel");
  await user.click(document.querySelector(".buzz-dialog-backdrop") as Element);
  expect(props.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  expect(props.onCreate).not.toHaveBeenCalled();
});

it("starts a channel from a template with its agents and teams' agents here and its Canvas", async () => {
  const user = userEvent.setup();
  const [ada, bo, elsewhere] = ["a", "b", "c"].map((c) => c.repeat(64)) as [
    string,
    string,
    string,
  ];
  const snapshot = {
    status: "ready",
    running: [],
    // Agents in this community; `elsewhere` is in another one.
    agents: [
      { pubkey: ada, name: "Ada" },
      { pubkey: bo, name: "Bo" },
    ],
    teams: [
      { id: "t1", name: "Core", instructions: "", members: [ada, elsewhere] },
      { id: "t2", name: "Docs", instructions: "", members: [bo, ada] },
    ],
  };
  const agents = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as Agents;
  channelTemplates.save({
    name: "Launch",
    teams: ["t1", "t2", "gone"],
    agents: [elsewhere, bo],
    canvas: "# Goal",
  });
  const onCreate = vi.fn(async () => {});
  render(
    <CreateChannelDialog
      {...setupProps()}
      agents={agents}
      open
      onOpenChange={() => {}}
      onCreate={onCreate}
    />,
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "launch");
  await user.click(screen.getByRole("combobox", { name: "Template" }));
  await user.click(await screen.findByRole("option", { name: "Launch" }));
  expect(screen.getByText("Adds Bo, Ada · Starts the Canvas")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Create channel" }));
  const [template] = channelTemplates.snapshot();
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith({
      name: "launch",
      visibility: "open",
      setup: {
        agents: [bo, ada],
        canvas: "# Goal",
        groupId: "",
        templateId: template?.id,
      },
    }),
  );
});

it("offers no template choice without saved templates", () => {
  render(
    <CreateChannelDialog
      {...setupProps()}
      open
      onOpenChange={() => {}}
      onCreate={async () => {}}
    />,
  );
  expect(
    screen.queryByRole("combobox", { name: "Template" }),
  ).not.toBeInTheDocument();
});

it("creates a plain channel from a template that adds nothing here", async () => {
  const user = userEvent.setup();
  channelTemplates.save({
    name: "Empty",
    teams: ["gone"],
    agents: [],
    canvas: "  ",
  });
  const onCreate = vi.fn(async () => {});
  render(
    <CreateChannelDialog
      {...setupProps()}
      open
      onOpenChange={() => {}}
      onCreate={onCreate}
    />,
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "plain");
  await user.click(screen.getByRole("combobox", { name: "Template" }));
  await user.click(await screen.findByRole("option", { name: "Empty" }));
  expect(
    screen.getByText(
      "None of its agents are in this community, and it has no Canvas.",
    ),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Create channel" }));
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith({
      name: "plain",
      visibility: "open",
    }),
  );
});
