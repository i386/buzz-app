// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentProviderSnapshot,
  AgentViewProps,
  Agents,
  AgentsSnapshot,
  RegisteredAgentType,
  TeamChange,
  TeamPort,
} from "../../features/agents/service";
import type {
  OldTeam,
  PortableAgent,
  PortableAgents,
} from "../../features/agents/native";
import type { RelayData } from "../../features/relay/service";
import type { Navigation } from "../../features/navigation/controller";
import type { PageNavigation } from "../../features/navigation/service";
import type { OpenTarget } from "../../features/navigation/targets";
import { PlugIcon, RobotIcon } from "../../shared/design-system/icons";
import { AgentsPage } from "./AgentsPage";

afterEach(cleanup);

const agent = (name: string, n: number): Agent => ({
  pubkey: String(n).repeat(64),
  name,
  type: "test/echo",
  owner: "f".repeat(64),
  relay: "wss://relay.example",
  place: "here",
  config: { reply: `${name} says hi` },
  skipped: {},
  timers: {},
  attentionEnabled: true,
  attention: {
    "interest/default": {
      slug: "interest/default",
      modifiedAt: 1,
      value: { type: "interest", instructions: "Help." },
    },
    "watch/hourly": {
      slug: "watch/hourly",
      modifiedAt: 1,
      value: {
        type: "timer",
        interest_id: "default",
        prompt: "Check in",
        enabled: true,
        interval_secs: 3600,
        armed_at: 1,
        max_occurrences: null,
        expires_at: null,
      },
    },
  },
});

const portable: PortableAgent[] = [
  {
    source: "harness",
    pubkey: "a".repeat(64),
    name: "Ada",
    relay: "wss://relay.example",
  },
  {
    source: "installed",
    pubkey: "b".repeat(64),
    name: "Bea",
    picture: "https://old.example/media/b.png",
    relay: "",
  },
];

function provider(
  initial: AgentProviderSnapshot["readiness"],
  DialogBody: (props: { onClose(): void }) => ReactNode = () => (
    <p>Provider controls</p>
  ),
  attentionLabel = "Set up provider",
) {
  let state: AgentProviderSnapshot =
    initial === "attention"
      ? { readiness: initial, attentionLabel }
      : { readiness: initial };
  let attentionAction: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const check = vi.fn(async () => undefined);
  return {
    contribution: {
      snapshot: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      check,
      get attentionAction() {
        return attentionAction;
      },
      DialogBody,
    },
    check,
    set(next: AgentProviderSnapshot) {
      state = next;
      for (const listener of listeners) listener();
    },
    setAttentionAction(next: (() => void) | undefined) {
      attentionAction = next;
    },
  };
}

