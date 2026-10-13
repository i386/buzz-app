import { afterEach, assert, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools";
import { createChannelDetails } from "./channel-details";
import {
  channelVisibility,
  canonicalDetailsName,
  detailsSettings,
  detailsTemplate,
  validateDetailsTemplate,
} from "./channel-details-protocol";
import { PublishRejected } from "./outbox";
import type { RelayEvent } from "./events";
import { createRelaySession } from "./session";
import { sessionDescription } from "../sessions/metadata";
import type { ReadFilter } from "./events";

const key = new Uint8Array(32).fill(2),
  relayKey = new Uint8Array(32).fill(3);
const viewer = getPublicKey(key),
  relayAuthor = getPublicKey(relayKey);
const id = "11111111-1111-4111-8111-111111111111";
const draft = {
  name: "renamed",
  description: "New description",
  visibility: "private" as const,
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(role = "owner", labels = false) {
  let clock = 100;
  const record = (kind: number, tags: string[][]) =>
    finalizeEvent(
      { kind, tags: [["d", id], ...tags], created_at: clock++, content: "" },
      relayKey,
    );
  const metadata = (
    name = "original",
    description = "Old description",
    visibility = "public",
    type = "stream",
  ) =>
    record(39000, [
      ["name", name],
      ["about", description],
      [visibility],
      ["t", type],
    ]);
  let events = [
    metadata(),
    record(39001, role === "member" ? [] : [["p", viewer, role]]),
    record(39002, [["p", viewer, "", role]]),
  ];
  const read = vi.fn(async (_filters: readonly ReadFilter[]) => events);
  const sign = vi.fn(async (event: EventTemplate) =>
    finalizeEvent(structuredClone(event), key),
  );
  const publish = vi.fn(async () => {
    events = [
      metadata(draft.name, draft.description, draft.visibility),
      ...events.slice(1),
    ];
  });
  const acceptDiscovery = vi.fn();
  let active = true;
  const owner = createChannelDetails({
    reader: { read },
    writer: { sign, publish },
    labels,
    viewer,
    relayAuthor,
    canAccess: () => active,
    acceptDiscovery,
  });
  cleanup.push(owner.dispose);
  const entry = (index: number) => {
    const value = events[index];
    assert(value);
    return value;
  };
  return {
    entry,
    owner,
    read,
    sign,
    publish,
    acceptDiscovery,
    metadata,
    record,
    events: () => events,
    set: (next: RelayEvent[]) => {
      events = next;
    },
    revoke: () => {
      active = false;
    },
  };
}
it("saves only after two fresh authority checks and projects confirmed readback", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  h.acceptDiscovery.mockClear();
  h.read.mockClear();
  await h.owner.capability.save(base, draft);
  expect(h.read).toHaveBeenCalledTimes(3);
  for (const call of h.read.mock.calls as unknown as [unknown, unknown][]) {
    expect(call).toEqual([
      [39000, 39001, 39002].map((kind) => ({
        kinds: [kind],
        consistency: "strong",
        authors: [relayAuthor],
        "#d": [id],
        limit: 1,
      })),
      expect.objectContaining({ fresh: true, priority: "foreground" }),
    ]);
  }
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.acceptDiscovery).toHaveBeenCalledWith([h.events()[0]]);
  expect(h.owner.capability.snapshot(id)).toBeUndefined();
});
it("confirms channel edits while the replica still has the old metadata", async () => {
  const h = harness();
  const replica = h.events();
  h.read.mockImplementation(async (filters) =>
    filters.every((filter) => filter.consistency === "strong")
      ? h.events()
      : replica,
  );
  const base = await h.owner.capability.load(id);
  await h.owner.capability.save(base, draft);
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.acceptDiscovery).toHaveBeenLastCalledWith([h.events()[0]]);
  expect(h.owner.capability.snapshot(id)).toBeUndefined();
});
it.each(["owner", "admin", "member"])(
  "derives current direct %s authority",
  async (role) => {
    const h = harness(role);
    const base = await h.owner.capability.load(id);
    expect(base.canEdit).toBe(role !== "member");
    if (role === "member") {
      await expect(h.owner.capability.save(base, draft)).rejects.toThrow(
        "permission",
      );
      expect(h.sign).not.toHaveBeenCalled();
    }
  },
);
it("revoked authority while signing prevents publication", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  h.sign.mockImplementationOnce(async (event) => {
    h.set([h.entry(0), h.record(39001, []), h.entry(2)]);
    return finalizeEvent(event, key);
  });
  await expect(h.owner.capability.save(base, draft)).rejects.toThrow(
    "permission",
  );
  expect(h.publish).not.toHaveBeenCalled();
});
it("stale edit bases fail before signing", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  h.set([h.metadata("changed", "", "private"), ...h.events().slice(1)]);
  await expect(
    h.owner.capability.save(base, { ...draft, visibility: "public" }),
  ).rejects.toThrow("changed");
  expect(h.sign).not.toHaveBeenCalled();
});
it.each([
  ["public", "private", "private"],
  ["private", "public", "open"],
  ["public", "public", undefined],
  ["private", "private", undefined],
] as const)(
  "saves %s → %s with only intentional visibility changes",
  async (before, after, tag) => {
    const h = harness();
    h.set([h.metadata("original", "", before), ...h.events().slice(1)]);
    const base = await h.owner.capability.load(id);
    h.publish.mockImplementationOnce(async () => {
      h.set([
        h.metadata(draft.name, draft.description, after),
        ...h.events().slice(1),
      ]);
    });
    await h.owner.capability.save(base, { ...draft, visibility: after });
    const command = h.sign.mock.calls[0]?.[0];
    assert(command);
    expect(command.tags.find(([key]) => key === "visibility")).toEqual(
      tag ? ["visibility", tag] : undefined,
    );
    expect(() => validateDetailsTemplate(command)).not.toThrow();
    expect(h.owner.capability.snapshot(id)).toBeUndefined();
  },
);
it("a metadata change while signing a reopening prevents publication", async () => {
  const h = harness();
  h.set([h.metadata("original", "", "private"), ...h.events().slice(1)]);
  const base = await h.owner.capability.load(id);
  h.sign.mockImplementationOnce(async (event) => {
    h.set([h.metadata("changed", "", "private"), ...h.events().slice(1)]);
    return finalizeEvent(event, key);
  });
  await expect(
    h.owner.capability.save(base, { ...draft, visibility: "public" }),
  ).rejects.toThrow("Reload details");
  expect(h.publish).not.toHaveBeenCalled();
});
it("unconfirmed reopening retains the public draft and checks without resending", async () => {
  const h = harness();
  h.set([h.metadata("original", "", "private"), ...h.events().slice(1)]);
  const base = await h.owner.capability.load(id);
  const reopening = { ...draft, visibility: "public" as const };
  h.publish.mockRejectedValueOnce(new Error("lost response"));
  await expect(h.owner.capability.save(base, reopening)).rejects.toThrow(
    "may have been saved",
  );
  expect(h.owner.capability.snapshot(id)).toEqual({
    draft: reopening,
    status: "unconfirmed",
  });
  await expect(h.owner.capability.check(id)).rejects.toThrow(
    "may have been saved",
  );
  h.set([
    h.metadata(draft.name, draft.description, "public"),
    ...h.events().slice(1),
  ]);
  await h.owner.capability.check(id);
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.owner.capability.snapshot(id)).toBeUndefined();
});
it("saves retained edits after reloading a channel made private by another editor", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  h.set([
    h.metadata("other edit", "Other description", "private"),
    ...h.events().slice(1),
  ]);
  await expect(
    h.owner.capability.save(base, { ...draft, visibility: "public" }),
  ).rejects.toThrow("Reload details");
  expect(h.sign).not.toHaveBeenCalled();
  const reloaded = await h.owner.capability.load(id);
  await h.owner.capability.save(reloaded, {
    ...draft,
    visibility: reloaded.visibility,
  });
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.owner.capability.snapshot(id)).toBeUndefined();
});
it.each(["dm", "session", "archived"])("does not edit %s", async (type) => {
  const h = harness();
  const tags = [
    ["name", "name"],
    ["about", type === "session" ? sessionDescription(id) : ""],
    ["private"],
    ["t", type === "dm" ? "dm" : "stream"],
    ...(type === "archived" ? [["archived", "true"]] : []),
  ];
  h.set([h.record(39000, tags), ...h.events().slice(1)]);
  const base = await h.owner.capability.load(id);
  expect(base.canEdit).toBe(false);
});
it("rejects unknown visibility, foreign coordinates and malformed admin state", async () => {
  const h = harness();
  for (const metadata of [
    h.record(39000, [
      ["name", "name"],
      ["t", "stream"],
    ]),
    h.record(39000, [
      ["name", "name"],
      ["t", "stream"],
      ["public"],
      ["private"],
    ]),
    h.record(39000, [
      ["d", "other"],
      ["name", "name"],
      ["t", "stream"],
      ["public"],
    ]),
  ]) {
    expect(() =>
      detailsSettings(
        [metadata, ...h.events().slice(1)],
        id,
        viewer,
        relayAuthor,
      ),
    ).toThrow();
  }
  expect(() => detailsSettings(h.events(), id, viewer, viewer)).toThrow();
  expect(() =>
    detailsSettings(
      [
        h.entry(0),
        h.record(39001, [
          ["p", viewer, "owner"],
          ["p", viewer, "admin"],
        ]),
        h.entry(2),
      ],
      id,
      viewer,
      relayAuthor,
    ),
  ).toThrow();
});
it("rejects an in-place mutated signer response", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  h.sign.mockImplementationOnce(async (event) => {
    event.tags[1] = ["name", "surprise"];
    return finalizeEvent(event, key);
  });
  await expect(h.owner.capability.save(base, draft)).rejects.toThrow(
    "Signer changed",
  );
  expect(h.publish).not.toHaveBeenCalled();
});
it("retains edits on rejection but locks unknown outcomes until read-only confirmation", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  h.publish.mockRejectedValueOnce(new PublishRejected("Not permitted"));
  await expect(h.owner.capability.save(base, draft)).rejects.toThrow(
    "Not permitted",
  );
  expect(h.owner.capability.snapshot(id)).toBeUndefined();
  h.publish.mockRejectedValueOnce(new Error("lost response"));
  await expect(h.owner.capability.save(base, draft)).rejects.toThrow(
    "may have been saved",
  );
  expect(h.owner.capability.snapshot(id)).toEqual({
    draft,
    status: "unconfirmed",
  });
  await expect(h.owner.capability.save(base, draft)).rejects.toThrow(
    "previous change",
  );
  await expect(h.owner.capability.check(id)).rejects.toThrow(
    "may have been saved",
  );
  h.set([
    h.metadata(draft.name, draft.description, draft.visibility),
    ...h.events().slice(1),
  ]);
  await h.owner.capability.check(id);
  expect(h.owner.capability.snapshot(id)).toBeUndefined();
  expect(h.publish).toHaveBeenCalledTimes(2);
});
it("receipt alone is not success and repeated Save cannot publish twice", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  const gate = deferred<void>(),
    started = deferred<void>();
  h.publish.mockImplementationOnce(async () => {
    started.resolve();
    await gate.promise;
  });
  const result = expect(h.owner.capability.save(base, draft)).rejects.toThrow(
    "may have been saved",
  );
  await started.promise;
  await expect(h.owner.capability.save(base, draft)).rejects.toThrow(
    "previous change",
  );
  gate.resolve();
  await result;
  expect(h.owner.capability.snapshot(id)?.status).toBe("unconfirmed");
  expect(h.publish).toHaveBeenCalledOnce();
});
it.each(["cancel", "clear", "dispose"] as const)(
  "%s fences late publication/readback",
  async (action) => {
    const h = harness();
    const base = await h.owner.capability.load(id);
    h.acceptDiscovery.mockClear();
    const gate = deferred<void>(),
      started = deferred<void>();
    h.publish.mockImplementationOnce(async () => {
      started.resolve();
      await gate.promise;
      h.set([
        h.metadata(draft.name, draft.description, draft.visibility),
        ...h.events().slice(1),
      ]);
    });
    const result = expect(
      h.owner.capability.save(base, draft),
    ).rejects.toThrow();
    await started.promise;
    h.owner[action]();
    gate.resolve();
    await result;
    expect(h.acceptDiscovery).not.toHaveBeenCalled();
    expect(h.owner.capability.snapshot(id)?.status).toBe(
      action === "dispose" ? undefined : "unconfirmed",
    );
  },
);
it("access loss and an aborted late load cannot update discovery", async () => {
  const h = harness();
  const gate = deferred<RelayEvent[]>();
  h.read.mockImplementationOnce(() => gate.promise);
  const result = expect(h.owner.capability.load(id)).rejects.toThrow();
  h.revoke();
  h.owner.cancel();
  gate.resolve(h.events());
  await result;
  expect(h.acceptDiscovery).not.toHaveBeenCalled();
});
it("admits only bounded name/about/visibility/lifetime metadata and preserves explicit description clearing", () => {
  const template = detailsTemplate(id, { ...draft, description: "" }, draft);
  expect(template.tags).toContainEqual(["about", ""]);
  expect(() => validateDetailsTemplate(template)).not.toThrow();
  const invalid = [
    { ...template, kind: 9000 },
    { ...template, content: "extra" },
    { ...template, tags: [...template.tags, ["ttl", "0"]] },
    ...["public", "", "hidden"].map((value) => ({
      ...template,
      tags: [...template.tags.slice(0, 3), ["visibility", value]],
    })),
    {
      ...template,
      tags: [
        ["h", id],
        ["name", " "],
        ["about", ""],
      ],
    },
    {
      ...template,
      tags: [
        ["h", id],
        ["name", "x".repeat(121)],
        ["about", ""],
      ],
    },
    {
      ...template,
      tags: [
        ["h", id],
        ["name", "name"],
        ["about", "x".repeat(1001)],
      ],
    },
    {
      ...template,
      tags: [
        ["h", id],
        ["name", "name"],
        ["about", "Buzz session (fake)"],
      ],
    },
  ];
  for (const event of invalid)
    expect(() => validateDetailsTemplate(event)).toThrow();
  const h = harness();
  expect(channelVisibility(h.record(39000, []))).toBeUndefined();
});

