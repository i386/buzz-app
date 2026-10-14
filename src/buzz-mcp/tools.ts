// The Buzz tools: what an agent does in Buzz, in the wire formats the `buzz`
// CLI writes. Names, arguments and descriptions are kept short because every
// session pays for them in context. Each tool answers in plain text.
import { decode } from "nostr-tools/nip19";
import type { BuzzClient, BuzzEvent, Context, Upload } from "./client";

const str = { type: "string" } as const;
const strs = { type: "array", items: str } as const;
const int = { type: "integer" } as const;
const tool = (
  name: string,
  description: string,
  properties: Readonly<Record<string, object>>,
  required: readonly string[] = [],
) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  },
});

export type Tool = ReturnType<typeof tool>;
export const TOOLS: readonly Tool[] = [
  tool(
    "send",
    "Post a message. Without channel, replies in the current thread. A reply goes in its message's thread.",
    {
      text: str,
      path: str,
      channel: str,
      reply: str,
      files: strs,
      mentions: strs,
      audience: {
        type: "string",
        enum: ["everyone", "agents"],
        description:
          "agents: only other agents need this (delegating, asking or answering an agent)",
      },
      final: {
        type: "boolean",
        description: "Your last message this turn; ends the turn.",
      },
    },
    ["audience"],
  ),
  tool("edit", "Edit your message.", { id: str, text: str }, ["id", "text"]),
  tool(
    "react",
    "React to a message.",
    { id: str, emoji: str, off: { type: "boolean" } },
    ["id", "emoji"],
  ),
  tool(
    "read",
    "Read a thread (default: current), a channel's latest, or search with q.",
    { channel: str, thread: str, q: str, limit: int, before: int },
  ),
  tool("channels", "Channels you are in.", { q: str }),
  tool("members", "A channel's members.", { channel: str }),
  tool("users", "Profiles by pubkey or name.", { ids: strs, q: str }),
  tool("dm", "Open a DM; returns its channel.", { to: strs }, ["to"]),
  tool("mem_get", "Read memory; without slug, list slugs.", { slug: str }),
  tool("mem_set", "Write memory.", { slug: str, text: str, path: str }, [
    "slug",
  ]),
  tool("canvas", "Read a channel's canvas, or replace it.", {
    channel: str,
    text: str,
    path: str,
  }),
  tool("media_get", "See an image from a Buzz media URL.", { url: str }, [
    "url",
  ]),
];

/** Message kinds as the CLI reads them. */
const MESSAGES = [9, 40002, 40008, 45001, 45003];
const THREAD = [9, 40002, 40008, 45003];
const SEARCH = [9, 40002, 45001, 45003];
const HEX = /^[0-9a-f]{64}$/;

type Args = Readonly<Record<string, unknown>>;
/** A tool's answer: text, or an image (base64 `data`) for the agent to see. */
export type Reply = string | Readonly<{ data: string; type: string }>;
type Handler = (tools: Tools, args: Args) => Promise<Reply>;

/** Runs tool `name` for an agent working in `context`. A throw is a tool
 * error for the agent to correct. */
export function callTool(
  client: BuzzClient,
  context: Context,
  name: string,
  args: Args,
) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`No tool ${name}`);
  return handler(new Tools(client, context), args);
}

