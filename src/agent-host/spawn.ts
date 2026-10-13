// The desktop app's process host (host_process.rs), for Node: starts only the
// processes a type's manifest declares, with their declared arguments first,
// without any Buzz identity in their environment, each in its own process
// group so stopping one stops what it started.
import { spawn as start } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Host, HostProcess } from "../features/host/service";

export type Declared = Readonly<{
  id: string;
  program: string;
  args?: readonly string[];
}>;

const STOP_GRACE_MS = 3_000;

/** PATH with per-user installs first and Homebrew's last, as the app has it. */
export function effectivePath(path = process.env.PATH ?? "") {
  const directories = [
    join(homedir(), ".local/bin"),
    ...(path || "/usr/bin:/bin").split(delimiter).filter(Boolean),
  ];
  if (process.platform === "darwin")
    directories.push("/opt/homebrew/bin", "/usr/local/bin");
  return directories.join(delimiter);
}

function directory(cwd: string) {
  if (cwd === "~") return homedir();
  if (cwd.startsWith("~/")) return join(homedir(), cwd.slice(2));
  if (!cwd.startsWith("/")) throw new Error("Invalid process directory");
  return cwd;
}

/** Starts declared processes; `stopAll` stops every one still running. */
export function processHost(declared: readonly Declared[]) {
  const live = new Set<() => void>();
  const spawn: NonNullable<Host["spawn"]> = async (id, options = {}) => {
    const entry = declared.find((item) => item.id === id);
    if (!entry) throw new Error("Process is not declared");
    const args = options.args ?? [];
    if (args.length > 256 || args.some((arg) => arg.includes("\0")))
      throw new Error("Invalid process arguments");
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env))
      if (
        value !== undefined &&
        !name.startsWith("BUZZ_") &&
        !name.startsWith("NOSTR_")
      )
        env[name] = value;
    env.PATH = effectivePath();
    for (const [name, value] of Object.entries(options.env ?? {})) {
      if (!name || /[=\0]/.test(name))
        throw new Error("Invalid environment variable");
      if (value === null) delete env[name];
      else env[name] = value;
    }
    const cwd = options.cwd ? directory(options.cwd) : undefined;
    if (cwd) mkdirSync(cwd, { recursive: true });
    const child = start(entry.program, [...(entry.args ?? []), ...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const started = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => options.onStdout?.(data));
    child.stderr.on("data", (data: string) => options.onStderr?.(data));
    child.stdin.on("error", () => {});
    const signal = (name: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, name);
      } catch {}
    };
    const exited = new Promise<number | null>((resolve) =>
      child.once("close", (code) => resolve(code)),
    );
    let stopping: Promise<void> | undefined;
    const kill = () => {
      stopping ??= (async () => {
        signal("SIGTERM");
        const timer = setTimeout(() => signal("SIGKILL"), STOP_GRACE_MS);
        await exited;
        clearTimeout(timer);
      })();
      return stopping;
    };
    const stop = () => void kill();
    live.add(stop);
    void exited.then(() => live.delete(stop));
    await started;
    const write = (data: string) =>
      new Promise<void>((resolve, reject) =>
        child.stdin.write(data, (error) => (error ? reject(error) : resolve())),
      );
    const handle: HostProcess = Object.freeze({
      write,
      end: async (data?: string) => {
        if (data) await write(data);
        child.stdin.end();
      },
      kill,
      exited,
    });
    return handle;
  };
  return {
    spawn,
    stopAll: () => {
      for (const stop of live) stop();
    },
  };
}
