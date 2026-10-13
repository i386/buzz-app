import { createLocalAgentActivity, type WorkOutcome } from "./local-activity";
import { createHash } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import { schnorr } from "@noble/curves/secp256k1.js";
import { npubEncode } from "nostr-tools/nip19";
import { bytesToHex } from "nostr-tools/utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eventDto, type RelayEvent } from "../relay/events";
import { keypair, signed } from "../relay/testing";
import type { LiveBatch, LiveListener } from "../relay/incoming";
import type { RelayData, RelaySnapshot } from "../relay/service";
import type { RelaySession } from "../relay/session";
import type {
  AgentEventTemplate,
  AgentIdentity,
  AgentsNative,
  PortableAgents,
} from "./native";
import {
  AgentsService,
  type AgentCommunities,
  type AgentType,
  type Delivery,
  fromOwner,
  teamPrompt,
} from "./service";
import { memoryStorage } from "./test-fakes";

// Cleanup's channel step has its own coverage (relay-removal); here only its
// place in the order matters.
const steps: string[] = [];
const leaveChannels = vi.hoisted(() => vi.fn());
// The viewer's kind 30177 records, as the community's outbox writes them.
const records = vi.hoisted(() => ({
  publish: vi.fn(),
  remove: vi.fn(),
  removeAgent: vi.fn(),
}));
vi.mock("./relay-removal", () => ({
  removeAgentFromChannels: leaveChannels,
  publishAgentRecord: records.publish,
  deleteAgentRecord: records.remove,
  removeRelayAgent: records.removeAgent,
}));

const viewer = "a".repeat(64);
const other = "b".repeat(64);
const bot = "c".repeat(64);
const sibling = "d".repeat(64);
const channel = "0b8e2a3c-1d4f-4a5b-8c6d-7e8f9a0b1c2d";
const event = (id: string, patch: Partial<RelayEvent> = {}) =>
  ({
    id: id.padEnd(64, "0"),
    pubkey: other,
    kind: 9,
    created_at: 100,
    content: `hello ${id}`,
    tags: [["h", channel]],
    sig: "",
    ...patch,
  }) as unknown as RelayEvent;

function fakeRelay(origin = "https://relay.example.test") {
  const live = new Set<LiveListener>();
  const changes = new Set<() => void>();
  const archived = new Set<string>();
  const archives = {
    archived,
    /** The last read did not finish, as when its session closed. */
    unknown: false,
    consent: vi.fn(
      async () => ({ auth: ["auth"] }) as { auth: string[] } | null,
    ),
    ensure: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    state(pubkey: string) {
      if (this.unknown) return "unknown";
      return archived.has(pubkey) ? "archived" : "not-archived";
    },
    writable: true,
    request: vi.fn(async (_: string, pubkey: string) => {
      steps.push("archive");
      archived.add(pubkey);
    }),
  };
  let status = "connected";
  const statuses = new Set<() => void>();
  /** The viewer's kind 30177 records the community returns. */
  const listed: RelayEvent[] = [];
  const session = {
    archives,
    read: vi.fn(async () => [...listed]),
    // STOPGAP(agent-local-typing): delete with local-typing.ts.
    typing: { local: vi.fn() },
    // The agent is in `channel`; `private` is the owner's alone.
    channels: {
      list: () => ({
        channels: [
          { id: channel, name: "general", members: [viewer, bot] },
          { id: "private", name: "private", members: [viewer] },
        ],
      }),
    },
    live: {
      snapshot: () => ({ status }),
      subscribe(listener: () => void) {
        statuses.add(listener);
        return () => statuses.delete(listener);
      },
    },
    subscribeLive(listener: LiveListener) {
      live.add(listener);
      return () => live.delete(listener);
    },
  } as unknown as RelaySession;
  let snapshot: RelaySnapshot = {
    status: "ready",
    generation: 1,
    viewer,
    origin,
    scope: `${origin}:${viewer}`,
    session,
  };
  const connected_ = snapshot;
  return {
    relay: {
      snapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        changes.add(listener);
        return () => changes.delete(listener);
      },
      retry: vi.fn(),
    } as unknown as RelayData,
    /** Drops the connection, or restores it with a new session. */
    connect(connected: boolean) {
      snapshot = connected
        ? { ...connected_, session: { ...session } as RelaySession }
        : { status: "disconnected", generation: 2, session };
      for (const listener of changes) listener();
    },
    /** Restores the connection signed in as `next`, in a new session. */
    signIn(next: string) {
      snapshot = {
        ...connected_,
        viewer: next,
        scope: `${origin}:${next}`,
        session: { ...session } as RelaySession,
      };
      for (const listener of changes) listener();
    },
    /** Fails the connection, as a first connect that timed out does. */
    fail() {
      snapshot = { status: "error", generation: 4, session, error: "down" };
      for (const listener of changes) listener();
    },
    /** Replaces the session, as after the transport was lost. */
    reconnecting() {
      snapshot = { status: "connecting", generation: 3, session };
      for (const listener of changes) listener();
    },
    /** Drops and restores the socket inside the same session, as live.ts does. */
    recover() {
      for (const next of ["retrying", "connected"]) {
        status = next;
        for (const listener of statuses) listener();
      }
    },
    emit: (batch: LiveBatch) => {
      for (const listener of live) listener(batch);
    },
    archives,
    listed,
    session,
    origin,
  };
}

/** The viewer's joined communities, one selected; `open` connects any of them. */
function fakeCommunities(...joined: ReturnType<typeof fakeRelay>[]) {
  let relays = joined;
  const changes = new Set<() => void>();
  let selected: string | null = relays[0]?.origin ?? null;
  return {
    communities: {
      snapshot: () => ({
        viewer,
        selected,
        memberships: relays.map(({ origin }) => ({ id: origin, name: origin })),
      }),
      subscribe: (listener: () => void) => {
        changes.add(listener);
        return () => changes.delete(listener);
      },
      open: vi.fn(
        (id: string) => relays.find((fake) => fake.origin === id)?.relay,
      ),
    } as unknown as AgentCommunities,
    select(next: string | null) {
      selected = next;
      for (const listener of changes) listener();
    },
    leave(origin: string) {
      relays = relays.filter((fake) => fake.origin !== origin);
      if (selected === origin) selected = null;
      for (const listener of changes) listener();
    },
  };
}

function fakeNative(identities: AgentIdentity[] = []) {
  let published = 0;
  const keys = [bot, sibling];
  const at = (pubkey: string) =>
    identities.findIndex((identity) => identity.pubkey === pubkey);
  const change = (pubkey: string, patch: Partial<AgentIdentity>) => {
    const index = at(pubkey);
    const identity = identities[index];
    if (identity) identities[index] = { ...identity, ...patch };
  };
  const native = {
    list: vi.fn(async () => [...identities]),
    create: vi.fn(async (_: string, __: string, type: string, name: string) => {
      const identity = {
        pubkey: keys.shift() as string,
        relay: "wss://relay.example.test",
        owner: viewer,
        type,
        name,
        deleted: false,
      };
      identities.push(identity);
      return identity;
    }),
    portable: vi.fn(
      async (): Promise<PortableAgents> => ({
        agents: [
          { source: "harness" as const, pubkey: bot, name: "Old", relay: "" },
          {
            source: "installed" as const,
            pubkey: sibling,
            name: "Older",
            relay: "",
          },
        ],
        teams: [],
        warnings: ["Could not read one store"],
      }),
    ),
    port: vi.fn(
      async (
        _: string,
        pubkey: string,
        destination: string,
        owner: string,
        type: string,
      ) => {
        const identity = {
          pubkey,
          relay: destination.replace(/^https:/, "wss:"),
          owner,
          type,
          name: "Older",
          deleted: false,
        };
        identities.push(identity);
        return { agent: identity, carry: { instructions: "Triage." } };
      },
    ),
    rename: vi.fn(async (pubkey: string, name: string) => {
      change(pubkey, { name });
    }),
    setPicture: vi.fn(async (pubkey: string, picture: string | null) => {
      const index = at(pubkey);
      const { picture: _, ...identity } = identities[index] as AgentIdentity;
      identities[index] = picture ? { ...identity, picture } : identity;
    }),
    setType: vi.fn(async (pubkey: string, type: string) => {
      change(pubkey, { type });
    }),
    remove: vi.fn(async (pubkey: string) => {
      steps.push("key");
      change(pubkey, { deleted: true });
    }),
    forget: vi.fn(async (pubkey: string) => {
      steps.push("forget");
      identities.splice(at(pubkey), 1);
    }),
    publish: vi.fn(async (pubkey: string, template: AgentEventTemplate) =>
      event(`p${++published}`, {
        pubkey,
        kind: template.kind,
        content: template.content,
        tags: (template.tags ?? []).map((tag) => [...tag]),
      }),
    ),
    publishProfile: vi.fn(async (_: string) => {}),
    query: vi.fn(async () => []),
    upload: vi.fn(async () => ({ url: "", sha256: "", size: 0, type: "" })),
    media: vi.fn(async () => ""),
    remember: vi.fn(async (pubkey: string) =>
      event(`m${++published}`, { pubkey }),
    ),
    claim: vi.fn(async (_: string) => true),
    release: vi.fn(async (_: string) => {}),
  } satisfies AgentsNative;
  return native;
}

type Config = { reply: string };
async function setup({
  storage = memoryStorage(),
  identities = [] as AgentIdentity[],
  listed = [] as RelayEvent[],
  timeoutMs = 60_000,
} = {}) {
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const fake = fakeRelay();
  const second = fakeRelay("https://other.example.test");
  const client = fakeCommunities(fake, second);
  const native = fakeNative(identities);
  fake.listed.push(...listed);
  const authorize = vi.fn(
    async (_: string, __: AbortSignal) =>
      ["auth", viewer, "", "f".repeat(128)] as const,
  );
  const activity = createLocalAgentActivity();
  const service = new AgentsService(
    ctx,
    client.communities,
    native,
    storage,
    authorize,
    activity,
  );
  const plugin = ctx.extend({
    pluginOwner: Object.freeze({ id: "example", revision: "one" }),
  });
  const run = vi.fn<(delivery: Delivery<Config>) => void | Promise<void>>();
  const type: AgentType<Config> = {
    id: "echo",
    title: "Echo",
    timeoutMs,
    adopt: (carry, saved) => ({ reply: carry.instructions ?? saved.reply }),
    carry: ({ reply }) => ({ instructions: reply, workspace: "~/echo" }),
    describeMigration: () => [
      { id: "model", label: "Model", isOverride: true },
      { id: "thinking", label: "Thinking", isOverride: true },
      {
        id: "sessions",
        label: "Sessions",
        isOverride: true,
        unchangedKey: "channel",
      },
      {
        id: "equivalent",
        label: "Equivalent setting",
        isOverride: true,
        unchangedKey: "same",
      },
      { id: "default", label: "Default setting", isOverride: false },
    ],
    defaults: () => ({
      config: { reply: "ok" },
      attention: {
        "interest/default": { type: "interest", instructions: "Be brief." },
        "watch/channel": {
          type: "event",
          interest_id: "default",
          enabled: true,
          since: 1,
          channels: [channel],
          kinds: [9],
          filter: 'content == "deploy"',
        },
      },
    }),
    models: async () => ({
      current: "fast",
      models: [
        {
          id: "fast",
          label: "Fast",
          efforts: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        },
        { id: "deep", label: "Deep", efforts: [{ id: "max", label: "Max" }] },
      ],
    }),
    run,
  };
  plugin.agents.register(type);
  await vi.waitFor(() => expect(service.snapshot().status).toBe("ready"));
  return {
    activity,
    service,
    type,
    native,
    storage,
    run,
    emit: fake.emit,
    connect: fake.connect,
    signIn: fake.signIn,
    fail: fake.fail,
    relay: fake.relay,
    reconnecting: fake.reconnecting,
    recover: fake.recover,
    archives: fake.archives,
    session: fake.session,
    authorize,
    plugin,
    second,
    select: client.select,
    leave: client.leave,
    communities: client.communities,
    ctx,
  };
}

/** Lets every pending promise chain finish: a macrotask runs only after the
 * microtask queue is empty, so this does not depend on how fast runners are. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The events native published as an agent, of `kind`, in order. */
async function published(native: ReturnType<typeof fakeNative>, kind: number) {
  const events = await Promise.all(
    native.publish.mock.results.map(({ value }) => value),
  );
  return events.filter((event) => event.kind === kind);
}

beforeEach(() => {
  vi.useRealTimers();
  steps.length = 0;
  leaveChannels.mockReset();
  leaveChannels.mockImplementation(async () => void steps.push("channels"));
  records.publish.mockReset();
  records.publish.mockImplementation(async () => {});
  records.remove.mockReset();
  records.remove.mockImplementation(async () => void steps.push("record"));
  records.removeAgent.mockReset();
  records.removeAgent.mockImplementation(async () => void steps.push("leave"));
});
afterEach(() => vi.useRealTimers());

