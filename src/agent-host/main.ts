// buzz-agent-host: runs one of this machine's Buzz agents without the desktop app.
//
//   buzz-agent-host run <pubkey>
//
// The agent is one the app saved here, and it runs with the settings, teams
// and sessions the app saved for it. Its key comes from BUZZ_AGENT_KEY or the
// app's Keychain item; BUZZ_AGENTS_DIR overrides where the app keeps its
// agents. While the installed app runs the agent, this host waits. It runs
// agents only on macOS, where it can take the app's hosting locks.
import { host } from "./host";
import { agentsDir, readIdentity, readKey } from "./identity";

const usage = "Usage: buzz-agent-host run <pubkey>";
const log = (message: string) =>
  console.error(`${new Date().toISOString()} ${message}`);

function main(args: readonly string[]) {
  const [command, pubkey, ...rest] = args;
  if (
    command !== "run" ||
    !pubkey ||
    !/^[0-9a-f]{64}$/.test(pubkey) ||
    rest.length
  ) {
    console.error(usage);
    process.exit(2);
  }
  const dir = agentsDir();
  const identity = readIdentity(dir, pubkey);
  const secret = readKey(identity);
  const stop = host({
    identity,
    secret,
    dir,
    log,
    onGone: (reason) => {
      log(`${reason}; stopped`);
      process.exit(0);
    },
  });
  let stopping = false;
  const quit = () => {
    if (stopping) process.exit(1);
    stopping = true;
    log("Stopping");
    void stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
