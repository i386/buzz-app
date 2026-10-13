import { expect, it, vi } from "vitest";
import { fileBacked, loadAgentStorage } from "./state";
import { memoryStorage } from "./test-fakes";

const files = (items: Record<string, string> = {}) => {
  const saved = new Map(Object.entries(items));
  return {
    saved,
    load: vi.fn(async () => Object.fromEntries(saved)),
    set: vi.fn(async (key: string, value: string | null) => {
      if (value === null) saved.delete(key);
      else saved.set(key, value);
    }),
  };
};

it("moves agent state from localStorage, keeping what agent storage has", async () => {
  const local = memoryStorage();
  local.setItem("buzz.agents.v1", "records");
  local.setItem("buzz.agents.teams.v1", "old teams");
  local.setItem("buzz.claude-code.sessions.v1", "sessions");
  local.setItem("buzz.codex.sessions.v4:scope:ab", "codex");
  local.setItem("buzz.codex.provider-defaults.v1", "codex defaults");
  local.setItem("buzz.claude-code.provider-defaults.v1", "claude defaults");
  local.setItem("buzz.theme", "dark");
  const native = files({ "buzz.agents.teams.v1": "shared teams" });
  const storage = await loadAgentStorage(local, native);
  expect(Object.fromEntries(native.saved)).toEqual({
    "buzz.agents.v1": "records",
    "buzz.agents.teams.v1": "shared teams",
    "buzz.claude-code.sessions.v1": "sessions",
    "buzz.codex.sessions.v4:scope:ab": "codex",
    "buzz.codex.provider-defaults.v1": "codex defaults",
    "buzz.claude-code.provider-defaults.v1": "claude defaults",
  });
  expect(storage.getItem("buzz.agents.teams.v1")).toBe("shared teams");
  // Moved keys leave localStorage; other keys stay.
  expect(local.length).toBe(1);
  expect(local.getItem("buzz.theme")).toBe("dark");
});

it("keeps a key in localStorage when it could not be moved", async () => {
  const local = memoryStorage();
  local.setItem("buzz.agents.v1", "records");
  const native = files();
  native.set.mockRejectedValueOnce(new Error("disk full"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await loadAgentStorage(local, native);
  error.mockRestore();
  expect(local.getItem("buzz.agents.v1")).toBe("records");
});

it("uses localStorage when agent storage cannot be read", async () => {
  const local = memoryStorage();
  const native = files();
  native.load.mockRejectedValueOnce(new Error("denied"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await loadAgentStorage(local, native)).toBe(local);
  expect(await loadAgentStorage(local, undefined)).toBe(local);
  error.mockRestore();
});

it("saves each write in order, and a failed write does not stop later ones", async () => {
  const native = files();
  const storage = fileBacked(new Map(), native.set);
  native.set.mockRejectedValueOnce(new Error("busy"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  storage.setItem("a", "1");
  storage.setItem("a", "2");
  storage.setItem("b", "3");
  storage.removeItem("b");
  storage.removeItem("missing");
  await storage.saved();
  error.mockRestore();
  expect(native.set.mock.calls).toEqual([
    ["a", "1"],
    ["a", "2"],
    ["b", "3"],
    ["b", null],
  ]);
  expect(Object.fromEntries(native.saved)).toEqual({ a: "2" });
  expect(storage.getItem("a")).toBe("2");
  expect(storage.length).toBe(1);
});

it("puts back a key whose write failed, so it is not taken as saved and can be set again", async () => {
  const native = files({ a: "old" });
  const storage = fileBacked(new Map([["a", "old"]]), native.set);
  native.set.mockRejectedValueOnce(new Error("disk full"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  storage.setItem("a", "new");
  storage.setItem("b", "kept");
  await expect(storage.saved("a")).rejects.toThrow("disk full");
  await expect(storage.saved()).rejects.toThrow("disk full");
  await expect(storage.saved("b")).resolves.toBeUndefined();
  error.mockRestore();
  expect(storage.getItem("a")).toBe("old");
  // The same value again is a new write, not a no-op.
  storage.setItem("a", "new");
  await storage.saved();
  expect(native.saved.get("a")).toBe("new");
  expect(storage.getItem("a")).toBe("new");
});
