// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { usePanelSplit } from "./usePanelSplit";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Controlled container measurements exercise the hook's clamp and observer
// lifecycle. Pointer hit targets and actual grid geometry stay in browser tests.
test.each([undefined, { defaultWidth: 420, maxRatio: 0.5 }])(
  "optional primary sizing %s preserves widths and existing defaults",
  (primary) => {
    let available = 960;
    let measure = () => {};
    const disconnect = vi.fn();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      () => available,
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        callback: () => void;
        constructor(callback: () => void) {
          this.callback = callback;
        }
        // The handle observes its own panel; track only the container.
        observe(element: HTMLElement) {
          if (element.dataset.testid !== "workspace") return;
          measure = this.callback;
          this.disconnect = disconnect;
        }
        disconnect() {}
      },
    );
    function Workspace() {
      const split = usePanelSplit(undefined, 316, primary);
      return (
        <div ref={split.ref} style={split.style} data-testid="workspace">
          <section>{split.handle}</section>
        </div>
      );
    }
    const view = render(
      <StrictMode>
        <Workspace />
      </StrictMode>,
    );
    const handle = screen.getByRole("separator");
    const workspace = screen.getByTestId("workspace");
    const width = () =>
      workspace.style.getPropertyValue("--secondary-panel-width");
    expect(width()).toBe(primary ? "540px" : "");
    expect(handle).toHaveAttribute("aria-valuemin", primary ? "480" : "316");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(width()).toBe(primary ? "480px" : "316px");
    fireEvent.keyDown(handle, { key: "End" });
    expect(width()).toBe("640px");
    available = 720;
    act(measure);
    expect(width()).toBe("400px");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(width()).toBe(primary ? "360px" : "316px");
    fireEvent.doubleClick(handle);
    expect(width()).toBe(primary ? "360px" : "");
    available = 1200;
    act(measure);
    expect(width()).toBe(primary ? "780px" : "");
    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(2);
  },
);
