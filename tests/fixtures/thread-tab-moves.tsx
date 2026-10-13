import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TabSlot } from "../../src/bundled/channels/TabHosts";
import { PanelDock } from "../../src/features/panels/PanelDock";

// Native reparenting scroll resets need a real browser. Keep both panes equal
// so message rewrap cannot conceal or cause the transfer's offset failure.
const node = document.createElement("div");
node.innerHTML =
  '<div data-message-scroller style="height:200px;overflow:auto"><div style="height:1000px">Thread reader</div></div>';
function Transfers() {
  const [main, setMain] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setMain(!main)}>
        Move thread
      </button>
      <section aria-label="Main pane" style={{ width: 400, height: 200 }}>
        {main && <TabSlot node={node} />}
      </section>
      <PanelDock open={!main} className={undefined}>
        {!main && (
          <section style={{ width: 400, height: 200 }}>
            <TabSlot node={node} />
          </section>
        )}
      </PanelDock>
    </>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Fixture root unavailable");
createRoot(root).render(<Transfers />);
