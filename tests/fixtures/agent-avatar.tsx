import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { AgentAvatar } from "../../src/features/agents/AgentAvatar";
import { Avatar } from "../../src/shared/design-system/ui/Avatar";
import "../../src/shared/styles/globals.css";

function Fixture() {
  const [thinking, setThinking] = useState(false);
  const [picture, setPicture] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const [remount, setRemount] = useState("");
  return (
    <main style={{ padding: 40 }}>
      <button type="button" onClick={() => setThinking(!thinking)}>
        Toggle thinking
      </button>
      <button
        type="button"
        onClick={() => setPicture("https://images.example/agent-fallback.png")}
      >
        Load picture
      </button>
      <button
        type="button"
        onClick={() =>
          setPicture(
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=",
          )
        }
      >
        Load cached picture
      </button>
      <button
        type="button"
        onClick={() => {
          flushSync(() => setGeneration(generation + 1));
          // Observe synchronously, before load events can conceal a blank first paint.
          const images = [
            ...document.querySelectorAll<HTMLImageElement>("section img"),
          ];
          setRemount(
            JSON.stringify(
              images.map((image) => ({
                complete: image.complete,
                opacity: getComputedStyle(image).opacity,
              })),
            ),
          );
        }}
      >
        Remount avatars
      </button>
      <output aria-label="Avatars immediately after remount">{remount}</output>
      {[22, 40].map((size) => (
        <section
          key={size}
          aria-label={`${size}px avatars`}
          style={{ display: "flex", gap: 24, padding: 24 }}
        >
          <div style={{ width: size, height: size }}>
            <AgentAvatar
              key={generation}
              alt="Agent"
              fallback="A"
              size="fill"
              shape="squircle"
              working={thinking}
              statusBadge="online"
              src={picture}
            />
          </div>
          <div style={{ width: size, height: size }}>
            <Avatar alt="Reference" fallback="A" size="fill" shape="squircle" />
          </div>
        </section>
      ))}
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
