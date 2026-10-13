import { expect, it } from "vitest";
import { validChannelCommand } from "./session-commands.mjs";
const id = "11111111-1111-4111-8111-111111111111";
const event = (body, tags = [["h", id]]) => ({
  kind: 9050,
  created_at: 1,
  content: JSON.stringify(body),
  tags,
});
it("rejects custom session commands", () => {
  expect(validChannelCommand(event({ action: "create", title: "Work" }))).toBe(
    false,
  );
  expect(
    validChannelCommand(
      event({ action: "move", parent_id: id, confirm_history: true }),
    ),
  ).toBe(false);
});
it("allows only ordinary invitations, without extra roles", () => {
  const invite = {
    kind: 9000,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["p", "a".repeat(64)],
    ],
  };
  expect(validChannelCommand(invite)).toBe(true);
  expect(
    validChannelCommand({
      ...invite,
      tags: [...invite.tags, ["role", "admin"]],
    }),
  ).toBe(false);
  expect(validChannelCommand({ ...invite, kind: 9001 })).toBe(false);
});

it("admits stream and NIP-CL system channel creation only", () => {
  const create = (type) => ({
    kind: 9007,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["name", "For You records"],
      ["visibility", "private"],
      ["channel_type", type],
      ["t", "for-you"],
    ],
  });
  expect(validChannelCommand(create("stream"))).toBe(true);
  expect(validChannelCommand(create("system"))).toBe(true);
  for (const type of ["dm", "forum", "session", "System", ""])
    expect(validChannelCommand(create(type))).toBe(false);
});

it("preserves strict Sessions metadata while allowing ordinary stream visibility", () => {
  const create = {
    kind: 9007,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["name", "Work"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["about", "Buzz session (buzz.sessions/v1)"],
    ],
  };
  expect(validChannelCommand(create)).toBe(true);
  const child = (description) => ({
    ...create,
    tags: create.tags.map((tag) =>
      tag[0] === "about" ? ["about", description] : tag,
    ),
  });
  expect(
    validChannelCommand(child(`Buzz session (buzz.sessions/v1)\nparent:${id}`)),
  ).toBe(true);
  for (const parent of ["invalid", `${id}\nrole:owner`, `${id}extra`]) {
    expect(
      validChannelCommand(
        child(`Buzz session (buzz.sessions/v1)\nparent:${parent}`),
      ),
    ).toBe(false);
  }
  for (const [index, value] of [
    [3, "dm"],
    [1, " "],
  ]) {
    expect(
      validChannelCommand({
        ...create,
        tags: create.tags.map((tag, i) =>
          i === index ? [tag[0], value] : tag,
        ),
      }),
    ).toBe(false);
  }
  expect(
    validChannelCommand({
      ...create,
      tags: create.tags.map((tag, i) =>
        i === 4 ? [tag[0], "Buzz session (forged)"] : tag,
      ),
    }),
  ).toBe(false);
  expect(
    validChannelCommand({
      ...create,
      tags: [...create.tags, ["p", "a".repeat(64)]],
    }),
  ).toBe(false);
  expect(validChannelCommand({ ...create, content: "extra" })).toBe(false);
});

it("accepts one trailing outbox identifier for invitations and rejects ambiguous envelopes", () => {
  const invite = (tags) => ({ kind: 9000, created_at: 1, content: "", tags });
  const h = ["h", id],
    p = ["p", "a".repeat(64)],
    client = ["client-id", id];
  expect(validChannelCommand(invite([h, p, client]))).toBe(true);
  for (const tags of [
    [h, p, client, client],
    [client, h, p],
    [h, p, ["client-id", "invalid"]],
    [h, p, [...client, "extra"]],
  ])
    expect(validChannelCommand(invite(tags))).toBe(false);
});

