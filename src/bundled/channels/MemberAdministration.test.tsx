// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { formatPublicKey } from "../../shared/identity/public-key";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import { keypair, profile, signed } from "../../features/relay/testing";
import { matchesEvent } from "../../features/relay/projection";
import type { RelayEvent } from "../../features/relay/events";
import { PublishRejected } from "../../features/relay/outbox";
import type {
  Presence,
  PresenceStatus,
} from "../../features/presence/presence";
import { ChannelMembersButton } from "./ChannelMembersDialog";
import { ToastProvider } from "../../shared/design-system/ui/Toast";

const stops: (() => void)[] = [];
beforeEach(() => {
  // jsdom has no top layer; browser tests own popup paint and hit testing.
  HTMLElement.prototype.showPopover = function () {
    this.style.display = "block";
  };
  // jsdom lacks scrollIntoView; the search highlight keeps its row in view.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  for (const stop of stops.splice(0)) stop();
});
const id = "11111111-1111-4111-8111-111111111111";
async function setup(
  actor = "owner",
  targetRole = "member",
  supported = true,
  roleRead?: Promise<void>,
  targetAgent = false,
  presence?: Presence,
  messageSupport = false,
  messageNavigation = true,
  initialReads?: { names?: Promise<void>; roster?: Promise<void> },
  ownership?: "own" | "other" | "invalid",
  visibility: "private" | "public" = "private",
  targetPicture?: string,
) {
  const viewer = keypair(),
    relay = keypair(),
    target = keypair(),
    owner = keypair();
  const manager = ownership === "other" ? owner : viewer;
  const digest = new Uint8Array(
    createHash("sha256").update(`nostr:agent-auth:${target.pubkey}:`).digest(),
  );
  const profileBody = {
    name: "Morgan",
    is_agent: targetAgent,
    picture: targetPicture,
  };
  const targetProfile = ownership
    ? signed(target, {
        kind: 0,
        content: JSON.stringify(profileBody),
        tags: [
          [
            "auth",
            manager.pubkey,
            "",
            bytesToHex(
              schnorr.sign(
                digest,
                ownership === "invalid" ? target.secret : manager.secret,
              ),
            ),
          ],
        ],
      })
    : profile(target, profileBody);
  let role: string | undefined = targetRole;
  let tick = 1700000000;
  let lag = false;
  const members = () => [
    [viewer.pubkey, actor],
    [owner.pubkey, "owner"],
    ...(role ? [[target.pubkey, role]] : []),
  ];
  const events = () => [
    signed(relay, {
      kind: 39000,
      created_at: tick,
      content: "",
      tags: [["d", id], ["t", "stream"], [visibility], ["name", "Design"]],
    }),
    signed(relay, {
      kind: 39001,
      created_at: tick,
      content: "",
      tags: [
        ["d", id],
        ...members()
          .filter(([, r]) => r === "owner" || r === "admin")
          .map(([key, r]) => ["p", key ?? "", r ?? ""]),
      ],
    }),
    signed(relay, {
      kind: 39002,
      created_at: tick,
      content: "",
      tags: [
        ["d", id],
        ...members().map(([key, r]) => ["p", key ?? "", "", r ?? ""]),
      ],
    }),
    profile(viewer, { name: "Carl" }),
    targetProfile,
    profile(owner, { name: "Owner" }),
  ];
  const publish = vi.fn(async (event: RelayEvent) => {
    if (!lag)
      role =
        event.kind === 9001
          ? undefined
          : event.tags.find(([key]) => key === "role")?.[1];
    tick++;
  });
  let dialogReads = false;
  const query = vi.fn(async (filters: Parameters<typeof matchesEvent>[1][]) => {
    if (filters.some((filter) => filter.kinds?.includes(39001))) await roleRead;
    if (filters.some((filter) => filter.kinds?.includes(0)))
      await initialReads?.names;
    if (dialogReads && filters.some((filter) => filter.kinds?.includes(39002)))
      await initialReads?.roster;
    return events().filter((event) =>
      filters.some((filter) => matchesEvent(event, filter)),
    );
  });
  const media = vi.fn(
    (url: string, size?: "small") =>
      `https://media.example/${size ?? "original"}?url=${encodeURIComponent(url)}`,
  );
  const sessionOwner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media,
    query,
    ...(supported
      ? {
          memberAdministration: {
            sign: async (template) => signed(viewer, template),
            publish,
          },
        }
      : {}),
    writer: {
      kinds: [9, 9000],
      sign: async (template) => signed(viewer, template),
      publish: vi.fn(),
    },
  });
  stops.push(sessionOwner.dispose);
  const session = sessionOwner.session;
  session.channels.ensureList();
  await vi.waitFor(() => expect(session.channels.list().status).toBe("ready"));
  const onOpenLink = vi.fn(() => true);
  const onOpenConversation = vi.fn(() => true);
  const openMessage = vi.fn(
    async (_keys: readonly string[], _signal: AbortSignal) => "dm-1",
  );
  const presentedSession = {
    ...session,
    ...(presence ? { presence } : {}),
    directMessages: {
      ...session.directMessages,
      available: messageSupport,
      open: openMessage,
    },
  };
  render(
    <ToastProvider>
      <ChannelMembersButton
        session={presentedSession}
        channelId={id}
        canOpenLink={() => true}
        onOpenLink={onOpenLink}
        onOpenConversation={messageNavigation ? onOpenConversation : undefined}
      />
    </ToastProvider>,
  );
  const user = userEvent.setup();
  dialogReads = true;
  await user.click(screen.getByRole("button", { name: "Channel members" }));
  if (roleRead || initialReads)
    await screen.findByRole("status", { name: "Loading members" });
  else await screen.findByText("Morgan");
  if (!initialReads)
    await vi.waitFor(() =>
      expect(session.memberAdministration.snapshot(id).status).toBe(
        roleRead ? "loading" : "ready",
      ),
    );
  return {
    user,
    session,
    publish,
    query,
    onOpenLink,
    onOpenConversation,
    openMessage,
    target,
    viewer,
    relay,
    lag: () => {
      lag = true;
    },
    confirm: (next: string | undefined) => {
      role = next;
      tick++;
    },
    choose: async (name: string) => {
      await user.click(
        screen.getByRole("button", { name: "Actions for Morgan" }),
      );
      await user.click(await screen.findByRole("menuitem", { name }));
      expect(onOpenLink).not.toHaveBeenCalled();
      return screen.findByRole("dialog", {
        name:
          name === "Remove from channel"
            ? `Remove ${targetAgent ? "agent" : "member"} from channel`
            : "Change member role?",
      });
    },
  };
}
it.each([
  ["member", "admin", ["Owner", "Morgan", "Carl"]],
  ["admin", "member", ["Owner", "Carl", "Morgan"]],
  ["owner", "owner", ["Carl", "Morgan", "Owner"]],
  ["admin", "admin", ["Owner", "Carl", "Morgan"]],
  ["member", "guest", ["Owner", "Carl", "Morgan"]],
] as const)(
  "orders owners, admins, then everyone else alphabetically (viewer: %s, target: %s)",
  async (actor, target, expected) => {
    const t = await setup(actor, target);
    expect(memberOrder()).toEqual(expected);
    const groupFor = (role: string) =>
      role === "owner" ? "Owners" : role === "admin" ? "Admins" : "Members";
    for (const [name, role] of [
      ["Carl", actor],
      ["Morgan", target],
      ["Owner", "owner"],
    ]) {
      const row = screen.getByRole("button", {
        name: new RegExp(`^Open profile for ${name}`),
      });
      expect(row.closest("section")).toHaveAttribute(
        "aria-label",
        groupFor(required(role)),
      );
      expect(
        within(required(row.closest("li"))).queryByText(required(role)),
      ).not.toBeInTheDocument();
    }
    await t.user.type(screen.getByRole("searchbox"), "o");
    expect(memberOrder()).toEqual(expected.filter((name) => name !== "Carl"));
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it.each([
  [true, "owner", "Owners"],
  [true, "admin", "Admins"],
  [true, "member", "Agents"],
  [false, "bot", "Members"],
] as const)(
  "groups agent identities below elevated roles (agent: %s, role: %s)",
  async (agent, role, expected) => {
    const t = await setup("member", role, true, undefined, agent);
    const row = screen.getByRole("button", {
      name: /^Open profile for Morgan/,
    });
    expect(row.closest("section")).toHaveAttribute("aria-label", expected);
    expect(memberOrder()).toEqual(
      role === "owner"
        ? ["Morgan", "Owner", "Carl"]
        : role === "admin"
          ? ["Owner", "Morgan", "Carl"]
          : ["Owner", "Carl", "Morgan"],
    );
    const count = expected === "Owners" || expected === "Members" ? 2 : 1;
    await t.user.type(screen.getByRole("searchbox"), "Morgan");
    expect(memberOrder()).toEqual(["Morgan"]);
    expect(
      screen.getByRole("heading", { name: `${expected} · ${count}` }),
    ).toBeVisible();
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("moves an agent between elevated roles and Agents after a verified refresh", async () => {
  const t = await setup("member", "member", true, undefined, true);
  const refresh = screen.getByRole("button", { name: "Refresh member data" });
  for (const [role, group] of [
    ["admin", "Admins"],
    ["owner", "Owners"],
    ["member", "Agents"],
  ]) {
    await vi.waitFor(() =>
      expect(refresh).toHaveAttribute("aria-busy", "false"),
    );
    t.confirm(role);
    await t.user.click(refresh);
    await vi.waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /Open profile for Morgan/ })
          .closest("section"),
      ).toHaveAttribute("aria-label", group),
    );
  }
  expect(t.publish).not.toHaveBeenCalled();
});

