import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Host, HostResponse } from "../../../features/host/service";
import { createOAuthSession } from "../oauth/session";
import { deferred } from "../test-helpers";
import { createAgentClient } from "./client";

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
const row = {
  agent_id: "agent-1",
  agent_name: "Helper",
  agent_pubkey: "ab".repeat(32),
  status: "AGENT_STATUS_ACTIVE",
};
const response = (value: unknown, status = 200): HostResponse => ({
  status,
  headers: {},
  body: JSON.stringify(value),
});
async function fixture(subject = "user") {
  const session = createOAuthSession(async () => ({
    value: "secret",
    account: { subject, email: "a@example.com" },
  }));
  await session.signIn();
  const host: Host = {
    runCommand: vi.fn(),
    request: vi.fn(async () =>
      response({ status: "LIST_AGENTS_STATUS_SUCCESS", agents: [row] }),
    ),
  };
  return {
    session,
    host,
    client: createAgentClient(host, session),
    retain: vi.fn(),
    signal: new AbortController().signal,
  };
}
it("lists the authenticated account through the configured native host", async () => {
  const h = await fixture();
  vi.mocked(h.host.request).mockResolvedValueOnce(
    response({
      status: 1,
      agents: [{ ...row, agent_instructions: "Review carefully." }],
    }),
  );
  expect(await h.client.list(h.signal)).toEqual([
    {
      id: row.agent_id,
      name: row.agent_name,
      pubkey: row.agent_pubkey,
      status: "Active",
      instructions: "Review carefully.",
    },
  ]);
  expect(h.host.request).toHaveBeenCalledWith({
    url: "https://builderlab.example/api/goose/v3/beekeeper/list-agents",
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-BB-Session-Credential": "secret",
    },
    body: JSON.stringify({ include_instructions: true }),
  });
});
it.each([{}, { agents: [] }])(
  "accepts an empty protobuf list %j",
  async (value) => {
    const h = await fixture();
    vi.mocked(h.host.request).mockResolvedValue(
      response({ status: 1, ...value }),
    );
    expect(await h.client.list(h.signal)).toEqual([]);
  },
);
it.each([
  ["AGENT_STATUS_UNATTESTED", "Unattested"],
  [1, "Unattested"],
  ["AGENT_STATUS_REVOKED", "Revoked"],
  [3, "Revoked"],
  ["FUTURE_STATUS", "Unknown"],
  [undefined, "Unknown"],
])(
  "handles agent status %j without treating unknown as active",
  async (status, expected) => {
    const h = await fixture();
    vi.mocked(h.host.request).mockResolvedValue(
      response({ status: 1, agents: [{ ...row, status }] }),
    );
    expect((await h.client.list(h.signal))[0]?.status).toBe(expected);
  },
);
it.each([
  null,
  { status: 2 },
  { status: 1, agents: {} },
  { status: 1, agents: [null] },
  { status: 1, agents: [{ ...row, agent_pubkey: "bad" }] },
  { status: 1, agents: [{ ...row, agent_instructions: 42 }] },
])("rejects invalid responses %j", async (value) => {
  const h = await fixture();
  vi.mocked(h.host.request).mockResolvedValue(response(value));
  await expect(h.client.list(h.signal)).rejects.toThrow(
    /invalid|did not return/,
  );
});
it.each([401, 403, 500])(
  "reports HTTP %s without disclosing the provider body",
  async (status) => {
    const h = await fixture();
    vi.mocked(h.host.request).mockResolvedValue(
      response({ error: "private-secret" }, status),
    );
    const error = await h.client.list(h.signal).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("private-secret");
    expect(h.session.snapshot().status).toBe(
      status === 401 ? "signed-out" : "signed-in",
    );
  },
);
it.each(["sign-out", "new-login", "cancel", "dispose"])(
  "discards a held result after %s",
  async (action) => {
    const h = await fixture();
    const held = deferred<HostResponse>();
    vi.mocked(h.host.request).mockReturnValue(held.promise);
    const controller = new AbortController();
    const pending = h.client.list(controller.signal);
    if (action === "cancel") controller.abort();
    else if (action === "dispose") h.session.dispose();
    else {
      h.session.signOut();
      if (action === "new-login") await h.session.signIn();
    }
    held.resolve(
      response(
        { status: 1, agents: [row] },
        action === "new-login" ? 401 : 200,
      ),
    );
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    if (action === "new-login")
      expect(h.session.snapshot().status).toBe("signed-in");
  },
);
it("does not dispatch signed-out or canceled requests", async () => {
  const h = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(h.client.list(controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  h.session.signOut();
  await expect(h.client.list(h.signal)).rejects.toThrow("Sign in");
  expect(h.host.request).not.toHaveBeenCalled();
});

const proof = ["auth", "cd".repeat(32), "", "ef".repeat(64)] as const;
const remoteAgent = {
  id: row.agent_id,
  name: row.agent_name,
  pubkey: row.agent_pubkey,
  status: "Active",
} as const;
it("replaces instructions verbatim through the authenticated host", async () => {
  const h = await fixture();
  const instructions = "  Review carefully.\nPreserve formatting.\n";
  vi.mocked(h.host.request).mockResolvedValue(response({}));
  await h.client.updateInstructions(remoteAgent, instructions, h.signal);
  expect(h.host.request).toHaveBeenCalledWith({
    url: "https://builderlab.example/api/goose/v3/beekeeper/update-agent",
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-BB-Session-Credential": "secret",
    },
    body: JSON.stringify({
      agent_pubkey: row.agent_pubkey,
      agent_instructions: instructions,
    }),
  });
});
it.each([
  { instructions: "", purpose: "empty clearing", accepted: true },
  {
    instructions: "x".repeat(20_000),
    purpose: "maximum length",
    accepted: true,
  },
  { instructions: "   ", purpose: "blank", accepted: false },
  { instructions: "x".repeat(20_001), purpose: "oversized", accepted: false },
])(
  "validates $purpose instructions before dispatch",
  async ({ instructions, accepted }) => {
    const h = await fixture();
    vi.mocked(h.host.request).mockResolvedValue(response({}));
    if (accepted) {
      await h.client.updateInstructions(remoteAgent, instructions, h.signal);
      expect(h.host.request).toHaveBeenCalledOnce();
      expect(
        JSON.parse(vi.mocked(h.host.request).mock.calls[0]?.[0].body ?? "{}")
          .agent_instructions,
      ).toBe(instructions);
    } else {
      await expect(
        h.client.updateInstructions(remoteAgent, instructions, h.signal),
      ).rejects.toThrow("Instructions must");
      expect(h.host.request).not.toHaveBeenCalled();
    }
  },
);
it("does not edit inactive agents or invalid identities", async () => {
  const h = await fixture();
  for (const agent of [
    { ...remoteAgent, status: "Unattested" as const },
    { ...remoteAgent, pubkey: "bad" },
  ])
    await expect(
      h.client.updateInstructions(agent, "Review carefully.", h.signal),
    ).rejects.toThrow("Only Active agents");
  expect(h.host.request).not.toHaveBeenCalled();
});
it("deletes through the configured authenticated host", async () => {
  const h = await fixture();
  vi.mocked(h.host.request).mockResolvedValue(
    response({ status: "DELETE_AGENT_STATUS_DELETED" }),
  );
  await h.client.delete(remoteAgent, h.signal);
  expect(h.host.request).toHaveBeenCalledWith({
    url: "https://builderlab.example/api/goose/v3/beekeeper/delete-agent",
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-BB-Session-Credential": "secret",
    },
    body: JSON.stringify({ agent_id: row.agent_id }),
  });
});
it.each([
  [3, undefined],
  ["DELETE_AGENT_STATUS_DISABLED", "disabled"],
  [0, "not confirmed"],
])("handles deletion status %s", async (status, error) => {
  const h = await fixture();
  vi.mocked(h.host.request).mockResolvedValue(response({ status }));
  const deleting = h.client.delete(remoteAgent, h.signal);
  if (error) await expect(deleting).rejects.toThrow(error);
  else await expect(deleting).resolves.toBeUndefined();
});
it("registers with a saved UUID and submits the supplied owner proof", async () => {
  const h = await fixture();
  vi.mocked(h.host.request)
    .mockResolvedValueOnce(
      response({
        status: "REGISTER_AGENT_STATUS_UNATTESTED",
        agent_id: row.agent_id,
        agent_pubkey: row.agent_pubkey,
      }),
    )
    .mockResolvedValueOnce(response({ status: "ATTEST_AGENT_STATUS_ACTIVE" }));
  const agent = await h.client.register(" Helper ", h.signal, h.retain);
  expect(agent).toMatchObject({ name: "Helper", status: "Unattested" });
  const input = vi.mocked(h.host.request).mock.calls[0]?.[0];
  expect(input).toMatchObject({
    url: "https://builderlab.example/api/goose/v3/beekeeper/register-agent",
    method: "POST",
  });
  expect(JSON.parse(input?.body ?? "{}")).toEqual({
    agent_name: "Helper",
    idempotency_key: expect.stringMatching(/^[0-9a-f-]{36}$/),
  });
  await h.client.activate(agent.pubkey, proof, undefined, h.signal);
  expect(h.host.request).toHaveBeenLastCalledWith(
    expect.objectContaining({
      url: expect.stringContaining("/attest-agent"),
      body: JSON.stringify({
        agent_pubkey: row.agent_pubkey,
        owner_auth_tag_json: JSON.stringify(proof),
      }),
    }),
  );
});
it.each(["network", "server", "malformed", "cancel"])(
  "retains the registration UUID after an uncertain %s result",
  async (failure) => {
    const h = await fixture();
    const controller = new AbortController();
    vi.mocked(h.host.request).mockImplementationOnce(async () => {
      if (failure === "network") throw new Error("private transport details");
      if (failure === "cancel") controller.abort();
      return failure === "server" ? response({}, 503) : response({});
    });
    await expect(
      h.client.register("Helper", controller.signal, h.retain),
    ).rejects.toThrow();
    vi.mocked(h.host.request).mockResolvedValueOnce(
      response({
        status: 1,
        agent_id: row.agent_id,
        agent_pubkey: row.agent_pubkey,
      }),
    );
    // A fresh consumer after navigation/restart reuses the persisted intent.
    await createAgentClient(h.host, h.session).register(
      "Helper",
      h.signal,
      h.retain,
    );
    const bodies = vi
      .mocked(h.host.request)
      .mock.calls.map(([input]) => JSON.parse(input.body ?? "{}"));
    expect(bodies[1].idempotency_key).toBe(bodies[0].idempotency_key);
  },
);
it("does not reuse a pending creation for another verified account with the same email", async () => {
  const first = await fixture("account-a");
  vi.mocked(first.host.request).mockRejectedValueOnce(new Error("offline"));
  await expect(
    first.client.register("Helper", first.signal, first.retain),
  ).rejects.toThrow("Retry the same name");
  first.session.signOut();
  const second = await fixture("account-b");
  vi.mocked(second.host.request).mockResolvedValueOnce(
    response({
      status: 1,
      agent_id: row.agent_id,
      agent_pubkey: row.agent_pubkey,
    }),
  );
  await second.client.register("Helper", second.signal, second.retain);
  const oldBody = JSON.parse(
    vi.mocked(first.host.request).mock.calls[0]?.[0].body ?? "{}",
  );
  const newBody = JSON.parse(
    vi.mocked(second.host.request).mock.calls[0]?.[0].body ?? "{}",
  );
  expect(newBody.idempotency_key).not.toBe(oldBody.idempotency_key);
});
it.each([2, 3, 4, 5, "REGISTER_AGENT_STATUS_TOO_MANY_AGENTS"])(
  "reports a terminal registration status %s and allows a fresh retry",
  async (status) => {
    const h = await fixture();
    vi.mocked(h.host.request).mockResolvedValueOnce(response({ status }));
    await expect(
      h.client.register("Helper", h.signal, h.retain),
    ).rejects.toThrow(/disabled|setup|limit|conflicts/);
    vi.mocked(h.host.request).mockResolvedValueOnce(
      response({
        status: 1,
        agent_id: row.agent_id,
        agent_pubkey: row.agent_pubkey,
      }),
    );
    await h.client.register("Helper", h.signal, h.retain);
    const bodies = vi
      .mocked(h.host.request)
      .mock.calls.map(([input]) => JSON.parse(input.body ?? "{}"));
    expect(bodies[1].idempotency_key).not.toBe(bodies[0].idempotency_key);
  },
);
it.each(["", "bad/name", "x".repeat(65)])(
  "does not register invalid name %s",
  async (name) => {
    const h = await fixture();
    await expect(h.client.register(name, h.signal, h.retain)).rejects.toThrow(
      "agent name",
    );
    expect(h.host.request).not.toHaveBeenCalled();
  },
);
it("blocks creation when the intent cannot be stored", async () => {
  const h = await fixture();
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw new Error("full");
    },
  });
  await expect(h.client.register("Helper", h.signal, h.retain)).rejects.toThrow(
    "Could not save",
  );
  expect(h.host.request).not.toHaveBeenCalled();
});
