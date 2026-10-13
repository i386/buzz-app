import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Host, HostResponse } from "../../../features/host/service";
import { createAgentClient } from "../agents/client";
import { createOAuthSession } from "../oauth/session";
import { builderlabType } from "./index";

const pubkey = "ab".repeat(32);
const proof = ["auth", "cd".repeat(32), "", "ef".repeat(64)] as const;
const response = (value: unknown): HostResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify(value),
});
beforeEach(() => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function fixture(subject = "account-a") {
  const session = createOAuthSession(async () => ({
    value: "credential",
    account: { subject, email: "a@example.com" },
  }));
  await session.signIn();
  const request = vi.fn<Host["request"]>();
  const host: Host = { runCommand: vi.fn(), request };
  const client = createAgentClient(host, session);
  const type = builderlabType(client, session);
  if (!type.remote) throw new Error("Missing hosted adapter");
  return {
    request,
    session,
    client,
    remote: type.remote,
    bodies: () =>
      request.mock.calls.map(([input]) => JSON.parse(input.body ?? "{}")),
  };
}
const provision = {
  name: "Helper",
  community: "wss://agent.example",
  signal: new AbortController().signal,
};
const registration = {
  status: 1,
  agent_id: "provider-id",
  agent_pubkey: pubkey,
};
const removal = {
  pubkey,
  community: provision.community,
  signal: provision.signal,
};

it("replays deletion across restart and releases unfinished provisioning only after confirmed removal", async () => {
  const first = await fixture();
  first.request.mockResolvedValueOnce(response(registration));
  await first.remote.provision(provision);
  const firstKey = first.bodies()[0]?.idempotency_key;
  first.session.dispose();

  const restarted = await fixture();
  restarted.request.mockRejectedValueOnce(new Error("offline"));
  await expect(restarted.remote.remove(removal)).rejects.toThrow(
    "Could not reach",
  );
  restarted.request.mockResolvedValueOnce(response(registration));
  await restarted.remote.provision(provision);
  expect(restarted.bodies()[1]?.idempotency_key).toBe(firstKey);
  restarted.request.mockResolvedValue(response({ status: 3 }));
  await restarted.remote.remove(removal);
  await restarted.remote.remove(removal);
  const deletes = restarted.request.mock.calls.slice(2);
  expect(deletes).toHaveLength(2);
  for (const [input] of deletes)
    expect(JSON.parse(input.body ?? "{}")).toEqual({ agent_id: "provider-id" });
  restarted.request.mockResolvedValueOnce(response(registration));
  await restarted.remote.provision(provision);
  expect(restarted.bodies().at(-1)?.idempotency_key).not.toBe(firstKey);
});

it.each(["account", "server"])(
  "refuses activation and deletion through a different %s",
  async (changed) => {
    const first = await fixture();
    first.request.mockResolvedValueOnce(response(registration));
    await first.remote.provision(provision);
    first.session.dispose();
    if (changed === "server")
      vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://other.example");
    const other = await fixture(
      changed === "account" ? "account-b" : "account-a",
    );
    await expect(
      other.remote.activate({ ...provision, pubkey, auth: proof }),
    ).rejects.toThrow("account that created");
    other.session.signOut();
    await expect(other.remote.remove(removal)).rejects.toThrow(
      "account that created",
    );
    expect(other.request).not.toHaveBeenCalled();
  },
);

it("looks up an agent from another device and retains its ID before a failed deletion", async () => {
  const h = await fixture();
  h.request
    .mockResolvedValueOnce(
      response({
        status: 1,
        agents: [
          {
            agent_id: "provider-id",
            agent_pubkey: pubkey,
            agent_name: "Helper",
            status: 2,
          },
        ],
      }),
    )
    .mockRejectedValueOnce(new Error("connection lost"));
  await expect(h.remote.remove(removal)).rejects.toThrow("Could not reach");
  const again = builderlabType(h.client, h.session).remote;
  if (!again) throw new Error("Missing hosted adapter");
  h.request.mockResolvedValueOnce(response({ status: 3 }));
  await again.remove(removal);
  expect(h.request).toHaveBeenLastCalledWith(
    expect.objectContaining({
      body: JSON.stringify({ agent_id: "provider-id" }),
    }),
  );
});

it("does not infer provider deletion from absence in an unrecognized account", async () => {
  const h = await fixture();
  h.request.mockResolvedValueOnce(response({ status: 1, agents: [] }));
  await expect(h.remote.remove(removal)).rejects.toThrow(
    "not found in this Builderlab account",
  );
  expect(h.request).toHaveBeenCalledOnce();
});
