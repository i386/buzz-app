// @vitest-environment jsdom
import { fireEvent, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useKeyboardFocusVisibility } from "./useKeyboardFocusVisibility";

afterEach(() => {
  delete document.documentElement.dataset.keyboardNavigation;
});

it("treats Ctrl+Tab after a pointer as keyboard navigation, but not other Ctrl chords", () => {
  const root = document.documentElement;
  const hook = renderHook(() => useKeyboardFocusVisibility());
  for (const init of [
    { key: "Tab", ctrlKey: true },
    { key: "Tab", ctrlKey: true, shiftKey: true },
  ]) {
    fireEvent.pointerDown(document.body);
    expect(root.dataset.keyboardNavigation).toBeUndefined();
    fireEvent.keyDown(document.body, init);
    expect(root.dataset.keyboardNavigation).toBe("");
  }
  fireEvent.pointerDown(document.body);
  fireEvent.keyDown(document.body, { key: "ArrowDown", ctrlKey: true });
  fireEvent.keyDown(document.body, { key: "Tab", metaKey: true });
  expect(root.dataset.keyboardNavigation).toBeUndefined();
  hook.unmount();
});
