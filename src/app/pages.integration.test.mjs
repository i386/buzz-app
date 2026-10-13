import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { setImmediate as settle } from "node:timers/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("the app runtime exposes ready bundled pages and removes them on disable", async () => {
  const vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, ws: false },
  });
  const originalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const values = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
  });
  let services;
  try {
    const { createServices } = await vite.ssrLoadModule("/src/app/services.ts");
    services = createServices();
    assert.deepEqual(services.pages.snapshot(), []);
    await vi.waitFor(() =>
      assert.equal(
        services.accountActions.snapshot()[0]?.key,
        "buzz.feedback/send",
      ),
    );
    const firstFeedback = services.accountActions.snapshot()[0];
    await services.plugins.change("disable", "buzz.feedback");
    assert.deepEqual(services.accountActions.snapshot(), []);
    await services.plugins.change("enable", "buzz.feedback");
    await vi.waitFor(() =>
      assert.equal(
        services.accountActions.snapshot()[0]?.key,
        "buzz.feedback/send",
      ),
    );
    assert.notEqual(services.accountActions.snapshot()[0], firstFeedback);
    await settle();
    assert.equal(services.pages.snapshot().length, 8);
    const { bundledPlugins } = await vite.ssrLoadModule(
      "/src/bundled/index.ts",
    );
    for (const plugin of bundledPlugins) {
      assert.equal(
        typeof plugin.enabledByDefault,
        "boolean",
        plugin.manifest.id,
      );
      assert.equal(
        plugin.enabledByDefault,
        !["buzz.bestie", "buzz.todos"].includes(plugin.manifest.id),
        plugin.manifest.id,
      );
    }
    assert.equal(
      services.pages.snapshot().some((p) => p.pluginId === "buzz.bestie"),
      false,
    );
    assert.equal(
      services.panels.snapshot().some((p) => p.pluginId === "buzz.bestie"),
      false,
    );
    const me = services.pages
      .snapshot()
      .find((page) => page.key === "buzz.me/me");
    assert.equal(me.primary, true);
    assert.equal(me.placement, "topbar");
    assert.match(
      renderToStaticMarkup(createElement(me.component)),
      /Connect to a community to work with your agents\./,
    );
    const messages = services.pages
      .snapshot()
      .find((page) => page.key === "buzz.channels/channels");
    assert.equal(messages.primary, true);
    assert.equal(messages.placement, "topbar");
    await services.plugins.change("disable", "buzz.me");
    assert.equal(
      services.pages.snapshot().some((page) => page.key === "buzz.me/me"),
      false,
    );
    await services.plugins.change("enable", "buzz.me");
    await vi.waitFor(() =>
      assert.ok(
        services.pages.snapshot().some((page) => page.key === "buzz.me/me"),
      ),
    );
    await services.plugins.change("disable", "buzz.me");
    const inbox = services.pages
      .snapshot()
      .find((page) => page.pluginId === "buzz.inbox");
    assert.equal(inbox.title, "Inbox");
    assert.equal(inbox.layout, "workspace");
    assert.equal(inbox.primary, true);
    assert.match(
      renderToStaticMarkup(createElement(inbox.component)),
      /Choose a community to see your inbox/,
    );
    const unread = services.relay.snapshot().session.unread;
    await services.plugins.change("disable", "buzz.inbox");
    assert.equal(
      services.pages.snapshot().some((page) => page.key === "buzz.inbox/inbox"),
      false,
    );
    assert.equal(services.relay.snapshot().session.unread, unread);
    await services.plugins.change("enable", "buzz.inbox");
    await vi.waitFor(() =>
      assert.ok(
        services.pages
          .snapshot()
          .some((page) => page.key === "buzz.inbox/inbox"),
      ),
    );
    assert.deepEqual(
      services.settingsCards
        .snapshot()
        .map((card) => card.pluginId)
        .sort(),
      [
        "block.builderlab",
        "block.hosted-communities",
        "buzz.channels",
        "buzz.channels",
        "buzz.emoji",
        "buzz.pairing",
      ],
    );
    // Messages owns thread placement through the plugin-settings boundary.
    assert.equal(services.settingsCards.has("buzz.channels/messages"), true);
    const messageSettings = services.settingsCards
      .snapshot()
      .find((card) => card.key === "buzz.channels/messages");
    assert.equal(messageSettings.title, "Messages");
    const pairingCard = services.settingsCards
      .snapshot()
      .find((card) => card.key === "buzz.pairing/mobile");
    assert.ok(pairingCard);
    await services.plugins.change("disable", "buzz.pairing");
    assert.equal(services.settingsCards.has("buzz.pairing/mobile"), false);
    await services.plugins.change("enable", "buzz.pairing");
    await vi.waitFor(() =>
      assert.ok(services.settingsCards.has("buzz.pairing/mobile")),
    );
    assert.notEqual(
      services.settingsCards
        .snapshot()
        .find((card) => card.key === "buzz.pairing/mobile"),
      pairingCard,
    );
    assert.equal(
      services.panels.snapshot().some((p) => p.pluginId === "buzz.todos"),
      false,
    );
    const canvas = services.relay.snapshot().session.canvas;
    await services.plugins.change("enable", "buzz.todos");
    await vi.waitFor(() =>
      assert.ok(
        services.panels.snapshot().find((p) => p.pluginId === "buzz.todos")
          ?.channelLauncher,
      ),
    );
    const firstTodos = services.panels
      .snapshot()
      .find((p) => p.pluginId === "buzz.todos");
    await services.plugins.change("disable", "buzz.todos");
    assert.equal(
      services.panels.snapshot().some((p) => p.pluginId === "buzz.todos"),
      false,
    );
    assert.equal(services.relay.snapshot().session.canvas, canvas);
    await services.plugins.change("enable", "buzz.todos");
    await vi.waitFor(() =>
      assert.ok(
        services.panels.snapshot().find((p) => p.pluginId === "buzz.todos"),
      ),
    );
    assert.notEqual(
      services.panels.snapshot().find((p) => p.pluginId === "buzz.todos"),
      firstTodos,
    );
    await services.plugins.change("disable", "buzz.todos");
    assert.deepEqual(
      services.settingsCards
        .snapshot()
        .map((card) => card.pluginId)
        .sort(),
      [
        "block.builderlab",
        "block.hosted-communities",
        "buzz.channels",
        "buzz.channels",
        "buzz.emoji",
        "buzz.pairing",
      ],
    );

    await vi.waitFor(() =>
      assert.equal(services.conversation.tools.snapshot().length, 4),
    );
    assert.equal(services.conversation.attachments.snapshot().length, 1);
    await services.plugins.change("disable", "buzz.voice-notes");
    assert.equal(services.conversation.attachments.snapshot().length, 0);
    assert.equal(services.conversation.inline.snapshot().length, 1);
    await vi.waitFor(() =>
      assert.equal(services.conversation.links.snapshot().length, 1),
    );
    assert.equal(
      services.conversation.links.snapshot()[0].pluginId,
      "buzz.links",
    );
    await services.plugins.change("disable", "buzz.links");
    assert.equal(services.conversation.links.snapshot().length, 0);
    await services.plugins.change("enable", "buzz.links");
    await vi.waitFor(() =>
      assert.equal(services.conversation.links.snapshot().length, 1),
    );
    await services.plugins.change("disable", "buzz.emoji");
    assert.deepEqual(
      services.conversation.tools.snapshot().map((tool) => tool.pluginId),
      ["buzz.mentions", "buzz.projects"],
    );
    assert.equal(services.conversation.inline.snapshot().length, 0);
    await services.plugins.change("disable", "buzz.mentions");
    assert.deepEqual(
      services.conversation.tools.snapshot().map((tool) => tool.pluginId),
      ["buzz.projects"],
    );
    await services.plugins.change("enable", "buzz.mentions");
    await vi.waitFor(() =>
      assert.equal(services.conversation.tools.snapshot().length, 2),
    );
    await services.plugins.change("enable", "buzz.emoji");
    await vi.waitFor(() =>
      assert.equal(services.conversation.tools.snapshot().length, 3),
    );

    const { npubEncode } = await import("nostr-tools/nip19");
    const profileTarget = `nostr:${npubEncode("ab".repeat(32))}`;
    assert.equal(
      services.panels.resolve(profileTarget)?.pluginId,
      "buzz.profiles",
    );
    await services.plugins.change("disable", "buzz.profiles");
    assert.equal(services.panels.resolve(profileTarget), undefined);
    await services.plugins.change("enable", "buzz.profiles");
    await vi.waitFor(() =>
      assert.equal(
        services.panels.resolve(profileTarget)?.pluginId,
        "buzz.profiles",
      ),
    );

    const usage = services.panels
      .snapshot()
      .find((panel) => panel.pluginId === "buzz.channel-usage");
    assert.equal(usage.channelMenu.label, "View channel usage");
    assert.equal(usage.matches("channel"), false);
    await services.plugins.change("disable", "buzz.channel-usage");
    assert.equal(services.panels.snapshot().includes(usage), false);
    assert.ok(
      services.pages
        .snapshot()
        .some((page) => page.pluginId === "buzz.channels"),
    );
    await services.plugins.change("enable", "buzz.channel-usage");
    await vi.waitFor(() =>
      assert.ok(
        services.panels
          .snapshot()
          .some(
            (panel) =>
              panel.pluginId === "buzz.channel-usage" && panel !== usage,
          ),
      ),
    );

    const activity = services.panels
      .snapshot()
      .find((panel) => panel.pluginId === "buzz.agent-activity");
    assert.equal(activity.title, "Agent Activity");
    assert.equal(activity.launcher, undefined);
    assert.equal(services.conversation.accessories.snapshot().length, 2);
    assert.deepEqual(
      services.conversation.accessories
        .snapshot()
        .map(({ id, placement }) => [id, placement]),
      [
        ["activity", "message"],
        ["typing-presentation", undefined],
      ],
    );
    assert.equal(
      services.conversation.accessories.snapshot()[0].pluginId,
      "buzz.agent-activity",
    );
    assert.match(
      renderToStaticMarkup(createElement(activity.component)),
      /Connect to a community/,
    );
    await services.plugins.change("disable", "buzz.agent-activity");
    assert.equal(
      services.panels
        .snapshot()
        .some((panel) => panel.pluginId === "buzz.agent-activity"),
      false,
    );
    assert.equal(services.conversation.accessories.snapshot().length, 0);
    await services.plugins.change("enable", "buzz.agent-activity");
    await vi.waitFor(() =>
      assert.ok(
        services.panels
          .snapshot()
          .some((panel) => panel.pluginId === "buzz.agent-activity"),
      ),
    );

    await services.plugins.change("enable", "buzz.bestie");
    await vi.waitFor(() =>
      assert.ok(
        services.pages.snapshot().some((p) => p.pluginId === "buzz.bestie"),
      ),
    );
    assert.equal(
      services.panels
        .snapshot()
        .some((panel) => panel.pluginId === "buzz.bestie"),
      false,
    );
    const bestiePage = services.pages
      .snapshot()
      .find((page) => page.pluginId === "buzz.bestie");
    assert.equal(bestiePage.title, "Bestie");
    assert.equal(bestiePage.layout, "workspace");
    assert.equal(bestiePage.primary, true);
    assert.match(
      renderToStaticMarkup(createElement(bestiePage.component)),
      /isn’t connected yet/,
    );
    await services.plugins.change("disable", "buzz.bestie");
    assert.equal(
      services.panels
        .snapshot()
        .some((panel) => panel.pluginId === "buzz.bestie"),
      false,
    );
    assert.equal(
      services.pages.snapshot().some((page) => page.pluginId === "buzz.bestie"),
      false,
    );
    assert.equal(services.pages.snapshot().length, 7);
    await services.plugins.change("enable", "buzz.bestie");
    // Management completion is not activation completion; Cordis still owns import/disposal barriers.
    await vi.waitFor(() =>
      assert.ok(
        services.pages
          .snapshot()
          .some((page) => page.pluginId === "buzz.bestie"),
      ),
    );
    const secondBestie = services.pages
      .snapshot()
      .find((page) => page.pluginId === "buzz.bestie");
    assert.notEqual(secondBestie, bestiePage);
    assert.equal(secondBestie.revision, bestiePage.revision);
    assert.equal(
      services.panels
        .snapshot()
        .some((panel) => panel.pluginId === "buzz.bestie"),
      false,
    );
    const page = services.pages.snapshot()[0];
    assert.match(
      renderToStaticMarkup(createElement(page.component)),
      /Your channels, one conversation/,
    );
    const session = services.relay.snapshot().session;
    const sessionsPage = services.pages
      .snapshot()
      .find((page) => page.pluginId === "buzz.sessions");
    assert.equal(sessionsPage.title, "Sessions (now in Me)");
    assert.equal(sessionsPage.primary, false);
    assert.match(
      renderToStaticMarkup(createElement(sessionsPage.component)),
      /Opening Me/,
    );
    await services.plugins.change("disable", "buzz.sessions");
    assert.equal(
      services.pages
        .snapshot()
        .some((page) => page.pluginId === "buzz.sessions"),
      false,
    );
    assert.equal(services.relay.snapshot().session, session);
    const nameFacts = [
      { pubkey: "a".repeat(64), name: "Alex" },
      { pubkey: "b".repeat(64), name: "Alex" },
    ];
    const named = () =>
      session.names.resolve(
        nameFacts[0].pubkey,
        "Unknown",
        nameFacts.map((row) => row.pubkey),
        nameFacts,
      );
    const qualified = named();
    assert.match(qualified, /^Alex · /);
    await services.plugins.change("disable", "buzz.identity-naming");
    assert.equal(named(), "Unknown");
    await services.plugins.change("enable", "buzz.identity-naming");
    await vi.waitFor(() => assert.equal(named(), qualified));
    assert.ok(session.agentLibrary);
    const workflows = services.pages
      .snapshot()
      .find((page) => page.pluginId === "buzz.workflows");
    assert.equal(workflows.title, "Workflows");
    assert.equal(workflows.layout, "workspace");
    assert.match(
      renderToStaticMarkup(createElement(workflows.component)),
      /Connect to a community/,
    );
    await services.plugins.change("disable", "buzz.workflows");
    assert.equal(
      services.pages
        .snapshot()
        .some((page) => page.pluginId === "buzz.workflows"),
      false,
    );
    assert.equal(services.relay.snapshot().session, session);
    assert.ok(session.workflows);
    await services.plugins.change("enable", "buzz.workflows");
    await vi.waitFor(() =>
      assert.ok(
        services.pages
          .snapshot()
          .some((page) => page.pluginId === "buzz.workflows"),
      ),
    );
    await services.plugins.change("disable", "buzz.workflows");
    assert.equal(
      await services.plugins.change("disable", "buzz.channels"),
      false,
    );
    const projects = services.pages
      .snapshot()
      .find((page) => page.pluginId === "buzz.projects");
    assert.equal(services.pages.snapshot().length, 6);
    assert.equal(projects.pluginId, "buzz.projects");
    assert.equal(projects.id, "projects");
    assert.equal(projects.title, "Projects");
    assert.equal(projects.layout, "workspace");
    assert.equal(projects.handlesNavigation, true);
    assert.equal(projects.primary, true);
    assert.equal(projects.route.version, 1);
    assert.equal(
      projects.route.validate({
        type: "repo",
        owner: "a".repeat(64),
        dtag: "repo",
      }),
      true,
    );
    assert.equal(
      projects.route.validate({
        type: "repo",
        owner: "a".repeat(64),
        dtag: "repo",
        arbitrary: true,
      }),
      false,
    );
    assert.match(
      renderToStaticMarkup(createElement(projects.component)),
      /Select a community to browse projects/,
    );
    await services.plugins.change("disable", "buzz.projects");
    // Bestie was re-enabled above, so it registered after Inbox.
    assert.deepEqual(
      services.pages.snapshot().map((page) => page.pluginId),
      [
        "buzz.channels",
        "buzz.reminders",
        "buzz.agents",
        "buzz.inbox",
        "buzz.bestie",
      ],
    );
    await services.plugins.change("enable", "buzz.projects");
    await vi.waitFor(() => {
      const restored = services.pages
        .snapshot()
        .find((page) => page.pluginId === "buzz.projects");
      assert.equal(restored?.pluginId, "buzz.projects");
      assert.notEqual(restored, projects);
    });
  } finally {
    await services?.dispose();
    await vite.close();
    if (originalStorage)
      Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete globalThis.localStorage;
  }
  // A real Vite server, the whole service graph and every page render take
  // seconds alone, so the default budget expires under a parallel suite.
}, 30_000);
