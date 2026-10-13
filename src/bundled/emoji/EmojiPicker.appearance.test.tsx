// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import { keypair } from "../../features/relay/testing";
import { EmojiPicker } from "./EmojiPicker";
import { createReactionPicker } from "./ReactionPicker";

const owners: ReturnType<typeof createRelaySession>[] = [];
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  document.documentElement.dataset.colorMode = "light";
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  delete document.documentElement.dataset.colorMode;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each(["dark", undefined] as const)(
  "preserves the surface theme across the emoji portal: %s",
  async (mode) => {
    const owner = createRelaySession({
      viewer: keypair().pubkey,
      relayAuthor: keypair().pubkey,
      media: (url) => url,
      query: async () => [],
    });
    owners.push(owner);
    render(
      <section data-color-mode={mode}>
        <EmojiPicker
          session={owner.session}
          scope="fixture"
          reaction
          disabled={false}
          insert={() => {}}
        />
      </section>,
    );
    const trigger = screen.getByRole("button", { name: "Add reaction" });
    expect(trigger.querySelector("svg")).toHaveClass("tabler-icon-mood-plus");
    fireEvent.click(trigger);
    const popup = await screen.findByRole("dialog", { name: "Emoji picker" });
    if (mode) {
      expect(popup).toHaveAttribute("data-color-mode", mode);
      expect(popup).toHaveClass(mode);
    } else {
      expect(popup).not.toHaveAttribute("data-color-mode");
      expect(popup).not.toHaveClass("dark");
    }
    await waitFor(() =>
      expect(popup.querySelector("em-emoji-picker")).toHaveAttribute(
        "theme",
        mode ?? "light",
      ),
    );
  },
);

it("uses smiley-plus for message reactions while leaving composer emoji unchanged", () => {
  const owner = createRelaySession({
    viewer: keypair().pubkey,
    relayAuthor: keypair().pubkey,
    media: (url) => url,
    query: async () => [],
  });
  owners.push(owner);
  const ReactionPicker = createReactionPicker();
  render(
    <>
      <ReactionPicker
        session={owner.session}
        scope="fixture"
        disabled={false}
        select={() => true}
      />
      <EmojiPicker
        session={owner.session}
        scope="fixture"
        disabled={false}
        insert={() => {}}
      />
    </>,
  );
  expect(
    screen.getByRole("button", { name: "Add reaction" }).querySelector("svg"),
  ).toHaveClass("tabler-icon-mood-plus");
  expect(
    screen.getByRole("button", { name: "Emoji and GIFS" }).querySelector("svg"),
  ).toHaveClass("tabler-icon-mood-smile");
});
