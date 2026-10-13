import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { openChannelDetails } from "./channel-details.mjs";
import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";
import { npubEncode } from "nostr-tools/nip19";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
test.use({
  productionBroker: true,
  // Navigation can publish read positions through the real broker.
  readState: true,
  developmentReact: true,
});

// The channel composer's context is the form's preceding sibling.
const channelComposer = (page) =>
  page
    .getByRole("form", { name: "Send a message to Alpha", exact: true })
    .locator("..");
// Floating avatars above a composer; its accessible name summarizes who works.
const activityTrigger = (scope) =>
  scope.getByRole("button", { name: /^Activity: .+ working$/ });
const workingNow = (page) =>
  page.getByRole("dialog", { name: "Working now", exact: true });
// Hover is the pointer path; keyboard opening is exercised explicitly below.
const openWorkingNow = async (page, scope) => {
  await activityTrigger(scope).hover();
  const popup = workingNow(page);
  await expect(popup).toBeVisible();
  return popup;
};
// Agents without a loaded profile fall back to their key prefix.
const agentRow = (popup, agent) =>
  popup.getByRole("button", {
    name: new RegExp(
      `^Open (?:thread|conversation) for .*${agent.slice(0, 10)}`,
    ),
  });
const agentActivityAction = (popup, agent) =>
  popup.getByRole("button", {
    name: new RegExp(`^View .*${agent.slice(0, 10)}.* activity$`),
  });
// The activity icon is revealed by hovering or focusing its row, like the sidebar.
const viewAgentActivity = async (page, scope, agent) => {
  const popup = await openWorkingNow(page, scope);
  await agentRow(popup, agent).hover();
  await agentActivityAction(popup, agent).click();
};
const isFocused = (locator) =>
  locator.evaluate((element) => element === document.activeElement);
const activityPanel = (page) =>
  page.getByRole("region", { name: "Agent activity", exact: true });
// Raw diagnostics sit behind the panel's Raw tab; the transcript is the default.
const showRaw = (panel) =>
  panel.getByRole("tab", { name: "Raw", exact: true }).click();
const activity = (kind, channelId, turnId, payload) => ({
  kind,
  seq: 1,
  timestamp: new Date().toISOString(),
  channelId,
  sessionId: "S",
  turnId,
  ...(payload === undefined ? {} : { payload }),
});

test("sidebar activity opens the working agent panel", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const key = generateSecretKey();
  const agent = getPublicKey(key);
  app.observer(activity("turn_liveness", "alpha", "sidebar"), key);
  const row = page.locator('[data-channel-id="alpha"]');
  await expect(
    row.getByRole("img", { name: /working in Alpha$/ }),
  ).toBeVisible();
  await row.hover();
  const popup = page.getByRole("dialog", { name: "Activity in Alpha" });
  await expect(popup).toBeVisible();
  await popup.getByRole("button", { name: /Open conversation for/ }).hover();
  const action = popup.getByRole("button", { name: /View .+ activity/ });
  await expect(action).toBeVisible();
  await action.click();
  await expect(activityPanel(page).locator("code").first()).toHaveText(agent);
});

test("mention picker demands the relay's protected archive snapshot", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page
    .getByRole("button", { name: "Mention a member", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Mention a member or agent" }),
  ).toBeVisible();
  await expect
    .poll(
      () =>
        app.report.queries.filter(({ filter }) => filter.kinds?.includes(13535))
          .length,
    )
    .toBeGreaterThan(0);
  expect(
    app.report.queries
      .filter(({ filter }) => filter.kinds?.includes(13535))
      .every(
        ({ filter }) =>
          filter.authors?.length === 1 &&
          filter.limit === 1 &&
          Object.keys(filter).length === 3,
      ),
  ).toBe(true);
});

