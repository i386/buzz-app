// A standalone agent host: runs one of the agents the desktop app saved on
// this machine, with the same runner and agent type code the app runs, while
// the app does not run it. The app's own claim protocol decides which copy
// runs the agent, so opening the installed app takes it over, and quitting
// the app lets this host take it back.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getPublicKey } from "nostr-tools/pure";
import claudeManifest from "../bundled/claude-code/manifest.json";
import { claudeRun } from "../bundled/claude-code/run";
import { withScript as claudeScript } from "../bundled/claude-code/setup";
import { ClaudeRuntime, DEFAULT_CONFIG } from "../bundled/claude-code/runtime";
import { defaults as codexDefaults } from "../bundled/codex/config";
import codexManifest from "../bundled/codex/manifest.json";
import { codexRun } from "../bundled/codex/run";
import { withScript as codexScript } from "../bundled/codex/setup";
import { CodexRuntime } from "../bundled/codex/runtime";
import { nodeClient } from "../buzz-mcp/node";
import { createLocalAgentActivity } from "../features/agents/local-activity";
import type { AgentReads } from "../features/agents/reads";
import { communityDestination } from "../features/communities/destination";
import { AgentRunners } from "../features/agents/runner";
import {
  type Agent,
  type RegisteredAgentType,
  teamPrompt,
} from "../features/agents/service";
import {
  type AgentRecord,
  readOne,
  readTeams,
  recordKey,
  setAttention,
  writeRecord,
} from "../features/agents/store";
import { eventsDto, type RelayEvent } from "../features/relay/events";
import { relayPartition } from "../features/relay/partition";
import { Claims } from "./claim";
import { AgentFeed } from "./feed";
import { checkSaved, type Identity, readNames } from "./identity";
import { agentReads } from "./reads";
import { type Declared, processHost } from "./spawn";
import { stateStorage } from "./storage";

/** The kinds the app's custody signs for an agent (agent-controller
 * app_agent.rs `KINDS`): its owner attestation is added to each. */
const KINDS = [5, 7, 9, 40003, 40100, 41010];
/** How often due timers are looked for, as in the app. */
const TICK_MS = 5_000;

/** Events checked as the app checks what custody gives back. */
const verified = (events: readonly unknown[]): RelayEvent[] =>
  eventsDto([...events]);

type TypeRun = Readonly<{
  type: RegisteredAgentType;
  sync(agents: readonly Agent[]): void;
  dispose(): void;
}>;

export type HostOptions = Readonly<{
  identity: Identity;
  secret: Uint8Array;
  /** The app's agents directory: `identities.json`, the `hosts` locks, and
   * the agent storage the app and this host share. */
  dir: string;
  log(message: string): void;
  /** Called once the agent is deleted, erased or changed in the app: this
   * host has stopped hosting it, and must stop. */
  onGone(reason: string): void;
}>;

