// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { Dialog } from "./Dialog";
import { Button } from "./Button";
import { Input } from "./Input";
import { Field } from "./Field";
import { Tooltip } from "./Tooltip";
import { Tabs } from "./Tabs";
import { NavigationItem } from "./NavigationItem";

afterEach(cleanup);

test.each([true, "true"] as const)(
  "expanded button hints dismiss without replacing the trigger (%s)",
  async (expanded) => {
    const user = userEvent.setup();
    const ref = createRef<HTMLButtonElement>();
    const control = (value: boolean | "true") => (
      <>
        <p id="picker-help">Choose a symbol.</p>
        <Button
          ref={ref}
          title="Open symbols"
          aria-label="Symbols"
          aria-describedby="picker-help"
          aria-expanded={value}
        >
          Symbols
        </Button>
      </>
    );
    const view = render(control(false));
    const trigger = screen.getByRole("button", { name: "Symbols" });
    await user.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Open symbols",
    );
    view.rerender(control(expanded));
    await waitFor(() =>
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
    );
    expect(ref.current).toBe(trigger);
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAccessibleName("Symbols");
    expect(trigger).toHaveAttribute("aria-describedby", "picker-help");
    view.rerender(control(false));
    expect(ref.current).toBe(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.hover(trigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Open symbols",
    );
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveAccessibleDescription("Choose a symbol.");
  },
);

test("button titles use the shared hint while preserving refs and activation", async () => {
  const user = userEvent.setup();
  const activate = vi.fn();
  const ref = createRef<HTMLButtonElement>();
  render(
    <Button
      ref={ref}
      title="Send this draft"
      aria-label="Send"
      onClick={activate}
    >
      Send
    </Button>,
  );
  const button = screen.getByRole("button", { name: "Send" });
  expect(ref.current).toBe(button);
  expect(button).not.toHaveAttribute("title");
  await user.hover(button);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Send this draft",
  );
  expect(button).toHaveAccessibleDescription("Send this draft");
  await user.click(button);
  expect(activate).toHaveBeenCalledTimes(1);
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
  );
  expect(button).toHaveAccessibleName("Send");
});

test("pending dialogs reject close and Escape, then allow dismissal once released", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  const content = (pending: boolean) => (
    <Dialog
      open
      onOpenChange={change}
      preventClose={pending}
      title="Edit notes"
    >
      <Field label="Name">
        <Input />
      </Field>
    </Dialog>
  );
  const view = render(content(true));
  expect(screen.getByRole("dialog", { name: "Edit notes" })).toBeVisible();
  expect(screen.getByRole("dialog", { name: "Edit notes" })).toHaveAttribute(
    "aria-modal",
    "true",
  );
  expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  await user.click(screen.getByRole("textbox", { name: "Name" }));
  await user.keyboard("{Escape}");
  expect(change).not.toHaveBeenCalled();
  view.rerender(content(false));
  await user.keyboard("{Escape}");
  expect(change).toHaveBeenCalledWith(false);
});

test("dialog close button closes the controlled frame", async () => {
  const user = userEvent.setup();
  function Example() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Edit notes</Button>
        <Dialog
          open={open}
          onOpenChange={setOpen}
          title="Note details"
          description="Edit this example."
        >
          <Field label="Name">
            <Input />
          </Field>
        </Dialog>
      </>
    );
  }
  render(<Example />);
  await user.click(screen.getByRole("button", { name: "Edit notes" }));
  expect(
    screen.getByRole("dialog", { name: "Note details" }),
  ).toHaveAccessibleDescription("Edit this example.");
  await user.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

test("tabs link each trigger to its visible panel", async () => {
  const user = userEvent.setup();
  function Example() {
    const [value, setValue] = useState("notes");
    return (
      <Tabs
        value={value}
        onValueChange={setValue}
        label="Workspace"
        variant="panel"
        items={[
          { value: "notes", label: "Notes" },
          { value: "activity", label: "Activity" },
        ]}
        renderPanel={(tab) => (
          <p>{tab === "notes" ? "Your notes" : "Recent activity"}</p>
        )}
      />
    );
  }
  render(<Example />);
  const notes = screen.getByRole("tab", { name: "Notes" });
  expect(notes).toHaveAttribute(
    "aria-controls",
    screen.getByRole("tabpanel").id,
  );
  expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Notes");
  await user.click(screen.getByRole("tab", { name: "Activity" }));
  expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Activity");
  expect(screen.getByRole("tabpanel")).toHaveTextContent("Recent activity");
  expect(screen.queryByText("Your notes")).not.toBeInTheDocument();
});