it("production session wiring updates shared discovery and cancels a retiring owner's read", async () => {
  const h = harness();
  const owner = createRelaySession({
    viewer,
    relayAuthor,
    query: async (filters: readonly ReadFilter[]) =>
      h
        .events()
        .filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
    channelDetails: { sign: h.sign, publish: h.publish },
    media: (url) => url,
  });
  cleanup.push(owner.dispose);
  owner.session.channels.refreshList?.();
  await vi.waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  const base = await owner.session.channelDetails.load(id);
  await owner.session.channelDetails.save(base, draft);
  expect(owner.session.channels.list().channels[0]).toMatchObject({
    name: draft.name,
    description: draft.description,
    visibility: "private",
  });
  owner.dispose();
  await expect(owner.session.channelDetails.load(id)).rejects.toThrow();
});

it.each([
  ["\u0085# \u0085#renamed\u0085", "renamed"],
  ["\t # # renamed\u00a0", "renamed"],
  ["\u2000#renamed\u3000", "renamed"],
  ["\ufeffrenamed\ufeff", "\ufeffrenamed\ufeff"],
  ["re\u0085named#", "re\u0085named#"],
])(
  "uses relay canonicalization for %j before signing and confirming",
  async (input, expected) => {
    const h = harness();
    const base = await h.owner.capability.load(id);
    const name = canonicalDetailsName(input);
    expect(name).toBe(expected);
    if (input !== expected) {
      await expect(
        h.owner.capability.save(base, { ...draft, name: input }),
      ).rejects.toThrow("Enter a channel name");
      expect(h.sign).not.toHaveBeenCalled();
      expect(h.owner.capability.snapshot(id)).toBeUndefined();
      const command = detailsTemplate(id, draft, draft);
      command.tags[1] = ["name", input];
      expect(() => validateDetailsTemplate(command)).toThrow(
        "Enter a channel name",
      );
    }
    h.publish.mockImplementationOnce(async () => {
      h.set([
        h.metadata(expected, draft.description, draft.visibility),
        ...h.events().slice(1),
      ]);
    });
    await h.owner.capability.save(base, { ...draft, name });
    expect(h.sign.mock.calls[0]?.[0].tags).toContainEqual(["name", expected]);
    expect(h.owner.capability.snapshot(id)).toBeUndefined();
    expect(h.publish).toHaveBeenCalledOnce();
  },
);

