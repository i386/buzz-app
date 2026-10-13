// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render as mount,
  screen,
} from "@testing-library/react";
afterEach(() => {
  cleanup();
});
import { renderToStaticMarkup } from "react-dom/server";
import type { RelaySession } from "../../features/relay/session";
import { LiveStatus } from "./LiveStatus";

type Snapshot = ReturnType<RelaySession["live"]["snapshot"]>;
const channel = {
  id: "channel:a",
  channelId: "a",
  status: "live",
  replay: "unknown",
} as const;
const base: Snapshot = {
  status: "connected",
  routes: [channel],
  roster: { state: "verified" },
  heads: [],
};
function render(
  patch: Partial<Snapshot> = {},
  partialRoster = false,
  diagnostics = false,
) {
  const snapshot: Snapshot = { ...base, ...patch };
  const live = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
  };
  const component = (
    <LiveStatus
      live={live}
      channelId="a"
      partialRoster={partialRoster}
      diagnostics={diagnostics}
    />
  );
  if (diagnostics) return renderToStaticMarkup(component);
  cleanup();
  mount(component);
  return screen.queryByRole("status")?.textContent ?? "";
}
it.each<Partial<Snapshot>>([
  {},
  { status: "connecting", routes: [] },
  { routes: [] },
  { routes: [{ ...channel, status: "pending" }] },
  {
    routes: [channel, { id: "profiles", status: "pending", replay: "unknown" }],
  },
  { heads: [{ channelId: "a", state: "deferred" }] },
])(
  "does not turn ordinary setup into a yellow recovery warning: %j",
  async (patch) => {
    expect(await render(patch)).toBe("");
  },
);
it("reports clean connection progress in diagnostics without a retry action", async () => {
  expect(
    await render({ routes: [{ ...channel, status: "pending" }] }, false, true),
  ).toContain("connecting");
  expect(await render({}, false, true)).toContain("stream established");
  expect(await render({ status: "connecting" }, false, true)).not.toContain(
    "button",
  );
});
it.each<Partial<Snapshot>>([
  { status: "error" },
  { status: "retrying" },
  { status: "unavailable" },
  { error: "Socket refused" },
  { routes: [{ ...channel, status: "limited" }] },
  { routes: [{ ...channel, status: "error" }] },
  { heads: [{ channelId: "a", state: "error", error: "Head read failed" }] },
  { roster: { state: "error", error: "Roster refused" } },
  { roster: { state: "deferred" } },
])("retains recovery for degraded coverage or failures: %j", async (patch) => {
  expect(await render(patch)).toContain("Retry live updates");
});
it.each(["channel", "global"])(
  "keeps bounded pending %s quota recovery in Diagnostics only",
  async (owner) => {
    const error = "rate-limited: quota exceeded; retry in 2s";
    const routes: Snapshot["routes"] =
      owner === "channel"
        ? [{ ...channel, status: "pending", error }]
        : [
            channel,
            { id: "profiles", status: "pending", replay: "unknown", error },
          ];
    expect(await render({ routes })).toBe("");
    const diagnostics = await render({ routes }, false, true);
    expect(diagnostics).toContain("recovering automatically");
    expect(diagnostics).toContain(`Last rejection: ${error}`);
    expect(diagnostics).not.toContain("stream established");
  },
);
const quota = "rate-limited: quota exceeded; retry in 4s";
const recovering = { ...channel, status: "pending", error: quota } as const;
it.each<Partial<Snapshot>>([
  { error: "Socket control failed" },
  { status: "retrying" },
  { roster: { state: "error", error: quota } },
  { heads: [{ channelId: "a", state: "error", error: `ReadError: ${quota}` }] },
  {
    routes: [
      recovering,
      {
        id: "profiles",
        status: "error",
        replay: "unknown",
        error: "Profile stream stopped",
      },
    ],
  },
  { routes: [{ ...channel, status: "error", error: quota }] },
  {
    routes: [
      {
        ...channel,
        status: "pending",
        error: "rate-limited: shared admission unavailable",
      },
    ],
  },
  {
    routes: [
      {
        ...channel,
        status: "pending",
        error: "rate-limited: quota exceeded; retry in 61s",
      },
    ],
  },
  {
    routes: [
      { ...channel, status: "pending", error: "rate-limited: quota exceeded" },
    ],
  },
])(
  "does not hide actionable or unsupported failures behind automatic recovery: %j",
  async (patch) => {
    const html = await render({ routes: [recovering], ...patch });
    expect(html).toContain("Retry live updates");
    expect(html).not.toContain("retry in 4s");
  },
);
it("a recovering global cannot hide a selected channel failure", async () => {
  expect(
    await render({
      routes: [
        { ...channel, status: "error", error: "Selected stream stopped" },
        { id: "profiles", status: "pending", replay: "unknown", error: quota },
      ],
    }),
  ).toContain("Selected stream stopped");
});
it("keeps partial roster coverage visible even with healthy established routes", async () => {
  expect(await render({}, true)).toContain("Some channels are missing");
  expect(await render({}, true)).toContain("Retry live updates");
  expect(await render({ routes: [recovering] }, true)).toContain(
    "Some channels are missing",
  );
});

it.each(["pending"] as const)(
  "keeps partial roster coverage quiet while discovery is %s",
  async (state) => {
    expect(await render({ roster: { state } }, true)).toBe("");
    expect(await render({ roster: { state } }, true, true)).not.toContain(
      "Some channels are missing",
    );
  },
);
it.each(["error", "deferred"] as const)(
  "offers roster recovery when partial discovery is %s",
  async (state) => {
    const notice = await render({ roster: { state } }, true);
    expect(notice).toContain("Channel list needs refreshing.");
    expect(notice).toContain("Retry live updates");
  },
);
it.each<Partial<Snapshot>>([{ error: "Socket refused" }])(
  "pending partial discovery does not hide another failure: %j",
  async (patch) => {
    const notice = await render(
      { ...patch, roster: { state: "pending" } },
      true,
    );
    expect(notice).toContain("Retry live updates");
    expect(notice).not.toContain("Some channels are missing");
  },
);

it("diagnostics does not duplicate notices; changing the selected channel/session replaces recovery ownership", async () => {
  const oldRetry = vi.fn();
  const retry = vi.fn();
  const live = (channelId: string, action: () => void) => {
    const snapshot: Snapshot = {
      ...base,
      routes: [{ ...channel, channelId, status: "error" }],
    };
    return {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      retry: action,
    };
  };
  const oldSession = live("a", oldRetry);
  const newSession = live("b", retry);
  const content = (
    session: typeof oldSession,
    channelId: string,
    visible = true,
  ) => (
    <>
      {visible && (
        <>
          <LiveStatus
            live={session}
            channelId={channelId}
            partialRoster={false}
            diagnostics
          />
          <LiveStatus
            live={session}
            channelId={channelId}
            partialRoster={false}
          />
        </>
      )}
    </>
  );
  const view = mount(content(oldSession, "a"));
  expect(screen.getAllByRole("status")).toHaveLength(1);
  view.rerender(content(newSession, "b"));
  expect(screen.getAllByRole("status")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry live updates" }));
  expect(retry).toHaveBeenCalledOnce();
  expect(oldRetry).not.toHaveBeenCalled();
  view.rerender(content(newSession, "b", false));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
