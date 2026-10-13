// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { checkSaved, readIdentity } from "./identity";

const saved = {
  pubkey: "ab".repeat(32),
  name: "Bot",
  type: "buzz.claude-code/claude-code",
  owner: "cd".repeat(32),
  relay: "wss://relay.example",
};
let dir: string;
const save = (list: unknown[]) =>
  writeFileSync(join(dir, "identities.json"), JSON.stringify(list));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-host-identity-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("keeps hosting while the agent is saved as it started", () => {
  save([saved]);
  const identity = readIdentity(dir, saved.pubkey);
  expect(checkSaved(dir, identity)).toBeUndefined();
  // A new name does not change who the agent is.
  save([{ ...saved, name: "Renamed" }]);
  expect(checkSaved(dir, identity)).toBeUndefined();
});

it("stops hosting once the app deletes, erases or moves the agent", () => {
  save([saved]);
  const identity = readIdentity(dir, saved.pubkey);
  save([{ ...saved, deleted: true }]);
  expect(checkSaved(dir, identity)).toMatch(/no longer saved/);
  save([]);
  expect(checkSaved(dir, identity)).toMatch(/no longer saved/);
  rmSync(join(dir, "identities.json"));
  expect(checkSaved(dir, identity)).toMatch(/no longer saved/);
  save([{ ...saved, owner: "ef".repeat(32) }]);
  expect(checkSaved(dir, identity)).toMatch(/owner changed/);
});

it("keeps hosting through a list it cannot read", () => {
  save([saved]);
  const identity = readIdentity(dir, saved.pubkey);
  writeFileSync(join(dir, "identities.json"), "{");
  expect(() => checkSaved(dir, identity)).toThrow();
});
