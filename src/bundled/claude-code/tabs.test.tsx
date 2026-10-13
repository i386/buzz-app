// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { CustomModelDialog } from "../../features/agents/ModelPicker";
import type { Agent, AgentType } from "../../features/agents/service";
import type { HostProcessOptions } from "../../features/host/service";
import { ClaudeLogoIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import {
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { apply, inject } from "./index";
import { type Config, DEFAULT_CONFIG } from "./runtime";
import { ClaudeDefaults } from "./defaults";

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
  localStorage.clear();
  vi.restoreAllMocks();
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

/** Applies the plugin to a stand-in context; setup steps run until killed. */
function applied({
  loggedIn = true,
  available = true,
  files = {},
}: {
  loggedIn?: boolean;
  available?: boolean;
  files?: Record<string, string>;
} = {}) {
  let type: AgentType<Config> | undefined;
  const spawn = vi.fn(async (id: string, options: HostProcessOptions = {}) => {
    // Claude and its install steps run as steps of claude.sh: its script, $0
    // and step come first.
    const step = id === "claude-sh" ? options.args?.[2] : undefined;
    const name = step === "run" ? "claude" : (step ?? id);
    const args = (options.args ?? []).slice(step ? 3 : 0).join(" ");
    if (name === "find") {
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
    if (name === "workspace" || name === "read") {
      const file = files[args];
      queueMicrotask(() =>
        name === "workspace"
          ? options.onStdout?.("/Users/me/.buzz\n")
          : file === undefined
            ? options.onStderr?.(`base64: ${args}: No such file or directory`)
            : options.onStdout?.(btoa(file)),
      );
      return {
        write: async () => undefined,
        end: async () => undefined,
        kill: async () => undefined,
        exited: new Promise<number>((resolve) =>
          setTimeout(
            () => resolve(name === "read" && file === undefined ? 1 : 0),
            0,
          ),
        ),
      };
    }
    // Buzz's launcher answers 127 when it has no copy.
    const missing = name === "claude" && args === "--version" && !available;
    const streaming = args.includes("--input-format stream-json");
    let kill: () => void = () => undefined;
    const exited = new Promise<number | null>((resolve) => {
      if (name === "install" || args === "auth login" || streaming)
        kill = () => resolve(null);
      else setTimeout(() => resolve(missing ? 127 : 0), 0);
    });
    queueMicrotask(() =>
      options.onStdout?.(
        missing
          ? ""
          : name === "install"
            ? "Setting up Claude Code...\n"
            : name === "platform"
              ? "Darwin arm64\n"
              : args === "--version"
                ? "2.1.292 (Claude Code)\n"
                : args === "auth status --json"
                  ? JSON.stringify({ loggedIn, email: "me@example.com" })
                  : "",
      ),
    );
    return {
      write: async (text: string) => {
        if (!streaming) return;
        const message = JSON.parse(text) as {
          request_id?: string;
          request?: { subtype?: string };
        };
        if (message.request?.subtype !== "initialize") return;
        queueMicrotask(() =>
          options.onStdout?.(
            `${JSON.stringify({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: message.request_id,
                response: {
                  models: [
                    {
                      value: "default",
                      resolvedModel: "claude-opus-5-5",
                      displayName: "Default (recommended)",
                      description:
                        "Opus 5.5 · Best for everyday, complex tasks",
                    },
                    {
                      value: "opus",
                      resolvedModel: "claude-opus-5-5",
                      displayName: "Opus",
                      description:
                        "Opus 5.5 · Best for everyday, complex tasks",
                    },
                    {
                      value: "sonnet",
                      resolvedModel: "claude-sonnet-5-5",
                      displayName: "Sonnet",
                      description: "Sonnet 5.5 · Efficient for routine tasks",
                    },
                    {
                      value: "haiku",
                      resolvedModel: "claude-haiku-4-5",
                      displayName: "Haiku",
                      description: "Haiku 4.5 · Fastest for quick answers",
                    },
                  ],
                },
              },
            })}\n`,
          ),
        );
      },
      end: async () => undefined,
      kill: async () => kill(),
      exited,
    };
  });
  const ctx = {
    pluginOwner: { id: "buzz.claude-code", revision: "r1" },
    host: {
      spawn,
      // downloads.claude.ai offering the release installed, so no update runs.
      request: vi.fn(async ({ url }: { url: string }) => ({
        status: 200,
        headers: {},
        body: url.endsWith("/latest")
          ? "2.1.292"
          : JSON.stringify({
              platforms: { "darwin-arm64": { checksum: "a".repeat(64) } },
            }),
      })),
    },
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
function providerSetup(type: AgentType<Config>) {
  if (!type.provider) throw new Error("no provider contribution");
  return type.provider.DialogBody;
}
async function choose(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

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
  const save = vi.fn();
  render(<Claude agent={agent()} save={save} />);
  fireEvent.click(screen.getByText("Runtime diagnostics"));
  const user = userEvent.setup();
  const rows = screen.getAllByRole("listitem");
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining("channel · thread eeeeeeee"),
    expect.stringContaining("channel · channel"),
  ]);
  fireEvent.change(screen.getByLabelText("Workspace"), {
    target: { value: "/draft" },
  });
  const viewButton = (index: number) =>
    screen.getAllByRole("button", { name: "View transcript" })[
      index
    ] as HTMLElement;
  await user.click(viewButton(0));
  expect(await screen.findByText("what changed?")).toBeVisible();
  expect(screen.getByText("Two files.")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Refresh" })).not.toHaveAttribute(
      "data-loading",
    ),
  );
  expect(screen.getByText("Two files.")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Back to profile" }));
  await user.click(viewButton(1));
  expect(
    await screen.findByText(/no transcript for this conversation/),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByLabelText("Workspace")).toHaveValue("/draft");
  expect(save).not.toHaveBeenCalled();
});

it("sets the conversation the profile was opened from apart from recent conversations", () => {
  const root = "e".repeat(64);
  localStorage.setItem(
    "buzz.claude-code.sessions.v1",
    JSON.stringify({
      [agent().pubkey]: {
        channel: { id: "channel-session", seen: 0, at: 1 },
        [`channel/${root}`]: { id: "thread-session", seen: 0, at: 2 },
      },
    }),
  );
  const Claude = tab(installed().type, 0);
  render(
    <Claude
      agent={agent()}
      save={vi.fn()}
      conversation={{ channelId: "channel", rootId: root }}
    />,
  );
  fireEvent.click(screen.getByText("Runtime diagnostics"));
  const opened = screen.getByRole("region", { name: "This thread" });
  expect(
    within(opened).getByRole("button", { name: "View transcript" }),
  ).toBeVisible();
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
  expect(screen.getByText(/channel · channel/)).toBeVisible();
});

it("finds the thread's Claude session another build started", async () => {
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
  render(
    <Claude
      agent={agent()}
      save={vi.fn()}
      conversation={{ channelId: "channel", rootId: root }}
    />,
  );
  fireEvent.click(screen.getByText("Runtime diagnostics"));
  const opened = screen.getByRole("region", { name: "This thread" });
  fireEvent.click(
    await within(opened).findByRole("button", { name: "View transcript" }),
  );
  expect(await screen.findByText("what changed?")).toBeVisible();
});

it("is an agent type on the desktop app", () => {
  expect(inject).toEqual(["agents", "host"]);
  const { type } = installed();
  expect(type).toMatchObject({
    id: "claude-code",
    title: "Claude",
    icon: ClaudeLogoIcon,
  });
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
  expect(type.carry?.(DEFAULT_CONFIG)).toEqual({});
  expect(
    type.carry?.({
      model: "opus",
      instructions: "Triage.",
      workspace: "~/code",
      scope: "channel",
    }),
  ).toEqual({ instructions: "Triage.", workspace: "~/code" });
  expect(type.describeMigration?.(DEFAULT_CONFIG)).toEqual([
    { id: "model", label: "Model", isOverride: false },
    {
      id: "sessions",
      label: "Sessions",
      isOverride: false,
      unchangedKey: "thread",
    },
  ]);
  expect(
    type.describeMigration?.({
      ...DEFAULT_CONFIG,
      model: "opus",
      scope: "channel",
    }),
  ).toEqual([
    { id: "model", label: "Model", isOverride: true },
    {
      id: "sessions",
      label: "Sessions",
      isOverride: true,
      unchangedKey: "channel",
    },
  ]);
  expect(type.summary?.(agent({ ...DEFAULT_CONFIG, model: "opus" }))).toBe(
    "opus",
  );
  expect(type.provider).toBeDefined();
  expect(type.tabs?.map((tab) => tab.title)).toEqual(["Settings"]);
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

it("keeps provider readiness quiet and agent diagnostics collapsed", async () => {
  const installedType = installed().type;
  const Setup = providerSetup(installedType);
  render(<Setup onClose={vi.fn()} />);
  await waitFor(() =>
    expect(screen.getByLabelText("Default model")).toHaveTextContent(
      "Claude default (Opus 5.5)",
    ),
  );
  expect(screen.queryByText("Connection")).not.toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  cleanup();
  const Settings = tab(installedType, 0);
  render(<Settings agent={agent()} save={vi.fn()} />);
  expect(
    screen.getByText("Runtime diagnostics").closest("details"),
  ).not.toHaveAttribute("open");
  expect(
    screen.getByText(/None\. A conversation's session starts/),
  ).toBeInTheDocument();
});

it("saves a provider model default explicitly and leaves blank agent config inherited", async () => {
  const installedType = installed().type;
  const Provider = providerSetup(installedType);
  const onClose = vi.fn();
  render(<Provider onClose={onClose} />);
  await waitFor(() =>
    expect(screen.getByLabelText("Default model")).toHaveTextContent(
      "Claude default (Opus 5.5)",
    ),
  );
  const user = userEvent.setup();
  const defaultModel = screen.getByRole("combobox", { name: "Default model" });
  const autoMemory = screen.getByRole("switch", {
    name: "Claude auto memory",
  });
  expect(autoMemory).toBeChecked();
  expect(autoMemory).toHaveAccessibleDescription(
    "Let Claude write its own auto memory in addition to Buzz memory. Claude still reads CLAUDE.md when this is off.",
  );
  expect(defaultModel).toHaveTextContent("Claude default (Opus 5.5)");
  await user.click(defaultModel);
  expect(
    await screen.findByRole("option", {
      name: "Claude default (Opus 5.5)",
    }),
  ).toHaveAccessibleDescription("Following Claude Code's recommendation");
  const sonnet = await screen.findByRole("option", { name: "Sonnet 5.5" });
  expect(sonnet).toHaveAccessibleDescription("Efficient for routine tasks");
  await user.click(sonnet);
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(onClose).toHaveBeenCalledOnce();
  cleanup();

  const Settings = tab(installedType, 0);
  const save = vi.fn(async () => undefined);
  render(<Settings agent={agent()} save={save} />);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
      "Provider default · Sonnet 5.5",
    ),
  );
  expect(save).not.toHaveBeenCalled();
});

it("preserves native behavior for invalid defaults and keeps explicit agent models", () => {
  localStorage.setItem("buzz.claude-code.provider-defaults.v1", "not json");
  const defaults = new ClaudeDefaults(localStorage);
  expect(defaults.resolve(DEFAULT_CONFIG)).toEqual({
    ...DEFAULT_CONFIG,
    disableAutoMemory: false,
  });
  defaults.save({ model: "sonnet", autoMemory: false });
  const inherited = { ...DEFAULT_CONFIG };
  expect(defaults.resolve(inherited).model).toBe("sonnet");
  expect(defaults.resolve(inherited).disableAutoMemory).toBe(true);
  expect(inherited).toEqual(DEFAULT_CONFIG);
  expect(defaults.resolve({ ...DEFAULT_CONFIG, model: "opus" }).model).toBe(
    "opus",
  );
  localStorage.setItem(
    "buzz.claude-code.provider-defaults.v1",
    JSON.stringify({ version: 1, model: "haiku" }),
  );
  expect(
    new ClaudeDefaults(localStorage).resolve(DEFAULT_CONFIG).disableAutoMemory,
  ).toBe(false);
});

it("can cancel sign-in and try again", async () => {
  const installedType = installed({ loggedIn: false }).type;
  const Setup = providerSetup(installedType);
  render(<Setup onClose={vi.fn()} />);
  const user = userEvent.setup();
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Claude 2.1.292 needs you to sign in.",
    ),
  );
  expect(screen.queryByText("Connection")).not.toBeInTheDocument();
  expect(installedType.provider?.snapshot()).toMatchObject({
    readiness: "attention",
    attentionLabel: "Log in to Claude Code",
  });
  const signIn = await screen.findByRole("button", { name: "Sign in" });
  await user.click(signIn);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Waiting for Claude Code sign-in…",
    ),
  );
  expect(screen.getByLabelText("Sign-in code")).toHaveAccessibleDescription(
    "If the browser shows a code to paste, enter it here.",
  );
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  const cancel = screen.getByRole("button", { name: "Cancel" });
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(installedType.provider?.snapshot()).toHaveProperty("blocking", true);
  await user.click(cancel);
  const retry = await screen.findByRole("button", { name: "Sign in" });
  expect(installedType.provider?.snapshot()).not.toHaveProperty("blocking");
  expect(retry).toHaveFocus();
  await user.click(retry);
  expect(await screen.findByRole("button", { name: "Cancel" })).toBeVisible();
});

