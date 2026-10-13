import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { bytesToHex } from "nostr-tools/utils";
import { keypair, signed } from "../features/relay/testing";
import { nodeClient } from "./node";

const agent = keypair();
const owner = keypair();
let stored: unknown[];
let response: (() => unknown) | undefined;

// A community that keeps what is posted and answers every query with all of it.
beforeEach(() => {
  stored = [];
  response = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/events")) stored.push(JSON.parse(String(init.body)));
      const body = url.endsWith("/events")
        ? { accepted: true }
        : (response?.() ?? stored);
      return new Response(JSON.stringify(body));
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const client = () =>
  nodeClient({
    relay: "wss://relay.test",
    key: bytesToHex(agent.secret),
    auth: JSON.stringify(["auth", owner.pubkey, "", "0".repeat(128)]),
    root: "/",
  });
const message = signed(owner, { kind: 9, content: "hi", tags: [["h", "c"]] });

it("returns verified events from a query", async () => {
  response = () => [message];
  expect(await client().query([{ kinds: [9] }])).toMatchObject([
    { id: message.id, content: "hi" },
  ]);
});

it.each([
  ["a forged signature", () => [{ ...message, sig: "0".repeat(128) }]],
  ["edited content", () => [{ ...message, content: "bye" }]],
  ["a malformed record", () => [{ ...message, pubkey: "me" }]],
  ["a non-array body", () => ({ events: [message] })],
])("rejects a query answered with %s", async (_, body) => {
  response = body;
  await expect(client().query([{ kinds: [9] }])).rejects.toThrow(
    /malformed or invalidly signed|not an event array/,
  );
});

it("reads back its memory and rejects a tampered entry", async () => {
  const buzz = client();
  await buzz.remember("mem/notes", "keep this", 0);
  expect(await buzz.memories()).toMatchObject([
    { slug: "mem/notes", body: "keep this" },
  ]);

  // The newest head would win if its signature went unchecked.
  const entry = stored[0] as { created_at: number };
  stored.push({ ...entry, created_at: entry.created_at + 1 });
  await expect(buzz.memories()).rejects.toThrow(/invalidly signed/);
});

it("fetches only its community's media, signed for a get", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const fetch = vi.mocked(globalThis.fetch);
  fetch.mockResolvedValueOnce(new Response(bytes));
  await expect(
    client().media(`https://relay.test/media/${sha}.png`),
  ).resolves.toBe(btoa("\x01\x02\x03"));
  const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
  expect(url).toBe(`https://relay.test/media/${sha}.png`);
  const header = (init.headers as Record<string, string>).authorization ?? "";
  const auth = JSON.parse(
    Buffer.from(header.replace("Nostr ", ""), "base64url").toString(),
  );
  expect(auth).toMatchObject({ kind: 24242, pubkey: agent.pubkey });
  expect(auth.tags).toContainEqual(["t", "get"]);
  expect(auth.tags).toContainEqual(["server", "relay.test"]);
  for (const input of [
    `https://elsewhere.test/media/${sha}.png`,
    `${sha}/../x`,
    "not-a-hash",
  ])
    await expect(client().media(input)).rejects.toThrow(
      "only their community's media",
    );
  expect(fetch).toHaveBeenCalledTimes(1);
  // The largest body whose base64 fits Claude's 5 MiB is past the size check.
  fetch.mockResolvedValueOnce(new Response(new Uint8Array(3_932_160)));
  await expect(client().media(sha)).rejects.toThrow("match its SHA-256");
  fetch.mockResolvedValueOnce(new Response(new Uint8Array(3_932_161)));
  await expect(client().media(sha)).rejects.toThrow("over 3.75 MiB");
  fetch.mockResolvedValueOnce(
    new Response(new Uint8Array(3_932_161), { status: 500 }),
  );
  await expect(client().media(sha)).rejects.toThrow("over 3.75 MiB");
  fetch.mockResolvedValueOnce(new Response("denied", { status: 401 }));
  await expect(client().media(sha)).rejects.toThrow("Media failed: 401 denied");
  const wrongHash = "a".repeat(64);
  fetch.mockResolvedValueOnce(new Response(bytes));
  await expect(client().media(wrongHash)).rejects.toThrow(
    "Media did not match its SHA-256",
  );
  fetch.mockResolvedValueOnce(new Response(bytes));
  await expect(client().media(`${wrongHash}.thumb.jpg`)).resolves.toBe(
    btoa("\x01\x02\x03"),
  );
});
