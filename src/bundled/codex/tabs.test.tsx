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
import type { AgentViewProps } from "../../features/agents/service";
import type { HostProcessOptions } from "../../features/host/service";
import type { RelayData } from "../../features/relay/service";
import { defaults, type Config } from "./config";
import { PanelSubviewHost } from "../../features/panels/PanelSubview";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
import { createTabs } from "./tabs";
import { CodexRuntime } from "./runtime";
import { sessionTag } from "./prompt";
import type { Wire } from "./rpc";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  // jsdom has no layout observers; the compact model picker sizes itself with one.
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
});
async function choose(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}
function fixture(
  saved: Record<string, unknown> = {},
  turns: (threadId: string) => Wire = () => ({ result: { data: [] } }),
  /** What `thread/list` finds, or the error message it fails with. */
  threads: { id: string; name: string; updatedAt: number }[] | string = [],
) {
  const processes: { end: ReturnType<typeof vi.fn> }[] = [];
  const spawn = vi.fn(async (_id: string, options?: HostProcessOptions) => {
    const exit = deferred<number | null>();
    const process = {
      write: async (text: string) => {
        const wire: Wire = JSON.parse(text);
        if (wire.id == null) return;
        let result: unknown = {};
        if (wire.method === "thread/turns/list") {
          const reply = turns((wire.params as { threadId: string }).threadId);
          options?.onStdout?.(`${JSON.stringify({ id: wire.id, ...reply })}\n`);
          return;
        }
        if (wire.method === "thread/list") {
          const { searchTerm } = wire.params as { searchTerm: string };
          if (typeof threads === "string") {
            const error = { code: -32603, message: threads };
            options?.onStdout?.(`${JSON.stringify({ id: wire.id, error })}\n`);
            return;
          }
          result = {
            data: threads.filter((thread) => thread.name.includes(searchTerm)),
          };
        }
        if (wire.method === "account/read")
          result = { account: { type: "chatgpt", email: "test@example.com" } };
        if (wire.method === "model/list")
          result = {
            data: [
              {
                id: "a",
                model: "model-a",
                displayName: "Model A",
                isDefault: true,
                defaultReasoningEffort: "low",
                supportedReasoningEfforts: [
                  { reasoningEffort: "low" },
                  { reasoningEffort: "high" },
                ],
              },
              {
                id: "b",
                model: "model-b",
                displayName: "Model B",
                defaultReasoningEffort: "medium",
                supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
              },
            ],
            nextCursor: null,
          };
        options?.onStdout?.(`${JSON.stringify({ id: wire.id, result })}\n`);
      },
      end: vi.fn(async () => {
        exit.resolve(0);
      }),
      kill: vi.fn(async () => {
        exit.resolve(null);
      }),
      exited: exit.promise,
    };
    processes.push(process);
    return process;
  });
  const relay = {
    snapshot: () => ({
      status: "ready",
      session: {
        channels: {
          list: () => ({ channels: [{ id: "channel", name: "general" }] }),
        },
      },
    }),
  } as unknown as RelayData;
  const storage = {
    getItem: () => JSON.stringify(saved),
    setItem: () => undefined,
  } as unknown as Storage;
  const runtime = new CodexRuntime(spawn, () => relay, storage);
  const tabs = createTabs(spawn, runtime);
  const props = (settings = defaults, save = vi.fn(async () => {})) =>
    ({
      agent: { pubkey: "a".repeat(64), name: "Sol", config: settings },
      save,
    }) as unknown as AgentViewProps<Config>;
  return { spawn, processes, tabs, props };
}
it("loads model/effort choices and saves only after a validated workspace, holding the saving state", async () => {
  const f = fixture();
  const saving = deferred<void>();
  const save = vi.fn(() => saving.promise);
  render(<f.tabs.SettingsTab {...f.props(defaults, save)} />);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue(
      "Codex default · Model A",
    ),
  );
  await choose("Model", "Model B");
  const thinking = screen.getByRole("combobox", { name: "Thinking" });
  expect(thinking).toHaveTextContent("Medium");
  await userEvent.setup().click(thinking);
  expect(
    screen.queryByRole("option", { name: "High" }),
  ).not.toBeInTheDocument();
  await userEvent.setup().keyboard("{Escape}");
  fireEvent.change(screen.getByLabelText("Workspace"), {
    target: { value: "relative" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("alert");
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Workspace"), {
    target: { value: "/tmp/codex" },
  });
  fireEvent.change(screen.getByLabelText("Instructions"), {
    target: { value: "Custom instructions" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  try {
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        ...defaults,
        model: "model-b",
        effort: "medium",
        workspace: "/tmp/codex",
        instructions: "Custom instructions",
      }),
    );
    expect(screen.getByRole("button", { name: "Saving…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByLabelText("Workspace")).toBeDisabled();
  } finally {
    saving.resolve();
  }
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
  );
  expect(f.processes[0]?.end).toHaveBeenCalled();
});
/** Holds the next spawn until `release`, returning its process, which the
 * view has not seen yet. */
async function holdSpawn(f: ReturnType<typeof fixture>) {
  const late = deferred<Awaited<ReturnType<typeof f.spawn>>>();
  const started = deferred<void>();
  const original = f.spawn.getMockImplementation();
  if (!original) throw new Error("Missing spawn fixture");
  let process!: Awaited<ReturnType<typeof f.spawn>>;
  f.spawn.mockImplementationOnce(async (id, options) => {
    process = await original(id, options);
    started.resolve();
    return late.promise;
  });
  return {
    started: started.promise,
    release: () => late.resolve(process),
    process: () => process,
  };
}
it("preserves unavailable saved choices and closes a process returned after unmount", async () => {
  const f = fixture();
  const saved = {
    ...defaults,
    model: "retired-model",
    effort: "high",
    workspace: "/tmp/codex",
  };
  const view = render(<f.tabs.SettingsTab {...f.props(saved)} />);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue(
      "retired-model",
    ),
  );
  await waitFor(() => expect(f.processes[0]?.end).toHaveBeenCalled());
  expect(screen.getByRole("combobox", { name: "Thinking" })).toHaveTextContent(
    "High (unavailable)",
  );
  view.unmount();
  const held = await holdSpawn(f);
  const pending = render(<f.tabs.CodexTab {...f.props(saved)} />);
  await held.started;
  pending.unmount();
  held.release();
  await waitFor(() => expect(held.process().end).toHaveBeenCalled());
});

it("starts a new agent from a model and instructions, keeping the rest", async () => {
  const f = fixture();
  const config = {
    ...defaults,
    model: "model-a",
    effort: "high",
    workspace: "/work",
    scope: "channel" as const,
  };
  const onChange = vi.fn();
  render(
    <f.tabs.Create config={config} onChange={onChange} disabled={false} />,
  );
  await choose("Model", "Model B");
  // The new model's own effort replaces the old one.
  expect(onChange).toHaveBeenLastCalledWith({
    ...config,
    model: "model-b",
    effort: "medium",
  });
  fireEvent.change(screen.getByLabelText("Instructions"), {
    target: { value: "Triage." },
  });
  expect(onChange).toHaveBeenLastCalledWith({
    ...config,
    instructions: "Triage.",
  });
  await choose("Model", "Codex default · Model A");
  expect(onChange).toHaveBeenLastCalledWith({
    ...config,
    model: "",
    effort: "",
  });
});

it("lets a new agent use the default or a typed model when the catalog fails", async () => {
  const f = fixture();
  f.spawn.mockRejectedValueOnce(new Error("no codex"));
  const onChange = vi.fn();
  render(
    <f.tabs.Create
      config={{ ...defaults, effort: "high" }}
      onChange={onChange}
      disabled={false}
    />,
  );
  const model = screen.getByRole("combobox", { name: "Model" });
  expect(model).toHaveValue("Codex default");
  await waitFor(() => expect(f.spawn).toHaveBeenCalled());
  const user = userEvent.setup();
  await user.clear(model);
  await user.type(model, "gpt-custom{Enter}");
  expect(onChange).toHaveBeenLastCalledWith({
    ...defaults,
    model: "gpt-custom",
    effort: "",
  });
});

it("checks the catalog for a new agent only while its view is mounted", async () => {
  const f = fixture();
  const held = await holdSpawn(f);
  expect(f.spawn).not.toHaveBeenCalled();
  const view = render(
    <f.tabs.Create config={defaults} onChange={vi.fn()} disabled={false} />,
  );
  await held.started;
  view.unmount();
  held.release();
  await waitFor(() => expect(held.process().end).toHaveBeenCalled());
});

it("shows the default workspace and restores it when the field is cleared", async () => {
  const f = fixture();
  const save = vi.fn(async () => {});
  render(<f.tabs.SettingsTab {...f.props(defaults, save)} />);
  expect(screen.getByLabelText("Workspace")).toHaveValue("~/.buzz");
  await waitFor(() => expect(f.processes[0]?.end).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("Instructions"), {
    target: { value: "Test instructions" },
  });
  const expected = { ...defaults, instructions: "Test instructions" };
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expected));
  await waitFor(() => expect(screen.getByLabelText("Workspace")).toBeEnabled());
  save.mockClear();
  fireEvent.change(screen.getByLabelText("Workspace"), {
    target: { value: "   " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expected));
});