it("replaces generic installation copy with the latest installer state", async () => {
  const installedType = installed({ available: false }).type;
  const Setup = providerSetup(installedType);
  render(<Setup onClose={vi.fn()} />);
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Claude is not installed.",
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Install Claude" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Setting up Claude Code...",
    ),
  );
  expect(screen.queryByText("Installing Claude Code…")).toBeNull();
  expect(screen.queryByLabelText("Setup output")).toBeNull();
});

it("starts viable provider recovery directly from its attention action", async () => {
  const { type, spawn } = installed({ loggedIn: false });
  const Setup = providerSetup(type);
  render(<Setup onClose={vi.fn()} />);
  await waitFor(() =>
    expect(type.provider?.snapshot()).toMatchObject({
      readiness: "attention",
      attentionLabel: "Log in to Claude Code",
    }),
  );
  // Offered once the update check on load has finished.
  await waitFor(() =>
    expect(type.provider?.attentionAction).toBeTypeOf("function"),
  );
  const action = type.provider?.attentionAction;
  act(() => action?.());
  await waitFor(() =>
    expect(spawn).toHaveBeenCalledWith(
      "claude-sh",
      expect.objectContaining({
        args: [expect.any(String), "claude.sh", "run", "auth", "login"],
      }),
    ),
  );
  expect(type.provider?.attentionAction).toBeUndefined();
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Waiting for Claude Code sign-in…",
    ),
  );
  expect(type.provider?.snapshot()).toHaveProperty("blocking", true);
});

