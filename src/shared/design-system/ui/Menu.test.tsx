// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { Button } from "./Button";
import { ChoiceRow } from "./ChoiceRow";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuSubmenu,
  MenuSubmenuTrigger,
  MenuSubmenuPopup,
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuLinkItem,
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioItem,
} from "./Menu";

afterEach(cleanup);

test("actions and links keep semantics, callbacks and dismissal while disabled items reject activation", async () => {
  const user = userEvent.setup();
  const action = vi.fn();
  const disabled = vi.fn();
  render(
    <StrictMode>
      <MenuRoot>
        <MenuTrigger render={<Button>Actions</Button>} />
        <MenuPopup>
          <MenuItem onClick={action}>Copy link</MenuItem>
          <MenuItem disabled onClick={disabled}>
            Unavailable
          </MenuItem>
          <MenuLinkItem href="#documentation">Documentation</MenuLinkItem>
        </MenuPopup>
      </MenuRoot>
    </StrictMode>,
  );
  await user.click(screen.getByRole("button", { name: "Actions" }));
  const unavailable = await screen.findByRole("menuitem", {
    name: "Unavailable",
  });
  expect(unavailable).toHaveAttribute("aria-disabled", "true");
  await user.click(unavailable);
  unavailable.focus();
  await user.keyboard("{Enter} ");
  expect(disabled).not.toHaveBeenCalled();
  expect(
    screen.getByRole("menuitem", { name: "Documentation" }),
  ).toHaveAttribute("href", "#documentation");
  await user.click(screen.getByRole("menuitem", { name: "Copy link" }));
  expect(action).toHaveBeenCalledTimes(1);
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
});

test("controlled checkbox and radio choices report selection and retain disabled values", async () => {
  const user = userEvent.setup();
  const checkboxChange = vi.fn();
  const radioChange = vi.fn();
  const disabledChange = vi.fn();
  function Example() {
    const [checked, setChecked] = useState(false);
    const [value, setValue] = useState("comfortable");
    return (
      <MenuRoot>
        <MenuTrigger render={<Button>Options</Button>} />
        <MenuPopup>
          <MenuCheckboxItem
            checked={checked}
            closeOnClick={false}
            onCheckedChange={(next) => {
              checkboxChange(next);
              setChecked(next);
            }}
          >
            Show details
          </MenuCheckboxItem>
          <MenuCheckboxItem
            disabled
            checked={false}
            onCheckedChange={disabledChange}
          >
            Unavailable toggle
          </MenuCheckboxItem>
          <MenuRadioGroup
            value={value}
            onValueChange={(next) => {
              radioChange(next);
              setValue(next);
            }}
          >
            <MenuRadioItem value="comfortable" closeOnClick={false}>
              Comfortable
            </MenuRadioItem>
            <MenuRadioItem value="compact" closeOnClick={false}>
              Compact
            </MenuRadioItem>
            <MenuRadioItem value="unavailable" disabled>
              Unavailable choice
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuPopup>
      </MenuRoot>
    );
  }
  render(
    <StrictMode>
      <Example />
    </StrictMode>,
  );
  await user.click(screen.getByRole("button", { name: "Options" }));
  const checkbox = await screen.findByRole("menuitemcheckbox", {
    name: "Show details",
  });
  await user.click(checkbox);
  expect(checkbox).toBeChecked();
  expect(checkboxChange).toHaveBeenLastCalledWith(true);
  await user.click(screen.getByRole("menuitemradio", { name: "Compact" }));
  expect(screen.getByRole("menuitemradio", { name: "Compact" })).toBeChecked();
  expect(
    screen.getByRole("menuitemradio", { name: "Comfortable" }),
  ).not.toBeChecked();
  expect(radioChange).toHaveBeenCalledExactlyOnceWith("compact");
  await user.click(
    screen.getByRole("menuitemcheckbox", { name: "Unavailable toggle" }),
  );
  await user.click(
    screen.getByRole("menuitemradio", { name: "Unavailable choice" }),
  );
  expect(disabledChange).not.toHaveBeenCalled();
  expect(radioChange).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("menuitemradio", { name: "Compact" })).toBeChecked();
});

