import { Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostService, type Host } from "./service";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(),
  invoke: vi.fn(),
  Channel: class {
    constructor(public onmessage: (event: unknown) => void) {}
  },
}));

beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockReset();
  vi.stubGlobal("navigator", { platform: "MacIntel" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function pluginContext() {
  const root = new Context();
  new HostService(root);
  return {
    root,
    plugin: root.extend({
      pluginOwner: { id: "example.plugin", revision: "abc" },
    }),
  };
}

it("prepares a structured NIP-OA proof with the native identity without a community", async () => {
  const identity = "ab".repeat(32);
  const agentPubkey = "cd".repeat(32);
  const authorization = ["auth", identity, "", "ef".repeat(64)];
  const { plugin } = pluginContext();
  vi.mocked(invoke)
    .mockResolvedValueOnce(identity)
    .mockResolvedValueOnce(authorization);
  expect(
    await plugin.host.prepareRemoteAgentAuthorization?.(agentPubkey),
  ).toEqual(authorization);
  expect(invoke).toHaveBeenNthCalledWith(1, "identity_restore");
  expect(invoke).toHaveBeenNthCalledWith(
    2,
    "identity_prepare_remote_agent_authorization",
    { owner: identity, agentPubkey },
  );
});

it.each([
  { mode: "browser", tauri: false, live: undefined },
  { mode: "live desktop", tauri: true, live: "1" },
])(
  "uses the dev broker identity for $mode authorization without a selected relay",
  async ({ tauri, live }) => {
    const identity = "ab".repeat(32);
    const agentPubkey = "cd".repeat(32);
    const authorization = ["auth", identity, "", "ef".repeat(64)];
    vi.mocked(isTauri).mockReturnValue(tauri);
    vi.stubEnv("VITE_BUZZ_LIVE", live);
    const fetcher = vi.fn(async (_url: string, _input?: RequestInit) =>
      Response.json({ viewer: identity }),
    );
    fetcher
      .mockResolvedValueOnce(Response.json({ viewer: identity }))
      .mockResolvedValueOnce(Response.json(authorization));
    vi.stubGlobal("fetch", fetcher);
    const { plugin } = pluginContext();
    expect(
      await plugin.host.prepareRemoteAgentAuthorization?.(agentPubkey),
    ).toEqual(authorization);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/relay/identity");
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "/api/relay/prepare-remote-agent-authorization",
    );
    const input = fetcher.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(input.body))).toEqual({
      owner: identity,
      agentPubkey,
    });
    expect(invoke).not.toHaveBeenCalled();
  },
);

it("does not sign invalid, self, missing-identity or pre-canceled requests", async () => {
  const identity = "ab".repeat(32);
  const agentPubkey = "cd".repeat(32);
  const { plugin } = pluginContext();
  await expect(
    plugin.host.prepareRemoteAgentAuthorization?.("invalid"),
  ).rejects.toThrow("64 lowercase hex");
  expect(invoke).not.toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValueOnce(identity);
  await expect(
    plugin.host.prepareRemoteAgentAuthorization?.(identity),
  ).rejects.toThrow("must differ");
  vi.mocked(invoke).mockResolvedValueOnce(null);
  await expect(
    plugin.host.prepareRemoteAgentAuthorization?.(agentPubkey),
  ).rejects.toThrow("Set up your identity");
  const cancel = new AbortController();
  cancel.abort();
  await expect(
    plugin.host.prepareRemoteAgentAuthorization?.(agentPubkey, cancel.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(invoke).toHaveBeenCalledTimes(2);
});

it.each(["identity_restore", "identity_prepare_remote_agent_authorization"])(
  "fences cancellation during %s",
  async (command) => {
    const identity = "ab".repeat(32);
    const agentPubkey = "cd".repeat(32);
    const authorization = ["auth", identity, "", "ef".repeat(64)];
    let release!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation((name) =>
      name === command
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(identity),
    );
    const { plugin } = pluginContext();
    const cancel = new AbortController();
    const pending = plugin.host.prepareRemoteAgentAuthorization?.(
      agentPubkey,
      cancel.signal,
    );
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      cancel.abort();
    } finally {
      release?.(command === "identity_restore" ? identity : authorization);
    }
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).toHaveBeenCalledTimes(
      command === "identity_restore" ? 1 : 2,
    );
  },
);