const HANDLERS: Readonly<Record<string, Handler>> = {
  async send(tools, args) {
    const { client, context } = tools;
    const reply =
      text(args.reply) ??
      (args.channel === undefined ? context.root : undefined);
    // A reply goes to its message's channel.
    const channel =
      text(args.channel) ??
      (reply && reply !== context.root
        ? tag(await tools.event(reply), "h")
        : undefined) ??
      context.channel;
    if (!channel) throw new Error("channel is required here.");
    if (reply && context.topLevel && channel === context.channel)
      throw new Error(
        "This chat stays at the top level: send again without reply.",
      );
    if (args.audience !== "everyone" && args.audience !== "agents")
      throw new Error("audience must be everyone or agents.");
    const files = await tools.attach(list(args.files));
    const content = `${(await tools.body(args, !files.links)) ?? ""}${files.links}`;
    const thread = reply ? await tools.threadTags(reply) : [];
    const mentions = await tools.mentions(
      channel,
      content,
      list(args.mentions),
    );
    const event = await client.publish({
      kind: 9,
      content,
      tags: [
        ["h", channel],
        ...thread,
        ...mentions.map((pubkey) => ["p", pubkey]),
        ...files.tags,
        ...(args.audience === "agents" ? [["audience", "agents"]] : []),
      ],
    });
    return `sent ${event.id}`;
  },

  async edit(tools, args) {
    const id = required(args, "id");
    const target = await tools.event(id);
    const channel = tag(target, "h");
    if (!channel) throw new Error(`${id} is not a channel message.`);
    await tools.client.publish({
      kind: 40003,
      content: required(args, "text"),
      // An edit replaces the attachments too, so it keeps the message's.
      tags: [
        ["h", channel],
        ["e", id],
        ...target.tags.filter((t) => t[0] === "imeta"),
      ],
    });
    return "edited";
  },

  async react(tools, args) {
    const { client } = tools;
    const id = required(args, "id");
    const emoji = required(args, "emoji");
    if (args.off !== true) {
      await client.publish({ kind: 7, content: emoji, tags: [["e", id]] });
      return "reacted";
    }
    const mine = await client.query([
      { kinds: [7], "#e": [id], authors: [client.pubkey], limit: 100 },
    ]);
    const reaction = mine.find((event) => event.content === emoji);
    if (!reaction) return "no such reaction";
    await client.publish({ kind: 5, content: "", tags: [["e", reaction.id]] });
    return "removed";
  },

  async read(tools, args) {
    const { client, context } = tools;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const before = typeof args.before === "number" ? args.before : undefined;
    const q = text(args.q);
    let channel = text(args.channel) ?? context.channel;
    let events: readonly BuzzEvent[];
    if (q)
      events = await client.query([
        {
          kinds: SEARCH,
          search: q,
          limit: bound(limit, 20, 100),
          ...(args.channel ? { "#h": [channel] } : {}),
          ...(before ? { until: before } : {}),
        },
      ]);
    else if (
      text(args.thread) ||
      (args.channel === undefined && context.root)
    ) {
      const id = text(args.thread) ?? (context.root as string);
      let root = id;
      if (id !== context.root) {
        const event = await tools.event(id);
        root = rootOf(event);
        channel = tag(event, "h") ?? channel;
      }
      if (!channel) throw new Error("channel is required here.");
      events = await client.query([
        {
          kinds: THREAD,
          "#h": [channel],
          "#e": [root],
          limit: bound(limit, 100, 500),
        },
        { ids: [root], kinds: [...THREAD, 45001], limit: 1 },
      ]);
    } else {
      if (!channel) throw new Error("channel is required here.");
      events = await client.query([
        {
          kinds: MESSAGES,
          "#h": [channel],
          limit: bound(limit, 30, 200),
          ...(before ? { until: before } : {}),
        },
      ]);
    }
    // An edit tags only the message it changes, so a thread's are not in it.
    const ids = events.filter((event) => event.kind !== 40003).map((e) => e.id);
    const edits = ids.length
      ? await client.query([{ kinds: [40003], "#e": ids, limit: 500 }])
      : [];
    const messages = edited([...events, ...edits]);
    if (!messages.length) return "No messages.";
    const names = await tools.names(messages.map((event) => event.pubkey));
    return messages
      .map(
        (event) =>
          `${event.id} ${names.get(event.pubkey) ?? event.pubkey} ${time(event.created_at)}: ${event.content}`,
      )
      .join("\n");
  },

  async channels(tools, args) {
    const { client } = tools;
    const memberships = await client.query([
      { kinds: [39002], "#p": [client.pubkey], limit: 500 },
    ]);
    const ids = [
      ...new Set(memberships.map((event) => tag(event, "d")).filter(Boolean)),
    ] as string[];
    if (!ids.length) return "No channels.";
    const channels = await client.query([
      { kinds: [39000], "#d": ids, limit: ids.length },
    ]);
    const q = text(args.q)?.toLowerCase();
    const rows = channels
      .map((event) => {
        const flags = [
          tag(event, "t") === "dm" ? "dm" : "",
          event.tags.some((t) => t[0] === "archived") ? "archived" : "",
        ].filter(Boolean);
        return `${tag(event, "d")} ${tag(event, "name") ?? ""}${flags.length ? ` (${flags.join(", ")})` : ""}`;
      })
      .filter((row) => !q || row.toLowerCase().includes(q));
    return rows.join("\n") || "No channels.";
  },

  async members(tools, args) {
    const channel = text(args.channel) ?? tools.context.channel;
    if (!channel) throw new Error("channel is required here.");
    const members = await tools.members(channel);
    const names = await tools.names(members.map((member) => member.pubkey));
    return members
      .map(
        ({ pubkey, role }) =>
          `${pubkey} ${names.get(pubkey) ?? ""}${role === "member" ? "" : ` (${role})`}`,
      )
      .join("\n");
  },

  async users(tools, args) {
    const { client } = tools;
    const ids = list(args.ids).map(pubkey);
    const q = text(args.q)?.toLowerCase();
    if (!ids.length && !q) throw new Error("Give ids or q.");
    const profiles = await client.query([
      ids.length
        ? { kinds: [0], authors: ids, limit: ids.length }
        : { kinds: [0], search: q, limit: 100 },
    ]);
    const rows = newest(profiles)
      .map((event) => {
        const profile = parse(event.content);
        const name = profileName(profile) ?? "";
        const about =
          typeof profile.about === "string" && profile.about.trim()
            ? ` — ${profile.about.trim().slice(0, 120)}`
            : "";
        return { name, row: `${event.pubkey} ${name}${about}` };
      })
      .filter(({ name }) => !q || ids.length || name.toLowerCase().includes(q));
    return rows.map(({ row }) => row).join("\n") || "No users.";
  },

  async dm(tools, args) {
    const { client } = tools;
    const to = list(args.to).map(pubkey);
    if (!to.length) throw new Error("to is required.");
    const people = new Set([client.pubkey, ...to]);
    const find = async () =>
      (
        await client.query([
          { kinds: [39000], "#p": [client.pubkey], "#t": ["dm"], limit: 500 },
        ])
      ).find((event) => {
        const members = new Set(
          event.tags.filter((t) => t[0] === "p").map((t) => t[1]),
        );
        return (
          members.size === people.size &&
          [...people].every((key) => members.has(key))
        );
      });
    let found = await find();
    if (!found) {
      await client.publish({
        kind: 41010,
        content: "",
        tags: [...to.map((key) => ["p", key]), ["d", crypto.randomUUID()]],
      });
      // The relay creates the channel's metadata just after answering.
      for (let tries = 0; !found && tries < 5; tries++) {
        if (tries) await new Promise((resolve) => setTimeout(resolve, 400));
        found = await find();
      }
    }
    const channel = found && tag(found, "d");
    if (!channel) throw new Error("The DM did not open.");
    return channel;
  },

  async mem_get(tools, args) {
    const entries = await tools.client.memories();
    const slug = text(args.slug);
    if (!slug)
      return (
        entries
          .map((entry) => `${entry.slug} ${time(entry.createdAt)}`)
          .join("\n") || "No memory."
      );
    const key = memorySlug(slug);
    return (
      entries.find((entry) => entry.slug === key)?.body ?? `No memory ${key}.`
    );
  },

  async mem_set(tools, args) {
    const key = memorySlug(required(args, "slug"));
    const body = (await tools.body(args, true)) as string;
    // Unreadable memory still takes a write, dated now.
    const current = (await tools.client.memories().catch(() => [])).find(
      (entry) => entry.slug === key,
    );
    await tools.client.remember(key, body, current?.createdAt ?? 0);
    return "saved";
  },

  async canvas(tools, args) {
    const { client, context } = tools;
    const channel = text(args.channel) ?? context.channel;
    if (!channel) throw new Error("channel is required here.");
    const content = await tools.body(args, false);
    if (content === undefined) {
      const [head] = await client.query([
        { kinds: [40100], "#h": [channel], limit: 1 },
      ]);
      return head?.content || "No canvas.";
    }
    // The newest canvas wins, so a write must be dated after the current one.
    const [head] = await client.query([
      { kinds: [40100], "#h": [channel], limit: 1 },
    ]);
    const wait = head ? (head.created_at + 1) * 1000 - Date.now() : 0;
    if (wait > 5000) throw new Error("The canvas was just changed; try again.");
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    await client.publish({ kind: 40100, content, tags: [["h", channel]] });
    return "saved";
  },

  async media_get(tools, args) {
    const data = await tools.client.media(required(args, "url"));
    // The first 12 bytes name the type.
    const head = atob(data.slice(0, 16));
    const type = sniff(Uint8Array.from(head, (c) => c.charCodeAt(0)));
    if (!type?.startsWith("image/"))
      throw new Error("Only JPEG, PNG, GIF and WebP images can be shown.");
    return { data, type };
  },
};

