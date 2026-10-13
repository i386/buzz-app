import { expect, it } from "vitest";
import type {
  HostProcess,
  HostProcessOptions,
} from "../../features/host/service";
import { fakeSpawn } from "./claude-testing";
import script from "./claude.sh?raw";
import { checkClaude, ClaudeSetup, MIN_VERSION, withScript } from "./setup";

/** A spawn whose processes print `output[args]` and exit with its code. */
function scripted(
  output: Record<string, { stdout?: string; code?: number } | Error>,
) {
  const calls: { id: string; args: readonly string[] }[] = [];
  const spawn = async (id: string, options: HostProcessOptions = {}) => {
    const args = options.args ?? [];
    calls.push({ id, args });
    const result = output[`${id} ${args.join(" ")}`.trim()];
    if (result instanceof Error) throw result;
    queueMicrotask(() => {
      if (result?.stdout) options.onStdout?.(result.stdout);
    });
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => undefined,
      exited: new Promise<number | null>((resolve) =>
        setTimeout(() => resolve(result?.code ?? 0), 0),
      ),
    };
  };
  return { spawn, calls };
}

it("finds Claude missing when Buzz has no copy", async () => {
  const { spawn } = scripted({ "claude --version": { code: 127 } });
  await expect(checkClaude(spawn)).resolves.toEqual({ state: "missing" });
  const setup = new ClaudeSetup(spawn);
  await setup.check();
  expect(setup.providerSnapshot()).toEqual({
    readiness: "attention",
    attentionLabel: "Install Claude Code",
  });
});

it("finds a copy older than Buzz needs outdated", async () => {
  const { spawn } = scripted({
    "claude --version": { stdout: "2.1.100 (Claude Code)\n" },
  });
  await expect(checkClaude(spawn)).resolves.toEqual({
    state: "outdated",
    version: "2.1.100",
  });
});

it("reports the version and whether it is signed in", async () => {
  const signedOut = scripted({
    "claude --version": { stdout: "2.1.200 (Claude Code)\n" },
    "claude auth status --json": { stdout: '{"loggedIn":false}', code: 1 },
  });
  await expect(checkClaude(signedOut.spawn)).resolves.toEqual({
    state: "signed-out",
    version: "2.1.200",
  });
  const ready = scripted({
    "claude --version": { stdout: "2.1.200 (Claude Code)\n" },
    "claude auth status --json": {
      stdout: '{"loggedIn":true,"email":"a@example.com","orgName":"Example"}',
    },
  });
  await expect(checkClaude(ready.spawn)).resolves.toEqual({
    state: "ready",
    version: "2.1.200",
    account: "a@example.com · Example",
  });
  const setup = new ClaudeSetup(ready.spawn);
  await setup.check();
  const refreshing = setup.check();
  expect(setup.providerSnapshot()).toEqual({ readiness: "ready" });
  await refreshing;
});

it("runs sign-in, shows its output, and checks again after", async () => {
  const { spawn, calls } = scripted({
    "claude auth login": { stdout: "Opening browser…\n" },
    "claude --version": { stdout: "2.1.200\n" },
    "claude auth status --json": { stdout: '{"loggedIn":true}' },
  });
  const setup = new ClaudeSetup(spawn);
  const run = setup.run("login");
  expect(setup.snapshot().running).toBe("login");
  await run;
  expect(setup.snapshot()).toMatchObject({
    running: undefined,
    output: "Opening browser…\n",
    status: { state: "ready", version: "2.1.200" },
  });
  expect(calls.map((call) => call.args.join(" "))).toEqual([
    "auth login",
    "--version",
    "auth status --json",
  ]);
});

it("stops a step cancelled before its process was returned", async () => {
  const { spawn: check } = scripted({});
  let resolveSpawn!: (process: HostProcess) => void;
  let resolveExit!: (code: number | null) => void;
  const process: HostProcess & { killed?: boolean } = {
    write: async () => undefined,
    end: async () => undefined,
    kill: async () => {
      process.killed = true;
      resolveExit(null);
    },
    exited: new Promise((resolve) => {
      resolveExit = resolve;
    }),
  };
  const setup = new ClaudeSetup((id, options) =>
    id === "claude" && options?.args?.[0] === "auth"
      ? new Promise((resolve) => {
          resolveSpawn = resolve;
        })
      : check(id, options),
  );
  const run = setup.run("login");
  expect(setup.snapshot().running).toBe("login");
  await setup.cancel();
  resolveSpawn(process);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(process.killed).toBe(true);
  await run;
  expect(setup.snapshot()).toMatchObject({
    running: undefined,
    output: "\nSign-in ended (stopped).",
  });
});