it("creates an agent in the community shown, with its type's defaults, and publishes its profile", async () => {
  const { service, native } = await setup();
  const agent = await service.create({ type: "example/echo", name: " Echo " });
  expect(native.create).toHaveBeenCalledWith(
    "https://relay.example.test",
    viewer,
    "example/echo",
    "Echo",
  );
  expect(native.publishProfile).toHaveBeenCalledWith(bot);
  expect(agent).toMatchObject({
    pubkey: bot,
    name: "Echo",
    type: "example/echo",
    config: { reply: "ok" },
  });
  expect(Object.keys(agent.attention)).toEqual([
    "interest/default",
    "watch/channel",
  ]);
  expect(service.find(bot)).toEqual(agent);
});

it("brings over an identity not already an agent, with its type's defaults and what it adopts, and publishes its profile", async () => {
  const { service, native } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  const found = await service.portable();
  // `bot` is already an agent here; the warning still shows.
  expect(found.agents.map((agent) => agent.pubkey)).toEqual([sibling]);
  expect(found.warnings).toEqual(["Could not read one store"]);
  const agent = await service.port({
    source: "installed",
    pubkey: sibling,
    type: "example/echo",
  });
  expect(native.port).toHaveBeenCalledWith(
    "installed",
    sibling,
    "https://relay.example.test",
    viewer,
    "example/echo",
  );
  expect(native.publishProfile).toHaveBeenCalledWith(sibling);
  expect(agent).toMatchObject({
    pubkey: sibling,
    name: "Older",
    config: { reply: "Triage." },
  });
  expect(service.find(sibling)?.config).toEqual({ reply: "Triage." });
  expect(Object.keys(agent.attention)).toEqual([
    "interest/default",
    "watch/channel",
  ]);
  await expect(
    service.port({ source: "harness", pubkey: bot, type: "nope/none" }),
  ).rejects.toThrow("That agent type is not available");
});

it("imports a shared agent as a new identity with its name and picture, adopting its instructions", async () => {
  const { service, native } = await setup();
  const agent = await service.port({
    source: "shared",
    type: "example/echo",
    name: " Baymax ",
    picture: "https://example.test/baymax.png",
    instructions: "Open drafts only.",
  });
  expect(native.create).toHaveBeenCalledWith(
    "https://relay.example.test",
    viewer,
    "example/echo",
    "Baymax",
  );
  expect(native.port).not.toHaveBeenCalled();
  expect(native.setPicture).toHaveBeenCalledWith(
    agent.pubkey,
    "https://example.test/baymax.png",
  );
  expect(agent).toMatchObject({
    name: "Baymax",
    picture: "https://example.test/baymax.png",
    config: { reply: "Open drafts only." },
  });
  // Without instructions it starts from the type's defaults.
  const plain = await service.port({
    source: "shared",
    type: "example/echo",
    name: "Plain",
  });
  expect(plain.config).toEqual({ reply: "ok" });
  await expect(
    service.port({ source: "shared", type: "example/echo", name: "  " }),
  ).rejects.toThrow("Name the agent");
});

/** The imported copy of old Buzz team `id` in `community`. */
const betaTeam = (id: string, community = "https://relay.example.test") =>
  `beta-${createHash("sha256").update(`${id}\n${community}`).digest("hex")}`;
const [alder, birch, carrow] = [bot, sibling, "e".repeat(64)];
const NAMES: Record<string, string> = {
  [alder]: "Alder",
  [birch]: "Birch",
  [carrow]: "Carrow",
};
/** Old Buzz's Night Shift as native lists it, with these members. */
const nightShift = (
  members: readonly string[],
  text: { name?: string; instructions?: string } = {},
) => ({
  id: "old-night-shift",
  name: "Night Shift",
  instructions: "Ship small.",
  ...text,
  members: members.map((pubkey) => ({
    pubkey,
    name: NAMES[pubkey] as string,
    source: "installed" as const,
  })),
});
/** Its copy here in `community`, as saved. */
const savedShift = (members: readonly string[], community?: string) => ({
  id: betaTeam("old-night-shift", community),
  name: "Night Shift",
  instructions: "Ship small.",
  members,
});
function listsTeam(
  native: ReturnType<typeof fakeNative>,
  team: ReturnType<typeof nightShift>,
) {
  native.portable.mockResolvedValue({
    agents: team.members.map(({ pubkey, name }) => ({
      source: "installed" as const,
      pubkey,
      name,
      relay: "",
    })),
    teams: [team],
    warnings: [],
  });
}
const importTeam = (service: AgentsService) =>
  service.portTeam({ id: "old-night-shift", type: "example/echo" });
const importOld = (service: AgentsService, pubkey: string) =>
  service.port({ source: "installed", pubkey, type: "example/echo" });
const portedKeys = (native: ReturnType<typeof fakeNative>) =>
  native.port.mock.calls.map(([, pubkey]) => pubkey);
const here = (pubkey: string, relay = "wss://relay.example.test") => ({
  pubkey,
  relay,
  owner: viewer,
  type: "example/echo",
  name: NAMES[pubkey] as string,
  deleted: false,
});

it("imports a team with the members that came, names the rest, and leaves later single imports off it", async () => {
  const { service, native, storage } = await setup();
  listsTeam(native, nightShift([alder, birch, carrow]));
  const port = native.port.getMockImplementation() as NonNullable<
    ReturnType<typeof native.port.getMockImplementation>
  >;
  native.port.mockImplementation(async (...args) => {
    if (args[1] === birch) throw new Error("Keychain access was denied");
    return port(...args);
  });
  const result = await importTeam(service);
  expect(result.team).toEqual(savedShift([alder, carrow]));
  expect(result.imported.map((agent) => agent.pubkey)).toEqual([alder, carrow]);
  expect(result.failed).toEqual([
    { name: "Birch", error: "Keychain access was denied" },
  ]);
  expect(result.teamError).toBeUndefined();
  // Imported on its own afterwards, it never joins the team.
  native.port.mockImplementation(port);
  const stored = storage.getItem("buzz.agents.teams.v1");
  await importOld(service, birch);
  expect(service.find(birch)).toBeDefined();
  expect(storage.getItem("buzz.agents.teams.v1")).toBe(stored);
  expect(service.snapshot().teams).toEqual([savedShift([alder, carrow])]);
});

it("puts members imported one by one on the team without importing them again", async () => {
  const { service, native } = await setup();
  listsTeam(native, nightShift([alder, birch]));
  await importOld(service, alder);
  const result = await importTeam(service);
  expect(result.team).toEqual(savedShift([alder, birch]));
  expect(result.imported.map((agent) => agent.pubkey)).toEqual([birch]);
  expect(portedKeys(native)).toEqual([alder, birch]);
});

it("imports a team again without duplicates, keeping its edits here", async () => {
  const { service, native } = await setup();
  listsTeam(native, nightShift([alder, birch]));
  await importTeam(service);
  await service.saveTeam({
    id: betaTeam("old-night-shift"),
    name: "Renamed",
    instructions: "Mine.",
    members: [alder, birch],
  });
  const again = await importTeam(service);
  expect(again.imported).toEqual([]);
  expect(service.snapshot().teams).toEqual([
    {
      id: betaTeam("old-night-shift"),
      name: "Renamed",
      instructions: "Mine.",
      members: [alder, birch],
    },
  ]);
  expect(portedKeys(native)).toEqual([alder, birch]);
});

it("never takes over a same-name team the owner made before importing", async () => {
  const { service, native } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  const own = await service.saveTeam({
    name: "Night Shift",
    instructions: "Mine.",
    members: [bot],
  });
  listsTeam(native, nightShift([carrow]));
  await importTeam(service);
  expect(service.snapshot().teams).toEqual([own, savedShift([carrow])]);
});

it("recreates a deleted imported team when it is imported again", async () => {
  const { service, native } = await setup();
  listsTeam(native, nightShift([alder]));
  await importTeam(service);
  await service.removeTeam(betaTeam("old-night-shift"));
  const text = { name: "Late Shift", instructions: "Ship smaller." };
  listsTeam(native, nightShift([alder, birch], text));
  await importTeam(service);
  expect(service.snapshot().teams).toEqual([
    { ...savedShift([alder, birch]), ...text },
  ]);
});

it("saves the team as old Buzz has it at import, not as the list showed it", async () => {
  const { service, native } = await setup();
  listsTeam(
    native,
    nightShift([alder, birch], { name: "Listed", instructions: "Stale." }),
  );
  await service.portable();
  listsTeam(native, nightShift([alder, birch, carrow]));
  const result = await importTeam(service);
  expect(result.team).toEqual(savedShift([alder, birch, carrow]));
  expect(portedKeys(native)).toEqual([alder, birch, carrow]);
});

it("imports members one at a time, in order, then saves the team once", async () => {
  const storage = memoryStorage();
  const { service, native } = await setup({ storage });
  listsTeam(native, nightShift([alder, birch, carrow]));
  const steps: string[] = [];
  const port = native.port.getMockImplementation() as NonNullable<
    ReturnType<typeof native.port.getMockImplementation>
  >;
  native.port.mockImplementation(async (...args) => {
    steps.push(`start ${NAMES[args[1]]}`);
    const done = await port(...args);
    steps.push(`end ${NAMES[args[1]]}`);
    return done;
  });
  const setItem = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (key === "buzz.agents.teams.v1") steps.push("team");
    setItem(key, value);
  };
  await importTeam(service);
  expect(steps).toEqual([
    "start Alder",
    "end Alder",
    "start Birch",
    "end Birch",
    "start Carrow",
    "end Carrow",
    "team",
  ]);
});

it("names a member old Buzz no longer lists, and never imports it", async () => {
  const { service, native } = await setup();
  listsTeam(native, nightShift([alder, birch]));
  const found = await native.portable();
  native.portable.mockResolvedValue({
    ...found,
    agents: found.agents.filter((agent) => agent.pubkey !== birch),
  });
  const result = await importTeam(service);
  expect(result.failed).toEqual([
    { name: "Birch", error: "No longer available in old Buzz" },
  ]);
  expect(portedKeys(native)).toEqual([alder]);
  expect(result.team).toEqual(savedShift([alder]));
});

it("names a member with no name by its short npub", async () => {
  const { service, native } = await setup();
  const team = nightShift([birch]);
  listsTeam(native, {
    ...team,
    members: team.members.map((member) => ({ ...member, name: "  " })),
  });
  native.port.mockRejectedValue(new Error("Keychain access was denied"));
  const result = await importTeam(service);
  expect(result.failed).toEqual([
    {
      name: `npub…${npubEncode(birch).slice(-3)}`,
      error: "Keychain access was denied",
    },
  ]);
});

it("imports every member into the community and owner the import started with", async () => {
  const { service, native, signIn } = await setup();
  listsTeam(native, nightShift([alder, birch]));
  const listed = native.portable.getMockImplementation() as NonNullable<
    ReturnType<typeof native.portable.getMockImplementation>
  >;
  const other = "e".repeat(64);
  native.portable.mockImplementationOnce(async () => {
    // Same community, so the import carries on; a new owner signed in.
    signIn(other);
    return listed();
  });
  const result = await importTeam(service);
  for (const pubkey of [alder, birch])
    expect(native.port).toHaveBeenCalledWith(
      "installed",
      pubkey,
      "https://relay.example.test",
      viewer,
      "example/echo",
    );
  const stored = (await native.list()).map(({ pubkey, relay, owner }) => ({
    pubkey,
    relay,
    owner,
  }));
  expect(stored).toEqual(
    [alder, birch].map((pubkey) => ({
      pubkey,
      relay: "wss://relay.example.test",
      owner: viewer,
    })),
  );
  expect(result.team).toEqual(savedShift([alder, birch]));
});

it("keeps an agent of the import's owner on the team when another owner signs in meanwhile", async () => {
  const { service, native, signIn } = await setup({
    identities: [here(birch)],
  });
  listsTeam(native, nightShift([alder, birch]));
  const listed = native.portable.getMockImplementation() as NonNullable<
    ReturnType<typeof native.portable.getMockImplementation>
  >;
  native.portable.mockImplementationOnce(async () => {
    signIn("e".repeat(64));
    return listed();
  });
  const result = await importTeam(service);
  expect(result.team).toEqual(savedShift([alder, birch]));
  expect(result.elsewhere).toEqual([]);
  expect(result.foreign).toEqual([]);
});

it("imports nothing when the community changes while old Buzz is read", async () => {
  const { service, native, second, select } = await setup();
  listsTeam(native, nightShift([alder]));
  const listed = native.portable.getMockImplementation() as NonNullable<
    ReturnType<typeof native.portable.getMockImplementation>
  >;
  native.portable.mockImplementationOnce(async () => {
    select(second.origin);
    return listed();
  });
  await expect(importTeam(service)).rejects.toThrow("Community changed");
  expect(native.port).not.toHaveBeenCalled();
  expect(service.snapshot().teams).toEqual([]);
});

it("keeps a team import in the community it started in, stopping when another is opened", async () => {
  const { service, native, second, select } = await setup();
  listsTeam(native, nightShift([alder, birch]));
  const port = native.port.getMockImplementation() as NonNullable<
    ReturnType<typeof native.port.getMockImplementation>
  >;
  native.port.mockImplementationOnce(async (...args) => {
    select(second.origin);
    return port(...args);
  });
  const result = await importTeam(service);
  expect(native.port).toHaveBeenCalledTimes(1);
  expect(native.port).toHaveBeenCalledWith(
    "installed",
    alder,
    "https://relay.example.test",
    viewer,
    "example/echo",
  );
  expect(result.failed).toEqual([
    { name: "Birch", error: "Community changed" },
  ]);
  expect(result.team).toEqual(savedShift([alder]));
  expect(service.snapshot().teams).toEqual([savedShift([alder])]);
  const relays = new Map(
    (await native.list()).map((identity) => [identity.pubkey, identity.relay]),
  );
  expect([...relays]).toEqual([[alder, "wss://relay.example.test"]]);
});

