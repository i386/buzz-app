// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ResizeHandle } from "./ResizeHandle";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// jsdom has no layout: a stub observer stands in for the browser and a
// controlled getBoundingClientRect supplies the panel's rendered width. The
// forced-layout count in a real browser is the perf harness's measurement.
test.each([1, -1] as const)(
  "direction %s measures the panel from its observer, not on every commit",
  (direction) => {
    let panelWidth = 260;
    const observed: Element[] = [];
    let notify = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe(element: Element) {
          observed.push(element);
        }
        disconnect = disconnect;
      },
    );
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => ({ width: panelWidth }) as DOMRect);
    let commit = () => {};
    function Workspace() {
      const [, bump] = useState(0);
      const [width, setWidth] = useState(260);
      commit = () => bump((count) => count + 1);
      const handle = (
        <ResizeHandle
          width={width}
          setWidth={setWidth}
          min={220}
          max={520}
          reset={() => setWidth(260)}
          label="Resize"
          direction={direction}
        />
      );
      return direction === 1 ? (
        <>
          <div data-testid="panel" />
          {handle}
        </>
      ) : (
        <section data-testid="panel">{handle}</section>
      );
    }
    const view = render(
      <StrictMode>
        <Workspace />
      </StrictMode>,
    );
    const handle = screen.getByRole("separator");
    expect(new Set(observed)).toEqual(new Set([screen.getByTestId("panel")]));
    expect(handle).toHaveAttribute("aria-valuenow", "260");
    for (let i = 0; i < 5; i++) act(commit);
    expect(rect).not.toHaveBeenCalled();

    panelWidth = 300;
    act(notify);
    expect(rect).toHaveBeenCalledTimes(1);
    expect(handle).toHaveAttribute("aria-valuenow", "300");

    // The width prop alone does not move the value; the rendered width does.
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle).toHaveAttribute("aria-valuenow", "300");
    panelWidth = 520;
    act(notify);
    expect(handle).toHaveAttribute("aria-valuenow", "520");

    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(2);
  },
);
