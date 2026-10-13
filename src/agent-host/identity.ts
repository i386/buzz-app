// The agent as the desktop app saved it on this machine: its identity from
// the app's `identities.json`, and its key from the environment or the app's
// Keychain item.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";

/** The app's identifier: installed and dev builds share it, and its data. */
const APP = "dev.local.buzz.foundation";
/** The app's Keychain item that holds every agent's key (agent-controller). */
const KEYCHAIN_SERVICE = `${APP}.agents`;
const KEYCHAIN_ACCOUNT = "agent-bundle-v1";

export type Identity = Readonly<{
  pubkey: string;
  name: string;
  /** The agent type's key, `pluginId/typeId`. */
  type: string;
  owner: string;
  relay: string;
  /** The owner's NIP-OA `auth` tag, as JSON. */
  auth?: string;
}>;

/** Where the app keeps its agents: `identities.json` and the `hosts` locks. */
export function agentsDir(env = process.env) {
  if (env.BUZZ_AGENTS_DIR) return env.BUZZ_AGENTS_DIR;
  const data =
    process.platform === "darwin"
      ? join(homedir(), "Library/Application Support")
      : (env.XDG_DATA_HOME ?? join(homedir(), ".local/share"));
  return join(data, APP, "agents");
}

type Saved = Record<string, unknown>;

/** The agents saved on this machine that are not deleted. */
function readList(dir: string): Saved[] {
  const saved = JSON.parse(
    readFileSync(join(dir, "identities.json"), "utf8"),
  ) as unknown;
  return (Array.isArray(saved) ? saved : []).filter(
    (item): item is Saved =>
      !!item && typeof item === "object" && item.deleted !== true,
  );
}

/** The name of each agent saved on this machine, for team prompts. */
export function readNames(dir: string): { pubkey: string; name: string }[] {
  return readList(dir).flatMap(({ pubkey, name }) =>
    typeof pubkey === "string" && typeof name === "string"
      ? [{ pubkey, name }]
      : [],
  );
}

export function readIdentity(dir: string, pubkey: string): Identity {
  const found = readList(dir).find((item) => item.pubkey === pubkey);
  if (!found) throw new Error(`No agent ${pubkey} is saved on this machine`);
  const text = (name: string) => {
    const value = found[name];
    if (typeof value !== "string" || !value)
      throw new Error(`The saved agent has no ${name}`);
    return value;
  };
  const auth = found.auth;
  return {
    pubkey,
    name: text("name"),
    type: text("type"),
    owner: text("owner"),
    relay: text("relay"),
    ...(typeof auth === "string" && auth ? { auth } : {}),
  };
}

/** Whether the agent is still saved here as `identity`: undefined while it is,
 * or why this host must stop running it. The app marks a deleted agent in
 * `identities.json`, and an erase that removes agents deletes the file. */
export function checkSaved(
  dir: string,
  identity: Identity,
): string | undefined {
  let now: Identity | undefined;
  try {
    now = readList(dir).some((item) => item.pubkey === identity.pubkey)
      ? readIdentity(dir, identity.pubkey)
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!now) return "The agent is no longer saved on this machine";
  for (const field of ["type", "owner", "relay", "auth"] as const)
    if (now[field] !== identity[field])
      return `The agent's ${field} changed on this machine`;
  return undefined;
}

/** The agent's secret key: `BUZZ_AGENT_KEY` (hex or nsec), or else the
 * app's Keychain item, which macOS may ask the user to allow. */
export function readKey(identity: Identity, env = process.env): Uint8Array {
  let text = env.BUZZ_AGENT_KEY?.trim();
  if (!text) {
    if (process.platform !== "darwin")
      throw new Error("Set BUZZ_AGENT_KEY to the agent's key");
    const bundle = execFileSync(
      "security",
      [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
        "-w",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        // macOS may ask the user to allow it; nobody may be there to answer.
        timeout: 60_000,
      },
    ).trim();
    const account = `agent:${identity.pubkey}-${createHash("sha256")
      .update(identity.relay)
      .digest("hex")}`;
    const value = (JSON.parse(bundle) as Record<string, unknown>)[account];
    if (typeof value !== "string")
      throw new Error("The app's Keychain has no key for this agent");
    text = value;
  }
  const secret = text.startsWith("nsec1")
    ? (decode(text as `nsec1${string}`).data as Uint8Array)
    : hexToBytes(text);
  if (getPublicKey(secret) !== identity.pubkey)
    throw new Error("The key is not this agent's");
  return secret;
}
