import { createLocalAgentActivity, type WorkOutcome } from "./local-activity";
import { createHash } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import { schnorr } from "@noble/curves/secp256k1.js";
import { npubEncode } from "nostr-tools/nip19";
import { bytesToHex } from "nostr-tools/utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eventDto, type ReadFilter, type RelayEvent } from "../relay/events";
import { keypair, message } from "../relay/testing";
import type { LiveBatch, LiveListener } from "../relay/incoming";
import type { RelayData, RelaySnapshot } from "../relay/service";
import type { RelaySession } from "../relay/session";
import type { AgentEventTemplate, AgentIdentity, AgentsNative } from "./native";
import {
  AgentsService,
  type AgentCommunities,
  type AgentType,
  type Delivery,
  fromOwner,
  teamPrompt,
} from "./service";
import type { ClassifierNative } from "./classifier";
import { CATCH_UP_KEY } from "./catch-up";
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
  /** Listeners that asked for replayed history too. */
  const replays = new Set<LiveListener>();
  const changes = new Set<() => void>();
  const rosterChanges = new Set<() => void>();
  // The agent is in `channel`; `private` is the owner's alone. `saved` has
  // only a roster loaded from disk, not yet confirmed by the relay.
  const rows: { id: string; name: string; members: string[]; cached?: true }[] =
    [
      { id: channel, name: "general", members: [viewer, bot] },
      { id: "private", name: "private", members: [viewer] },
      { id: "saved", name: "saved", members: [viewer, bot], cached: true },
    ];
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
  /** The kind 9 messages it stores, which catch-up reads. */
  const history: RelayEvent[] = [];
  const session = {
    archives,
    read: vi.fn(async (filters: readonly ReadFilter[]) =>
      filters[0]?.kinds?.includes(9) ? page(history, filters[0]) : [...listed],
    ),
    // STOPGAP(agent-local-typing): delete with local-typing.ts.
    typing: { local: vi.fn() },
    channels: {
      list: () => ({ channels: rows.map((row) => ({ ...row })) }),
      subscribeList(listener: () => void) {
        rosterChanges.add(listener);
        return () => rosterChanges.delete(listener);
      },
    },
    live: {
      snapshot: () => ({ status }),
      subscribe(listener: () => void) {
        statuses.add(listener);
        return () => statuses.delete(listener);
      },
    },
    subscribeLive(listener: LiveListener, options?: { replay?: boolean }) {
      const listeners = options?.replay ? replays : live;
      listeners.add(listener);
      return () => listeners.delete(listener);
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
      for (const listener of batch.replay ? replays : [...live, ...replays])
        listener(batch);
    },
    /** The relay confirms channel `id`'s roster, with these members. */
    confirm(id: string, members: string[]) {
      const index = rows.findIndex((row) => row.id === id);
      rows[index] = { id, name: id, members };
      for (const listener of rosterChanges) listener();
    },
    archives,
    listed,
    history,
    session,
    origin,
  };
}
/** One page of `events` for `filter`, as the relay pages them: newest first,
 * ties by id ascending, below the `until`/`before_id` cursor. */