test("context menus reuse the shared popup and action boundary", async () => {
  const action = vi.fn();
  const user = userEvent.setup();
  render(
    <StrictMode>
      <ContextMenuRoot>
        <ContextMenuTrigger>Context target</ContextMenuTrigger>
        <MenuPopup>
          <MenuItem onClick={action}>Copy context link</MenuItem>
        </MenuPopup>
      </ContextMenuRoot>
    </StrictMode>,
  );
  fireEvent.contextMenu(screen.getByText("Context target"), {
    clientX: 20,
    clientY: 20,
  });
  const item = await screen.findByRole("menuitem", {
    name: "Copy context link",
  });
  expect(screen.getByRole("menu")).toHaveAttribute("data-buzz-ui");
  await user.click(item);
  expect(action).toHaveBeenCalledTimes(1);
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
});

test("rich choices retain their names and selected state while disabled choices reject activation", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(
    <MenuRoot>
      <MenuTrigger render={<Button>Agents</Button>} />
      <MenuPopup>
        <MenuRadioGroup value="studio" onValueChange={change}>
          <MenuRadioItem value="studio">
            <ChoiceRow
              label="Studio"
              description="Already in this session"
              leading={<span>S</span>}
            />
          </MenuRadioItem>
          <MenuRadioItem value="archive" disabled>
            <ChoiceRow
              label="Archive"
              description="Unavailable"
              leading={<span>A</span>}
            />
          </MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </MenuRoot>,
  );
  await user.click(screen.getByRole("button", { name: "Agents" }));
  await screen.findByRole("menu");
  expect(
    screen.getByRole("menuitemradio", {
      name: "Studio Already in this session",
    }),
  ).toBeChecked();
  const unavailable = screen.getByRole("menuitemradio", {
    name: "Archive Unavailable",
  });
  await user.click(unavailable);
  expect(change).not.toHaveBeenCalled();
  expect(unavailable).toHaveAttribute("aria-disabled", "true");
});

test("keyboard-opened menus ignore a stationary pointer and open submenus immediately on movement", async () => {
  const user = userEvent.setup();
  render(
    <MenuRoot>
      <MenuTrigger>Actions</MenuTrigger>
      <MenuPopup>
        <MenuSubmenu>
          <MenuSubmenuTrigger>Sort</MenuSubmenuTrigger>
          <MenuSubmenuPopup>
            <MenuItem>Recent</MenuItem>
          </MenuSubmenuPopup>
        </MenuSubmenu>
      </MenuPopup>
    </MenuRoot>,
  );
  screen.getByRole("button", { name: "Actions" }).focus();
  await user.keyboard("{ArrowDown}");
  const trigger = await screen.findByRole("menuitem", { name: "Sort" });
  vi.useFakeTimers();
  try {
    fireEvent.mouseEnter(trigger);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.mouseMove(trigger);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: "Recent" })).toBeVisible();
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

test("highlight radio choices keep single-selection semantics without a check icon", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  function ViewMenu() {
    const [value, setValue] = useState("all");
    return (
      <MenuRoot>
        <MenuTrigger render={<Button>Views</Button>} />
        <MenuPopup>
          <MenuRadioGroup
            value={value}
            onValueChange={(next) => {
              setValue(next);
              change(next);
            }}
          >
            <MenuRadioItem
              value="all"
              selection="highlight"
              closeOnClick={false}
            >
              All
            </MenuRadioItem>
            <MenuRadioItem
              value="threads"
              selection="highlight"
              closeOnClick={false}
            >
              Threads
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuPopup>
      </MenuRoot>
    );
  }
  render(<ViewMenu />);
  await user.click(screen.getByRole("button", { name: "Views" }));
  const all = await screen.findByRole("menuitemradio", { name: "All" });
  const threads = screen.getByRole("menuitemradio", { name: "Threads" });
  expect(all).toBeChecked();
  expect(all).toHaveAttribute("data-selection", "highlight");
  expect(all.querySelector("svg")).toBeNull();
  expect(threads.querySelector("svg")).toBeNull();
  await user.click(threads);
  expect(threads).toBeChecked();
  expect(all).not.toBeChecked();
  expect(change).toHaveBeenLastCalledWith("threads");
});
