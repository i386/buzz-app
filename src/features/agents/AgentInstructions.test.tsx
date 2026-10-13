// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentInstructions } from "./AgentInstructions";
import { CreateCardContext, type CardEditing } from "./create-card";

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness({
  initial = "",
  disabled = false,
  onChange,
}: {
  initial?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <AgentInstructions
      value={value}
      disabled={disabled}
      description="Added to every session."
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
    />
  );
}

/** A stand-in for the dialog's card, remembering what the field registered. */
function inCard(ui: React.ReactElement) {
  const calls: (CardEditing | null)[] = [];
  const edit = vi.fn((editing: CardEditing | null) => void calls.push(editing));
  const card = { corner: null, edit };
  const view = render(
    <CreateCardContext.Provider value={card}>{ui}</CreateCardContext.Provider>,
  );
  const current = () => calls.at(-1) ?? null;
  return { edit, calls, current, view };
}

const open = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: /^(Add|Edit) instructions$/ }));

it("is a plain labelled field outside the card", async () => {
  const user = userEvent.setup();
  render(<Harness initial="Be kind." />);
  const field = screen.getByLabelText("Instructions");
  expect(field).toHaveValue("Be kind.");
  expect(field).toHaveAccessibleDescription("Added to every session.");
  expect(
    screen.queryByRole("button", { name: /^(Add|Edit) instructions$/ }),
  ).not.toBeInTheDocument();
  await user.type(field, " Really.");
  expect(field).toHaveValue("Be kind. Really.");
});

it("disables the plain field", () => {
  render(<Harness disabled />);
  expect(screen.getByLabelText("Instructions")).toBeDisabled();
});

it("shows examples and 'Add instructions' in the card while empty", () => {
  const { edit } = inCard(<Harness />);
  expect(
    screen.getByRole("button", { name: /^(Add|Edit) instructions$/ }),
  ).toHaveTextContent("Add instructions");
  expect(screen.getByText(/Help me plan my week/)).toBeInTheDocument();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(edit).not.toHaveBeenCalled();
});

it("treats whitespace alone as empty", () => {
  inCard(<Harness initial={"  \n "} />);
  expect(
    screen.getByRole("button", { name: /^(Add|Edit) instructions$/ }),
  ).toHaveTextContent("Add instructions");
  expect(screen.getByText(/Help me plan my week/)).toBeInTheDocument();
});

it("shows a preview and 'Edit instructions' in the card once set", () => {
  inCard(<Harness initial="Triage my inbox." />);
  expect(screen.getByText("Triage my inbox.")).toBeInTheDocument();
  expect(screen.queryByText(/Help me plan my week/)).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /^(Add|Edit) instructions$/ }),
  ).toHaveTextContent("Edit instructions");
});

it("disables the card's entry button", () => {
  inCard(<Harness disabled />);
  expect(
    screen.getByRole("button", { name: /^(Add|Edit) instructions$/ }),
  ).toBeDisabled();
});

it("opens an editor over the card and registers Back and Done", async () => {
  const user = userEvent.setup();
  const { edit, current } = inCard(<Harness initial="Triage." />);
  await open(user);
  const editor = screen.getByRole("textbox", { name: "Agent instructions" });
  expect(editor).toHaveValue("Triage.");
  expect(editor).toHaveFocus();
  expect(
    screen.queryByRole("button", { name: /^(Add|Edit) instructions$/ }),
  ).not.toBeInTheDocument();
  expect(edit).toHaveBeenCalledTimes(1);
  expect(current()).toEqual({
    back: expect.any(Function),
    done: expect.any(Function),
  });
});

it("keeps the new text on Done", async () => {
  const user = userEvent.setup();
  const { current } = inCard(<Harness initial="Triage." />);
  await open(user);
  await user.type(
    screen.getByRole("textbox", { name: "Agent instructions" }),
    " Then summarize.",
  );
  act(() => current()?.done());
  expect(screen.getByText("Triage. Then summarize.")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /^(Add|Edit) instructions$/ }),
  ).toHaveTextContent("Edit instructions");
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

it("restores the text from when editing began on Back", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const { current } = inCard(<Harness initial="Triage." onChange={onChange} />);
  await open(user);
  await user.type(
    screen.getByRole("textbox", { name: "Agent instructions" }),
    " Then summarize.",
  );
  act(() => current()?.back());
  expect(onChange).toHaveBeenLastCalledWith("Triage.");
  expect(screen.getByText("Triage.")).toBeInTheDocument();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Edit instructions" }),
  ).toHaveFocus();
});

it("returns to the examples on Back after instructions were typed from empty", async () => {
  const user = userEvent.setup();
  const { current } = inCard(<Harness />);
  await open(user);
  await user.type(
    screen.getByRole("textbox", { name: "Agent instructions" }),
    "Something new",
  );
  act(() => current()?.back());
  expect(
    screen.getByRole("button", { name: /^(Add|Edit) instructions$/ }),
  ).toHaveTextContent("Add instructions");
  expect(screen.queryByText("Something new")).not.toBeInTheDocument();
});

it("restores only what the latest editing began with", async () => {
  const user = userEvent.setup();
  const { current } = inCard(<Harness initial="One." />);
  await open(user);
  await user.type(
    screen.getByRole("textbox", { name: "Agent instructions" }),
    " Two.",
  );
  act(() => current()?.done());
  await open(user);
  await user.type(
    screen.getByRole("textbox", { name: "Agent instructions" }),
    " Three.",
  );
  act(() => current()?.back());
  expect(screen.getByText("One. Two.")).toBeInTheDocument();
});

it("unregisters when editing closes, and when it unmounts mid-edit", async () => {
  const user = userEvent.setup();
  const { calls, current, view } = inCard(<Harness initial="Triage." />);
  await open(user);
  expect(current()).not.toBeNull();
  act(() => current()?.done());
  expect(calls.at(-1)).toBeNull();
  expect(calls.filter((call) => call !== null)).toHaveLength(1);

  await open(user);
  expect(calls.at(-1)).not.toBeNull();
  view.unmount();
  expect(calls.at(-1)).toBeNull();
});