function setup(
  saved: Agent[],
  {
    shown = true,
    more = [] as RegisteredAgentType[],
    dirtySettings = false,
    page = {} as {
      navigation?: PageNavigation;
      navigator?: Navigation;
    },
  } = {},
) {
  let snapshot: AgentsSnapshot = {
    status: "ready",
    agents: saved,
    running: saved,
    teams: [],
  };
  const listeners = new Set<() => void>();
  const echoProvider = provider("ready", ({ onClose }) => (
    <>
      <p>Echo controls</p>
      <button type="button" onClick={onClose}>
        Save defaults
      </button>
    </>
  ));
  const DirtySettings = ({ agent, save, settingsHost }: AgentViewProps) => {
    const [reply, setReply] = useState(
      (agent.config as { reply: string }).reply,
    );
    const [error, setError] = useState("");
    const pendingSave = settingsHost?.pendingSave;
    return settingsHost ? (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          void save({ reply }).catch((reason: unknown) =>
            setError(String(reason instanceof Error ? reason.message : reason)),
          );
        }}
      >
        {settingsHost.typeControl?.(true)}
        <p>Provider settings</p>
        <label>
          Reply
          <input
            value={reply}
            onChange={(event) => setReply(event.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={!pendingSave}>
          Save
        </button>
      </form>
    ) : (
      <p>Provider settings</p>
    );
  };
  const tabs = dirtySettings
    ? [
        {
          id: "settings",
          title: "Settings",
          role: "settings" as const,
          component: DirtySettings,
        },
      ]
    : [{ id: "reply", title: "Reply", component: () => <p>Reply tab</p> }];
  const type = {
    key: "test/echo",
    pluginId: "test",
    revision: "1",
    id: "echo",
    title: "Echo",
    icon: RobotIcon,
    description: "Says its line.",
    migrationWarning: "Anything Echo left running will stop.",
    defaults: () => ({ config: { reply: "" } }),
    summary: (item: Agent) => (item.config as { reply: string }).reply,
    Peek: ({ agent }: { agent: Agent }) => <p>Peek of {agent.name}</p>,
    provider: echoProvider.contribution,
    tabs,
    Create: ({
      config,
      onChange,
    }: {
      config: { reply: string };
      onChange(config: { reply: string }): void;
    }) => (
      <input
        aria-label="Reply"
        value={config.reply}
        onChange={(event) => onChange({ reply: event.target.value })}
      />
    ),
  } as unknown as RegisteredAgentType;
  const created = agent("Nova", 3);
  const types = [type, ...more];
  const agents = {
    types: () => types,
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    find: (pubkey: string) => snapshot.agents.find((a) => a.pubkey === pubkey),
    relay: () => undefined,
    register: vi.fn(),
    create: vi.fn(async () => {
      // `shown: false`: it was made for a community no longer selected.
      if (!shown) return created;
      snapshot = { ...snapshot, agents: [...snapshot.agents, created] };
      for (const listener of listeners) listener();
      return created;
    }),
    finish: vi.fn(async (_: string) => created),
    portable: vi.fn(
      async (): Promise<PortableAgents> => ({
        agents: portable,
        teams: [],
        warnings: [],
      }),
    ),
    port: vi.fn(async () => created),
    portTeam: vi.fn(
      async (): Promise<TeamPort> => ({
        imported: [],
        failed: [],
        elsewhere: [],
      }),
    ),
    save: vi.fn(async () => {}),
    previewRetype: vi.fn(
      () =>
        ({
          config: { endpoint: "wss://relay.example" },
          moved: [],
          dropped: ["workspace"],
          settings: [
            {
              id: "model",
              label: "Model",
              outcome: "reset",
            },
            {
              id: "thinking",
              label: "Thinking",
              outcome: "dropped",
            },
          ],
        }) as const,
    ),
    retype: vi.fn(async (pubkey, typeKey, change) => {
      const changed = snapshot.agents.map((saved) =>
        saved.pubkey === pubkey
          ? { ...saved, type: typeKey, config: change?.config ?? {} }
          : saved,
      );
      snapshot = { ...snapshot, agents: changed, running: changed };
      for (const listener of listeners) listener();
      return ["workspace"] as const;
    }),
    remove: vi.fn(async () => {}),
    saveTeam: vi.fn(async (change: TeamChange) => {
      const team = { ...change, id: change.id ?? "team-1" };
      snapshot = {
        ...snapshot,
        teams: [...snapshot.teams.filter((t) => t.id !== team.id), team],
      };
      for (const listener of listeners) listener();
      return team;
    }),
    removeTeam: vi.fn(async (id: string) => {
      snapshot = {
        ...snapshot,
        teams: snapshot.teams.filter((t) => t.id !== id),
      };
      for (const listener of listeners) listener();
    }),
  } satisfies Agents;
  const disconnected = { status: "disconnected", generation: 0 };
  const relay = {
    snapshot: () => disconnected,
    subscribe: () => () => {},
  } as unknown as RelayData;
  const view = render(<AgentsPage agents={agents} relay={relay} {...page} />);
  const show = (next: Agent[]) => {
    snapshot = { ...snapshot, agents: next };
    for (const listener of listeners) listener();
  };
  return { agents, echoProvider, types, show, relay, ...view };
}

async function openAction(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(screen.getByRole("button", { name: "More agent actions" }));
  await user.click(await screen.findByRole("menuitem", { name }));
}

