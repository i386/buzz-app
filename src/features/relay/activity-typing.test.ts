import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.useRealTimers());
import { createRelaySession } from "./session";
import type { LiveCallbacks } from "./live";
import { keypair, roster, scriptedTransport, signed } from "./testing";

it("live typing is owner-recognized and self-suppressed, bypasses history/read views, and loses access before a mixed batch", async () => {
  const viewer = keypair(),
    agent = keypair(),
    relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  let generation = 0;
  const owner = createRelaySession({
    ...wire.transport,
    agentActivity: true,
    subscribe(callbacks) {
      live = callbacks;
      return {
        update() {},
        retry() {},
        dispose() {},
        observe(next) {
          generation = next ?? 0;
        },
      };
    },
  });
  const state = () =>
    live.state({
      status: "connected",
      routes: [{ id: "observer", status: "live", replay: "unknown" }],
    });
  const now = Math.floor(Date.now() / 1000);
  const make = (key = agent) =>
    signed(key, {
      kind: 20002,
      content: "",
      created_at: now,
      tags: [
        ["h", "a"],
        ["e", "a".repeat(64), "", "reply"],
      ],
    });
  const recognize = (key = agent) =>
    live.observer?.(
      {
        id: key.pubkey,
        agent: key.pubkey,
        createdAt: now,
        plaintext: JSON.stringify({
          kind: "turn_liveness",
          channelId: "a",
          turnId: key.pubkey,
          timestamp: new Date().toISOString(),
        }),
      },
      generation,
    );
  try {
    live.receive([roster(relay, "a", [viewer.pubkey, agent.pubkey])]);
    const release = owner.session.agentActivity.activate();
    state();
    recognize();
    recognize(viewer);
    const view = owner.session.observe([
      { kinds: [20002], "#h": ["a"], limit: 10 },
    ]);
    live.receive([make(), make(viewer)]);
    expect(
      owner.session.agentActivity.snapshot().typing.map((entry) => entry.agent),
    ).toEqual([agent.pubkey]);
    expect(owner.session.typing.snapshot()).toMatchObject([
      { pubkey: agent.pubkey },
    ]);
    expect(view.snapshot().events).toEqual([]);
    expect(JSON.stringify(owner.session.channels.window("a"))).not.toContain(
      make().id,
    );
    const read = owner.session.read([
      { kinds: [20002], "#h": ["a"], limit: 10 },
    ]);
    wire.next().respond([make()]);
    expect(await read).toEqual([]);
    release();
    const activate = owner.session.agentActivity.activate();
    state();
    recognize();
    // Finite reads must not seed either history or typing after a reset.
    const finite = owner.session.read([
      { kinds: [20002], "#h": ["a"], limit: 10 },
    ]);
    wire.next().respond([make()]);
    expect(await finite).toEqual([]);
    expect(owner.session.agentActivity.snapshot().typing).toEqual([]);
    live.receive([make(), roster(relay, "a", [agent.pubkey], now + 1)]);
    expect(owner.session.agentActivity.snapshot().typing).toEqual([]);
    expect(owner.session.agentActivity.snapshot().records).toEqual([]);
    activate();
    view.dispose();
  } finally {
    owner.dispose();
  }
});

// Both projections consume the same live delivery, but public typing listeners
// may synchronously retire that delivery before the owner-only consumer runs.
it.each(["cache", "dispose", "access", "reconnect"] as const)(
  "fences owner-only activity after a shared typing subscriber triggers %s",
  async (transition) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const viewer = keypair(),
      relay = keypair(),
      agent = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    let generation = 0;
    const owner = createRelaySession({
      ...wire.transport,
      agentActivity: true,
      subscribe(callbacks) {
        live = callbacks;
        return {
          update() {},
          retry() {},
          dispose() {},
          observe(next) {
            generation = next ?? 0;
          },
        };
      },
    });
    const connected = () =>
      live.state({
        status: "connected",
        routes: [{ id: "observer", status: "live", replay: "unknown" }],
      });
    let clearing: Promise<void> | undefined;
    try {
      live.receive([
        roster(relay, "a", [viewer.pubkey]),
        roster(relay, "b", [viewer.pubkey]),
      ]);
      owner.session.agentActivity.activate();
      connected();
      live.observer?.(
        {
          id: agent.pubkey,
          agent: agent.pubkey,
          createdAt: 1_800_000_000,
          plaintext: JSON.stringify({ kind: "telemetry", channelId: "a" }),
        },
        generation,
      );
      expect(owner.session.agentActivity.snapshot().records).toHaveLength(1);
      let transitioned = false;
      const listener = vi.fn(() => {
        if (transitioned || !owner.session.typing.snapshot().length) return;
        transitioned = true;
        if (transition === "cache") clearing = owner.clearCache();
        else if (transition === "dispose") owner.dispose();
        else if (transition === "access")
          live.receive([roster(relay, "b", [], 1_800_000_001)]);
        else {
          live.state({ status: "retrying", routes: [] });
          connected();
        }
      });
      owner.session.typing.subscribe(listener);
      live.receive([
        signed(agent, {
          kind: 20002,
          content: "",
          created_at: 1_800_000_000,
          tags: [["h", "a"]],
        }),
      ]);
      await clearing;
      expect(transitioned).toBe(true);
      expect(owner.session.typing.snapshot()).toEqual([]);
      expect(owner.session.agentActivity.snapshot().typing).toEqual([]);
    } finally {
      owner.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("late retained trigger admission updates message and thread work synchronously without advancing the freshness clock", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  const viewer = keypair(),
    agent = keypair(),
    relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  let generation = 0;
  const owner = createRelaySession({
    ...wire.transport,
    agentActivity: true,
    subscribe(callbacks) {
      live = callbacks;
      return {
        update() {},
        retry() {},
        dispose() {},
        observe(next) {
          generation = next ?? 0;
        },
      };
    },
  });
  const root = "b".repeat(64);
  const trigger = signed(viewer, {
    kind: 9,
    content: "please work",
    created_at: 1_800_000_000,
    tags: [
      ["h", "a"],
      ["e", root, "", "reply"],
    ],
  });
  try {
    live.receive([roster(relay, "a", [viewer.pubkey, agent.pubkey])]);
    owner.session.agentActivity.activate();
    live.state({
      status: "connected",
      routes: [{ id: "observer", status: "live", replay: "unknown" }],
    });
    for (const [seq, kind] of [
      [1, "turn_started"],
      [2, "turn_completed"],
    ] as const) {
      live.observer?.(
        {
          id: String(seq).repeat(64),
          agent: agent.pubkey,
          createdAt: 1_800_000_000,
          plaintext: JSON.stringify({
            kind,
            seq,
            channelId: "a",
            turnId: "work",
            timestamp: new Date().toISOString(),
            payload: { triggeringEventIds: [trigger.id] },
          }),
        },
        generation,
      );
    }
    expect(owner.session.agentActivity.snapshot().turns[0]?.requests).toEqual(
      [],
    );
    const listener = vi.fn();
    owner.session.agentActivity.subscribe(listener);
    live.receive([trigger]);
    expect(listener).toHaveBeenCalled();
    expect(owner.session.agentActivity.snapshot().turns[0]).toMatchObject({
      state: "ended",
      requests: [{ messageId: trigger.id, threadRootId: root }],
    });
  } finally {
    owner.dispose();
  }
});
