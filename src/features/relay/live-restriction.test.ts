import { afterEach, expect, it, vi } from "vitest";
import { sidebarSections } from "../../bundled/channels/sidebar-sections";
import { subscribeRelayTraffic, type LiveCallbacks } from "./live";
import { createRelaySession } from "./session";
import {
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "./testing";

class Socket {
  readyState = 1;
  onmessage?: (event: { data: string }) => Promise<void>;
  onclose?: () => void;
  sent: unknown[][] = [];
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  async receive(frame: unknown[]) {
    await this.onmessage?.({ data: JSON.stringify(frame) });
  }
  requests() {
    return this.sent.filter(([type]) => type === "REQ") as [
      string,
      string,
      { kinds: number[]; "#h"?: string[] },
    ][];
  }
}

afterEach(() => vi.useRealTimers());
const settle = () => vi.advanceTimersByTimeAsync(0);

async function setup(singletons = false) {
  vi.useFakeTimers();
  const viewer = keypair();
  const relay = keypair();
  const socket = new Socket();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      const traffic = subscribeRelayTraffic(
        "wss://relay.test",
        async (event) => signed(viewer, event),
        viewer.pubkey,
        callbacks,
        () => socket as unknown as WebSocket,
      );
      // Cases asserting independent CLOSED scopes keep explicit singleton inputs;
      // all other session cases exercise production joined batching.
      return singletons
        ? {
            ...traffic,
            update: (ids: readonly string[]) => traffic.update(ids),
          }
        : traffic;
    },
  });
  const memberships = ["a", "b"].map((id) =>
    roster(relay, id, [viewer.pubkey]),
  );
  const active = [metadata(relay, "a", "Alpha"), metadata(relay, "b", "Beta")];
  const archived = signed(relay, {
    kind: 39000,
    created_at: 1700000001,
    content: "",
    tags: [
      ["d", "a"],
      ["name", "Alpha"],
      ["archived", "true"],
    ],
  });
  const rows = () =>
    sidebarSections(owner.session.channels.list().channels, {
      starred: ["a"],
      muted: [],
      sections: [],
      assignments: {},
    }).flatMap((section) => section.rows.map((channel) => channel.id));
  try {
    await socket.receive(["AUTH", "challenge"]);
    const auth = socket.sent.find(([type]) => type === "AUTH")?.[1] as {
      id: string;
    };
    await socket.receive(["OK", auth.id, true]);
    for (const [, id] of socket.requests()) await socket.receive(["EOSE", id]);
    await settle();
    wire.next().respond(memberships);
    await settle();
    wire.next().respond(active);
    await settle();
    for (const [, id, filter] of socket.requests()) {
      if (filter["#h"]) await socket.receive(["EOSE", id]);
    }
    await settle();
    expect(wire.pending).toHaveLength(0);
    expect(rows()).toEqual(["a", "b"]);
    const route = socket
      .requests()
      .find(([, , filter]) => filter["#h"]?.includes("a"));
    expect(route).toBeDefined();
    const close = (reason = "restricted: channel access revoked") =>
      socket.receive(["CLOSED", route?.[1], reason]);
    return {
      viewer,
      relay,
      socket,
      wire,
      owner,
      live,
      memberships,
      active,
      archived,
      rows,
      close,
    };
  } catch (error) {
    owner.dispose();
    throw error;
  }
}