it("withholds initial rows until roles settle, then preserves content through refresh", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const t = await setup("member", "member", true, gate);
  try {
    expect(
      screen.getByRole("status", { name: "Loading members" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /^Open profile for/ }),
    ).toBeNull();
  } finally {
    await act(async () => release());
  }
  const refresh = screen.getByRole("button", { name: "Refresh member data" });
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  expect(memberOrder()).toEqual(["Owner", "Carl", "Morgan"]);
  t.confirm("admin");
  await t.user.click(refresh);
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  expect(memberOrder()).toEqual(["Owner", "Morgan", "Carl"]);
  const query = required(t.query.getMockImplementation());
  t.query.mockRejectedValue(new Error("Read failed"));
  await t.user.click(refresh);
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  expect(memberOrder()).toEqual(["Owner", "Morgan", "Carl"]);
  t.query.mockImplementation(query);
  t.confirm("member");
  await t.user.click(refresh);
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  expect(memberOrder()).toEqual(["Owner", "Carl", "Morgan"]);
  expect(t.publish).not.toHaveBeenCalled();
});

function memberOrder() {
  return within(screen.getByRole("region", { name: "Member list" }))
    .getAllByRole("button", { name: /^Open profile for/ })
    .map((row) =>
      required(row.getAttribute("aria-label"))
        .split(" (")[0]
        ?.replace("Open profile for ", ""),
    );
}

it.each([false, true])(
  "withholds rows during the initial role read, then shows the result (failure: %s)",
  async (failure) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    }).then(() => {
      if (failure) throw new Error("Roles unavailable");
    });
    try {
      const t = await setup("owner", "member", true, gate);
      await vi.waitFor(() =>
        expect(
          t.query.mock.calls.some(([filters]) =>
            filters.some((filter) => filter.kinds?.includes(39001)),
          ),
        ).toBe(true),
      );
      expect(
        screen.getByRole("status", { name: "Loading members" }),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: /^Open profile for/ }),
      ).toBeNull();
      await act(async () => release());
      await vi.waitFor(() =>
        expect(t.session.memberAdministration.snapshot(id).status).toBe(
          failure ? "error" : "ready",
        ),
      );
      const row = await screen.findByRole("button", {
        name: /Open profile for Morgan/,
      });
      expect(
        screen.queryByRole("status", { name: "Loading members" }),
      ).toBeNull();
      expect(row.closest("li")).not.toHaveTextContent(
        /Role unverified|^member$/,
      );
      expect(row).toHaveAccessibleName(
        failure ? /Role unverified/ : /, member$/,
      );
      expect(t.publish).not.toHaveBeenCalled();
    } finally {
      await act(async () => release());
    }
  },
);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["names", "roles", "roster"] as const)(
  "shows only a list spinner until the last required read settles: %s",
  async (last) => {
    const gates = { names: deferred(), roles: deferred(), roster: deferred() };
    try {
      const t = await setup(
        "member",
        "member",
        true,
        gates.roles.promise,
        false,
        undefined,
        false,
        true,
        { names: gates.names.promise, roster: gates.roster.promise },
      );
      const list = screen.getByRole("region", { name: "Member list" });
      const search = screen.getByRole("searchbox");
      await vi.waitFor(() => {
        for (const kind of [0, 39001, 39002])
          expect(
            t.query.mock.calls.some(([filters]) =>
              filters.some((filter) => filter.kinds?.includes(kind)),
            ),
          ).toBe(true);
      });
      await act(async () => {
        for (const [key, gate] of Object.entries(gates))
          if (key !== last) gate.resolve();
      });
      expect(
        within(list).getByRole("status", { name: "Loading members" }),
      ).toBeVisible();
      expect(
        within(list).queryByRole("button", { name: /^Open profile for/ }),
      ).toBeNull();
      expect(within(list).queryByRole("heading")).toBeNull();
      expect(screen.getByRole("searchbox")).toBe(search);
      await act(async () => gates[last].resolve());
      await screen.findByText("Morgan");
      expect(memberOrder()).toEqual(["Owner", "Carl", "Morgan"]);
      expect(
        screen.queryByRole("status", { name: "Loading members" }),
      ).toBeNull();
      expect(screen.getByRole("region", { name: "Member list" })).toBe(list);
      expect(screen.getByRole("searchbox")).toHaveFocus();
      expect(t.publish).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        for (const gate of Object.values(gates)) gate.resolve();
      });
    }
  },
);

