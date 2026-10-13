// @vitest-environment node
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readRecords, recordKey, writeRecord } from "../features/agents/store";
import { decodeKey, encodeKey, fileName, stateStorage } from "./storage";

it("names files as the app does", () => {
  // The same names as agent_state.rs `names_round_trip`.
  expect(encodeKey("buzz.agents.v1")).toBe("buzz.agents.v1");
  expect(encodeKey("buzz.codex.sessions.v4:wss://relay.example/a:ab")).toBe(
    "buzz.codex.sessions.v4%3Awss%3A%2F%2Frelay.example%2Fa%3Aab",
  );
  expect(encodeKey("a/b c%d")).toBe("a%2Fb%20c%25d");
  for (const key of ["buzz.agent.v1:ab", "a/b c%d", "é"])
    expect(decodeKey(encodeKey(key))).toBe(key);
  expect(decodeKey("x.tmp")).toBeUndefined();
  expect(decodeKey(".hidden")).toBeUndefined();
  expect(decodeKey("bad%Z")).toBeUndefined();
  expect(decodeKey("has space")).toBeUndefined();
});

it("reads what another program saved, and skips writes in progress", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "agent-state-")), "state");
  const storage = stateStorage(dir);
  expect(storage.getItem("missing")).toBeNull();
  expect(storage.length).toBe(0);
  const pubkey = "a".repeat(64);
  writeRecord(storage, { pubkey, attention: {}, config: { word: "one" } });
  // The app saves a change to the same file.
  writeFileSync(
    join(dir, encodeKey(recordKey(pubkey))),
    JSON.stringify({ pubkey, attention: {}, config: { word: "two" } }),
  );
  writeFileSync(join(dir, ".123.tmp"), "partial");
  expect(readRecords(storage)[pubkey]?.config).toEqual({ word: "two" });
  expect(storage.length).toBe(1);
  storage.removeItem(recordKey(pubkey));
  storage.removeItem(recordKey(pubkey));
  expect(readdirSync(dir)).toEqual([".123.tmp"]);
});

it("saves a key whose name is too long in a file named by its hash, as the app does", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "agent-state-")), "state");
  const storage = stateStorage(dir);
  // 251 bytes, as Codex names it for a community on a 95-character host;
  // encoded, 263.
  const key = `buzz.codex.sessions.v4:https://agents.production.us-west-2.buzz-workspace.platform.engineering.internal.tools.example.com:${"a".repeat(64)}:${"b".repeat(64)}`;
  expect(key.length).toBe(251);
  expect(encodeKey(key).length).toBeGreaterThan(255);
  // The name agent_state.rs `file_name` gives it.
  expect(fileName(key)).toBe(
    "~2418a80781b72ec15bca6c4423fa41f0937d29e13b19fe1247bf0daaa571773f",
  );
  storage.setItem(key, "{}");
  expect(readdirSync(dir)).toEqual([fileName(key)]);
  expect(storage.getItem(key)).toBe("{}");
  expect(storage.key(0)).toBe(key);
  storage.setItem(key, "2");
  expect(storage.getItem(key)).toBe("2");
  // A hashed file whose key does not give its name is not a key.
  writeFileSync(
    join(dir, `~${"0".repeat(64)}`),
    JSON.stringify({ key: "other", value: "x" }),
  );
  writeFileSync(join(dir, "~bad"), "not json");
  expect(storage.length).toBe(1);
  storage.removeItem(key);
  expect(storage.getItem(key)).toBeNull();
  expect(storage.length).toBe(0);
});
