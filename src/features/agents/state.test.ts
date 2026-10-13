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

it("moves agent state from localStorage, which replaces what agent storage has", async () => {
  const local = memoryStorage();
  local.setItem("buzz.agents.v1", "records");
  local.setItem("buzz.agents.teams.v1", "new teams");
  local.setItem("buzz.claude-code.sessions.v1", "sessions");
  local.setItem("buzz.codex.sessions.v4:scope:ab", "codex");
  local.setItem("buzz.codex.provider-defaults.v1", "codex defaults");
  local.setItem("buzz.claude-code.provider-defaults.v1", "claude defaults");
  local.setItem("buzz.theme", "dark");
  const native = files({
    "buzz.agents.teams.v1": "stale teams",
    "buzz.agent.v1:aa": "kept",
  });
  const storage = await loadAgentStorage(local, native);
  expect(Object.fromEntries(native.saved)).toEqual({
    "buzz.agents.v1": "records",
    "buzz.agents.teams.v1": "new teams",
    "buzz.agent.v1:aa": "kept",
    "buzz.claude-code.sessions.v1": "sessions",
    "buzz.codex.sessions.v4:scope:ab": "codex",
    "buzz.codex.provider-defaults.v1": "codex defaults",
    "buzz.claude-code.provider-defaults.v1": "claude defaults",
  });
  expect(storage.getItem("buzz.agents.teams.v1")).toBe("new teams");
  // Moved keys leave localStorage; other keys stay.
  expect(local.length).toBe(1);
  expect(local.getItem("buzz.theme")).toBe("dark");
});

it("uses localStorage for a start where a copy fails, and keeps its state through a later move", async () => {
  const local = memoryStorage();
  local.setItem("buzz.agents.v1", "records");
  local.setItem("buzz.agents.teams.v1", "teams");
  const native = files();
  // The records copy is saved; the teams copy fails.
  native.set.mockResolvedValueOnce(undefined);
  native.set.mockRejectedValueOnce(new Error("disk full"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const first = await loadAgentStorage(local, native);
  error.mockRestore();
  expect(first).toBe(local);
  expect(first.getItem("buzz.agents.v1")).toBe("records");
  expect(first.getItem("buzz.agents.teams.v1")).toBe("teams");
  // The owner saves while the app uses localStorage.
  first.setItem("buzz.agents.v1", "saved records");

  // The disk recovers: the next start moves everything, the newer records too.
  const second = await loadAgentStorage(local, native);
  expect(second).not.toBe(local);
  expect(local.getItem("buzz.agents.v1")).toBeNull();
  second.setItem("buzz.agent.v1:aa", "saved again");
  await vi.waitFor(() =>
    expect(native.saved.get("buzz.agent.v1:aa")).toBe("saved again"),
  );

  const third = await loadAgentStorage(local, native);
  expect(third.getItem("buzz.agents.teams.v1")).toBe("teams");
  expect(third.getItem("buzz.agents.v1")).toBe("saved records");
  expect(third.getItem("buzz.agent.v1:aa")).toBe("saved again");
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

it("uses localStorage when agent storage does not answer, and leaves it as it was", async () => {
  vi.useFakeTimers();
  const local = memoryStorage();
  local.setItem("buzz.agents.v1", "records");
  const native = files();
  let answer = () => {};
  native.load.mockImplementationOnce(
    () => new Promise((resolve) => (answer = () => resolve({}))),
  );
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const started = loadAgentStorage(local, native, 1_000);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await started).toBe(local);
  // A late answer moves nothing: the app is using localStorage.
  answer();
  await vi.runAllTimersAsync();
  error.mockRestore();
  vi.useRealTimers();
  expect(local.getItem("buzz.agents.v1")).toBe("records");
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
