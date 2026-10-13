import { expect, it, vi } from "vitest";
import type { BuzzClient, BuzzEvent, Filter, Template } from "./client";
import { respond } from "./rpc";
import { callTool } from "./tools";

const me = "c".repeat(64);
const alice = "a".repeat(64);
const bob = "b".repeat(64);
const root = "1".repeat(64);
const nested = "2".repeat(64);
const event = (fields: Partial<BuzzEvent>): BuzzEvent => ({
  id: "f".repeat(64),
  pubkey: alice,
  created_at: 100,
  kind: 9,
  tags: [["h", "chan"]],
  content: "",
  sig: "",
  ...fields,
});
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** A community with `events` in it, answering filters by kind and a few tags. */
function fake(events: readonly BuzzEvent[] = []) {
  const published: Template[] = [];
  const matches = (filter: Filter, item: BuzzEvent) => {
    const tag = (name: string) =>
      item.tags.filter((t) => t[0] === name).map((t) => t[1]);
    return Object.entries(filter).every(([key, value]) => {
      if (key === "kinds") return (value as number[]).includes(item.kind);
      if (key === "ids") return (value as string[]).includes(item.id);
      if (key === "authors") return (value as string[]).includes(item.pubkey);
      if (key.startsWith("#"))
        return (value as string[]).some((v) => tag(key.slice(1)).includes(v));
      return true;
    });
  };
  const client: BuzzClient = {
    pubkey: me,
    query: vi.fn(async (filters: readonly Filter[]) =>
      events.filter((item) => filters.some((filter) => matches(filter, item))),
    ),
    publish: vi.fn(async (template: Template) => {
      published.push(template);
      return event({ ...template, pubkey: me, id: "e".repeat(64) });
    }),
    upload: vi.fn(async (_data: Uint8Array, mime: string) => ({
      url: "https://relay/media/x.png",
      sha256: "ab",
      size: 7,
      type: mime,
      dim: "1x1",
    })),
    read: vi.fn(async (path: string) =>
      path.endsWith(".png") ? PNG : new TextEncoder().encode(`# ${path}`),
    ),
    memories: vi.fn(async () => [
      { slug: "mem/notes", body: "old", createdAt: 50 },
    ]),
    remember: vi.fn(async () => undefined),
    media: vi.fn(async (url: string) =>
      btoa(String.fromCharCode(...(url.endsWith(".png") ? PNG : [1, 2, 3]))),
    ),
  };
  return { client, published };
}

const members = event({
  kind: 39002,
  tags: [
    ["d", "chan"],
    ["p", alice, "", "member"],
    ["p", bob, "", "admin"],
    ["p", me, "", "bot"],
  ],
});
const profile = (pubkey: string, name: string) =>
  event({ kind: 0, pubkey, content: JSON.stringify({ display_name: name }) });
const community = [
  members,
  profile(alice, "Alice Smith"),
  profile(bob, "Bob"),
  event({ id: root }),
  event({
    id: nested,
    tags: [
      ["h", "chan"],
      ["e", root, "", "reply"],
    ],
  }),
];

it("replies in the current thread and notifies the members it names", async () => {
  const { client, published } = fake(community);
  await callTool(client, { channel: "chan", root }, "send", {
    audience: "everyone",
    text: "@Alice Smith see `@Bob`",
  });
  expect(published).toEqual([
    {
      kind: 9,
      content: "@Alice Smith see `@Bob`",
      tags: [
        ["h", "chan"],
        ["e", root, "", "reply"],
        ["p", alice],
      ],
    },
  ]);
});

it("tags a message for agents, and needs the audience said", async () => {
  const { client, published } = fake(community);
  const context = { channel: "chan", root };
  await callTool(client, context, "send", {
    text: "@Bob run the suite",
    audience: "agents",
  });
  expect(published[0]?.tags).toEqual([
    ["h", "chan"],
    ["e", root, "", "reply"],
    ["p", bob],
    ["audience", "agents"],
  ]);
  await expect(
    callTool(client, context, "send", { text: "hi" }),
  ).rejects.toThrow("audience must be everyone or agents");
  await expect(
    callTool(client, context, "send", { text: "hi", audience: "humans" }),
  ).rejects.toThrow("audience must be everyone or agents");
  expect(published).toHaveLength(1);
});

it("refuses to post a name it cannot resolve unless told who it means", async () => {
  const { client, published } = fake(community);
  const context = { channel: "chan", root };
  await expect(
    callTool(client, context, "send", {
      audience: "everyone",
      text: "hi @Carol",
    }),
  ).rejects.toThrow("No single channel member is @carol");
  await callTool(client, context, "send", {
    audience: "everyone",
    text: "hi @Carol",
    mentions: [bob],
  });
  expect(published[0]?.tags).toContainEqual(["p", bob]);
});

