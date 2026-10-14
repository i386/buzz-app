// STOPGAP(agent-local-typing): delete with local-typing.ts.
import { afterEach, expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import type { RelaySession } from "../relay/session";
import { typeLocally } from "./local-typing";

const agent = "a".repeat(64);
const root = "b".repeat(64);
const mention = {
  id: "c".repeat(64),
  pubkey: "d".repeat(64),
  kind: 9,
  created_at: 1,
  content: "@Agent hi",
  tags: [
    ["h", "channel"],
    ["e", root, "", "reply"],
  ],
} as unknown as RelayEvent;

afterEach(() => vi.useRealTimers());
/** A community whose Me holds `personal`; `local` takes each pulse. */
const community = (
  local: () => void,
  personal: readonly string[] = [],
  placement: { status: string; refresh?: () => Promise<void> } = {
    status: "ready",
  },
) =>
  ({
    typing: { local },
    mePlacement: {
      snapshot: () => placement,
      refresh: placement.refresh,
      has: (id: string) =>
        placement.status === "ready" && personal.includes(id),
    },
  }) as unknown as RelaySession;

it("pulses in the mention's thread every three seconds until stopped", () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const local = vi.fn();
  const stop = typeLocally(() => community(local), agent, mention, "channel");
  expect(local).toHaveBeenCalledExactlyOnceWith({
    id: "",
    pubkey: agent,
    kind: 20002,
    created_at: 10,
    content: "",
    tags: [
      ["h", "channel"],
      ["e", root, "", "root"],
      ["e", mention.id, "", "reply"],
    ],
  });
  vi.advanceTimersByTime(3_000);
  expect(local).toHaveBeenCalledTimes(2);
  expect(local.mock.lastCall?.[0].created_at).toBe(13);
  stop();
  // Stopping ends it at once, then nothing more is sent.
  expect(local).toHaveBeenCalledTimes(3);
  expect(local.mock.lastCall?.[0]).toMatchObject({
    kind: 9,
    tags: local.mock.calls[0]?.[0].tags,
  });
  vi.advanceTimersByTime(9_000);
  expect(local).toHaveBeenCalledTimes(3);
});

it("skips pulses while the community is not ready, and stops if one throws", () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let session: RelaySession | undefined;
  const local = vi.fn(() => {
    throw new Error("closed");
  });
  typeLocally(() => session, agent, mention, "channel");
  session = community(local);
  vi.advanceTimersByTime(3_000);
  expect(local).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(9_000);
  expect(local).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledOnce();
  warn.mockRestore();
});

it("types in a Me chat itself, ending only when its last turn stops", () => {
  vi.useFakeTimers();
  const local = vi.fn();
  const session = () => community(local, ["channel"]);
  const first = typeLocally(session, agent, mention, "channel");
  const other = { ...mention, id: "e".repeat(64), tags: [["h", "channel"]] };
  const second = typeLocally(session, agent, other, "channel");
  expect(local.mock.calls.map(([event]) => event.tags)).toEqual([
    [["h", "channel"]],
    [["h", "channel"]],
  ]);
  first();
  first();
  // The other turn is still working, so nothing ends it yet.
  expect(local.mock.calls.map(([event]) => event.kind)).toEqual([20002, 20002]);
  vi.advanceTimersByTime(3_000);
  expect(local.mock.lastCall?.[0].kind).toBe(20002);
  second();
  expect(local.mock.lastCall?.[0]).toMatchObject({
    kind: 9,
    tags: [["h", "channel"]],
  });
});

it("waits for a first placement read, as its turn does, before choosing where to type", async () => {
  vi.useFakeTimers();
  const local = vi.fn();
  let read!: () => void;
  // One read in flight, joined by every caller, as the kit's is.
  const pending = new Promise<void>((resolve) => {
    read = () => {
      placement.status = "ready";
      resolve();
    };
  });
  const placement = { status: "loading", refresh: vi.fn(() => pending) };
  const session = community(local, ["channel"], placement);
  const stop = typeLocally(() => session, agent, mention, "channel");
  const early = typeLocally(() => session, agent, mention, "channel");
  early();
  expect(local).not.toHaveBeenCalled();
  read();
  await vi.advanceTimersByTimeAsync(0);
  expect(local).toHaveBeenCalledOnce();
  // In the chat itself, not the mention's thread; the stopped one never showed.
  expect(local.mock.lastCall?.[0]).toMatchObject({
    kind: 20002,
    tags: [["h", "channel"]],
  });
  stop();
  expect(local.mock.lastCall?.[0].kind).toBe(9);
});
