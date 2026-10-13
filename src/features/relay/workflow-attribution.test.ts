import { afterEach, assert, expect, it, vi } from "vitest";
import * as nostr from "nostr-tools";
import { createEventVerifier, eventDto, hasEventProof } from "./events";
import { foldMessages } from "./fold";
import { rowProfileIds } from "./membership";
import { projectEvents } from "./projection";
import { keypair, signed } from "./testing";
import { workflowOwner, workflowMentionOwner } from "./workflow-attribution";

vi.mock("nostr-tools", { spy: true });

const relay = keypair(),
  owner = keypair(),
  other = keypair();
const tags = [
  ["h", "room"],
  ["buzz:workflow", "true"],
  ["buzz:workflow-owner", owner.pubkey],
];
const sample = (nextTags = tags, key = relay, kind = 9) =>
  signed(key, { kind, content: "Automated", tags: nextTags });
afterEach(() => vi.restoreAllMocks());

it("uses only admission-owned proof, without verification during repeated folds", () => {
  const verify = vi.mocked(nostr.verifyEvent);
  const event = eventDto(sample());
  expect(hasEventProof(event)).toBe(true);
  verify.mockClear();
  for (let i = 0; i < 20; i++) {
    const projected = projectEvents([event], [], [{ kinds: [9], limit: 50 }]);
    const rows = foldMessages("room", relay.pubkey, projected, {
      signingAuthority: relay.pubkey,
    });
    expect(rows[0]).toMatchObject({
      authorId: relay.pubkey,
      workflowOwnerId: owner.pubkey,
    });
    assert.exists(rows[0]);
    expect(rowProfileIds(rows[0])).toContain(owner.pubkey);
  }
  expect(verify).not.toHaveBeenCalled();
});
it("recognizes the bounded HTTP verifier's proof too", () => {
  const read = createEventVerifier();
  const event = sample();
  expect(workflowOwner(read(event), relay.pubkey)).toBe(owner.pubkey);
  expect(workflowOwner(read(event), relay.pubkey)).toBe(owner.pubkey);
});
it("delegates only to explicit canonical workflow targets", () => {
  const nextTags = [
    ...tags,
    ["buzz:workflow-mention", other.pubkey],
    ["buzz:workflow-mention", owner.pubkey],
  ];
  const event = eventDto(sample(nextTags));
  expect(workflowMentionOwner(event, relay.pubkey, other.pubkey)).toBe(
    owner.pubkey,
  );
  expect(
    workflowMentionOwner(event, relay.pubkey, relay.pubkey),
  ).toBeUndefined();
  expect(workflowMentionOwner(event, undefined, other.pubkey)).toBeUndefined();
  expect(
    workflowMentionOwner(event, other.pubkey, other.pubkey),
  ).toBeUndefined();
  expect(
    workflowMentionOwner({ ...event }, relay.pubkey, other.pubkey),
  ).toBeUndefined();
  expect(
    workflowMentionOwner(
      eventDto(sample(nextTags, other)),
      relay.pubkey,
      other.pubkey,
    ),
  ).toBeUndefined();
});
it.each(
  [
    [],
    [["p", other.pubkey]],
    [["buzz:workflow-mention", owner.pubkey]],
    [["buzz:workflow-mention", other.pubkey, "extra"]],
    [["buzz:workflow-mention", other.pubkey.toUpperCase()]],
    [
      ["buzz:workflow-mention", other.pubkey],
      ["buzz:workflow-mention", other.pubkey],
    ],
    [["buzz:workflow-mention", other.pubkey], ["buzz:workflow-mention"]],
    [
      ["buzz:workflow-mention", other.pubkey],
      ["buzz:workflow-mention", "bad"],
    ],
  ].map((mentions) => ({ mentions })),
)("rejects missing or ambiguous workflow targets %#", ({ mentions }) => {
  expect(
    workflowMentionOwner(
      eventDto(sample([...tags, ...mentions])),
      relay.pubkey,
      other.pubkey,
    ),
  ).toBeUndefined();
});
it("rejects unsigned intent, caller proof symbols, copied and tampered records", () => {
  const raw = sample();
  const { sig: _sig, ...intent } = raw;
  for (const event of [
    raw,
    intent,
    Object.freeze(intent),
    { ...eventDto(raw) },
    { ...raw, content: "tampered" },
  ])
    expect(workflowOwner(event, relay.pubkey)).toBeUndefined();
  expect(() => eventDto({ ...raw, content: "tampered" })).toThrow();
});
it("keeps the signer fallback until explicit live authority is available, including restored JSON", () => {
  const cached = eventDto(JSON.parse(JSON.stringify(sample())));
  for (const authority of [undefined, "", other.pubkey])
    expect(workflowOwner(cached, authority)).toBeUndefined();
  const offline = foldMessages("room", relay.pubkey, [cached])[0];
  expect(offline?.authorId).toBe(relay.pubkey);
  expect(offline?.workflowOwnerId).toBeUndefined();
  expect(workflowOwner(cached, relay.pubkey)).toBe(owner.pubkey);
});
it("cannot attribute ordinary signers or non-message kinds", () => {
  expect(
    workflowOwner(eventDto(sample(tags, other)), relay.pubkey),
  ).toBeUndefined();
  expect(
    workflowOwner(eventDto(sample(tags, relay, 40002)), relay.pubkey),
  ).toBeUndefined();
});
it.each(
  [
    [],
    [["p", owner.pubkey]],
    [["buzz:workflow", "true"]],
    [["buzz:workflow-owner", owner.pubkey]],
    [...tags, ["buzz:workflow", "true"]],
    [...tags, ["buzz:workflow-owner", owner.pubkey]],
    [
      ["buzz:workflow", "false"],
      ["buzz:workflow-owner", owner.pubkey],
    ],
    [
      ["buzz:workflow", "true", "extra"],
      ["buzz:workflow-owner", owner.pubkey],
    ],
    [
      ["buzz:workflow", "true"],
      ["buzz:workflow-owner", owner.pubkey, "extra"],
    ],
    [
      ["buzz:workflow", "true"],
      ["buzz:workflow-owner", ""],
    ],
    [
      ["buzz:workflow", "true"],
      ["buzz:workflow-owner", "a".repeat(63)],
    ],
    [
      ["buzz:workflow", "true"],
      ["buzz:workflow-owner", owner.pubkey.toUpperCase()],
    ],
  ].map((nextTags) => ({ nextTags })),
)("rejects malformed or ambiguous metadata %#", ({ nextTags }) => {
  expect(
    workflowOwner(eventDto(sample(nextTags)), relay.pubkey),
  ).toBeUndefined();
});

it("keeps workflow signer disclosure separate from main's attributed author and owner edits", () => {
  const event = eventDto(sample([["p", owner.pubkey], ...tags]));
  const edit = eventDto(
    signed(owner, {
      kind: 40003,
      content: "Owner edit",
      created_at: event.created_at + 1,
      tags: [["e", event.id]],
    }),
  );
  const [row] = foldMessages("room", relay.pubkey, [event, edit], {
    signingAuthority: relay.pubkey,
  });
  expect(row).toMatchObject({
    authorId: owner.pubkey,
    signerId: relay.pubkey,
    workflowOwnerId: owner.pubkey,
    content: "Owner edit",
  });
  const deletion = eventDto(
    signed(owner, {
      kind: 5,
      content: "",
      created_at: event.created_at + 2,
      tags: [["e", event.id]],
    }),
  );
  expect(
    foldMessages("room", relay.pubkey, [event, edit, deletion], {
      signingAuthority: relay.pubkey,
    }),
  ).toEqual([]);
});