test("navigation keeps warm-read events and data attributes on the focusable button", async () => {
  const user = userEvent.setup();
  const warm = vi.fn();
  const select = vi.fn();
  render(
    <NavigationItem
      label="Notes"
      selected
      data-channel-id="example"
      onPointerEnter={warm}
      onFocus={warm}
      onClick={select}
    />,
  );
  const row = screen.getByRole("button", { name: "Notes" });
  expect(row).toHaveAttribute("data-channel-id", "example");
  expect(row).toHaveAttribute("aria-current", "page");
  await user.hover(row);
  expect(warm).toHaveBeenCalled();
  await user.click(row);
  expect(select).toHaveBeenCalledTimes(1);
});

test("navigation rows keep rich session labels readable and selected", async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  render(
    <NavigationItem
      selected
      label={
        <>
          <small>Release planning</small> <span>Review the proposal</span>{" "}
          <span role="img" aria-label="Unread messages">
            •
          </span>
        </>
      }
      onClick={select}
    />,
  );
  const row = screen.getByRole("button", {
    name: "Release planning Review the proposal Unread messages",
  });
  expect(row).toHaveAttribute("aria-current", "page");
  expect(row).toHaveAttribute("data-buzz-ui");
  await user.click(row);
  expect(select).toHaveBeenCalledTimes(1);
});

test("tooltip adds a dismissible hint without replacing the control name", async () => {
  const user = userEvent.setup();
  render(
    <Tooltip content="Create a new note">
      <Button aria-label="Create note">+</Button>
    </Tooltip>,
  );
  const button = screen.getByRole("button", { name: "Create note" });
  await user.hover(button);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Create a new note",
  );
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
  );
  expect(button).toHaveAccessibleName("Create note");
});

test("tooltip preserves existing descriptions while open and after dismissal", async () => {
  const user = userEvent.setup();
  render(
    <>
      <p id="existing-help">Existing help.</p>
      <p id="additional-help">More context.</p>
      <Tooltip content="Additional hint.">
        <Button aria-describedby="existing-help additional-help">
          Described action
        </Button>
      </Tooltip>
    </>,
  );
  const button = screen.getByRole("button", { name: "Described action" });
  expect(button).toHaveAccessibleDescription("Existing help. More context.");
  await user.tab();
  const tooltip = await screen.findByRole("tooltip");
  expect(button).toHaveAttribute(
    "aria-describedby",
    `existing-help additional-help ${tooltip.id}`,
  );
  expect(button).toHaveAccessibleDescription(
    "Existing help. More context. Additional hint.",
  );
  expect(button).toHaveAccessibleName("Described action");
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
  );
  expect(button).toHaveAttribute(
    "aria-describedby",
    "existing-help additional-help",
  );
  expect(button).toHaveAccessibleDescription("Existing help. More context.");
  expect(button).toHaveAccessibleName("Described action");
});

test("stable dialog height is opt-in and can return to content sizing", () => {
  const renderDialog = (height?: "content" | "stable") => (
    <Dialog
      open
      onOpenChange={() => {}}
      title="Search"
      {...(height ? { height } : {})}
    >
      Results
    </Dialog>
  );
  const { rerender } = render(renderDialog());
  expect(screen.getByRole("dialog")).toHaveAttribute("data-height", "content");
  rerender(renderDialog("stable"));
  expect(screen.getByRole("dialog")).toHaveAttribute("data-height", "stable");
  rerender(renderDialog());
  expect(screen.getByRole("dialog")).toHaveAttribute("data-height", "content");
});

test("dialog composition keeps actions accessible and lets an inner layer consume Escape", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  const interceptEscape = vi
    .fn()
    .mockReturnValueOnce(true)
    .mockReturnValue(false);
  render(
    <Dialog
      open
      title="Editor"
      onOpenChange={change}
      onEscape={interceptEscape}
      headerActions={<Button>Editor menu</Button>}
      leadingActions={<Button>Change view</Button>}
      actions={<Button>Save</Button>}
    >
      <Field label="Name">
        <Input />
      </Field>
    </Dialog>,
  );
  for (const name of ["Editor menu", "Change view", "Save", "Close"])
    expect(screen.getByRole("button", { name })).toBeVisible();
  await user.click(screen.getByRole("textbox", { name: "Name" }));
  await user.keyboard("{Escape}");
  expect(interceptEscape).toHaveBeenCalledTimes(1);
  expect(change).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  expect(change).toHaveBeenCalledWith(false);
});

