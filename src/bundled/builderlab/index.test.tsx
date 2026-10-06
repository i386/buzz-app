// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
import type { KnownCommunities } from "../../features/communities/service";
import { HostService, type HostResponse } from "../../features/host/service";
import { SettingsCardsService } from "../../features/settings/service";
import {
  AgentsService,
  type AgentCommunities,
} from "../../features/agents/service";
import { AgentsPage } from "../agents/AgentsPage";
import * as builderlab from "./index";
import { PluginRuntime } from "../../plugins/runtime";
import type { PluginInfo } from "../../plugins/types";
import manifest from "./manifest.json";
import type { OAuthCallback } from "./oauth/browser";
import { deferred } from "./test-helpers";
import { communityFixture } from "./agents/community-testing";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";

const native = vi.hoisted(() => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);
stubAvatarBrowserApis();
/** The device's identity, which the account must be bound to before its
 * community list follows the sign-in. */
const viewer = "cd".repeat(32);
function provideKnownCommunities(root: Context) {
  const knownCommunities: KnownCommunities = {
    snapshot: () => ({
      status: "ready",
      relayAvailable: true,
      profile: { name: "", picture: "" },
      sync: { known: {}, outbox: [] },
      viewer,
      selected: null,
      memberships: [],
    }),
    subscribe: () => () => {},
    pending: () => [],
    apply: vi.fn(async () => {}),
    status: vi.fn(),
  };
  root.provide("knownCommunities", knownCommunities);
  return knownCommunities;
}
beforeEach(() => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  vi.stubGlobal("navigator", {
    platform: "MacIntel",
    locks: {
      request: async (
        _name: string,
        _options: unknown,
        work: () => Promise<void>,
      ) => work(),
    },
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  native.invoke.mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function provideAgents(
  root: Context,
  community: ReturnType<typeof communityFixture>,
) {
  const communities = {
    ...community.reader,
    open: () => community.relay,
  } as unknown as AgentCommunities;
  return new AgentsService(root, communities, {
    list: async () => [],
    create: vi.fn(),
    portable: vi.fn(),
    port: vi.fn(),
    rename: vi.fn(),
    setPicture: vi.fn(),
    setType: vi.fn(),
    remove: vi.fn(),
    forget: vi.fn(),
    publish: vi.fn(),
    publishProfile: vi.fn(),
    query: vi.fn(),
    upload: vi.fn(),
    media: vi.fn(),
    remember: vi.fn(),
    claim: async () => true,
    release: vi.fn(),
  });
}

it.each([undefined, "", "http://builderlab.example"])(
  "an unavailable desktop build (%s) shows setup guidance without login or an agent type",
  async (url) => {
    vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", url);
    const root = new Context();
    const runtime = new PluginRuntime(root, async () => builderlab);
    new HostService(root);
    provideKnownCommunities(root);
    const cards = new SettingsCardsService(root);
    const community = communityFixture(null);
    const agents = provideAgents(root, community);
    try {
      runtime.reconcile([
        {
          manifest: { ...manifest, apiVersion: 1 },
          source: "bundled",
          revision: "bundled",
          enabled: true,
          previous: null,
          reloadable: false,
          error: null,
        },
      ]);
      await waitFor(() => expect(cards.snapshot()).toHaveLength(1));
      const card = cards.snapshot()[0];
      if (!card) throw new Error("Missing Builderlab card");
      const Card = card.component;
      render(<Card active={() => true} />);
      expect(screen.getByRole("status")).toHaveTextContent(
        /not configured|does not support/,
      );
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(native.invoke).not.toHaveBeenCalled();
      expect(agents.types()).toHaveLength(0);
      cleanup();
      render(<AgentsPage agents={agents} relay={community.relay} />);
      expect(
        await screen.findByText("Enable an agent type plugin to make one."),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "New agent" }),
      ).not.toBeInTheDocument();
    } finally {
      cleanup();
      await runtime.dispose();
      await root.fiber.dispose();
      await community.dispose();
    }
  },
);

it("shares plugin login with Settings, hosted Agents and community sync, replays failed setup writes, and clears login on re-enable", async () => {
  const user = userEvent.setup();
  const hostedKey = "de".repeat(32);
  const browserKey = "09".repeat(32);
  let browserCreated = false;
  let browserInstructions = "Be concise.";
  let instructionsSave: ReturnType<typeof deferred<HostResponse>> | undefined;
  let loginCallback: ReturnType<typeof deferred<OAuthCallback>> | undefined;
  const hostRequests = () =>
    native.invoke.mock.calls
      .filter(([command]) => command === "plugin_host_request")
      .map(([, input]) => input);
  const requestsTo = (endpoint: string) =>
    hostRequests().filter((input) =>
      input.request.url.endsWith(`/${endpoint}`),
    );
  const loginWaits = () =>
    native.invoke.mock.calls.filter(
      ([command]) => command === "oauth_callback_wait",
    );
  native.invoke.mockImplementation(async (command, input) => {
    if (command === "oauth_callback_begin")
      return {
        id: "native-attempt-id",
        callbackUrl: `http://127.0.0.1:12345${input.callbackPath}`,
      };
    if (command === "oauth_callback_wait")
      return loginCallback?.promise ?? { parameters: [["code", "one-time"]] };
    if (command === "oauth_callback_cancel") return;
    if (command === "identity_restore") return community.viewer;
    if (command === "identity_prepare_remote_agent_authorization")
      return ["auth", community.viewer, "", "ef".repeat(64)];
    if (command !== "plugin_host_request")
      throw new Error(`Unexpected command ${command}`);
    const { url, body } = input.request;
    let result: unknown;
    if (url.endsWith("/exchange")) {
      result = { session_credential: "private-token" };
    } else if (url.endsWith("/me")) {
      result = { subject: "user", email: "a@example.com" };
    } else if (url.endsWith("/list-agents")) {
      result = {
        status: 1,
        agents: browserCreated
          ? [
              {
                agent_id: "browser",
                agent_name: "Browser",
                agent_pubkey: browserKey,
                status: 2,
                agent_instructions: browserInstructions,
              },
            ]
          : [],
      };
    } else if (url.endsWith("/register-agent")) {
      const name = JSON.parse(body).agent_name;
      const hosted = name === "Hosted";
      if (name === "Browser") browserCreated = true;
      result = {
        status: 1,
        agent_id: hosted ? "hosted" : "browser",
        agent_pubkey: hosted ? hostedKey : browserKey,
      };
    } else if (url.endsWith("/attest-agent")) {
      result = { status: 1 };
    } else if (url.endsWith("/update-agent")) {
      if (instructionsSave) return instructionsSave.promise;
      browserInstructions = JSON.parse(body).agent_instructions;
      result = { status: 1 };
    } else if (url.endsWith("/delete-agent")) {
      result = { status: 1 };
    } else if (url.endsWith("/nostr-identities/current")) {
      result = { identity: { pubkey_hex: viewer } };
    } else if (url.endsWith("/known-communities/list")) {
      result = { communities: [] };
    } else {
      throw new Error(`Unexpected Builderlab request ${url}`);
    }
    return { status: 200, headers: {}, body: JSON.stringify(result) };
  });
  const root = new Context();
  const runtime = new PluginRuntime(root, async () => builderlab);
  new HostService(root);
  const knownCommunities = provideKnownCommunities(root);
  const cards = new SettingsCardsService(root);
  const community = communityFixture();
  const agents = provideAgents(root, community);
  const plugin: PluginInfo = {
    manifest: { ...manifest, apiVersion: 1 },
    source: "bundled",
    revision: "bundled",
    enabled: true,
    previous: null,
    reloadable: false,
    error: null,
  };
  try {
    runtime.reconcile([plugin]);
    await waitFor(() => expect(cards.snapshot()).toHaveLength(1));
    expect(agents.types()).toMatchObject([
      { key: "block.builderlab/builderlab", title: "Builderlab" },
    ]);
    expect(agents.types()[0]?.defaults()).toEqual({ config: {} });
    const picker = render(
      <AgentsPage agents={agents} relay={community.relay} />,
    );
    const providerUser = userEvent.setup();
    await providerUser.click(
      screen.getByRole("button", { name: "More agent actions" }),
    );
    await providerUser.hover(
      await screen.findByRole("menuitem", { name: "Provider settings" }),
    );
    const providers = await screen.findByRole("menu", {
      name: "Provider settings",
    });
    await waitFor(() =>
      expect(providers).not.toHaveAttribute("data-starting-style"),
    );
    fireEvent.click(
      within(providers).getByRole("menuitem", {
        name: "Log in to Builderlab, attention",
      }),
    );
    const providerDialog = await screen.findByRole("dialog", {
      name: "Builderlab",
    });
    await providerUser.click(
      within(providerDialog).getByRole("button", {
        name: "Sign in with Builderlab",
      }),
    );
    expect(
      await within(providerDialog).findByRole("button", { name: "Sign out" }),
    ).toBeEnabled();
    picker.unmount();
    const card = cards.snapshot()[0];
    expect(card?.group).toBe("Integrations");
    if (!card) throw new Error("Missing Builderlab login card");
    const Card = card.component;
    const mounted = render(<Card active={() => true} />);
    expect(
      await screen.findByRole("button", { name: "Sign out" }),
    ).toBeEnabled();
    expect(
      await screen.findByText("No remote agents yet."),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Signed in as a@example.com.",
    );
    expect(document.body).not.toHaveTextContent("private-token");
    expect(native.invoke).toHaveBeenCalledWith("oauth_callback_wait", {
      id: "native-attempt-id",
    });
    // The signed-in account's community list follows through the same wiring:
    // the binding is checked, then the complete list is read.
    await waitFor(() =>
      expect(knownCommunities.status).toHaveBeenLastCalledWith({
        phase: "synced",
        pending: 0,
      }),
    );
    const requests = hostRequests();
    const [account, sync] = [
      requests.filter((input) => !input.request.url.includes("/v1/buzz/")),
      requests.filter((input) => input.request.url.includes("/v1/buzz/")),
    ];
    expect(account).toHaveLength(3);
    expect(
      requests.every(
        (input) =>
          input.id === "block.builderlab" && input.revision === "bundled",
      ),
    ).toBe(true);
    // Prove the account login supplies this consumer's credential through the real plugin wiring.
    expect(account.at(-1).request.headers["X-BB-Session-Credential"]).toBe(
      "private-token",
    );
    expect(sync.map((input) => input.request.url)).toEqual([
      "https://builderlab.example/api/goose/v1/buzz/nostr-identities/current",
      "https://builderlab.example/api/goose/v1/buzz/known-communities/list",
    ]);
    expect(
      sync.every(
        (input) =>
          input.request.headers["X-BB-Session-Credential"] === "private-token",
      ),
    ).toBe(true);
    expect(sync[1].request.body).toBe(JSON.stringify({ pubkey_hex: viewer }));
    // Both writes happen after Beekeeper has returned the identity. Neither
    // failure may turn a retry into a second backend creation.
    for (const failedKey of [
      `buzz.builderlab.adapter-identity.v1:${hostedKey}`,
      "buzz.agents.unfinished.v1",
    ]) {
      const setItem = localStorage.setItem.bind(localStorage);
      const storageFailure = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation((key, value) => {
          if (key === failedKey) throw new Error(`Storage full: ${failedKey}`);
          setItem(key, value);
        });
      try {
        await act(async () => {
          await expect(
            agents.create({
              type: "block.builderlab/builderlab",
              name: "Hosted",
            }),
          ).rejects.toThrow(`Storage full: ${failedKey}`);
        });
        expect(agents.find(hostedKey)).toBeUndefined();
      } finally {
        storageFailure.mockRestore();
      }
    }
    await act(async () => {
      await agents.create({
        type: "block.builderlab/builderlab",
        name: "Hosted",
      });
    });
    expect(agents.find(hostedKey)).toMatchObject({
      name: "Hosted",
      place: "hosted",
      type: "block.builderlab/builderlab",
    });
    expect(agents.find(hostedKey)?.unfinished).toBeUndefined();
    expect(
      community.events.filter((event) => event.kind === 30177),
    ).toHaveLength(1);
    expect(community.events.at(-1)?.tags).toContainEqual([
      "runtime",
      "block.builderlab/builderlab",
    ]);
    const hostedRequests = hostRequests()
      .filter((input) => /\/(register|attest)-agent$/.test(input.request.url))
      .map((input) => JSON.parse(input.request.body));
    const provisions = hostedRequests.filter(
      (body) => body.agent_name === "Hosted",
    );
    expect(provisions).toHaveLength(3);
    expect(provisions.map((body) => body.idempotency_key)).toEqual([
      provisions[0].idempotency_key,
      provisions[0].idempotency_key,
      provisions[0].idempotency_key,
    ]);
    expect(hostedRequests.at(-1)).toEqual({
      agent_pubkey: hostedKey,
      community_url: "wss://community.example",
      owner_auth_tag_json: JSON.stringify([
        "auth",
        community.viewer,
        "",
        "ef".repeat(64),
      ]),
    });
    await expect(agents.save(hostedKey, { name: "Renamed" })).rejects.toThrow(
      "profile updates are not supported yet",
    );
    await act(async () => {
      await agents.remove(hostedKey);
    });
    expect(agents.find(hostedKey)).toBeUndefined();
    expect(community.events.at(-1)?.tags).toContainEqual([
      "a",
      `30177:${community.viewer}:${hostedKey}`,
    ]);
    await act(async () => {
      runtime.reconcile([]);
    });
    expect(cards.snapshot()).toHaveLength(0);
    expect(agents.types()).toHaveLength(0);
    expect(
      screen.getByRole("button", { name: "Sign in with Builderlab" }),
    ).toBeEnabled();
    // The disabled plugin's sync owner withdraws its report with it.
    expect(knownCommunities.status).toHaveBeenLastCalledWith(undefined);
    mounted.unmount();
    runtime.reconcile([plugin]);
    await waitFor(() => expect(cards.snapshot()).toHaveLength(1));
    const fresh = cards.snapshot()[0];
    if (!fresh) throw new Error("Missing reactivated Builderlab login card");
    const FreshCard = fresh.component;
    render(<FreshCard active={() => true} />);
    expect(screen.getByRole("status")).toHaveTextContent("Sign in securely");
    // Creating while signed out starts the same browser login. A failed login
    // preserves the draft and sends no provisioning request; retry completes it.
    render(<AgentsPage agents={agents} relay={community.relay} />);
    await user.click(screen.getByRole("button", { name: "New agent" }));
    const createDialog = screen.getByRole("dialog", { name: "Create agent" });
    expect(within(createDialog).getByText("Builderlab")).toBeInTheDocument();
    expect(
      within(createDialog).getByText(/Its provider keeps its key and runs it/),
    ).toBeInTheDocument();
    const name = within(createDialog).getByRole("textbox", { name: "Name" });
    const create = within(createDialog).getByRole("button", {
      name: "Create agent",
    });
    await user.type(name, "Browser");
    const beforeCreateLogin = loginWaits().length;
    loginCallback = deferred();
    try {
      await user.click(create);
      await waitFor(() =>
        expect(loginWaits()).toHaveLength(beforeCreateLogin + 1),
      );
      expect(create).toBeDisabled();
      expect(name).toHaveValue("Browser");
      loginCallback.reject(new Error("Browser could not open."));
      expect(await within(createDialog).findByRole("alert")).toHaveTextContent(
        "Browser could not open.",
      );
      expect(create).toBeEnabled();
      expect(name).toHaveValue("Browser");
      expect(
        requestsTo("register-agent").filter(
          (input) => JSON.parse(input.request.body).agent_name === "Browser",
        ),
      ).toHaveLength(0);
    } finally {
      loginCallback.resolve({ parameters: [["code", "one-time"]] });
      loginCallback = undefined;
    }
    await user.click(create);
    await waitFor(() =>
      expect(agents.find(browserKey)).toMatchObject({
        name: "Browser",
        place: "hosted",
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Create agent" }),
      ).not.toBeInTheDocument(),
    );
    expect(agents.find(browserKey)?.unfinished).toBeUndefined();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
    expect(
      screen.getByRole("tab", { name: "Instructions" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Instructions" }));
    const instructions = await screen.findByRole("textbox", {
      name: "Instructions",
    });
    expect(instructions).toHaveValue("Be concise.");
    const save = screen.getByRole("button", { name: "Save instructions" });
    await user.clear(instructions);
    await user.type(instructions, "New direction.");
    instructionsSave = deferred();
    try {
      await user.click(save);
      await waitFor(() => expect(requestsTo("update-agent")).toHaveLength(1));
      expect(save).toHaveAttribute("aria-disabled", "true");
      expect(instructions).toBeDisabled();
      instructionsSave.reject(new Error("offline"));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Could not reach Builderlab",
      );
      expect(instructions).toHaveValue("New direction.");
      expect(save).not.toHaveAttribute("aria-disabled", "true");
    } finally {
      instructionsSave.resolve({
        status: 200,
        headers: {},
        body: '{"status":1}',
      });
      instructionsSave = undefined;
    }
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await user.click(save);
    await waitFor(() => expect(instructions).toBeEnabled());
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(browserInstructions).toBe("New direction.");
    await user.clear(instructions);
    await user.click(save);
    await waitFor(() => expect(instructions).toBeEnabled());
    expect(browserInstructions).toBe("");

    // Confirmed deletion waits for login before provider or community removal.
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await user.click(screen.getByRole("button", { name: "Delete agent" }));
    const deletion = screen.getByRole("dialog", { name: "Delete Browser?" });
    const remove = within(deletion).getByRole("button", { name: "Delete" });
    const beforeDelete = requestsTo("delete-agent").length;
    const beforeDeleteLogin = loginWaits().length;
    loginCallback = deferred();
    try {
      await user.click(remove);
      await waitFor(() =>
        expect(loginWaits()).toHaveLength(beforeDeleteLogin + 1),
      );
      expect(remove).toHaveAttribute("aria-disabled", "true");
      expect(requestsTo("delete-agent")).toHaveLength(beforeDelete);
      expect(agents.find(browserKey)).toBeDefined();
    } finally {
      await act(async () => {
        loginCallback?.resolve({ parameters: [["code", "one-time"]] });
        await loginCallback?.promise;
      });
      loginCallback = undefined;
    }
    await waitFor(() => expect(agents.find(browserKey)).toBeUndefined());
    expect(requestsTo("delete-agent")).toHaveLength(beforeDelete + 1);
  } finally {
    cleanup();
    await runtime.dispose();
    await root.fiber.dispose();
    await community.dispose();
  }
});