it("lists saved conversations and shows one's Codex thread, or that Codex no longer has it", async () => {
  const root = "e".repeat(64);
  const f = fixture(
    {
      [JSON.stringify(["channel", "channel"])]: {
        threadId: "deleted",
        workspace: "/w",
        at: 1,
      },
      [JSON.stringify(["channel", root])]: {
        threadId: "kept",
        workspace: "/w",
        at: 2,
      },
    },
    (threadId) =>
      threadId === "kept"
        ? {
            result: {
              data: [
                {
                  id: "turn-1",
                  status: "completed",
                  error: null,
                  startedAt: 1,
                  completedAt: 2,
                  items: [
                    {
                      type: "userMessage",
                      id: "u",
                      content: [
                        { type: "text", text: 'Request: "what changed?"' },
                      ],
                    },
                    { type: "agentMessage", id: "a", text: "Two files." },
                  ],
                },
              ],
              nextCursor: null,
            },
          }
        : {
            error: { code: -32600, message: `thread not loaded: ${threadId}` },
          },
  );
  render(
    <PanelSubviewHost close={vi.fn()}>
      <f.tabs.CodexTab {...f.props()} />
    </PanelSubviewHost>,
  );
  const user = userEvent.setup();
  const viewButton = (index: number) =>
    screen.getAllByRole("button", { name: "View transcript" })[
      index
    ] as HTMLElement;
  expect(screen.getByText(/#general · thread eeeeeeee/)).toBeVisible();
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
    await screen.findByText(/Codex has no history for this conversation/),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("sets the conversation the profile was opened from apart from the recent ones", async () => {
  const root = "e".repeat(64);
  const f = fixture(
    {
      [JSON.stringify(["channel", "channel"])]: {
        threadId: "channel-thread",
        workspace: "/w",
        at: 1,
      },
      [JSON.stringify(["channel", root])]: {
        threadId: "kept",
        workspace: "/w",
        at: 2,
      },
    },
    () => ({ result: { data: [], nextCursor: null } }),
  );
  const here = (conversation: { channelId: string; rootId?: string }) =>
    render(<f.tabs.CodexTab {...f.props()} conversation={conversation} />);
  const opened = (name: string) =>
    screen.getByRole("region", { name }) as HTMLElement;
  here({ channelId: "channel", rootId: root });
  expect(opened("This thread")).toHaveTextContent("#general");
  expect(screen.queryByText(/thread eeeeeeee/)).toBeNull();
  expect(screen.getByText(/#general · channel/)).toBeVisible();
  fireEvent.click(
    within(opened("This thread")).getByRole("button", {
      name: "View transcript",
    }),
  );
  expect(
    await screen.findByRole("heading", { name: "#general · thread eeeeeeee" }),
  ).toBeVisible();
  cleanup();
  // A thread without its own session falls back to the channel's, once
  // Codex has no thread for it either.
  here({ channelId: "channel", rootId: "f".repeat(64) });
  expect(opened("This thread")).toHaveTextContent(
    "Looking for a Codex session…",
  );
  expect(
    await screen.findByRole("region", { name: "This channel" }),
  ).toHaveTextContent("#general");
  expect(screen.getByText(/#general · thread eeeeeeee/)).toBeVisible();
  cleanup();
  here({ channelId: "elsewhere", rootId: root });
  await waitFor(() =>
    expect(opened("This thread")).toHaveTextContent(
      "No Codex session here yet",
    ),
  );
  expect(
    screen.getAllByRole("button", { name: "View transcript" }),
  ).toHaveLength(2);
});

it("brings an open transcript's tab back, and closes it for good when the profile is opened from elsewhere", async () => {
  const root = "e".repeat(64);
  const f = fixture(
    {
      [JSON.stringify(["channel", root])]: {
        threadId: "kept",
        workspace: "/w",
        at: 2,
      },
    },
    () => ({ result: { data: [], nextCursor: null } }),
  );
  const Panel = ({
    conversation,
  }: {
    conversation: { channelId: string; rootId?: string };
  }) => (
    <PanelWorkspace
      value="profile"
      select={() => undefined}
      items={[
        {
          id: "profile",
          label: "Sol",
          close: () => undefined,
          content: (
            <f.tabs.CodexTab {...f.props()} conversation={conversation} />
          ),
        },
      ]}
    />
  );
  const user = userEvent.setup();
  const view = render(
    <Panel conversation={{ channelId: "channel", rootId: root }} />,
  );
  const tab = (name: string) => screen.getByRole("tab", { name });
  const viewHere = () =>
    user.click(
      within(screen.getByRole("region", { name: "This thread" })).getByRole(
        "button",
        { name: "View transcript" },
      ),
    );
  const transcript = "#general · thread eeeeeeee";
  await viewHere();
  expect(tab(transcript)).toHaveAttribute("aria-selected", "true");
  await user.click(tab("Sol"));
  await viewHere();
  expect(tab(transcript)).toHaveAttribute("aria-selected", "true");
  view.rerender(<Panel conversation={{ channelId: "channel" }} />);
  expect(screen.queryByRole("tab", { name: transcript })).toBeNull();
  expect(tab("Sol")).toHaveAttribute("aria-selected", "true");
  // Back in the first conversation, it stays closed until viewed again.
  view.rerender(
    <Panel conversation={{ channelId: "channel", rootId: root }} />,
  );
  expect(screen.queryByRole("tab", { name: transcript })).toBeNull();
  await viewHere();
  expect(tab(transcript)).toHaveAttribute("aria-selected", "true");
});

it("finds the thread's Codex thread another build of the app started", async () => {
  const root = "f".repeat(64);
  const tag = sessionTag("a".repeat(64), { channelId: "channel", root });
  const f = fixture(
    {},
    (threadId) => ({
      result: {
        data:
          threadId === "elsewhere"
            ? [
                {
                  id: "turn-1",
                  status: "completed",
                  error: null,
                  startedAt: 1,
                  completedAt: 2,
                  items: [
                    {
                      type: "userMessage",
                      id: "u",
                      content: [
                        { type: "text", text: 'Request: "what changed?"' },
                      ],
                    },
                  ],
                },
              ]
            : [],
        nextCursor: null,
      },
    }),
    [{ id: "elsewhere", name: `Buzz #general · Sol · ${tag}`, updatedAt: 5 }],
  );
  render(
    <f.tabs.CodexTab
      {...f.props()}
      conversation={{ channelId: "channel", rootId: root }}
    />,
  );
  const opened = screen.getByRole("region", { name: "This thread" });
  fireEvent.click(
    await within(opened).findByRole("button", { name: "View transcript" }),
  );
  expect(await screen.findByText("what changed?")).toBeVisible();
});

it("says when looking for another build's thread failed", async () => {
  const f = fixture({}, undefined, "database is locked");
  render(
    <f.tabs.CodexTab {...f.props()} conversation={{ channelId: "channel" }} />,
  );
  expect(
    await within(
      screen.getByRole("region", { name: "This channel" }),
    ).findByRole("alert"),
  ).toHaveTextContent("Could not look for a Codex session: database is locked");
});