it.each([undefined, 3600, 2147483647])(
  "reads exact duration %s from signed metadata",
  async (ttlSeconds) => {
    const h = harness();
    h.set([
      h.record(39000, [
        ...h.entry(0).tags.slice(1),
        ...(ttlSeconds === undefined ? [] : [["ttl", String(ttlSeconds)]]),
      ]),
      ...h.events().slice(1),
    ]);
    expect((await h.owner.capability.load(id)).ttlSeconds).toBe(ttlSeconds);
  },
);
it.each([
  [["ttl"]],
  [["ttl", ""]],
  [["ttl", "0"]],
  [["ttl", "2147483648"]],
  [["ttl", "60", "extra"]],
  [
    ["ttl", "60"],
    ["ttl", "60"],
  ],
])("rejects ambiguous or invalid metadata duration %j", async (...tags) => {
  const h = harness();
  h.set([
    h.record(39000, [...h.entry(0).tags.slice(1), ...tags]),
    ...h.events().slice(1),
  ]);
  await expect(h.owner.capability.load(id)).rejects.toThrow();
});
it.each([
  [undefined, 604800, "604800"],
  [3600, undefined, ""],
  [3600, 3600, undefined],
])(
  "saves duration %s → %s without resetting unchanged cleanup deadlines",
  async (before, after, tag) => {
    const h = harness();
    const metadata = (ttl: number | undefined) =>
      h.record(39000, [
        ["name", draft.name],
        ["about", draft.description],
        ["private"],
        ["t", "stream"],
        ...(ttl === undefined ? [] : [["ttl", String(ttl)]]),
      ]);
    h.set([metadata(before), ...h.events().slice(1)]);
    const base = await h.owner.capability.load(id);
    h.publish.mockImplementationOnce(async () => {
      h.set([metadata(after), ...h.events().slice(1)]);
    });
    await h.owner.capability.save(base, { ...draft, ttlSeconds: after });
    const command = h.sign.mock.calls[0]?.[0];
    expect(command?.tags.filter(([key]) => key === "ttl")).toEqual(
      tag === undefined ? [] : [["ttl", tag]],
    );
    expect(() =>
      validateDetailsTemplate(command as EventTemplate),
    ).not.toThrow();
    expect((await h.owner.capability.load(id)).ttlSeconds).toBe(after);
  },
);
it("locks a mismatched lifetime readback and only clears it after matching read-only confirmation", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  const temporary = { ...draft, ttlSeconds: 604800 };
  await expect(h.owner.capability.save(base, temporary)).rejects.toThrow(
    "may have been saved",
  );
  expect(h.owner.capability.snapshot(id)).toEqual({
    draft: temporary,
    status: "unconfirmed",
  });
  h.set([
    h.record(39000, [...h.entry(0).tags.slice(1), ["ttl", "604800"]]),
    ...h.events().slice(1),
  ]);
  await h.owner.capability.check(id);
  expect(h.owner.capability.snapshot(id)).toBeUndefined();
  expect(h.publish).toHaveBeenCalledOnce();
});
it.each([0, 1.5, 2147483648, "60"])(
  "rejects invalid draft duration %j before signing",
  async (ttlSeconds) => {
    const h = harness();
    const base = await h.owner.capability.load(id);
    await expect(
      h.owner.capability.save(base, {
        ...draft,
        ttlSeconds: ttlSeconds as number,
      }),
    ).rejects.toThrow("duration");
    expect(h.sign).not.toHaveBeenCalled();
  },
);
it("allows only a single canonical TTL command tag without widening other fields", () => {
  const template = detailsTemplate(id, draft, draft);
  for (const tail of [
    [["ttl"]],
    [["ttl", "0"]],
    [["ttl", "-1"]],
    [["ttl", "1.5"]],
    [["ttl", "01"]],
    [["ttl", "2147483648"]],
    [["ttl", "60", "extra"]],
    [
      ["ttl", "60"],
      ["ttl", "60"],
    ],
    [
      ["ttl", "60"],
      ["visibility", "private"],
    ],
    [["visibility,ttl", "private"]],
    [["", ""]],
    [["archived", "true"]],
  ])
    expect(() =>
      validateDetailsTemplate({
        ...template,
        tags: [...template.tags.slice(0, 3), ...tail],
      }),
    ).toThrow();
  for (const ttl of ["", "1", "604800", "2147483647"]) {
    for (const tags of [
      template.tags,
      [...template.tags, ["visibility", "private"]],
      [...template.tags, ["visibility", "open"]],
    ])
      expect(() =>
        validateDetailsTemplate({ ...template, tags: [...tags, ["ttl", ttl]] }),
      ).not.toThrow();
  }
});

