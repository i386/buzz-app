// The Buzz tools' client for a standalone server: holds the agent's key from
// its environment, as a harness agent's is given, and talks to the community's
// HTTP API directly. Reads only files under `root`.
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { decode } from "nostr-tools/nip19";
import { decrypt, encrypt, getConversationKey } from "nostr-tools/nip44";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import { eventsDto } from "../features/relay/events";
import type { BuzzClient, BuzzEvent, Memory, Template, Upload } from "./client";

const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");
const now = () => Math.floor(Date.now() / 1000);
/** The largest image an agent is shown. Claude takes 5 MiB of base64 on its
 * strictest hosts, and base64 is 4 characters per 3 bytes. */
const MEDIA_LIMIT = (5 * 1024 * 1024 * 3) / 4;

/** A BuzzClient whose memory writes give back the event they posted. */
export type NodeClient = Omit<BuzzClient, "remember"> & {
  remember(slug: string, body: string, after: number): Promise<BuzzEvent>;
};

export function nodeClient(
  options: Readonly<{
    relay: string;
    /** The agent's secret key, hex. */
    key: string;
    /** The owner's NIP-OA `auth` tag, as JSON. */
    auth?: string;
    /** Files outside it cannot be read. */
    root: string;
  }>,
): NodeClient {
  const secret = options.key.startsWith("nsec1")
    ? (decode(options.key as `nsec1${string}`).data as Uint8Array)
    : hexToBytes(options.key);
  const pubkey = getPublicKey(secret);
  const base = options.relay.replace(/^ws/, "http").replace(/\/+$/, "");
  const auth = options.auth
    ? (JSON.parse(options.auth) as string[])
    : undefined;
  const owner = auth?.[1];
  const sign = (event: Template, createdAt = now()) =>
    finalizeEvent(
      {
        kind: event.kind,
        content: event.content,
        tags: event.tags.map((tag) => [...tag]),
        created_at: createdAt,
      },
      secret,
    ) as BuzzEvent;
  // NIP-98 takes standard base64; Blossom takes it URL-safe and unpadded.
  const header = (event: BuzzEvent, encoding: "base64" | "base64url") =>
    `Nostr ${Buffer.from(JSON.stringify(event)).toString(encoding)}`;

  async function request(path: string, body: string) {
    const url = `${base}${path}`;
    const nip98 = sign({
      kind: 27235,
      content: "",
      tags: [
        ["u", url],
        ["method", "POST"],
        ["payload", sha256(body)],
        ["nonce", randomUUID()],
      ],
    });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: header(nip98, "base64"),
        "content-type": "application/json",
        ...(options.auth ? { "x-auth-tag": options.auth } : {}),
      },
      body,
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`${response.status} ${text.slice(0, 300)}`.trim());
    return JSON.parse(text) as unknown;
  }

  async function post(event: BuzzEvent) {
    const reply = (await request("/events", JSON.stringify(event))) as {
      accepted?: boolean;
      message?: string;
    };
    if (!reply.accepted && !reply.message?.startsWith("duplicate"))
      throw new Error(reply.message || "The community refused the event");
    return event;
  }

  const conversation = () => {
    if (!owner) throw new Error("Memory needs BUZZ_AUTH_TAG");
    return getConversationKey(secret, owner);
  };

  return {
    pubkey,
    query: async (filters) =>
      eventsDto(await request("/query", JSON.stringify(filters))),
    publish(event) {
      const tags = event.tags.filter(
        (tag) => tag[0] !== "auth" && tag[0] !== "ms",
      );
      if (tags.some((tag) => tag[0] === "h"))
        tags.push(["ms", String(Date.now() % 1000)]);
      if (auth) tags.push(auth);
      return post(sign({ ...event, tags }));
    },
    async upload(data, mime) {
      const hash = sha256(data);
      const blossom = sign({
        kind: 24242,
        content: "Upload file",
        tags: [
          ["t", "upload"],
          ["x", hash],
          ["expiration", String(now() + 60)],
          ["server", new URL(base).host],
        ],
      });
      const response = await fetch(`${base}/upload`, {
        method: "PUT",
        headers: {
          authorization: header(blossom, "base64url"),
          "content-type": mime,
          "x-sha-256": hash,
          ...(options.auth ? { "x-auth-tag": options.auth } : {}),
        },
        body: data as Uint8Array<ArrayBuffer>,
      });
      const text = await response.text();
      if (!response.ok)
        throw new Error(
          `Upload failed: ${response.status} ${text.slice(0, 300)}`,
        );
      return JSON.parse(text) as Upload;
    },
    async media(input) {
      // Only the community's own media, so the signature goes nowhere else.
      const prefix = `${base}/media/`;
      const name = input.trim().startsWith(prefix)
        ? input.trim().slice(prefix.length)
        : input.trim();
      if (!/^[0-9a-f]{64}(\.[a-z0-9]{1,8}|\.thumb\.jpg)?$/.test(name))
        throw new Error("Agents fetch only their community's media");
      const blossom = sign({
        kind: 24242,
        content: "Get media",
        tags: [
          ["t", "get"],
          ["expiration", String(now() + 60)],
          ["server", new URL(base).host],
        ],
      });
      const response = await fetch(`${base}/media/${name}`, {
        headers: {
          authorization: header(blossom, "base64url"),
          ...(options.auth ? { "x-auth-tag": options.auth } : {}),
        },
        redirect: "error",
      });
      // Read within the limit before the status, so no body is unbounded.
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > MEDIA_LIMIT)
          throw new Error("Media over 3.75 MiB cannot be shown");
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (!response.ok)
        throw new Error(
          `Media failed: ${response.status} ${bytes.subarray(0, 300).toString()}`,
        );
      if (!name.endsWith(".thumb.jpg") && sha256(bytes) !== name.slice(0, 64))
        throw new Error("Media did not match its SHA-256");
      return bytes.toString("base64");
    },
    async read(path) {
      const full = await realpath(resolve(options.root, path));
      const inside = relative(await realpath(options.root), full);
      if (inside.startsWith("..") || isAbsolute(inside))
        throw new Error(`${path} is outside ${options.root}`);
      return new Uint8Array(await readFile(full));
    },
    async memories() {
      const key = conversation();
      const events = eventsDto(
        await request(
          "/query",
          JSON.stringify([
            { kinds: [30174], authors: [pubkey], "#p": [owner], limit: 5000 },
          ]),
        ),
      );
      const heads = new Map<string, BuzzEvent>();
      for (const event of events) {
        const d = event.tags.find((tag) => tag[0] === "d")?.[1];
        if (!d) continue;
        const head = heads.get(d);
        if (
          !head ||
          head.created_at < event.created_at ||
          (head.created_at === event.created_at && event.id < head.id)
        )
          heads.set(d, event);
      }
      const entries: Memory[] = [];
      for (const event of heads.values()) {
        try {
          const entry = JSON.parse(decrypt(event.content, key));
          const body = entry.slug === "core" ? entry.profile : entry.value;
          if (typeof entry.slug === "string" && typeof body === "string")
            entries.push({
              slug: entry.slug,
              body,
              createdAt: event.created_at,
            });
        } catch {}
      }
      return entries.sort((a, b) => a.slug.localeCompare(b.slug));
    },
    async remember(slug, body, after) {
      const key = conversation();
      const d = createHmac("sha256", key)
        .update(`agent-memory/v1/d-tag\0${slug}`)
        .digest("hex");
      const plaintext = JSON.stringify(
        slug === "core" ? { slug, profile: body } : { slug, value: body },
      );
      return post(
        sign(
          {
            kind: 30174,
            content: encrypt(plaintext, key),
            tags: [
              ["d", d],
              ["p", owner as string],
            ],
          },
          Math.max(now(), after + 1),
        ),
      );
    },
  };
}