it("leaves a member that lives in another community off the team, and never moves it", async () => {
  const { service, native } = await setup({
    identities: [here(birch, "wss://other.example.test")],
  });
  listsTeam(native, nightShift([alder, birch]));
  const result = await importTeam(service);
  expect(result.elsewhere).toEqual(["Birch"]);
  expect(result.team).toEqual(savedShift([alder]));
  expect(portedKeys(native)).toEqual([alder]);
});

it("leaves a member another account on this device has off the team, and names it", async () => {
  const { service, native } = await setup({
    identities: [{ ...here(birch), owner: "e".repeat(64) }],
  });
  listsTeam(native, nightShift([alder, birch]));
  expect((await service.portable()).here).toEqual([]);
  const result = await importTeam(service);
  expect(result.foreign).toEqual(["Birch"]);
  expect(result.elsewhere).toEqual([]);
  expect(result.team).toEqual(savedShift([alder]));
  expect(portedKeys(native)).toEqual([alder]);
});

it("lists a team whose members are all here, and imports it from them", async () => {
  const { service, native } = await setup({
    identities: [here(alder), here(birch)],
  });
  listsTeam(native, nightShift([alder, birch]));
  const found = await service.portable();
  expect(found.agents).toEqual([]);
  expect(found.teams).toEqual([nightShift([alder, birch])]);
  expect(found.here).toEqual([alder, birch]);
  const result = await importTeam(service);
  expect(result).toEqual({
    team: savedShift([alder, birch]),
    imported: [],
    failed: [],
    elsewhere: [],
    foreign: [],
  });
  expect(native.port).not.toHaveBeenCalled();
});

it("keeps a team's imported members when the team cannot be saved, and changes no team", async () => {
  const storage = memoryStorage();
  const { service, native } = await setup({ storage });
  await service.create({ type: "example/echo", name: "Echo" });
  await service.saveTeam({ name: "Crew", instructions: "", members: [bot] });
  const stored = storage.getItem("buzz.agents.teams.v1");
  const teams = service.snapshot().teams;
  const setItem = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (key === "buzz.agents.teams.v1") throw new Error("Quota exceeded");
    setItem(key, value);
  };
  listsTeam(native, nightShift([carrow]));
  const result = await importTeam(service);
  expect(result.teamError).toEqual({ name: "Night Shift" });
  expect(result.team).toBeUndefined();
  expect(service.find(carrow)).toBeDefined();
  expect(storage.getItem("buzz.agents.teams.v1")).toBe(stored);
  expect(service.snapshot().teams).toBe(teams);
});