test("a nested right dialog renders its own dismissal backdrop", () => {
  render(
    <Dialog open title="Editor" onOpenChange={() => {}}>
      <Dialog
        open
        placement="right"
        dismissOnOutsideClick
        title="Inspector"
        onOpenChange={() => {}}
      >
        <Button>Inspect</Button>
      </Dialog>
    </Dialog>,
  );
  expect(screen.getByRole("dialog", { name: "Inspector" })).toHaveAttribute(
    "data-placement",
    "right",
  );
  expect(
    document.querySelector('.buzz-dialog-backdrop[data-placement="right"]'),
  ).not.toBeNull();
});

test("dialog content-owned layout is opt-in and retains the shared body", () => {
  const props = {
    open: true,
    onOpenChange: () => {},
    title: "Browse",
    children: <p>Results</p>,
  };
  const { rerender } = render(<Dialog {...props} />);
  expect(screen.getByRole("dialog")).toHaveAttribute(
    "data-body-layout",
    "flow",
  );
  rerender(<Dialog {...props} height="stable" bodyLayout="flex" />);
  expect(screen.getByRole("dialog")).toHaveAttribute(
    "data-body-layout",
    "flex",
  );
  expect(screen.getByText("Results").parentElement).toHaveClass(
    "buzz-dialog-body",
  );
  rerender(<Dialog {...props} />);
  expect(screen.getByRole("dialog")).toHaveAttribute(
    "data-body-layout",
    "flow",
  );
});

test("navigation tabs retain keyboard selection and separate close buttons", async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  function Example() {
    const [value, setValue] = useState("thread");
    return (
      <Tabs
        value={value}
        onValueChange={setValue}
        label="Panel tabs"
        variant="navigation"
        items={[
          {
            value: "thread",
            label: "Thread",
            icon: <span aria-hidden="true">T</span>,
          },
          { value: "profile", label: "Ada", onClose: close },
        ]}
        renderPanel={(tab) => <p>{tab} content</p>}
      />
    );
  }
  render(<Example />);
  const thread = screen.getByRole("tab", { name: "Thread" });
  expect(thread).toHaveClass("navigation-item");
  expect(thread).not.toHaveAttribute("aria-current", "page");
  await user.click(thread);
  await user.keyboard("{ArrowRight}");
  const profile = screen.getByRole("tab", { name: "Ada" });
  expect(profile).toHaveFocus();
  expect(profile).toHaveAttribute("aria-selected", "false");
  await user.keyboard("{Enter}");
  expect(profile).toHaveAttribute("aria-selected", "true");
  expect(profile).toHaveAttribute("data-selected");
  expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Ada");
  const dismiss = screen.getByRole("button", { name: "Close Ada tab" });
  expect(profile).not.toContainElement(dismiss);
  await user.click(dismiss);
  expect(close).toHaveBeenCalledOnce();
  await user.click(profile);
  await user.keyboard("{Delete}");
  expect(close).toHaveBeenCalledTimes(2);
});

test("centered nested pointer-dismissal owns a backdrop and leaves the parent open", async () => {
  const user = userEvent.setup();
  const parent = vi.fn();
  const child = vi.fn();
  render(
    <Dialog open title="Editor" onOpenChange={parent} dismissOnOutsideClick>
      <Dialog open title="Confirm" onOpenChange={child} dismissOnOutsideClick>
        <Button>Cancel</Button>
      </Dialog>
    </Dialog>,
  );
  const popup = screen.getByRole("dialog", { name: "Confirm" });
  const backdrop = popup.parentElement?.querySelector(".buzz-dialog-backdrop");
  expect(backdrop).toHaveAttribute("data-outside-dismissal", "true");
  await user.click(backdrop as Element);
  expect(child).toHaveBeenCalledExactlyOnceWith(false);
  expect(parent).not.toHaveBeenCalled();
});

test("outside dismissal remains opt-in", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(
    <Dialog open title="Editor" onOpenChange={change}>
      <Button>Save</Button>
    </Dialog>,
  );
  await user.click(document.querySelector(".buzz-dialog-backdrop") as Element);
  expect(change).not.toHaveBeenCalled();
});

