import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Avatar } from "../../src/shared/design-system/ui/Avatar";
import "../../src/shared/styles/globals.css";

declare global {
  interface Window {
    avatarFixture: { setArtwork(url: string): void };
  }
}

// One shared avatar far below the fold, whose artwork the spec can swap.
function Fixture() {
  const [artwork, setArtwork] = useState("https://images.example/avatar.png");
  window.avatarFixture = { setArtwork };
  return (
    <main>
      <div style={{ height: "20000px" }} />
      <section aria-label="Avatars">
        <Avatar src={artwork} alt="A Brain identity" fallback="A Brain" />
      </section>
    </main>
  );
}
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
