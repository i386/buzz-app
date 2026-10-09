// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { App } from "./App";
import { createServices, type AppServices } from "./services";
import { composerDOMFixture } from "../features/messages/composer-testing";

composerDOMFixture();

// jsdom has no IndexedDB; nothing is sent here.
vi.mock("../features/relay/outbox-storage", () => ({
  browserOutboxStorage: () => ({ load: () => [], save: () => {} }),
}));
vi.mock("../bundled", async () => ({
  bundledPlugins: [
    {
      manifest: { id: "buzz.channels", name: "Channels", apiVersion: 1 },
      module: await import("../bundled/channels"),
    },
  ],
}));
const viewer = "6".repeat(64);
const origin = "https://community.example";
const other = "https://other.example";
const scoped = {
  version: 1 as const,
  kind: "settings" as const,
  section: "appearance",
  scope: { viewer, communityOrigin: origin },
};
const channels = {
  version: 1,
  kind: "page",
  pluginId: "buzz.channels",
  pageId: "channels",
  scope: null,
};
let services: AppServices | undefined;
afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

/** The app open on a Settings card scoped to the selected community. */
async function setup() {
  // jsdom has no media queries; responsive shell geometry is covered in browsers.
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Local name", picture: "" },
      memberships: [
        { id: origin, name: "Fixture community" },
        { id: other, name: "Other community" },
      ],
      selected: origin,
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/identity")) return Response.json({ viewer });
      if (url.endsWith("/session"))
        return Response.json({
          viewer,
          relayAuthor: viewer,
          relayUrl: decodeURIComponent(url.split("/").at(-2) ?? ""),
        });
      if (url.endsWith("/query")) return Response.json([]);
      return Response.json({});
    }),
  );
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(JSON.stringify(scoped))}`,
  );
  services = createServices();
  const current = services;
  render(
    <StrictMode>
      <App services={current} />
    </StrictMode>,
  );
  await waitFor(() =>
    expect(current.navigation.snapshot()).toMatchObject({
      status: "opened",
      entry: { target: scoped },
    }),
  );
  expect(current.communities.snapshot().selected).toBe(origin);
  return current;
}

it.each([
  {
    name: "a leave on this device",
    forget: (current: AppServices, id: string) => current.communities.leave(id),
  },
  {
    name: "a removal synced from another device",
    forget: (current: AppServices, id: string) =>
      current.communities.applySync(
        { known: [], outbox: [] },
        { remove: [`wss://${new URL(id).host}`] },
      ),
  },
])(
  "a selection dropped by $name lands on Channels as clicking Personal space would; another community going does not move the page",
  async ({ forget }) => {
    const current = await setup();
    await act(async () => {
      await forget(current, other);
    });
    expect(current.communities.snapshot().memberships.map((m) => m.id)).toEqual(
      [origin],
    );
    expect(current.communities.snapshot().selected).toBe(origin);
    expect(current.navigation.snapshot().entry.target).toEqual(scoped);
    await act(async () => {
      await forget(current, origin);
    });
    expect(current.communities.snapshot().selected).toBeNull();
    await waitFor(() =>
      expect(current.navigation.snapshot()).toMatchObject({
        status: "opened",
        entry: { target: channels },
      }),
    );
  },
);