it("peeks at a selected agent beside the grid and follows the arrow keys", async () => {
  const user = userEvent.setup();
  setup([agent("Ada", 1), agent("Bo", 2)]);
  const grid = screen.getByRole("listbox", { name: "Agents" });
  expect(within(grid).getByText("Ada says hi")).toBeInTheDocument();
  expect(screen.queryByText("Peek of Ada")).not.toBeInTheDocument();

  await user.click(within(grid).getByText("Ada"));
  expect(screen.getByRole("option", { name: /Ada/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByText("Peek of Ada")).toBeInTheDocument();
  expect(screen.getByText("Every hour")).toBeInTheDocument();
  expect(screen.getByText("Mentions")).toBeInTheDocument();

  await user.keyboard("{ArrowRight}");
  expect(screen.getByText("Peek of Bo")).toBeInTheDocument();
  expect(screen.getByRole("option", { name: /Bo/ })).toHaveFocus();

  await user.keyboard("{Escape}");
  expect(screen.queryByText("Peek of Bo")).not.toBeInTheDocument();
  expect(grid).toBeInTheDocument();
});

it("opens the build view with the type's tabs and the app's Attention and Memory tabs", async () => {
  const user = userEvent.setup();
  setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("option", { name: /Ada/ }));
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
  expect(tabs).toEqual(["Settings", "Reply", "Attention", "Memory"]);
  expect(
    within(
      screen.getByRole("complementary", { name: "Ada identity" }),
    ).queryByText("Type"),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Reply" }));
  expect(screen.getByText("Reply tab")).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Attention" }));
  expect(screen.getByText("Default")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "All agents" }));
  expect(screen.getByRole("option", { name: /Ada/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("checks active providers in a health submenu and opens their host-owned dialogs", async () => {
  const user = userEvent.setup();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const relay = {
    key: "test/relay",
    pluginId: "test",
    revision: "1",
    id: "relay",
    title: "Relay",
    icon: PlugIcon,
    defaults: () => ({ config: {} }),
  } as unknown as RegisteredAgentType;
  const brokenProvider = provider(
    "attention",
    () => {
      throw new Error("Broken controls");
    },
    "Repair Broken",
  );
  brokenProvider.contribution.check = vi.fn(() => {
    throw new Error("Broken check");
  });
  const broken = {
    ...relay,
    key: "test/broken",
    id: "broken",
    title: "Broken",
    provider: brokenProvider.contribution,
  } as unknown as RegisteredAgentType;
  const checkingProvider = provider("checking");
  const checking = {
    ...relay,
    key: "test/checking",
    id: "checking",
    title: "Checking",
    provider: checkingProvider.contribution,
  } as unknown as RegisteredAgentType;
  try {
    const { echoProvider } = setup([agent("Ada", 1)], {
      more: [relay, broken, checking],
    });
    const more = screen.getByRole("button", { name: "More agent actions" });

    await user.click(more);
    const trigger = await screen.findByRole("menuitem", {
      name: "Provider settings",
    });
    await user.hover(trigger);
    const menu = await screen.findByRole("menu", {
      name: "Provider settings",
    });
    await vi.waitFor(() =>
      expect(menu).not.toHaveAttribute("data-starting-style"),
    );
    expect(screen.getAllByRole("menu")).toHaveLength(2);
    const echo = within(menu).getByRole("menuitem", {
      name: "Echo, ready",
    });
    const relayRow = within(menu).getByRole("menuitem", {
      name: "Relay, unavailable",
    });
    expect(relayRow).toHaveAttribute("aria-disabled", "true");
    expect(
      within(menu).getByRole("menuitem", {
        name: "Repair Broken, attention",
      }),
    ).toBeEnabled();
    const checkingRow = within(menu).getByRole("menuitem", {
      name: "Checking, checking",
    });
    expect(checkingRow).toHaveAttribute("aria-disabled", "true");
    expect(checkingRow).toHaveAttribute("aria-busy", "true");
    expect(
      checkingRow.querySelector(".motion-safe\\:animate-spin"),
    ).toBeVisible();
    expect(echo.querySelector("svg")).toBeInTheDocument();
    expect(checkingProvider.check).toHaveBeenCalled();

    fireEvent.click(echo);
    const dialog = await screen.findByRole("dialog", { name: "Echo" });
    expect(within(dialog).getByText("Echo controls")).toBeVisible();
    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(
      within(dialog.querySelector("header") as HTMLElement).getAllByRole(
        "button",
      ),
    ).toEqual([close]);
    await user.click(
      within(dialog).getByRole("button", { name: "Save defaults" }),
    );
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(more);
    await user.hover(
      await screen.findByRole("menuitem", { name: "Provider settings" }),
    );
    const reopenedProviders = await screen.findByRole("menu", {
      name: "Provider settings",
    });
    fireEvent.click(
      within(reopenedProviders).getByRole("menuitem", {
        name: "Echo, ready",
      }),
    );
    const reopenedDialog = await screen.findByRole("dialog", { name: "Echo" });
    act(() => echoProvider.set({ readiness: "attention" }));
    expect(
      within(reopenedDialog).queryByRole("button", { name: "Check again" }),
    ).toBeNull();
    act(() => echoProvider.set({ readiness: "ready", blocking: true }));
    await user.keyboard("{Escape}");
    expect(reopenedDialog).toBeInTheDocument();
    expect(
      within(reopenedDialog).getByRole("button", { name: "Close" }),
    ).toBeDisabled();
    act(() => echoProvider.set({ readiness: "ready" }));
    await user.click(
      document.querySelector(".buzz-dialog-backdrop") as Element,
    );
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const attentionAction = vi.fn();
    echoProvider.setAttentionAction(attentionAction);
    act(() =>
      echoProvider.set({
        readiness: "attention",
        attentionLabel: "Log in to Echo",
      }),
    );
    await user.click(more);
    await user.hover(
      await screen.findByRole("menuitem", { name: "Provider settings" }),
    );
    const actionableProviders = await screen.findByRole("menu", {
      name: "Provider settings",
    });
    await vi.waitFor(() =>
      expect(actionableProviders).not.toHaveAttribute("data-starting-style"),
    );
    fireEvent.click(
      within(actionableProviders).getByRole("menuitem", {
        name: "Log in to Echo, attention",
      }),
    );
    expect(attentionAction).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Echo" })).toBeNull();

    await user.click(more);
    await user.hover(
      await screen.findByRole("menuitem", { name: "Provider settings" }),
    );
    const providers = await screen.findByRole("menu", {
      name: "Provider settings",
    });
    await vi.waitFor(() =>
      expect(providers).not.toHaveAttribute("data-starting-style"),
    );
    fireEvent.click(
      within(providers).getByRole("menuitem", {
        name: "Repair Broken, attention",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Provider controls are unavailable.",
    );
    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(more).toHaveFocus());
  } finally {
    errors.mockRestore();
  }
});

it("restores a provider dialog from page history and writes open and close visits", async () => {
  const user = userEvent.setup();
  const base = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: null,
  } as const;
  const routed = {
    ...base,
    route: { version: 1, params: { provider: "test/echo" } },
  } as const;
  let current: { id: string; target: OpenTarget } = {
    id: "base",
    target: base,
  };
  const open = vi.fn(async () => ({ status: "opened" as const }));
  const navigator = {
    snapshot: () => ({ entry: current }),
    open,
  } as unknown as Navigation;
  const request = (): PageNavigation => {
    const navigation = {
      entryId: current.id,
      target: current.target,
      signal: new AbortController().signal,
      focus: "content" as const,
      forSession: () => navigation,
      resolve: () => true,
      complete: () => true,
    };
    return navigation;
  };
  const pageView = (agents: Agents, relay: RelayData) => (
    <AgentsPage
      agents={agents}
      relay={relay}
      navigator={navigator}
      navigation={request()}
    />
  );
  const page = { navigator, navigation: request() };
  const view = setup([agent("Ada", 1)], { page });

  await user.click(screen.getByRole("button", { name: "More agent actions" }));
  await user.hover(
    await screen.findByRole("menuitem", { name: "Provider settings" }),
  );
  const providers = await screen.findByRole("menu", {
    name: "Provider settings",
  });
  fireEvent.click(
    within(providers).getByRole("menuitem", { name: "Echo, ready" }),
  );
  expect(open).toHaveBeenLastCalledWith(routed);

  current = { id: "provider", target: routed };
  view.unmount();
  const restored = render(pageView(view.agents, view.relay));
  expect(await screen.findByRole("dialog", { name: "Echo" })).toBeVisible();

  current = { id: "base", target: base };
  restored.rerender(pageView(view.agents, view.relay));
  expect(screen.queryByRole("dialog", { name: "Echo" })).toBeNull();

  current = { id: "provider", target: routed };
  restored.rerender(pageView(view.agents, view.relay));
  await user.click(await screen.findByRole("button", { name: "Close" }));
  await vi.waitFor(() =>
    expect(open).toHaveBeenLastCalledWith(base, { replace: true }),
  );
});

it("shows an agent's picture in the grid, peek and build view", async () => {
  const user = userEvent.setup();
  const picture = "https://old.example/media/a.png";
  setup([{ ...agent("Ada", 1), picture }]);
  const pictures = () =>
    document.querySelectorAll(`img[src="${picture}"]`).length;
  expect(pictures()).toBe(1);
  await user.click(screen.getByRole("option", { name: /Ada/ }));
  expect(pictures()).toBe(2);
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(pictures()).toBe(1);
});

it("edits the picture from the build view and shows why a save failed", async () => {
  const user = userEvent.setup();
  const picture = "https://old.example/media/a.png";
  const { agents } = setup([{ ...agent("Ada", 1), picture }]);
  await user.click(screen.getByRole("option", { name: /Ada/ }));
  await user.keyboard("{Enter}");
  agents.save.mockRejectedValueOnce(new Error("Could not save"));
  await user.click(screen.getByRole("button", { name: "Edit avatar" }));
  await user.click(
    await screen.findByRole("button", { name: "Remove avatar" }),
  );
  expect(agents.save).toHaveBeenCalledWith("1".repeat(64), { picture: null });
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not save");
});

it("saves a reviewed provider change with the destination settings", async () => {
  const user = userEvent.setup();
  const RelaySettings = ({
    agent,
    save,
    settingsHost,
  }: AgentViewProps<{ endpoint: string }>) => {
    const [endpoint, setEndpoint] = useState(agent.config.endpoint);
    const [error, setError] = useState("");
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          void save({ endpoint }).catch((reason: unknown) =>
            setError(String(reason instanceof Error ? reason.message : reason)),
          );
        }}
      >
        {settingsHost?.typeControl?.(false)}
        <label>
          Endpoint
          <input
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit">Save</button>
      </form>
    );
  };
  const relay = {
    key: "test/relay",
    pluginId: "test",
    revision: "1",
    id: "relay",
    title: "Relay",
    icon: PlugIcon,
    defaults: () => ({ config: { endpoint: "wss://relay.example" } }),
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        component: RelaySettings,
      },
    ],
  } as unknown as RegisteredAgentType;
  const { agents } = setup([agent("Ada", 1)], {
    more: [relay],
    dirtySettings: true,
  });
  await user.click(screen.getByRole("option", { name: /Ada/ }));
  await user.keyboard("{Enter}");
  const rail = screen.getByRole("complementary", { name: "Ada identity" });
  expect(
    within(rail).queryByRole("button", { name: "Change provider from Echo" }),
  ).not.toBeInTheDocument();
  agents.retype.mockRejectedValueOnce(new Error("Ada is answering"));
  const typeTrigger = screen.getByRole("button", {
    name: "Change provider from Echo",
  });
  expect(typeTrigger.querySelectorAll("svg")).toHaveLength(2);
  await user.click(typeTrigger);
  const providerMenu = await screen.findByRole("menu");
  const currentChoice = within(providerMenu).getByRole("menuitemradio", {
    name: "Echo",
  });
  const relayChoice = within(providerMenu).getByRole("menuitemradio", {
    name: "Relay",
  });
  expect(currentChoice).toBeChecked();
  expect(relayChoice).not.toBeChecked();
  expect(relayChoice.querySelector("svg")).toBeInTheDocument();
  await user.click(relayChoice);
  const dialog = await screen.findByRole("dialog", {
    name: "Move Ada to Relay?",
  });
  expect(
    screen.queryByRole("dialog", { name: "Change provider" }),
  ).not.toBeInTheDocument();
  expect(agents.retype).not.toHaveBeenCalled();
  expect(within(dialog).queryByText("Instructions")).toBeNull();
  expect(within(dialog).getByText("Workspace").parentElement).toHaveTextContent(
    "WorkspaceDropped",
  );
  expect(within(dialog).getByText("Model").parentElement).toHaveTextContent(
    "ModelResets",
  );
  expect(within(dialog).getByText("Thinking").parentElement).toHaveTextContent(
    "ThinkingDropped",
  );
  expect(dialog).toHaveTextContent(
    "Your agent will continue the conversation in Buzz.",
  );
  expect(dialog).toHaveTextContent("Anything Echo left running will stop.");
  expect(dialog).toHaveTextContent(
    "Unsaved Settings changes will be discarded when you continue.",
  );
  expect(dialog).toHaveTextContent(
    "The provider changes when you save settings.",
  );
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(agents.retype).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Change provider from Relay" }),
  ).toBeVisible();
  expect(screen.queryByText("Provider settings")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("textbox", { name: "Reply" }),
  ).not.toBeInTheDocument();
  const endpoint = screen.getByRole("textbox", { name: "Endpoint" });
  expect(endpoint).toHaveValue("wss://relay.example");
  const save = screen.getByRole("button", { name: "Save" });
  expect(save).toBeEnabled();
  await user.click(save);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Ada is answering",
  );
  expect(agents.retype).toHaveBeenCalledOnce();
  expect(agents.retype).toHaveBeenLastCalledWith("1".repeat(64), "test/relay", {
    config: { endpoint: "wss://relay.example" },
  });
  await user.clear(endpoint);
  await user.type(endpoint, "wss://custom.example");
  await user.click(save);
  expect(agents.retype).toHaveBeenLastCalledWith("1".repeat(64), "test/relay", {
    config: { endpoint: "wss://custom.example" },
  });
  expect(
    screen.getByRole("button", { name: "Change provider from Relay" }),
  ).toBeVisible();
});

