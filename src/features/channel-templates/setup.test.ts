// @vitest-environment jsdom
import { afterEach, beforeEach, assert, expect, it, vi } from "vitest";
import { createChannelSetup, type ChannelCreationInput } from "./setup";
import type { Outbox, OutgoingEvent } from "../relay/outbox";
import { keypair, metadata, roster, signed } from "../relay/testing";
import { createRelaySession } from "../relay/session";
import { matchesEvent } from "../relay/projection";
import type { ReadFilter, RelayEvent } from "../relay/events";

const viewer = keypair();
const agent = keypair().pubkey;
const input: ChannelCreationInput = {
  name: "Daily",
  visibility: "private",
  setup: {
    agents: [agent],
    canvas: "# Plan",
    groupId: "work",
    templateId: "daily",
  },
};
beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _key: string,
        _opts: unknown,
        run: (lock: object) => unknown,
      ) => run({}),
    },
  });
});
afterEach(() => {
  Reflect.deleteProperty(navigator, "locks");
  vi.restoreAllMocks();
});
function fixture() {
  const events: OutgoingEvent[] = [];
  let clock = 1_700_000_000;
  let canvas: string | undefined;
  const outbox: Outbox = {
    snapshot: () => events,
    subscribe: () => () => {},
    observeSend: () => () => {},
    ready: async () => {},
    recover: async () => {},
    acknowledge: async () => {},
    supports: () => true,
    send: vi.fn((value) => {
      const event = signed(viewer, { ...value, created_at: clock++ });
      events.push({ event, delivery: "accepted" });
      return event.id;
    }),
    retry: vi.fn(),
    dismiss: vi.fn(async (id: string) => {
      const index = events.findIndex((item) => item.event.id === id);
      if (index >= 0) events.splice(index, 1);
    }),
  };
  const opts = {
    scope: "setup-test",
    changed: vi.fn(),
    outbox,
    local: outbox,
    create: vi.fn((id: string, _input: ChannelCreationInput) =>
      outbox.send({ kind: 9007, content: "", tags: [["h", id]] }),
    ),
    delivered: vi.fn(async (_id: string, _active?: () => boolean) => {}),
    confirm: vi.fn(async (id: string) => {
      if (events.find((e) => e.event.id === id)?.event.kind === 40100)
        canvas = id;
    }),
    refresh: vi.fn(async (_id: string, _member: string) => {}),
    canvasHead: vi.fn(async () => canvas),
    place: vi.fn(async (_id: string, _group: string) => {}),
    preflight: vi.fn(async (_input: ChannelCreationInput) => {}),
    signal: new AbortController().signal,
  };
  return {
    opts,
    events,
    outbox,
    setup: createChannelSetup(opts),
    setCanvas: (id: string) => {
      canvas = id;
    },
  };
}

function receipts() {
  return Object.keys(localStorage).filter((key) =>
    key.startsWith("buzz-channel-setup.v2:setup-test:"),
  );
}
function firstReceipt() {
  const key = receipts()[0];
  assert.exists(key);
  return key;
}
function hold() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.each([true, false])(
  "confirms a setup seed against the writer without replay (writer visible: %s)",
  async (visible) => {
    const relay = keypair();
    const events: RelayEvent[] = [];
    const published: RelayEvent[] = [];
    const query = vi.fn(async (filters: readonly ReadFilter[]) =>
      events.filter((event) =>
        filters.some(
          (filter) =>
            matchesEvent(event, filter) &&
            (event.kind !== 40100 ||
              (visible && filter.consistency === "strong")),
        ),
      ),
    );
    const owner = createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        scope: "https://setup.example.test",
        media: () => undefined,
        query,
        channelKit: { prepare: async () => "", decode: async () => [] },
        writer: {
          kinds: [9007, 40100],
          sign: async (template) => signed(viewer, template),
          publish: async (event) => {
            published.push(event);
            events.push(event);
            if (event.kind === 9007) {
              const id = event.tags.find(([tag]) => tag === "h")?.[1];
              assert.exists(id);
              events.push(
                metadata(relay, id, "Daily"),
                roster(relay, id, [viewer.pubkey]),
              );
            }
          },
        },
      },
      { outboxStorage: { load: async () => [], save: async () => {} } },
    );
    try {
      const id = await owner.session.channelCreation.create({
        name: "Daily",
        visibility: "open",
        setup: { canvas: "# Plan", agents: [], groupId: "", templateId: "" },
      });
      const receipt = `buzz-channel-setup.v2:https://setup.example.test:${viewer.pubkey}:${id}`;
      if (visible) {
        await vi.waitFor(() =>
          expect(localStorage.getItem(receipt)).toBeNull(),
        );
        expect(owner.session.channelCreation.notices()).toEqual([]);
        expect(owner.session.outbox?.snapshot()).toEqual([]);
      } else {
        await vi.waitFor(() =>
          expect(owner.session.channelCreation.notices()).toEqual([
            expect.objectContaining({
              id,
              error: expect.stringContaining(
                "awaiting exact relay confirmation",
              ),
            }),
          ]),
        );
        expect(
          JSON.parse(localStorage.getItem(receipt) ?? "null"),
        ).toMatchObject({
          canvasDone: false,
        });
      }
      // Receipt retirement / completion failure is the barrier: confirmation
      // must not republish even when the writer cannot prove the accepted seed.
      expect(published.map((event) => event.kind)).toEqual([9007, 40100]);
      const seed = published[1];
      assert.exists(seed);
      const exact = query.mock.calls.flatMap(([filters]) =>
        filters.filter((filter) => filter.ids?.includes(seed.id)),
      );
      // Outbox delivery may also observe by ID; this pins setup's separate,
      // fresh confirmation read rather than incidental background read counts.
      expect(exact).toContainEqual({
        ids: [seed.id],
        limit: 1,
        consistency: "strong",
      });
    } finally {
      owner.dispose();
    }
  },
);

