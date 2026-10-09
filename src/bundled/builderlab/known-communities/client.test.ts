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
const url = "wss://primary.example";
const route = (path: string) =>
  `https://builderlab.example/api/goose/v1/buzz/known-communities/${path}`;
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

it("lists every destination the account holds under the session credential", async () => {
  const h = await fixture(
    response({
      communities: [{ relay_url: url }, { relay_url: "wss://b.example:8443" }],
    }),
  );
  expect(await h.client.list(h.signal)).toEqual({
    kind: "listed",
    communities: [url, "wss://b.example:8443"],
  });
  expect(h.host.request).toHaveBeenCalledWith({
    url: route("list"),
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-BB-Session-Credential": "secret",
    },
    body: "{}",
  });
});

it("reads an omitted repeated field as an empty list", async () => {
  const h = await fixture(response({}));
  expect(await h.client.list(h.signal)).toEqual({
    kind: "listed",
    communities: [],
  });
});

it.each([
  { relay_url: "https://primary.example" },
  { relay_url: 7 },
  {},
  "not a record",
  null,
])("rejects a list holding %j", async (entry) => {
  const h = await fixture(
    response({ communities: [{ relay_url: url }, entry] }),
  );
  await expect(h.client.list(h.signal)).rejects.toThrow(
    "Builderlab returned an invalid response.",
  );
});

it.each([
  {
    name: "a plain-text framework refusal",
    body: "Forbidden",
    status: 403,
    kind: "forbidden",
  },
  {
    name: "a JSON refusal",
    body: { error: "forbidden" },
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
  expect(await h.client.list(h.signal)).toEqual({ kind });
});

it("adds and removes one destination by its address, taking the status as the answer", async () => {
  const added = await fixture(response({ community: { relay_url: url } }));
  expect(await added.client.add(url, added.signal)).toEqual({
    kind: "accepted",
  });
  expect(added.host.request).toHaveBeenCalledWith(
    expect.objectContaining({
      url: route("add"),
      body: JSON.stringify({ relay_url: url }),
    }),
  );
  const removed = await fixture(response({}));
  expect(await removed.client.remove(url, removed.signal)).toEqual({
    kind: "accepted",
  });
  expect(removed.host.request).toHaveBeenCalledWith(
    expect.objectContaining({
      url: route("remove"),
      body: JSON.stringify({ relay_url: url }),
    }),
  );
});

it.each([
  { body: { error: "limit_reached" }, status: 422, kind: "limit_reached" },
  { body: "Unprocessable Entity", status: 422, kind: "limit_reached" },
  { body: { error: "forbidden" }, status: 403, kind: "forbidden" },
  { body: "<html>Forbidden</html>", status: 403, kind: "forbidden" },
  { body: { error: "invalid_request" }, status: 400, kind: "invalid_request" },
])(
  "add and remove return HTTP $status $body as $kind",
  async ({ body, status, kind }) => {
    const h = await fixture(response(body, status));
    expect(await h.client.add(url, h.signal)).toEqual({ kind });
    expect(await h.client.remove(url, h.signal)).toEqual({ kind });
  },
);

it.each([408, 429, 500, 502])(
  "surfaces HTTP %i as a failure to retry that keeps the intent",
  async (status) => {
    const h = await fixture(response("Unavailable", status));
    await expect(h.client.add(url, h.signal)).rejects.toMatchObject({
      message: `Builderlab request failed (HTTP ${status}).`,
      status,
    });
    expect(h.session.snapshot().status).toBe("signed-in");
  },
);

it.each([404, 405, 409, 415])(
  "returns an unnamed HTTP %i as a rejection of the request as sent, on every route",
  async (status) => {
    const h = await fixture(response("Refused", status));
    const rejected = { kind: "rejected", status };
    expect(await h.client.add(url, h.signal)).toEqual(rejected);
    expect(await h.client.remove(url, h.signal)).toEqual(rejected);
    expect(await h.client.list(h.signal)).toEqual(rejected);
    expect(h.session.snapshot().status).toBe("signed-in");
  },
);

it("treats a 401 as the end of the session and cancels rather than failing", async () => {
  const h = await fixture(response("Unauthorized", 401));
  await expect(h.client.list(h.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(h.session.snapshot().status).toBe("signed-out");
});

it("names an unreachable service while the session stands, and cancels once it changed", async () => {
  const h = await fixture(() => Promise.reject(new Error("socket hang up")));
  await expect(h.client.list(h.signal)).rejects.toThrow(
    "Couldn’t reach Builderlab.",
  );
  const late = await fixture(async () => {
    late.session.signOut();
    throw new Error("socket hang up");
  });
  await expect(late.client.list(late.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(late.host.request).toHaveBeenCalledTimes(1);
});

it("does not request under an aborted signal or a signed-out session", async () => {
  const h = await fixture(response({ community: { relay_url: url } }));
  const controller = new AbortController();
  controller.abort();
  await expect(h.client.add(url, controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  h.session.signOut();
  await expect(h.client.add(url, h.signal)).rejects.toThrow(
    "Sign in to Builderlab first.",
  );
  expect(h.host.request).not.toHaveBeenCalled();
});
