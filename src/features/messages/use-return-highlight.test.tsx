// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useReturnHighlight } from "./use-return-highlight";
import styles from "./Messages.module.css";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("ignores other animation completions while its own cue and cancellation retire it", () => {
  const container = document.createElement("div");
  container.innerHTML =
    '<section data-channel-timeline="alpha"><div data-message-id="root"><div data-layout="timeline"><span>Reaction</span></div></div></section>';
  document.body.append(container);
  const scroller = container.querySelector("section");
  const row = container.querySelector<HTMLElement>("[data-layout]");
  const reaction = row?.querySelector("span");
  const highlight = styles.returnHighlight;
  if (!scroller || !row || !reaction || !highlight)
    throw new Error("Missing fixture elements");
  vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 300, 300),
  );
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 50, 300, 50),
  );
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => {
    frame = next;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frame = undefined;
  });
  const ref = { current: container };
  const h = renderHook(({ channel }) => useReturnHighlight(ref, channel), {
    initialProps: { channel: "alpha" },
  });
  const paint = () =>
    act(() => {
      h.result.current("root");
      frame?.(0);
    });
  const finish = (target: Element, pseudoElement = "") => {
    const event = new Event("animationend", { bubbles: true });
    Object.defineProperty(event, "pseudoElement", { value: pseudoElement });
    act(() => target.dispatchEvent(event));
  };
  paint();
  expect(row).toHaveClass(highlight);
  finish(reaction, "::after");
  finish(row);
  finish(row, "::before");
  expect(row).toHaveClass(highlight);
  finish(row, "::after");
  expect(row).not.toHaveClass(highlight);
  paint();
  act(() => h.result.current(undefined));
  expect(row).not.toHaveClass(highlight);
  paint();
  h.rerender({ channel: "beta" });
  expect(row).not.toHaveClass(highlight);
  h.rerender({ channel: "alpha" });
  paint();
  h.unmount();
  expect(row).not.toHaveClass(highlight);
});