it("explains that it needs the desktop app", async () => {
  const setup = new ClaudeSetup(undefined);
  await setup.check();
  expect(setup.snapshot().status).toEqual({
    state: "error",
    message: "Claude agents run only in the desktop app",
  });
  expect(setup.providerSnapshot()).toEqual({
    readiness: "attention",
    attentionLabel: "Claude Code needs attention",
  });
});

const CHECKSUM = "a".repeat(64);

/** Buzz's copy on a fake disk, and downloads.claude.ai offering `latest`. */
function releases(
  latest: string,
  { current, broken }: { current?: string; broken?: string } = {},
) {
  const state = {
    current,
    offline: false,
    fetched: [] as string[],
    used: [] as string[],
  };
  const claude = fakeSpawn();
  const spawn = async (id: string, options: HostProcessOptions = {}) => {
    const args = options.args ?? [];
    if (id === "claude" && args.includes("stream-json"))
      return claude.spawn(id, options);
    const version = options.env?.BUZZ_CLAUDE_VERSION ?? state.current;
    let result: { stdout?: string; stderr?: string; code: number } = {
      code: 0,
    };
    if (id === "platform") result = { stdout: "Darwin arm64\n", code: 0 };
    else if (id === "install") {
      state.fetched.push(args.join(" "));
      if (state.offline) result = { code: 1 };
    } else if (id === "use") state.current = args[0];
    else if (args[0] === "--version")
      result = !version
        ? { code: 127 }
        : version === broken
          ? { stderr: "Killed: 9", code: 137 }
          : { stdout: `${version} (Claude Code)\n`, code: 0 };
    else if (args[0] === "auth")
      result = { stdout: '{"loggedIn":true}', code: 0 };
    if (id === "use") state.used.push(args.join(" "));
    queueMicrotask(() => {
      if (result.stdout) options.onStdout?.(result.stdout);
      if (result.stderr) options.onStderr?.(result.stderr);
    });
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => undefined,
      exited: new Promise<number | null>((resolve) =>
        setTimeout(() => resolve(result.code), 0),
      ),
    };
  };
  const requests: string[] = [];
  const request = async ({ url }: { url: string }) => {
    requests.push(url);
    const path = url.replace(
      "https://downloads.claude.ai/claude-code-releases/",
      "",
    );
    const body =
      path === "latest"
        ? `${latest}\n`
        : path === `${latest}/manifest.json`
          ? JSON.stringify({
              platforms: { "darwin-arm64": { checksum: CHECKSUM } },
            })
          : undefined;
    return { status: body ? 200 : 404, headers: {}, body: body ?? "" };
  };
  return { spawn, request, requests, state, claude };
}

it("installs the latest release once it passes its test", async () => {
  const { spawn, request, state, claude } = releases("2.1.300");
  const setup = new ClaudeSetup(spawn, request);
  await setup.run("install");
  expect(state.fetched).toEqual([`2.1.300 darwin-arm64 ${CHECKSUM}`]);
  // The test ran the new release, not the copy in use.
  expect(claude.processes[0]?.options.env?.BUZZ_CLAUDE_VERSION).toBe("2.1.300");
  expect(claude.processes[0]?.killed).toBe(true);
  expect(state.used).toEqual(["2.1.300"]);
  expect(setup.snapshot()).toMatchObject({
    running: undefined,
    notice: undefined,
    status: { state: "ready", version: "2.1.300" },
  });
});

it("keeps the copy in use when a new release fails its test", async () => {
  const { spawn, request, state } = releases("2.1.300", {
    current: "2.1.200",
    broken: "2.1.300",
  });
  const setup = new ClaudeSetup(spawn, request);
  await setup.update(false);
  expect(state.fetched).toHaveLength(1);
  expect(state.used).toEqual([]);
  expect(setup.snapshot()).toMatchObject({
    notice:
      "Claude 2.1.300 failed its test: Killed: 9. Buzz keeps using 2.1.200.",
    status: { state: "ready", version: "2.1.200" },
  });
  // A refused release is not downloaded again, unless the person asks.
  await setup.update(false);
  expect(state.fetched).toHaveLength(1);
  await setup.run("install");
  expect(state.fetched).toHaveLength(2);
});