it("opens after confirmed creation, before Canvas completes; places independently and never sends a message", async () => {
  const f = fixture();
  const gate = hold();
  const reached = hold();
  const confirm = f.opts.confirm.getMockImplementation();
  f.opts.confirm.mockImplementation(async (id) => {
    reached.release();
    await gate.promise;
    await confirm?.(id);
  });
  const run = f.setup.run(input, viewer.pubkey);
  const id = await run.admission;
  await reached.promise;
  expect(f.opts.place).toHaveBeenCalledWith(id, "work");
  expect(f.events.map((e) => e.event.kind)).toEqual([9007, 40100]);
  expect(f.events[1]?.event.tags).toEqual([
    ["h", id],
    ["expected-revision", "none"],
  ]);
  expect(receipts()).toHaveLength(1);
  gate.release();
  await run.completion;
  expect(f.opts.confirm).toHaveBeenCalledTimes(2);
  expect(receipts()).toHaveLength(0);
});

it("keeps partial intent without locking a second Create or replaying the first member", async () => {
  const f = fixture();
  f.opts.refresh.mockImplementation(async (_id, member) => {
    if (member === agent) throw new Error("Roster not confirmed");
  });
  const run = f.setup.run(input, viewer.pubkey);
  const failure = expect(run.completion).rejects.toThrow(
    "Roster not confirmed",
  );
  const id = await run.admission;
  await failure;
  const frozen = localStorage.getItem(firstReceipt());
  expect(f.events.map((e) => e.event.kind)).toEqual([9007, 40100, 9000]);
  const next = f.setup.run(
    { name: "Second", visibility: "open" },
    viewer.pubkey,
  );
  expect(await next.admission).not.toBe(id);
  await next.completion;
  expect(localStorage.getItem(firstReceipt())).toBe(frozen);
  expect(f.outbox.retry).not.toHaveBeenCalled();
});

it("checks an uncertain attempt without replaying Create or template writes", async () => {
  const f = fixture();
  f.opts.delivered.mockRejectedValueOnce(new Error("Unknown delivery"));
  const run = f.setup.run(input, viewer.pubkey);
  await expect(run.admission).rejects.toThrow("Unknown delivery");
  await expect(run.completion).rejects.toThrow("Unknown delivery");
  expect(f.setup.snapshot()).toEqual(input);
  const saved = JSON.parse(localStorage.getItem(firstReceipt()) ?? "null");
  const next = f.setup.run(input, viewer.pubkey);
  await expect(next.admission).resolves.toBe(saved.id);
  await expect(next.completion).rejects.toThrow(
    "Template setup was not continued",
  );
  expect(f.opts.delivered.mock.calls).toEqual([
    [saved.operations.create],
    [saved.operations.create, expect.any(Function)],
  ]);
  expect(f.setup.snapshot()).toBeUndefined();
  expect(f.events.map((e) => e.event.kind)).toEqual([9007]);
  expect(f.outbox.retry).not.toHaveBeenCalled();
});