/** One call's helpers, so lookups it repeats are made once. */
class Tools {
  private readonly cache = new Map<string, Promise<unknown>>();
  constructor(
    readonly client: BuzzClient,
    readonly context: Context,
  ) {}

  private once<T>(key: string, load: () => Promise<T>) {
    let value = this.cache.get(key) as Promise<T> | undefined;
    if (!value) {
      value = load();
      this.cache.set(key, value);
    }
    return value;
  }

  /** `text`, or the file at `path`. Undefined when neither is given and
   * `needed` is false. */
  async body(args: Args, needed: boolean) {
    const path = text(args.path);
    const value = path
      ? new TextDecoder().decode(await this.client.read(path))
      : typeof args.text === "string"
        ? args.text
        : undefined;
    if (value === undefined && needed) throw new Error("Give text or path.");
    return value;
  }

  async event(id: string) {
    if (!HEX.test(id)) throw new Error(`Not an event id: ${id}`);
    const [event] = await this.client.query([
      { ids: [id], kinds: [...THREAD, 45001], limit: 1 },
    ]);
    if (!event) throw new Error(`No message ${id}.`);
    return event;
  }

  /** The e-tag of a reply to `parent`. Agents never nest: a reply to any
   * message in a thread is a reply to the thread's root. */
  async threadTags(parent: string) {
    const root =
      parent === this.context.root ? parent : rootOf(await this.event(parent));
    return [["e", root, "", "reply"]];
  }