it("replies to a message inside a thread at the thread's root, and posts a file's text and images", async () => {
  const { client, published } = fake(community);
  await callTool(client, { channel: "chan", root }, "send", {
    audience: "everyone",
    reply: nested,
    path: "notes.md",
    files: ["shot.png"],
  });
  expect(published[0]).toEqual({
    kind: 9,
    content: "# notes.md\n![image](https://relay/media/x.png)",
    tags: [
      ["h", "chan"],
      ["e", root, "", "reply"],
      [
        "imeta",
        "url https://relay/media/x.png",
        "m image/png",
        "x ab",
        "size 7",
        "dim 1x1",
      ],
    ],
  });
});

it("posts at the channel's top level when given a channel", async () => {
  const { client, published } = fake(community);
  await callTool(client, { channel: "chan", root }, "send", {
    audience: "everyone",
    channel: "other",
    text: "hello",
  });
  expect(published[0]?.tags).toEqual([["h", "other"]]);
});

it("reads the current thread with each message's latest edit", async () => {
  const { client } = fake([
    ...community,
    event({
      kind: 40003,
      created_at: 120,
      content: "edited",
      tags: [
        ["h", "chan"],
        ["e", nested],
      ],
    }),
  ]);
  const text = (await callTool(
    client,
    { channel: "chan", root },
    "read",
    {},
  )) as string;
  expect(text.split("\n")).toEqual([
    `${root} Alice Smith 1970-01-01T00:01Z: `,
    `${nested} Alice Smith 1970-01-01T00:01Z: edited`,
  ]);
});

it("takes back its own reaction", async () => {
  const reaction = event({
    id: "9".repeat(64),
    kind: 7,
    pubkey: me,
    content: "👍",
    tags: [["e", root]],
  });
  const { client, published } = fake([...community, reaction]);
  await callTool(client, {}, "react", { id: root, emoji: "👍", off: true });
  expect(published).toEqual([
    { kind: 5, content: "", tags: [["e", reaction.id]] },
  ]);
});

it("writes memory under mem/, newer than the entry it replaces", async () => {
  const { client } = fake();
  await callTool(client, {}, "mem_set", { slug: "notes", text: "new" });
  expect(client.remember).toHaveBeenCalledWith("mem/notes", "new", 50);
  await expect(
    callTool(client, {}, "mem_get", { slug: "notes" }),
  ).resolves.toBe("old");
});

it("answers MCP requests, reporting a failed call as a tool error", async () => {
  const { client } = fake(community);
  const init = await respond(
    client,
    {},
    {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    },
  );
  expect(init).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
  const list = (await respond(
    client,
    {},
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    },
  )) as { result: { tools: { name: string }[] } };
  expect(list.result.tools.map((tool) => tool.name)).toContain("send");
  await expect(
    respond(
      client,
      {},
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "send", arguments: { text: "hi" } },
      },
    ),
  ).resolves.toEqual({
    jsonrpc: "2.0",
    id: 2,
    result: {
      content: [{ type: "text", text: "channel is required here." }],
      isError: true,
    },
  });
});

it("replies in the channel of the message it answers", async () => {
  const elsewhere = event({ id: "3".repeat(64), tags: [["h", "other"]] });
  const { client, published } = fake([...community, elsewhere]);
  await callTool(client, { channel: "chan", root }, "send", {
    audience: "everyone",
    reply: elsewhere.id,
    text: "over here",
  });
  expect(published[0]?.tags).toEqual([
    ["h", "other"],
    ["e", elsewhere.id, "", "reply"],
  ]);
});

it("refuses a memory slug the community would not list", async () => {
  const { client } = fake();
  await expect(
    callTool(client, {}, "mem_set", { slug: "My Notes", text: "x" }),
  ).rejects.toThrow("Bad slug");
});

it("lists its tools before it can call them", async () => {
  const list = (await respond(
    undefined,
    {},
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    },
  )) as { result: { tools: unknown[] } };
  expect(list.result.tools).toHaveLength(12);
  await expect(
    respond(
      undefined,
      {},
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "read", arguments: {} },
      },
    ),
  ).resolves.toMatchObject({ result: { isError: true } });
});

it("shows a media image to the agent, and nothing else", async () => {
  const { client } = fake();
  const png = btoa(String.fromCharCode(...PNG));
  await expect(
    respond(
      client,
      {},
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "media_get", arguments: { url: "abc.png" } },
      },
    ),
  ).resolves.toEqual({
    jsonrpc: "2.0",
    id: 3,
    result: { content: [{ type: "image", data: png, mimeType: "image/png" }] },
  });
  expect(client.media).toHaveBeenCalledWith("abc.png");
  await expect(
    callTool(client, {}, "media_get", { url: "abc.txt" }),
  ).rejects.toThrow("Only JPEG, PNG, GIF and WebP");
});