// The floating composer control lists every working agent in the channel.
// Profile activity remains the durable fallback after fresh evidence disappears.
test("channel activity consumes telemetry, isolates mixed batches, selects agents, and retains history on disable", async ({
  page,
  app,
}) => {
  // Hold the first explicit profile read before broker admission so telemetry
  // cannot coalesce into it; hold all upstream presence responses too,
  // including a replacement if that first request is cancelled.
  app.relay.holdPresence();
  const firstSnapshot = Promise.withResolvers();
  let firstAuthors;
  await page.route("**/presence-snapshot", async (route) => {
    if (!firstAuthors) {
      firstAuthors = route.request().postDataJSON()[0].authors;
      await firstSnapshot.promise;
    }
    await route.fallback();
  });
  const firstKey = generateSecretKey();
  const secondKey = generateSecretKey();
  const first = getPublicKey(firstKey);
  const second = getPublicKey(secondKey);
  const composer = channelComposer(page);
  const trigger = activityTrigger(composer);
  const popup = workingNow(page);
  const onlyFirst = new RegExp(`^Activity: .*${first.slice(0, 10)}.* working$`);
  const onlySecond = new RegExp(
    `^Activity: .*${second.slice(0, 10)}.* working$`,
  );
  let unsafe;
  try {
    await open(page, app);
    await page
      .getByRole("button", { name: "View Alice Fixture profile", exact: true })
      .first()
      .click();
    await expect.poll(() => firstAuthors).toBeDefined();
    await expect(
      page.getByRole("button", { name: "Agent Activity", exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    unsafe = app.observer(
      activity("turn_liveness", "alpha", "one", {
        text: '<img src=x onerror="window.telemetryExecuted=true">',
      }),
      firstKey,
    );
    app.observer(activity("turn_liveness", "alpha", "two"), secondKey);
    app.observer(
      {
        kind: "batch",
        timestamp: new Date().toISOString(),
        channelId: "alpha",
        payload: {
          events: [
            activity("acp_read", "alpha", "one", "wanted child"),
            activity("acp_write", "beta", "other-channel", "other channel"),
          ],
        },
      },
      firstKey,
    );
    await expect(trigger).toHaveAccessibleName("Activity: 2 agents working");
    // The compact control renders telemetry keys without demanding profile or
    // presence reads, so neither can join the held explicit profile read.
    expect(firstAuthors).not.toContain(first);
    expect(firstAuthors).not.toContain(second);
  } finally {
    firstSnapshot.resolve();
    app.relay.releasePresence();
  }
  // The released explicit read (or its replacement) settles before counting.
  await expect
    .poll(
      () =>
        app.report.presenceSnapshots.length > 0 &&
        app.report.presenceSnapshots.every(({ pending }) => !pending),
    )
    .toBe(true);
  await page
    .locator(
      '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
    )
    .click();
  // A busy skip followed by a successful retry must not masquerade as recovery.
  expect(
    app.report.brokerRequests.filter(({ url }) =>
      url.endsWith("/presence-snapshot"),
    ),
  ).toHaveLength(app.report.presenceSnapshots.length);
  // Bare avatars: no permanent container behind the resting control.
  await page.mouse.move(0, 0);
  await expect(popup).toHaveCount(0);
  await expect(trigger).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  for (const side of ["top", "right", "bottom", "left"])
    await expect(trigger).toHaveCSS(`border-${side}-width`, "0px");
  await expect(trigger.locator(".buzz-avatar")).toHaveCount(2);

  await openWorkingNow(page, composer);
  await expect(
    popup.getByRole("heading", { name: "Working now", exact: true }),
  ).toBeVisible();
  // Observer turns carry no thread identity: rows open the channel, not a guess.
  for (const agent of [first, second]) {
    await expect(agentRow(popup, agent)).toHaveAccessibleName(
      /^Open conversation for /,
    );
    await expect(agentRow(popup, agent)).toContainText("Working");
    await expect(agentRow(popup, agent)).toContainText(
      "Work with unconfirmed thread",
    );
    await expect(agentActivityAction(popup, agent)).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await page.mouse.move(0, 0);
  // Keyboard path: real key input opens the popup and reaches the activity icon.
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(popup).toBeVisible();
  const firstAction = agentActivityAction(popup, first);
  for (let step = 0; step < 3 && !(await isFocused(firstAction)); step++)
    await page.keyboard.press("Tab");
  await expect(firstAction).toBeFocused();
  await page.keyboard.press("Enter");

  const panel = activityPanel(page);
  await expect(popup).toHaveCount(0);
  await expect(panel.locator("code").first()).toHaveText(first);
  await expect(
    panel.getByRole("combobox", { name: "Conversation", exact: true }),
  ).toHaveText(/^#Alpha · whole channel/);
  await expect(panel.getByText("1 observed working turn(s).")).toBeVisible();
  // Telemetry supplies keys before any profile or directory facts exist.
  const agentSelect = panel.getByRole("combobox", {
    name: "Agent",
    exact: true,
  });
  for (const key of [second, first]) {
    await agentSelect.click();
    const choices = page.getByRole("option");
    await expect(choices).toHaveCount(2);
    const labels = await choices.allTextContents();
    expect(new Set(labels).size).toBe(2);
    const label = labels.find(
      (text) =>
        text.startsWith("Agent · npub…") &&
        npubEncode(key).endsWith(text.slice("Agent · npub…".length)),
    );
    expect(label).toBeDefined();
    const choice = page.getByRole("option", { name: label, exact: true });
    await expect(choice).toBeVisible();
    await choice.click();
    await expect(panel.locator("code").first()).toHaveText(key);
  }
  await showRaw(panel);
  const unsafeDisclosure = panel.getByRole("button", { name: /turn_liveness/ });
  await unsafeDisclosure.focus();
  await unsafeDisclosure.press("Enter");
  await expect(panel.locator("pre code")).toHaveText(unsafe.plaintext);
  expect(await page.evaluate(() => window.telemetryExecuted)).toBeUndefined();
  await unsafeDisclosure.press("Space");
  await expect(panel.locator("pre code")).not.toBeVisible();

  const matchingChild = panel.getByRole("button", { name: /acp_read/ });
  await expect(matchingChild).toBeVisible();
  await expect(panel.getByRole("button", { name: /acp_write/ })).toHaveCount(0);
  await matchingChild.click();
  await expect(panel.locator("pre code")).toContainText('"channelId": "alpha"');
  await expect(panel.locator("pre code")).not.toContainText("other channel");

  await page
    .locator(
      '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
    )
    .click();
  // The popup's action has unmounted; focus returns to its floating trigger.
  await expect(trigger).toBeFocused();
  await viewAgentActivity(page, composer, second);
  await expect(panel.locator("code").first()).toHaveText(second);
  await showRaw(panel);
  await expect(
    panel.getByRole("button", { name: /turn_liveness/ }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: /acp_read/ })).toHaveCount(0);
  await page
    .locator(
      '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
    )
    .click();
  await expect(trigger).toBeFocused();

  const sockets = app.relay.sockets.length;
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  const toggle = page.getByRole("switch", {
    name: "Enable Agent Activity",
    exact: true,
  });
  const disabled = page.waitForResponse(
    (response) =>
      response.url().endsWith("/stream-observer") &&
      response.ok() &&
      response.request().postDataJSON().observer === null,
  );
  await toggle.click();
  await disabled;
  // Archive capture retains independent demand.
  // Disabling the activity UI clears only its display evidence.
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  expect(app.relay.sockets).toHaveLength(sockets);
  await page
    .getByRole("complementary", { name: "Settings sidebar" })
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await page.locator('[data-channel-id="alpha"]').click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await expect(trigger).toHaveCount(0);

  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  // Capture keeps this wire alive while the display is disabled. Its existence
  // no longer proves that the plugin's new display generation reached the host.
  const enabled = page.waitForResponse(
    (response) =>
      response.url().endsWith("/stream-observer") &&
      response.ok() &&
      response.request().postDataJSON().observer !== null,
  );
  await toggle.click();
  await enabled;
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  app.observer(activity("turn_liveness", "alpha", "after-reset"), firstKey);
  await page
    .getByRole("complementary", { name: "Settings sidebar" })
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await page.locator('[data-channel-id="alpha"]').click();
  // Only the fresh agent returns; the disabled generation's evidence is gone.
  await expect(trigger).toHaveAccessibleName(onlyFirst);
  await viewAgentActivity(page, composer, first);
  await showRaw(panel);
  await expect(
    panel.getByRole("button", { name: /turn_liveness/ }),
  ).toHaveCount(2);
  await expect(panel.getByRole("button", { name: /acp_read/ })).toHaveCount(1);

  // One terminal turn must not hide another active turn for the same agent,
  // and stale evidence is not working. The other agent's frames, observed in
  // order, are the barrier for each transition. Capture survives closing the panel.
  await page
    .locator(
      '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
    )
    .click();
  app.observer(activity("turn_liveness", "alpha", "parallel"), firstKey);
  app.observer(activity("turn_completed", "alpha", "after-reset"), firstKey);
  app.observer(activity("turn_liveness", "alpha", "barrier"), secondKey);
  await expect(trigger).toHaveAccessibleName("Activity: 2 agents working");
  app.observer(activity("turn_completed", "alpha", "parallel"), firstKey);
  app.observer(
    {
      ...activity("turn_liveness", "alpha", "stale"),
      timestamp: new Date(Date.now() - 31_000).toISOString(),
    },
    firstKey,
  );
  await expect(trigger).toHaveAccessibleName(onlySecond);
  app.observer(activity("turn_liveness", "alpha", "fresh"), firstKey);
  await expect(trigger).toHaveAccessibleName("Activity: 2 agents working");
  app.observer(activity("turn_completed", "alpha", "fresh"), firstKey);
  await expect(trigger).toHaveAccessibleName(onlySecond);
  app.observer(activity("turn_completed", "alpha", "stale"), firstKey);
  app.observer(activity("turn_completed", "alpha", "barrier"), secondKey);
  await expect(trigger).toHaveCount(0);
});

for (const mode of ["light", "dark"]) {
  test(`channel activity control and raw disclosure fit wide and narrow layouts in ${mode}`, async ({
    page,
    app,
  }, testInfo) => {
    await page.addInitScript((mode) => {
      localStorage.setItem("buzz-appearance.v1", mode);
    }, mode);
    await open(page, app);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    const agentKey = generateSecretKey();
    const agent = getPublicKey(agentKey);
    const secondKey = generateSecretKey();
    app.observer(
      activity("turn_liveness", "alpha", "second-layout"),
      secondKey,
    );
    app.observer(
      activity("acp_read", "alpha", "layout", {
        text: "A long literal raw record. ".repeat(40),
      }),
      agentKey,
    );
    const composer = channelComposer(page);
    const trigger = activityTrigger(composer);
    const popup = workingNow(page);
    await expect(trigger).toHaveAccessibleName("Activity: 2 agents working");
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      // The shell applies its media-query change in React. Wait for that commit
      // before measuring; otherwise these reads can straddle sidebar collapse.
      await expect(page.locator("[data-shell-sidebar-toggle]")).toHaveAttribute(
        "aria-label",
        width <= 650 ? "Show navigation" : "Hide Channel sidebar",
      );
      await expect(trigger).toBeVisible();
      const triggerBox = await trigger.boundingBox();
      const formBox = await page
        .getByRole("form", { name: "Send a message to Alpha", exact: true })
        .boundingBox();
      // Floats in its own lane above the composer, at the composer's end edge.
      expect(triggerBox.y + triggerBox.height).toBeLessThanOrEqual(formBox.y);
      expect(triggerBox.x).toBeGreaterThanOrEqual(formBox.x);
      expect(triggerBox.x + triggerBox.width).toBeCloseTo(
        formBox.x + formBox.width,
        0,
      );
      const avatar = trigger.locator(".buzz-avatar").first();
      // Production CSS must retain a loadable SVG mask after bundling. A valid
      // mask-image string alone can still point to the HTML fallback route.
      await expect
        .poll(() =>
          avatar.evaluate(async (element) => {
            const mask = getComputedStyle(element).maskImage;
            const image = new Image();
            image.src = mask.slice(4, -1).replace(/^["']|["']$/g, "");
            try {
              await image.decode();
              return image.naturalWidth > 0;
            } catch {
              return false;
            }
          }),
        )
        .toBe(true);
      await expect(page.locator("html")).toHaveAttribute(
        "data-color-mode",
        mode,
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      // Escape suppresses hover until the pointer leaves the trigger. A viewport
      // resize can keep WebKit's pointer over it, so make the next entry explicit.
      await page.mouse.move(0, 0);
      await openWorkingNow(page, composer);
      await expect(agentRow(popup, agent)).toBeVisible();
      await expect(popup).not.toHaveAttribute("data-starting-style", "");
      const popupBox = await popup.boundingBox();
      expect(popupBox.x).toBeGreaterThanOrEqual(0);
      expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(width);
      expect(popupBox.y + popupBox.height).toBeLessThanOrEqual(triggerBox.y);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      await page.screenshot({
        path: testInfo.outputPath(`activity-entry-${mode}-${width}.png`),
      });
      await page.keyboard.press("Escape");
      // Escape starts Base UI's asynchronous unmount. The closing portal still
      // has its wide-screen position and can overflow the next narrow viewport.
      await expect(
        page.getByRole("dialog", { name: "Working now", includeHidden: true }),
      ).toHaveCount(0);
    }

    await page.mouse.move(0, 0);
    await viewAgentActivity(page, composer, agent);
    const panel = activityPanel(page);
    await showRaw(panel);
    await panel.getByRole("button", { name: /acp_read/ }).click();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(panel.locator("pre code")).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      await page.screenshot({
        path: testInfo.outputPath(`activity-${mode}-${width}.png`),
      });
    }
  });
}

const profileChannelId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const it = test.extend({
  readState: true,
  channelIds: [profileChannelId, "beta"],
  channelNames: { [profileChannelId]: "Alpha" },
  historyCounts: { [profileChannelId]: 1, beta: 1 },
});
it("profile activity opens the exact agent and originating channel before its first frame", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  // The production broker advertises read-state writes even without the
  // readState fixture option. Exercise that publication before profile activity.
  await openChannelDetails(page);
  await expect(
    page.getByRole("complementary", {
      name: "Channel settings",
      exact: true,
      includeHidden: true,
    }),
  ).toHaveAttribute("aria-busy", "false");
  await expect(
    page.getByRole("button", { name: "Leave channel", exact: true }),
  ).toBeVisible();
  await page.getByText("Diagnostics", { exact: true }).click();
  await page
    .getByRole("button", {
      name: "Mark read through loaded messages",
      exact: true,
    })
    .click();
  await expect.poll(() => app.report.readPublications.length).toBe(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Close Channel settings tab", exact: true })
    .click();
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const profile = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  // A person's profile carries no activity card: neither preview nor launcher.
  const personKey = generateSecretKey();
  const personMessage = finalizeEvent(
    {
      kind: 9,
      tags: [["h", profileChannelId]],
      content: "Contextual person entry",
      created_at: Math.floor(Date.now() / 1000),
    },
    personKey,
  );
  app.relay.publish("primary", personMessage);
  await page
    .locator(`[data-message-id="${personMessage.id}"]`)
    .getByRole("button", { name: /profile/ })
    .click();
  // The settled metadata read is the barrier: no agent evidence can follow it.
  await expect(
    profile.getByText("No profile metadata is available in this community."),
  ).toBeVisible();
  await expect(
    profile.getByRole("region", { name: "Activity preview" }),
  ).toHaveCount(0);
  await expect(
    profile.getByRole("button", { name: "View activity", exact: true }),
  ).toHaveCount(0);
  const agentKey = generateSecretKey();
  const agent = getPublicKey(agentKey);
  app.serveProfile(agentKey, { name: "Fixture agent", is_agent: true });
  const message = finalizeEvent(
    {
      kind: 9,
      tags: [["h", profileChannelId]],
      content: "Contextual agent entry",
      created_at: Math.floor(Date.now() / 1000),
    },
    agentKey,
  );
  app.relay.publish("primary", message);
  const avatar = page
    .locator(`[data-message-id="${message.id}"]`)
    .getByRole("button", { name: /profile/ });
  await avatar.waitFor();
  // Reading the live message can outlast the normal publication debounce while
  // the profile is open. Exercise that boundary instead of racing teardown.
  await page
    .getByRole("region", { name: "Channel message history", exact: true })
    .focus();
  await expect
    .poll(() =>
      app.report.readPublications.some(
        ({ community, blob }) =>
          community === "primary" &&
          // Catch-up replaces the message's own mark once it covers it.
          Math.max(
            blob.contexts[`msg:${message.id}`] ?? -1,
            blob.contexts[`activity:${profileChannelId}`] ?? -1,
          ) >= message.created_at,
      ),
    )
    .toBe(true);
  await avatar.click();
  await expect(
    profile.getByRole("region", { name: "Activity preview" }),
  ).toContainText("No activity yet");
  await profile
    .getByRole("button", { name: "View activity", exact: true })
    .click();
  await expect(
    profile.getByRole("tab", { name: "Activity", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const panel = page.getByRole("region", {
    name: "Agent activity",
    exact: true,
  });
  await expect(panel.locator("code").first()).toHaveText(agent);
  await expect(
    panel.getByRole("combobox", { name: "Conversation", exact: true }),
  ).toHaveText(/^#Alpha · whole channel/);
  await showRaw(panel);
  await expect(
    panel.getByText(/No captured records for this identity in this channel/),
  ).toBeVisible();
  const item = (kind, channelId, turnId) => ({
    kind,
    channelId,
    turnId,
    sessionId: null,
    timestamp: new Date().toISOString(),
  });
  app.observer(
    item("acp_read", profileChannelId, "other-agent"),
    generateSecretKey(),
  );
  app.observer(item("acp_write", "beta", "other-channel"), agentKey);
  app.observer(item("session_resolved", null, "unscoped"), agentKey);
  const expected = app.observer(
    item("turn_liveness", profileChannelId, "wanted"),
    agentKey,
  );
  const row = panel.getByRole("button", { name: /turn_liveness/ });
  await expect(row).toBeVisible();
  await expect(panel.getByText("1 observed working turn(s).")).toBeVisible();
  await expect(
    panel.getByRole("button", {
      name: /acp_read|acp_write|session_resolved/,
    }),
  ).toHaveCount(0);
  await row.click();
  await expect(panel.locator("pre code")).toHaveText(expected.plaintext);
  await panel
    .getByRole("combobox", { name: "Conversation", exact: true })
    .click();
  await page
    .getByRole("option", {
      name: "All conversations (including unscoped records)",
      exact: true,
    })
    .click();
  await expect(panel.getByRole("button", { name: /acp_write/ })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: /session_resolved/ }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: /acp_read/ })).toHaveCount(0);
  // Activity is the profile's tab, not a nested panel. Info returns to the preview.
  await profile.getByRole("tab", { name: "Info", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(
    profile.getByRole("region", { name: "Activity preview" }),
  ).toBeVisible();
  const profileTab = page
    .getByRole("tablist", { name: "Panel tabs" })
    .getByRole("tab", { selected: true });
  await profileTab.focus();
  await profileTab.press("Escape");
  await expect(profile).toBeHidden();
  await expect(avatar).toBeFocused();
  await avatar.click();
  await expect(
    profile.getByRole("region", { name: "Activity preview" }).locator("time"),
  ).toHaveAttribute("datetime", JSON.parse(expected.plaintext).timestamp);
  const preview = profile.getByRole("region", { name: "Activity preview" });
  await profile.getByRole("tab", { name: "Channels", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await profile.getByRole("tab", { name: "Info", exact: true }).click();
  await expect(preview.locator("time")).toHaveAttribute(
    "datetime",
    JSON.parse(expected.plaintext).timestamp,
  );
  const update = (value) => ({
    ...item("acp_read", profileChannelId, "wanted"),
    payload: { method: "session/update", params: { update: value } },
  });
  app.observer(
    update({
      sessionUpdate: "agent_message_chunk",
      messageId: "reply",
      content: {
        type: "text",
        text: "I found the issue in the channel subscription. ",
      },
    }),
    agentKey,
  );
  app.observer(
    update({
      sessionUpdate: "agent_message_chunk",
      messageId: "reply",
      content: {
        type: "text",
        text: "Checking the fix against the existing tests.",
      },
    }),
    agentKey,
  );
  app.observer(
    update({
      sessionUpdate: "tool_call",
      toolCallId: "tests",
      title: "Run profile tests",
      status: "in_progress",
    }),
    agentKey,
  );
  await expect(
    preview.getByRole("list", { name: "Recent activity" }),
  ).toContainText(
    "I found the issue in the channel subscription. Checking the fix against the existing tests.",
  );
  await expect(
    preview.getByText("Run profile tests", { exact: true }),
  ).toBeVisible();
  app.observer(
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "tests",
      status: "completed",
    }),
    agentKey,
  );
  await expect(
    preview.getByText("Tool completed", { exact: true }),
  ).toBeVisible();
  await profile.getByRole("tab", { name: "Channels", exact: true }).click();
  await profile.getByRole("tab", { name: "Info", exact: true }).click();
  await expect(
    preview.getByText("Run profile tests", { exact: true }),
  ).toBeVisible();
  // Exercise painted theme/layout, not the separate appearance persistence contract.
  for (const mode of ["light", "dark"]) {
    await page.locator("html").evaluate((element, mode) => {
      element.setAttribute("data-color-mode", mode);
    }, mode);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(preview).toBeVisible();
      await expect(
        preview.getByRole("button", { name: "View activity" }),
      ).toBeVisible();
      const bounds = await preview.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(
        await preview.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`profile-preview-${mode}-${width}.png`),
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  await profile
    .getByRole("button", { name: "View activity", exact: true })
    .click();
  await page.locator('[data-channel-id="beta"]').click();
  await expect(panel).toHaveCount(0);
  // Disable removes both registration and profile affordance, not the profile itself.
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page
    .getByRole("switch", { name: "Enable Agent Activity", exact: true })
    .click();
  await page
    .getByRole("complementary", { name: "Settings sidebar" })
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await page.locator(`[data-channel-id="${profileChannelId}"]`).click();
  // Channel navigation restores the existing profile tab. Close it explicitly
  // so this exercises a fresh opening and its focus handoff after disable.
  await page
    .getByRole("button", { name: "Close Fixture agent tab", exact: true })
    .click();
  await expect(profile).toBeHidden();
  await avatar.click();
  await expect(profile).toBeVisible();
  await expect(
    profile.getByRole("button", { name: "View activity", exact: true }),
  ).toHaveCount(0);
  // Finish the reopened profile's focus handoff and timeline layout before
  // starting read dwell; visible profile content alone proves neither.
  await expect(profileTab).toBeFocused();
  await settle(page);
  const history = page.getByRole("region", {
    name: "Channel message history",
  });
  await history.focus();
  await expect(history).toBeFocused();
  // Complete ordinary read dwell and publication before fixture teardown.
  await expect
    .poll(() => app.report.readPublications.length)
    .toBeGreaterThan(1);
});

test.describe("thread activity", () => {
  test.use({
    threadUnread: true,
    readState: true,
    historyCounts: { alpha: 2, beta: 1 }, // Thread fixtures replace the last two Alpha rows with roots.
  });

  test("thread typing uses the existing route, stays isolated, and floats thread activity above the composer", async ({
    page,
    app,
  }, testInfo) => {
    await open(page, app);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    const key = generateSecretKey(),
      agent = getPublicKey(key);
    const onlyAgent = new RegExp(
      `^Activity: .*${agent.slice(0, 10)}.* working$`,
    );
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content.startsWith("Thread root"));
    const row = page.locator(
      `[data-channel-timeline] [data-message-id="${root.id}"]`,
    );
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const openThread = async () => {
      await row.hover();
      await row.getByRole("button", { name: /^View thread:/ }).click();
      await expect(
        thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
      ).toBeVisible();
    };
    await openThread();
    const composer = channelComposer(page);
    const channelTrigger = activityTrigger(composer);
    const threadTrigger = activityTrigger(thread);
    const threadStatus = thread.locator("[data-agent-working-status]");
    const popup = workingNow(page);
    const marker = page
      .locator('[data-channel-id="alpha"]')
      .getByRole("img", { name: /working in Alpha$/ });
    const sendEvent = (kind, threadId, signingKey = key, content = "") => {
      const event = finalizeEvent(
        {
          kind,
          created_at: Math.floor(Date.now() / 1000),
          content,
          tags: [
            ["h", "alpha"],
            ...(threadId
              ? [
                  ["e", threadId, "", "root"],
                  ["e", threadId, "", "reply"],
                ]
              : []),
          ],
        },
        signingKey,
      );
      app.relay.publish("primary", event);
      return event;
    };
    const sendTyping = (threadId, signingKey) =>
      sendEvent(20002, threadId, signingKey);
    // Pointer exit closes the hover popup; Escape is covered separately.
    const closePopup = async () => {
      await page.mouse.move(0, 0);
      await expect(popup).toHaveCount(0);
    };
    // Owner telemetry recognizes the agent; its channel-wide turn has no thread.
    app.observer(activity("turn_liveness", "alpha", "previous"), key);
    await expect(channelTrigger).toHaveAccessibleName(onlyAgent);
    await expect(threadTrigger).toHaveCount(0);
    app.observer(activity("turn_completed", "alpha", "previous"), key);
    await expect(channelTrigger).toHaveCount(0);
    const unrecognized = generateSecretKey();
    const otherThread = "b".repeat(64);
    sendTyping(root.id, unrecognized);
    sendTyping(otherThread);
    // An unrecognized signer is ordinary typing, never an agent avatar.
    await expect(threadStatus).toHaveText(/^\S+ is typing$/);
    // Another thread's agent work lights the channel control with that thread's
    // scope; arriving after the first event, it is also the barrier for it.
    await openWorkingNow(page, composer);
    await expect(agentRow(popup, agent)).toContainText(
      `Thread · ${otherThread.slice(0, 8)}`,
    );
    await expect(threadTrigger).toHaveCount(0);
    await closePopup();
    // A completed message ends public typing in both scopes.
    sendEvent(9, root.id, unrecognized, "Unrecognized participant finished");
    sendEvent(9, otherThread, key, "Other thread finished");
    await expect(threadStatus).toBeEmpty();
    await expect(channelTrigger).toHaveCount(0);
    // Finish panel entrance before starting the eight-second working signal.
    await page.locator("[data-panel-dock]").evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      );
    });
    const typing = sendTyping(root.id);
    await expect(threadTrigger).toHaveAccessibleName(onlyAgent);
    await expect(threadStatus).toHaveText(/ is working$/);
    await expect(marker).toHaveCount(0); // Thread-only fallback must not light channel scope.
    await expect(page.locator(`[data-message-id="${typing.id}"]`)).toHaveCount(
      0,
    );
    const form = thread.getByRole("form", {
      name: "Reply to thread",
      exact: true,
    });
    const expectAboveForm = async () => {
      const triggerBox = await threadTrigger.boundingBox(),
        formBox = await form.boundingBox();
      expect(triggerBox.y + triggerBox.height).toBeLessThanOrEqual(formBox.y);
      expect(triggerBox.x).toBeGreaterThanOrEqual(formBox.x);
      expect(triggerBox.x + triggerBox.width).toBeCloseTo(
        formBox.x + formBox.width,
        0,
      );
    };
    await expectAboveForm();
    // The thread control's row names the exact thread; no channel-wide guess.
    await openWorkingNow(page, thread);
    await expect(agentRow(popup, agent)).toHaveAccessibleName(
      /^Open thread for /,
    );
    await expect(agentRow(popup, agent)).not.toContainText("Thread ·");
    await closePopup();
    // Same agent, two observer turns, and scoped thread typing. Do not infer
    // that either channel-wide turn belongs to this thread, or hide other work.
    app.observer(activity("turn_liveness", "alpha", "parallel-one"), key);
    app.observer(activity("turn_liveness", "alpha", "parallel-two"), key);
    sendTyping(root.id);
    await openWorkingNow(page, composer);
    await expect(agentRow(popup, agent)).toContainText(
      "Work with unconfirmed thread",
    );
    await expect(agentRow(popup, agent)).toContainText(
      `Thread · ${root.content.replace(/\s+/g, " ").trim().slice(0, 60)}`,
    );
    await expect(threadTrigger).toHaveAccessibleName(onlyAgent);
    await page.screenshot({
      path: testInfo.outputPath("thread-activity-above-composer.png"),
    });
    // Mixed scopes: channel activity stays whole-channel, thread activity exact.
    await agentRow(popup, agent).hover();
    await agentActivityAction(popup, agent).click();
    const panel = activityPanel(page);
    const conversation = panel.getByRole("combobox", {
      name: "Conversation",
      exact: true,
    });
    await expect(panel.locator("code").first()).toHaveText(agent);
    await expect(conversation).toHaveText(/^#Alpha · whole channel/);
    await page
      .locator(
        '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
      )
      .click();
    // Activity and Thread share the detail pane; return to the thread.
    await openThread();
    // Popup semantics and keyboard operation need real browsers.
    await threadTrigger.focus();
    await page.keyboard.press("Enter");
    await expect(popup).toBeVisible();
    await expect(agentRow(popup, agent)).toBeVisible();
    // WebKit focuses the first row on open; Chromium leaves it one Tab away.
    const keyboardRow = agentRow(popup, agent);
    for (let step = 0; step < 2 && !(await isFocused(keyboardRow)); step++)
      await page.keyboard.press("Tab");
    await expect(keyboardRow).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(popup).toHaveCount(0);
    await expect(
      thread.getByRole("region", { name: "Thread messages", exact: true }),
    ).toContainText(root.content);
    await page.setViewportSize({ width: 390, height: 844 });
    sendTyping(root.id);
    await expect(threadTrigger).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBe(390);
    await expectAboveForm();
    await page.screenshot({
      path: testInfo.outputPath("thread-activity-narrow.png"),
    });
    await page.setViewportSize({ width: 1440, height: 950 });
    await viewAgentActivity(page, thread, agent);
    await expect(panel.locator("code").first()).toHaveText(agent);
    // The thread composer opens this thread's scope, not channel-wide details.
    await expect(conversation).toHaveText(/^#Alpha › /);
    await page
      .locator(
        '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
      )
      .click();
    // The channel row opens the agent's one known thread.
    await openThread();
    await page
      .locator(
        '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"])',
      )
      .click();
    await expect(thread).toHaveCount(0);
    sendTyping(root.id);
    await openWorkingNow(page, composer);
    await expect(agentRow(popup, agent)).toHaveAccessibleName(
      /^Open thread for /,
    );
    await agentRow(popup, agent).click();
    await expect(popup).toHaveCount(0);
    await expect(
      thread.getByRole("region", { name: "Thread messages", exact: true }),
    ).toContainText(root.content);
    app.observer(activity("turn_completed", "alpha", "parallel-one"), key);
    app.observer(activity("turn_completed", "alpha", "parallel-two"), key);
    sendEvent(9, root.id, key, "Thread work finished");
    await expect(threadTrigger).toHaveCount(0);
    sendTyping();
    await expect(marker).toBeVisible();
    const workingBox = await marker.boundingBox();
    expect(workingBox).toEqual(
      expect.objectContaining({ width: 26, height: 15 }),
    );
    // Channel-level work opens the channel conversation, never an inferred thread.
    await openWorkingNow(page, composer);
    await expect(agentRow(popup, agent)).toHaveAccessibleName(
      /^Open conversation for /,
    );
    await expect(agentRow(popup, agent)).toContainText("Channel conversation");
    const channelStatus = composer.locator("[data-agent-working-status]");
    await expect(channelStatus).toHaveText(/ is working$/);
    await page.screenshot({
      path: testInfo.outputPath("channel-agent-single-presentation.png"),
    });
    // Escape dismisses only the popup, never the conversation pane beneath it.
    await expect(thread).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(thread).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(marker).toHaveCount(0, { timeout: 10_000 });
    await expect(channelTrigger).toHaveCount(0);
    await expect(channelStatus).toBeEmpty();
  });
  // Browser-only: real composer wiring through signed relay traffic,
  // mixed-status geometry at narrow width, and navigation across live scopes.
  test("thread working avatars deduplicate agents while preserving human typing and scope transitions", async ({
    page,
    app,
  }, testInfo) => {
    await open(page, app);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    const keys = [generateSecretKey(), generateSecretKey()];
    const roots = app.histories
      .get("primary/alpha")
      .filter((row) => row.content.startsWith("Thread root"));
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const threadTrigger = activityTrigger(thread);
    const workingStatus = thread.locator("[data-agent-working-status]");
    // Visible human typing is presentation; the status above announces it.
    const humanTyping = (scope) =>
      scope.locator('[aria-hidden="true"]').filter({ hasText: /is typing$/ });
    const popup = workingNow(page);
    const openThread = async (root) => {
      await page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ })
        .click();
      await expect(
        thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
      ).toBeVisible();
    };
    const publish = (key, root, kind = 20002) => {
      app.relay.publish(
        "primary",
        finalizeEvent(
          {
            kind,
            created_at: Math.floor(Date.now() / 1000),
            content: kind === 9 ? "Work finished" : "",
            tags: [
              ["h", "alpha"],
              ...(root
                ? [
                    ["e", root.id, "", "root"],
                    ["e", root.id, "", "reply"],
                  ]
                : []),
            ],
          },
          key,
        ),
      );
    };
    // Pointer exit closes the hover popup; Escape is covered separately.
    const closePopup = async () => {
      await page.mouse.move(0, 0);
      await expect(popup).toHaveCount(0);
    };
    await openThread(roots[0]);
    // The live region exists before the first transition, without visible layout.
    await expect(workingStatus).toBeAttached();
    await expect(workingStatus).toBeEmpty();
    await expect(threadTrigger).toHaveCount(0);
    const composer = channelComposer(page);
    const channelTrigger = activityTrigger(composer);
    // Names come from already-loaded profiles; the control itself reads none.
    // Ordinary channel messages load them before any activity starts.
    for (const [index, key] of keys.entries()) {
      app.serveProfile(key, { name: `Worker ${index + 1}`, is_agent: true });
      publish(key, undefined, 9);
      await expect(
        page
          .locator("[data-channel-timeline]")
          .getByText(`Worker ${index + 1}`, { exact: true }),
      ).toBeVisible();
      app.observer(
        activity("turn_liveness", "alpha", `recognize-${index}`),
        key,
      );
    }
    await expect(channelTrigger).toHaveAccessibleName(
      "Activity: 2 agents working",
    );
    for (const [index, key] of keys.entries())
      app.observer(
        activity("turn_completed", "alpha", `recognize-${index}`),
        key,
      );
    await expect(channelTrigger).toHaveCount(0);
    publish(keys[0], roots[0]);
    await expect(threadTrigger).toHaveAccessibleName(
      /^Activity: Worker 1 working$/,
    );
    await expect(workingStatus).toHaveText("Worker 1 is working");
    await expect(humanTyping(thread)).toHaveCount(0);
    publish(keys[1], roots[0]);
    await expect(threadTrigger).toHaveAccessibleName(
      "Activity: 2 agents working",
    );
    await expect(workingStatus).toHaveText(
      /^Worker [12], Worker [12] are working$/,
    );
    await expect(threadTrigger.locator(".buzz-avatar")).toHaveCount(2);
    await openWorkingNow(page, thread);
    for (const name of ["Worker 1", "Worker 2"])
      await expect(
        popup.getByRole("button", { name: `Open thread for ${name}` }),
      ).toHaveCount(1);
    await closePopup();
    await expect(humanTyping(thread)).toHaveCount(0);
    const human = generateSecretKey();
    app.serveProfile(human, { name: "Human typer" });
    publish(human, roots[0]);
    await expect(humanTyping(thread)).toHaveCount(1);
    await expect(humanTyping(thread)).not.toContainText("Worker");
    await expect(workingStatus).toHaveText(/ are working\. .+ is typing$/);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("[data-panel-dock]").evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      );
    });
    for (const key of keys) publish(key, roots[0]);
    publish(human, roots[0]);
    await expect(threadTrigger).toHaveAccessibleName(
      "Activity: 2 agents working",
    );
    await expect(humanTyping(thread)).toBeVisible();
    // Human typing and agent avatars share one floating lane without overlap.
    const typingBox = await humanTyping(thread).boundingBox();
    const triggerBox = await threadTrigger.boundingBox();
    const formBox = await thread
      .getByRole("form", { name: "Reply to thread", exact: true })
      .boundingBox();
    expect(typingBox.y + typingBox.height).toBeLessThanOrEqual(formBox.y);
    expect(triggerBox.y + triggerBox.height).toBeLessThanOrEqual(formBox.y);
    expect(typingBox.x).toBeGreaterThanOrEqual(formBox.x);
    expect(typingBox.x + typingBox.width).toBeLessThanOrEqual(triggerBox.x);
    expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(
      formBox.x + formBox.width + 0.5,
    );
    await page.screenshot({
      path: testInfo.outputPath(
        "thread-single-agent-presentation-human-typing.png",
      ),
    });
    await page.setViewportSize({ width: 1440, height: 950 });
    publish(human, roots[0], 9);
    await expect(humanTyping(thread)).toHaveCount(0);
    await page
      .locator(
        '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"])',
      )
      .click();
    await openThread(roots[1]);
    await expect(
      thread.getByRole("region", { name: "Thread messages", exact: true }),
    ).toContainText(roots[1].content);
    await expect(threadTrigger).toHaveCount(0);
    await expect(workingStatus).toBeEmpty();
    await page
      .locator(
        '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"])',
      )
      .click();
    await openThread(roots[0]);
    // Fresh pulses avoid making the navigation assertions depend on fixture speed.
    for (const key of keys) publish(key, roots[0]);
    await expect(threadTrigger).toHaveAccessibleName(
      "Activity: 2 agents working",
    );
    publish(keys[0], roots[0], 9);
    await expect(threadTrigger).toHaveAccessibleName(
      "Activity: Worker 2 working",
    );
    publish(keys[1], roots[0], 9);
    await expect(threadTrigger).toHaveCount(0);
    await expect(workingStatus).toBeAttached();
    await expect(workingStatus).toBeEmpty();
    await expect(humanTyping(thread)).toHaveCount(0);
    await page
      .locator(
        '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"])',
      )
      .click();
    // The channel composer uses the same floating control and popup rows.
    const channelStatus = composer.locator("[data-agent-working-status]");
    publish(keys[0]);
    await expect(channelTrigger).toHaveAccessibleName(
      "Activity: Worker 1 working",
    );
    await expect(channelStatus).toHaveText("Worker 1 is working");
    await expect(humanTyping(composer)).toHaveCount(0);
    publish(keys[1]);
    await expect(channelTrigger).toHaveAccessibleName(
      "Activity: 2 agents working",
    );
    await expect(channelStatus).toHaveText(
      /^Worker [12], Worker [12] are working$/,
    );
    await expect(popup).toHaveCount(0);
    await openWorkingNow(page, composer);
    for (const name of ["Worker 1", "Worker 2"])
      await expect(
        popup.getByRole("button", { name: `Open conversation for ${name}` }),
      ).toHaveCount(1);
    await closePopup();
    publish(human);
    await expect(humanTyping(composer)).toBeVisible();
    await expect(humanTyping(composer)).not.toContainText("Worker");
    await expect(channelStatus).toHaveText(/ are working\. .+ is typing$/);
    await page.screenshot({
      path: testInfo.outputPath("channel-multiple-agents-human-typing.png"),
    });
    publish(human, undefined, 9);
    await expect(humanTyping(composer)).toHaveCount(0);
    publish(keys[0], undefined, 9);
    await expect(channelTrigger).toHaveAccessibleName(
      "Activity: Worker 2 working",
    );
    publish(keys[1], undefined, 9);
    await expect(channelTrigger).toHaveCount(0);
    await page.locator('[data-channel-id="beta"]').click();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    await expect(page.locator("[data-agent-activity-trigger]")).toHaveCount(0);
    await expect(
      page.locator("[data-agent-working-status]:not(:empty)"),
    ).toHaveCount(0);
  });
});

// Browser-only: production broker SQLite survives document reload and the real
// Settings confirmation clears the mounted plugin. Native process restart is tested in Rust.
test.describe("host archive durability", () => {
  test.use({ archiveOnDisk: true });
  test("encrypted host history survives reload without working evidence and can be cleared", async ({
    page,
    app,
  }) => {
    await open(page, app);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    const key = generateSecretKey();
    const agent = getPublicKey(key);
    app.serveProfile(key, { name: "History agent", is_agent: true });
    const record = app.observer(
      activity("turn_liveness", "alpha", "saved", {
        text: "secret-history-marker",
      }),
      key,
    );
    const composer = channelComposer(page);
    const popup = await openWorkingNow(page, composer);
    // The served profile may name this row; there is exactly one agent.
    await popup
      .getByRole("button", { name: /^Open conversation for / })
      .hover();
    await popup.getByRole("button", { name: /^View .+ activity$/ }).click();
    const panel = activityPanel(page);
    await expect(panel.locator("code").first()).toHaveText(agent);
    await showRaw(panel);
    await expect(
      panel.getByText("Saved history loaded.", { exact: true }),
    ).toBeVisible();
    const disk = async () =>
      Buffer.concat(
        await Promise.all(
          [app.archiveFile, `${app.archiveFile}-wal`].map(async (path) => {
            try {
              return await readFile(path);
            } catch (error) {
              if (error.code === "ENOENT") return Buffer.alloc(0);
              throw error;
            }
          }),
        ),
      ).toString("utf8");
    await expect.poll(disk).toContain(record.event.id);
    expect(await disk()).not.toContain("secret-history-marker");
    await open(page, app); // new document and session, same device/account/community
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    // Open through a profile: restored history must not create a working launcher.
    const message = finalizeEvent(
      {
        kind: 9,
        tags: [["h", "alpha"]],
        content: "History profile entry",
        created_at: Math.floor(Date.now() / 1000),
      },
      key,
    );
    app.relay.publish("primary", message);
    await page
      .locator(`[data-message-id="${message.id}"]`)
      .getByRole("button", { name: /profile/ })
      .click();
    await page
      .getByRole("button", { name: "View activity", exact: true })
      .click();
    await showRaw(panel);
    await expect(
      panel.getByText("Saved history loaded.", { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByText("No fresh working evidence.", { exact: true }),
    ).toBeVisible();
    await expect(activityTrigger(composer)).toHaveCount(0);
    await panel.getByRole("button", { name: /turn_liveness/ }).click();
    await expect(panel.locator("pre code")).toContainText(
      "secret-history-marker",
    );
    await page
      .getByRole("button", { name: "Your profile", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    const archive = page.getByRole("region", { name: /Saved agent activity/ });
    await expect(archive.getByText(/not in this browser/)).toBeVisible();
    await archive
      .getByRole("button", { name: "Clear activity history", exact: true })
      .click();
    const confirmation = page.getByRole("alertdialog", {
      name: "Clear activity history?",
    });
    await expect(confirmation).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("archive-clear-confirmation.png"),
    });
    await confirmation
      .getByRole("button", { name: "Clear saved records" })
      .click();
    await expect(confirmation).toHaveCount(0);
    const count = () => {
      const database = new DatabaseSync(app.archiveFile, { readOnly: true });
      try {
        return database
          .prepare(
            "SELECT COUNT(*) AS count FROM archive_events WHERE kind=24200",
          )
          .get().count;
      } finally {
        database.close();
      }
    };
    expect(count()).toBe(0);
    await page
      .getByRole("complementary", { name: "Settings sidebar" })
      .getByRole("button", { name: "Back", exact: true })
      .click();
    await expect(
      panel.getByRole("button", { name: /turn_liveness/ }),
    ).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("archive-cleared.png"),
    });
  });
});
