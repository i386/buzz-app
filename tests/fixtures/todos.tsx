import { CanvasConflictError } from "../../src/features/channel-templates/canvas-conflict";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import "../../src/shared/styles/globals.css";
import { createRelaySession } from "../../src/features/relay/session";
import { TodosPanel } from "../../src/bundled/todos/TodosPanel";
import type { RelayEvent } from "../../src/features/relay/events";
import { Button } from "../../src/shared/design-system/ui/Button";
const initial =
  "# Launch notes\n\nThis text is outside the todo list.\n\n## Todos\n\n- [ ] Review the first working version\n- [/] Build the In progress column\n- [ ] Try a longer task label that wraps naturally on a narrow screen without squashing the checkbox\n- [x] Keep the list readable without the plugin\n\n## Decisions\n\nKeep it simple.\n";
let head = {
  id: "preview-1",
  content: new URLSearchParams(location.search).has("empty") ? "" : initial,
  created_at: 0,
} as RelayEvent;
let revision = 1;
const canvas = {
  available: true,
  async read() {
    return head;
  },
  async save(_channel: string, content: string, expected: string | undefined) {
    if (expected !== head.id) throw new CanvasConflictError();
    if (head.created_at >= Math.floor(Date.now() / 1000))
      throw new Error("Please wait a second before saving Canvas again");
    head = {
      ...head,
      id: `preview-${++revision}`,
      content,
      created_at: Math.floor(Date.now() / 1000),
    };
    return head;
  },
};
const session = createRelaySession(null).session;
const members = ["a".repeat(64), "b".repeat(64)];
const list = {
  status: "ready" as const,
  channels: [{ id: "preview", name: "Preview", members }],
};
const people = {
  ...session,
  profiles: { ...session.profiles, ensure: async () => {} },
  channels: { ...session.channels, list: () => list },
  names: {
    ...session.names,
    resolve: (key: string) =>
      key === members[0] ? "Alex Fixture" : "Sam Fixture",
  },
};
function Preview() {
  const [open, setOpen] = useState(true);
  const [wide, setWide] = useState(false);
  const [large, setLarge] = useState(false);
  return (
    <main style={{ maxWidth: 1100, margin: "auto", padding: 24 }}>
      <div
        style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}
      >
        <Button
          onClick={() => {
            document.documentElement.dataset.colorMode =
              document.documentElement.dataset.colorMode === "dark"
                ? "light"
                : "dark";
          }}
        >
          Toggle theme
        </Button>
        <Button onClick={() => setOpen(!open)}>Toggle panel</Button>
        <Button onClick={() => setWide(!wide)}>Toggle width</Button>
        <Button
          onClick={() => {
            document.documentElement.style.fontSize = large ? "16px" : "24px";
            setLarge(!large);
          }}
        >
          Toggle text size
        </Button>
        <Button
          onClick={() => {
            head = {
              ...head,
              id: `preview-${++revision}`,
              content: `${head.content}\nExternal change.\n`,
            };
          }}
        >
          Simulate external edit
        </Button>
      </div>
      <p className="text-body-sm">
        Local preview only. No relay reads or writes.
      </p>
      <div
        style={{
          height: "75vh",
          width: wide ? "100%" : 380,
          maxWidth: "100%",
          marginTop: 16,
        }}
      >
        {open && (
          <TodosPanel
            canvas={canvas}
            people={people}
            context={{
              scope: "todos-fixture",
              channelId: "preview",
              channelName: "cheap-todo-plugin",
              viewer: "preview",
              relayUrl: "",
            }}
            close={() => setOpen(false)}
            active={() => true}
          />
        )}
      </div>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Preview />);
