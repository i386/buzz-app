import { expect, it } from "vitest";
import {
  acknowledge,
  conflict,
  emptySync,
  enqueue,
  mergeList,
  parseSync,
  type PendingOp,
  type SyncState,
} from "./known-communities";

const a = "wss://a.example";
const b = "wss://b.example:8443";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const op = (overrides: Partial<PendingOp> = {}): PendingOp => ({
  operationId: "00000000-0000-4000-8000-000000000000",
  url: a,
  expectedRevision: 0,
  removed: false,
  ...overrides,
});
const withKnown = (known: SyncState["known"]): SyncState => ({
  known,
  outbox: [],
});

it("queues one canonical operation per destination; a newer intent replaces it and inherits its fence", () => {
  const added = enqueue(emptySync(), a, false);
  expect(added.outbox).toEqual([
    {
      operationId: expect.stringMatching(uuid),
      url: a,
      expectedRevision: 0,
      removed: false,
    },
  ]);
  const removed = enqueue(added, a, true);
  expect(removed.outbox).toHaveLength(1);
  expect(removed.outbox[0]).toMatchObject({
    url: a,
    expectedRevision: 0,
    removed: true,
  });
  expect(removed.outbox[0]?.operationId).not.toBe(added.outbox[0]?.operationId);
  // Another destination keeps its own operation.
  const both = enqueue(removed, b, false);
  expect(both.outbox.map((entry) => entry.url)).toEqual([a, b]);
  expect(enqueue(both, a, false).outbox.map((entry) => entry.url)).toEqual([
    b,
    a,
  ]);
});

it("fences a never-synced removal on revision 0 and a re-add on the tombstone's revision", () => {
  expect(enqueue(emptySync(), a, true).outbox[0]).toMatchObject({
    expectedRevision: 0,
    removed: true,
  });
  const tombstoned = withKnown({ [a]: { revision: 4, removed: true } });
  expect(enqueue(tombstoned, a, false).outbox[0]).toMatchObject({
    expectedRevision: 4,
    removed: false,
  });
  // A replacement inherits the pending fence even once the record moved on.
  const pending = enqueue(
    withKnown({ [a]: { revision: 2, removed: false } }),
    a,
    true,
  );
  const moved: SyncState = {
    ...pending,
    known: { [a]: { revision: 3, removed: false } },
  };
  expect(enqueue(moved, a, false).outbox[0]?.expectedRevision).toBe(2);
});

it("acknowledges by storing the record and dropping the settled operation", () => {
  const queued = enqueue(emptySync(), a, false);
  const sent = queued.outbox[0];
  if (!sent) throw new Error("expected a queued operation");
  const settled = acknowledge(queued, sent, { revision: 1, removed: false });
  expect(settled).toEqual({
    known: { [a]: { revision: 1, removed: false } },
    outbox: [],
  });
  // Acknowledging an operation that was already replaced never resurrects it.
  const other = enqueue(settled, b, true);
  expect(
    acknowledge(other, sent, { revision: 1, removed: false }).outbox,
  ).toEqual(other.outbox);
});

it("merges an acknowledgement into a newer pending intent: dropped when satisfied, rebased when not", () => {
  const queued = enqueue(emptySync(), a, false);
  const sent = queued.outbox[0];
  if (!sent) throw new Error("expected a queued operation");
  // The user removed it while the add was in flight; the add landed as revision 1.
  const removing = enqueue(queued, a, true);
  const rebased = acknowledge(removing, sent, { revision: 1, removed: false });
  expect(rebased.known).toEqual({ [a]: { revision: 1, removed: false } });
  expect(rebased.outbox).toEqual([
    { ...removing.outbox[0], expectedRevision: 1 },
  ]);
  // Re-added again while the add was in flight: the record already says so.
  const readding = enqueue(removing, a, false);
  const satisfied = acknowledge(readding, sent, {
    revision: 1,
    removed: false,
  });
  expect(satisfied.outbox).toEqual([]);
});

it("lets the server win a conflict: adopts its record, drops the intent and names the divergence", () => {
  const queued = enqueue(emptySync(), a, false);
  const sent = queued.outbox[0];
  if (!sent) throw new Error("expected a queued operation");
  const removedElsewhere = conflict(queued, sent, {
    revision: 2,
    removed: true,
  });
  expect(removedElsewhere).toEqual({
    state: { known: { [a]: { revision: 2, removed: true } }, outbox: [] },
    divergence: "removed-elsewhere",
  });
  const leaving = enqueue(
    withKnown({ [a]: { revision: 2, removed: false } }),
    a,
    true,
  );
  const leaveOp = leaving.outbox[0];
  if (!leaveOp) throw new Error("expected a queued operation");
  const addedElsewhere = conflict(leaving, leaveOp, {
    revision: 3,
    removed: false,
  });
  expect(addedElsewhere.divergence).toBe("added-elsewhere");
  expect(addedElsewhere.state.outbox).toEqual([]);
  // A record that already satisfies the refused intent is not a divergence.
  expect(
    conflict(queued, sent, { revision: 5, removed: false }).divergence,
  ).toBeNull();
  // A newer local intent still resolves the destination; it is rebased, not reported.
  const readding = enqueue(leaving, a, false);
  const pendingWins = conflict(readding, leaveOp, {
    revision: 3,
    removed: true,
  });
  expect(pendingWins.divergence).toBeNull();
  expect(pendingWins.state.outbox).toEqual([
    { ...readding.outbox[0], expectedRevision: 3 },
  ]);
});