it("saves settings as one config", async () => {
  const Settings = tab(installed().type, 0);
  const save = vi.fn(async () => undefined);
  render(<Settings agent={agent()} save={save} />);
  const user = userEvent.setup();
  expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  const sonnet = await screen.findByRole("option", { name: "Sonnet 5.5" });
  expect(sonnet).toHaveAccessibleDescription("Efficient for routine tasks");
  await user.click(sonnet);
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
  const Settings = tab(installed().type, 0);
  let fail: (error: Error) => void = () => undefined;
  const save = vi
    .fn<(config: Config) => Promise<void>>()
    .mockImplementationOnce(
      () => new Promise((_resolve, reject) => (fail = reject)),
    )
    .mockResolvedValueOnce(undefined);
  render(<Settings agent={agent()} save={save} />);
  const user = userEvent.setup();
  await choose("Model", "Haiku 4.5");
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

it("starts a new agent from a model and instructions, keeping the rest", async () => {
  const installedType = installed().type;
  const Create = installedType.Create;
  const CreateModelMenu = installedType.CreateModelMenu;
  if (!Create || !CreateModelMenu) throw new Error("no create choices");
  const CreateView = Create;
  const ModelMenu = CreateModelMenu;
  const config = {
    ...DEFAULT_CONFIG,
    workspace: "~/code",
    scope: "channel" as const,
  };
  const onChange = vi.fn();
  function CreateChoices() {
    const [request, setRequest] = useState<{
      initialValue: string;
      onChange(model: string): void;
    } | null>(null);
    return (
      <>
        <CreateView config={config} onChange={onChange} disabled={false} />
        <MenuRoot>
          <MenuTrigger render={<Button>Models</Button>} />
          <MenuPopup>
            <ModelMenu
              config={config}
              onChange={onChange}
              disabled={false}
              requestCustomModel={(
                initialValue: string,
                commit: (model: string) => void,
              ) => setRequest({ initialValue, onChange: commit })}
            />
          </MenuPopup>
        </MenuRoot>
        {request && (
          <CustomModelDialog
            initialValue={request.initialValue}
            onClose={() => setRequest(null)}
            onSubmit={(model) => {
              request.onChange(model);
              setRequest(null);
            }}
          />
        )}
      </>
    );
  }
  render(<CreateChoices />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Models" }));
  const opus = await screen.findByRole("menuitemradio", {
    name: "Opus 5.5 Best for everyday, complex tasks",
  });
  await user.click(opus);
  expect(onChange).toHaveBeenLastCalledWith({ ...config, model: "opus" });
  expect(installedType.createModelLabel?.({ ...config, model: "opus" })).toBe(
    "Opus 5.5",
  );
  fireEvent.change(screen.getByLabelText("Instructions"), {
    target: { value: "Triage." },
  });
  expect(onChange).toHaveBeenLastCalledWith({
    ...config,
    instructions: "Triage.",
  });
});

it("shows a new agent's starting config, and accepts a custom model", async () => {
  const installedType = installed().type;
  const Create = installedType.Create;
  const CreateModelMenu = installedType.CreateModelMenu;
  if (!Create || !CreateModelMenu) throw new Error("no create choices");
  const CreateView = Create;
  const ModelMenu = CreateModelMenu;
  const config = {
    ...DEFAULT_CONFIG,
    model: "sonnet",
    instructions: "Triage.",
  };
  const onChange = vi.fn();
  function CreateChoices() {
    const [request, setRequest] = useState<{
      initialValue: string;
      onChange(model: string): void;
    } | null>(null);
    return (
      <>
        <CreateView config={config} onChange={onChange} disabled={false} />
        <MenuRoot>
          <MenuTrigger render={<Button>Models</Button>} />
          <MenuPopup>
            <ModelMenu
              config={config}
              onChange={onChange}
              disabled={false}
              requestCustomModel={(initialValue, commit) =>
                setRequest({ initialValue, onChange: commit })
              }
            />
          </MenuPopup>
        </MenuRoot>
        {request && (
          <CustomModelDialog
            initialValue={request.initialValue}
            onClose={() => setRequest(null)}
            onSubmit={(model) => {
              request.onChange(model);
              setRequest(null);
            }}
          />
        )}
      </>
    );
  }
  render(<CreateChoices />);
  expect(screen.getByLabelText("Instructions")).toHaveValue("Triage.");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Models" }));
  await user.click(
    await screen.findByRole("menuitem", {
      name: "Custom model Enter a model ID",
    }),
  );
  await user.type(
    await screen.findByRole("textbox", { name: "Model ID" }),
    "claude-opus-4-1",
  );
  await user.click(screen.getByRole("button", { name: "Use model" }));
  expect(onChange).toHaveBeenLastCalledWith({
    ...DEFAULT_CONFIG,
    model: "claude-opus-4-1",
    instructions: "Triage.",
  });
});

it("disables a new agent's controls while it is being created", () => {
  const Create = installed().type.Create;
  if (!Create) throw new Error("no create choices");
  render(<Create config={DEFAULT_CONFIG} onChange={vi.fn()} disabled />);
  expect(screen.getByLabelText("Instructions")).toBeDisabled();
});

it("edits a custom model and instructions in settings", async () => {
  const Settings = tab(installed().type, 0);
  const save = vi.fn(async () => undefined);
  render(
    <Settings
      agent={agent({ ...DEFAULT_CONFIG, model: "claude-opus-4-1" })}
      save={save}
      settingsHost={{ typeControl: () => <p>Provider control</p> }}
    />,
  );
  const user = userEvent.setup();
  const providerControl = screen.getByText("Provider control");
  const modelControl = screen.getByRole("combobox", { name: "Model" });
  expect(
    providerControl.compareDocumentPosition(modelControl) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(modelControl).toHaveTextContent("claude-opus-4-1");
  expect(screen.getByLabelText("Instructions")).toHaveAccessibleDescription(
    "Added to every session's system prompt, after Buzz's own.",
  );
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(await screen.findByRole("option", { name: "Custom model" }));
  const modelId = await screen.findByRole("textbox", { name: "Model ID" });
  expect(modelId).toHaveValue("claude-opus-4-1");
  await user.clear(modelId);
  await user.type(modelId, "claude-sonnet-custom");
  await user.click(screen.getByRole("button", { name: "Use model" }));
  fireEvent.change(screen.getByLabelText("Instructions"), {
    target: { value: "Triage." },
  });
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith({
    ...DEFAULT_CONFIG,
    model: "claude-sonnet-custom",
    instructions: "Triage.",
  });
});

it("keeps settings editable while a provider change waits for Save", async () => {
  const Settings = tab(installed().type, 0);
  const save = vi.fn(async () => undefined);
  render(
    <Settings
      agent={agent()}
      save={save}
      settingsHost={{
        pendingSave: async () => {},
      }}
    />,
  );
  const user = userEvent.setup();
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  expect(screen.getByRole("combobox", { name: "Model" })).toBeEnabled();
  expect(screen.getByRole("textbox", { name: "Workspace" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith(DEFAULT_CONFIG);
});