it("retires a proven-failed Create so the form can try a new attempt", async () => {
  const f = fixture();
  f.opts.delivered.mockImplementationOnce(async (id) => {
    const index = f.events.findIndex((item) => item.event.id === id);
    assert.exists(f.events[index]);
    f.events[index] = { ...f.events[index], delivery: "failed" };
    throw new Error("Rejected");
  });
  const run = f.setup.run(input, viewer.pubkey);
  await expect(run.admission).rejects.toThrow("Rejected");
  await expect(run.completion).rejects.toThrow("Rejected");
  expect(f.setup.snapshot()).toBeUndefined();
  expect(receipts()).toHaveLength(0);
  const next = f.setup.run(input, viewer.pubkey);
  await next.admission;
  await next.completion;
  expect(f.opts.create).toHaveBeenCalledTimes(2);
});

it("Canvas failure does not lose group placement or turn admission into failure", async () => {
  const f = fixture();
  f.opts.confirm.mockRejectedValue(new Error("Canvas unconfirmed"));
  const run = f.setup.run(input, viewer.pubkey);
  const failure = expect(run.completion).rejects.toThrow("Canvas unconfirmed");
  const id = await run.admission;
  await failure;
  expect(f.opts.place).toHaveBeenCalledWith(id, "work");
  expect(f.events.map((e) => e.event.kind)).toEqual([9007, 40100]);
  expect(receipts()).toHaveLength(1);
});

it.each(["failed", "unknown"] as const)(
  "keeps seed recovery observe-only and dismisses only a proven conflict (%s)",
  async (delivery) => {
    const f = fixture();
    f.opts.confirm.mockImplementation(async (id) => {
      const index = f.events.findIndex((item) => item.event.id === id);
      assert.exists(f.events[index]);
      f.events[index] = {
        ...f.events[index],
        delivery,
        error: "conflict: the relay state changed",
      };
      f.setCanvas("other-editor");
      throw new Error("conflict: the relay state changed");
    });
    const run = f.setup.run(input, viewer.pubkey);
    const failure = expect(run.completion).rejects.toThrow(
      delivery === "failed"
        ? /Canvas changed.*no agents were added/
        : /conflict:/,
    );
    await run.admission;
    await failure;
    expect(f.opts.canvasHead).toHaveBeenCalledTimes(1);
    expect(await f.opts.canvasHead()).toBe("other-editor");
    expect(f.outbox.retry).not.toHaveBeenCalled();
    expect(
      vi.mocked(f.outbox.send).mock.calls.map(([event]) => event.kind),
    ).toEqual([9007, 40100]);
    expect(f.events.map((item) => item.event.kind)).toEqual(
      delivery === "failed" ? [9007] : [9007, 40100],
    );
    expect(f.outbox.dismiss).toHaveBeenCalledTimes(
      delivery === "failed" ? 1 : 0,
    );
    const saved = JSON.parse(localStorage.getItem(firstReceipt()) ?? "null");
    expect(saved.created).toBe(true);
    expect(saved.canvasDone).toBe(false);
    expect(saved.added).toEqual([]);
  },
);

it("group failure does not skip Canvas and members; retains the incomplete destination", async () => {
  const f = fixture();
  f.opts.place.mockRejectedValue(new Error("Group unavailable"));
  const run = f.setup.run(input, viewer.pubkey);
  const failure = expect(run.completion).rejects.toThrow("Group unavailable");
  await run.admission;
  await failure;
  expect(f.events.map((e) => e.event.kind)).toEqual([9007, 40100, 9000]);
  expect(receipts()).toHaveLength(1);
});

it("leaves historical/corrupt records untouched and never lets them occupy a fresh form", async () => {
  const f = fixture();
  localStorage.setItem("buzz-channel-setup.v1:setup-test", "broken");
  localStorage.setItem(
    "buzz-channel-setup.v1:setup-test:channel:old",
    "frozen old intent",
  );
  const run = f.setup.run({ name: "Fresh", visibility: "open" }, viewer.pubkey);
  await run.admission;
  await run.completion;
  expect(localStorage.getItem("buzz-channel-setup.v1:setup-test")).toBe(
    "broken",
  );
  expect(
    localStorage.getItem("buzz-channel-setup.v1:setup-test:channel:old"),
  ).toBe("frozen old intent");
});