it("does nothing when the copy is already the latest", async () => {
  const { spawn, request, state } = releases("2.1.300", { current: "2.1.300" });
  await new ClaudeSetup(spawn, request).update(true);
  expect(state.fetched).toEqual([]);
});

it("refuses a release older than Buzz needs", async () => {
  const { spawn, request, state } = releases("2.1.100");
  const setup = new ClaudeSetup(spawn, request);
  await setup.run("install");
  expect(state.fetched).toEqual([]);
  expect(setup.snapshot().output).toContain(
    `Claude 2.1.100 is older than Buzz needs (${MIN_VERSION}).`,
  );
});

it("waits for a Claude agent before the first download", async () => {
  const { spawn, request, requests } = releases("2.1.300");
  const setup = new ClaudeSetup(spawn, request);
  await setup.update(false);
  expect(requests).toEqual([]);
  await setup.update(true);
  expect(requests).toHaveLength(2);
});

it("starts Claude and its install steps as steps of claude.sh", async () => {
  const { spawn, calls } = scripted({});
  const run = withScript(spawn);
  await run("claude", { args: ["--version"] });
  await run("use", { args: ["2.1.300"] });
  await run("platform");
  expect(calls).toEqual([
    { id: "claude-sh", args: [script, "claude.sh", "run", "--version"] },
    { id: "claude-sh", args: [script, "claude.sh", "use", "2.1.300"] },
    { id: "platform", args: [] },
  ]);
});

/** `releases` whose first `id` process waits until `release` is called. */
function held(disk: ReturnType<typeof releases>, id: string) {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let first = true;
  const spawn = async (name: string, options?: HostProcessOptions) => {
    if (name === id && first) {
      first = false;
      started();
      await gate;
    }
    return disk.spawn(name, options);
  };
  return { spawn, waiting, release };
}

it("holds a delivery while it downloads the first copy", async () => {
  const disk = releases("2.1.300");
  const { spawn, waiting, release } = held(disk, "install");
  const setup = new ClaudeSetup(spawn, disk.request);
  const update = setup.update(true);
  await waiting;
  let delivered = false;
  const delivery = setup.installed(new AbortController().signal).then(() => {
    delivered = true;
  });
  // Settles only once the held download does, which nothing has released.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(delivered).toBe(false);
  release();
  await Promise.all([update, delivery]);
  expect(disk.state.used).toEqual(["2.1.300"]);
  expect(setup.snapshot().status).toMatchObject({ version: "2.1.300" });
});

it("stops holding a delivery when its deadline passes", async () => {
  const disk = releases("2.1.300");
  const { spawn, waiting, release } = held(disk, "install");
  const setup = new ClaudeSetup(spawn, disk.request);
  const update = setup.update(true);
  await waiting;
  const deadline = new AbortController();
  const delivery = setup.installed(deadline.signal);
  deadline.abort(new Error("timed out"));
  await expect(delivery).rejects.toThrow("timed out");
  release();
  await update;
});

it("does not hold deliveries while it updates a copy in use", async () => {
  const disk = releases("2.1.300", { current: "2.1.200" });
  const { spawn, waiting, release } = held(disk, "install");
  const setup = new ClaudeSetup(spawn, disk.request);
  const update = setup.update(false);
  await waiting;
  await setup.installed(new AbortController().signal);
  release();
  await update;
});

it("holds a delivery that arrives while it first looks for its copy", async () => {
  const disk = releases("2.1.300");
  const { spawn, waiting, release } = held(disk, "claude");
  const setup = new ClaudeSetup(spawn, disk.request);
  const update = setup.update(true);
  await waiting;
  let used: string[] | undefined;
  const delivery = setup.installed(new AbortController().signal).then(() => {
    used = [...disk.state.used];
  });
  release();
  await Promise.all([update, delivery]);
  // Released only once the first copy was in use.
  expect(used).toEqual(["2.1.300"]);
});

it("tries the first download again when a mention finds no copy", async () => {
  const disk = releases("2.1.300");
  const setup = new ClaudeSetup(disk.spawn, disk.request);
  disk.state.offline = true;
  await setup.update(true);
  expect(setup.snapshot().status).toEqual({ state: "missing" });
  disk.state.offline = false;
  await setup.installed(new AbortController().signal);
  expect(disk.state.fetched).toHaveLength(2);
  expect(disk.state.used).toEqual(["2.1.300"]);
});