it("makes a new agent in the create dialog and goes straight to building it", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("button", { name: "New agent" }));
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  expect(
    within(dialog).getByText("Echo").closest("span")?.querySelector("svg"),
  ).toBeInTheDocument();
  await user.type(within(dialog).getByLabelText("Reply"), "Hi there");
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  expect(agents.create).toHaveBeenCalledWith({
    type: "test/echo",
    name: "Nova",
    picture: expect.stringMatching(/^https:\/\//),
    config: { reply: "Hi there" },
  });
  expect(await screen.findByRole("tab", { name: "Attention" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Nova" })).toBeInTheDocument();
});

it("stays on the grid when the new agent belongs to a community no longer shown", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)], { shown: false });
  await user.click(screen.getByRole("button", { name: "New agent" }));
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  await vi.waitFor(() => expect(agents.create).toHaveBeenCalled());
  expect(
    await screen.findByRole("listbox", { name: "Agents" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("form", { name: "New agent" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "Attention" })).toBeNull();
});

it("saves a rename on Enter and discards it on Escape", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("option", { name: /Ada/ }));
  await user.keyboard("{Enter}");
  const field = within(
    screen.getByRole("complementary", { name: "Ada identity" }),
  ).getByLabelText("Name");
  await user.clear(field);
  await user.type(field, "Discarded{Escape}");
  expect(agents.save).not.toHaveBeenCalled();
  expect(field).toHaveValue("Ada");
  await user.clear(field);
  await user.type(field, "Kept{Enter}");
  expect(agents.save).toHaveBeenCalledExactlyOnceWith("1".repeat(64), {
    name: "Kept",
  });
});

