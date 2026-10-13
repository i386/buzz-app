// The claim that lets one copy on this machine run each agent, made the way a
// dev build of the desktop app makes it (`Hosting::claim` in app_agents.rs):
// while the installed app holds `<pubkey>.packaged` this host lets the agent
// go; otherwise it runs the agent only while it holds `<pubkey>.lock`. Both are
// flock(2) locks in the app's `hosts` directory, so the OS lets go of them when
// a holder exits, however it exits.
//
// Node has no flock call, but macOS open(2) takes the same lock when it is
// given O_EXLOCK or O_SHLOCK, and Node passes those flags through. The lock is
// this process's own, held while its file stays open.
import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

/** macOS <fcntl.h>; Node does not name them. */
const O_SHLOCK = 0x10;
const O_EXLOCK = 0x20;

/** Takes the flock at `path` without waiting: the open file that holds it, or
 * undefined when another holder has it. */
export function hold(
  path: string,
  mode: "shared" | "exclusive",
): number | undefined {
  if (process.platform !== "darwin")
    throw new Error("The agent host can check who runs an agent only on macOS");
  try {
    return openSync(
      path,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_NONBLOCK |
        (mode === "shared" ? O_SHLOCK : O_EXLOCK),
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EAGAIN") return undefined;
    throw error;
  }
}

/** One host's claims, kept for as long as it runs. */
export class Claims {
  private readonly held = new Map<string, number>();
  constructor(private readonly dir: string) {}

  /** Whether this host runs the agent now; asked on every wake, so it takes
   * the agent over within a tick of the holder quitting or letting go. */
  async claim(pubkey: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error("Invalid agent");
    mkdirSync(this.dir, { recursive: true });
    const packaged = hold(join(this.dir, `${pubkey}.packaged`), "shared");
    if (packaged === undefined) {
      await this.release(pubkey);
      return false;
    }
    closeSync(packaged);
    if (!this.held.has(pubkey)) {
      const lock = hold(join(this.dir, `${pubkey}.lock`), "exclusive");
      if (lock !== undefined) this.held.set(pubkey, lock);
    }
    return this.held.has(pubkey);
  }
  async release(pubkey: string): Promise<void> {
    const lock = this.held.get(pubkey);
    if (lock !== undefined) closeSync(lock);
    this.held.delete(pubkey);
  }
  dispose() {
    for (const lock of this.held.values()) closeSync(lock);
    this.held.clear();
  }
}
