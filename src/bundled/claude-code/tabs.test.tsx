// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent, AgentType } from "../../features/agents/service";
import type { HostProcessOptions } from "../../features/host/service";
import { PanelSubviewHost } from "../../features/panels/PanelSubview";
import { apply, inject } from "./index";
import { type Config, DEFAULT_CONFIG } from "./runtime";

const desktop = vi.hoisted(() => ({ tauri: true }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => desktop.tauri }));

beforeEach(() => {
  desktop.tauri = true;
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  // jsdom has no layout observers; the model picker sizes itself with one.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const agent = (config: Config = DEFAULT_CONFIG) =>
  ({
    pubkey: "c".repeat(64),
    name: "Claude",
    type: "buzz.claude-code/claude-code",
    owner: "a".repeat(64),
    config,
  }) as Agent<Config>;

// jsdom leaves focus on a button that becomes natively disabled, where a
// browser drops it, so the focus tests also check for no `disabled`.

/** Applies the plugin to a stand-in context; sign-in runs until killed. */
function applied({
  loggedIn = true,
  files = {},
}: {
  loggedIn?: boolean;
  files?: Record<string, string>;
} = {}) {
  let type: AgentType<Config> | undefined;
  const spawn = vi.fn(async (id: string, options: HostProcessOptions = {}) => {
    const args = (options.args ?? []).join(" ");
    if (id === "find") {
      // Session files in the project folder that mention the pattern.
      const project = options.cwd?.split("/").pop();
      const [pattern = ""] = options.args ?? [];
      const found = Object.keys(files).filter(
        (path) =>
          path.startsWith(`./${project}/`) && files[path]?.includes(pattern),
      );
      queueMicrotask(() =>
        options.onStdout?.(
          found.map((path) => `./${path.split("/").pop()}\n`).join(""),
        ),
      );
      return {
        write: async () => undefined,
        end: async () => undefined,
        kill: async () => undefined,
        exited: new Promise<number>((resolve) =>
          setTimeout(() => resolve(found.length ? 0 : 1), 0),
        ),
      };
    }
    if (id === "workspace" || id === "read") {
      const file = files[args];
      queueMicrotask(() =>
        id === "workspace"
          ? options.onStdout?.("/Users/me/.buzz\n")
          : file === undefined
            ? options.onStderr?.(`base64: ${args}: No such file or directory`)
            : options.onStdout?.(btoa(file)),
      );
      const code = id === "read" && file === undefined ? 1 : 0;
      return {
        write: async () => undefined,
        end: async () => undefined,
        kill: async () => undefined,
        exited: new Promise<number>((resolve) =>
          setTimeout(() => resolve(code), 0),
        ),
      };
    }
    let kill: () => void = () => undefined;
    const exited = new Promise<number | null>((resolve) => {
      if (args === "auth login") kill = () => resolve(null);
      else setTimeout(() => resolve(0), 0);
    });
    queueMicrotask(() =>
      options.onStdout?.(
        args === "--version"
          ? "2.1.292 (Claude Code)\n"
          : args === "auth status --json"
            ? JSON.stringify({ loggedIn, email: "me@example.com" })
            : "",
      ),
    );
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => kill(),
      exited,
    };
  });
  const ctx = {
    pluginOwner: { id: "buzz.claude-code", revision: "r1" },
    host: { spawn, request: vi.fn() },
    agents: {
      register: (registered: AgentType<Config>) => {
        type = registered;
      },
      snapshot: () => ({ status: "ready", agents: [], running: [] }),
      relay: () => undefined,
      subscribe: () => () => undefined,
    },
    effect: vi.fn(),
  };
  apply(ctx as never);
  return { type, spawn };
}
function installed(options?: Parameters<typeof applied>[0]) {
  const { type, spawn } = applied(options);
  if (!type) throw new Error("no type registered");
  return { type, spawn };
}
function tab(type: AgentType<Config>, index: number) {
  const component = type.tabs?.[index]?.component;
  if (!component) throw new Error("no tab");
  return component;
}
async function choose(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

it("is an agent type on the desktop app", () => {
  expect(inject).toEqual(["agents", "host"]);
  const { type } = installed();
  expect(type).toMatchObject({ id: "claude-code", title: "Claude" });
  expect(type.defaults()).toEqual({ config: DEFAULT_CONFIG });
  expect(
    type.adopt?.(
      { instructions: "Triage.", workspace: "~/code" },
      DEFAULT_CONFIG,
    ),
  ).toEqual({
    ...DEFAULT_CONFIG,
    instructions: "Triage.",
    workspace: "~/code",
  });
  expect(type.adopt?.({}, DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
  expect(type.summary?.(agent({ ...DEFAULT_CONFIG, model: "opus" }))).toBe(
    "opus",
  );
  expect(type.tabs?.map((tab) => tab.title)).toEqual(["Claude", "Settings"]);
});

it("registers only where setup's bash and base64 exist", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  expect(applied().type).toBeDefined();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  expect(applied().type).toBeUndefined();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  desktop.tauri = false;
  expect(applied().type).toBeUndefined();
});

it("shows that Claude is ready and that nothing is running yet", async () => {
  const Claude = tab(installed().type, 0);
  render(<Claude agent={agent()} save={vi.fn()} />);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Claude 2.1.292 is ready (me@example.com).",
    ),
  );
  expect(
    screen.getByText(/None\. A conversation's session starts/),
  ).toBeVisible();
});

it("keeps focus on sign-in while it runs and on the same button after cancel", async () => {
  const Claude = tab(installed({ loggedIn: false }).type, 0);
  render(<Claude agent={agent()} save={vi.fn()} />);
  const user = userEvent.setup();
  const signIn = await screen.findByRole("button", { name: "Sign in" });
  await user.click(signIn);
  await waitFor(() => expect(signIn).toHaveAttribute("aria-busy", "true"));
  expect(signIn).toHaveFocus();
  expect(signIn).not.toHaveAttribute("disabled");
  expect(screen.getByLabelText("Sign-in code")).toHaveAccessibleDescription(
    "If the browser shows a code to paste, enter it here.",
  );
  const cancel = screen.getByRole("button", { name: "Cancel" });
  await user.click(cancel);
  await waitFor(() => expect(cancel).toHaveTextContent("Check again"));
  expect(cancel).toHaveFocus();
  expect(cancel).not.toHaveAttribute("disabled");
});

it("saves settings as one config", async () => {
  const Settings = tab(installed().type, 1);
  const save = vi.fn(async () => undefined);
  render(<Settings agent={agent()} save={save} />);
  const user = userEvent.setup();
  expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await choose("Model", "Sonnet");
  expect(screen.getByLabelText("Workspace")).toHaveAccessibleDescription(
    "The folder Claude works in. Use ~/ for your home folder.",
  );
  await user.clear(screen.getByLabelText("Workspace"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith({
    ...DEFAULT_CONFIG,
    model: "sonnet",
    workspace: "~/.buzz",
  });
});

it("keeps Save focused while saving, and lets a failed save be retried", async () => {
  const Settings = tab(installed().type, 1);
  let fail: (error: Error) => void = () => undefined;
  const save = vi
    .fn<(config: Config) => Promise<void>>()
    .mockImplementationOnce(
      () => new Promise((_resolve, reject) => (fail = reject)),
    )
    .mockResolvedValueOnce(undefined);
  render(<Settings agent={agent()} save={save} />);
  const user = userEvent.setup();
  await choose("Model", "Haiku");
  const saveButton = screen.getByRole("button", { name: "Save" });
  await user.click(saveButton);
  expect(saveButton).toHaveAttribute("aria-busy", "true");
  expect(saveButton).toHaveFocus();
  expect(saveButton).not.toHaveAttribute("disabled");
  fail(new Error("Relay rejected the change"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Relay rejected the change",
  );
  expect(saveButton).toHaveFocus();
  await user.click(saveButton);
  expect(save).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("lists saved conversations and shows one's transcript, or that it is gone", async () => {
  const thread = `channel/${"e".repeat(64)}`;
  localStorage.setItem(
    "buzz.claude-code.sessions.v1",
    JSON.stringify({
      [agent().pubkey]: {
        channel: { id: "deleted", seen: 0, at: 1 },
        [thread]: { id: "kept", seen: 0, at: 2 },
      },
    }),
  );
  const transcript = [
    JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2026-10-09T10:00:00Z",
      message: {
        content:
          "<buzz-event>\nEvent ID: e\nContent: what changed?\nTags: []\n</buzz-event>",
      },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "u2",
      timestamp: "2026-10-09T10:00:05Z",
      message: { content: [{ type: "text", text: "Two files." }] },
    }),
  ].join("\n");
  const Claude = tab(
    installed({ files: { "./-Users-me--buzz/kept.jsonl": transcript } }).type,
    0,
  );
  render(
    <PanelSubviewHost close={vi.fn()}>
      <Claude agent={agent()} save={vi.fn()} />
    </PanelSubviewHost>,
  );
  const user = userEvent.setup();
  const rows = screen.getAllByRole("listitem");
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining("channel · thread eeeeeeee"),
    expect.stringContaining("channel · channel"),
  ]);
  const viewButton = (index: number) =>
    screen.getAllByRole("button", { name: "View transcript" })[
      index
    ] as HTMLElement;
  const opened = viewButton(0);
  await user.click(opened);
  expect(await screen.findByText("what changed?")).toBeVisible();
  expect(screen.getByText("Two files.")).toBeVisible();
  // The transcript covers the tab, and Back returns focus to what opened it.
  const back = screen.getByRole("button", { name: "Back to profile" });
  expect(back).toHaveFocus();
  await user.click(back);
  expect(opened).toHaveFocus();
  await user.click(viewButton(1));
  expect(
    await screen.findByText(/no transcript for this conversation/),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("sets the conversation the profile was opened from apart from the recent ones", async () => {
  const root = "e".repeat(64);
  localStorage.setItem(
    "buzz.claude-code.sessions.v1",
    JSON.stringify({
      [agent().pubkey]: {
        channel: { id: "channel-session", seen: 0, at: 1 },
        [`channel/${root}`]: { id: "kept", seen: 0, at: 2 },
      },
    }),
  );
  const Claude = tab(installed().type, 0);
  const user = userEvent.setup();
  render(
    <Claude
      agent={agent()}
      save={vi.fn()}
      conversation={{ channelId: "channel", rootId: root }}
    />,
  );
  const opened = screen.getByRole("region", { name: "This thread" });
  expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual(
    [expect.stringContaining("channel · channel")],
  );
  await user.click(
    within(opened).getByRole("button", { name: "View transcript" }),
  );
  expect(
    await screen.findByRole("heading", { name: "channel · thread eeeeeeee" }),
  ).toBeVisible();
  cleanup();
  render(
    <Claude
      agent={agent()}
      save={vi.fn()}
      conversation={{ channelId: "elsewhere" }}
    />,
  );
  const empty = screen.getByRole("region", { name: "This channel" });
  expect(empty).toHaveTextContent("Looking for a Claude session…");
  await waitFor(() =>
    expect(empty).toHaveTextContent("No Claude session here yet"),
  );
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
});

it("finds the thread's session another build of the app started", async () => {
  const root = "f".repeat(64);
  const started = JSON.stringify({
    type: "user",
    uuid: "u1",
    timestamp: "2026-10-09T10:00:00Z",
    message: {
      content: `<context>\nScope: thread\nSession scope: thread\nChannel: dev (#channel)\nThread root: ${root}\nAgent: ${agent().pubkey}\n</context>\n\n<buzz-event>\nEvent ID: e\nContent: what changed?\nTags: []\n</buzz-event>`,
    },
  });
  const Claude = tab(
    installed({ files: { "./-Users-me--buzz/elsewhere.jsonl": started } }).type,
    0,
  );
  const user = userEvent.setup();
  render(
    <Claude
      agent={agent()}
      save={vi.fn()}
      conversation={{ channelId: "channel", rootId: root }}
    />,
  );
  const opened = screen.getByRole("region", { name: "This thread" });
  await user.click(
    await within(opened).findByRole("button", { name: "View transcript" }),
  );
  expect(await screen.findByText("what changed?")).toBeVisible();
});

it("starts a new agent from a model and instructions, keeping the rest", async () => {
  const Create = installed().type.Create;
  if (!Create) throw new Error("no create view");
  const config = {
    ...DEFAULT_CONFIG,
    workspace: "~/code",
    scope: "channel" as const,
  };
  const onChange = vi.fn();
  render(<Create config={config} onChange={onChange} disabled={false} />);
  await choose("Model", "Opus");
  expect(onChange).toHaveBeenLastCalledWith({ ...config, model: "opus" });
  fireEvent.change(screen.getByLabelText("Instructions"), {
    target: { value: "Triage." },
  });
  expect(onChange).toHaveBeenLastCalledWith({
    ...config,
    instructions: "Triage.",
  });
});

it("shows a new agent's starting config, and lets a custom model be typed", async () => {
  const Create = installed().type.Create;
  if (!Create) throw new Error("no create view");
  const onChange = vi.fn();
  render(
    <Create
      config={{ ...DEFAULT_CONFIG, model: "sonnet", instructions: "Triage." }}
      onChange={onChange}
      disabled={false}
    />,
  );
  expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue("Sonnet");
  expect(screen.getByLabelText("Instructions")).toHaveValue("Triage.");
  const user = userEvent.setup();
  const model = screen.getByRole("combobox", { name: "Model" });
  await user.clear(model);
  await user.type(model, "claude-opus-4-1{Enter}");
  expect(onChange).toHaveBeenLastCalledWith({
    ...DEFAULT_CONFIG,
    model: "claude-opus-4-1",
    instructions: "Triage.",
  });
});

it("disables a new agent's controls while it is being created", () => {
  const Create = installed().type.Create;
  if (!Create) throw new Error("no create view");
  render(<Create config={DEFAULT_CONFIG} onChange={vi.fn()} disabled />);
  expect(screen.getByRole("combobox", { name: "Model" })).toBeDisabled();
  expect(screen.getByLabelText("Instructions")).toBeDisabled();
});

it("keeps a custom model and instructions in settings", async () => {
  const Settings = tab(installed().type, 1);
  const save = vi.fn(async () => undefined);
  render(
    <Settings
      agent={agent({ ...DEFAULT_CONFIG, model: "claude-opus-4-1" })}
      save={save}
    />,
  );
  expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue(
    "claude-opus-4-1",
  );
  expect(screen.getByLabelText("Instructions")).toHaveAccessibleDescription(
    "Added to every session's system prompt, after Buzz's own.",
  );
  fireEvent.change(screen.getByLabelText("Instructions"), {
    target: { value: "Triage." },
  });
  await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith({
    ...DEFAULT_CONFIG,
    model: "claude-opus-4-1",
    instructions: "Triage.",
  });
});
