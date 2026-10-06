import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Host, HostResponse } from "../../../features/host/service";
import { createOAuthSession } from "../oauth/session";
import { createKnownCommunitiesClient } from "./client";

beforeEach(() => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
});
afterEach(() => {
  vi.unstubAllEnvs();
});
const pubkey = "ab".repeat(32);
const url = "wss://primary.example";
const op = {
  operationId: "0f3d6b1e-6d2a-4f5b-9c1e-2a7d8e9f0a1b",
  url,
  expectedRevision: 2,
  removed: false,
};
const row = { relay_url: url, revision: 3, removed: false };
const response = (body: unknown, status = 200): HostResponse => ({
  status,
  headers: {},
  body: typeof body === "string" ? body : JSON.stringify(body),
});
async function fixture(reply: HostResponse | (() => Promise<HostResponse>)) {
  const session = createOAuthSession(async () => ({
    value: "secret",
    account: { subject: "user", email: "a@example.com" },
  }));
  await session.signIn();
  const host: Host = {
    runCommand: vi.fn(),
    request: vi.fn(async () => (typeof reply === "function" ? reply() : reply)),
  };
  return {
    session,
    host,
    client: createKnownCommunitiesClient(host, session),
    signal: new AbortController().signal,
  };
}

it("reads the account's bound key under the session credential", async () => {
  const h = await fixture(response({ identity: { pubkey_hex: pubkey } }));
  expect(await h.client.identity(h.signal)).toEqual({
    kind: "identity",
    pubkey,
  });
  expect(h.host.request).toHaveBeenCalledWith({
    url: "https://builderlab.example/api/goose/v1/buzz/nostr-identities/current",
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-BB-Session-Credential": "secret",
    },
    body: "{}",
  });
});

it.each([
  { name: "an unbound account", body: {}, result: { kind: "identity" } },
  {
    name: "an explicit null identity",
    body: { identity: null },
    result: { kind: "identity" },
  },
  {
    // This route answers its refusal as an object, unlike the sync routes.
    name: "the framework's refusal",
    body: { error: { code: "UNAUTHORIZED" } },
    status: 403,
    result: { kind: "forbidden" },
  },
])("identity reports $name", async ({ body, status, result }) => {
  const h = await fixture(response(body, status));
  expect(await h.client.identity(h.signal)).toEqual(result);
});

it.each([
  { name: "a malformed key", body: { identity: { pubkey_hex: "XYZ" } } },
  {
    name: "an uppercase key",
    body: { identity: { pubkey_hex: "AB".repeat(32) } },
  },
])("identity rejects $name", async ({ body }) => {
  const h = await fixture(response(body));
  await expect(h.client.identity(h.signal)).rejects.toThrow(
    "Builderlab returned an invalid response.",
  );
});

it("lists every record the service holds, tombstones and int64 strings included", async () => {
  const h = await fixture(
    response({
      communities: [
        row,
        { relay_url: "wss://gone.example:8443", revision: "7", removed: true },
        { relay_url: "wss://fresh.example", revision: 0 },
      ],
    }),
  );
  expect(await h.client.list(pubkey, h.signal)).toEqual({
    kind: "listed",
    communities: [
      { url, revision: 3, removed: false },
      { url: "wss://gone.example:8443", revision: 7, removed: true },
      { url: "wss://fresh.example", revision: 0, removed: false },
    ],
  });
  expect(h.host.request).toHaveBeenCalledWith(
    expect.objectContaining({
      url: "https://builderlab.example/api/goose/v1/buzz/known-communities/list",
      body: JSON.stringify({ pubkey_hex: pubkey }),
    }),
  );
});

it("reads an omitted repeated field as an empty list", async () => {
  const h = await fixture(response({}));
  expect(await h.client.list(pubkey, h.signal)).toEqual({
    kind: "listed",
    communities: [],
  });
});

it.each([
  { relay_url: "https://primary.example", revision: 1, removed: false },
  { relay_url: url, revision: -1, removed: false },
  { relay_url: url, revision: 1.5, removed: false },
  { relay_url: url, revision: 1, removed: "yes" },
  { revision: 1, removed: false },
  "not a record",
])("rejects a list holding %j", async (entry) => {
  const h = await fixture(response({ communities: [row, entry] }));
  await expect(h.client.list(pubkey, h.signal)).rejects.toThrow(
    "Builderlab returned an invalid response.",
  );
});

it.each([
  {
    name: "a JSON refusal",
    body: { error: "identity_mismatch" },
    status: 409,
    kind: "identity_mismatch",
  },
  {
    name: "a plain-text framework refusal",
    body: "Forbidden",
    status: 403,
    kind: "forbidden",
  },
  {
    name: "a JSON invalid request",
    body: { error: "invalid_request" },
    status: 400,
    kind: "invalid_request",
  },
  {
    name: "a plain-text bad request",
    body: "Bad Request",
    status: 400,
    kind: "invalid_request",
  },
])("list returns $name as a refusal", async ({ body, status, kind }) => {
  const h = await fixture(response(body, status));
  expect(await h.client.list(pubkey, h.signal)).toEqual({ kind });
});