/** Runs the agent until the returned stop is called. */
export function host(options: HostOptions): () => Promise<void> {
  const { identity, secret, dir, log, onGone } = options;
  const { pubkey } = identity;
  if (getPublicKey(secret) !== pubkey)
    throw new Error("The key is not this agent's");
  const home = join(dir, "standalone", pubkey);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // The app's agent storage: the agent's settings, teams and sessions are the
  // ones the app shows and saves.
  const storage = stateStorage(join(dir, "state"));
  const client = nodeClient({
    relay: identity.relay,
    key: Buffer.from(secret).toString("hex"),
    ...(identity.auth ? { auth: identity.auth } : {}),
    root: home,
  });
  const reads: AgentReads = agentReads(client, identity.relay);
  let live = false;
  const readsOf = (agent: string) =>
    live && agent === pubkey ? reads : undefined;

  const [pluginId = "", typeId = ""] = identity.type.split("/");
  const run = typeRun(typeId, pluginId, identity.type, readsOf, storage);
  const claims = new Claims(join(dir, "hosts"));
  const activity = createLocalAgentActivity();

  // The agent's record as last read, and the stored text it was read from:
  // the app may save a change at any time, and each tick reads it again.
  let saved = storage.getItem(recordKey(pubkey));
  let stored = readOne(storage, pubkey);
  let view: Agent | undefined;
  const recordOf = (): AgentRecord => {
    if (!stored) {
      const made = run.type.defaults();
      let record: AgentRecord = {
        pubkey,
        attention: {},
        config: made.config,
      };
      for (const [slug, value] of Object.entries(made.attention ?? {}))
        record = setAttention(record, slug, value);
      stored = record;
    }
    return stored;
  };
  const reread = () => {
    const now = storage.getItem(recordKey(pubkey));
    if (now === saved) return;
    saved = now;
    stored = readOne(storage, pubkey);
    view = undefined;
    run.sync([agentView()]);
  };
  // One object while nothing changes: the runner compares it to see edits.
  const agent = (): Agent => {
    if (view) return view;
    const record = recordOf();
    view = Object.freeze({
      pubkey,
      name: identity.name,
      type: identity.type,
      owner: identity.owner,
      relay: identity.relay,
      place: "here",
      attention: record.attention,
      skipped: record.skipped ?? {},
      timers: record.timers ?? {},
      attentionEnabled: record.attentionEnabled === true,
      config: record.config,
    });
    return view;
  };
  const save = (record: AgentRecord) => {
    mine(record.pubkey);
    writeRecord(storage, record);
    saved = storage.getItem(recordKey(pubkey));
    stored = record;
    view = undefined;
    run.sync([agentView()]);
  };
  const feed = new AgentFeed({
    relay: identity.relay,
    secret,
    pubkey,
    ...(identity.auth ? { auth: JSON.parse(identity.auth) as string[] } : {}),
    onEvents: (batch) => runners.dispatch(batch, () => true),
    onStatus: (now) => {
      if (now === live) return;
      live = now;
      log(now ? "Listening" : "Not listening");
      runners.resume(new Set(now ? [pubkey] : []));
    },
    log,
  });
  // Whether the app deleted, erased or changed the agent: then this host
  // stops, and tells its caller why.
  let gone = false;
  const isGone = () => {
    let reason: string | undefined;
    try {
      reason = checkSaved(dir, identity);
    } catch (error) {
      log(`Could not read the saved agent: ${String(error)}`);
    }
    if (reason && !gone) {
      gone = true;
      // After this function has set the host up, if it is still doing so.
      queueMicrotask(() => void stop().finally(() => onGone(reason)));
    }
    return gone;
  };
  const mine = (agent: string) => {
    if (agent !== pubkey) throw new Error("Not this host's agent");
  };
  // As the app scopes the agent's community, so saved sessions match.
  const scope = relayPartition(
    communityDestination(identity.relay).url,
    identity.owner,
  );
  const runners = new AgentRunners({
    ready: (agent) => (live && agent === pubkey ? agentView() : undefined),
    agent: (agent) => (agent === pubkey ? agentView() : undefined),
    find: (agent) => (agent === pubkey ? agentView() : undefined),
    member: (_, event) => {
      const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
      return !!channel && feed.channels.has(channel);
    },
    scope: () => scope,
    saved: (agent) => (agent === pubkey ? stored : undefined),
    record: (agent) => {
      mine(agent);
      return recordOf();
    },
    // Storage here saves as it is set, so a write either throws or is saved.
    write: async (record) => save(record),
    progress: (record) => save(record),
    team: (agent) => teamPrompt(readTeams(storage), readNames(dir), agent),
    classifier: () => "unavailable",
    custody: {
      claim: async (agent) => {
        mine(agent);
        // Checked here too, not only each tick, so an event cannot start a
        // turn for an agent the app has deleted.
        if (gone || isGone()) return false;
        try {
          return await claims.claim(agent);
        } catch (error) {
          // Unlike the app, which always runs its agents, this host runs one
          // only when it knows no other copy does.
          log(`Could not check who runs the agent: ${String(error)}`);
          return false;
        }
      },
      release: (agent) => claims.release(agent),
      publish: async (agent, event) => {
        mine(agent);
        if (!KINDS.includes(event.kind))
          throw new Error(`Agents cannot publish kind ${event.kind}`);
        const posted = await client.publish({
          kind: event.kind,
          content: event.content,
          tags: event.tags ?? [],
        });
        return verified([posted])[0] as RelayEvent;
      },
      query: async (agent, filters) => {
        mine(agent);
        return verified(
          await client.query(filters as readonly Record<string, unknown>[]),
        );
      },
      upload: (agent, data, mime) => {
        mine(agent);
        return client.upload(Buffer.from(data, "base64"), mime);
      },
      media: (agent, url) => {
        mine(agent);
        return client.media(url);
      },
      remember: async (agent, slug, body, after) => {
        mine(agent);
        return verified([
          await client.remember(slug, body, after),
        ])[0] as RelayEvent;
      },
    },
    activity,
    // The app shows typing only on its own screen; there is none here.
    typing: () => () => {},
  });
  function agentView() {
    return agent();
  }

  runners.reconcile(
    [{ pubkey, type: identity.type }],
    new Map([[identity.type, run.type]]),
  );
  run.sync([agentView()]);
  feed.start();
  const tick = setInterval(() => {
    if (gone || isGone()) return;
    try {
      reread();
    } catch (error) {
      log(`Could not read the agent's settings: ${String(error)}`);
    }
    runners.tick();
  }, TICK_MS);
  log(`Running ${identity.name} (${identity.type}) from ${home}`);

  let stopped: Promise<void> | undefined;
  const stop = () => (stopped ??= stopHosting());
  return stop;

  async function stopHosting() {
    clearInterval(tick);
    feed.stop();
    runners.clear();
    run.dispose();
    await claims.release(pubkey);
    claims.dispose();
  }
}

