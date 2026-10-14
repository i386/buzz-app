import { expect, it, vi } from "vitest";
import type { MemoryEntry, MemoryListing } from "../agents/memory";
import type { RelaySession } from "../relay/session";
import { MemoryReads, coreMemorySection, coreOf } from "./core-memory";

const agent = "a".repeat(64);
const core: MemoryEntry = {
  slug: "core",
  body: "I am Claude.",
  eventId: "e".repeat(64),
  createdAt: 1,
};
const listing = (
  entries: readonly MemoryEntry[],
  partial = false,
): MemoryListing => ({ entries, partial });

/** A session whose reads wait until the test settles them. They ignore their
 * abort signal, as the native reader does while it waits on the host. */
function session() {
  const pending: ((value: MemoryListing) => void)[] = [];
  const read = vi.fn(
    () =>
      new Promise<MemoryListing>((resolve) => {
        pending.push(resolve);
      }),
  );
  return {
    read,
    settle: (index: number, value: MemoryListing) => pending[index]?.(value),
    session: { agentMemories: { read } } as unknown as RelaySession,
  };
}

it("shares a read between concurrent callers, and reads again once it settles", async () => {
  const s = session();
  const reads = new MemoryReads();
  const first = reads.read(s.session, agent, new AbortController().signal);
  const second = reads.read(s.session, agent, new AbortController().signal);
  expect(s.read).toHaveBeenCalledTimes(1);
  s.settle(0, listing([core]));
  await expect(Promise.all([first, second])).resolves.toEqual([
    listing([core]),
    listing([core]),
  ]);
  const later = reads.read(s.session, agent, new AbortController().signal);
  expect(s.read).toHaveBeenCalledTimes(2);
  s.settle(1, listing([]));
  await expect(later).resolves.toEqual(listing([]));
});

it("does not share a read that started before a write", async () => {
  const s = session();
  const reads = new MemoryReads();
  const stale = reads.read(s.session, agent, new AbortController().signal);
  reads.forget(s.session, agent);
  const fresh = reads.read(s.session, agent, new AbortController().signal);
  const shared = reads.read(s.session, agent, new AbortController().signal);
  expect(s.read).toHaveBeenCalledTimes(2);
  // The stale read settling first must not drop the fresh one.
  s.settle(0, listing([core]));
  await stale;
  reads.read(s.session, agent, new AbortController().signal);
  expect(s.read).toHaveBeenCalledTimes(2);
  const renamed = listing([{ ...core, body: "I am Claude, renamed." }]);
  s.settle(1, renamed);
  await expect(Promise.all([fresh, shared])).resolves.toEqual([
    renamed,
    renamed,
  ]);
});

it("stops waiting when the caller aborts, even if the read does not", async () => {
  const s = session();
  const reads = new MemoryReads();
  const controller = new AbortController();
  const waiting = reads.read(s.session, agent, controller.signal);
  const other = reads.read(s.session, agent, new AbortController().signal);
  controller.abort(new Error("turn ended"));
  await expect(waiting).rejects.toThrow("turn ended");
  s.settle(0, listing([core]));
  await expect(other).resolves.toEqual(listing([core]));
  await expect(
    reads.read(s.session, agent, AbortSignal.abort()),
  ).rejects.toThrow();
  expect(s.read).toHaveBeenCalledTimes(1);
});

it("finds core memory, none, or nothing certain in a partial listing", () => {
  expect(coreOf(listing([core]))).toBe("I am Claude.");
  expect(coreOf(listing([core], true))).toBe("I am Claude.");
  expect(coreOf(listing([]))).toBeNull();
  expect(coreOf(listing([], true))).toBeUndefined();
});

it("shows core memory, prompts for one when there is none, and omits unknown", () => {
  expect(coreMemorySection(" I am Claude.\n")).toBe(
    "<core-memory>\nI am Claude.\n</core-memory>",
  );
  expect(coreMemorySection(null)).toContain("No core memory found.");
  expect(coreMemorySection(undefined)).toBe("");
  expect(coreMemorySection("  ")).toBe("");
});