it.each(["different owner", "nonempty conditions", "malformed signature"])(
  "rejects an invalid authorization: %s",
  async (scenario) => {
    const identity = "ab".repeat(32);
    const agentPubkey = "cd".repeat(32);
    const authorization = [
      "auth",
      scenario === "different owner" ? agentPubkey : identity,
      scenario === "nonempty conditions" ? "kind=0" : "",
      scenario === "malformed signature" ? "invalid" : "ef".repeat(64),
    ];
    const { plugin } = pluginContext();
    vi.mocked(invoke)
      .mockResolvedValueOnce(identity)
      .mockResolvedValueOnce(authorization);
    await expect(
      plugin.host.prepareRemoteAgentAuthorization?.(agentPubkey),
    ).rejects.toThrow("Invalid remote agent authorization");
  },
);

it("uses the calling plugin identity and preserves bounded command output", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValue("ready \n");
  await expect(plugin.host.runCommand("status")).resolves.toBe("ready \n");
  expect(invoke).toHaveBeenCalledWith("plugin_host_run_command", {
    id: "example.plugin",
    revision: "abc",
    commandId: "status",
  });
});

it("keeps native command failures and browser calls nullable", async () => {
  const { root, plugin } = pluginContext();
  vi.mocked(invoke).mockRejectedValue(new Error("secret stderr"));
  await expect(plugin.host.runCommand("status")).resolves.toBeNull();
  await expect(root.host.runCommand("status")).resolves.toBeNull();
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(plugin.host.runCommand("status")).resolves.toBeNull();
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("passes review decisions as stdin data while keeping the command fixed", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValue('{"accepted":true}');
  const input =
    '{"id":"action-a","choice":"allow_once","text":"$(touch injected)"}';
  await plugin.host.runCommand("review", input);
  expect(invoke).toHaveBeenCalledWith("plugin_host_run_command", {
    id: "example.plugin",
    revision: "abc",
    commandId: "review",
    input,
  });
});

it("routes HTTPS requests with plugin identity and rejects browser requests", async () => {
  const { plugin } = pluginContext();
  const response = {
    status: 200,
    headers: { "content-type": "application/json" },
    body: "{}",
  };
  vi.mocked(invoke).mockResolvedValue(response);
  const request = {
    url: "https://api.example.com/graphql",
    method: "POST" as const,
    headers: { Authorization: "Bearer token" },
    body: "{}",
  };
  await expect(plugin.host.request(request)).resolves.toEqual(response);
  expect(invoke).toHaveBeenCalledWith("plugin_host_request", {
    id: "example.plugin",
    revision: "abc",
    request,
  });
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(plugin.host.request(request)).rejects.toThrow(/desktop plugin/);
});

it("starts a declared process as the calling plugin and streams it", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce(7);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const process = await plugin.host.spawn?.("agent", {
    args: ["--print"],
    cwd: "~/.buzz",
    env: { CLAUDECODE: null },
    onStdout: (data) => stdout.push(data),
    onStderr: (data) => stderr.push(data),
  });
  const [, spawn] = vi.mocked(invoke).mock.calls[0] as [
    string,
    { onEvent: { onmessage(event: unknown): void } },
  ];
  expect(invoke).toHaveBeenCalledWith("plugin_host_process_spawn", {
    id: "example.plugin",
    revision: "abc",
    processId: "agent",
    args: ["--print"],
    cwd: "~/.buzz",
    env: { CLAUDECODE: null },
    onEvent: spawn.onEvent,
  });
  spawn.onEvent.onmessage({ type: "stdout", data: "out" });
  spawn.onEvent.onmessage({ type: "stderr", data: "err" });
  expect(stdout).toEqual(["out"]);
  expect(stderr).toEqual(["err"]);

  vi.mocked(invoke).mockResolvedValue(undefined);
  await process?.write("line\n");
  await process?.end();
  expect(invoke).toHaveBeenCalledWith("plugin_host_process_write", {
    id: "example.plugin",
    handle: 7,
    data: "line\n",
    close: false,
  });
  expect(invoke).toHaveBeenCalledWith("plugin_host_process_write", {
    id: "example.plugin",
    handle: 7,
    data: "",
    close: true,
  });
  spawn.onEvent.onmessage({ type: "exit", code: 0 });
  await expect(process?.exited).resolves.toBe(0);
});