it("keeps resolved rows and focus while refreshing, and reopens warm without a spinner", async () => {
  const t = await setup();
  const refresh = screen.getByRole("button", { name: "Refresh member data" });
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  const gate = deferred();
  const query = required(t.query.getMockImplementation());
  t.query.mockImplementation(async (filters) => {
    await gate.promise;
    return query(filters);
  });
  try {
    const row = screen.getByRole("button", { name: /Open profile for Morgan/ });
    const list = screen.getByRole("region", { name: "Member list" });
    list.scrollTop = 24;
    await t.user.click(refresh);
    expect(
      screen.queryByRole("status", { name: "Loading members" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: /Open profile for Morgan/ }),
    ).toBe(row);
    expect(refresh).toHaveFocus();
    expect(list.scrollTop).toBe(24);
    await act(async () => gate.resolve());
    await vi.waitFor(() =>
      expect(refresh).toHaveAttribute("aria-busy", "false"),
    );
    await t.user.click(
      screen.getByRole("button", { name: "Close channel members" }),
    );
    const reopen = deferred();
    t.query.mockImplementation(async (filters) => {
      await reopen.promise;
      return query(filters);
    });
    try {
      await t.user.click(
        screen.getByRole("button", { name: "Channel members" }),
      );
      expect(
        screen.queryByRole("status", { name: "Loading members" }),
      ).toBeNull();
      expect(memberOrder()).toEqual(["Carl", "Owner", "Morgan"]);
    } finally {
      await act(async () => reopen.resolve());
    }
  } finally {
    await act(async () => gate.resolve());
  }
});

it("presents verified roles, protects owners/self, and confirms a separate deliberate role intent", async () => {
  const t = await setup();
  await expectProfileOnly(t.user, "Carl");
  await expectProfileOnly(t.user, "Owner");
  const row = required(screen.getByText("Morgan").closest("li"));
  expect(row.closest("section")).toHaveAttribute("aria-label", "Members");
  let dialog = await t.choose("Make admin");
  await vi.waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus(),
  );
  expect(
    within(dialog).getByRole("button", { name: "Cancel" }),
  ).toHaveAttribute("data-variant", "subtle");
  expect(
    within(dialog).getByRole("button", { name: "Make admin" }),
  ).toHaveAttribute("data-variant", "prominent");
  expect(t.publish).not.toHaveBeenCalled();
  await t.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(t.publish).not.toHaveBeenCalled();
  dialog = await t.choose("Make admin");
  await t.user.click(
    within(dialog).getByRole("button", { name: "Make admin" }),
  );
  await vi.waitFor(() =>
    expect(t.session.memberAdministration.snapshot(id).operation?.status).toBe(
      "confirmed",
    ),
  );
  expect(
    screen.queryByText("Member change confirmed."),
  ).not.toBeInTheDocument();
  expect(
    screen
      .getByRole("button", { name: /Open profile for Morgan/ })
      .closest("section"),
  ).toHaveAttribute("aria-label", "Admins");
  expect(t.publish).toHaveBeenCalledOnce();
});
it.each(["cancel", "close", "escape", "outside"])(
  "returns from confirmation with %s without losing the search or sending a write",
  async (dismiss) => {
    const t = await setup();
    const original = screen.getByRole("dialog", { name: "Channel members" });
    await t.user.type(screen.getByRole("searchbox"), "Morgan");
    const dialog = await t.choose("Remove from channel");
    expect(dialog).toBe(original);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await vi.waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Cancel" }),
      ).toHaveFocus(),
    );
    if (dismiss === "escape") await t.user.keyboard("{Escape}");
    else if (dismiss === "outside")
      await t.user.click(
        required(document.querySelector<HTMLElement>(".buzz-dialog-backdrop")),
      );
    else
      await t.user.click(
        within(dialog).getByRole("button", {
          name: dismiss === "cancel" ? "Cancel" : "Back to channel members",
        }),
      );
    const search = await screen.findByRole("searchbox");
    expect(search).toHaveValue("Morgan");
    await vi.waitFor(() => expect(search).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "Channel members" })).toBe(
      original,
    );
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("keeps confirmation read-only when the verified target role changes", async () => {
  const t = await setup();
  const dialog = await t.choose("Remove from channel");
  t.confirm("owner");
  await act(async () => t.session.memberAdministration.refresh(id));
  const remove = within(dialog).getByRole("button", { name: "Remove member" });
  expect(remove).toBeDisabled();
  await t.user.click(remove);
  expect(t.publish).not.toHaveBeenCalled();
  await t.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await screen.findByRole("searchbox");
});