it("delivers mentions and matching watches once, and never the agent's own events", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  const mention = event("m", {
    tags: [
      ["h", channel],
      ["p", bot],
    ],
  });
  const watched = event("w", { content: "deploy" });
  emit({ events: [mention, mention, event("x"), watched], channelId: channel });
  emit({ events: [event("own", { pubkey: bot, content: "deploy" })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  const [first, second] = run.mock.calls.map(([delivery]) => delivery);
  expect(first?.trigger).toEqual({ type: "mention", event: mention });
  expect(second?.trigger).toMatchObject({
    type: "watch",
    event: watched,
    slug: "watch/channel",
    interest: { instructions: "Be brief." },
  });
  expect(first?.channelId).toBe(channel);
  expect(first?.config).toEqual({ reply: "ok" });
});

it("gives each member its teams' roster and instructions, and drops a deleted agent from its teams", async () => {
  const { service, run, emit, storage } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.create({ type: "example/echo", name: "Sib" });
  await expect(
    service.saveTeam({ name: "Crew", instructions: "", members: [other] }),
  ).rejects.toThrow("not an agent");
  const team = await service.saveTeam({
    name: " Crew ",
    instructions: "Echo leads.",
    members: [bot, sibling, bot],
  });
  expect(team).toMatchObject({ name: "Crew", members: [bot, sibling] });
  await service.saveTeam({
    name: "Solo",
    instructions: "",
    members: [sibling],
  });
  expect(service.snapshot().teams.map((saved) => saved.name)).toEqual([
    "Crew",
    "Solo",
  ]);
  emit({
    events: [
      event("m", {
        tags: [
          ["h", channel],
          ["p", bot],
        ],
      }),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  const prompt = run.mock.calls[0]?.[0].team ?? "";
  expect(prompt).toContain('"Crew"');
  expect(prompt).toContain(`- Echo (${npubEncode(bot)}), you`);
  expect(prompt).toContain(`- Sib (${npubEncode(sibling)})\n`);
  expect(prompt).toContain("Echo leads.");
  expect(prompt).not.toContain("Solo");

  await service.remove(sibling);
  await vi.waitFor(() =>
    expect(service.snapshot().teams.map((saved) => saved.members)).toEqual([
      [bot],
      [],
    ]),
  );
  expect(storage.getItem("buzz.agents.teams.v1")).not.toContain(sibling);
  await service.removeTeam(team.id);
  expect(service.snapshot().teams.map((saved) => saved.name)).toEqual(["Solo"]);
});

it("leaves the team section out for an agent on no team", () => {
  const agents = [{ pubkey: bot, name: "Echo" }];
  expect(teamPrompt([], agents, bot)).toBe("");
  expect(
    teamPrompt(
      [{ id: "t", name: "Crew", instructions: " ", members: [sibling] }],
      agents,
      bot,
    ),
  ).toBe("");
});

it("keeps handed-off activity local, without publishing working reactions", async () => {
  const { service, run, emit, native, relay, activity } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  let finish = () => {};
  const turn = new Promise<void>((resolve) => {
    finish = resolve;
  });
  run.mockImplementationOnce(async ({ workingUntil }) => workingUntil(turn));
  const mention = event("m", {
    tags: [
      ["h", channel],
      ["p", bot],
    ],
  });
  emit({ events: [mention], channelId: channel });
  const typing = relay.snapshot().session.typing.local;
  try {
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await settle();
    expect(activity.reader.work()[0]?.state).toBe("working");
    expect(typing).toHaveBeenCalledWith(
      expect.objectContaining({
        pubkey: bot,
        kind: 20002,
        tags: [
          ["h", channel],
          ["e", mention.id, "", "reply"],
        ],
      }),
    );
    expect(await published(native, 7)).toEqual([]);
    finish();
    await vi.waitFor(() =>
      expect(typing).toHaveBeenCalledWith(expect.objectContaining({ kind: 9 })),
    );
    expect(activity.reader.work()[0]?.state).toBe("done");
    expect(await published(native, 7)).toEqual([]);
    expect(await published(native, 5)).toEqual([]);
  } finally {
    finish();
  }
});

it("wakes on a reply in a thread it started only by a mention or a watch", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  run.mockImplementationOnce(async ({ agent }) => {
    await agent.publish({ kind: 9, content: "hi", tags: [["h", channel]] });
  });
  emit({ events: [event("m", { tags: [["p", bot]] })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  // The publish above returned event p1, which the relay sends back.
  const root = "p1".padEnd(64, "0");
  const reply = (id: string, patch: Partial<RelayEvent> = {}) =>
    event(id, {
      ...patch,
      tags: [["h", channel], ["e", root, "", "reply"], ...(patch.tags ?? [])],
    });
  emit({ events: [event("p1", { pubkey: bot, content: "hi" })] });
  emit({ events: [reply("quiet")] });
  await settle();
  expect(run).toHaveBeenCalledTimes(1);
  emit({ events: [reply("watched", { content: "deploy" })] });
  emit({ events: [reply("named", { tags: [["p", bot]] })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
  expect(run.mock.calls.slice(1).map(([{ trigger }]) => trigger.type)).toEqual([
    "watch",
    "mention",
  ]);
});

it("passes the model and effort its owner asked for, and no other", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  const asked = (id: string, pubkey: string, ...tags: string[][]) =>
    event(id, { pubkey, tags: [["h", channel], ["p", bot], ...tags] });
  emit({
    events: [
      asked("owner", viewer, ["effort", bot, "high"]),
      asked("stranger", other, ["effort", bot, "high"], ["model", bot, "deep"]),
      asked("unlisted", viewer, ["effort", bot, "max"]),
      asked("elsewhere", viewer, ["effort", sibling, "high"]),
      asked("model", viewer, ["model", bot, "deep"], ["effort", bot, "max"]),
      asked("mismatch", viewer, ["model", bot, "deep"], ["effort", bot, "low"]),
      asked("unknown", viewer, ["model", bot, "gone"], ["effort", bot, "low"]),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(7));
  expect(
    run.mock.calls.map(([{ model, effort }]) => ({ model, effort })),
  ).toEqual([
    { model: undefined, effort: "high" },
    { model: undefined, effort: undefined },
    { model: undefined, effort: undefined },
    { model: undefined, effort: undefined },
    // An effort counts only for the model the run uses.
    { model: "deep", effort: "max" },
    { model: "deep", effort: undefined },
    { model: undefined, effort: "low" },
  ]);
});

it("keeps the in-flight run and the queue across edits; each job reads the agent as it starts", async () => {
  const { service, run, emit, native } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  let release: () => void = () => {};
  let held: Delivery<Config> | undefined;
  run.mockImplementationOnce(
    (delivery) =>
      new Promise<void>((resolve) => {
        held = delivery;
        release = resolve;
      }),
  );
  emit({
    events: [
      event("1", { tags: [["p", bot]] }),
      event("2", { tags: [["p", bot]] }),
    ],
  });
  await vi.waitFor(() => expect(held).toBeDefined());
  expect(run).toHaveBeenCalledTimes(1);
  await service.save(bot, { name: "Echo two", config: { reply: "new" } });
  await service.save(bot, {
    attention: { "watch/channel": null },
  });
  expect(held?.signal.aborted).toBe(false);
  await held?.agent.publish({ kind: 7, content: "+" });
  expect(native.publish).toHaveBeenLastCalledWith(bot, {
    kind: 7,
    content: "+",
  });
  release();
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  const queued = run.mock.calls[1]?.[0];
  expect(queued?.config).toEqual({ reply: "new" });
  expect(queued?.agent.name).toBe("Echo two");
});

it("keeps queued work across a disconnect and runs it once on reconnect", async () => {
  const { service, run, emit, connect } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  let release: () => void = () => {};
  run.mockImplementationOnce(
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  emit({
    events: [
      event("1", { tags: [["p", bot]] }),
      event("2", { tags: [["p", bot]] }),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  connect(false);
  expect(service.find(bot)).toBeUndefined();
  release();
  await settle();
  expect(run).toHaveBeenCalledTimes(1);
  await service.save(bot, { config: { reply: "new" } });
  connect(true);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect(run.mock.calls[1]?.[0].config).toEqual({ reply: "new" });
  await settle();
  expect(run).toHaveBeenCalledTimes(2);
});

it("aborts the in-flight run, and drops what is queued, when the agent is removed", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  let held: Delivery<Config> | undefined;
  run.mockImplementationOnce(
    (delivery) =>
      new Promise(() => {
        held = delivery;
      }),
  );
  emit({
    events: [
      event("1", { tags: [["p", bot]] }),
      event("2", { tags: [["p", bot]] }),
    ],
  });
  await vi.waitFor(() => expect(held).toBeDefined());
  await service.remove(bot);
  expect(held?.signal.aborted).toBe(true);
  await settle();
  expect(run).toHaveBeenCalledTimes(1);
});

it("drops its events while another copy of the app holds the agent, and runs once it holds it", async () => {
  const { service, run, emit, native } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  native.claim.mockResolvedValue(false);
  emit({ events: [event("1", { tags: [["p", bot]] })] });
  await vi.waitFor(() => expect(native.claim).toHaveBeenCalledWith(bot));
  await settle();
  expect(run).not.toHaveBeenCalled();
  native.claim.mockResolvedValue(true);
  const second = event("2", { tags: [["p", bot]] });
  emit({ events: [second] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(run.mock.calls[0]?.[0].trigger).toEqual({
    type: "mention",
    event: second,
  });
  // When the claim itself fails, it answers rather than stay silent.
  native.claim.mockRejectedValue(new Error("unreadable"));
  emit({ events: [event("3", { tags: [["p", bot]] })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
});

it("lets another copy of the app run an agent it cannot run", async () => {
  vi.useFakeTimers();
  const { service, run, emit, native, connect } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  emit({ events: [event("1", { tags: [["p", bot]] })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(native.release).not.toHaveBeenCalled();
  connect(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(native.release).toHaveBeenCalledTimes(1);
  expect(native.release).toHaveBeenCalledWith(bot);
  connect(true);
  native.claim.mockClear();
  emit({ events: [event("2", { tags: [["p", bot]] })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect(native.claim).toHaveBeenCalledWith(bot);
});

it("claims an agent as it comes into view, and releases it as it leaves, without waiting for a tick", async () => {
  const { service, native, connect } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await vi.waitFor(() => expect(native.claim).toHaveBeenCalledWith(bot));
  connect(false);
  await vi.waitFor(() => expect(native.release).toHaveBeenCalledWith(bot));
  native.claim.mockClear();
  connect(true);
  await vi.waitFor(() => expect(native.claim).toHaveBeenCalledWith(bot));
});

it("keeps running an agent while another community is selected, and gives it only its community's events", async () => {
  const { service, run, emit, second, select } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  select(second.origin);
  expect(service.find(bot)).toBeUndefined();
  expect(service.snapshot().running.map((agent) => agent.pubkey)).toEqual([
    bot,
  ]);
  expect(service.relay(bot)?.snapshot().origin).toBe(
    "https://relay.example.test",
  );
  second.emit({ events: [event("2", { tags: [["p", bot]] })] });
  const mention = event("1", { tags: [["p", bot]] });
  emit({ events: [mention] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(run.mock.calls[0]?.[0].trigger).toEqual({
    type: "mention",
    event: mention,
  });
  await settle();
  expect(run).toHaveBeenCalledTimes(1);
});

it("connects an agent's community at start without selecting it", async () => {
  const { service, run, second, communities } = await setup({
    identities: [
      {
        pubkey: bot,
        relay: "wss://other.example.test",
        owner: viewer,
        type: "example/echo",
        name: "Echo",
        deleted: false,
      },
    ],
  });
  expect(communities.open).toHaveBeenCalledWith("https://other.example.test");
  expect(service.find(bot)).toBeUndefined();
  second.emit({ events: [event("1", { tags: [["p", bot]] })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
});

it("opens no community for an agent list that arrives after it stopped", async () => {
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const client = fakeCommunities(
    fakeRelay(),
    fakeRelay("https://other.example.test"),
  );
  client.select(null);
  const native = fakeNative();
  let list!: (identities: AgentIdentity[]) => void;
  native.list.mockReturnValueOnce(
    new Promise((resolve) => {
      list = resolve;
    }),
  );
  const service = new AgentsService(
    ctx,
    client.communities,
    native,
    memoryStorage(),
  );
  await vi.waitFor(() => expect(list).toBeDefined());
  await ctx.fiber.dispose();
  list([
    {
      pubkey: bot,
      relay: "wss://other.example.test",
      owner: viewer,
      type: "example/echo",
      name: "Echo",
      deleted: false,
    },
  ]);
  await settle();
  expect(client.communities.open).not.toHaveBeenCalled();
  expect(service.snapshot().running).toEqual([]);
});

it("keeps an agent running while its community reconnects, and stops it on disconnect or leave", async () => {
  const { service, connect, reconnecting, leave } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  const running = () => service.snapshot().running.map((agent) => agent.pubkey);
  reconnecting();
  expect(service.find(bot)).toBeUndefined();
  expect(running()).toEqual([bot]);
  connect(false);
  expect(running()).toEqual([]);
  connect(true);
  expect(running()).toEqual([bot]);
  leave("https://relay.example.test");
  expect(running()).toEqual([]);
  expect(service.relay(bot)).toBeUndefined();
});

it("tries a failed unselected community again every so often, and leaves the selected one's Retry to the viewer", async () => {
  vi.useFakeTimers();
  const { service, relay, fail, second, select } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  fail();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(relay.retry).not.toHaveBeenCalled();
  select(second.origin);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(relay.retry).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(relay.retry).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(relay.retry).toHaveBeenCalledTimes(2);
});

it("is not woken by reactions, deletions or DMs", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  const ownMessage = "p1".padEnd(64, "0");
  emit({
    events: [
      event("react", {
        kind: 7,
        tags: [
          ["e", ownMessage],
          ["p", bot],
        ],
      }),
      event("delete", { kind: 5, tags: [["e", ownMessage]] }),
      event("dm", { kind: 4, tags: [["p", bot]] }),
    ],
  });
  emit({ events: [event("m", { tags: [["p", bot]] })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(run.mock.calls[0]?.[0].trigger).toMatchObject({ type: "mention" });
});

it("wakes on another of the owner's agents only when it names the agent", async () => {
  const { service, run, emit, native } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.create({ type: "example/echo", name: "Sibling" });
  run.mockImplementation(async ({ agent, trigger }) => {
    if (trigger.type === "timer") return;
    await agent.publish({ kind: 9, content: "hi" });
  });
  emit({
    events: [
      event("start", {
        tags: [
          ["h", channel],
          ["p", bot],
        ],
      }),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  const echoMessage = (await published(native, 9))[0]?.id;
  const auth = ["auth", viewer, "", "f".repeat(128)];
  // The sibling replies to Echo's message without naming it, and says "deploy",
  // which Echo's watch matches. Neither wakes Echo: two agents replying to each
  // other would otherwise never stop.
  emit({
    events: [
      event("reply", {
        pubkey: sibling,
        content: "deploy",
        tags: [["h", channel], ["e", echoMessage], auth],
      }),
    ],
  });
  await settle();
  expect(run).toHaveBeenCalledTimes(1);
  // Naming Echo wakes it, even in reply to Echo's own message.
  emit({
    events: [
      event("callback", {
        pubkey: sibling,
        tags: [["h", channel], ["e", echoMessage], ["p", bot], auth],
      }),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect(run.mock.calls[1]?.[0].trigger).toMatchObject({
    type: "mention",
    event: { pubkey: sibling },
  });
});

it("answers the owner and agents the owner attested, nobody else", async () => {
  const secret = schnorr.utils.randomSecretKey();
  const owner = bytesToHex(schnorr.getPublicKey(secret));
  const agent = bytesToHex(
    schnorr.getPublicKey(schnorr.utils.randomSecretKey()),
  );
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${agent}:`)
    .digest();
  const auth = ["auth", owner, "", bytesToHex(schnorr.sign(digest, secret))];
  const from = (pubkey: string, tags: string[][] = []) =>
    event("gate", { pubkey, tags });
  expect(await fromOwner(from(owner), owner)).toBe(true);
  expect(await fromOwner(from(agent, [auth]), owner)).toBe(true);
  expect(await fromOwner(from(agent), owner)).toBe(false);
  // Another key cannot borrow the agent's attestation, nor claim an owner.
  expect(await fromOwner(from(other, [auth]), owner)).toBe(false);
  expect(
    await fromOwner(from(agent, [["auth", owner, "", "0".repeat(128)]]), owner),
  ).toBe(false);
});

it("accepts relay workflow delegation only from this agent's owner", async () => {
  const relay = keypair();
  const workflow = { authority: relay.pubkey, agent: bot };
  const prompt = eventDto(
    signed(relay, {
      kind: 9,
      content: "@bot work",
      tags: [
        ["buzz:workflow", "true"],
        ["buzz:workflow-owner", viewer],
        ["buzz:workflow-mention", bot],
      ],
    }),
  );
  expect(await fromOwner(prompt, viewer, workflow)).toBe(true);
  expect(await fromOwner(prompt, other, workflow)).toBe(false);
  expect(await fromOwner(prompt, viewer)).toBe(false);
});

it("changes an agent's type between turns, carrying what the new type adopts", async () => {
  const { service, native, run, emit, ctx, storage } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  const attention = service.find(bot)?.attention;
  await service.save(bot, { config: { reply: "Triage." } });
  const other = vi.fn<(delivery: Delivery<{ prompt: string }>) => void>();
  ctx
    .extend({ pluginOwner: Object.freeze({ id: "other", revision: "one" }) })
    .agents.register<{ prompt: string; model: string }>({
      id: "relay",
      title: "Relay",
      defaults: () => ({ config: { prompt: "", model: "small" } }),
      adopt: (carry, saved) => ({
        ...saved,
        prompt: carry.instructions ?? saved.prompt,
      }),
      carry: ({ prompt }) => ({ instructions: prompt }),
      describeMigration: () => [
        { id: "model", label: "Model", isOverride: false },
        {
          id: "sessions",
          label: "Sessions",
          isOverride: false,
          unchangedKey: "thread",
        },
        {
          id: "equivalent",
          label: "Equivalent setting",
          isOverride: false,
          unchangedKey: "same",
        },
        { id: "destination", label: "Destination only", isOverride: false },
      ],
      run: other,
    });
  // Not while a turn, or the work it handed off, is still going.
  let finish = () => {};
  run.mockImplementationOnce(async ({ workingUntil }) =>
    workingUntil(new Promise<void>((resolve) => (finish = resolve))),
  );
  const mention = (id: string) =>
    event(id, {
      tags: [
        ["h", channel],
        ["p", bot],
      ],
    });
  emit({ events: [mention("m1")], channelId: channel });
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(service.previewRetype(bot, "other/relay")).toEqual({
    config: { prompt: "Triage.", model: "small" },
    moved: ["instructions"],
    dropped: ["workspace"],
    settings: [
      { id: "model", label: "Model", outcome: "reset" },
      { id: "thinking", label: "Thinking", outcome: "dropped" },
      { id: "sessions", label: "Sessions", outcome: "reset" },
    ],
  });
  expect(native.setType).not.toHaveBeenCalled();
  await expect(service.retype(bot, "other/relay")).rejects.toThrow(
    "Echo is answering",
  );
  expect(native.setType).not.toHaveBeenCalled();
  finish();
  await settle();
  vi.spyOn(storage, "setItem").mockImplementationOnce(() => {
    throw new Error("QuotaExceededError");
  });
  await expect(
    service.retype(bot, "other/relay", {
      config: { prompt: "Reviewed target", model: "large" },
    }),
  ).rejects.toThrow("QuotaExceededError");
  expect(native.setType.mock.calls).toEqual([
    [bot, "other/relay"],
    [bot, "example/echo"],
  ]);
  expect(service.find(bot)).toMatchObject({
    type: "example/echo",
    config: { reply: "Triage." },
  });
  native.setType.mockClear();
  native.claim.mockResolvedValueOnce(false);
  await expect(service.retype(bot, "other/relay")).rejects.toThrow(
    "device that runs it",
  );
  expect(native.setType).not.toHaveBeenCalled();
  native.claim.mockRejectedValueOnce(new Error("claim unavailable"));
  await expect(service.retype(bot, "other/relay")).rejects.toThrow(
    "claim unavailable",
  );
  expect(native.setType).not.toHaveBeenCalled();
  let continueType = () => {};
  const typeGate = new Promise<void>((resolve) => (continueType = resolve));
  const persistType = native.setType.getMockImplementation();
  native.setType.mockImplementationOnce(async (...args) => {
    await typeGate;
    return persistType?.(...args);
  });
  // The workspace has no place in the new type, so it stays behind.
  const changing = service.retype(bot, "other/relay", {
    config: { prompt: "Reviewed target", model: "large" },
  });
  await vi.waitFor(() => expect(native.setType).toHaveBeenCalledOnce());
  await expect(service.retype(bot, "other/relay")).rejects.toThrow(
    "provider is already changing",
  );
  await expect(
    service.save(bot, { config: { reply: "Lost edit" } }),
  ).rejects.toThrow("provider is already changing");
  await service.save(bot, { attentionEnabled: true });
  emit({ events: [mention("m2")], channelId: channel });
  await settle();
  expect(other).not.toHaveBeenCalled();
  expect(run).toHaveBeenCalledOnce();
  continueType();
  await expect(changing).resolves.toEqual(["workspace"]);
  expect(native.setType).toHaveBeenCalledWith(bot, "other/relay");
  expect(service.find(bot)).toMatchObject({
    type: "other/relay",
    config: { prompt: "Reviewed target", model: "large" },
    attention,
    attentionEnabled: true,
  });
  // The new type answers from now on.
  await vi.waitFor(() => expect(other).toHaveBeenCalledOnce());
  expect(other.mock.calls[0]?.[0].config).toEqual({
    prompt: "Reviewed target",
    model: "large",
  });
  expect(run).toHaveBeenCalledOnce();
  // Its own type, or one not available, changes nothing.
  expect(await service.retype(bot, "other/relay")).toEqual([]);
  await expect(service.retype(bot, "missing/type")).rejects.toThrow(
    "not available",
  );
  expect(native.setType).toHaveBeenCalledOnce();
});

it("sets and clears a picture through native, and publishes it", async () => {
  const { service, native } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  native.publishProfile.mockClear();
  const url = "https://relay.example/media/abc";
  await service.save(bot, { picture: url });
  expect(native.setPicture).toHaveBeenCalledWith(bot, url);
  expect(service.find(bot)?.picture).toBe(url);
  expect(native.publishProfile).toHaveBeenCalledWith(bot);
  // An unchanged picture is not saved again; an empty one clears it.
  await service.save(bot, { picture: url });
  expect(native.setPicture).toHaveBeenCalledOnce();
  await service.save(bot, { picture: "" });
  expect(native.setPicture).toHaveBeenLastCalledWith(bot, null);
  expect(service.find(bot)?.picture).toBeUndefined();
});

it("renames through native, and publishes profiles again on rename and reconnect", async () => {
  const { service, native, connect } = await setup();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  native.publishProfile.mockRejectedValueOnce(new Error("offline"));
  const agent = await service.create({ type: "example/echo", name: "Echo" });
  // An unpublished profile only warns; the agent exists either way.
  await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  expect(service.find(bot)).toEqual(agent);
  warn.mockRestore();
  native.publishProfile.mockClear();
  await service.save(bot, { name: " Echo Two " });
  expect(native.rename).toHaveBeenCalledWith(bot, "Echo Two");
  expect(service.find(bot)?.name).toBe("Echo Two");
  expect(native.publishProfile).toHaveBeenCalledWith(bot);
  // An unchanged name is not saved again.
  await service.save(bot, { name: "Echo Two", config: { reply: "new" } });
  expect(native.rename).toHaveBeenCalledOnce();
  connect(false);
  connect(true);
  expect(native.publishProfile).toHaveBeenCalledTimes(2);
});

it("retries a failed profile and cleanup when the live connection recovers in the same session", async () => {
  const { service, native, recover } = await setup();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  native.publishProfile.mockRejectedValueOnce(new Error("offline"));
  await service.create({ type: "example/echo", name: "Echo" });
  await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
  expect(native.publishProfile).toHaveBeenCalledTimes(1);
  recover();
  expect(native.publishProfile).toHaveBeenCalledTimes(2);
  leaveChannels.mockRejectedValueOnce(new Error("offline"));
  await service.remove(bot);
  await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
  warn.mockRestore();
  expect(native.forget).not.toHaveBeenCalled();
  recover();
  await vi.waitFor(() => expect(native.forget).toHaveBeenCalledWith(bot));
});

it("retries a cleanup that fails after the connection recovered while it ran", async () => {
  const { service, native, recover } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let fail: (error: Error) => void = () => {};
  leaveChannels.mockImplementationOnce(
    () => new Promise((_, reject) => (fail = reject)),
  );
  await service.remove(bot);
  await vi.waitFor(() => expect(leaveChannels).toHaveBeenCalledTimes(1));
  recover();
  fail(new Error("Read started before the drop"));
  await vi.waitFor(() => expect(native.forget).toHaveBeenCalledWith(bot));
  expect(leaveChannels).toHaveBeenCalledTimes(2);
  warn.mockRestore();
});

it("shows an agent whose settings could not be saved with its type's defaults", async () => {
  const storage = memoryStorage();
  const { service } = await setup({ storage });
  vi.spyOn(storage, "setItem").mockImplementationOnce(() => {
    throw new Error("QuotaExceededError");
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await service.create({ type: "example/echo", name: "Echo" });
  warn.mockRestore();
  expect(storage.getItem("buzz.agents.v1") ?? "").not.toContain(bot);
  expect(service.find(bot)).toMatchObject({ config: { reply: "ok" } });
  expect(Object.keys(service.find(bot)?.attention ?? {})).toEqual([
    "interest/default",
    "watch/channel",
  ]);
  // The next save stores them.
  await service.save(bot, { config: { reply: "saved" } });
  expect(storage.getItem("buzz.agents.v1")).toContain(bot);
});

it("saves nothing when native create fails", async () => {
  const storage = memoryStorage();
  const { service, native } = await setup({ storage });
  native.create.mockRejectedValueOnce(new Error("Credential store refused"));
  await expect(
    service.create({ type: "example/echo", name: "Echo" }),
  ).rejects.toThrow("Credential store refused");
  expect(service.snapshot().agents).toEqual([]);
  expect(storage.getItem("buzz.agents.v1")).toBeNull();
});

it("creates an agent with the config it was given, not its type's defaults, and sets its picture", async () => {
  const storage = memoryStorage();
  const { service, native } = await setup({ storage });
  const picture = "https://relay.example/media/pack.png";
  const agent = await service.create({
    type: "example/echo",
    name: " Echo ",
    picture,
    config: { reply: "chosen" },
  });
  expect(native.create).toHaveBeenCalledWith(
    "https://relay.example.test",
    viewer,
    "example/echo",
    "Echo",
  );
  expect(native.setPicture).toHaveBeenCalledExactlyOnceWith(bot, picture);
  expect(agent).toMatchObject({ pubkey: bot, name: "Echo", picture });
  expect(agent.config).toEqual({ reply: "chosen" });
  expect(service.find(bot)).toMatchObject({
    picture,
    config: { reply: "chosen" },
  });
  // Everything but the config still starts from the type's defaults.
  expect(Object.keys(service.find(bot)?.attention ?? {})).toEqual([
    "interest/default",
    "watch/channel",
  ]);
  expect(storage.getItem("buzz.agents.v1")).toContain("chosen");
});

it("keeps a new agent whose picture could not be set", async () => {
  const { service, native } = await setup();
  native.setPicture.mockRejectedValueOnce(new Error("Could not write"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const agent = await service.create({
    type: "example/echo",
    name: "Echo",
    picture: "https://relay.example/media/pack.png",
    config: { reply: "chosen" },
  });
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("picture was not saved"),
    expect.any(Error),
  );
  warn.mockRestore();
  expect(agent).toMatchObject({
    pubkey: bot,
    name: "Echo",
    config: { reply: "chosen" },
  });
  expect(service.find(bot)).toMatchObject({ config: { reply: "chosen" } });
  expect(agent.picture).toBeUndefined();
  expect(service.find(bot)?.picture).toBeUndefined();
  expect(service.snapshot().agents.map((item) => item.pubkey)).toEqual([bot]);
});

it("sets no picture and uses the type's defaults for a new agent given neither", async () => {
  const { service, native } = await setup();
  const agent = await service.create({ type: "example/echo", name: "Echo" });
  expect(native.setPicture).not.toHaveBeenCalled();
  expect(agent.config).toEqual({ reply: "ok" });
  expect(service.find(bot)).toMatchObject({ config: { reply: "ok" } });
});

it("refuses a blank name before making anything", async () => {
  const { service, native } = await setup();
  await expect(
    service.create({ type: "example/echo", name: "   " }),
  ).rejects.toThrow("Name the agent");
  expect(native.create).not.toHaveBeenCalled();
  expect(service.snapshot().agents).toEqual([]);
});

it("returns the created agent after the community changes mid-create", async () => {
  const { service, native, connect } = await setup();
  const create = native.create.getMockImplementation();
  if (!create) throw new Error("The fake creates agents");
  native.create.mockImplementationOnce(async (...input) => {
    connect(false);
    return create(...input);
  });
  const agent = await service.create({ type: "example/echo", name: "Echo" });
  expect(agent).toMatchObject({ pubkey: bot, name: "Echo" });
  expect(service.find(bot)).toBeUndefined();
});

it("forgets records whose key is gone when identities load", async () => {
  const storage = memoryStorage();
  storage.setItem(
    "buzz.agents.v1",
    JSON.stringify({
      version: 1,
      agents: {
        [bot]: { pubkey: bot, attention: {}, config: {} },
        [sibling]: { pubkey: sibling, attention: {}, config: {} },
      },
    }),
  );
  const { service } = await setup({
    storage,
    identities: [
      {
        pubkey: bot,
        relay: "wss://relay.example.test",
        owner: viewer,
        type: "example/echo",
        name: "Echo",
        deleted: false,
      },
    ],
  });
  expect(service.snapshot().agents.map((agent) => agent.name)).toEqual([
    "Echo",
  ]);
  expect(storage.getItem("buzz.agents.v1")).not.toContain(sibling);
});

it("keeps an agent created while identities are still loading", async () => {
  const storage = memoryStorage();
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const native = fakeNative();
  let release: (value: AgentIdentity[]) => void = () => {};
  native.list.mockImplementationOnce(
    () => new Promise<AgentIdentity[]>((resolve) => (release = resolve)),
  );
  const service = new AgentsService(
    ctx,
    fakeCommunities(fakeRelay()).communities,
    native,
    storage,
  );
  ctx
    .extend({ pluginOwner: Object.freeze({ id: "example", revision: "one" }) })
    .agents.register<Config>({
      id: "echo",
      title: "Echo",
      defaults: () => ({ config: { reply: "ok" } }),
    });
  await vi.waitFor(() => expect(native.list).toHaveBeenCalled());
  await service.create({ type: "example/echo", name: "Echo" });
  release([]);
  await vi.waitFor(() => expect(service.snapshot().status).toBe("ready"));
  expect(service.find(bot)?.name).toBe("Echo");
  expect(storage.getItem("buzz.agents.v1")).toContain(bot);
});

it("reads the list again on refresh and clears the error a failed read left", async () => {
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const identity = {
    pubkey: bot,
    relay: "wss://relay.example.test",
    owner: viewer,
    type: "example/echo",
    name: "Echo",
    deleted: false,
  };
  const native = fakeNative([identity]);
  native.list.mockRejectedValueOnce(
    new Error("Could not read saved agent identities"),
  );
  const service = new AgentsService(
    ctx,
    fakeCommunities(fakeRelay()).communities,
    native,
    memoryStorage(),
  );
  await vi.waitFor(() =>
    expect(service.local()).toEqual({
      status: "error",
      agents: [],
      error: "Could not read saved agent identities",
    }),
  );
  await service.refresh();
  expect(native.list).toHaveBeenCalledTimes(2);
  expect(service.local()).toEqual({
    status: "ready",
    agents: [
      {
        pubkey: bot,
        name: "Echo",
        relayUrl: "wss://relay.example.test",
        owner: viewer,
      },
    ],
  });
  expect(service.snapshot().error).toBeUndefined();
});

it("fires a due timer once, then again an interval after it ran", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const { service, run, storage } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  await service.save(bot, {
    attention: {
      "watch/tick": {
        type: "timer",
        interest_id: "default",
        prompt: "check in",
        enabled: true,
        interval_secs: 60,
        armed_at: 1_000,
        max_occurrences: 2,
        expires_at: null,
      },
      // Armed long ago with no run state: what was due counts as used, so it
      // neither fires at once nor ever (both of its runs are spent).
      "watch/stale": {
        type: "timer",
        interest_id: "default",
        prompt: "stale",
        enabled: true,
        interval_secs: 60,
        armed_at: 0,
        max_occurrences: 2,
        expires_at: null,
      },
    },
  });
  await vi.advanceTimersByTimeAsync(55_000);
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]?.[0].trigger).toMatchObject({
    type: "timer",
    slug: "watch/tick",
    interest: { instructions: "Be brief." },
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(run).toHaveBeenCalledTimes(2);
  // The last allowed occurrence says so, as Janet's final wake does.
  expect(run.mock.calls.map(([{ trigger }]) => trigger)).toMatchObject([
    { spent: false },
    { spent: true },
  ]);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(run).toHaveBeenCalledTimes(2);
  // Its run state lives in the agent's record and goes when the timer does.
  const stored = () =>
    JSON.parse(storage.getItem("buzz.agents.v1") ?? "{}").agents[bot];
  expect(stored().timers["watch/tick"]).toMatchObject({ used: 2 });
  expect(stored().timers["watch/stale"]).toMatchObject({ used: 16 });
  await service.save(bot, { attention: { "watch/tick": null } });
  expect(Object.keys(stored().timers)).toEqual(["watch/stale"]);
});

it("keeps at most one occurrence of a timer waiting, and never runs one removed meanwhile", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const { service, run } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  const timer = (prompt: string) =>
    ({
      type: "timer",
      interest_id: "default",
      prompt,
      enabled: true,
      interval_secs: 1,
      armed_at: 1_000,
      max_occurrences: null,
      expires_at: null,
    }) as const;
  await service.save(bot, {
    attention: { "watch/kept": timer("kept"), "watch/removed": timer("gone") },
  });
  let release: () => void = () => {};
  run.mockImplementationOnce(
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  // The first run holds the runner across many intervals of both timers.
  await vi.advanceTimersByTimeAsync(5_000);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000);
  await service.save(bot, { attention: { "watch/removed": null } });
  release();
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  await vi.advanceTimersByTimeAsync(0);
  const slugs = run.mock.calls.map(([{ trigger }]) =>
    trigger.type === "timer" ? trigger.slug : trigger.type,
  );
  expect(slugs).toEqual(["watch/kept", "watch/kept"]);
});

it("gives each due timer a turn when one's runs outlast its interval", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const { service, run } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  const timer = (prompt: string) =>
    ({
      type: "timer",
      interest_id: "default",
      prompt,
      enabled: true,
      interval_secs: 1,
      armed_at: 1_000,
      max_occurrences: null,
      expires_at: null,
    }) as const;
  await service.save(bot, {
    attention: { "watch/slow": timer("slow"), "watch/other": timer("other") },
  });
  // Every run takes three intervals, so the first timer is always due again.
  run.mockImplementation(
    () => new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  );
  await vi.advanceTimersByTimeAsync(20_000);
  const slugs = run.mock.calls.map(([{ trigger }]) =>
    trigger.type === "timer" ? trigger.slug : trigger.type,
  );
  expect(slugs.slice(0, 4)).toEqual([
    "watch/slow",
    "watch/other",
    "watch/slow",
    "watch/other",
  ]);
});

it("runs waiting events before a due timer, so a busy timer cannot starve them", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  await service.save(bot, {
    attention: {
      "watch/tick": {
        type: "timer",
        interest_id: "default",
        prompt: "tick",
        enabled: true,
        interval_secs: 1,
        armed_at: 1_000,
        max_occurrences: null,
        expires_at: null,
      },
    },
  });
  let release: () => void = () => {};
  run.mockImplementationOnce(
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  await vi.advanceTimersByTimeAsync(5_000);
  emit({ events: [event("m", { tags: [["p", bot]] })] });
  await vi.advanceTimersByTimeAsync(5_000);
  release();
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
  expect(run.mock.calls.map(([{ trigger }]) => trigger.type)).toEqual([
    "timer",
    "mention",
    "timer",
  ]);
});

it("deletes the key at once, then leaves its channels and archives it before forgetting it", async () => {
  const { service, native, storage, archives } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.remove(bot);
  expect(service.snapshot().agents).toEqual([]);
  expect(storage.getItem("buzz.agents.v1")).not.toContain(bot);
  await vi.waitFor(() =>
    expect(steps).toEqual(["key", "channels", "archive", "record", "forget"]),
  );
  expect(leaveChannels).toHaveBeenCalledWith(
    expect.objectContaining({ archives }),
    bot,
    expect.any(AbortSignal),
  );
  expect(archives.request).toHaveBeenCalledWith(
    "archive",
    bot,
    expect.any(AbortSignal),
  );
  expect(await native.list()).toEqual([]);
});

it("retries a failed cleanup on the next connect, without archiving twice", async () => {
  const { service, native, archives, connect } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  leaveChannels.mockRejectedValueOnce(new Error("Channel removal refused"));
  await service.remove(bot);
  await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
  archives.request.mockRejectedValueOnce(new Error("Archive refused"));
  connect(true);
  await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
  warn.mockRestore();
  expect(native.forget).not.toHaveBeenCalled();
  archives.request.mockClear();
  archives.archived.add(bot);
  connect(true);
  await vi.waitFor(() => expect(native.forget).toHaveBeenCalledWith(bot));
  expect(archives.request).not.toHaveBeenCalled();
});

it("forgets an agent with no owner-attested profile without archiving it", async () => {
  const { service, native, archives } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  archives.consent.mockResolvedValueOnce(null);
  await service.remove(bot);
  await vi.waitFor(() => expect(native.forget).toHaveBeenCalledWith(bot));
  expect(archives.request).not.toHaveBeenCalled();
});

it("deletes outside the agent's community, and cleans up once it is open", async () => {
  const { service, native, connect } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  connect(false);
  await service.remove(bot);
  expect(native.remove).toHaveBeenCalledWith(bot);
  await settle();
  expect(leaveChannels).not.toHaveBeenCalled();
  connect(true);
  await vi.waitFor(() => expect(native.forget).toHaveBeenCalledWith(bot));
});

it("keeps the cleanup for later when the session closes while archive state is read", async () => {
  const { service, native, archives, connect } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  archives.refresh.mockImplementationOnce(async () => {
    // A closed session's read ends without an answer.
    archives.unknown = true;
    connect(false);
  });
  await service.remove(bot);
  await vi.waitFor(() => expect(archives.refresh).toHaveBeenCalled());
  await settle();
  expect(native.forget).not.toHaveBeenCalled();
  expect(await native.list()).toMatchObject([{ pubkey: bot, deleted: true }]);
  archives.unknown = false;
  connect(true);
  await vi.waitFor(() => expect(native.forget).toHaveBeenCalledWith(bot));
  expect(archives.request).toHaveBeenCalledOnce();
});

it("runs once per matching watch, and passes a classifier watch it cannot classify", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  await service.save(bot, {
    attention: {
      "watch/classified": {
        type: "event",
        interest_id: "missing",
        enabled: true,
        since: 1,
        channels: "all",
        kinds: [],
        classifier: {
          questions: {
            deploy: {
              question: "Is it about a deploy?",
              true: "It is",
              false: "It is not",
              threshold: 0.5,
            },
          },
        },
      },
    },
  });
  emit({ events: [event("w", { content: "deploy" })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  const triggers = run.mock.calls.map(([delivery]) => delivery.trigger);
  expect(triggers).toEqual([
    expect.objectContaining({ slug: "watch/channel" }),
    expect.objectContaining({
      slug: "watch/classified",
      classifier: { outcome: "not-run", reason: expect.any(String) },
    }),
  ]);
  // Its Interest does not exist, so it arrives without instructions.
  expect(triggers[1]).not.toHaveProperty("interest");
});

it("keeps DMs and reactions to its own messages away from watches", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  await service.save(bot, {
    attention: {
      "watch/everything": {
        type: "event",
        interest_id: "default",
        enabled: true,
        since: 1,
        channels: "all",
        kinds: [],
      },
    },
  });
  run.mockImplementationOnce(async ({ agent }) => {
    await agent.publish({ kind: 9, content: "hi", tags: [["h", channel]] });
  });
  emit({ events: [event("m", { tags: [["p", bot]] })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  emit({
    events: [
      event("dm", { kind: 4, tags: [["p", bot]] }),
      // p1 is what the run above published.
      event("like", { kind: 7, tags: [["e", "p1".padEnd(64, "0")]] }),
      event("note", { kind: 1 }),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  await settle();
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1]?.[0].trigger).toMatchObject({
    type: "watch",
    slug: "watch/everything",
    event: { id: "note".padEnd(64, "0") },
  });
});

it("wakes a watch only for channels the agent is in, even when it watches all", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  await service.save(bot, {
    attention: {
      "watch/everything": {
        type: "event",
        interest_id: "default",
        enabled: true,
        since: 1,
        channels: "all",
        kinds: [],
      },
    },
  });
  emit({
    events: [
      // The owner's own channel, one whose roster is unknown, and no channel.
      event("secret", { tags: [["h", "private"]] }),
      event("unknown", { tags: [["h", "elsewhere"]] }),
      event("bare", { kind: 1, tags: [] }),
      event("open"),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  await settle();
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]?.[0].trigger).toMatchObject({
    slug: "watch/everything",
    event: { id: "open".padEnd(64, "0") },
  });
});

it("keeps a new agent's attention off until its owner turns it on", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  expect(service.find(bot)?.attentionEnabled).toBe(false);
  // Its type's default watch matches, but wakes nothing while off.
  emit({ events: [event("one", { content: "deploy" })] });
  await settle();
  await settle();
  expect(run).not.toHaveBeenCalled();
  await service.save(bot, { attentionEnabled: true });
  expect(service.find(bot)?.attentionEnabled).toBe(true);
  emit({ events: [event("two", { content: "deploy" })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(run.mock.calls[0]?.[0].trigger).toMatchObject({
    type: "watch",
    event: { id: "two".padEnd(64, "0") },
  });
});

it("drops a queued watch run whose watch was disabled, or whose attention went off, before it ran", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  let release = () => {};
  run.mockImplementationOnce(
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  emit({
    events: [
      event("one", { content: "deploy" }),
      event("two", { content: "deploy" }),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  const watch = service.find(bot)?.attention["watch/channel"]?.value;
  await service.save(bot, {
    attention: { "watch/channel": { ...watch, enabled: false } as never },
  });
  release();
  await settle();
  expect(run).toHaveBeenCalledTimes(1);
  // Back on: a run queued before attention went off does not run either.
  await service.save(bot, {
    attention: { "watch/channel": { ...watch, enabled: true } as never },
  });
  run.mockImplementationOnce(
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  emit({
    events: [
      event("three", { content: "deploy" }),
      event("four", { content: "deploy" }),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  await service.save(bot, { attentionEnabled: false });
  release();
  await settle();
  expect(run).toHaveBeenCalledTimes(2);
});

it("drops a queued watch run when attention goes off and on, or its watch is replaced, before it ran", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  const watch = service.find(bot)?.attention["watch/channel"]?.value;
  let release = () => {};
  const hold = () =>
    run.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
  hold();
  emit({
    events: [
      event("one", { content: "deploy" }),
      event("two", { content: "deploy" }),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  await service.save(bot, { attentionEnabled: false });
  await service.save(bot, { attentionEnabled: true });
  release();
  await settle();
  expect(run).toHaveBeenCalledTimes(1);
  // A replacement that still matches is a new watch: the old one's work goes.
  hold();
  emit({
    events: [
      event("three", { content: "deploy" }),
      event("four", { content: "deploy" }),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  await service.save(bot, {
    attention: {
      "watch/channel": { ...watch, name: "Replaced" } as never,
    },
  });
  release();
  await settle();
  expect(run).toHaveBeenCalledTimes(2);
  // New events still wake the replacement.
  emit({ events: [event("five", { content: "deploy" })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
});

it("tells a run whose type queued its work whether that work is still current", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  const watch = service.find(bot)?.attention["watch/channel"]?.value;
  emit({ events: [event("one", { content: "deploy" })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  const first = run.mock.calls[0]?.[0] as Delivery;
  // The run returned, as a type that queues its own work does.
  await settle();
  expect(first.current()).toBe(true);
  // An earlier turn tightened the watch: its event no longer matches.
  await service.save(bot, {
    attention: {
      "watch/channel": { ...watch, filter: 'content == "ship"' } as never,
    },
  });
  expect(first.current()).toBe(false);
  await service.save(bot, {
    attention: { "watch/channel": watch as never },
  });
  emit({ events: [event("two", { content: "deploy" })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  const second = run.mock.calls[1]?.[0] as Delivery;
  await settle();
  expect(second.current()).toBe(true);
  await service.save(bot, { attentionEnabled: false });
  expect(second.current()).toBe(false);
});

it("voids a handed-off timer occurrence once attention or the timer is reset", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const { service, run } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  const timer = {
    type: "timer",
    interest_id: "default",
    prompt: "tick",
    enabled: true,
    interval_secs: 60,
    armed_at: 1_000,
    max_occurrences: null,
    expires_at: null,
  } as const;
  await service.save(bot, {
    attention: { "watch/channel": null, "watch/tick": timer },
  });
  await vi.advanceTimersByTimeAsync(65_000);
  expect(run).toHaveBeenCalledTimes(1);
  // The run returned, as a type that hands the turn to its own queue does.
  const first = run.mock.calls[0]?.[0] as Delivery;
  expect(first.current()).toBe(true);
  // Turned off and on again while the turn waits for a process.
  await service.save(bot, { attentionEnabled: false });
  await service.save(bot, { attentionEnabled: true });
  expect(first.current()).toBe(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(run).toHaveBeenCalledTimes(2);
  const second = run.mock.calls[1]?.[0] as Delivery;
  expect(second.current()).toBe(true);
  // Disabled and rearmed while it waits: the old occurrence stays void.
  await service.save(bot, {
    attention: { "watch/tick": { ...timer, enabled: false } },
  });
  await service.save(bot, {
    attention: { "watch/tick": { ...timer, armed_at: 1_100 } },
  });
  expect(second.current()).toBe(false);
});

it("runs a spent timer again when its owner restarts it", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const { service, run } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  const once = {
    type: "timer",
    interest_id: "default",
    prompt: "once",
    enabled: true,
    interval_secs: 60,
    armed_at: 1_000,
    max_occurrences: 1,
    expires_at: null,
  } as const;
  await service.save(bot, { attention: { "watch/once": once } });
  await vi.advanceTimersByTimeAsync(65_000);
  expect(run).toHaveBeenCalledTimes(1);
  expect(service.find(bot)?.timers["watch/once"]).toMatchObject({ used: 1 });
  // Rearming alone keeps the spent budget; a restart grants a fresh one.
  await service.save(bot, {
    attention: { "watch/once": { ...once, armed_at: 1_065 } },
  });
  await vi.advanceTimersByTimeAsync(65_000);
  expect(run).toHaveBeenCalledTimes(1);
  await service.save(bot, {
    attention: { "watch/once": { ...once, armed_at: 1_130 } },
    restart: ["watch/once"],
  });
  await vi.advanceTimersByTimeAsync(65_000);
  expect(run).toHaveBeenCalledTimes(2);
});

it("keeps an Interest while a watch still uses it", async () => {
  const { service } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await expect(
    service.save(bot, { attention: { "interest/default": null } }),
  ).rejects.toThrow(/use this Interest/);
  expect(service.find(bot)?.attention).toHaveProperty("interest/default");
  await service.save(bot, {
    attention: { "watch/channel": null, "interest/default": null },
  });
  expect(service.find(bot)?.attention).toEqual({});
});

const record = (pubkey: string, patch: Partial<RelayEvent> = {}) =>
  event(`r${pubkey.slice(0, 4)}`, {
    pubkey: viewer,
    kind: 30177,
    content: JSON.stringify({ name: "Far" }),
    tags: [
      ["d", pubkey],
      ["runtime", "example/echo"],
    ],
    ...patch,
  });
const hostedKey = "e".repeat(64);
function cloud() {
  const remote = {
    provision: vi.fn(async (_: { name: string; community: string }) => ({
      pubkey: hostedKey,
    })),
    activate: vi.fn(
      async (_: { pubkey: string; auth: readonly string[] }) => {},
    ),
    profile: vi.fn(async (_: { name: string; picture?: string }) => {}),
    remove: vi.fn(async (_: { pubkey: string }) => void steps.push("provider")),
  };
  const type: AgentType = {
    id: "cloud",
    title: "Cloud",
    defaults: () => ({ config: {} }),
    remote,
  };
  return { type, remote };
}

it("lists each agent here in the owner's agent records, with its type as the runtime", async () => {
  const { service, session } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await vi.waitFor(() =>
    expect(records.publish).toHaveBeenCalledWith(
      session,
      { pubkey: bot, name: "Echo", runtime: "example/echo" },
      expect.any(AbortSignal),
    ),
  );
  // Listed once: later syncs see the record it wrote.
  await service.save(bot, { config: { reply: "hi" } });
  await settle();
  expect(records.publish).toHaveBeenCalledTimes(1);
  // A rename replaces it.
  await service.save(bot, { name: "Echo Two" });
  await vi.waitFor(() =>
    expect(records.publish).toHaveBeenLastCalledWith(
      session,
      { pubkey: bot, name: "Echo Two", runtime: "example/echo" },
      expect.any(AbortSignal),
    ),
  );
});

it("leaves an agent already listed under its name and type as it is", async () => {
  const identity = {
    pubkey: bot,
    relay: "wss://relay.example.test",
    owner: viewer,
    type: "example/echo",
    name: "Echo",
    deleted: false,
  };
  const { service } = await setup({
    identities: [identity],
    listed: [record(bot, { content: JSON.stringify({ name: "Echo" }) })],
  });
  await vi.waitFor(() => expect(service.find(bot)?.place).toBe("here"));
  await settle();
  expect(records.publish).not.toHaveBeenCalled();
  expect(service.snapshot().agents).toHaveLength(1);
});

it("shows the owner's agents on other devices without running them, and leaves earlier systems' records alone", async () => {
  const { service, emit, run, native } = await setup({
    listed: [
      record(sibling),
      record(other, { tags: [["d", other]], content: '{"name":"Old"}' }),
    ],
  });
  await vi.waitFor(() =>
    expect(service.find(sibling)).toMatchObject({
      name: "Far",
      type: "example/echo",
      place: "elsewhere",
      relay: "wss://relay.example.test",
      attention: {},
    }),
  );
  expect(service.find(other)).toBeUndefined();
  emit({
    events: [
      event("hey", {
        pubkey: viewer,
        tags: [
          ["h", channel],
          ["p", sibling],
        ],
      }),
    ],
  });
  await settle();
  expect(run).not.toHaveBeenCalled();
  expect(native.claim).not.toHaveBeenCalledWith(sibling);
  await expect(service.remove(sibling)).rejects.toThrow(/device that runs it/);
  await expect(service.save(sibling, { name: "Near" })).rejects.toThrow();
});

it("creates a hosted agent through its provider, attesting the key it returns", async () => {
  const { service, plugin, session, authorize, native, storage } =
    await setup();
  const { type, remote } = cloud();
  plugin.agents.register(type);
  const agent = await service.create({ type: "example/cloud", name: " Sky " });
  expect(remote.provision).toHaveBeenCalledWith({
    name: "Sky",
    community: "wss://relay.example.test",
    signal: expect.any(AbortSignal),
  });
  expect(authorize).toHaveBeenCalledWith(hostedKey, expect.any(AbortSignal));
  expect(remote.activate).toHaveBeenCalledWith({
    pubkey: hostedKey,
    name: "Sky",
    community: "wss://relay.example.test",
    auth: ["auth", viewer, "", "f".repeat(128)],
    signal: expect.any(AbortSignal),
  });
  expect(records.publish).toHaveBeenCalledWith(
    session,
    { pubkey: hostedKey, name: "Sky", runtime: "example/cloud" },
    expect.any(AbortSignal),
  );
  expect(agent).toMatchObject({ pubkey: hostedKey, place: "hosted" });
  expect(agent.unfinished).toBeUndefined();
  expect(native.create).not.toHaveBeenCalled();
  expect(native.claim).not.toHaveBeenCalledWith(hostedKey);
  expect(storage.getItem("buzz.agents.unfinished.v1")).toContain('"agents":[]');
});

it("keeps a hosted agent whose setup failed, and finishes it without making another", async () => {
  const storage = memoryStorage();
  const { service, plugin } = await setup({ storage });
  const { type, remote } = cloud();
  plugin.agents.register(type);
  remote.activate.mockRejectedValueOnce(new Error("provider down"));
  await expect(
    service.create({ type: "example/cloud", name: "Sky" }),
  ).rejects.toThrow("provider down");
  expect(service.find(hostedKey)).toMatchObject({
    place: "hosted",
    unfinished: true,
    name: "Sky",
  });
  expect(records.publish).not.toHaveBeenCalled();
  await expect(service.save(hostedKey, { name: "Sea" })).rejects.toThrow(
    /Finish the agent's setup/,
  );
  // A restart keeps it.
  const again = await setup({ storage });
  again.plugin.agents.register(cloud().type);
  await vi.waitFor(() =>
    expect(again.service.find(hostedKey)?.unfinished).toBe(true),
  );
  const agent = await service.finish(hostedKey);
  expect(remote.provision).toHaveBeenCalledTimes(1);
  expect(remote.activate).toHaveBeenCalledTimes(2);
  expect(agent.unfinished).toBeUndefined();
  expect(records.publish).toHaveBeenCalledTimes(1);
  expect(storage.getItem("buzz.agents.unfinished.v1")).not.toContain(hostedKey);
});

it("lists a hosted agent with the picture it was made with when its provider cannot publish it", async () => {
  const { service, plugin, session } = await setup();
  const { type, remote } = cloud();
  plugin.agents.register(type);
  remote.profile.mockRejectedValueOnce(new Error("not supported"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const picture = "https://example.test/sky.png";
  const agent = await service.create({
    type: "example/cloud",
    name: "Sky",
    picture,
  });
  expect(records.publish).toHaveBeenCalledExactlyOnceWith(
    session,
    { pubkey: hostedKey, name: "Sky", picture, runtime: "example/cloud" },
    expect.any(AbortSignal),
  );
  expect(remote.profile).toHaveBeenCalledWith({
    pubkey: hostedKey,
    community: "wss://relay.example.test",
    name: "Sky",
    picture,
    signal: expect.any(AbortSignal),
  });
  expect(agent).toMatchObject({ pubkey: hostedKey, place: "hosted", picture });
  expect(service.find(hostedKey)?.picture).toBe(picture);
  expect(remote.provision).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    "Agent Sky picture was not published",
    expect.any(Error),
  );
  warn.mockRestore();
});

it("keeps a hosted agent's picture through a setup that failed, and lists it once finished", async () => {
  const storage = memoryStorage();
  const { service, plugin, session } = await setup({ storage });
  const { type, remote } = cloud();
  plugin.agents.register(type);
  remote.activate.mockRejectedValueOnce(new Error("provider down"));
  const picture = "https://example.test/sky.png";
  await expect(
    service.create({ type: "example/cloud", name: "Sky", picture }),
  ).rejects.toThrow("provider down");
  expect(service.find(hostedKey)).toMatchObject({ unfinished: true, picture });
  expect(remote.profile).not.toHaveBeenCalled();
  // A restart keeps it.
  const again = await setup({ storage });
  again.plugin.agents.register(cloud().type);
  await vi.waitFor(() =>
    expect(again.service.find(hostedKey)).toMatchObject({
      unfinished: true,
      picture,
    }),
  );
  const agent = await service.finish(hostedKey);
  expect(agent).toMatchObject({ picture });
  expect(agent.unfinished).toBeUndefined();
  expect(records.publish).toHaveBeenCalledExactlyOnceWith(
    session,
    { pubkey: hostedKey, name: "Sky", picture, runtime: "example/cloud" },
    expect.any(AbortSignal),
  );
});

it("makes a hosted agent without a picture that is not an HTTPS image URL", async () => {
  const { service, plugin } = await setup();
  const { type, remote } = cloud();
  plugin.agents.register(type);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const agent = await service.create({
    type: "example/cloud",
    name: "Sky",
    picture: "data:image/png;base64,AAAA",
  });
  expect(agent.picture).toBeUndefined();
  expect(remote.profile).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(
    "Agent Sky picture is not an HTTPS image URL",
  );
  warn.mockRestore();
});

it("renames a hosted agent through its provider and relists it; its settings are the provider's", async () => {
  const { service, plugin, session } = await setup();
  const { type, remote } = cloud();
  plugin.agents.register(type);
  await service.create({ type: "example/cloud", name: "Sky" });
  await service.save(hostedKey, {
    name: "Sea",
    picture: "https://example.test/sea.png",
  });
  expect(remote.profile).toHaveBeenCalledWith({
    pubkey: hostedKey,
    community: "wss://relay.example.test",
    name: "Sea",
    picture: "https://example.test/sea.png",
    signal: expect.any(AbortSignal),
  });
  expect(records.publish).toHaveBeenLastCalledWith(
    session,
    {
      pubkey: hostedKey,
      name: "Sea",
      picture: "https://example.test/sea.png",
      runtime: "example/cloud",
    },
    expect.any(AbortSignal),
  );
  expect(service.find(hostedKey)).toMatchObject({
    name: "Sea",
    picture: "https://example.test/sea.png",
  });
  await expect(service.save(hostedKey, { config: {} })).rejects.toThrow(
    /through its provider/,
  );
});

it("deletes a hosted agent from its provider, then from its community", async () => {
  const { service, plugin, session } = await setup();
  const { type, remote } = cloud();
  plugin.agents.register(type);
  await service.create({ type: "example/cloud", name: "Sky" });
  // A provider that fails leaves it listed, to delete again.
  remote.remove.mockRejectedValueOnce(new Error("provider down"));
  await expect(service.remove(hostedKey)).rejects.toThrow("provider down");
  expect(records.removeAgent).not.toHaveBeenCalled();
  expect(service.find(hostedKey)?.place).toBe("hosted");
  await service.remove(hostedKey);
  expect(records.removeAgent).toHaveBeenCalledWith(
    session,
    viewer,
    hostedKey,
    expect.any(AbortSignal),
  );
  expect(steps).toEqual(["provider", "leave"]);
  expect(remote.remove).toHaveBeenCalledWith({
    pubkey: hostedKey,
    community: "wss://relay.example.test",
    signal: expect.any(AbortSignal),
  });
  expect(service.find(hostedKey)).toBeUndefined();
});

it("deletes an unfinished hosted agent from its community too, as its profile may be out", async () => {
  const { service, plugin } = await setup();
  const { type, remote } = cloud();
  plugin.agents.register(type);
  remote.activate.mockRejectedValueOnce(new Error("provider down"));
  await expect(
    service.create({ type: "example/cloud", name: "Sky" }),
  ).rejects.toThrow();
  await service.remove(hostedKey);
  expect(steps).toEqual(["provider", "leave"]);
  expect(service.find(hostedKey)).toBeUndefined();
});

it("refuses to finish a hosted agent's setup while it is being deleted", async () => {
  const { service, plugin } = await setup();
  const { type, remote } = cloud();
  plugin.agents.register(type);
  remote.activate.mockRejectedValueOnce(new Error("provider down"));
  await expect(
    service.create({ type: "example/cloud", name: "Sky" }),
  ).rejects.toThrow();
  let release = () => {};
  remote.remove.mockImplementationOnce(
    () =>
      new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      }),
  );
  const removing = service.remove(hostedKey);
  await expect(service.finish(hostedKey)).rejects.toThrow(/Wait for/);
  release();
  await removing;
  expect(remote.activate).toHaveBeenCalledTimes(1);
});

it("keeps an earlier system's settings when it lists an agent here under that record", async () => {
  const identity = {
    pubkey: bot,
    relay: "wss://relay.example.test",
    owner: viewer,
    type: "example/echo",
    name: "Echo",
    deleted: false,
  };
  const content = { name: "Old", parallelism: 2, respond_to: "anyone" };
  const tags = [
    ["d", bot],
    ["a", "30175:x:y"],
  ];
  const { service, session } = await setup({
    identities: [identity],
    listed: [record(bot, { tags, content: JSON.stringify(content) })],
  });
  await vi.waitFor(() =>
    expect(records.publish).toHaveBeenCalledWith(
      session,
      {
        pubkey: bot,
        name: "Echo",
        runtime: "example/echo",
        prior: { content, tags },
      },
      expect.any(AbortSignal),
    ),
  );
  expect(service.snapshot().agents).toHaveLength(1);
});

it("keeps what it lists while the community's records are read, and reads again after a failure", async () => {
  const { service, plugin, session, connect } = await setup();
  const { type } = cloud();
  plugin.agents.register(type);
  const read = vi.mocked(session.read);
  read.mockRejectedValueOnce(new Error("offline"));
  connect(false);
  connect(true);
  await settle();
  // The failed read lists nothing, and a sync reads again, held this time.
  let respond = (_: RelayEvent[]) => {};
  read.mockImplementationOnce(
    () =>
      new Promise<RelayEvent[]>((resolve) => {
        respond = resolve;
      }) as never,
  );
  await service.create({ type: "example/echo", name: "Echo" });
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  // Made meanwhile, it shows at once and stays once the read returns.
  await service.create({ type: "example/cloud", name: "Sky" });
  expect(service.find(hostedKey)).toMatchObject({ place: "hosted" });
  respond([]);
  await settle();
  expect(service.find(hostedKey)).toMatchObject({ place: "hosted" });
  // Then the agent here is listed too.
  await vi.waitFor(() =>
    expect(records.publish).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ pubkey: bot }),
      expect.any(AbortSignal),
    ),
  );
});

it("lists only an HTTPS picture of a hosted agent", async () => {
  const { service, plugin } = await setup();
  const { type, remote } = cloud();
  plugin.agents.register(type);
  await service.create({ type: "example/cloud", name: "Sky" });
  await expect(
    service.save(hostedKey, { picture: "data:image/png;base64,AAAA" }),
  ).rejects.toThrow(/HTTPS image URL/);
  expect(remote.profile).not.toHaveBeenCalled();
});

it("refuses a hosted type that also runs here", async () => {
  const { plugin } = await setup();
  const { type } = cloud();
  expect(() => plugin.agents.register({ ...type, run: () => {} })).toThrow(
    /hosted agent type/,
  );
});

it("brings over no identity as a hosted type, whose key stays with its provider", async () => {
  const { service, plugin, native } = await setup();
  plugin.agents.register(cloud().type);
  await expect(
    service.port({
      source: "installed",
      pubkey: sibling,
      type: "example/cloud",
    }),
  ).rejects.toThrow(/stays with its provider/);
  expect(native.port).not.toHaveBeenCalled();
});

it("refuses a key from the provider that the owner already lists", async () => {
  const { service, plugin } = await setup({ listed: [record(sibling)] });
  const { type, remote } = cloud();
  plugin.agents.register(type);
  await vi.waitFor(() =>
    expect(service.find(sibling)?.place).toBe("elsewhere"),
  );
  remote.provision.mockResolvedValueOnce({ pubkey: sibling });
  await expect(
    service.create({ type: "example/cloud", name: "Sky" }),
  ).rejects.toThrow(/already in use/);
  expect(remote.activate).not.toHaveBeenCalled();
  expect(service.find(sibling)).toMatchObject({
    name: "Far",
    place: "elsewhere",
  });
});

it("lists a rename made while the agent's earlier record was being written", async () => {
  const { service, session } = await setup();
  let release = () => {};
  records.publish.mockImplementationOnce(
    () =>
      new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      }) as never,
  );
  await service.create({ type: "example/echo", name: "Echo" });
  await vi.waitFor(() => expect(records.publish).toHaveBeenCalledTimes(1));
  await service.save(bot, { name: "Echo Two" });
  await settle();
  expect(records.publish).toHaveBeenCalledTimes(1);
  release();
  await vi.waitFor(() =>
    expect(records.publish).toHaveBeenLastCalledWith(
      session,
      expect.objectContaining({ pubkey: bot, name: "Echo Two" }),
      expect.any(AbortSignal),
    ),
  );
  await settle();
  expect(records.publish).toHaveBeenCalledTimes(2);
});

it("refuses to delete a hosted agent while its new name is being saved", async () => {
  const { service, plugin } = await setup();
  const { type, remote } = cloud();
  plugin.agents.register(type);
  await service.create({ type: "example/cloud", name: "Sky" });
  let release = () => {};
  remote.profile.mockImplementationOnce(
    () =>
      new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      }),
  );
  const saving = service.save(hostedKey, { name: "Sea" });
  await vi.waitFor(() => expect(remote.profile).toHaveBeenCalled());
  await expect(service.remove(hostedKey)).rejects.toThrow(/Wait for/);
  release();
  await saving;
  expect(remote.remove).not.toHaveBeenCalled();
  expect(service.find(hostedKey)).toMatchObject({ name: "Sea" });
});

it("keeps what it lists when the community's records cannot be read", async () => {
  const { service, plugin, session, connect } = await setup();
  plugin.agents.register(cloud().type);
  const read = vi.mocked(session.read);
  read.mockRejectedValueOnce(new Error("offline"));
  connect(false);
  connect(true);
  await settle();
  // Set up after the read failed, it is listed and shown.
  const agent = await service.create({ type: "example/cloud", name: "Sky" });
  expect(agent).toMatchObject({ pubkey: hostedKey, place: "hosted" });
  // Renamed while a read is under way that then fails, it keeps the new name.
  let fail = () => {};
  read.mockImplementationOnce(
    () =>
      new Promise<RelayEvent[]>((_, reject) => {
        fail = () => reject(new Error("offline"));
      }) as never,
  );
  const reads = read.mock.calls.length;
  await service.create({ type: "example/echo", name: "Echo" });
  await vi.waitFor(() => expect(read.mock.calls.length).toBe(reads + 1));
  await service.save(hostedKey, { name: "Sea" });
  fail();
  await settle();
  expect(service.find(hostedKey)).toMatchObject({
    name: "Sea",
    place: "hosted",
  });
  // The next read that succeeds keeps it too.
  await service.save(bot, { name: "Echo Two" });
  await vi.waitFor(() => expect(read.mock.calls.length).toBe(reads + 2));
  await settle();
  expect(service.find(hostedKey)).toMatchObject({
    name: "Sea",
    place: "hosted",
  });
});

it("projects accepted queued work and keeps working past handover until the plugin's actual result", async () => {
  const f = await setup();
  await f.service.create({ type: "example/echo", name: "Echo" });
  let releaseHandover!: () => void;
  let finish!: (outcome: WorkOutcome) => void;
  const done = new Promise<WorkOutcome>((resolve) => {
    finish = resolve;
  });
  f.run.mockImplementationOnce((delivery) => {
    delivery.workingUntil?.(done);
    return new Promise<void>((resolve) => {
      releaseHandover = resolve;
    });
  });
  const first = event("1", {
    tags: [
      ["h", channel],
      ["p", bot],
    ],
  });
  const second = event("2", {
    tags: [
      ["h", channel],
      ["p", bot],
    ],
  });
  f.emit({ events: [first, second], channelId: channel });
  try {
    await vi.waitFor(() =>
      expect(f.activity.reader.work().map((row) => row.state)).toEqual([
        "working",
        "waiting",
      ]),
    );
    expect(f.activity.reader.work()[0]).toMatchObject({
      agent: bot,
      messageId: first.id,
      threadRootId: first.id,
      channelId: channel,
    });
    releaseHandover();
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(f.activity.reader.work().map((row) => row.state)).toEqual([
        "working",
        "done",
      ]),
    );
    finish({ ok: false, error: "Provider unavailable" });
    await vi.waitFor(() =>
      expect(f.activity.reader.work()[0]).toMatchObject({
        state: "error",
        error: "Provider unavailable",
      }),
    );
  } finally {
    releaseHandover?.();
    finish({ ok: true });
    await f.ctx.fiber.dispose();
  }
});

it("keeps a handed-off request and its original scope through reconnect, without reviving it from old callbacks", async () => {
  const f = await setup();
  await f.service.create({ type: "example/echo", name: "Echo" });
  let finish!: (result: WorkOutcome) => void;
  const done = new Promise<WorkOutcome>((resolve) => {
    finish = resolve;
  });
  f.run.mockImplementationOnce((delivery) => delivery.workingUntil?.(done));
  f.emit({
    events: [
      event("1", {
        tags: [
          ["h", channel],
          ["p", bot],
        ],
      }),
    ],
  });
  try {
    await vi.waitFor(() =>
      expect(f.activity.reader.work()[0]?.state).toBe("working"),
    );
    const scope = f.activity.reader.work()[0]?.scope;
    f.reconnecting();
    f.connect(true);
    expect(f.activity.reader.work()[0]).toMatchObject({
      state: "working",
      scope,
    });
    finish({ ok: true });
    await vi.waitFor(() =>
      expect(f.activity.reader.work()[0]?.state).toBe("done"),
    );
    expect(f.run).toHaveBeenCalledTimes(1);
  } finally {
    finish({ ok: true });
    await f.ctx.fiber.dispose();
  }
});

it("does not label still-running work failed when only its handover deadline expires", async () => {
  const f = await setup({ timeoutMs: 100 });
  await f.service.create({ type: "example/echo", name: "Echo" });
  let release!: () => void;
  let expired!: () => void;
  const deadline = new Promise<void>((resolve) => {
    expired = resolve;
  });
  f.run.mockImplementationOnce((delivery) => {
    delivery.signal.addEventListener("abort", expired, { once: true });
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  f.emit({
    events: [
      event("1", {
        tags: [
          ["h", channel],
          ["p", bot],
        ],
      }),
    ],
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await vi.waitFor(() =>
      expect(f.activity.reader.work()[0]?.state).toBe("working"),
    );
    await deadline;
    await settle();
    expect(f.activity.reader.work()[0]?.state).toBe("working");
    release();
    await vi.waitFor(() =>
      expect(f.activity.reader.work()[0]?.state).toBe("done"),
    );
  } finally {
    release?.();
    log.mockRestore();
    await f.ctx.fiber.dispose();
  }
});

it("clears declined requests and removed agents without late outcomes reviving activity", async () => {
  const f = await setup();
  await f.service.create({ type: "example/echo", name: "Echo" });
  const request = (id: string) => ({
    events: [
      event(id, {
        tags: [
          ["h", channel],
          ["p", bot],
        ],
      }),
    ],
    channelId: channel,
  });
  let finish!: (result: WorkOutcome) => void;
  const done = new Promise<WorkOutcome>((resolve) => {
    finish = resolve;
  });
  try {
    f.native.claim.mockResolvedValue(false);
    f.emit(request("unclaimed"));
    await settle();
    expect(f.activity.reader.work()).toEqual([]);
    expect(f.run).not.toHaveBeenCalled();
    f.native.claim.mockResolvedValue(true);
    f.run.mockImplementationOnce((delivery) => delivery.ignored?.());
    f.emit(request("declined"));
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
    await settle();
    expect(f.activity.reader.work()).toEqual([]);
    f.run.mockImplementationOnce((delivery) => delivery.workingUntil(done));
    f.emit(request("active"));
    await vi.waitFor(() =>
      expect(f.activity.reader.work()[0]?.state).toBe("working"),
    );
    await f.service.remove(bot);
    finish({ ok: false, error: "Late failure" });
    await settle();
    expect(f.activity.reader.work()).toEqual([]);
  } finally {
    finish({ ok: true });
    await f.ctx.fiber.dispose();
  }
});

/** The handle of the agent's next run, from a mention. */
async function handleOf(
  run: ReturnType<typeof vi.fn<(delivery: Delivery<Config>) => void>>,
  emit: (batch: LiveBatch) => void,
) {
  emit({
    events: [
      event("hi", {
        tags: [
          ["h", channel],
          ["p", bot],
        ],
      }),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalled());
  return run.mock.calls.at(-1)?.[0].agent as Delivery["agent"];
}

it("lets a run read and write its attention with expected-state tokens", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true });
  const { attention } = await handleOf(run, emit);
  expect(attention.enabled()).toBe(true);
  expect(attention.classifier()).toBe("unavailable");
  expect(attention.interests()).toEqual(["default"]);
  const shown = await attention.show("interest/default");
  expect(shown).toMatchObject({
    result: "found",
    object: { id: "default", instructions: "Be brief." },
    expected_state: expect.stringMatching(/^object-v1:[0-9a-f]{64}$/),
  });
  const written = await attention.write(
    "interest/default",
    { type: "interest", instructions: "Be briefer." },
    { expected: shown.expected_state },
  );
  expect(written.object).toMatchObject({ instructions: "Be briefer." });
  // The owner sees the agent's write, and the old token no longer works.
  expect(service.find(bot)?.attention["interest/default"]?.value).toEqual({
    type: "interest",
    instructions: "Be briefer.",
  });
  await expect(
    attention.write(
      "interest/default",
      { type: "interest", instructions: "Stale." },
      { expected: shown.expected_state },
    ),
  ).rejects.toThrow(/^conflict:/);
});

it("keeps attention off across a reload", async () => {
  const { service, storage, native } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: false });
  const reloaded = await setup({
    storage,
    identities: await native.list(),
  });
  await vi.waitFor(() =>
    expect(reloaded.service.snapshot().status).toBe("ready"),
  );
  expect(reloaded.service.find(bot)?.attentionEnabled).toBe(false);
});

it("stops watches and timers while attention is off, keeps every object, and resumes them", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, {
    attentionEnabled: false,
    attention: {
      "watch/tick": {
        type: "timer",
        interest_id: "default",
        prompt: "check in",
        enabled: true,
        interval_secs: 60,
        armed_at: 1_000,
        max_occurrences: null,
        expires_at: null,
      },
    },
  });
  const before = service.find(bot);
  expect(before?.attentionEnabled).toBe(false);
  emit({ events: [event("w", { content: "deploy" })] });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(run).not.toHaveBeenCalled();
  // Mentions still reach it.
  emit({
    events: [
      event("m", {
        tags: [
          ["h", channel],
          ["p", bot],
        ],
      }),
    ],
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(run.mock.calls.map(([{ trigger }]) => trigger.type)).toEqual([
    "mention",
  ]);
  expect(run.mock.calls[0]?.[0].agent.attention.enabled()).toBe(false);
  await service.save(bot, { attentionEnabled: true });
  expect(service.find(bot)?.attention).toEqual(before?.attention);
  emit({ events: [event("w2", { content: "deploy" })] });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(run.mock.calls.map(([{ trigger }]) => trigger.type)).toEqual([
    "mention",
    "watch",
    "timer",
  ]);
});
