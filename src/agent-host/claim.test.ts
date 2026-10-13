// @vitest-environment node
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Claims, hold } from "./claim";

const agent = "ab".repeat(32);
let dir: string;
const claims: Claims[] = [];
const children: ChildProcess[] = [];
const make = () => {
  const made = new Claims(dir);
  claims.push(made);
  return made;
};

/** Another process that holds `path` with flock(2), as the app's
 * `File::try_lock` does, until it is killed. */
async function flockHolder(path: string, mode: "LOCK_EX" | "LOCK_SH") {
  const child = spawn(
    "python3",
    [
      "-c",
      `import fcntl,sys,time\nf=open(sys.argv[1],"a")\nfcntl.flock(f,fcntl.${mode})\nprint("held",flush=True)\ntime.sleep(60)`,
      path,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once("data", () => resolve());
    child.once("exit", () => reject(new Error("The holder did not start")));
  });
  return child;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-host-claim-"));
});
afterEach(() => {
  for (const made of claims.splice(0)) made.dispose();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "darwin")("on macOS", () => {
  it("lets one copy run the agent until it lets go", async () => {
    const first = make();
    const second = make();
    expect(await first.claim(agent)).toBe(true);
    expect(await first.claim(agent)).toBe(true);
    expect(await second.claim(agent)).toBe(false);
    await first.release(agent);
    expect(await second.claim(agent)).toBe(true);
  });

  it("lets the agent go while the installed app holds it", async () => {
    const host = make();
    expect(await host.claim(agent)).toBe(true);
    const packaged = hold(join(dir, `${agent}.packaged`), "exclusive");
    expect(packaged).toBeDefined();
    expect(await host.claim(agent)).toBe(false);
    // The lock is free again, so another copy can take over after the app.
    if (packaged !== undefined) closeSync(packaged);
    expect(await make().claim(agent)).toBe(true);
  });

  it("shares the app's flock(2) locks, and gets them back when a holder dies", async () => {
    const host = make();
    // The installed app holds the agent.
    const app = await flockHolder(join(dir, `${agent}.packaged`), "LOCK_EX");
    expect(await host.claim(agent)).toBe(false);
    app.kill("SIGKILL");
    await expect.poll(() => host.claim(agent)).toBe(true);
    await host.release(agent);
    // A dev build holds it.
    const dev = await flockHolder(join(dir, `${agent}.lock`), "LOCK_EX");
    expect(await host.claim(agent)).toBe(false);
    dev.kill("SIGKILL");
    await expect.poll(() => host.claim(agent)).toBe(true);
  });
});

it.skipIf(process.platform === "darwin")(
  "runs no agent where it cannot check",
  async () => {
    await expect(make().claim(agent)).rejects.toThrow(/only on macOS/);
  },
);