it("confirms removal and removes only the confirmed roster entry", async () => {
  const t = await setup();
  const membersDialog = screen.getByRole("dialog", { name: "Channel members" });
  const dialog = await t.choose("Remove from channel");
  expect(dialog).toBe(membersDialog);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  expect(
    required(
      dialog.querySelector(
        '.buzz-dialog-step:not([aria-hidden="true"]) > .buzz-dialog-body',
      ),
    ),
  ).toBeEmptyDOMElement();
  expect(
    within(dialog).getByRole("button", { name: "Cancel" }),
  ).toHaveAttribute("data-variant", "subtle");
  expect(
    within(dialog).getByRole("button", { name: "Remove member" }),
  ).toHaveAttribute("data-variant", "destructive");
  expect(screen.getAllByText("Morgan").length).toBeGreaterThan(0);
  await t.user.click(
    within(dialog).getByRole("button", { name: "Remove member" }),
  );
  await vi.waitFor(() =>
    expect(t.session.memberAdministration.snapshot(id).operation?.status).toBe(
      "confirmed",
    ),
  );
  expect(
    screen.queryByText("Member change confirmed."),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Open profile for Morgan/ }),
  ).not.toBeInTheDocument();
  expect(t.session.channels.get?.(id)?.members).not.toContain(t.target.pubkey);
});
it.each(["member", "guest"])(
  "keeps ordinary invitations usable for %s without admin controls",
  async (actor) => {
    const t = await setup(actor);
    await expectProfileOnly(t.user, "Morgan");
    expect(screen.getByRole("searchbox")).toHaveAttribute(
      "placeholder",
      "Add people and agents",
    );
  },
);
it.each([
  ["member", ["Make admin", "Remove from channel"]],
  ["admin", ["Make member", "Remove from channel"]],
  ["guest", ["Make admin", "Make member", "Remove from channel"]],
] as const)(
  "omits Guest assignment while preserving the verified %s role and supported actions",
  async (role, actions) => {
    const t = await setup("owner", role);
    const row = required(screen.getByText("Morgan").closest("li"));
    expect(
      within(row).getByRole("button", { name: /Open profile/ }),
    ).toHaveAccessibleName(new RegExp(`, ${role}$`));
    await t.user.click(
      screen.getByRole("button", { name: "Actions for Morgan" }),
    );
    await screen.findByRole("menuitem", { name: "Remove from channel" });
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["View profile", ...actions]);
    await t.user.keyboard("{Escape}");
    expect(
      within(row).getByRole("button", { name: /Open profile/ }),
    ).toHaveAccessibleName(new RegExp(`, ${role}$`));
    expect(t.publish).not.toHaveBeenCalled();
  },
);
it("changes an existing Guest to Member only after explicit confirmation", async () => {
  const t = await setup("owner", "guest");
  const dialog = await t.choose("Make member");
  expect(dialog).toHaveTextContent("from guest to member");
  expect(t.publish).not.toHaveBeenCalled();
  await t.user.click(
    within(dialog).getByRole("button", { name: "Make member" }),
  );
  await vi.waitFor(() =>
    expect(t.session.memberAdministration.snapshot(id).operation?.status).toBe(
      "confirmed",
    ),
  );
  expect(
    screen.queryByText("Member change confirmed."),
  ).not.toBeInTheDocument();
  expect(
    screen
      .getByRole("button", { name: /Open profile for Morgan/ })
      .closest("section"),
  ).toHaveAttribute("aria-label", "Members");
  expect(t.publish).toHaveBeenCalledOnce();
});
it.each([false, true])(
  "groups Bot by identity while retaining its accessible role and explicit role controls (Agent: %s)",
  async (agent) => {
    const t = await setup("owner", "bot", true, undefined, agent);
    const row = screen.getByRole("button", { name: /Open profile for Morgan/ });
    if (agent) {
      expect(
        row.closest("li")?.querySelector('[data-avatar-shape="squircle"]'),
      ).toBeInTheDocument();
      expect(row.closest("section")).toHaveAttribute("aria-label", "Agents");
      expect(
        within(required(row.closest("li"))).queryByText("bot"),
      ).not.toBeInTheDocument();
      expect(row).toHaveAccessibleName(/, member$/);
      expect(row).not.toHaveAccessibleName(/, bot/);
    } else {
      expect(
        within(required(row.closest("li"))).queryByText("Agent"),
      ).not.toBeInTheDocument();
      expect(row.closest("section")).toHaveAttribute("aria-label", "Members");
      expect(row).toHaveAccessibleName(/, bot/);
    }
    expect(
      t.session.memberAdministration.snapshot(id).authority.roles[
        t.target.pubkey
      ],
    ).toBe("bot");
    await t.user.click(
      screen.getByRole("button", { name: "Actions for Morgan" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Remove from channel" }),
    ).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Make admin" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Make member" })).toBeVisible();
    expect(t.publish).not.toHaveBeenCalled();
    await t.user.click(
      screen.getByRole("menuitem", { name: "Remove from channel" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: `Remove ${agent ? "agent" : "member"} from channel`,
    });
    await vi.waitFor(() =>
      expect(
        within(dialog).getByRole("button", {
          name: `Remove ${agent ? "agent" : "member"}`,
        }),
      ).toBeVisible(),
    );
    expect(dialog).toHaveAccessibleDescription("Morgan");
    const avatar = required(
      dialog.querySelector(".buzz-dialog-description .buzz-avatar"),
    );
    expect(avatar).toHaveAttribute(
      "data-avatar-shape",
      agent ? "squircle" : "circle",
    );
    expect(avatar).toHaveAttribute("data-size", "small");
    expect(avatar).toHaveTextContent("M");
    expect(
      required(
        dialog.querySelector(
          '.buzz-dialog-step:not([aria-hidden="true"]) > .buzz-dialog-body',
        ),
      ),
    ).toBeEmptyDOMElement();
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveAttribute("data-variant", "subtle");
    expect(t.publish).not.toHaveBeenCalled();
  },
);
it.each([false, true])(
  "uses the row's member picture beside the accessible confirmation name (Agent: %s)",
  async (agent) => {
    const picture = "https://profiles.example/morgan.png";
    const t = await setup(
      "owner",
      "member",
      true,
      undefined,
      agent,
      undefined,
      false,
      true,
      undefined,
      undefined,
      "private",
      picture,
    );
    const row = required(screen.getByText("Morgan").closest("li"));
    const rowPicture = required(
      row.querySelector(".buzz-avatar img"),
    ).getAttribute("src");
    expect(rowPicture).toBe(
      `https://media.example/small?url=${encodeURIComponent(picture)}`,
    );
    const dialog = await t.choose("Remove from channel");
    const avatar = required(
      dialog.querySelector(".buzz-dialog-description .buzz-avatar"),
    );
    const image = required(avatar.querySelector("img"));
    expect(image).toHaveAttribute("src", rowPicture);
    expect(avatar).toHaveAttribute(
      "data-avatar-shape",
      agent ? "squircle" : "circle",
    );
    expect(dialog).toHaveAccessibleDescription("Morgan");
    expect(t.publish).not.toHaveBeenCalled();
  },
);
it.each(["admin", "owner", "guest"])(
  "groups an Agent by verified %s role without role pills",
  async (role) => {
    const t = await setup("owner", role, true, undefined, true);
    const row = screen.getByRole("button", { name: /Open profile for Morgan/ });
    expect(
      row.closest("li")?.querySelector('[data-avatar-shape="squircle"]'),
    ).toBeInTheDocument();
    expect(
      within(required(row.closest("li"))).queryByText(role),
    ).not.toBeInTheDocument();
    expect(row.closest("section")).toHaveAttribute(
      "aria-label",
      role === "owner" ? "Owners" : role === "admin" ? "Admins" : "Agents",
    );
    expect(row).toHaveAccessibleName(new RegExp(`, ${role}$`));
    expect(t.publish).not.toHaveBeenCalled();
  },
);
it("reads roles on hosts without the narrow writer", async () => {
  const t = await setup("owner", "guest", false);
  expect(
    screen.getByRole("button", { name: /Open profile for Morgan/ }),
  ).toHaveAccessibleName(/, guest$/);
  await expectProfileOnly(t.user, "Morgan");
});
it("keeps unconfirmed roles and session recovery across close/reopen without replay", async () => {
  const t = await setup();
  t.lag();
  const dialog = await t.choose("Make admin");
  await t.user.click(
    within(dialog).getByRole("button", { name: "Make admin" }),
  );
  await screen.findByText(/This request may have taken effect/);
  expect(
    screen
      .getByRole("button", { name: /Open profile for Morgan/ })
      .closest("section"),
  ).toHaveAttribute("aria-label", "Members");
  await expectProfileOnly(t.user, "Morgan");
  await t.user.click(
    screen.getByRole("button", { name: "Close channel members" }),
  );
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await t.user.click(screen.getByRole("button", { name: "Channel members" }));
  await screen.findByText(/This request may have taken effect/);
  await vi.waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Refresh member data" }),
    ).not.toHaveAttribute("aria-disabled", "true"),
  );
  t.confirm("admin");
  await t.user.click(
    screen.getByRole("button", { name: "Refresh member data" }),
  );
  await vi.waitFor(() =>
    expect(t.session.memberAdministration.snapshot(id).operation?.status).toBe(
      "confirmed",
    ),
  );
  expect(
    screen.queryByText("Member change confirmed."),
  ).not.toBeInTheDocument();
  expect(t.publish).toHaveBeenCalledOnce();
});
it("pending operations survive closing while suppressing duplicate actions", async () => {
  const t = await setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const publish = required(t.publish.getMockImplementation());
  t.publish.mockImplementationOnce(async (event) => {
    await gate;
    await publish(event);
  });
  try {
    const dialog = await t.choose("Make admin");
    await t.user.click(
      within(dialog).getByRole("button", { name: "Make admin" }),
    );
    await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
    await expectProfileOnly(t.user, "Morgan");
    await t.user.click(
      screen.getByRole("button", { name: "Close channel members" }),
    );
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await t.user.click(screen.getByRole("button", { name: "Channel members" }));
    expect(
      screen.queryByText(/Checking permissions and waiting/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh member data" }),
    ).toHaveAttribute("aria-disabled", "true");
  } finally {
    await act(async () => release());
  }
  await vi.waitFor(() =>
    expect(t.session.memberAdministration.snapshot(id).operation?.status).toBe(
      "confirmed",
    ),
  );
  expect(
    screen.queryByText("Member change confirmed."),
  ).not.toBeInTheDocument();
  expect(t.publish).toHaveBeenCalledOnce();
});
it("retains roster and displays rejection with explicit refresh recovery", async () => {
  const t = await setup();
  t.publish.mockRejectedValueOnce(new PublishRejected("Permission changed"));
  const dialog = await t.choose("Remove from channel");
  await t.user.click(
    within(dialog).getByRole("button", { name: "Remove member" }),
  );
  const error = await screen.findByText("Permission changed");
  expect(error).toHaveAttribute("role", "alert");
  expect(error.closest(".buzz-toast")).toBeNull();
  expect(
    within(screen.getByRole("region", { name: "Member list" })).queryByText(
      "Permission changed",
    ),
  ).not.toBeInTheDocument();
  await vi.waitFor(() =>
    expect(
      screen.getByRole("button", { name: /Open profile for Morgan/ }),
    ).toBeVisible(),
  );
  await t.user.click(
    screen.getByRole("button", { name: "Refresh member data" }),
  );
  await screen.findByRole("button", { name: "Actions for Morgan" });
  expect(t.publish).toHaveBeenCalledOnce();
});

it.each(["failed", "uncertain"])(
  "hides the previous %s error during refresh without replaying the write",
  async (outcome) => {
    const t = await setup();
    if (outcome === "uncertain") t.lag();
    else
      t.publish.mockRejectedValueOnce(
        new PublishRejected("Permission changed"),
      );
    const confirmation = await t.choose("Remove from channel");
    await t.user.click(
      within(confirmation).getByRole("button", { name: "Remove member" }),
    );
    const message =
      outcome === "uncertain"
        ? /This request may have taken effect/
        : "Permission changed";
    await screen.findByText(message);
    const refresh = screen.getByRole("button", { name: "Refresh member data" });
    await vi.waitFor(() =>
      expect(refresh).not.toHaveAttribute("aria-disabled", "true"),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const query = required(t.query.getMockImplementation());
    t.query.mockImplementation(async (...args) => {
      await gate;
      return query(...args);
    });
    try {
      await t.user.click(refresh);
      await vi.waitFor(() =>
        expect(t.session.memberAdministration.snapshot(id).status).toBe(
          "loading",
        ),
      );
      expect(screen.queryByText(message)).not.toBeInTheDocument();
      expect(t.publish).toHaveBeenCalledOnce();
    } finally {
      await act(async () => release());
    }
    await vi.waitFor(() =>
      expect(t.session.memberAdministration.snapshot(id).status).toBe("ready"),
    );
    if (outcome === "uncertain")
      expect(screen.getByText(message)).toHaveAttribute("role", "alert");
    else expect(screen.queryByText(message)).not.toBeInTheDocument();
    expect(t.publish).toHaveBeenCalledOnce();
  },
);

it.each([true, false])(
  "refreshes roster and roles from the header without writes (writer: %s)",
  async (supported) => {
    const t = await setup("owner", "member", supported);
    const section = screen.getByRole("region", { name: "Members" });
    const dialog = screen.getByRole("dialog", { name: "Channel members" });
    const header = required(dialog.querySelector("header"));
    const refresh = within(header).getByRole("button", {
      name: "Refresh member data",
    });
    const close = within(header).getByRole("button", {
      name: "Close channel members",
    });
    expect(refresh).toHaveAttribute("data-variant", "ghost");
    expect(refresh).toHaveAttribute("data-icon-size", "compact");
    expect(refresh.nextElementSibling).toBe(close);
    await vi.waitFor(() =>
      expect(refresh).not.toHaveAttribute("aria-disabled", "true"),
    );
    await t.user.type(screen.getByRole("searchbox"), "Morgan");
    await vi.waitFor(() =>
      expect(refresh).toHaveAttribute("aria-busy", "false"),
    );
    t.confirm("admin");
    await t.user.click(refresh);
    await vi.waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /Open profile for Morgan/ })
          .closest("section"),
      ).toHaveAttribute("aria-label", "Admins"),
    );
    await vi.waitFor(() =>
      expect(refresh).not.toHaveAttribute("aria-disabled", "true"),
    );
    t.confirm(undefined);
    await t.user.click(refresh);
    await vi.waitFor(() =>
      expect(refresh).not.toHaveAttribute("aria-disabled", "true"),
    );
    expect(within(section).getByRole("heading")).toHaveTextContent(
      "Members · 0",
    );
    expect(within(section).queryByText("Morgan")).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toHaveValue("Morgan");
    expect(t.publish).not.toHaveBeenCalled();
  },
);
it.each([false, true])(
  "recovers visible roles after an unrelated access change (read fails: %s)",
  async (failure) => {
    const t = await setup();
    const other = "22222222-2222-4222-8222-222222222222";
    const query = required(t.query.getMockImplementation());
    let joined = true;
    let failRead = failure;
    t.query.mockImplementation(async (filters) => {
      if (
        !joined &&
        failRead &&
        filters.some((filter) => filter.kinds?.includes(39001))
      )
        throw new Error("Roles unavailable");
      if (filters.some((filter) => filter["#d"]?.includes(other)))
        return [
          signed(t.relay, {
            kind: 39000,
            content: "",
            tags: [
              ["d", other],
              ["t", "stream"],
              ["private"],
              ["name", "Other"],
            ],
          }),
          signed(t.relay, {
            kind: 39002,
            created_at: joined ? 1700000100 : 1700000101,
            content: "",
            tags: [["d", other], ...(joined ? [["p", t.viewer.pubkey]] : [])],
          }),
        ].filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
      return query(filters);
    });
    const readOther = () =>
      t.session.read([{ kinds: [39000, 39002], "#d": [other], limit: 2 }], {
        fresh: true,
      });
    await act(async () => {
      await readOther();
    });
    const before = t.query.mock.calls.filter(([filters]) =>
      filters.some((filter) => filter.kinds?.includes(39001)),
    ).length;
    joined = false;
    await act(async () => {
      await readOther();
    });
    await vi.waitFor(() =>
      expect(t.session.memberAdministration.snapshot(id).status).toBe(
        failure ? "error" : "ready",
      ),
    );
    const refresh = screen.getByRole("button", { name: "Refresh member data" });
    await vi.waitFor(() =>
      expect(refresh).toHaveAttribute("aria-busy", "false"),
    );
    expect(
      t.query.mock.calls.filter(([filters]) =>
        filters.some((filter) => filter.kinds?.includes(39001)),
      ),
    ).toHaveLength(before + 1);
    // Session revocation also clears optional names; identify the row by its stable key.
    const targetRow = () =>
      required(
        screen
          .getAllByRole("button", { name: /^Open profile for/ })
          .find((button) =>
            button
              .getAttribute("aria-label")
              ?.includes(`(${formatPublicKey(t.target.pubkey)})`),
          )
          ?.closest("li"),
      );
    if (failure) {
      expect(screen.getByText("Roles unavailable")).toBeVisible();
      expect(
        within(targetRow()).getByRole("button", { name: /Open profile/ }),
      ).toHaveAccessibleName(/Role unverified/);
      failRead = false;
      await t.user.click(refresh);
      await vi.waitFor(() =>
        expect(t.session.memberAdministration.snapshot(id).status).toBe(
          "ready",
        ),
      );
    }
    expect(targetRow().closest("section")).toHaveAttribute(
      "aria-label",
      "Members",
    );
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("does not reload roles after this channel's access is revoked", async () => {
  const t = await setup();
  const query = required(t.query.getMockImplementation());
  const before = t.query.mock.calls.filter(([filters]) =>
    filters.some((filter) => filter.kinds?.includes(39001)),
  ).length;
  t.query.mockImplementation(async (filters) => {
    if (filters.some((filter) => filter.kinds?.includes(39002)))
      return [
        signed(t.relay, {
          kind: 39002,
          created_at: 1700000100,
          content: "",
          tags: [
            ["d", id],
            ["p", t.target.pubkey, "", "member"],
          ],
        }),
      ];
    return query(filters);
  });
  await act(async () => {
    await t.session.read([{ kinds: [39002], "#d": [id], limit: 1 }], {
      fresh: true,
    });
  });
  expect(t.session.memberAdministration.snapshot(id).status).toBe("idle");
  expect(
    t.query.mock.calls.filter(([filters]) =>
      filters.some((filter) => filter.kinds?.includes(39001)),
    ),
  ).toHaveLength(before);
  expect(
    screen.queryByRole("button", { name: /Open profile for Morgan/ }),
  ).not.toBeInTheDocument();
  expect(t.publish).not.toHaveBeenCalled();
});

it("holds duplicate refreshes, retains the roster on read failure, and recovers explicitly", async () => {
  const t = await setup();
  const refresh = screen.getByRole("button", {
    name: "Refresh member data",
  });
  await vi.waitFor(() =>
    expect(refresh).not.toHaveAttribute("aria-disabled", "true"),
  );
  const query = required(t.query.getMockImplementation());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  t.query.mockImplementation(async (filters) => {
    if (filters.some((filter) => filter.kinds?.includes(39002))) {
      started++;
      await gate;
      throw new Error("Member reads offline");
    }
    return query(filters);
  });
  try {
    await t.user.click(refresh);
    await vi.waitFor(() => expect(started).toBe(2));
    expect(refresh).toHaveAttribute("aria-busy", "true");
    expect(refresh).toHaveAttribute("aria-disabled", "true");
    expect(refresh.querySelector("svg")).toHaveClass(
      "motion-safe:animate-spin",
    );
    expect(screen.queryByText("Loading members…")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Open profile for Morgan/ }),
    ).toBeVisible();
    await t.user.click(refresh);
  } finally {
    await act(async () => release());
  }
  await screen.findByText(/The member list could not load/);
  await vi.waitFor(() =>
    expect(refresh).not.toHaveAttribute("aria-disabled", "true"),
  );
  expect(started).toBe(2);
  expect(
    screen
      .getByRole("button", { name: /Open profile for Morgan/ })
      .closest("section"),
  ).toHaveAttribute("aria-label", "Members");
  t.query.mockImplementation(query);
  t.confirm("admin");
  await t.user.click(refresh);
  await vi.waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: /Open profile for Morgan/ })
        .closest("section"),
    ).toHaveAttribute("aria-label", "Admins"),
  );
  await vi.waitFor(() =>
    expect(refresh).not.toHaveAttribute("aria-disabled", "true"),
  );
  expect(
    screen.queryByText(/The member list could not load/),
  ).not.toBeInTheDocument();
  expect(t.publish).not.toHaveBeenCalled();
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}