function typeRun(
  typeId: string,
  pluginId: string,
  key: string,
  reads: (pubkey: string) => AgentReads | undefined,
  storage: Storage,
): TypeRun {
  const registered = (
    type: Pick<RegisteredAgentType, "id" | "title" | "defaults"> &
      Partial<RegisteredAgentType>,
  ) =>
    Object.freeze({
      ...type,
      key,
      pluginId,
      revision: "standalone",
    }) as RegisteredAgentType;
  if (typeId === "claude-code") {
    const processes = processHost(
      claudeManifest.host.processes as readonly Declared[],
    );
    // Runs Buzz's own copy of Claude, which the desktop app keeps current.
    const runtime = new ClaudeRuntime(
      { spawn: claudeScript(processes.spawn) },
      reads,
      storage,
    );
    return {
      type: registered({
        id: typeId,
        title: "Claude",
        defaults: () => ({ config: DEFAULT_CONFIG }),
        ...claudeRun(runtime),
      }),
      sync: (agents) => runtime.sync(agents),
      dispose: () => {
        runtime.dispose();
        processes.stopAll();
      },
    };
  }
  if (typeId === "codex") {
    const processes = processHost(
      codexManifest.host.processes as readonly Declared[],
    );
    // Runs Buzz's own copy of Codex, which the desktop app keeps current.
    const runtime = new CodexRuntime(
      codexScript(processes.spawn),
      reads,
      storage,
    );
    return {
      type: registered({
        id: typeId,
        title: "Codex",
        defaults: () => ({ config: { ...codexDefaults } }),
        ...codexRun(runtime),
      }),
      sync: (agents) => runtime.sync(agents),
      dispose: () => {
        runtime.dispose();
        processes.stopAll();
      },
    };
  }
  throw new Error(`This host cannot run ${key} agents`);
}