it.each(["archived", "unchanged", "removed"])(
  "repairs a missed metadata update from real CLOSED, applying authoritative %s state",
  async (outcome) => {
    const h = await setup();
    try {
      // Deliberately omit the archive EVENT. CLOSED alone is not archive authority.
      await h.close();
      await settle();
      expect(h.rows()).toEqual(["a", "b"]);
      const refresh = h.wire.next();
      expect(refresh.filters[0]?.kinds).toEqual([39002]);
      refresh.respond(
        outcome === "removed" ? h.memberships.slice(1) : h.memberships,
      );
      await settle();
      const names = h.wire.next();
      expect(names.filters[0]?.kinds).toEqual([39000]);
      names.respond(
        outcome === "archived" ? [h.archived, ...h.active.slice(1)] : h.active,
      );
      await settle();
      expect(h.rows()).toEqual(outcome === "unchanged" ? ["a", "b"] : ["b"]);
      const channel = h.owner.session.channels
        .list()
        .channels.find(({ id }) => id === "a");
      if (outcome === "archived") expect(channel?.archived).toBe(true);
      if (outcome === "removed") expect(channel).toBeUndefined();
      expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
      expect(h.wire.pending).toHaveLength(0);

      // An aggregate state notification or stale CLOSED must not refresh again.
      const snapshot = h.owner.session.live.snapshot();
      h.live.state(snapshot);
      await h.close();
      await settle();
      expect(h.wire.pending).toHaveLength(0);
      expect(
        h.socket
          .requests()
          .filter(([, , filter]) => filter["#h"]?.includes("a")),
      ).toHaveLength(1);
    } finally {
      h.owner.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["roster", "metadata"])(
  "retains state after a failed %s refresh and supports explicit retry",
  async (phase) => {
    const h = await setup();
    try {
      await h.close();
      await settle();
      if (phase === "metadata") {
        h.wire.next().respond(h.memberships);
        await settle();
      }
      h.wire.next().fail(new Error("offline"));
      await settle();
      expect(h.rows()).toEqual(["a", "b"]);
      expect(h.owner.session.live.snapshot().roster.state).toBe("error");
      h.live.state(h.owner.session.live.snapshot());
      await settle();
      expect(h.wire.pending).toHaveLength(0);
      h.owner.session.channels.refreshList?.();
      await settle();
      h.wire.next().respond(h.memberships);
      await settle();
      h.wire.next().respond([h.archived, ...h.active.slice(1)]);
      await settle();
      expect(h.rows()).toEqual(["b"]);
      expect(h.owner.session.live.snapshot().roster.state).toBe("verified");
    } finally {
      h.owner.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("ignores unrelated route failures and repeated aggregate restriction snapshots", async () => {
  const h = await setup(true);
  try {
    const b = h.socket
      .requests()
      .find(([, , filter]) => filter["#h"]?.includes("b"));
    const global = h.socket.requests().find(([, , filter]) => !filter["#h"]);
    await h.socket.receive([
      "CLOSED",
      global?.[1],
      "restricted: channel access revoked",
    ]);
    await h.close("invalid: bad filter");
    await settle();
    expect(h.wire.pending).toHaveLength(0);
    await h.socket.receive([
      "CLOSED",
      b?.[1],
      "restricted: channel access revoked",
    ]);
    h.live.state(h.owner.session.live.snapshot());
    await settle();
    expect(h.wire.pending).toHaveLength(1);
    h.live.state(h.owner.session.live.snapshot());
    await settle();
    h.wire.next().respond(h.memberships);
    await settle();
    h.wire.next().respond(h.active);
    await settle();
    expect(h.wire.pending).toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
});

it.each(["queued", "pending"])(
  "fences %s recovery on disposal",
  async (phase) => {
    const h = await setup();
    await h.close();
    if (phase === "pending") await settle();
    const pending = phase === "pending" ? h.wire.next() : undefined;
    h.owner.dispose();
    expect(pending?.signal?.aborted ?? true).toBe(true);
    pending?.respond(h.memberships);
    await h.close();
    await settle();
    expect(h.wire.pending).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("coalesces two restricted channels into one authoritative refresh", async () => {
  const h = await setup(true);
  try {
    const b = h.socket
      .requests()
      .find(([, , filter]) => filter["#h"]?.includes("b"));
    await h.close();
    await h.socket.receive([
      "CLOSED",
      b?.[1],
      "restricted: channel access revoked",
    ]);
    await settle();
    expect(h.wire.pending).toHaveLength(1);
    h.wire.next().respond(h.memberships);
    await settle();
    h.wire.next().respond([h.archived, ...h.active.slice(1)]);
    await settle();
    expect(h.rows()).toEqual(["b"]);
    expect(h.wire.pending).toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves the existing immediate explicit non-member denial", async () => {
  const h = await setup(true);
  try {
    await h.close("restricted: not a channel member");
    await settle();
    expect(h.rows()).toEqual(["b"]);
    expect(h.wire.pending).toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("refreshes again after deliberate route retry receives a fresh restriction", async () => {
  const h = await setup();
  try {
    await h.close();
    await settle();
    h.wire.next().respond(h.memberships);
    await settle();
    h.wire.next().respond(h.active);
    await settle();
    h.owner.session.live.retry();
    const retry = h.socket
      .requests()
      .filter(([, , filter]) => filter["#h"]?.includes("a"));
    expect(retry).toHaveLength(2);
    await h.socket.receive([
      "CLOSED",
      retry[1]?.[1],
      "restricted: channel access revoked",
    ]);
    await settle();
    expect(h.wire.pending).toHaveLength(1);
    h.wire.next().respond(h.memberships);
    await settle();
    h.wire.next().respond([h.archived, ...h.active.slice(1)]);
    await settle();
    expect(h.rows()).toEqual(["b"]);
    expect(h.wire.pending).toHaveLength(0);
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("purges a public nonmember after real CLOSED and omitted metadata, without a metadata EVENT", async () => {
  const h = await setup();
  try {
    // Only a demanded preview enters the existing live transport.
    const resolve = h.owner.session.channels.resolve?.(["open"]);
    await settle();
    h.wire.next().respond([
      signed(h.relay, {
        kind: 39000,
        content: "",
        tags: [["d", "open"], ["public"]],
      }),
    ]);
    await resolve;
    const hit = message(h.viewer, "open", "public content", 1700000000);
    h.owner.session.channels.ensure("open");
    const route = h.socket
      .requests()
      .find(([, , filter]) => filter["#h"]?.includes("open"));
    expect(route).toBeDefined();
    await h.socket.receive(["EVENT", route?.[1], hit]);
    const view = h.owner.session.observe([
      { kinds: [9], "#h": ["open"], limit: 20 },
    ]);
    expect(view.snapshot().events).toHaveLength(1);
    await settle();
    // Finish the demand-owned head before exercising closure.
    h.wire.next().respond([]);
    await settle();
    await h.socket.receive([
      "CLOSED",
      route?.[1],
      "restricted: channel access revoked",
    ]);
    await settle();
    const pending = h.wire.pending.splice(0);
    const resolution = pending.find(({ filters }) =>
      filters.some((filter) => filter["#d"]?.includes("open")),
    );
    expect(resolution?.filters).toMatchObject([
      { kinds: [39000], "#d": ["open"], limit: 2 },
      { kinds: [39002], "#d": ["open"], "#p": [h.viewer.pubkey], limit: 2 },
    ]);
    // Close-before-broadcast means neither membership nor metadata is served.
    resolution?.respond([]);
    await settle();
    expect(h.owner.session.channels.get?.("open")).toBeUndefined();
    expect(
      h.owner.session.channels.list().channels.map(({ id }) => id),
    ).toEqual(["a", "b"]);
    expect(view.snapshot().events).toEqual([]);
    expect(h.owner.session.channels.window("open").rows).toEqual([]);
    for (const request of pending)
      if (request !== resolution) request.respond(h.memberships);
    await settle();
    for (const request of h.wire.pending.splice(0)) request.respond(h.active);
    view.dispose();
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["cancelled", "unavailable"])(
  "keeps two CLOSED public previews hidden through %s rechecks and recovers them through the session owner",
  async (failure) => {
    const h = await setup();
    try {
      const ids = ["open-one", "open-two"];
      const metadata = ids.map((id) =>
        signed(h.relay, {
          kind: 39000,
          content: "",
          tags: [["d", id], ["public"]],
        }),
      );
      const resolve = h.owner.session.channels.resolve?.(ids);
      await settle();
      h.wire.next().respond(metadata);
      await resolve;
      const views = [];
      const routes = [];
      for (const id of ids) {
        h.owner.session.channels.ensure(id);
        const route = h.socket
          .requests()
          .find(([, , filter]) => filter["#h"]?.includes(id));
        routes.push(route);
        await h.socket.receive([
          "EVENT",
          route?.[1],
          message(h.viewer, id, "preview content", 1700000000),
        ]);
        const view = h.owner.session.observe([
          { kinds: [9], "#h": [id], limit: 20 },
        ]);
        expect(view.snapshot().events).toHaveLength(1);
        views.push(view);
        await settle();
        h.wire.next().respond([]);
        await settle();
      }
      // Both routes were live before the relay closed them without metadata EVENTs.
      await h.socket.receive([
        "CLOSED",
        routes[0]?.[1],
        "restricted: channel access revoked",
      ]);
      await settle();
      const first = h.wire.pending.splice(0);
      await h.socket.receive([
        "CLOSED",
        routes[1]?.[1],
        "restricted: channel access revoked",
      ]);
      await settle();
      const second = h.wire.pending.splice(0);
      for (const request of first) request.respond([]);
      if (failure === "cancelled") {
        // The independently scheduled roster revocation invalidates outstanding reads.
        h.live.denied("a", "restricted: not a channel member");
      } else {
        for (const request of second)
          request.fail(new Error("metadata offline"));
      }
      await settle();
      for (const id of ids)
        expect(h.owner.session.channels.get?.(id)).toBeUndefined();
      for (const view of views) expect(view.snapshot().events).toEqual([]);
      expect(h.owner.session.live.snapshot().error).toContain(
        "Public preview access needs rechecking",
      );
      // A failed recheck is not a signed denial. Session recovery owns it: the
      // identical signed public version can restore access on its retry, but it
      // cannot resurrect purged content.
      expect(h.owner.session.live.snapshot().previews).toBe("suspended");
      expect(h.owner.session.recovery?.snapshot().recovering).toBe(true);
      h.owner.session.recovery?.retryNow();
      expect(h.owner.session.live.snapshot().previews).toBe("checking");
      await settle();
      const retry = h.wire.pending.splice(0);
      const preview = retry.find(({ filters }) =>
        filters.some((filter) => filter["#d"]?.includes("open-two")),
      );
      expect(preview).toBeDefined();
      preview?.respond(metadata);
      await settle();
      for (const id of ids)
        expect(h.owner.session.channels.get?.(id)?.readOnly).toBe(true);
      expect(h.owner.session.live.snapshot().error).toBeUndefined();
      expect(h.owner.session.live.snapshot().previews).toBeUndefined();
      for (const view of views) {
        expect(view.snapshot().events).toEqual([]);
        view.dispose();
      }
    } finally {
      h.owner.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);