async function expectProfileOnly(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(screen.getByRole("button", { name: `Actions for ${name}` }));
  expect(
    (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
  ).toEqual(["View profile"]);
  await vi.waitFor(() => expect(screen.getByRole("menu")).toHaveFocus());
  await user.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
}

it.each(["ellipsis", "context", "keyboard", "context-key"])(
  "opens the same profile-first member menu via %s",
  async (entry) => {
    const t = await setup();
    const row = required(screen.getByText("Morgan").closest("li"));
    if (entry === "ellipsis") {
      await t.user.click(
        screen.getByRole("button", { name: "Actions for Morgan" }),
      );
    } else if (entry === "context") {
      fireEvent.contextMenu(row, { clientX: 100, clientY: 100, button: 2 });
    } else {
      fireEvent.keyDown(
        within(required(row.closest("li"))).getByRole("button", {
          name: /^Open profile/,
        }),
        entry === "keyboard"
          ? { key: "F10", shiftKey: true }
          : { key: "ContextMenu" },
      );
    }
    expect(
      (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
    ).toEqual(["View profile", "Make admin", "Remove from channel"]);
    expect(t.onOpenLink).not.toHaveBeenCalled();
    expect(t.publish).not.toHaveBeenCalled();
    await t.user.click(screen.getByRole("menuitem", { name: "View profile" }));
    expect(t.onOpenLink).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("keeps Members and restores the menu trigger when profile navigation is declined", async () => {
  const t = await setup();
  t.onOpenLink.mockReturnValue(false);
  const actions = screen.getByRole("button", { name: "Actions for Morgan" });
  await t.user.click(actions);
  await t.user.click(
    await screen.findByRole("menuitem", { name: "View profile" }),
  );
  await vi.waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("dialog", { name: "Channel members" })).toBeVisible();
  await vi.waitFor(() => expect(actions).toHaveFocus());
  expect(t.onOpenLink).toHaveBeenCalledOnce();
  expect(t.onOpenLink).toHaveBeenCalledWith(
    expect.any(String),
    screen.getByRole("button", { name: "Channel members", hidden: true }),
  );
  expect(t.publish).not.toHaveBeenCalled();
});

it.each([false, true])(
  "reuses mounted presence for human/agent avatars without inventing offline state (agent: %s)",
  async (agent) => {
    let status: PresenceStatus = "unknown";
    const listeners = new Map<string, Set<() => void>>();
    const presence = {
      status: () => status,
      limited: () => false,
      subscribe(key, listener) {
        const current = listeners.get(key) ?? new Set();
        current.add(listener);
        listeners.set(key, current);
        return () => {
          current.delete(listener);
          if (!current.size) listeners.delete(key);
        };
      },
      connected() {},
      clear() {},
      refresh() {},
      dispose() {},
    } satisfies Presence;
    const t = await setup("owner", "member", true, undefined, agent, presence);
    const profile = screen.getByRole("button", {
      name: /Open profile for Morgan/,
    });
    const avatar = required(profile.querySelector(".buzz-avatar-status"));
    expect(avatar).not.toHaveAttribute("data-status");
    expect(profile).not.toHaveAttribute("title");
    expect(profile).not.toHaveAccessibleDescription(/Presence:/);
    expect(avatar).toHaveAttribute("data-shape", agent ? "squircle" : "circle");
    expect(listeners.get(t.target.pubkey)?.size).toBe(1);
    for (const next of ["online", "away", "offline", "unknown"] as const) {
      act(() => {
        status = next;
        for (const callbacks of listeners.values())
          for (const callback of callbacks) callback();
      });
      if (next === "unknown") {
        expect(avatar).not.toHaveAttribute("data-status");
        expect(profile).not.toHaveAccessibleDescription(/Presence:/);
      } else {
        expect(avatar).toHaveAttribute("data-status", next);
        expect(profile).toHaveAccessibleDescription(`Presence: ${next}`);
      }
    }
    await t.user.type(screen.getByRole("searchbox"), "Carl");
    expect(listeners.has(t.target.pubkey)).toBe(false);
    await t.user.click(
      screen.getByRole("button", { name: "Close channel members" }),
    );
    await vi.waitFor(() => expect(listeners.size).toBe(0));
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it.each(["Carl", "Owner", "Morgan"])(
  "offers profile navigation instead of Copy npub for %s",
  async (name) => {
    const t = await setup();
    await t.user.click(
      screen.getByRole("button", { name: `Actions for ${name}` }),
    );
    const view = await screen.findByRole("menuitem", { name: "View profile" });
    expect(
      screen.queryByRole("menuitem", { name: "Copy npub" }),
    ).not.toBeInTheDocument();
    await t.user.click(view);
    expect(t.onOpenLink).toHaveBeenCalledOnce();
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it.each([
  [false, "member", true, true, true],
  [true, "member", true, true, false],
  [false, "bot", true, true, false],
  [false, "member", false, true, false],
  [false, "member", true, false, false],
] as const)(
  "gates Send message by human identity, capability and navigation (%s/%s/%s/%s)",
  async (agent, role, available, navigation, offered) => {
    const t = await setup(
      "member",
      role,
      true,
      undefined,
      agent,
      undefined,
      available,
      navigation,
    );
    await t.user.click(
      screen.getByRole("button", { name: "Actions for Morgan" }),
    );
    expect(
      (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
    ).toEqual(offered ? ["View profile", "Send message"] : ["View profile"]);
    await t.user.keyboard("{Escape}");
    await t.user.click(
      screen.getByRole("button", { name: "Actions for Carl" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "View profile" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: "Send message" }),
    ).not.toBeInTheDocument();
    expect(t.openMessage).not.toHaveBeenCalled();
  },
);

it("opens a confirmed human DM once, then hands navigation off without a membership write", async () => {
  const t = await setup(
    "member",
    "member",
    true,
    undefined,
    false,
    undefined,
    true,
  );
  let release!: (id: string) => void;
  t.openMessage.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const actions = screen.getByRole("button", { name: "Actions for Morgan" });
  await t.user.click(actions);
  await t.user.click(
    await screen.findByRole("menuitem", { name: "Send message" }),
  );
  expect(t.openMessage).toHaveBeenCalledExactlyOnceWith(
    [t.target.pubkey],
    expect.any(AbortSignal),
  );
  expect(await screen.findByText("Opening conversation…")).toBeVisible();
  await t.user.click(actions);
  expect(
    await screen.findByRole("menuitem", { name: "Send message" }),
  ).toHaveAttribute("aria-disabled", "true");
  await t.user.click(screen.getByRole("menuitem", { name: "Send message" }));
  expect(t.openMessage).toHaveBeenCalledOnce();
  await t.user.keyboard("{Escape}");
  await act(async () => release("dm-1"));
  expect(t.onOpenConversation).toHaveBeenCalledExactlyOnceWith("dm-1");
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(t.onOpenLink).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
});

it.each(["read", "navigation"])(
  "retains Members after DM %s failure and allows explicit retry",
  async (failure) => {
    const t = await setup(
      "member",
      "member",
      true,
      undefined,
      false,
      undefined,
      true,
    );
    if (failure === "read")
      t.openMessage.mockRejectedValueOnce(new Error("DM unavailable"));
    else t.onOpenConversation.mockReturnValueOnce(false);
    const actions = screen.getByRole("button", { name: "Actions for Morgan" });
    await t.user.click(actions);
    await t.user.click(
      await screen.findByRole("menuitem", { name: "Send message" }),
    );
    expect(
      await screen.findByText(
        failure === "read"
          ? "DM unavailable"
          : "Could not open the conversation. Try Send message again.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("dialog", { name: "Channel members" }),
    ).toBeVisible();
    await t.user.click(actions);
    await t.user.click(
      await screen.findByRole("menuitem", { name: "Send message" }),
    );
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(t.openMessage).toHaveBeenCalledTimes(2);
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("closing Members aborts the DM waiter and prevents late navigation", async () => {
  const t = await setup(
    "member",
    "member",
    true,
    undefined,
    false,
    undefined,
    true,
  );
  let release!: (id: string) => void;
  t.openMessage.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await t.user.click(
    screen.getByRole("button", { name: "Actions for Morgan" }),
  );
  await t.user.click(
    await screen.findByRole("menuitem", { name: "Send message" }),
  );
  const signal = required(t.openMessage.mock.calls[0]?.[1]);
  expect(signal.aborted).toBe(false);
  await t.user.click(
    screen.getByRole("button", { name: "Close channel members" }),
  );
  expect(signal.aborted).toBe(true);
  await act(async () => release("dm-1"));
  expect(t.onOpenConversation).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
});

it("filters by present groups and resets to All on any search input", async () => {
  const t = await setup("admin", "member", true, undefined, true);
  const list = screen.getByRole("region", { name: "Member list" });
  const filter = () =>
    screen.getByRole("combobox", { name: "Filter members by role" });
  expect(filter()).toHaveTextContent("All");
  await t.user.click(filter());
  await screen.findByRole("option", { name: /^All/ });
  expect(screen.getAllByRole("option").map((item) => item.textContent)).toEqual(
    ["All · 3", "Owners · 1", "Admins · 1", "Agents · 1"],
  );
  expect(screen.getByRole("option", { name: "All · 3" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await t.user.click(screen.getByRole("option", { name: "Agents · 1" }));
  expect(within(list).getByText("Morgan")).toBeVisible();
  expect(within(list).queryByText("Carl (you)")).not.toBeInTheDocument();
  expect(within(list).queryByText("Owner")).not.toBeInTheDocument();
  expect(filter()).toHaveTextContent("Agents");
  // Whitespace still starts search mode, even though matching trims it.
  await t.user.type(screen.getByRole("searchbox"), " ");
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(within(list).getByText("Carl (you)")).toBeVisible();
  await t.user.clear(screen.getByRole("searchbox"));
  expect(filter()).toHaveTextContent("All");
  await t.user.click(filter());
  await t.user.click(await screen.findByRole("option", { name: "Agents · 1" }));
  await t.user.type(screen.getByRole("searchbox"), "Carl");
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  const carl = within(list).getByText("Carl (you)");
  expect(carl).toBeVisible();
  // Only rows you can add show the typed letters; members stay unchanged.
  expect(carl.querySelector("mark")).toBeNull();
  expect(within(list).queryByText("Morgan")).not.toBeInTheDocument();
  await t.user.clear(screen.getByRole("searchbox"));
  expect(within(list).getByText("Carl (you)")).toBeVisible();
  expect(within(list).getByText("Morgan")).toBeVisible();
  expect(within(list).getByText("Owner")).toBeVisible();
  expect(t.publish).not.toHaveBeenCalled();
});

it("hides the role filter for a single group, including agents who are owners", async () => {
  await setup("owner", "owner", true, undefined, true);
  expect(
    screen.queryByRole("combobox", { name: "Filter members by role" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Owners · 3" })).toBeVisible();
});

it("returns to All when a refreshed role group disappears and resets on reopen", async () => {
  const t = await setup("admin", "member");
  const filter = () =>
    screen.getByRole("combobox", { name: "Filter members by role" });
  await t.user.click(filter());
  await screen.findByRole("option", { name: /^All/ });
  await t.user.click(screen.getByRole("option", { name: "Members · 1" }));
  t.confirm("admin");
  await act(async () => {
    await t.session.memberAdministration.refresh(id);
  });
  expect(filter()).toHaveTextContent("All");
  await t.user.click(filter());
  await screen.findByRole("option", { name: /^All/ });
  expect(
    screen.queryByRole("option", { name: /Members/ }),
  ).not.toBeInTheDocument();
  await t.user.click(screen.getByRole("option", { name: "Admins · 2" }));
  await t.user.click(
    screen.getByRole("button", { name: "Close channel members" }),
  );
  await t.user.click(screen.getByRole("button", { name: "Channel members" }));
  await screen.findByText("Morgan");
  expect(filter()).toHaveTextContent("All");
});

it.each(["bot", "member"])(
  "lets a regular member confirm/cancel removal of their own %s agent, without role controls",
  async (role) => {
    const t = await setup(
      "member",
      role,
      true,
      undefined,
      true,
      undefined,
      false,
      true,
      undefined,
      "own",
    );
    await screen.findByRole("button", {
      name: "Open owner profile: Carl (you)",
    });
    await t.user.click(
      screen.getByRole("button", { name: "Actions for Morgan" }),
    );
    const remove = await screen.findByRole("menuitem", {
      name: "Remove from channel",
    });
    expect(
      screen.queryByRole("menuitem", { name: /^Make / }),
    ).not.toBeInTheDocument();
    await t.user.click(remove);
    const dialog = await screen.findByRole("dialog", {
      name: "Remove agent from channel",
    });
    expect(
      required(
        dialog.querySelector(
          '.buzz-dialog-step:not([aria-hidden="true"]) > .buzz-dialog-body',
        ),
      ),
    ).toBeEmptyDOMElement();
    expect(dialog).toHaveAccessibleDescription("Morgan");
    expect(
      within(dialog).getByRole("button", { name: "Remove agent" }),
    ).toHaveAttribute("data-variant", "destructive");
    await vi.waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Cancel" }),
      ).toHaveFocus(),
    );
    await t.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(t.publish).not.toHaveBeenCalled();
    const confirm = await t.choose("Remove from channel");
    await t.user.click(
      within(confirm).getByRole("button", { name: "Remove agent" }),
    );
    await vi.waitFor(() =>
      expect(
        t.session.memberAdministration.snapshot(id).operation?.status,
      ).toBe("confirmed"),
    );
    expect(
      screen.queryByText("Member change confirmed."),
    ).not.toBeInTheDocument();
    expect(t.publish).toHaveBeenCalledOnce();
    expect(t.publish.mock.calls[0]?.[0]).toMatchObject({
      kind: 9001,
      tags: [
        ["h", id],
        ["p", t.target.pubkey],
      ],
    });
  },
);
it.each(["other", "invalid"] as const)(
  "does not expose removal for %s ownership to a regular member",
  async (ownership) => {
    const t = await setup(
      "member",
      "bot",
      true,
      undefined,
      true,
      undefined,
      false,
      true,
      undefined,
      ownership,
    );
    await vi.waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Refresh member data" }),
      ).toHaveAttribute("aria-busy", "false"),
    );
    await t.user.click(
      screen.getByRole("button", { name: "Actions for Morgan" }),
    );
    await screen.findByRole("menuitem", { name: "View profile" });
    expect(
      screen.queryByRole("menuitem", { name: "Remove from channel" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /^Make / }),
    ).not.toBeInTheDocument();
  },
);

it.each(["owner", "admin"])(
  "lets %s explicitly promote a bot while preserving verified agent identity",
  async (actor) => {
    const t = await setup(actor, "bot", true, undefined, true);
    const dialog = await t.choose("Make admin");
    expect(dialog).toHaveTextContent("from bot to admin");
    expect(t.publish).not.toHaveBeenCalled();
    await t.user.click(
      within(dialog).getByRole("button", { name: "Make admin" }),
    );
    await vi.waitFor(() =>
      expect(
        t.session.memberAdministration.snapshot(id).operation?.status,
      ).toBe("confirmed"),
    );
    expect(
      screen.queryByText("Member change confirmed."),
    ).not.toBeInTheDocument();
    const row = screen.getByRole("button", { name: /Open profile for Morgan/ });
    expect(row.closest("section")).toHaveAttribute("aria-label", "Admins");
    expect(
      row.closest("li")?.querySelector('[data-avatar-shape="squircle"]'),
    ).toBeInTheDocument();
    expect(row).toHaveAccessibleName(/, admin$/);
    expect(t.publish).toHaveBeenCalledOnce();
  },
);
