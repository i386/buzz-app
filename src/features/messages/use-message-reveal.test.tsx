// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMessageReveal } from "./use-message-reveal";

// Control frame/mutation ordering; browser journeys own real layout and inert focus.
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    top: 0,
    left: 0,
    bottom: 100,
    right: 100,
    width: 100,
    height: 100,
    x: 0,
    y: 0,
    toJSON() {},
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  frames.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});
async function frame() {
  await act(async () => {
    for (const [id, callback] of [...frames]) {
      if (!frames.delete(id)) continue;
      callback(0);
    }
  });
}
function mount() {
  const request = new AbortController();
  const complete = vi.fn();
  function Surface({
    signal = request.signal,
    prepare = undefined,
    rowKey = 0,
  }: {
    signal?: AbortSignal;
    prepare?: () => void;
    rowKey?: number;
  }) {
    const scroller = useRef<HTMLDivElement>(null);
    const settled = useRef(false);
    useMessageReveal({
      scroller,
      settled,
      messageId: "target",
      signal,
      ready: true,
      complete,
      ...(prepare ? { prepare } : {}),
    });
    return (
      <>
        <div ref={scroller}>
          <div key={rowKey} data-message-id="target">
            Target
          </div>
        </div>
        <button type="button">Elsewhere</button>
      </>
    );
  }
  const result = render(<Surface />);
  const row = screen.getByText("Target");
  const outside = screen.getByRole("button", { name: "Elsewhere" });
  return {
    ...result,
    request,
    complete,
    row,
    outside,
    restart: () => result.rerender(<Surface prepare={() => {}} />),
    remountRow: () => result.rerender(<Surface rowKey={1} />),
    next: () =>
      result.rerender(<Surface signal={new AbortController().signal} />),
  };
}
async function mutate(row: HTMLElement) {
  await act(async () => {
    row.style.paddingBottom = "1px";
  });
}

it("notifies reading after the revealed row is verified", async () => {
  const { row, complete } = mount();
  const positioned = vi.fn();
  row.parentElement?.addEventListener("reading-positioned", positioned);
  await frame(); // Attach observers.
  await frame(); // Reveal, but do not verify yet.
  expect(positioned).not.toHaveBeenCalled();
  await frame();
  expect(positioned).toHaveBeenCalledOnce();
  expect(complete).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "preserves moved focus before verification (mutation: %s)",
  async (mutation) => {
    const { row, outside, complete } = mount();
    await frame(); // Attach observers.
    await frame(); // Reveal, but do not verify yet.
    expect(document.activeElement).toBe(row);
    outside.focus();
    if (mutation) await mutate(row); // Cancel verification and schedule another reveal.
    await frame();
    await frame();
    expect(document.activeElement).toBe(outside);
    expect(complete).toHaveBeenCalledOnce();
    await mutate(row);
    expect(frames.size).toBe(0);
  },
);

it("preserves focus ownership through an effect restart, but a new request can focus", async () => {
  const { row, outside, complete, restart, next } = mount();
  await frame();
  await frame();
  expect(document.activeElement).toBe(row);
  outside.focus();
  restart();
  await frame();
  await frame();
  await frame();
  expect(document.activeElement).toBe(outside);
  expect(complete).toHaveBeenCalledOnce();
  next();
  await frame();
  await frame();
  await frame();
  expect(document.activeElement).toBe(row);
  expect(complete).toHaveBeenCalledTimes(2);
});

it("retries a focus attempt that did not acquire ownership", async () => {
  const { row, complete } = mount();
  const blocked = vi.spyOn(row, "focus").mockImplementation(() => {});
  await frame();
  await frame();
  await frame();
  expect(complete).not.toHaveBeenCalled();
  blocked.mockRestore();
  await mutate(row);
  await frame();
  await frame();
  expect(document.activeElement).toBe(row);
  expect(complete).toHaveBeenCalledOnce();
});

it.each(["inert", "hidden"])(
  "still requires visibility and admission after acquiring focus: %s",
  async (mode) => {
    const { row, outside, complete } = mount();
    await frame();
    await frame();
    outside.focus();
    const bounds = row.getBoundingClientRect();
    if (mode === "inert") row.setAttribute("inert", "");
    else
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
        ...bounds,
        height: 0,
      });
    await frame();
    expect(complete).not.toHaveBeenCalled();
    row.removeAttribute("inert");
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(bounds);
    await mutate(row);
    await frame();
    await frame();
    expect(document.activeElement).toBe(outside);
    expect(complete).toHaveBeenCalledOnce();
  },
);

it("cancels pending verification when the request is aborted", async () => {
  const { request, complete } = mount();
  await frame();
  await frame();
  request.abort();
  await frame();
  expect(frames.size).toBe(0);
  expect(complete).not.toHaveBeenCalled();
});

it.each([false, true])(
  "replaces the row without stealing moved focus (moved: %s)",
  async (moved) => {
    const { row, outside, complete, remountRow } = mount();
    await frame();
    await frame();
    expect(document.activeElement).toBe(row);
    if (moved) outside.focus();
    await act(async () => remountRow());
    const replacement = screen.getByText("Target");
    expect(replacement).not.toBe(row);
    expect(document.activeElement).toBe(moved ? outside : document.body);
    const focus = vi.spyOn(replacement, "focus");
    await frame();
    await frame();
    expect(document.activeElement).toBe(moved ? outside : replacement);
    expect(focus).toHaveBeenCalledTimes(moved ? 0 : 1);
    expect(complete).toHaveBeenCalledOnce();
    await mutate(replacement);
    expect(frames.size).toBe(0);
  },
);

it("completes after focus leaves another control between replacement reveal and verification", async () => {
  const { outside, complete, remountRow } = mount();
  await frame();
  await frame();
  outside.focus();
  await act(async () => remountRow());
  const replacement = screen.getByText("Target");
  const focus = vi.spyOn(replacement, "focus");
  await frame();
  expect(document.activeElement).toBe(outside);
  outside.blur();
  await frame();
  expect(document.activeElement).toBe(document.body);
  expect(focus).not.toHaveBeenCalled();
  expect(complete).toHaveBeenCalledOnce();
  expect(frames.size).toBe(0);
});

it("retries failed focus recovery on a replacement before completing", async () => {
  const { complete, remountRow } = mount();
  await frame();
  await frame();
  await act(async () => remountRow());
  const replacement = screen.getByText("Target");
  const blocked = vi.spyOn(replacement, "focus").mockImplementation(() => {});
  await frame();
  await frame();
  expect(document.activeElement).toBe(document.body);
  expect(complete).not.toHaveBeenCalled();
  blocked.mockRestore();
  await mutate(replacement);
  await frame();
  await frame();
  expect(document.activeElement).toBe(replacement);
  expect(complete).toHaveBeenCalledOnce();
});