it("allows bounded ordinary stream creation without a Sessions marker", () => {
  const create = {
    kind: 9007,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["name", "Release notes"],
      ["visibility", "open"],
      ["channel_type", "stream"],
      ["about", "Updates for the team"],
    ],
  };
  expect(validChannelCommand(create)).toBe(true);
  expect(
    validChannelCommand({ ...create, tags: create.tags.slice(0, 4) }),
  ).toBe(true);
  expect(
    validChannelCommand({
      ...create,
      tags: create.tags.map((tag) =>
        tag[0] === "about" ? ["about", "x".repeat(1001)] : tag,
      ),
    }),
  ).toBe(false);
  expect(
    validChannelCommand({
      ...create,
      tags: create.tags.map((tag) =>
        tag[0] === "about" ? ["about", "Buzz session (forged)"] : tag,
      ),
    }),
  ).toBe(false);
  expect(
    validChannelCommand({
      ...create,
      tags: [...create.tags, ["ttl", "604800"]],
    }),
  ).toBe(true);
  expect(
    validChannelCommand({
      ...create,
      tags: [...create.tags.slice(0, 4), ["ttl", "604800"]],
    }),
  ).toBe(true);
  for (const ttl of ["0", "-1", "forever", "2147483648"]) {
    expect(
      validChannelCommand({
        ...create,
        tags: [...create.tags, ["ttl", ttl]],
      }),
    ).toBe(false);
  }
});

it("rejects every truncated mandatory creation-tag prefix", () => {
  const create = {
    kind: 9007,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["name", "Release notes"],
      ["visibility", "open"],
      ["channel_type", "stream"],
    ],
  };
  for (let length = 0; length < create.tags.length; length++)
    expect(
      validChannelCommand({ ...create, tags: create.tags.slice(0, length) }),
    ).toBe(false);
});

it("does not add temporary cleanup to Sessions metadata", () => {
  const create = {
    kind: 9007,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["name", "Work"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["about", "Buzz session (buzz.sessions/v1)"],
      ["ttl", "604800"],
    ],
  };
  expect(validChannelCommand(create)).toBe(false);
});

it("rejects plugin placement metadata in channel creation", () => {
  const base = {
    kind: 9007,
    created_at: 1700000000,
    content: "",
    tags: [
      ["h", "11111111-1111-4111-8111-111111111111"],
      ["name", "Me"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["about", "Buzz session (buzz.sessions/v1)"],
    ],
  };
  const personal = ["buzz-space", "personal"];
  expect(validChannelCommand({ ...base, tags: [...base.tags, personal] })).toBe(
    false,
  );
  for (const extra of [
    [["buzz-space", "me"]],
    [["buzz-space"]],
    [["buzz-space", "personal", "extra"]],
    [personal, personal],
    [["ttl", "60"], personal],
  ])
    expect(
      validChannelCommand({ ...base, tags: [...base.tags, ...extra] }),
    ).toBe(false);
  expect(
    validChannelCommand({
      ...base,
      tags: base.tags
        .map((tag) => (tag[0] === "visibility" ? ["visibility", "open"] : tag))
        .concat([personal]),
    }),
  ).toBe(false);
});

it("admits NIP-CL labels at the end of a channel creation, before the client id", () => {
  const create = (labels) => ({
    kind: 9007,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["name", "Records"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["about", "For You records"],
      ...labels,
      ["client-id", "22222222-2222-4222-8222-222222222222"],
    ],
  });
  expect(validChannelCommand(create([]))).toBe(true);
  expect(
    validChannelCommand(
      create([
        ["t", "for-you"],
        ["t", "app:records"],
      ]),
    ),
  ).toBe(true);
  for (const labels of [
    [["t", "system"]],
    [["t", "Upper"]],
    [["t", ""]],
    [
      ["t", "a"],
      ["t", "a"],
    ],
    [
      ["t", "a"],
      ["about", "late"],
    ],
    Array.from({ length: 9 }, (_, n) => ["t", `l${n}`]),
  ])
    expect(validChannelCommand(create(labels))).toBe(false);
});