it("imports an earlier agent as the chosen type and shows it in Your agents", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("tab", { name: "Import" }));
  const list = await screen.findByRole("region", { name: "Agents to import" });
  // Names are unique here, so each card shows only where it comes from.
  expect(within(list).getByText("Buzz 1.0 harness agent")).toBeInTheDocument();
  expect(within(list).getByText("Buzz 0.X")).toBeInTheDocument();
  expect(within(list).queryByText(/npub/)).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Import Bea" }));
  expect(agents.port).toHaveBeenCalledWith({
    source: "installed",
    pubkey: "b".repeat(64),
    type: "test/echo",
  });
  expect(screen.getByRole("tab", { name: "Your agents" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("tells same-named agents to import apart by their keys", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  agents.portable.mockResolvedValueOnce({
    agents: [
      ...portable,
      { source: "development", pubkey: "c".repeat(64), name: "Bea", relay: "" },
    ],
    teams: [],
    warnings: [],
  });
  await user.click(screen.getByRole("tab", { name: "Import" }));
  const list = await screen.findByRole("region", { name: "Agents to import" });
  expect(within(list).getByText("Buzz 1.0 harness agent")).toBeInTheDocument();
  expect(within(list).getByText(/^Buzz 0\.X · npub…/)).toBeInTheDocument();
  expect(within(list).getByText(/^Buzz 0\.X dev · npub…/)).toBeInTheDocument();
});

it("imports agents only as a type that runs here", async () => {
  const user = userEvent.setup();
  const { agents, types } = setup([]);
  types.push({
    ...types[0],
    key: "test/cloud",
    title: "Cloud",
    remote: {},
  } as unknown as RegisteredAgentType);
  await user.click(screen.getByRole("tab", { name: "Import" }));
  const importAda = await screen.findByRole("button", { name: "Import Ada" });
  expect(screen.queryByLabelText("Import as")).not.toBeInTheDocument();
  await user.click(importAda);
  expect(agents.port).toHaveBeenCalledWith(
    expect.objectContaining({ type: "test/echo" }),
  );
});

it("shows why importing an agent failed and keeps it listed", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  agents.port.mockRejectedValueOnce(new Error("Keychain access was denied"));
  await user.click(screen.getByRole("tab", { name: "Import" }));
  await user.click(await screen.findByRole("button", { name: "Import Ada" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Keychain access was denied",
  );
  expect(screen.getByRole("button", { name: "Import Ada" })).toBeEnabled();
});

const nightShift: OldTeam = {
  id: "old-night-shift",
  name: "Night Shift",
  instructions: "Ship small.",
  members: [
    { pubkey: "b".repeat(64), name: "Bea", source: "installed" },
    { pubkey: "c".repeat(64), name: "Cy", source: "installed" },
  ],
};
const onImport = () =>
  expect(screen.getByRole("tab", { name: "Import" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

it("lists old teams apart from agents, and imports one as a team", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  agents.portable.mockResolvedValueOnce({
    agents: portable,
    teams: [nightShift],
    warnings: [],
  });
  await user.click(screen.getByRole("tab", { name: "Import" }));
  const teams = await screen.findByRole("region", { name: "Teams to import" });
  expect(
    within(teams).getByRole("heading", { name: "Teams" }),
  ).toBeInTheDocument();
  expect(within(teams).getByText("Night Shift")).toBeInTheDocument();
  // Cy is here already; Bea is still listed as an agent.
  expect(
    within(teams).getByText("2 members · 1 already here"),
  ).toBeInTheDocument();
  const list = screen.getByRole("region", { name: "Agents to import" });
  expect(within(list).queryByText(/team/i)).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Import team Night Shift" }),
  );
  expect(agents.portTeam).toHaveBeenCalledWith({
    id: "old-night-shift",
    type: "test/echo",
  });
  expect(screen.getByRole("tab", { name: "Your agents" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("keeps a team whose members are all here importable with no agents to list", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  agents.portable.mockResolvedValueOnce({
    agents: [],
    teams: [nightShift],
    warnings: [],
  });
  await user.click(screen.getByRole("tab", { name: "Import" }));
  await user.click(
    await screen.findByRole("button", { name: "Import team Night Shift" }),
  );
  expect(
    screen.queryByRole("region", { name: "Agents to import" }),
  ).not.toBeInTheDocument();
  expect(agents.portTeam).toHaveBeenCalled();
  expect(screen.getByRole("tab", { name: "Your agents" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("stays on Import and names each part of a team import that did not come", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  agents.portable.mockResolvedValue({
    agents: portable,
    teams: [nightShift],
    warnings: [],
  });
  const team = { id: "t", name: "Night Shift", instructions: "", members: [] };
  agents.portTeam
    .mockResolvedValueOnce({
      team,
      imported: [{ ...agent("Bea", 2), pubkey: "b".repeat(64) }],
      failed: [{ name: "Cy", error: "Keychain access was denied" }],
      elsewhere: [],
    })
    .mockResolvedValueOnce({
      imported: [],
      failed: [],
      elsewhere: ["Cy"],
      teamError: { name: "Night Shift" },
    })
    .mockResolvedValueOnce({
      team,
      imported: [],
      failed: [],
      elsewhere: ["Cy"],
    });
  await user.click(screen.getByRole("tab", { name: "Import" }));
  const importTeam = await screen.findByRole("button", {
    name: "Import team Night Shift",
  });
  await user.click(importTeam);
  onImport();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Imported team Night Shift with Bea. Couldn't import Cy: Keychain access was denied.",
  );
  // Bea came, so it is no longer offered on its own.
  expect(
    screen.queryByRole("button", { name: "Import Bea" }),
  ).not.toBeInTheDocument();
  await user.click(importTeam);
  onImport();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Couldn't save team Night Shift. Add its members in Teams. Kept out: Cy, in another community.",
  );
  await user.click(importTeam);
  onImport();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Imported team Night Shift. Kept out: Cy, in another community.",
  );
});

it("makes a team of chosen agents and lists it with its members", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const { agents } = setup([ada, agent("Bo", 2), agent("Cy", 3)]);
  await openAction(user, "Teams");
  expect(screen.getByText("No teams yet.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "New team" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Crew");
  await user.type(
    screen.getByRole("textbox", { name: "Instructions" }),
    "Ada leads.",
  );
  await user.click(screen.getByRole("checkbox", { name: "Ada" }));
  await user.click(screen.getByRole("checkbox", { name: "Cy" }));
  await user.click(screen.getByRole("button", { name: "Create team" }));

  expect(agents.saveTeam).toHaveBeenCalledWith({
    name: "Crew",
    instructions: "Ada leads.",
    members: [ada.pubkey, agent("Cy", 3).pubkey],
  });
  const list = screen.getByRole("list", { name: "Teams" });
  expect(within(list).getByText("Crew")).toBeInTheDocument();
  expect(within(list).getByText("Ada, Cy")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Edit Crew" }));
  await user.click(screen.getByRole("button", { name: "Delete team" }));
  expect(agents.removeTeam).toHaveBeenCalledWith("team-1");
  expect(screen.getByText("No teams yet.")).toBeInTheDocument();
});

it("shows an agent on another device read-only, and offers only Finish setup and Delete for an unfinished hosted one", async () => {
  const user = userEvent.setup();
  const far: Agent = {
    ...agent("Far", 3),
    place: "elsewhere",
    attention: {},
  };
  const sky: Agent = {
    ...agent("Sky", 4),
    place: "hosted",
    unfinished: true,
    attention: {},
  };
  const { agents } = setup([far, sky]);
  const grid = screen.getByRole("listbox", { name: "Agents" });
  expect(within(grid).getByText("On another device")).toBeInTheDocument();
  expect(within(grid).getByText("Setup unfinished")).toBeInTheDocument();

  await user.click(within(grid).getByText("Far"));
  expect(screen.getByText(/another of your devices/)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Open" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Wakes on")).not.toBeInTheDocument();
  await user.dblClick(within(grid).getByText("Far"));
  expect(screen.getByRole("listbox")).toBeInTheDocument();

  await user.click(within(grid).getByText("Sky"));
  expect(
    screen.queryByRole("button", { name: "Open" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Delete agent" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Finish setup" }));
  expect(agents.finish).toHaveBeenCalledWith(sky.pubkey);
  await user.dblClick(within(grid).getByText("Sky"));
  expect(screen.getByRole("listbox")).toBeInTheDocument();
});

it("moves focus from Finish setup to Open once the setup finishes", async () => {
  const user = userEvent.setup();
  const finished: Agent = {
    ...agent("Sky", 4),
    place: "hosted",
    attention: {},
  };
  const { agents, show } = setup([{ ...finished, unfinished: true }]);
  agents.finish.mockImplementationOnce(async () => {
    show([finished]);
    return finished;
  });
  await user.click(screen.getByText("Sky"));
  screen.getByRole("button", { name: "Finish setup" }).focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("button", { name: "Open" })).toHaveFocus();
});