it("renames standalone sessions with a name-only command and confirmed relay readback", async () => {
  const h = harness();
  h.set([
    h.metadata("Old title", sessionDescription(), "private"),
    ...h.events().slice(1),
  ]);
  const base = await h.owner.capability.load(id);
  expect(base.canEdit).toBe(true);
  h.publish.mockImplementationOnce(async () => {
    h.set([
      h.metadata("New title", sessionDescription(), "private"),
      ...h.events().slice(1),
    ]);
  });
  await h.owner.capability.save(base, { ...base, name: "New title" });
  const command = h.sign.mock.calls[0]?.[0];
  expect(command?.tags).toEqual([
    ["h", id],
    ["name", "New title"],
  ]);
  assert(command);
  expect(() => validateDetailsTemplate(command)).not.toThrow();
  expect(h.acceptDiscovery).toHaveBeenLastCalledWith([h.events()[0]]);
});
it.each([false, true])(
  "promotes a standalone session in place (public/temporary=%s)",
  async (changed) => {
    const h = harness();
    h.set([
      h.metadata("Work", sessionDescription(), "private"),
      ...h.events().slice(1),
    ]);
    const base = await h.owner.capability.load(id);
    const promotion = {
      name: "Work",
      description: "",
      visibility: changed ? ("public" as const) : ("private" as const),
      ...(changed ? { ttlSeconds: 600 } : {}),
    };
    h.publish.mockImplementationOnce(async () => {
      h.set([
        h.record(39000, [
          ["name", promotion.name],
          ["about", ""],
          [promotion.visibility],
          ["t", "stream"],
          ...(changed ? [["ttl", "600"]] : []),
        ]),
        ...h.events().slice(1),
      ]);
    });
    await h.owner.capability.save(base, promotion);
    const command = h.sign.mock.calls[0]?.[0];
    assert(command);
    expect(command.tags).toEqual([
      ["h", id],
      ["name", "Work"],
      ["about", ""],
      ...(changed
        ? [
            ["visibility", "open"],
            ["ttl", "600"],
          ]
        : []),
    ]);
    expect(() => validateDetailsTemplate(command)).not.toThrow();
    expect(h.acceptDiscovery).toHaveBeenLastCalledWith([h.events()[0]]);
    expect(h.owner.capability.snapshot(id)).toBeUndefined();
  },
);
it("does not promote parent-linked sessions", async () => {
  const h = harness();
  h.set([
    h.metadata("Work", sessionDescription(id), "private"),
    ...h.events().slice(1),
  ]);
  const base = await h.owner.capability.load(id);
  expect(base.canEdit).toBe(false);
  await expect(
    h.owner.capability.save(base, { ...base, description: "" }),
  ).rejects.toThrow("permission");
  expect(h.sign).not.toHaveBeenCalled();
});
it.each([
  { description: "ordinary channel" },
  { visibility: "public" as const },
  { ttlSeconds: 600 },
])(
  "rejects session metadata changes alongside renaming: %j",
  async (change) => {
    const h = harness();
    h.set([
      h.metadata("Old title", sessionDescription(), "private"),
      ...h.events().slice(1),
    ]);
    const base = await h.owner.capability.load(id);
    await expect(
      h.owner.capability.save(base, { ...base, name: "New title", ...change }),
    ).rejects.toThrow("Only the name");
    expect(h.sign).not.toHaveBeenCalled();
  },
);

