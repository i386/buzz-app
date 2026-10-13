import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import type { Panels } from "../../features/panels/service";
import type { PagesReader } from "../../features/pages/service";
import { ChannelsPage, mediaReviewForDestination } from "./ChannelsPage";

// This is a shallow element-boundary test, not a React render. Navigation effects
// are exercised by the browser navigation journeys; do not execute them here.
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: () => {},
  useSyncExternalStore: (
    _subscribe: PagesReader["subscribe"],
    snapshot: PagesReader["snapshot"],
  ) => snapshot(),
}));
// Inspect the actual element returned at the workspace boundary, not a parallel
// key helper. React uses this key to decide whether to retain the subtree.
vi.mock("../../features/relay/react", async (original) => ({
  ...(await original<typeof import("../../features/relay/react")>()),
  useRelayConnection: (relay: RelayData) => relay.snapshot(),
}));
const pages = {
  subscribe: () => () => {},
  snapshot: () => [],
} as PagesReader;
function workspace(scope: string, generation: number) {
  const snapshot = { status: "ready", scope, generation } as RelaySnapshot;
  const relay = { snapshot: () => snapshot } as RelayData;
  const page = ChannelsPage({ relay, panels: {} as Panels, pages });
  return page.props.children as ReactElement<{ scope: string }>;
}

it("never carries a media review across channel navigation or resurrects it on return", () => {
  const review = { channelId: "alpha", messageId: "root", entryId: "visit-a" };
  expect(mediaReviewForDestination(review, "alpha", "visit-a")).toBe(review);
  expect(mediaReviewForDestination(review, "beta", "visit-a")).toBeUndefined();
  expect(mediaReviewForDestination(review, "alpha", "visit-b")).toBeUndefined();
  expect(
    mediaReviewForDestination(undefined, "alpha", "visit-a"),
  ).toBeUndefined();
});

it("distinguishes ready communities with the same connection generation", () => {
  const a = workspace("community-a:viewer", 1);
  const b = workspace("community-b:viewer", 1);
  expect(a.key).not.toBe(b.key);
  expect(a.props.scope).toBe("community-a:viewer");
  expect(b.props.scope).toBe("community-b:viewer");
});
it("distinguishes a replacement session within one scope without changing persisted intent keys", () => {
  const before = workspace("community-a:viewer", 1);
  const after = workspace("community-a:viewer", 2);
  expect(before.key).not.toBe(after.key);
  expect(before.props.scope).toBe(after.props.scope);
});
it("keeps the same workspace identity for updates within a session", () => {
  expect(workspace("community-a:viewer", 1).key).toBe(
    workspace("community-a:viewer", 1).key,
  );
});

it("the actual workspace receives session-bound authority, never the page's reusable authority", async () => {
  const { Context } = await import("@deepseek-ai/cordis");
  const { provideNavigation } = await import(
    "../../features/navigation/service"
  );
  const { provideRelay } = await import("../../features/relay/service");
  const ctx = new Context();
  const host = provideNavigation(ctx);
  const source = provideRelay(ctx);
  const relay: RelayData = {
    ...source,
    snapshot: () => ({ ...source.snapshot(), status: "ready" }),
  };
  try {
    const pending = host.navigation.open({
      version: 1,
      kind: "page",
      pluginId: "buzz.channels",
      pageId: "channels",
    });
    const parent = host.request(host.navigation.snapshot().attempt, {
      valid: () => true,
      subscribe: () => () => {},
    }).request;
    const rendered = ChannelsPage({
      relay,
      panels: {} as Panels,
      pages,
      navigation: parent,
    });
    const workspace = rendered.props.children as ReactElement<{
      navigation: typeof parent;
    }>;
    source.disconnect();
    expect(workspace.props.navigation.signal.aborted).toBe(true);
    expect(workspace.props.navigation.complete({ status: "opened" })).toBe(
      false,
    );
    expect(
      workspace.props.navigation.resolve({ version: 1, kind: "settings" }),
    ).toBe(false);
    expect(parent.signal.aborted).toBe(false);
    const replacement = ChannelsPage({
      relay,
      panels: {} as Panels,
      pages,
      navigation: parent,
    }).props.children as typeof workspace;
    expect(replacement.props.navigation.complete({ status: "opened" })).toBe(
      true,
    );
    expect(await pending).toEqual({ status: "opened" });
  } finally {
    await ctx.fiber.dispose();
  }
});