function page(events: readonly RelayEvent[], filter: ReadFilter) {
  const until = filter.until ?? Number.MAX_SAFE_INTEGER;
  return events
    .filter(
      (event) =>
        event.created_at >= (filter.since ?? 0) &&
        (event.created_at < until ||
          (event.created_at === until &&
            (filter.before_id === undefined || event.id > filter.before_id))) &&
        (!filter["#h"] ||
          event.tags.some(
            ([key, value]) => key === "h" && value === filter["#h"]?.[0],
          )),
    )
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
    .slice(0, filter.limit);
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
    portable: vi.fn(async () => ({
      agents: [
        { source: "harness" as const, pubkey: bot, name: "Old", relay: "" },
        {
          source: "installed" as const,
          pubkey: sibling,
          name: "Older",
          relay: "",
        },
      ],
      warnings: ["Could not read one store"],
    })),
    port: vi.fn(
      async (
        _: string,
        pubkey: string,
        __: string,
        ___: string,
        type: string,
      ) => {
        const identity = {
          pubkey,
          relay: "wss://relay.example.test",
          owner: viewer,
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
  history = [] as RelayEvent[],
  timeoutMs = 60_000,
  jev = undefined as ClassifierNative | undefined,
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
  fake.history.push(...history);
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
    jev,
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
    confirm: fake.confirm,
    connect: fake.connect,
    fail: fake.fail,
    relay: fake.relay,
    reconnecting: fake.reconnecting,
    recover: fake.recover,
    archives: fake.archives,
    session: fake.session,
    history: fake.history,
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
  const from = (pubkey: string, tags: string[][] = []) => ({
    pubkey,
    kind: 9,
    created_at: 100,
    tags,
  });
  expect(await fromOwner(from(owner), owner)).toBe(true);
  expect(await fromOwner(from(agent, [auth]), owner)).toBe(true);
  expect(await fromOwner(from(agent), owner)).toBe(false);
  // Another key cannot borrow the agent's attestation, nor claim an owner.
  expect(await fromOwner(from(other, [auth]), owner)).toBe(false);
  expect(
    await fromOwner(from(agent, [["auth", owner, "", "0".repeat(128)]]), owner),
  ).toBe(false);
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

/** A native classifier whose answers the test sets. */
function fakeJev(configured = true) {
  let key = configured;
  const jev = {
    status: vi.fn(async () => key),
    setKey: vi.fn(async (_: string) => {
      key = true;
    }),
    clearKey: vi.fn(async () => {
      key = false;
    }),
    classify: vi.fn<ClassifierNative["classify"]>(async () => ({
      outcome: "answered",
      answers: { deploy: { type: "noul", noul: 0.9 } },
    })),
  };
  return jev;
}
async function classifiedAgent(jev: ReturnType<typeof fakeJev>) {
  const harness = await setup({ jev });
  await harness.service.create({ type: "example/echo", name: "Echo" });
  await harness.service.save(bot, {
    attentionEnabled: true,
    attention: {
      "watch/channel": {
        type: "event",
        interest_id: "default",
        enabled: true,
        since: 1,
        channels: [channel],
        kinds: [9],
        classifier: {
          questions: {
            deploy: { question: "Is it about a deploy?", threshold: 0.5 },
          },
        },
      },
    },
  });
  return harness;
}

it("runs a watch's classifier after its selectors and passes the event with each answer", async () => {
  const jev = fakeJev();
  const { service, run, emit } = await classifiedAgent(jev);
  await vi.waitFor(() => expect(service.classifier()).toBe("available"));
  emit({ events: [event("w", { content: "shipping v2" })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(run.mock.calls[0]?.[0].trigger).toMatchObject({
    slug: "watch/channel",
    classifier: {
      outcome: "passed",
      model: "jev-1.13.0",
      answers: { deploy: { probability: 0.9, threshold: 0.5, pass: true } },
      policy: "deploy",
    },
  });
  const [state, questions] = jev.classify.mock.calls[0] ?? [];
  expect(state).toMatchObject({
    event: { id: expect.stringMatching(/^w0+$/), content: "shipping v2" },
    author: { role: "other" },
    context: { channel: expect.any(Object), thread: { is_reply: false } },
  });
  expect(questions).toMatchObject({
    deploy: {
      type: "noul",
      instructions: { question: "Is it about a deploy?" },
      criteria: { true: expect.any(String), false: expect.any(String) },
    },
  });
});

it("drops an event every answer rejects, and does not classify an event the selectors reject", async () => {
  const jev = fakeJev();
  jev.classify.mockResolvedValue({
    outcome: "answered",
    answers: { deploy: { type: "noul", noul: 0.2 } },
  });
  const { run, emit } = await classifiedAgent(jev);
  emit({ events: [event("w", { content: "lunch?" })] });
  emit({ events: [event("x", { kind: 7 })] });
  await vi.waitFor(() => expect(jev.classify).toHaveBeenCalledOnce());
  await settle();
  expect(run).not.toHaveBeenCalled();
});

it("passes the event when the classifier fails, and says why", async () => {
  const jev = fakeJev();
  jev.classify
    .mockResolvedValueOnce({ outcome: "failed", reason: "timeout" })
    .mockResolvedValueOnce({ outcome: "answered", answers: {} })
    .mockRejectedValueOnce(new Error("ipc"));
  const { run, emit } = await classifiedAgent(jev);
  emit({ events: [event("a"), event("b"), event("c")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
  expect(
    run.mock.calls
      .map(([delivery]) => delivery.trigger)
      .map((t) => (t.type === "watch" ? t.classifier : undefined)),
  ).toEqual([
    { outcome: "failed", reason: "timeout" },
    { outcome: "failed", reason: "invalid_response" },
    { outcome: "failed", reason: "service_error" },
  ]);
});

it("without a key the classifier does not run and the turn is told so", async () => {
  const jev = fakeJev(false);
  const { service, run, emit } = await classifiedAgent(jev);
  emit({ events: [event("w")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(jev.classify).not.toHaveBeenCalled();
  expect(run.mock.calls[0]?.[0].trigger).toMatchObject({
    classifier: { outcome: "not-run" },
  });
  expect(service.classifier()).toBe("unavailable");
});

it("a key set or cleared takes effect at once, and one removed elsewhere is noticed", async () => {
  const jev = fakeJev(false);
  const { service, run, emit } = await classifiedAgent(jev);
  await service.setClassifierKey("tk");
  expect(jev.setKey).toHaveBeenCalledWith("tk");
  expect(service.classifier()).toBe("available");
  expect(service.snapshot().classifier).toBe("available");
  await service.clearClassifierKey();
  expect(service.classifier()).toBe("unavailable");
  await service.setClassifierKey("tk");
  jev.classify.mockResolvedValueOnce({
    outcome: "failed",
    reason: "missing_credentials",
  });
  emit({ events: [event("w")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(run.mock.calls[0]?.[0].trigger).toMatchObject({
    classifier: { outcome: "not-run" },
  });
  expect(service.classifier()).toBe("unavailable");
});

it("shows a key it cannot read as unreadable, and one the service refuses as refused", async () => {
  const jev = fakeJev();
  jev.status.mockRejectedValueOnce(new Error("locked"));
  const { service, run, emit } = await classifiedAgent(jev);
  await vi.waitFor(() =>
    expect(service.snapshot().classifierKey).toBe("unreadable"),
  );
  // Unreadable is not missing: native is still asked, and its answer shows
  // the key is saved.
  emit({ events: [event("a")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(jev.classify).toHaveBeenCalledOnce();
  expect(service.snapshot().classifierKey).toBe("saved");
  jev.classify.mockResolvedValueOnce({
    outcome: "failed",
    reason: "unauthorized",
  });
  emit({ events: [event("b")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect(run.mock.calls[1]?.[0].trigger).toMatchObject({
    classifier: { outcome: "failed", reason: "unauthorized" },
  });
  expect(service.snapshot().classifierKey).toBe("refused");
  expect(service.classifier()).toBe("available");
  // Another failure does not say whether the key was accepted.
  jev.classify.mockResolvedValueOnce({ outcome: "failed", reason: "timeout" });
  emit({ events: [event("c")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
  expect(service.snapshot().classifierKey).toBe("refused");
});

it("does not run an event classified against a classifier changed since", async () => {
  const jev = fakeJev();
  let answer!: (
    value: Awaited<ReturnType<ClassifierNative["classify"]>>,
  ) => void;
  jev.classify.mockImplementationOnce(
    () => new Promise((resolve) => (answer = resolve)),
  );
  const { service, run, emit } = await classifiedAgent(jev);
  emit({ events: [event("w")] });
  await vi.waitFor(() => expect(jev.classify).toHaveBeenCalledOnce());
  const watch = service.find(bot)?.attention["watch/channel"]?.value;
  if (watch?.type !== "event") throw new Error("no watch");
  await service.save(bot, {
    attention: {
      "watch/channel": {
        ...watch,
        classifier: { questions: { deploy: { question: "Is it urgent?" } } },
      },
    },
  });
  answer({
    outcome: "answered",
    answers: { deploy: { type: "noul", noul: 1 } },
  });
  await settle();
  await settle();
  expect(run).not.toHaveBeenCalled();
});

type Answer = Awaited<ReturnType<ClassifierNative["classify"]>>;
const yes: Answer = {
  outcome: "answered",
  answers: { deploy: { type: "noul", noul: 0.9 } },
};

it("queues classified events in arrival order, whichever answer comes first", async () => {
  const jev = fakeJev();
  let first!: (value: Answer) => void;
  jev.classify
    .mockImplementationOnce(() => new Promise((resolve) => (first = resolve)))
    .mockResolvedValueOnce(yes);
  const { run, emit } = await classifiedAgent(jev);
  emit({ events: [event("a"), event("b")] });
  await vi.waitFor(() => expect(jev.classify).toHaveBeenCalledTimes(2));
  await settle();
  expect(run).not.toHaveBeenCalled();
  first(yes);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect(
    run.mock.calls.map(([delivery]) =>
      delivery.trigger.type === "watch" ? delivery.trigger.event.id[0] : "",
    ),
  ).toEqual(["a", "b"]);
});

it("an event heard before the saved key's status is read waits for it, then is classified", async () => {
  const jev = fakeJev();
  let known!: (value: boolean) => void;
  jev.status.mockImplementationOnce(
    () => new Promise<boolean>((resolve) => (known = resolve)),
  );
  const { run, emit } = await classifiedAgent(jev);
  emit({ events: [event("w")] });
  await settle();
  expect(run).not.toHaveBeenCalled();
  known(true);
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(jev.classify).toHaveBeenCalledOnce();
  expect(run.mock.calls[0]?.[0].trigger).toMatchObject({
    classifier: { outcome: "passed" },
  });
});

it("a failed read of the key's status does not stop a saved key from classifying", async () => {
  const jev = fakeJev();
  jev.status.mockRejectedValueOnce(new Error("The Keychain is locked"));
  const { service, run, emit } = await classifiedAgent(jev);
  expect(service.classifier()).toBe("unavailable");
  emit({ events: [event("w")] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(jev.classify).toHaveBeenCalledOnce();
  expect(run.mock.calls[0]?.[0].trigger).toMatchObject({
    classifier: { outcome: "passed" },
  });
  expect(service.classifier()).toBe("available");
});

it("classifies a reply without its parent when the parent lookup does not answer", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const jev = fakeJev();
    const { native, run, emit } = await classifiedAgent(jev);
    native.query.mockImplementation(() => new Promise(() => {}));
    emit({
      events: [
        event("r", {
          tags: [
            ["h", channel],
            ["e", "b".repeat(64), "", "reply"],
          ],
        }),
      ],
    });
    await vi.waitFor(() => expect(native.query).toHaveBeenCalled());
    expect(jev.classify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const [state] = jev.classify.mock.calls[0] ?? [];
    expect((state as { context: { thread: unknown } }).context.thread).toEqual({
      is_reply: true,
      parent: null,
    });
  } finally {
    vi.useRealTimers();
  }
});

it("sends nothing to the classifier for a watch stopped while its event waited", async () => {
  const jev = fakeJev();
  let known!: (value: boolean) => void;
  jev.status.mockImplementationOnce(
    () => new Promise<boolean>((resolve) => (known = resolve)),
  );
  const { service, run, emit } = await classifiedAgent(jev);
  emit({ events: [event("w")] });
  await settle();
  const watch = service.find(bot)?.attention["watch/channel"]?.value;
  if (watch?.type !== "event") throw new Error("no watch");
  await service.save(bot, {
    attention: { "watch/channel": { ...watch, enabled: false } },
  });
  known(true);
  await settle();
  await settle();
  expect(jev.classify).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it("a copy of the app that does not hold the agent sends nothing to the classifier", async () => {
  const jev = fakeJev();
  const { native, run, emit } = await classifiedAgent(jev);
  native.claim.mockResolvedValue(false);
  emit({ events: [event("w")] });
  await vi.waitFor(() => expect(native.claim).toHaveBeenCalled());
  await settle();
  await settle();
  expect(jev.classify).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it("gives the classifier Buzz's thread parent: the marked reply, in any case; a lone root is no reply", async () => {
  const jev = fakeJev();
  const { native, emit } = await classifiedAgent(jev);
  const parent = "A".repeat(64);
  emit({
    events: [
      event("r", {
        tags: [
          ["h", channel],
          ["e", "b".repeat(64), "", "root"],
        ],
      }),
      event("p", {
        tags: [
          ["h", channel],
          ["e", "b".repeat(64), "", "root"],
          ["e", "c".repeat(64), "", "reply"],
          ["e", parent, "", "reply"],
        ],
      }),
    ],
  });
  await vi.waitFor(() => expect(jev.classify).toHaveBeenCalledTimes(2));
  const states = jev.classify.mock.calls.map(
    ([state]) => state as { context: { thread: { is_reply: boolean } } },
  );
  expect(states.map((state) => state.context.thread.is_reply)).toEqual([
    false,
    true,
  ]);
  expect(native.query).toHaveBeenCalledOnce();
  expect(native.query).toHaveBeenCalledWith(bot, [
    { ids: [parent.toLowerCase()], limit: 1 },
  ]);
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

const everything = {
  "watch/everything": {
    type: "event",
    interest_id: "default",
    enabled: true,
    since: 1,
    channels: "all",
    kinds: [],
  },
} as const;
const woke = (run: { mock: { calls: readonly (readonly unknown[])[] } }) =>
  run.mock.calls.map(([input]) =>
    (input as { trigger: { event: RelayEvent } }).trigger.event.id.replace(
      /0+$/,
      "",
    ),
  );

it("delivers what a reconnect replays since the agent started listening, once", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true, attention: everything });
  const now = Math.floor(Date.now() / 1000);
  emit({ events: [event("live", { created_at: now })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  // The subscription comes back and sends its recent history again: the one
  // already heard, one missed while it was down, and one from before.
  emit({
    replay: true,
    events: [
      event("live", { created_at: now }),
      event("missed", { created_at: now + 1 }),
      event("before", { created_at: now - 600 }),
    ],
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  await settle();
  expect(woke(run)).toEqual(["live", "missed"]);
});

it("still knows a quiet channel's event when a reconnect replays it after busy traffic elsewhere", async () => {
  const { service, run, emit } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true, attention: everything });
  const now = Math.floor(Date.now() / 1000);
  emit({ events: [event("quiet", { created_at: now })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  // More events than the shared seen set holds, all in another channel.
  emit({
    events: Array.from({ length: 2_100 }, (_, index) =>
      event(`busy${index}x`, { created_at: now, tags: [["h", "private"]] }),
    ),
  });
  emit({ replay: true, events: [event("quiet", { created_at: now })] });
  // A later event runs after anything the replay queued.
  emit({ events: [event("after", { created_at: now })] });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  await settle();
  expect(woke(run)).toEqual(["quiet", "after"]);
});

it("delivers a replay of more matching events than the rate limit takes at once, each once", async () => {
  vi.useFakeTimers({ now: 1_000_000_000 });
  try {
    const { service, run, emit } = await setup();
    await service.create({ type: "example/echo", name: "Echo" });
    await service.save(bot, { attentionEnabled: true, attention: everything });
    const now = Math.floor(Date.now() / 1000);
    const ids = Array.from({ length: 80 }, (_, index) => `m${index}x`);
    // A three-minute drop: live, these would have spread over three windows.
    emit({
      replay: true,
      events: ids.map((id, index) =>
        event(id, { created_at: now + 1 + Math.floor(index / 30) }),
      ),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run.mock.calls.length).toBeLessThanOrEqual(60);
    expect(run.mock.calls.length).toBeGreaterThan(0);
    // The rest wait for the next rate window, and a second replay of the
    // same history wakes nothing again.
    emit({
      replay: true,
      events: ids.map((id) => event(id, { created_at: now + 1 })),
    });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(woke(run).sort()).toEqual(
      ids.map((id) => id.replace(/0+$/, "")).sort(),
    );
  } finally {
    vi.useRealTimers();
  }
});

it("leaves a replay past its backlog unseen, so a later replay delivers it", async () => {
  vi.useFakeTimers({ now: 1_000_000_000 });
  try {
    const { service, run, emit } = await setup();
    await service.create({ type: "example/echo", name: "Echo" });
    await service.save(bot, { attentionEnabled: true, attention: everything });
    const now = Math.floor(Date.now() / 1000);
    const ids = Array.from({ length: 520 }, (_, index) => `b${index}x`);
    const replay = () =>
      emit({
        replay: true,
        events: ids.map((id) => event(id, { created_at: now + 1 })),
      });
    replay();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(run.mock.calls.length).toBe(512);
    replay();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(new Set(woke(run)).size).toBe(520);
    expect(run.mock.calls.length).toBe(520);
  } finally {
    vi.useRealTimers();
  }
});

it("holds a watched event until the relay confirms its channel's saved roster", async () => {
  const { service, run, emit, confirm } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true, attention: everything });
  emit({
    events: [
      event("kept", { tags: [["h", "saved"]] }),
      event("dropped", { tags: [["h", "saved"]] }),
    ],
  });
  await settle();
  expect(run).not.toHaveBeenCalled();
  // Confirmed with the agent still in it: both wake it, each once.
  confirm("saved", [viewer, bot]);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  confirm("saved", [viewer, bot]);
  await settle();
  expect(woke(run)).toEqual(["kept", "dropped"]);
});

it("drops a held event when the confirmed roster no longer has the agent", async () => {
  const { service, run, emit, confirm } = await setup();
  await service.create({ type: "example/echo", name: "Echo" });
  await service.save(bot, { attentionEnabled: true, attention: everything });
  emit({ events: [event("removed", { tags: [["h", "saved"]] })] });
  await settle();
  confirm("saved", [viewer]);
  confirm("saved", [viewer, bot]);
  await settle();
  expect(run).not.toHaveBeenCalled();
});

const echo = {
  pubkey: bot,
  relay: "wss://relay.example.test",
  owner: viewer,
  type: "example/echo",
  name: "Echo",
  deleted: false,
};
const chat = {
  "watch/chat": {
    type: "event",
    interest_id: "default",
    enabled: true,
    since: 1,
    channels: [channel],
    kinds: [9],
  },
} as const;
const author = keypair();
/** A message in `channel` the relay signed and stored. */
const said = (content: string, created_at: number) =>
  eventDto(message(author, channel, content, created_at));
const heard = (run: { mock: { calls: readonly (readonly unknown[])[] } }) =>
  run.mock.calls.map(
    ([input]) =>
      (input as { trigger: { event: RelayEvent } }).trigger.event.content,
  );
const catchUpReads = (session: RelaySession) =>
  vi
    .mocked(session.read)
    .mock.calls.map(([filters]) => filters[0] as ReadFilter)
    .filter((filter) => filter.kinds?.includes(9));
const nowSeconds = () => Math.floor(Date.now() / 1000);

it("catches a kind 9 watch up on what it missed, a page at a time, and not again after a restart", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const start = nowSeconds();
    const storage = memoryStorage();
    const first = await setup({ storage, identities: [echo] });
    vi.setSystemTime(start * 1000);
    // Only this watch: the type's default one reads the channel too.
    await first.service.save(bot, {
      attentionEnabled: true,
      attention: { ...chat, "watch/channel": null },
    });
    await settle();
    // Missed while the socket was down.
    vi.setSystemTime((start + 200) * 1000);
    for (let i = 0; i < 20; i++)
      first.history.push(said(`m${i}`, start + 100 + i));
    first.recover();
    await vi.waitFor(() => expect(first.run).toHaveBeenCalledTimes(20));
    // Then an empty page finishes the window.
    await vi.waitFor(
      () => expect(catchUpReads(first.session)).toHaveLength(3),
      {
        timeout: 3_000,
      },
    );
    // The newest page first, each page oldest first; then the rest of the
    // short page, and an empty one that finishes the window.
    expect(heard(first.run)).toEqual(
      [...Array(16).keys(), 16, 17, 18, 19]
        .map((i) => (i < 16 ? i + 4 : i - 16))
        .map((i) => `m${i}`),
    );
    expect(catchUpReads(first.session)).toEqual([
      {
        kinds: [9],
        "#h": [channel],
        since: start + 1,
        until: start + 200,
        limit: 16,
      },
      expect.objectContaining({
        until: start + 104,
        before_id: expect.any(String),
      }),
      expect.objectContaining({ until: start + 100 }),
    ]);
    first.connect(false);
    // Started again a minute later, it reads only what came after.
    vi.setSystemTime((start + 260) * 1000);
    const second = await setup({
      storage,
      identities: [echo],
      history: [...first.history, said("late", start + 230)],
    });
    await vi.waitFor(() => expect(second.run).toHaveBeenCalledTimes(1));
    await settle();
    expect(heard(second.run)).toEqual(["late"]);
    expect(catchUpReads(second.session)[0]).toMatchObject({
      since: start + 201,
      until: start + 260,
    });
  } finally {
    vi.useRealTimers();
  }
});

it("takes the next page's cursor from the relay's events, not a local one older than them", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { service, run, session, history, recover } = await setup({
      identities: [echo],
    });
    const now = nowSeconds();
    await service.save(bot, { attentionEnabled: true, attention: chat });
    await settle();
    // Missed while the socket was down.
    vi.setSystemTime((now + 200) * 1000);
    for (let i = 0; i < 20; i++) history.push(said(`m${i}`, now + 100 + i));
    const read = vi.mocked(session.read);
    const original = read.getMockImplementation() as NonNullable<
      ReturnType<typeof read.getMockImplementation>
    >;
    let first = true;
    read.mockImplementation(async (filters, options) => {
      const events = await original(filters, options);
      if (!filters[0]?.kinds?.includes(9) || !first) return events;
      first = false;
      // The owner's message not yet sent, from before the relay's oldest.
      return [...events, { ...said("unsent", now + 50) }];
    });
    recover();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(20), {
      timeout: 3_000,
    });
    expect(new Set(heard(run))).toEqual(
      new Set(Array.from({ length: 20 }, (_, i) => `m${i}`)),
    );
  } finally {
    vi.useRealTimers();
  }
});

it("hears a whole page when live events fill the queue while the page is read", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { service, run, session, history, emit, recover } = await setup({
      identities: [echo],
    });
    const now = nowSeconds();
    await service.save(bot, {
      attentionEnabled: true,
      attention: { ...chat, "watch/channel": null },
    });
    await settle();
    vi.setSystemTime((now + 200) * 1000);
    for (let i = 0; i < 16; i++) history.push(said(`m${i}`, now + 100 + i));
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    run.mockImplementation(() => blocked);
    const read = vi.mocked(session.read);
    const original = read.getMockImplementation() as NonNullable<
      ReturnType<typeof read.getMockImplementation>
    >;
    let first = true;
    read.mockImplementation(async (filters, options) => {
      if (filters[0]?.kinds?.includes(9) && first) {
        first = false;
        // Live traffic arrives while the page is on its way.
        emit({
          events: Array.from({ length: 20 }, (_, i) =>
            event(`live${i}x`, { created_at: now + 200 }),
          ),
        });
      }
      return original(filters, options);
    });
    recover();
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    await settle();
    unblock();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(36), {
      timeout: 5_000,
    });
    expect(
      heard(run).filter((content) => content.startsWith("m")),
    ).toHaveLength(16);
  } finally {
    vi.useRealTimers();
  }
});

it("starts catch-up again when its watch is edited while a page is being read", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { service, run, session, history, recover } = await setup({
      identities: [echo],
    });
    const now = nowSeconds();
    // Only this watch: the type's default one would wake for "deploy" too.
    await service.save(bot, {
      attentionEnabled: true,
      attention: { ...chat, "watch/channel": null },
    });
    await settle();
    vi.setSystemTime((now + 60) * 1000);
    history.push(said("before", now + 10), said("deploy", now + 20));
    const read = vi.mocked(session.read);
    const original = read.getMockImplementation() as NonNullable<
      ReturnType<typeof read.getMockImplementation>
    >;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    read.mockImplementation(async (filters, options) => {
      if (filters[0]?.kinds?.includes(9) && first) {
        first = false;
        await held;
      }
      return original(filters, options);
    });
    recover();
    await vi.waitFor(() => expect(catchUpReads(session)).toHaveLength(1));
    await service.save(bot, {
      attention: {
        "watch/chat": { ...chat["watch/chat"], filter: 'content == "deploy"' },
      },
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    // The page read for the old watch wakes nothing when it comes back.
    release();
    await settle();
    await settle();
    expect(heard(run)).toEqual(["deploy"]);
  } finally {
    vi.useRealTimers();
  }
});

it("wakes nothing for what came before a watch was first caught up, as after an upgrade", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const start = nowSeconds();
    const storage = memoryStorage();
    const first = await setup({ storage, identities: [echo] });
    vi.setSystemTime(start * 1000);
    await first.service.save(bot, {
      attentionEnabled: true,
      attention: { ...chat, "watch/channel": null },
    });
    await settle();
    first.connect(false);
    // As a build from before catch-up leaves it: the watch, and no progress.
    storage.removeItem(CATCH_UP_KEY);
    vi.setSystemTime((start + 60) * 1000);
    const second = await setup({
      storage,
      identities: [echo],
      history: [said("before", start - 600), said("offline", start + 30)],
    });
    await settle();
    await settle();
    expect(second.run).not.toHaveBeenCalled();
    expect(catchUpReads(second.session)).toEqual([]);
    // From then on, it catches up on what it misses.
    vi.setSystemTime((start + 120) * 1000);
    second.history.push(said("missed", start + 90));
    second.recover();
    await vi.waitFor(() => expect(second.run).toHaveBeenCalledTimes(1));
    await settle();
    expect(heard(second.run)).toEqual(["missed"]);
  } finally {
    vi.useRealTimers();
  }
});

it("hears a page every matching watch wakes for, though its jobs fill the queue more than once", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { service, run, history, recover } = await setup({
      identities: [echo],
    });
    const now = nowSeconds();
    vi.setSystemTime(now * 1000);
    const watch = chat["watch/chat"];
    await service.save(bot, {
      attentionEnabled: true,
      attention: {
        "watch/channel": null,
        "watch/chat": watch,
        "watch/chat2": watch,
        "watch/chat3": watch,
      },
    });
    await settle();
    vi.setSystemTime((now + 60) * 1000);
    // One page: 16 events, and three jobs for each of them.
    for (let i = 0; i < 16; i++) history.push(said(`m${i}`, now + 10 + i));
    recover();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(48), {
      timeout: 5_000,
    });
    await settle();
    const wakes = run.mock.calls.map(([input]) => {
      const { trigger } = input as {
        trigger: { slug: string; event: RelayEvent };
      };
      return `${trigger.slug} ${trigger.event.content}`;
    });
    expect(new Set(wakes).size).toBe(48);
  } finally {
    vi.useRealTimers();
  }
});

it("waits for a confirmed roster before catching up past what the roster hold keeps", async () => {
  vi.useFakeTimers({ now: 1_000_000_000 });
  try {
    const { service, run, history, recover, confirm, session } = await setup({
      identities: [echo],
    });
    const now = nowSeconds();
    // Every channel: "saved" has only a roster loaded from disk.
    const watch = { ...chat["watch/chat"], channels: "all" as const };
    await service.save(bot, {
      attentionEnabled: true,
      attention: { "watch/channel": null, "watch/chat": watch },
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime((now + 400) * 1000);
    // More missed messages than the roster hold keeps.
    const missed = Array.from({ length: 300 }, (_, i) => `m${i}`);
    for (const [i, content] of missed.entries())
      history.push(eventDto(message(author, "saved", content, now + 1 + i)));
    recover();
    await vi.advanceTimersByTimeAsync(5_000);
    // Waiting on the roster, it reads no further than its first page.
    expect(run).not.toHaveBeenCalled();
    expect(catchUpReads(session)).toHaveLength(1);
    confirm("saved", [viewer, bot]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(new Set(heard(run))).toEqual(new Set(missed));
    expect(run).toHaveBeenCalledTimes(300);
  } finally {
    vi.useRealTimers();
  }
});

it("answers a mention catch-up reads from while it listened, not one from before", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const start = nowSeconds();
    const mention = (content: string, created_at: number) =>
      eventDto(message(author, channel, content, created_at, [["p", bot]]));
    const { service, run, history, recover } = await setup({
      identities: [echo],
      history: [mention("old", start - 10)],
    });
    await service.save(bot, { attentionEnabled: true, attention: chat });
    await settle();
    // Missed while the socket was down, live replay or not.
    vi.setSystemTime((start + 60) * 1000);
    history.push(mention("new", start + 30));
    recover();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await settle();
    expect(heard(run)).toEqual(["new"]);
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      trigger: { type: "mention" },
    });
  } finally {
    vi.useRealTimers();
  }
});

it("wakes nothing from the time its attention was off", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { service, run, history, recover } = await setup({
      identities: [echo],
    });
    const start = nowSeconds();
    await service.save(bot, { attentionEnabled: true, attention: chat });
    await settle();
    await service.save(bot, { attentionEnabled: false });
    history.push(said("while off", start));
    await service.save(bot, { attentionEnabled: true });
    // A reconnect a minute later catches up from when it was turned on.
    vi.setSystemTime((start + 60) * 1000);
    history.push(said("after", start + 30));
    recover();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await settle();
    expect(heard(run)).toEqual(["after"]);
  } finally {
    vi.useRealTimers();
  }
});

it("wakes nothing from the time its watch was off, also when it is turned on after a restart", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const start = nowSeconds();
    const storage = memoryStorage();
    const first = await setup({ storage, identities: [echo] });
    await first.service.save(bot, {
      attentionEnabled: true,
      attention: { ...chat, "watch/channel": null },
    });
    await settle();
    await first.service.save(bot, {
      attention: { "watch/chat": { ...chat["watch/chat"], enabled: false } },
    });
    first.history.push(said("while off", start + 10));
    // Still off a while later, then the app quits.
    vi.setSystemTime((start + 20) * 1000);
    first.recover();
    await settle();
    first.connect(false);
    // Turned on again elsewhere while this copy was closed.
    const saved = storage.getItem("buzz.agents.v1") ?? "";
    storage.setItem(
      "buzz.agents.v1",
      saved.replace('"enabled":false', '"enabled":true'),
    );
    vi.setSystemTime((start + 60) * 1000);
    const second = await setup({
      storage,
      identities: [echo],
      history: [...first.history, said("after", start + 30)],
    });
    await vi.waitFor(() => expect(second.run).toHaveBeenCalledTimes(1));
    await settle();
    expect(heard(second.run)).toEqual(["after"]);
  } finally {
    vi.useRealTimers();
  }
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

it("keeps a hosted agent made without its picture when the picture fails to save", async () => {
  const { service, plugin } = await setup();
  const { type, remote } = cloud();
  plugin.agents.register(type);
  remote.profile.mockRejectedValueOnce(new Error("provider down"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const agent = await service.create({
    type: "example/cloud",
    name: "Sky",
    picture: "https://example.test/sky.png",
  });
  expect(agent).toMatchObject({ pubkey: hostedKey, place: "hosted" });
  expect(agent.picture).toBeUndefined();
  expect(remote.provision).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    "Agent Sky picture was not saved",
    expect.any(Error),
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