test("dialog steps keep one labelled modal and make outgoing controls inert", async () => {
  const content = (confirm: boolean) => (
    <Dialog
      open
      onOpenChange={() => {}}
      title={confirm ? "Confirm change" : "Edit notes"}
      height={confirm ? "content" : "stable"}
      bodyLayout={confirm ? "flow" : "flex"}
      description={confirm ? "Applies only after Save." : undefined}
      step={
        confirm ? { key: "confirm", scale: 1.05 } : { key: "edit", scale: 0.95 }
      }
      actions={<Button>{confirm ? "Continue" : "Save"}</Button>}
    >
      {confirm ? <p>Review this change.</p> : <Input aria-label="Note" />}
    </Dialog>
  );
  const view = render(content(false));
  const popup = screen.getByRole("dialog", { name: "Edit notes" });
  const outgoing = screen
    .getByRole("textbox", { name: "Note" })
    .closest(".buzz-dialog-step");
  view.rerender(content(true));
  expect(screen.getByRole("dialog", { name: "Confirm change" })).toBe(popup);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(document.querySelectorAll(".buzz-dialog-backdrop")).toHaveLength(1);
  expect(popup).toHaveAccessibleDescription("Applies only after Save.");
  expect(outgoing).toHaveAttribute("data-height", "stable");
  expect(outgoing).toHaveAttribute("data-body-layout", "flex");
  const incoming = screen
    .getByRole("button", { name: "Continue" })
    .closest(".buzz-dialog-step");
  expect(incoming).toHaveAttribute("data-height", "content");
  expect(incoming).toHaveAttribute("data-body-layout", "flow");
  expect(outgoing).toHaveAttribute("inert");
  expect(outgoing).toHaveAttribute("aria-hidden", "true");
  expect(
    screen.queryByRole("textbox", { name: "Note" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  // Reverse before the outgoing step has finished; presence must revive it.
  view.rerender(content(false));
  expect(screen.getByRole("dialog", { name: "Edit notes" })).toBe(popup);
  expect(screen.getByRole("textbox", { name: "Note" })).toBeEnabled();
  expect(outgoing).not.toHaveAttribute("inert");
  expect(popup).not.toHaveAccessibleDescription();
  await waitFor(() =>
    expect(popup.querySelectorAll(".buzz-dialog-step")).toHaveLength(1),
  );
  expect(
    screen.queryByRole("button", { name: "Continue" }),
  ).not.toBeInTheDocument();
});

test("compact header spacing is opt-in and follows stepped content", () => {
  const view = (compact: boolean, step = "form") => (
    <Dialog
      open
      title="Channel"
      onOpenChange={() => {}}
      headerGap={compact ? "compact" : "default"}
      step={{ key: step, scale: 0.95 }}
    >
      <p>{step}</p>
    </Dialog>
  );
  const { rerender } = render(view(false));
  expect(screen.getByText("form").parentElement).toHaveAttribute(
    "data-header-gap",
    "default",
  );
  rerender(view(true));
  expect(screen.getByText("form").parentElement).toHaveAttribute(
    "data-header-gap",
    "compact",
  );
  rerender(view(true, "confirmation"));
  expect(screen.getByText("confirmation").parentElement).toHaveAttribute(
    "data-header-gap",
    "compact",
  );
});

test("compact footer spacing is opt-in and resets when leaving confirmation", () => {
  const view = (confirm = false) => (
    <Dialog
      open
      title="Channel"
      onOpenChange={() => {}}
      {...(confirm ? { footerGap: "compact" as const } : {})}
      step={{ key: confirm ? "confirmation" : "form", scale: 0.95 }}
    >
      <p>{confirm ? "confirmation" : "form"}</p>
    </Dialog>
  );
  const { rerender } = render(view());
  expect(screen.getByText("form").parentElement).toHaveAttribute(
    "data-footer-gap",
    "default",
  );
  rerender(view(true));
  expect(screen.getByText("confirmation").parentElement).toHaveAttribute(
    "data-footer-gap",
    "compact",
  );
  rerender(view());
  expect(screen.getByText("form").parentElement).toHaveAttribute(
    "data-footer-gap",
    "default",
  );
});

test("selected tab reactivation is opt-in and distinct from value changes", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  const reselect = vi.fn();
  const props = {
    label: "Area",
    value: "one",
    onValueChange: change,
    items: [
      { value: "one", label: "One" },
      { value: "two", label: "Two" },
    ],
  };
  const { rerender } = render(<Tabs {...props} />);
  const one = screen.getByRole("tab", { name: "One" });
  await user.click(one);
  expect(change).not.toHaveBeenCalled();
  rerender(<Tabs {...props} onReselect={reselect} />);
  await user.click(one);
  await user.keyboard("{Enter} ");
  expect(reselect).toHaveBeenCalledTimes(3);
  expect(reselect).toHaveBeenLastCalledWith("one");
  expect(change).not.toHaveBeenCalled();
  await user.keyboard("{ArrowRight}");
  expect(reselect).toHaveBeenCalledTimes(3);
  expect(change).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  expect(change).toHaveBeenCalledExactlyOnceWith("two");
  expect(reselect).toHaveBeenCalledTimes(3);
});