it("forgets a destination the server never held and drops the refused intent", () => {
  const stale = withKnown({
    [a]: { revision: 2, removed: false },
    [b]: { revision: 1, removed: false },
  });
  const leaving = enqueue(stale, a, true);
  const leaveOp = leaving.outbox[0];
  if (!leaveOp) throw new Error("expected a queued operation");
  expect(conflict(leaving, leaveOp)).toEqual({
    state: { known: { [b]: { revision: 1, removed: false } }, outbox: [] },
    divergence: null,
  });
  // A newer intent waits on revision 0 since nothing is recorded any more.
  const readding = enqueue(leaving, a, false);
  expect(conflict(readding, leaveOp).state.outbox).toEqual([
    { ...readding.outbox[0], expectedRevision: 0 },
  ]);
});

it("merges a server list: adds, removes, keeps pending intents and uploads unsynced memberships", () => {
  const state: SyncState = {
    known: {
      [b]: { revision: 1, removed: false },
      "wss://stale.example": { revision: 1, removed: false },
    },
    outbox: [],
  };
  const memberships = [
    { id: "primary" }, // alias of https://primary.example, unknown to the server
    { id: "https://b.example:8443" },
    { id: "https://gone.example" },
  ];
  const merged = mergeList(state, memberships, [
    { url: "wss://new.example", revision: 1, removed: false },
    { url: b, revision: 2, removed: false },
    { url: "wss://gone.example", revision: 3, removed: true },
    { url: "wss://old.example", revision: 2, removed: true },
  ]);
  expect(merged.add).toEqual(["wss://new.example"]);
  expect(merged.remove).toEqual(["wss://gone.example"]);
  expect(merged.state.known).toEqual({
    "wss://new.example": { revision: 1, removed: false },
    [b]: { revision: 2, removed: false },
    "wss://gone.example": { revision: 3, removed: true },
    "wss://old.example": { revision: 2, removed: true },
  });
  expect(merged.state.outbox).toEqual([
    {
      operationId: expect.stringMatching(uuid),
      url: "wss://primary.example",
      expectedRevision: 0,
      removed: false,
    },
  ]);
});

it("defers to pending intents when merging: no add over a queued removal, no removal over a queued re-add, no duplicate upload", () => {
  const removing = enqueue(
    withKnown({ [a]: { revision: 1, removed: false } }),
    a,
    true,
  );
  const readding = enqueue(
    withKnown({ [b]: { revision: 2, removed: true } }),
    b,
    false,
  );
  const state: SyncState = {
    known: {},
    outbox: [
      ...removing.outbox,
      ...readding.outbox,
      ...enqueue(emptySync(), "wss://primary.example", false).outbox,
    ],
  };
  const merged = mergeList(
    state,
    [{ id: "https://b.example:8443" }, { id: "primary" }],
    [
      { url: a, revision: 1, removed: false },
      { url: b, revision: 2, removed: true },
    ],
  );
  expect(merged.add).toEqual([]);
  expect(merged.remove).toEqual([]);
  expect(merged.state.outbox).toEqual(state.outbox);
});

it("reads old or malformed saved sync fields as empty and drops malformed entries one by one", () => {
  expect(parseSync(undefined)).toEqual(emptySync());
  expect(parseSync("sync")).toEqual(emptySync());
  expect(parseSync({ known: [], outbox: {} })).toEqual(emptySync());
  const good = op();
  // Parsed, not literal: a literal `__proto__` key would set the prototype
  // instead of the own property a stored record carries.
  const known = JSON.parse(
    JSON.stringify({
      [a]: { revision: 1, removed: false },
      "https://b.example": { revision: 1, removed: false },
      [b]: { revision: -1, removed: false },
      "wss://c.example": { revision: 1.5, removed: false },
      "wss://d.example": { revision: 1, removed: "yes" },
    }).replace("}}", '},"__proto__":{"revision":1,"removed":false}}'),
  );
  expect(Object.hasOwn(known, "__proto__")).toBe(true);
  expect(
    parseSync({
      known,
      outbox: [
        good,
        { ...good, url: "https://a.example" },
        { ...good, operationId: 7 },
        null,
      ],
    }),
  ).toEqual({
    known: { [a]: { revision: 1, removed: false } },
    outbox: [good],
  });
  expect(Object.hasOwn(parseSync({ known }).known, "__proto__")).toBe(false);
});
