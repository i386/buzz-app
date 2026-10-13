import { expect, it } from "vitest";
import {
  STORAGE_KEY,
  TEAMS_KEY,
  readOne,
  readRecords,
  recordKey,
  readTeams,
  setAttention,
  removeRecord,
  splitLegacyRecords,
  writeRecord,
  writeTeams,
  type AgentRecord,
} from "./store";
import { memoryStorage } from "./test-fakes";

const pubkey = "a".repeat(64);
const record: AgentRecord = {
  pubkey,
  attention: {},
  config: { word: "hi" },
};

it("round-trips records and drops attention objects a reader would ignore", () => {
  const storage = memoryStorage();
  const saved = setAttention(
    record,
    "interest/default",
    { type: "interest", instructions: "Be brief." },
    7,
  );
  writeRecord(storage, saved);
  expect(readRecords(storage)).toEqual({ [pubkey]: saved });
  const stored = JSON.parse(storage.getItem(recordKey(pubkey)) as string);
  stored.attention["watch/bad"] = {
    slug: "watch/bad",
    value: { type: "event" },
    modifiedAt: 1,
  };
  storage.setItem(recordKey(pubkey), JSON.stringify(stored));
  storage.setItem(recordKey("nonsense"), JSON.stringify(record));
  const read = readRecords(storage);
  expect(read[pubkey]?.attention).toEqual(saved.attention);
  expect(read).not.toHaveProperty("nonsense");
  // The invalid object is reported, and written back as it was.
  expect(read[pubkey]?.skipped?.["watch/bad"]).toMatchObject({
    value: { type: "event" },
    problem: expect.stringMatching(/Missing/),
  });
  writeRecord(storage, read[pubkey] as AgentRecord);
  expect(
    JSON.parse(storage.getItem(recordKey(pubkey)) as string).attention[
      "watch/bad"
    ],
  ).toEqual({ slug: "watch/bad", value: { type: "event" }, modifiedAt: 1 });
  // Fixing it moves it back to the attention it applies.
  const fixed = setAttention(read[pubkey] as AgentRecord, "watch/bad", null);
  expect(fixed.skipped).toEqual({});
});

it("keeps each agent's record under its own key and moves the old shared value", () => {
  const storage = memoryStorage();
  const other = "b".repeat(64);
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 1,
      agents: { [pubkey]: record, [other]: { ...record, pubkey: other } },
    }),
  );
  expect(Object.keys(readRecords(storage)).sort()).toEqual([pubkey, other]);
  expect(readOne(storage, other)?.pubkey).toBe(other);
  // Saved records win over the old shared value.
  writeRecord(storage, { ...record, config: { word: "new" } });
  expect(readRecords(storage)[pubkey]?.config).toEqual({ word: "new" });
  splitLegacyRecords(storage, readRecords(storage));
  expect(storage.getItem(STORAGE_KEY)).toBeNull();
  expect(readOne(storage, other)?.pubkey).toBe(other);
  // Writing one record leaves another program's record alone.
  storage.setItem(recordKey(other), "sentinel");
  writeRecord(storage, { ...record, config: { word: "newer" } });
  expect(storage.getItem(recordKey(other))).toBe("sentinel");
  // A record that did not change is not written again.
  const writes: string[] = [];
  const watched = Object.assign(Object.create(storage), {
    setItem: (key: string, value: string) => {
      writes.push(key);
      storage.setItem(key, value);
    },
  });
  writeRecord(watched, { ...record, config: { word: "newer" } });
  expect(writes).toEqual([]);
  // A removed record is gone.
  removeRecord(storage, other);
  expect(storage.getItem(recordKey(other))).toBeNull();
});

it("saves attention only as on; absent or anything else reads as off", () => {
  const storage = memoryStorage();
  for (const saved of [
    { ...record, attentionEnabled: true },
    { ...record, pubkey: "b".repeat(64) },
    { ...record, pubkey: "c".repeat(64), attentionEnabled: false },
  ] as AgentRecord[])
    writeRecord(storage, saved);
  const read = readRecords(storage);
  expect(read[pubkey]?.attentionEnabled).toBe(true);
  expect(read["b".repeat(64)]).not.toHaveProperty("attentionEnabled");
  expect(read["c".repeat(64)]).not.toHaveProperty("attentionEnabled");
});

