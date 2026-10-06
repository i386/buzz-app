import { expect, it } from "vitest";
import {
  acknowledge,
  conflict,
  emptySync,
  enqueue,
  heads,
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
const head = (state: SyncState, url = a) => {
  const found = heads(state.outbox).find((entry) => entry.url === url);
  if (!found) throw new Error(`expected a head for ${url}`);
  return found;
};

it("keeps the head and queues a newer intent behind it; a newer one again replaces only the queued intent", () => {
  const added = enqueue(emptySync(), a, false);
  expect(added.outbox).toEqual([
    {
      operationId: expect.stringMatching(uuid),
      url: a,
      expectedRevision: 0,
      removed: false,
    },
  ]);
  const sent = head(added);
  // The head may be in flight, so leaving does not touch it; the removal
  // waits behind it with the revision the head would produce.
  const removed = enqueue(added, a, true);
  expect(removed.outbox).toEqual([
    sent,
    {
      operationId: expect.stringMatching(uuid),
      url: a,
      expectedRevision: 1,
      removed: true,
    },
  ]);
  expect(removed.outbox[1]?.operationId).not.toBe(sent.operationId);
  // Another destination keeps its own head in between.
  const both = enqueue(removed, b, false);
  expect(both.outbox.map((entry) => entry.url)).toEqual([a, a, b]);
  // Rejoining replaces the waiting removal, never the head.
  const readded = enqueue(both, a, false);
  expect(readded.outbox.map((entry) => [entry.url, entry.removed])).toEqual([
    [a, false],
    [b, false],
    [a, false],
  ]);
  expect(readded.outbox[0]).toBe(sent);
  expect(readded.outbox[2]?.operationId).not.toBe(
    removed.outbox[1]?.operationId,
  );
  expect(heads(readded.outbox)).toEqual([sent, both.outbox[2]]);
});

it("queues nothing when the latest word on the destination already says so", () => {
  // A saved community the service already holds: re-running its join.
  const present = withKnown({ [a]: { revision: 3, removed: false } });
  expect(enqueue(present, a, false)).toBe(present);
  // The same intent as the head, or as the intent waiting behind it.
  const adding = enqueue(emptySync(), a, false);
  expect(enqueue(adding, a, false)).toBe(adding);
  const leaving = enqueue(adding, a, true);
  expect(enqueue(leaving, a, true)).toBe(leaving);
  // A tombstone already says removed; nothing to tell the service.
  const gone = withKnown({ [a]: { revision: 2, removed: true } });
  expect(enqueue(gone, a, true)).toBe(gone);
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
  // The head keeps its fence once the record moves on; the queued intent's
  // fence is provisional until the head settles.
  const pending = enqueue(
    withKnown({ [a]: { revision: 2, removed: false } }),
    a,
    true,
  );
  const moved: SyncState = {
    ...pending,
    known: { [a]: { revision: 3, removed: false } },
  };
  expect(
    enqueue(moved, a, false).outbox.map((entry) => entry.expectedRevision),
  ).toEqual([2, 3]);
});

it("acknowledges by storing the record and dropping the settled operation", () => {
  const queued = enqueue(emptySync(), a, false);
  const sent = head(queued);
  const settled = acknowledge(queued, sent, { revision: 1, removed: false });
  expect(settled).toEqual({
    known: { [a]: { revision: 1, removed: false } },
    outbox: [],
  });
  // Acknowledging an operation that was already settled changes nothing else.
  const other = enqueue(settled, b, true);
  expect(
    acknowledge(other, sent, { revision: 1, removed: false }).outbox,
  ).toEqual(other.outbox);
});

it("settles the queued intent with the head: dropped when the record satisfies it, rebased when not", () => {
  const queued = enqueue(emptySync(), a, false);
  const sent = head(queued);
  // The user left while the add was in flight; the add landed as revision 1.
  const removing = enqueue(queued, a, true);
  const rebased = acknowledge(removing, sent, { revision: 1, removed: false });
  expect(rebased.known).toEqual({ [a]: { revision: 1, removed: false } });
  expect(rebased.outbox).toEqual([
    { ...removing.outbox[1], expectedRevision: 1 },
  ]);
  // Rejoined again while the add was in flight: the record already says so.
  const readding = enqueue(removing, a, false);
  const satisfied = acknowledge(readding, sent, {
    revision: 1,
    removed: false,
  });
  expect(satisfied.outbox).toEqual([]);
});

it.each([
  { name: "join, lost acknowledgement, leave", first: false },
  { name: "leave, lost acknowledgement, rejoin", first: true },
])(
  "converges on the latest intent after $name: the replayed head settles, then the queued intent goes as a fresh edit",
  ({ first }) => {
    const start = first
      ? withKnown({ [a]: { revision: 1, removed: false } })
      : emptySync();
    const intended = enqueue(start, a, first);
    const sent = head(intended);
    // The service applied the head but its answer never arrived; the user
    // then changed their mind. The replay answers for the head as applied.
    const changed = enqueue(intended, a, !first);
    expect(heads(changed.outbox)).toEqual([sent]);
    const applied = { revision: sent.expectedRevision + 1, removed: first };
    const replayed = acknowledge(changed, sent, applied);
    expect(replayed.known).toEqual({ [a]: applied });
    expect(replayed.outbox).toEqual([
      {
        operationId: expect.stringMatching(uuid),
        url: a,
        expectedRevision: applied.revision,
        removed: !first,
      },
    ]);
    const next = head(replayed);
    expect(next.operationId).not.toBe(sent.operationId);
    const done = acknowledge(replayed, next, {
      revision: applied.revision + 1,
      removed: !first,
    });
    expect(done).toEqual({
      known: { [a]: { revision: applied.revision + 1, removed: !first } },
      outbox: [],
    });
  },
);

it("lets the server win a conflict: adopts its record, drops the intent and names the divergence", () => {
  const queued = enqueue(emptySync(), a, false);
  const sent = head(queued);
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
  const leaveOp = head(leaving);
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
});

it("reports no divergence while an intent waits behind the refused head: it is rebased or already satisfied", () => {
  const leaving = enqueue(
    withKnown({ [a]: { revision: 2, removed: false } }),
    a,
    true,
  );
  const leaveOp = head(leaving);
  const readding = enqueue(leaving, a, false);
  // Removed elsewhere meanwhile: the rejoin goes again on the new revision.
  const pendingWins = conflict(readding, leaveOp, {
    revision: 3,
    removed: true,
  });
  expect(pendingWins.divergence).toBeNull();
  expect(pendingWins.state.outbox).toEqual([
    { ...readding.outbox[1], expectedRevision: 3 },
  ]);
  // Added elsewhere meanwhile: the record already says what the rejoin wants.
  const agreed = conflict(readding, leaveOp, { revision: 3, removed: false });
  expect(agreed.divergence).toBeNull();
  expect(agreed.state.outbox).toEqual([]);
});

it("forgets a destination the server never held and drops the refused intent", () => {
  const stale = withKnown({
    [a]: { revision: 2, removed: false },
    [b]: { revision: 1, removed: false },
  });
  const leaving = enqueue(stale, a, true);
  const leaveOp = head(leaving);
  expect(conflict(leaving, leaveOp)).toEqual({
    state: { known: { [b]: { revision: 1, removed: false } }, outbox: [] },
    divergence: null,
  });
  // A waiting intent goes on revision 0 since nothing is recorded any more.
  const readding = enqueue(leaving, a, false);
  expect(conflict(readding, leaveOp).state.outbox).toEqual([
    { ...readding.outbox[1], expectedRevision: 0 },
  ]);
});

it("settles every operation for the destination, so a duplicate can never stay behind", () => {
  const sent = op();
  const duplicated: SyncState = {
    known: {},
    outbox: [sent, op({ url: b }), { ...sent }, op({ operationId: "x" })],
  };
  expect(
    acknowledge(duplicated, sent, { revision: 1, removed: false }).outbox,
  ).toEqual([op({ url: b })]);
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

it("defers to the newest pending intent when merging: no add over a queued removal, no removal over a queued re-add, no duplicate upload", () => {
  // A removal waiting behind an unsettled add still speaks for its destination.
  const removing = enqueue(enqueue(emptySync(), a, false), a, true);
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

it("reads a destination's first and last saved operations as its head and queued intent, dropping the rest", () => {
  const first = op({ operationId: "1".repeat(8).padEnd(36, "0") });
  const middle = op({ operationId: "2".repeat(36), removed: true });
  const last = op({ operationId: "3".repeat(36) });
  const other = op({ operationId: "4".repeat(36), url: b });
  expect(parseSync({ outbox: [first, middle, other, last] }).outbox).toEqual([
    first,
    other,
    last,
  ]);
  expect(heads([first, other, last])).toEqual([first, other]);
});
