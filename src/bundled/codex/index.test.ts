// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentType } from "../../features/agents/service";
import { CodexLogoIcon } from "../../shared/design-system/icons";
import { CodexRuntime } from "./runtime";
import { CodexProvider } from "./tabs";
import { apply } from "./index";

const desktop = vi.hoisted(() => ({ tauri: true }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => desktop.tauri }));

beforeEach(() => {
  desktop.tauri = true;
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
});
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

/** Applies the plugin to a stand-in context and returns the registered type. */
function applied() {
  let type: AgentType | undefined;
  const subscribe = () => () => undefined;
  const ctx = {
    pluginOwner: { id: "buzz.codex", revision: "r1" },
    host: { spawn: vi.fn(), request: vi.fn() },
    agents: {
      register: (registered: AgentType) => {
        type = registered;
      },
      snapshot: () => ({ status: "ready", agents: [], running: [] }),
      relay: () => undefined,
      subscribe,
    },
    effect: vi.fn(),
  };
  apply(ctx as never);
  return type;
}

it("registers only where the desktop app can run codex and base64", () => {
  const check = vi.spyOn(CodexProvider.prototype, "check").mockResolvedValue();
  const type = applied();
  expect(check).not.toHaveBeenCalled();
  expect(type).toMatchObject({
    id: "codex",
    title: "Codex",
    Create: expect.any(Function),
    icon: CodexLogoIcon,
  });
  expect(type?.provider).toBeDefined();
  expect(type?.tabs?.map((tab) => tab.title)).toEqual(["Settings"]);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  expect(applied()).toBeDefined();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  expect(applied()).toBeUndefined();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  desktop.tauri = false;
  expect(applied()).toBeUndefined();
});

it("adopts and carries an agent's instructions and workspace, nothing else", () => {
  const type = applied();
  const saved = type?.defaults().config;
  expect(
    type?.adopt?.({ instructions: "Triage.", model: "gpt" } as never, saved),
  ).toEqual({ ...(saved as object), instructions: "Triage." });
  expect(type?.adopt?.({ workspace: "/work/code" }, saved)).toEqual({
    ...(saved as object),
    workspace: "/work/code",
  });
  expect(type?.adopt?.({ workspace: "~/code" }, saved)).toEqual({
    ...(saved as object),
    workspace: "~/code",
  });
  // A workspace Codex cannot run in stays the default.
  expect(type?.adopt?.({ workspace: "code" }, saved)).toEqual(saved);
  expect(
    type?.carry?.({ ...(saved as object), model: "gpt", instructions: " " }),
  ).toEqual({});
  expect(
    type?.carry?.({ instructions: "Triage.", workspace: "/work/code" }),
  ).toEqual({ instructions: "Triage.", workspace: "/work/code" });
  expect(type?.describeMigration?.(saved)).toEqual([
    { id: "model", label: "Model", isOverride: false },
    { id: "thinking", label: "Thinking", isOverride: false },
    {
      id: "sessions",
      label: "Sessions",
      isOverride: false,
      unchangedKey: "thread",
    },
  ]);
  expect(
    type?.describeMigration?.({
      ...(saved as object),
      model: "gpt-5",
      effort: "high",
      scope: "channel",
    }),
  ).toEqual([
    { id: "model", label: "Model", isOverride: true },
    { id: "thinking", label: "Thinking", isOverride: true },
    {
      id: "sessions",
      label: "Sessions",
      isOverride: true,
      unchangedKey: "channel",
    },
  ]);
  expect(type?.migrationWarning).toBe(
    "Any commands Codex left running will stop.",
  );
});

it("stops agents that stop running even when the agent list could not be read", () => {
  const sync = vi.spyOn(CodexRuntime.prototype, "sync");
  const agent = { pubkey: "agent", type: "buzz.codex/codex" };
  let state = { status: "ready", agents: [agent], running: [agent] };
  let notify = () => undefined;
  apply({
    pluginOwner: { id: "buzz.codex" },
    host: { spawn: vi.fn(), request: vi.fn() },
    agents: {
      register: () => undefined,
      snapshot: () => state,
      relay: () => undefined,
      subscribe: (listener: () => undefined) => {
        notify = listener;
        return () => undefined;
      },
    },
    effect: vi.fn(),
  } as never);
  expect(sync).toHaveBeenLastCalledWith([agent]);
  // A failed refresh keeps the list; leaving the community then empties it.
  state = { ...state, status: "error", agents: [], running: [] };
  notify();
  expect(sync).toHaveBeenLastCalledWith([]);
});