  members(channel: string) {
    return this.once(`members/${channel}`, async () => {
      const [list] = await this.client.query([
        { kinds: [39002], "#d": [channel], limit: 1 },
      ]);
      return (list?.tags ?? [])
        .filter((t) => t[0] === "p" && t[1])
        .map((t) => ({ pubkey: t[1] as string, role: t[3] || "member" }));
    });
  }

  /** Display names of `pubkeys` that have a profile. */
  async names(pubkeys: readonly string[]) {
    const wanted = [...new Set(pubkeys)];
    const names = new Map<string, string>();
    if (!wanted.length) return names;
    const profiles = await this.client.query([
      { kinds: [0], authors: wanted, limit: wanted.length },
    ]);
    for (const event of newest(profiles)) {
      const name = profileName(parse(event.content));
      if (name) names.set(event.pubkey, name);
    }
    return names;
  }

  /** Who `content` notifies: `mentions`, `nostr:npub…` links, and `@Name`
   * for a channel member, as the CLI resolves them. Each must be a member. */
  async mentions(
    channel: string,
    content: string,
    explicit: readonly string[],
  ) {
    const keys = new Set(explicit.map(pubkey));
    for (const match of content.matchAll(/nostr:(npub1[02-9ac-hj-np-z]{58})/g))
      keys.add(pubkey(match[1] as string));
    const prose = content
      .replace(/^```[\s\S]*?^```/gm, " ")
      .replace(/`[^`\n]*`/g, " ");
    if (!prose.includes("@") && !keys.size) return [];
    const members = await this.members(channel);
    if (prose.includes("@")) {
      const byName = new Map<string, string[]>();
      for (const [key, name] of await this.names(
        members.map((member) => member.pubkey),
      )) {
        const lower = name.toLowerCase();
        byName.set(lower, [...(byName.get(lower) ?? []), key]);
      }
      const longest = [...byName.keys()].sort((a, b) => b.length - a.length);
      const unknown: string[] = [];
      for (const match of prose.matchAll(/(^|\s)@/g)) {
        const rest = prose
          .slice((match.index ?? 0) + match[0].length)
          .toLowerCase();
        const name = longest.find(
          (candidate) =>
            rest.startsWith(candidate) &&
            /^($|[\s,;.!?:)\]}])/.test(rest.slice(candidate.length)),
        );
        const found = name ? (byName.get(name) ?? []) : [];
        if (found.length === 1) keys.add(found[0] as string);
        else {
          const token = name ?? rest.match(/^[a-z0-9._-]+/)?.[0];
          if (token)
            unknown.push(`@${token}${found.length ? " (ambiguous)" : ""}`);
        }
      }
      if (unknown.length && !explicit.length)
        throw new Error(
          `No single channel member is ${unknown.join(", ")}. Pass their pubkeys in mentions, or drop the @.`,
        );
    }
    const outside = [...keys].filter(
      (key) => !members.some((member) => member.pubkey === key),
    );
    if (outside.length)
      throw new Error(`Not in this channel: ${outside.join(", ")}`);
    return [...keys].slice(0, 50);
  }

  /** Uploads each file and returns its `imeta` tags and the links to append. */
  async attach(paths: readonly string[]) {
    const tags: string[][] = [];
    let links = "";
    for (const path of paths) {
      const data = await this.client.read(path);
      const mime = sniff(data);
      if (!mime)
        throw new Error(`${path}: only JPEG, PNG, GIF, WebP and MP4 attach.`);
      const upload = await this.client.upload(data, mime);
      tags.push(imeta(upload));
      links += `\n![${mime.startsWith("video/") ? "video" : "image"}](${upload.url})`;
    }
    return { tags, links };
  }
}

/** The root of the thread `event` is in, by its NIP-10 markers. */
function rootOf(event: BuzzEvent) {
  const tags = event.tags.filter(
    (t) => t[0] === "e" && t.length >= 4 && HEX.test(t[1] ?? ""),
  );
  const root = tags.find((t) => t[3] === "root");
  const reply = tags.find((t) => t[3] === "reply");
  return ((root && reply ? root : reply)?.[1] ?? event.id) as string;
}

/** Messages oldest first, each showing its author's latest edit. */
function edited(events: readonly BuzzEvent[]) {
  const edits = new Map<string, BuzzEvent>();
  for (const event of events)
    if (event.kind === 40003) {
      const target = tag(event, "e");
      const last = target && edits.get(target);
      if (target && (!last || last.created_at < event.created_at))
        edits.set(target, event);
    }
  return events
    .filter((event) => event.kind !== 40003)
    .map((event) => {
      const edit = edits.get(event.id);
      return edit && edit.pubkey === event.pubkey
        ? { ...event, content: edit.content }
        : event;
    })
    .sort((a, b) => a.created_at - b.created_at);
}

/** Each author's newest event. */
function newest(events: readonly BuzzEvent[]) {
  const latest = new Map<string, BuzzEvent>();
  for (const event of events) {
    const seen = latest.get(event.pubkey);
    if (!seen || seen.created_at < event.created_at)
      latest.set(event.pubkey, event);
  }
  return [...latest.values()];
}

function imeta(upload: Upload) {
  return [
    "imeta",
    `url ${upload.url}`,
    `m ${upload.type}`,
    `x ${upload.sha256}`,
    `size ${upload.size}`,
    ...(["dim", "blurhash", "thumb", "duration"] as const)
      .filter((key) => upload[key] !== undefined)
      .map((key) => `${key} ${upload[key]}`),
  ];
}

/** An attachable type, by the file's leading bytes. */
function sniff(data: Uint8Array) {
  const at = (offset: number, ...bytes: number[]) =>
    bytes.every((byte, index) => data[offset + index] === byte);
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
    return "image/webp";
  if (at(4, 0x66, 0x74, 0x79, 0x70)) return "video/mp4";
  return undefined;
}

function memorySlug(slug: string) {
  const key = slug === "core" || slug.startsWith("mem/") ? slug : `mem/${slug}`;
  if (
    key.length > 255 ||
    !/^(core|mem\/[a-z0-9][a-z0-9_-]{0,63}(\/[a-z0-9][a-z0-9_-]{0,63})*)$/.test(
      key,
    )
  )
    throw new Error(
      `Bad slug ${slug}: use lowercase parts like notes or team/plan.`,
    );
  return key;
}

function pubkey(value: string) {
  if (HEX.test(value.toLowerCase())) return value.toLowerCase();
  try {
    const decoded = decode(value);
    if (decoded.type === "npub") return decoded.data;
  } catch {}
  throw new Error(`Not a pubkey: ${value}`);
}

const profileName = (profile: Record<string, unknown>) =>
  [profile.display_name, profile.name].find(
    (name): name is string => typeof name === "string" && !!name.trim(),
  );
function parse(content: string): Record<string, unknown> {
  try {
    const value = JSON.parse(content);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
const tag = (event: BuzzEvent, name: string) =>
  event.tags.find((t) => t[0] === name)?.[1];
const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const list = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
function required(args: Args, name: string) {
  const value = args[name];
  if (typeof value !== "string" || !value)
    throw new Error(`${name} is required.`);
  return value;
}
const bound = (value: number | undefined, fallback: number, max: number) =>
  Math.max(1, Math.min(max, Math.floor(value ?? fallback)));
const time = (seconds: number) =>
  `${new Date(seconds * 1000).toISOString().slice(0, 16)}Z`;
