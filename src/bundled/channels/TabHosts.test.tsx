// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { PanelDock } from "../../features/panels/PanelDock";
import { TabSlot } from "./TabHosts";

afterEach(cleanup);

// The dock retains exit content after its last tab moves away. Its late
// cleanup must not detach content already claimed by the destination slot.
test("moving the last side tab retains its content after the closing dock retires", async () => {
  const node = document.createElement("div");
  node.textContent = "Thread and unfinished reply";
  function Fixture({ moved }: { moved: boolean }) {
    return (
      <>
        <section aria-label="Main pane">
          {moved && <TabSlot node={node} />}
        </section>
        <PanelDock open={!moved} className={undefined}>
          {!moved && <TabSlot node={node} />}
        </PanelDock>
      </>
    );
  }
  const view = render(<Fixture moved={false} />);
  expect(node.isConnected).toBe(true);
  view.rerender(<Fixture moved />);
  await waitFor(() =>
    expect(document.querySelector("[data-panel-dock]")).toBeNull(),
  );
  expect(screen.getByRole("region", { name: "Main pane" })).toContainElement(
    node,
  );
  expect(node).toBeVisible();
});
