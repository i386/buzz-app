import { expect, it } from "vitest";
import {
  acknowledge,
  emptySync,
  enqueue,
  mergeList,
  parseSync,
  type SyncState,
} from "./known-communities";

const a = "wss://a.example";
const b = "wss://b.example:8443";
const withKnown = (...known: string[]): SyncState => ({ known, outbox: [] });

it("keeps one latest intent per destination: a newer intent replaces the older one", () => {
  const added = enqueue(emptySync(), a, false);
  expect(added.outbox).toEqual([{ url: a, removed: false }]);
  // Leaving while the add may be in flight replaces it: whichever of the two
  // idempotent edits lands last is the state, and the removal is the intent.
  const removed = enqueue(added, a, true);
  expect(removed.outbox).toEqual([{ url: a, removed: true }]);
  // Another destination keeps its own place; a replaced intent moves to the end.
  const both = enqueue(removed, b, false);
  expect(enqueue(both, a, false).outbox).toEqual([
    { url: b, removed: false },
    { url: a, removed: false },
  ]);
});

it("queues nothing when the latest word on the destination already says so", () => {
  // A saved community the service already holds: re-running its join.
  const present = withKnown(a);
  expect(enqueue(present, a, false)).toBe(present);
  // The same intent as the one pending.
  const adding = enqueue(emptySync(), a, false);
  expect(enqueue(adding, a, false)).toBe(adding);
  const leaving = enqueue(adding, a, true);
  expect(enqueue(leaving, a, true)).toBe(leaving);
  // Removing a destination the service is not known to hold still queues:
  // another device may have saved it, and the removal is idempotent.
  expect(enqueue(emptySync(), a, true).outbox).toEqual([
    { url: a, removed: true },
  ]);
});

it("acknowledges by moving the destination in or out of the known set and dropping the settled intent", () => {
  const queued = enqueue(enqueue(emptySync(), a, false), b, true);
  const added = acknowledge(queued, { url: a, removed: false });
  expect(added).toEqual({ known: [a], outbox: [{ url: b, removed: true }] });
  const removed = acknowledge(added, { url: b, removed: true });
  expect(removed).toEqual({ known: [a], outbox: [] });
  // Acknowledging again changes nothing: the set already agrees.
  expect(acknowledge(removed, { url: a, removed: false })).toEqual(removed);
  expect(acknowledge(removed, { url: b, removed: true })).toEqual(removed);
  expect(acknowledge(withKnown(a, b), { url: a, removed: true }).known).toEqual(
    [b],
  );
});

it("keeps an intent that replaced the acknowledged one while it was in flight", () => {
  const sent = { url: a, removed: false };
  // The user left while the add was in flight; the add landed.
  const leaving = enqueue(enqueue(emptySync(), a, false), a, true);
  const landed = acknowledge(leaving, sent);
  expect(landed).toEqual({ known: [a], outbox: [{ url: a, removed: true }] });
  // The removal then lands too, and the set follows.
  expect(acknowledge(landed, { url: a, removed: true })).toEqual(emptySync());
  // Changed their mind twice: the intent is the add that landed.
  const rejoined = enqueue(leaving, a, false);
  expect(acknowledge(rejoined, sent)).toEqual({ known: [a], outbox: [] });
});

it.each([
  { name: "join, lost acknowledgement, leave", first: false },
  { name: "leave, lost acknowledgement, rejoin", first: true },
])(
  "converges on the latest intent after $name: the retry simply sends the newer intent",
  ({ first }) => {
    const start = first ? withKnown(a) : emptySync();
    const intended = enqueue(start, a, first);
    expect(intended.outbox).toEqual([{ url: a, removed: first }]);
    // The service applied it but its answer never arrived; the user then
    // changed their mind. Only the newer intent remains to send, and it is
    // idempotent against whatever the service holds.
    const changed = enqueue(intended, a, !first);
    expect(changed.outbox).toEqual([{ url: a, removed: !first }]);
    const done = acknowledge(changed, { url: a, removed: !first });
    expect(done).toEqual({ known: first ? [a] : [], outbox: [] });
  },
);

it("merges a server list: adds, removes what was removed elsewhere, uploads unsynced memberships", () => {
  const state = withKnown(b, "wss://gone.example", "wss://stale.example");
  const memberships = [
    { id: "primary" }, // alias of https://primary.example, unknown to the server
    { id: "https://b.example:8443" },
    { id: "https://gone.example" },
  ];
  const merged = mergeList(state, memberships, ["wss://new.example", b]);
  expect(merged.add).toEqual(["wss://new.example"]);
  // Known before and no longer listed: removed elsewhere. A destination the
  // service never held is not a removal, nor is one that is not saved here.
  expect(merged.remove).toEqual(["wss://gone.example"]);
  expect(merged.state).toEqual({
    known: ["wss://new.example", b],
    outbox: [{ url: "wss://primary.example", removed: false }],
  });
});

it("defers to the pending intent when merging: no add over a queued removal, no removal over a queued re-add, no duplicate upload", () => {
  const state: SyncState = {
    known: [b],
    outbox: [
      { url: a, removed: true },
      { url: b, removed: false },
      { url: "wss://primary.example", removed: false },
    ],
  };
  const merged = mergeList(
    state,
    [{ id: "https://b.example:8443" }, { id: "primary" }],
    [a],
  );
  expect(merged.add).toEqual([]);
  expect(merged.remove).toEqual([]);
  expect(merged.state).toEqual({ known: [a], outbox: state.outbox });
});

it("reads old or malformed saved sync fields as empty and drops malformed entries one by one", () => {
  expect(parseSync(undefined)).toEqual(emptySync());
  expect(parseSync("sync")).toEqual(emptySync());
  expect(parseSync({ known: "a", outbox: {} })).toEqual(emptySync());
  expect(
    parseSync({
      known: [a, "https://b.example", a, 7, null],
      outbox: [
        { url: a, removed: false },
        { url: "https://a.example", removed: true },
        { url: b, removed: "yes" },
        { removed: true },
        null,
      ],
    }),
  ).toEqual({ known: [a], outbox: [{ url: a, removed: false }] });
});

it("normalises the shape saved before the set model: live records are known, tombstones are not, and a destination keeps its newest operation", () => {
  const op = (url: string, removed: boolean, operationId: string) => ({
    operationId,
    url,
    expectedRevision: 1,
    removed,
  });
  // Parsed, not literal: a literal `__proto__` key would set the prototype
  // instead of the own property a stored record carries.
  const known = JSON.parse(
    JSON.stringify({
      "wss://d.example": "record",
      [a]: { revision: 1, removed: false },
      "wss://gone.example": { revision: 3, removed: true },
      "https://c.example": { revision: 1, removed: false },
    }).replace(/}}$/, '},"__proto__":{"revision":1,"removed":false}}'),
  );
  expect(Object.hasOwn(known, "__proto__")).toBe(true);
  expect(
    parseSync({
      known,
      outbox: [
        op(a, false, "1"),
        op(b, false, "2"),
        op(a, true, "3"),
        op("https://b.example", true, "4"),
      ],
    }),
  ).toEqual({
    known: [a],
    outbox: [
      { url: b, removed: false },
      { url: a, removed: true },
    ],
  });
});