it("skips objects over the count limit in slug order, and refuses to add more", () => {
  const storage = memoryStorage();
  const attention = Object.fromEntries(
    Array.from({ length: 101 }, (_, n) => {
      const slug = `interest/i${String(n).padStart(3, "0")}`;
      return [
        slug,
        { slug, value: { type: "interest", instructions: "x" }, modifiedAt: 1 },
      ];
    }),
  );
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 1,
      agents: { [pubkey]: { ...record, attention } },
    }),
  );
  const read = readRecords(storage)[pubkey] as AgentRecord;
  expect(Object.keys(read.attention)).toHaveLength(100);
  expect(Object.keys(read.skipped ?? {})).toEqual(["interest/i100"]);
  const { "interest/i099": _, ...full } = read.attention;
  expect(() =>
    setAttention({ ...read, attention: full }, "interest/new", {
      type: "interest",
      instructions: "x",
    }),
  ).not.toThrow();
  expect(() =>
    setAttention(read, "interest/new", { type: "interest", instructions: "x" }),
  ).toThrow(/at most 100/);
});

it("keeps a timer's budget across edits; only a rearm moves its deadline", () => {
  const timer = {
    type: "timer",
    interest_id: "x",
    prompt: "tick",
    enabled: true,
    interval_secs: 3600,
    armed_at: 100,
    max_occurrences: 3,
    expires_at: null,
  } as const;
  const armed = setAttention(record, "watch/t", timer, 100);
  expect(armed.timers?.["watch/t"]).toEqual({
    armedAt: 100,
    nextDue: 3700,
    used: 0,
  });
  const ran = {
    ...armed,
    timers: { "watch/t": { armedAt: 100, nextDue: 7300, used: 1 } },
  };
  const later = 100 + 10 * 3600;
  // A new prompt or interval, pausing and resuming: none of them spends an
  // occurrence or moves the deadline. A new interval applies from the next run.
  for (const edit of [
    { prompt: "tock" },
    { interval_secs: 60 },
    { enabled: false },
    { enabled: true },
  ])
    expect(
      setAttention(ran, "watch/t", { ...timer, ...edit }, later).timers,
    ).toEqual(ran.timers);
  // A rearm is a new deadline that keeps what was used, as in Janet, even
  // when it is armed in the past.
  expect(
    setAttention(ran, "watch/t", { ...timer, armed_at: later }, later).timers?.[
      "watch/t"
    ],
  ).toEqual({ armedAt: later, nextDue: later + 3600, used: 1 });
  expect(
    setAttention(ran, "watch/t", { ...timer, armed_at: 200 }, later).timers?.[
      "watch/t"
    ],
  ).toEqual({ armedAt: 200, nextDue: 3800, used: 1 });
  // An explicit rearm sets the deadline even at the same armed_at, so a new
  // interval applies from it; a restart also gives back the whole budget.
  expect(
    setAttention(
      ran,
      "watch/t",
      { ...timer, interval_secs: 60 },
      later,
      "rearm",
    ).timers?.["watch/t"],
  ).toEqual({ armedAt: 100, nextDue: 160, used: 1 });
  expect(
    setAttention(
      ran,
      "watch/t",
      { ...timer, armed_at: later },
      later,
      "restart",
    ).timers?.["watch/t"],
  ).toEqual({ armedAt: later, nextDue: later + 3600, used: 0 });
  // Without saved state, what was already due counts as used.
  expect(
    setAttention(record, "watch/t", timer, 100 + 2 * 3600 + 5).timers?.[
      "watch/t"
    ],
  ).toEqual({ armedAt: 100, nextDue: 100 + 3 * 3600, used: 2 });
});

it("validates, replaces and deletes one object at a time", () => {
  expect(() =>
    setAttention(record, "interest/x", { type: "interest", instructions: " " }),
  ).toThrow(/empty/);
  const one = setAttention(
    record,
    "interest/x",
    { type: "interest", instructions: "a" },
    1,
  );
  const two = setAttention(
    one,
    "interest/x",
    { type: "interest", instructions: "b" },
    2,
  );
  expect(two.attention["interest/x"]).toEqual({
    slug: "interest/x",
    value: { type: "interest", instructions: "b" },
    modifiedAt: 2,
  });
  expect(setAttention(two, "interest/x", null).attention).toEqual({});
});

it("reads nothing from missing or malformed storage", () => {
  const storage = memoryStorage();
  expect(readRecords(storage)).toEqual({});
  storage.setItem(STORAGE_KEY, "{");
  storage.setItem(recordKey(pubkey), "{");
  expect(readRecords(storage)).toEqual({});
  expect(readOne(storage, pubkey)).toBeUndefined();
});

it("round-trips teams and skips any that is not one", () => {
  const storage = memoryStorage();
  expect(readTeams(storage)).toEqual([]);
  const team = { id: "t", name: "Crew", instructions: "Hi", members: [pubkey] };
  writeTeams(storage, [team]);
  expect(readTeams(storage)).toEqual([team]);
  storage.setItem(
    TEAMS_KEY,
    JSON.stringify({
      version: 1,
      teams: [{ ...team, members: [pubkey, "nope"] }, { id: 1 }, null],
    }),
  );
  expect(readTeams(storage)).toEqual([team]);
  storage.setItem(TEAMS_KEY, "{");
  expect(readTeams(storage)).toEqual([]);
});
