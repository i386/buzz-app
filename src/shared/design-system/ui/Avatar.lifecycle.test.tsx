// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Avatar } from "./Avatar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("reveals completed cached artwork on mount without waiting for a load event", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    32,
  );
  const view = render(
    <StrictMode>
      <Avatar src="https://example.test/a.png" alt="Agent" fallback="A" />
    </StrictMode>,
  );
  expect(view.container.querySelector("img")).toHaveAttribute(
    "data-loaded",
    "true",
  );
  expect(view.container.querySelector("img")).toHaveAttribute(
    "loading",
    "lazy",
  );
});

it("uses the fallback for an already completed broken image", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    0,
  );
  render(
    <Avatar src="https://example.test/broken.png" alt="Agent" fallback="A" />,
  );
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByRole("img", { name: "Agent" })).toHaveTextContent("A");
});

it("defers new sources, uses eager loading after success, and forgets a failed remount", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    false,
  );
  const props = {
    src: "https://example.test/warm-remount.png",
    alt: "Agent",
    fallback: "A",
  };
  const first = render(<Avatar {...props} />);
  const image = first.container.querySelector("img");
  if (!image) throw new Error("Expected initial artwork");
  expect(image).toHaveAttribute("loading", "lazy");
  fireEvent.load(image);
  first.unmount();

  const second = render(<Avatar {...props} />);
  const remount = second.container.querySelector("img");
  if (!remount) throw new Error("Expected remounted artwork");
  expect(remount).toHaveAttribute("loading", "eager");
  // Remembered success is only a scheduling hint: the browser may have evicted
  // the bytes, so actual image readiness still controls visibility.
  expect(remount).not.toHaveAttribute("data-loaded");
  fireEvent.error(remount);
  expect(screen.getByRole("img", { name: "Agent" })).toHaveTextContent("A");
  second.unmount();

  const retry = render(<Avatar {...props} />);
  expect(retry.container.querySelector("img")).toHaveAttribute(
    "loading",
    "lazy",
  );
});

it("bounds remembered sources and retains recently used artwork", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    false,
  );
  const src = (index: number) => `https://example.test/bounded-${index}.png`;
  const view = render(<Avatar src={src(0)} alt="Agent" fallback="A" />);
  const mount = (index: number) => {
    view.rerender(<Avatar src={src(index)} alt="Agent" fallback="A" />);
    const image = view.container.querySelector("img");
    if (!image) throw new Error("Expected bounded-cache artwork");
    return image;
  };
  fireEvent.load(mount(0));
  for (let index = 1; index < 128; index++) fireEvent.load(mount(index));
  // Refresh the oldest entry before adding another distinct source.
  expect(mount(0)).toHaveAttribute("loading", "eager");
  fireEvent.load(mount(0));
  fireEvent.load(mount(128));
  expect(mount(1)).toHaveAttribute("loading", "lazy");
  expect(mount(0)).toHaveAttribute("loading", "eager");
});

it("preserves delayed loading and error fallbacks, resetting when the source changes", () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    false,
  );
  const view = render(
    <Avatar src="https://example.test/a.png" alt="Agent" fallback="A" />,
  );
  const artwork = () => {
    const image = view.container.querySelector("img");
    if (!image) throw new Error("Expected avatar artwork");
    return image;
  };
  const avatar = screen.getByRole("img", { name: "Agent" });
  expect(avatar).toHaveTextContent("");
  act(() => vi.advanceTimersByTime(149));
  expect(avatar).toHaveTextContent("");
  act(() => vi.advanceTimersByTime(1));
  expect(avatar).toHaveTextContent("A");
  fireEvent.load(artwork());
  expect(artwork()).toHaveAttribute("data-loaded", "true");
  expect(avatar).toHaveTextContent("");

  view.rerender(
    <Avatar src="https://example.test/b.png" alt="Agent" fallback="A" />,
  );
  expect(artwork()).not.toHaveAttribute("data-loaded");
  expect(avatar).toHaveTextContent("");
  fireEvent.error(artwork());
  expect(avatar).toHaveTextContent("A");
  expect(document.querySelector("img")).toBeNull();
  view.rerender(
    <Avatar src="https://example.test/c.png" alt="Agent" fallback="A" />,
  );
  fireEvent.load(artwork());
  expect(artwork()).toHaveAttribute("data-loaded", "true");
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
