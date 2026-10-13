// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import { createAppearance } from "../shared/theme/service";
import { AppearanceSettings } from "./AppearanceSettings";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

it("hidden settings do not portal errors; returning retains both save recovery actions", async () => {
  const appearance = createAppearance();
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("denied");
    });
  act(() => {
    appearance.setMode("dark");
    appearance.setFontScale(1.2);
  });
  const content = (active: boolean) => (
    <ToastProvider>
      <AppearanceSettings appearance={appearance} active={active} />
    </ToastProvider>
  );
  const view = render(content(false));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  view.rerender(content(true));
  await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(2));
  view.rerender(content(false));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(appearance.snapshot().error).not.toBeNull();
  view.rerender(content(true));
  write.mockRestore();
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry saving appearance" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Retry saving interface size" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(localStorage.getItem("buzz-appearance.v1")).toBe("dark");
  expect(localStorage.getItem("buzz-font-scale.v1")).toBe("1.2");
  appearance.dispose();
});

it("retry saves the System choice even when its current palette is light", async () => {
  const appearance = createAppearance();
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementationOnce(() => {
      throw new Error("denied");
    });
  act(() => appearance.setMode("system"));
  render(
    <ToastProvider>
      <AppearanceSettings appearance={appearance} />
    </ToastProvider>,
  );
  expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry saving appearance" }),
  );
  expect(write).toHaveBeenLastCalledWith("buzz-appearance.v1", "system");
  expect(localStorage.getItem("buzz-appearance.v1")).toBe("system");
  appearance.dispose();
});

it("shows reset only away from the default size and hides it after reset", () => {
  const appearance = createAppearance();
  render(
    <ToastProvider>
      <AppearanceSettings appearance={appearance} />
    </ToastProvider>,
  );
  expect(
    screen.queryByRole("button", { name: "Reset interface size" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Increase interface size" }),
  );
  expect(
    screen.getByRole("status", { name: "Interface size" }),
  ).toHaveTextContent("110%");
  fireEvent.click(screen.getByRole("button", { name: "Reset interface size" }));
  expect(
    screen.getByRole("status", { name: "Interface size" }),
  ).toHaveTextContent("100%");
  expect(
    screen.queryByRole("button", { name: "Reset interface size" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Decrease interface size" }),
  );
  expect(
    screen.getByRole("button", { name: "Reset interface size" }),
  ).toBeVisible();
  appearance.dispose();
});

it.each([1.1, 2])(
  "returns focused Reset from %s to Increase, including storage failure",
  async (scale) => {
    const user = userEvent.setup();
    const appearance = createAppearance();
    render(
      <ToastProvider>
        <AppearanceSettings appearance={appearance} />
      </ToastProvider>,
    );
    const increase = screen.getByRole("button", {
      name: "Increase interface size",
    });
    act(() => appearance.setFontScale(scale));
    screen.getByRole("button", { name: "Reset interface size" }).focus();
    vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new Error("denied");
    });
    await user.keyboard("{Enter}");
    expect(
      screen.queryByRole("button", { name: "Reset interface size" }),
    ).not.toBeInTheDocument();
    expect(increase).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Retry saving interface size" }),
    ).toBeVisible();
    appearance.dispose();
  },
);

it.each([false, true])(
  "external reset hands off only the retiring control's focus (%s)",
  (focusReset) => {
    const appearance = createAppearance();
    appearance.setFontScale(1.2);
    render(
      <ToastProvider>
        <AppearanceSettings appearance={appearance} />
      </ToastProvider>,
    );
    const colorMode = screen.getByRole("radio", { name: "System" });
    (focusReset
      ? screen.getByRole("button", { name: "Reset interface size" })
      : colorMode
    ).focus();
    act(() => appearance.setFontScale(1.3));
    expect(
      focusReset
        ? screen.getByRole("button", { name: "Reset interface size" })
        : colorMode,
    ).toHaveFocus();
    act(() => {
      localStorage.setItem("buzz-font-scale.v1", "1");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "buzz-font-scale.v1",
          newValue: "1",
          storageArea: localStorage,
        }),
      );
    });
    expect(
      screen.queryByRole("button", { name: "Reset interface size" }),
    ).not.toBeInTheDocument();
    expect(
      focusReset
        ? screen.getByRole("button", { name: "Increase interface size" })
        : colorMode,
    ).toHaveFocus();
    appearance.dispose();
  },
);

it("does not hand off Reset focus when the settings form unmounts", () => {
  const appearance = createAppearance();
  appearance.setFontScale(2);
  const view = render(
    <ToastProvider>
      <AppearanceSettings appearance={appearance} />
    </ToastProvider>,
  );
  const increase = screen.getByRole("button", {
    name: "Increase interface size",
  });
  screen.getByRole("button", { name: "Reset interface size" }).focus();
  const focus = vi.spyOn(increase, "focus");
  view.unmount();
  expect(focus).not.toHaveBeenCalled();
  appearance.dispose();
});

it("selects and saves color mode through visual radio choices", async () => {
  const appearance = createAppearance();
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <AppearanceSettings appearance={appearance} />
    </ToastProvider>,
  );
  expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
  for (const [label, value] of [
    ["Dark", "dark"],
    ["Light", "light"],
    ["System", "system"],
  ] as const) {
    const choice = screen.getByRole("radio", { name: label });
    await user.click(choice);
    expect(choice).toBeChecked();
    expect(appearance.snapshot().preference).toBe(value);
    expect(localStorage.getItem("buzz-appearance.v1")).toBe(value);
  }
  appearance.dispose();
});
