// End-to-end checks against a real Buzz relay, for example the docker compose
// stack. Skipped unless BUZZ_E2E_RELAY_URL names the relay's https origin.
// For a relay behind a private CA, start vitest with NODE_EXTRA_CA_CERTS.
//
//   BUZZ_E2E_RELAY_URL=https://localhost:3443 \
//   NODE_EXTRA_CA_CERTS=caddy-root.crt \
//   pnpm exec vitest run src/features/relay/container-relay.e2e.test.ts
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import type { ViteDevServer } from "vite";
import { afterAll, assert, expect, it, vi } from "vitest";
import { relayBrokerPlugin } from "../../../browser-host/relay-broker.mjs";
import { openBrokerSocket } from "../../../tests/broker-socket.mjs";
import { connectBrokerTransport } from "./transport";
import { createRelaySession } from "./session";
import { keypair } from "./testing";

const relayUrl = process.env.BUZZ_E2E_RELAY_URL;
// Channel setup keeps local receipts; Node has no localStorage of its own.
const stored = new Map<string, string>();
vi.stubGlobal("localStorage", {
  get length() {
    return stored.size;
  },
  key: (index: number) => [...stored.keys()][index] ?? null,
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
  removeItem: (key: string) => void stored.delete(key),
  clear: () => stored.clear(),
});
const cleanup: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** One viewer's real broker (real upstream fetch and socket) and session. */
async function viewerSession() {
  assert.exists(relayUrl);
  const key = keypair();
  let handler: RequestListener | undefined;
  const server = createServer((req, res) => {
    req.headers.origin = `http://${req.headers.host}`;
    handler?.(req, res);
  });
  const plugin = relayBrokerPlugin({
    archiveFile: ":memory:",
    relayUrl,
    identity: () => key.secret,
  });
  await (plugin.configureServer as (server: ViteDevServer) => Promise<void>)({
    httpServer: server,
    config: { logger: { info() {}, error() {} } },
    middlewares: {
      use(callback: RequestListener) {
        handler = callback;
      },
    },
  } as unknown as ViteDevServer);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const transport = await connectBrokerTransport(base);
  const live = await openBrokerSocket(transport);
  const owner = createRelaySession(
    { ...transport, subscribe: undefined } as unknown as typeof transport,
    { outboxStorage: { load: () => [], save() {} } },
  );
  cleanup.push(async () => {
    owner.dispose();
    live.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { key, session: owner.session };
}

it.skipIf(!relayUrl)(
  "creates, finds, relabels and clears NIP-CL labels on a real relay",
  { timeout: 60_000 },
  async () => {
    const alice = await viewerSession();
    const bob = await viewerSession();
    const label = `e2e-${Date.now().toString(36)}`;
    const create = (name: string) =>
      alice.session.channelCreation.create({
        name,
        visibility: "open",
        labels: [label, "app:e2e"],
      });
    const first = await create("labels first");
    // created_at has one-second resolution; make "oldest" unambiguous.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await create("labels second");
    console.info("[e2e] created", { label, first, second });

    // Another reader finds both, oldest first, with relay-written identity.
    const find = (who: typeof alice, query = label) =>
      who.session.channels.findLabeled?.({
        creator: alice.key.pubkey,
        label: query,
      });
    let found = await find(bob);
    expect(found?.map(({ id }) => id)).toEqual([first, second]);
    expect(found?.[0]).toMatchObject({
      creator: alice.key.pubkey,
      labels: [label, "app:e2e"],
    });
    assert.isNumber(found?.[0]?.createdAt);
    console.info("[e2e] bob found", found);
    // A different creator has no such channels.
    expect(
      await bob.session.channels.findLabeled?.({
        creator: bob.key.pubkey,
        label,
      }),
    ).toEqual([]);

    // The owner replaces the set: the first channel drops the shared label.
    const details = alice.session.channelDetails;
    await vi.waitFor(() => details.load(first), { timeout: 10_000 });
    const loaded = await details.load(first);
    expect(loaded.labels).toEqual([label, "app:e2e"]);
    await details.save(loaded, { ...loaded, labels: ["app:e2e", "moved"] });
    found = await find(bob);
    expect(found?.map(({ id }) => id)).toEqual([second]);
    expect((await find(bob, "moved"))?.map(({ id }) => id)).toEqual([first]);

    // Saving other details leaves the labels alone.
    const relabeled = await details.load(first);
    await details.save(relabeled, {
      ...relabeled,
      description: "still labeled",
      labels: undefined,
    });
    expect((await details.load(first)).labels).toEqual(["app:e2e", "moved"]);

    // An empty set clears every label.
    const before = await details.load(first);
    await details.save(before, { ...before, labels: [] });
    expect((await details.load(first)).labels).toEqual([]);
    expect(await find(bob, "moved")).toEqual([]);
    console.info("[e2e] relabel and clear confirmed");
  },
);
