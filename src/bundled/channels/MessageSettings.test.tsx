// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MessageSettings } from "./MessageSettings";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import {
  setThreadPlacementPreference,
  threadPlacementPreference,
} from "../../features/messages/thread-preferences";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setThreadPlacementPreference("side");
  localStorage.clear();
});
it("saves new-thread placement, restores it, and follows another window", async () => {
  const user = userEvent.setup();
  render(<MessageSettings active={() => true} />, {
    wrapper: ToastProvider,
  });
  const choice = () =>
    screen.getByRole("combobox", { name: "Open threads in" });
  expect(
    screen.getByText(
      "New threads open here. Already-open threads stay where you placed them.",
    ),
  ).toBeVisible();
  expect(choice()).toHaveTextContent("Side pane");
  await user.click(choice());
  await user.click(await screen.findByRole("option", { name: "Main pane" }));
  expect(threadPlacementPreference()).toBe("main");
  cleanup();
  render(<MessageSettings active={() => true} />, {
    wrapper: ToastProvider,
  });
  expect(choice()).toHaveTextContent("Main pane");
  act(() => {
    localStorage.setItem("buzz-thread-placement.v1", "side");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "buzz-thread-placement.v1" }),
    );
  });
  expect(choice()).toHaveTextContent("Side pane");
});

it("keeps unsaved thread placement and recovery through remount, then retries the same choice", async () => {
  const user = userEvent.setup();
  const view = render(<MessageSettings active={() => true} />, {
    wrapper: ToastProvider,
  });
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("unavailable");
    });
  await user.click(screen.getByRole("combobox", { name: "Open threads in" }));
  await user.click(await screen.findByRole("option", { name: "Main pane" }));
  expect(threadPlacementPreference()).toBe("main");
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "Thread preference wasn’t saved",
  );
  // The app keeps its toast host while the settings destination unmounts.
  view.rerender(null);
  view.rerender(<MessageSettings active={() => true} />);
  expect(
    screen.getByRole("combobox", { name: "Open threads in" }),
  ).toHaveTextContent("Main pane");
  expect(await screen.findByRole("dialog")).toHaveTextContent(
    "Thread preference wasn’t saved",
  );
  // Re-enter through the preference before invoking its recovery action.
  screen.getByRole("combobox", { name: "Open threads in" }).focus();
  write.mockRestore();
  await user.click(screen.getByRole("button", { name: "Retry saving" }));
  expect(localStorage.getItem("buzz-thread-placement.v1")).toBe("main");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