it("sends a queued operation exactly as queued and adopts the accepted record", async () => {
  const h = await fixture(response({ community: row }));
  expect(await h.client.update(pubkey, op, h.signal)).toEqual({
    kind: "accepted",
    record: { url, revision: 3, removed: false },
  });
  expect(h.host.request).toHaveBeenCalledWith(
    expect.objectContaining({
      url: "https://builderlab.example/api/goose/v1/buzz/known-communities/update",
      body: JSON.stringify({
        pubkey_hex: pubkey,
        relay_url: url,
        expected_revision: 2,
        operation_id: op.operationId,
        removed: false,
      }),
    }),
  );
});

it("sends removed explicitly on a removal too", async () => {
  const h = await fixture(response({ community: { ...row, removed: true } }));
  await h.client.update(pubkey, { ...op, removed: true }, h.signal);
  expect(
    JSON.parse(vi.mocked(h.host.request).mock.calls[0]?.[0].body as string),
  ).toMatchObject({ removed: true });
});

it.each([
  {
    name: "with the current record",
    body: { error: "revision_conflict", community: { ...row, revision: 9 } },
    result: {
      kind: "revision_conflict",
      record: { url, revision: 9, removed: false },
    },
  },
  {
    name: "without a record",
    body: { error: "revision_conflict" },
    result: { kind: "revision_conflict" },
  },
])("reports a revision conflict $name", async ({ body, result }) => {
  const h = await fixture(response(body, 409));
  expect(await h.client.update(pubkey, op, h.signal)).toEqual(result);
});

it.each([
  { name: "an accepted reply without a record", body: {}, status: 200 },
  {
    name: "an accepted reply with a malformed record",
    body: { community: { relay_url: url } },
    status: 200,
  },
  {
    name: "a conflict carrying a malformed record",
    body: { error: "revision_conflict", community: { relay_url: url } },
    status: 409,
  },
])("update rejects $name", async ({ body, status }) => {
  const h = await fixture(response(body, status));
  await expect(h.client.update(pubkey, op, h.signal)).rejects.toThrow(
    "Builderlab returned an invalid response.",
  );
});

it.each([
  { body: { error: "limit_reached" }, status: 422, kind: "limit_reached" },
  { body: "Unprocessable Entity", status: 422, kind: "limit_reached" },
  {
    body: { error: "identity_mismatch" },
    status: 409,
    kind: "identity_mismatch",
  },
  { body: { error: "forbidden" }, status: 403, kind: "forbidden" },
  { body: "<html>Forbidden</html>", status: 403, kind: "forbidden" },
  { body: { error: "invalid_request" }, status: 400, kind: "invalid_request" },
])(
  "update returns HTTP $status $body as $kind",
  async ({ body, status, kind }) => {
    const h = await fixture(response(body, status));
    expect(await h.client.update(pubkey, op, h.signal)).toEqual({ kind });
  },
);

it.each([415, 500, 502])(
  "surfaces an unexpected HTTP %i as a failure that keeps the operation",
  async (status) => {
    const h = await fixture(response("Unsupported", status));
    await expect(h.client.update(pubkey, op, h.signal)).rejects.toMatchObject({
      message: `Builderlab request failed (HTTP ${status}).`,
      status,
    });
    expect(h.session.snapshot().status).toBe("signed-in");
  },
);

it("treats a 401 as the end of the session and cancels rather than failing", async () => {
  const h = await fixture(response("Unauthorized", 401));
  await expect(h.client.list(pubkey, h.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(h.session.snapshot().status).toBe("signed-out");
});

it("names an unreachable service while the session stands, and cancels once it changed", async () => {
  const h = await fixture(() => Promise.reject(new Error("socket hang up")));
  await expect(h.client.list(pubkey, h.signal)).rejects.toThrow(
    "Couldn’t reach Builderlab.",
  );
  const late = await fixture(async () => {
    late.session.signOut();
    throw new Error("socket hang up");
  });
  await expect(late.client.list(pubkey, late.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(late.host.request).toHaveBeenCalledTimes(1);
});

it("does not request under an aborted signal or a signed-out session", async () => {
  const h = await fixture(response({ community: row }));
  const controller = new AbortController();
  controller.abort();
  await expect(
    h.client.update(pubkey, op, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  h.session.signOut();
  await expect(h.client.update(pubkey, op, h.signal)).rejects.toThrow(
    "Sign in to Builderlab first.",
  );
  expect(h.host.request).not.toHaveBeenCalled();
});