it("writes a long input in order, in pieces the host accepts", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce(7);
  const process = await plugin.host.spawn?.("agent");
  const pieces: string[] = [];
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    pieces.push((args as { data: string }).data);
  });
  // A pair straddles the first boundary.
  const long = `${"a".repeat(256 * 1024 - 1)}😀${"b".repeat(600 * 1024)}`;
  await Promise.all([process?.write(long), process?.write("next\n")]);
  expect(pieces).toHaveLength(5);
  expect(pieces.every((piece) => new Blob([piece]).size <= 1024 * 1024)).toBe(
    true,
  );
  expect(pieces[0]?.endsWith("a")).toBe(true);
  expect(pieces.join("")).toBe(`${long}next\n`);
});

it("keeps delivering process events after an output handler throws", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce(7);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const process = await plugin.host.spawn?.("agent", {
    onStdout: () => {
      throw new Error("handler bug");
    },
  });
  const [, spawn] = vi.mocked(invoke).mock.calls[0] as [
    string,
    { onEvent: { onmessage(event: unknown): void } },
  ];
  expect(() =>
    spawn.onEvent.onmessage({ type: "stdout", data: "out" }),
  ).not.toThrow();
  expect(error).toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValue(undefined);
  spawn.onEvent.onmessage({ type: "exit", code: 1 });
  await expect(process?.exited).resolves.toBe(1);
  error.mockRestore();
});

it("kills a plugin's processes when the plugin unloads", async () => {
  const root = new Context();
  new HostService(root);
  let host!: Host;
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "abc" } })
    .plugin({
      inject: ["host"],
      apply: (ctx: Context) => {
        host = ctx.host;
      },
    });
  await fiber;
  vi.mocked(invoke).mockResolvedValue(3);
  await host.spawn?.("agent");
  vi.mocked(invoke).mockClear();
  await fiber.dispose();
  expect(invoke).toHaveBeenCalledWith("plugin_host_process_kill", {
    id: "example.plugin",
    handle: 3,
  });
});

it("kills a process that started as its plugin unloaded", async () => {
  const root = new Context();
  new HostService(root);
  let host!: Host;
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "abc" } })
    .plugin({
      inject: ["host"],
      apply: (ctx: Context) => {
        host = ctx.host;
      },
    });
  await fiber;
  let started!: (handle: number) => void;
  vi.mocked(invoke).mockImplementation((command) =>
    command === "plugin_host_process_spawn"
      ? new Promise((resolve) => {
          started = resolve;
        })
      : Promise.resolve(undefined),
  );
  const spawning = host.spawn?.("agent");
  await fiber.dispose();
  started(4);
  await expect(spawning).rejects.toThrow();
  expect(invoke).toHaveBeenCalledWith("plugin_host_process_kill", {
    id: "example.plugin",
    handle: 4,
  });
});

it("refuses processes outside the desktop app", async () => {
  const { root, plugin } = pluginContext();
  await expect(root.host.spawn?.("agent")).rejects.toThrow(
    "installed desktop plugin",
  );
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(plugin.host.spawn?.("agent")).rejects.toThrow(
    "installed desktop plugin",
  );
  expect(invoke).not.toHaveBeenCalled();
});