it("writes NIP-CL labels only when the set changes, and admits only valid label tails", () => {
  const base = { ...draft, labels: ["for-you", "demo"] };
  const tagsOf = (labels?: readonly string[]) =>
    detailsTemplate(id, { ...draft, labels }, base).tags;
  // Absent or the same set (any order) sends no `t`, so the relay keeps it.
  expect(tagsOf(undefined).some(([key]) => key === "t")).toBe(false);
  expect(tagsOf(["demo", "for-you"]).some(([key]) => key === "t")).toBe(false);
  // A new set replaces it; an empty set clears it with one empty `t`.
  expect(tagsOf(["for-you", "app:records"]).slice(3)).toEqual([
    ["t", "for-you"],
    ["t", "app:records"],
  ]);
  expect(tagsOf([]).slice(3)).toEqual([["t", ""]]);
  for (const labels of [["for-you"], [], ["a", "b", "c"]]) {
    const template = detailsTemplate(id, { ...draft, labels }, base);
    expect(() => validateDetailsTemplate(template)).not.toThrow();
  }
  for (const labels of [["System"], ["stream"], ["x".repeat(65)], ["a b"]])
    expect(() => tagsOf(labels)).toThrow(/channel labels/);
  expect(() => tagsOf(Array.from({ length: 9 }, (_, n) => `l${n}`))).toThrow(
    /at most 8/,
  );
  const head = [
    ["h", id],
    ["name", "renamed"],
    ["about", ""],
  ];
  for (const tail of [
    [["t", "system"]],
    [
      ["t", "a"],
      ["t", "a"],
    ],
    [
      ["t", ""],
      ["t", "a"],
    ],
    [
      ["t", "a"],
      ["visibility", "open"],
    ],
    [["t", "a", "extra"]],
    Array.from({ length: 9 }, (_, n) => ["t", `l${n}`]),
  ])
    expect(() =>
      validateDetailsTemplate({
        kind: 9002,
        created_at: 1,
        content: "",
        tags: [...head, ...tail],
      }),
    ).toThrow();
  expect(() =>
    validateDetailsTemplate({
      kind: 9002,
      created_at: 1,
      content: "",
      tags: [...head, ["visibility", "open"], ["ttl", ""], ["t", "a"]],
    }),
  ).not.toThrow();
});

it("refuses a label change without signing when the relay does not advertise NIP-CL", async () => {
  const old = harness();
  const base = await old.owner.capability.load(id);
  expect(base.labels).toEqual([]);
  await expect(
    old.owner.capability.save(base, { ...draft, labels: ["for-you"] }),
  ).rejects.toThrow(/does not support channel labels/);
  expect(old.sign).not.toHaveBeenCalled();
  // Other edits still save, with the unchanged (empty) label set.
  await old.owner.capability.save(base, { ...draft, labels: [] });
  expect(old.publish).toHaveBeenCalledOnce();

  const supported = harness("owner", true);
  const current = await supported.owner.capability.load(id);
  await supported.owner.capability
    .save(current, { ...draft, labels: ["for-you"] })
    .catch(() => {});
  expect(supported.sign).toHaveBeenCalledOnce();
  expect(supported.sign.mock.calls[0]?.[0].tags).toContainEqual([
    "t",
    "for-you",
  ]);
});
