// Claude on this computer: whether it is installed and signed in, and the
// installer and sign-in, each run as a declared process.
import type { HostProcess } from "../../features/host/service";
import type { AgentProviderSnapshot } from "../../features/agents/service";
import { ClaudeProcess, ENV, type ClaudeModel, type Spawn } from "./claude";

export type ClaudeStatus =
  | Readonly<{ state: "missing" }>
  | Readonly<{ state: "signed-out"; version: string }>
  | Readonly<{ state: "ready"; version: string; account?: string }>
  | Readonly<{ state: "error"; message: string }>;

const CHECK_TIMEOUT_MS = 15_000;

async function queryModels(spawn: Spawn) {
  const process = await ClaudeProcess.spawn(spawn, { cwd: "~/.buzz" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Claude Code model discovery timed out")),
        CHECK_TIMEOUT_MS,
      );
    });
    return await Promise.race([
      process.initialize({ systemPrompt: "" }).then(() => process.models()),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    await process.kill().catch(() => undefined);
  }
}

/** Runs a short process and returns its exit code and output. */
async function collect(spawn: Spawn, id: string, args: readonly string[]) {
  let stdout = "";
  let stderr = "";
  const process = await spawn(id, {
    args,
    env: ENV,
    onStdout: (data) => {
      stdout += data;
    },
    onStderr: (data) => {
      stderr += data;
    },
  });
  const timer = setTimeout(() => void process.kill(), CHECK_TIMEOUT_MS);
  const code = await process.exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
}

export async function checkClaude(spawn: Spawn): Promise<ClaudeStatus> {
  let version: string;
  try {
    const result = await collect(spawn, "claude", ["--version"]);
    if (result.code !== 0)
      return {
        state: "error",
        message: result.stderr.trim() || "Claude did not start",
      };
    version = result.stdout.trim().split(/\s/)[0] ?? "";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Native reports a program it cannot find as a failure to start it.
    return /could not start/i.test(message)
      ? { state: "missing" }
      : { state: "error", message };
  }
  try {
    const { stdout } = await collect(spawn, "claude", [
      "auth",
      "status",
      "--json",
    ]);
    const status = JSON.parse(stdout) as {
      loggedIn?: boolean;
      email?: string;
      orgName?: string;
    };
    if (!status.loggedIn) return { state: "signed-out", version };
    const account = [status.email, status.orgName].filter(Boolean).join(" · ");
    return { state: "ready", version, ...(account ? { account } : {}) };
  } catch {
    return { state: "signed-out", version };
  }
}

/** A setup step whose output is shown as it runs. */
export async function runStep(
  spawn: Spawn,
  step: "install" | "login",
  onOutput: (text: string) => void,
): Promise<HostProcess> {
  return spawn(step === "install" ? "install" : "claude", {
    ...(step === "login" ? { args: ["auth", "login"] } : {}),
    env: ENV,
    onStdout: onOutput,
    onStderr: onOutput,
  });
}

export type SetupState = Readonly<{
  status: ClaudeStatus | undefined;
  models: readonly ClaudeModel[];
  checking: boolean;
  running: "install" | "login" | undefined;
  /** The running or last step's output. */
  output: string;
}>;
const OUTPUT_LIMIT = 20_000;

/** The plugin's one view of Claude on this computer. */
export class ClaudeSetup {
  private state: SetupState = {
    status: undefined,
    models: [],
    checking: false,
    running: undefined,
    output: "",
  };
  private readonly listeners = new Set<() => void>();
  private health: AgentProviderSnapshot = { readiness: "checking" };
  private process: HostProcess | undefined;
  private loadingModels = false;
  /** Cancel was asked for before the running step's process was returned. */
  private cancelled = false;

  constructor(private readonly spawn: Spawn | undefined) {}

  snapshot = () => this.state;
  providerSnapshot = () => this.health;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(change: Partial<SetupState>) {
    this.state = { ...this.state, ...change };
    const status = this.state.status;
    const blocking = this.state.running ? { blocking: true as const } : {};
    this.health = Object.freeze(
      !status
        ? { readiness: "checking", ...blocking }
        : status.state === "ready"
          ? { readiness: "ready", ...blocking }
          : {
              readiness: "attention",
              ...blocking,
              attentionLabel:
                status.state === "missing"
                  ? "Install Claude Code"
                  : status.state === "signed-out"
                    ? "Log in to Claude Code"
                    : "Claude Code needs attention",
            },
    );
    for (const listener of this.listeners) listener();
  }

  async check() {
    if (!this.spawn) {
      this.set({
        status: {
          state: "error",
          message: "Claude agents run only in the desktop app",
        },
      });
      return;
    }
    if (this.state.checking || this.state.running) return;
    this.set({ checking: true });
    const status = await checkClaude(this.spawn);
    this.set({
      status,
      ...(status.state === "ready" ? {} : { models: [] }),
      checking: false,
    });
  }

  /** Loads optional model copy only for surfaces that display the catalog. */
  async loadModels() {
    if (
      !this.spawn ||
      this.state.status?.state !== "ready" ||
      this.loadingModels
    )
      return;
    this.loadingModels = true;
    try {
      this.set({ models: await queryModels(this.spawn) });
    } catch {
      // Model metadata is optional; setup remains usable when discovery fails.
    } finally {
      this.loadingModels = false;
    }
  }

  /** Runs the installer or sign-in, then checks again. */
  async run(step: "install" | "login") {
    if (!this.spawn || this.state.running) return;
    this.cancelled = false;
    this.set({ running: step, output: "" });
    try {
      this.process = await runStep(this.spawn, step, (text) =>
        this.set({ output: (this.state.output + text).slice(-OUTPUT_LIMIT) }),
      );
      if (this.cancelled) void this.process.kill();
      const code = await this.process.exited;
      if (code !== 0)
        this.set({
          output: `${this.state.output}\n${step === "install" ? "Install" : "Sign-in"} ended (${code ?? "stopped"}).`,
        });
    } catch (error) {
      this.set({
        output: `${this.state.output}\n${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      this.process = undefined;
      this.set({ running: undefined });
    }
    await this.check();
  }

  /** Sends a line to the running step, such as a sign-in code. */
  answer(text: string) {
    return this.process?.write(`${text}\n`);
  }
  cancel() {
    this.cancelled = true;
    return this.process?.kill();
  }
  dispose() {
    void this.cancel();
  }
}