it("bounds record count and UTF-8 bytes before enqueue without evicting unresolved intent", async () => {
  const f = fixture();
  for (let i = 0; i < 256; i++)
    localStorage.setItem(`buzz-channel-setup.v2:setup-test:${i}`, "old");
  const run = f.setup.run(input, viewer.pubkey);
  await expect(run.admission).rejects.toThrow("Too many unfinished");
  await expect(run.completion).rejects.toThrow("Too many unfinished");
  expect(f.events).toHaveLength(0);
  expect(receipts()).toHaveLength(256);
  localStorage.clear();
  localStorage.setItem(
    "buzz-channel-setup.v2:setup-test:old",
    "é".repeat(1024 * 1024),
  );
  const next = f.setup.run(input, viewer.pubkey);
  await expect(next.admission).rejects.toThrow("Too many unfinished");
  await expect(next.completion).rejects.toThrow("Too many unfinished");
  expect(f.events).toHaveLength(0);
  expect(receipts()).toHaveLength(1);
});

it("checks saved growth and preserves the last receipt when storage fails", async () => {
  const f = fixture();
  const original = Storage.prototype.setItem;
  let saved: string | undefined;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    if (saved) throw new Error("Storage full");
    saved = value;
    original.call(this, key, value);
  });
  const run = f.setup.run(input, viewer.pubkey);
  await expect(run.admission).rejects.toThrow("Storage full");
  await expect(run.completion).rejects.toThrow("Storage full");
  expect(localStorage.getItem(firstReceipt())).toBe(saved);
  expect(f.opts.delivered).not.toHaveBeenCalled();
  expect(f.events.map((e) => e.event.kind)).toEqual([9007]);
  expect(f.outbox.dismiss).not.toHaveBeenCalled();
});

it("does not retire intent if Outbox dismissal did not actually remove the operation", async () => {
  const f = fixture();
  vi.mocked(f.outbox.dismiss).mockResolvedValue();
  const run = f.setup.run(input, viewer.pubkey);
  const failure = expect(run.completion).rejects.toThrow(
    "could not be retired",
  );
  await run.admission;
  await failure;
  expect(receipts()).toHaveLength(1);
});

it("shares one admission while preflight is pending, including concurrent submits", async () => {
  const f = fixture();
  const gate = hold();
  f.opts.preflight.mockImplementationOnce(() => gate.promise);
  const run = f.setup.run(input, viewer.pubkey);
  const concurrent = f.setup.run(input, viewer.pubkey);
  expect(concurrent).toBe(run);
  gate.release();
  expect(await concurrent.admission).toBe(await run.admission);
  await run.completion;
  expect(f.opts.create).toHaveBeenCalledOnce();
});

it("releases a pending attempt when read-only confirmation proves it failed", async () => {
  const f = fixture();
  f.opts.delivered.mockRejectedValueOnce(new Error("Timed out"));
  const run = f.setup.run(input, viewer.pubkey);
  await expect(run.admission).rejects.toThrow("Timed out");
  await expect(run.completion).rejects.toThrow("Timed out");
  f.opts.delivered.mockImplementationOnce(async (id) => {
    const index = f.events.findIndex((item) => item.event.id === id);
    assert.exists(f.events[index]);
    f.events[index] = { ...f.events[index], delivery: "failed" };
    throw new Error("Rejected");
  });
  const check = f.setup.run(input, viewer.pubkey);
  await expect(check.admission).rejects.toThrow("Rejected");
  await expect(check.completion).rejects.toThrow("Rejected");
  expect(f.setup.snapshot()).toBeUndefined();
  expect(receipts()).toHaveLength(0);
  expect(f.opts.create).toHaveBeenCalledOnce();
});

it("keeps admitted partial receipts out of a restarted Create without resuming them", async () => {
  const f = fixture();
  f.opts.confirm.mockRejectedValueOnce(new Error("Canvas unavailable"));
  const run = f.setup.run(input, viewer.pubkey);
  const id = await run.admission;
  await expect(run.completion).rejects.toThrow("Canvas unavailable");
  const frozen = localStorage.getItem(firstReceipt());
  const restarted = createChannelSetup(f.opts);
  expect(restarted.owns(id)).toBe(true);
  expect(restarted.snapshot()).toBeUndefined();
  expect(localStorage.getItem(firstReceipt())).toBe(frozen);
  expect(f.events.map((e) => e.event.kind)).toEqual([9007, 40100]);
  expect(f.outbox.retry).not.toHaveBeenCalled();
});
