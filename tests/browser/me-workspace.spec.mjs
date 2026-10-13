import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
const id = "33333333-3333-4333-8333-333333333333";
const other = "44444444-4444-4444-8444-444444444444";
test.use({
  productionBroker: true,
  channelIds: [id, other, "gamma"],
  channelNames: { [id]: "Alpha", [other]: "Beta", gamma: "Gamma" },
  sessionChannels: [id, other],
  meChannels: [id, other],
  historyCounts: { [id]: 2, [other]: 1, gamma: 1 },
});
// Verifies shell routing, actual hover/focus and retained drafts across the real panel host.
test("Me Activity opens locally, restores per conversation and retires on plugin disable", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Me");
  const sidebar = page.getByRole("navigation", { name: "Me conversations" });
  await sidebar.locator(`[data-me-channel-id="${id}"]`).click();
  const composer = page.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  await composer.fill("Keep my Me draft");
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const key = generateSecretKey();
  app.observer(
    {
      kind: "turn_liveness",
      seq: 1,
      timestamp: new Date().toISOString(),
      channelId: id,
      sessionId: "S",
      turnId: "me-activity",
    },
    key,
  );
  const trigger = page.getByRole("button", {
    name: /^Activity: .+ working$/,
  });
  await trigger.hover();
  const preview = page.getByRole("dialog", { name: "Working now" });
  await expect(preview).toBeVisible();
  await trigger.click();
  const panel = page.getByRole("region", {
    name: "Agent activity",
    exact: true,
  });
  await expect(panel).toBeVisible();
  await expect(panel.locator("code").first()).toHaveText(getPublicKey(key));
  await expect(preview).toBeHidden();
  await expect(sidebar).toBeVisible();
  await expect(composer).toHaveText("Keep my Me draft");
  await page
    .getByRole("button", { name: "Close Agent Activity tab", exact: true })
    .click();
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await expect(panel).toBeVisible();
  await sidebar.getByRole("button", { name: "Beta", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await sidebar.locator(`[data-me-channel-id="${id}"]`).click();
  await expect(panel).toBeVisible();
  await expect(composer).toHaveText("Keep my Me draft");
  await page
    .getByRole("button", { name: "Close Agent Activity tab", exact: true })
    .click();
  // Restored panels no longer retain the original trigger element.
  await trigger.focus();
  await page.mouse.move(0, 0);
  await page.keyboard.press("ArrowDown");
  await expect(preview).toBeVisible();
  await expect(preview).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(preview).toBeFocused();
  await page.keyboard.press("Tab");
  const conversationAction = preview.getByRole("button", {
    name: /^Open conversation for/,
  });
  await expect(conversationAction).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(sidebar).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Alpha", exact: true }),
  ).toBeVisible();
  await openPage(page, "Me");
  await sidebar.locator(`[data-me-channel-id="${id}"]`).click();
  await trigger.press("Enter");
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page
    .getByRole("switch", { name: "Enable Agent Activity", exact: true })
    .click();
  await openPage(page, "Me");
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "Agent Activity", exact: true }),
  ).toHaveCount(0);
});
// Real hover, menu hit targets and local-panel handoff cannot be proved in jsdom.
test("Me sidebar shares working activity, keyboard preview and local panel navigation", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Me");
  const sidebar = page.getByRole("navigation", { name: "Me conversations" });
  const alpha = sidebar.locator(`[data-me-channel-id="${id}"]`);
  await sidebar.getByRole("button", { name: "Beta", exact: true }).click();
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const key = generateSecretKey();
  const event = (kind) => ({
    kind,
    seq: 1,
    timestamp: new Date().toISOString(),
    channelId: id,
    sessionId: "S",
    turnId: "sidebar-me",
  });
  app.observer(event("turn_liveness"), key);
  const badge = alpha.getByRole("img", { name: /working in Alpha$/ });
  await page.mouse.move(0, 0);
  await expect(badge).toBeVisible();
  await expect(alpha.locator("[data-me-working-indicator]")).toHaveCSS(
    "opacity",
    "1",
  );
  await alpha.hover();
  const popup = page.getByRole("dialog", {
    name: "Activity in Alpha",
    exact: true,
  });
  await expect(popup).toBeVisible();
  await expect(
    sidebar.getByRole("button", { name: "Beta", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await popup.getByRole("button", { name: /Open conversation for/ }).hover();
  await popup.getByRole("button", { name: /View .+ activity/ }).click();
  const panel = page.getByRole("region", {
    name: "Agent activity",
    exact: true,
  });
  await expect(panel.locator("code").first()).toHaveText(getPublicKey(key));
  await expect(sidebar).toBeVisible();
  await expect(alpha).toHaveAttribute("aria-current", "page");
  await page
    .getByRole("button", { name: "Close Agent Activity tab", exact: true })
    .click();
  await expect(alpha).toBeFocused();
  // The installed clock runs, so pause at a fixed instant ahead of it rather
  // than a test-side timestamp that the page clock may already have passed.
  const base = Date.now();
  await page.clock.install({ time: base });
  await page.clock.pauseAt(base + 1_000);
  // Cross the closed trigger, then reopen by keyboard before hover dismissal.
  await alpha.hover();
  await page.mouse.move(0, 0);
  await alpha.press("Enter");
  await expect(alpha).toHaveAttribute("aria-expanded", "true");
  await expect(popup).toBeVisible();
  // Run past the 150ms hover-close deadline, not a wall-clock wait.
  await page.clock.runFor(200);
  await page.clock.resume();
  await expect(popup).toBeVisible();
  const activityAction = popup.getByRole("button", {
    name: /View .+ activity/,
  });
  // Visibility precedes Base UI's initial-focus handoff. Wait for that boundary
  // before tabbing, otherwise a fast keypress can leave the popup while it opens.
  await expect(
    popup.getByRole("button", { name: /Open conversation for/ }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(activityAction).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel).toBeVisible();
  await page
    .getByRole("button", { name: "Close Agent Activity tab", exact: true })
    .click();
  // Context actions must remain separate from the activity trigger.
  await alpha.press("Shift+F10");
  await expect(
    page.getByRole("menuitem", { name: "Rename", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  app.observer(event("turn_completed"), key);
  await expect(badge).toHaveCount(0);
});

// Me's actual host must not retain the removed blank-tab entry point.
test("Me leaves an empty pane unavailable until content opens it", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Me");
  await page
    .getByRole("navigation", { name: "Me conversations" })
    .getByRole("button", { name: "Alpha", exact: true })
    .click();
  const composer = page.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  await composer.fill("Keep this draft");
  const split = page.getByRole("button", {
    name: "Toggle tab pane",
    exact: true,
  });
  await expect(split).toHaveAttribute("aria-disabled", "true");
  await split.focus();
  await split.press("Enter");
  await expect(page.locator("[data-panel-workspace]")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Choose a tab" })).toHaveCount(
    0,
  );
  await expect(composer).toHaveText("Keep this draft");
});

// Real PersonalComposer -> signing boundary remains covered through the main reader.
// Me no longer has a user path that opens another conversation as a side tab.
// Owner-authored inventory supplies choices; signed membership remains authority.
test.describe("personal recipients", () => {
  test.use({
    sessionChannels: [id],
    meAgentNames: ["Owned Honey", "Owned Brain"],
    meOutsideAgentNames: ["Outside Agent"],
  });
  test("Me signs only explicit owned recipients and rejects an outside identity", async ({
    page,
    app,
  }) => {
    // An older finite head may finish after a live arrival mounts the reader.
    // Hold the response to exercise that route; the mounted timeline test
    // controls the exact zero-viewport ordering independently of browser timing.
    let releaseHead;
    const heldHead = new Promise((resolve) => {
      releaseHead = resolve;
    });
    let readHead = false;
    await page.route("**/api/relay/**/query", async (route) => {
      if (
        !route
          .request()
          .postDataJSON()
          .some((filter) => filter.top_level && filter["#h"]?.includes("gamma"))
      )
        return route.continue();
      const response = await route.fetch();
      readHead = true;
      await heldHead;
      await route.fulfill({ response }).catch(() => {});
    });
    try {
      await page.goto(app.origin);
      await openPage(page, "Me");
      await page
        .getByRole("navigation", { name: "Me conversations" })
        .getByRole("button", { name: "Beta", exact: true })
        .click();
      const workspace = page.getByRole("main");
      const composer = page.getByRole("textbox", {
        name: "Message your agents",
        exact: true,
      });
      const [honey, brain, outsider] = app.meAgents;
      await workspace
        .getByRole("button", { name: "Mention a member", exact: true })
        .click();
      const picker = page.getByRole("dialog", {
        name: "Mention a member or agent",
      });
      await expect(
        picker.getByRole("button", {
          name: `${brain.name} ${brain.pubkey}`,
          exact: true,
        }),
      ).toBeVisible();
      await picker
        .getByRole("button", {
          name: `${honey.name} ${honey.pubkey}`,
          exact: true,
        })
        .click();
      await composer.press("End");
      await page.keyboard.insertText("Only this agent from Beta");
      await composer.press("Enter");
      const publications = () =>
        app.report.publications.filter(({ event }) => event.kind === 9);
      await expect.poll(() => publications().length).toBe(1);
      const sent = publications()[0].event;
      expect(verifyEvent(sent)).toBe(true);
      expect(sent.tags.filter(([key]) => key === "h")).toEqual([["h", other]]);
      expect(sent.tags.filter(([key]) => key === "p")).toEqual([
        ["p", honey.pubkey],
      ]);
      // Successful personal sends keep explicit mention chips for follow-up turns.
      await expect(composer).toHaveText(`@${honey.name} `);
      // A draft from the ordinary Messages reader may retain a channel member
      // who isn't in the owner's inventory. Me must reject that explicit recipient.
      await composer.fill("");
      await openPage(page, "Messages");
      await page.locator('[data-channel-id="gamma"]').click();
      // Me-owned conversations are intentionally absent from the Messages
      // sidebar. A real conversation link still opens their ordinary reader.
      const link = app.append(
        "primary",
        "gamma",
        `[Open Beta](buzz://channel/${other})`,
      );
      await expect.poll(() => readHead).toBe(true);
      releaseHead();
      await page
        .locator(`[data-message-id="${link.id}"]`)
        .getByRole("link", { name: "Open Beta", exact: true })
        .click();
      await workspace
        .getByRole("button", { name: "Mention a member", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Mention a member or agent" })
        .getByRole("button", {
          name: `${outsider.name} ${outsider.pubkey}`,
          exact: true,
        })
        .click();
      const ordinaryComposer = page.getByRole("textbox", {
        name: "Message #Beta",
        exact: true,
      });
      await ordinaryComposer.press("End");
      await page.keyboard.insertText("Not mine");
      await openPage(page, "Me");
      await page
        .getByRole("navigation", { name: "Me conversations" })
        .getByRole("button", { name: "Beta", exact: true })
        .click();
      await expect(composer).toContainText("@Outside Agent");
      await composer.press("Enter");
      await expect(
        workspace.getByText(
          "Only your available agents can be mentioned in Me. Remove the unavailable recipient and retry.",
          { exact: true },
        ),
      ).toBeVisible();
      // Error rendering is the completion barrier: rejected admission never reaches outbox.
      expect(publications()).toHaveLength(1);
      await expect(composer).toContainText("Not mine");
    } finally {
      releaseHead();
    }
  });
});

// Touch has no hover affordance: working must coexist with the permanent menu.
test.describe("touch sidebar activity", () => {
  test.use({ hasTouch: true, isMobile: true });
  test("working remains visible beside the row menu", async ({ page, app }) => {
    await page.goto(app.origin);
    await openPage(page, "Me");
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    app.observer(
      {
        kind: "turn_liveness",
        seq: 1,
        timestamp: new Date().toISOString(),
        channelId: id,
        sessionId: "S",
        turnId: "touch",
      },
      generateSecretKey(),
    );
    const row = page.locator(`[data-me-channel-id="${id}"]`);
    const indicator = row.locator("[data-me-working-indicator]");
    await expect(
      row.getByRole("img", { name: /working in Alpha$/ }),
    ).toBeVisible();
    await expect(indicator).toHaveCSS("opacity", "1");
    await row.tap();
    await expect(row).toHaveAttribute("aria-current", "page");
    await expect(indicator).toHaveCSS("opacity", "1");
    const menu = page.locator(
      `[data-session-menu-id="${id}"] [data-session-row-action]`,
    );
    await expect(menu).toHaveCSS("opacity", "1");
    const a = await indicator.boundingBox(),
      b = await menu.boundingBox();
    expect(a.x + a.width).toBeLessThanOrEqual(b.x + 1);
    await menu.focus();
    await expect(menu).toBeFocused();
    await expect(indicator).toHaveCSS("opacity", "1");
  });
});

// Captured-message navigation uses the exact-message reader, not a guessed thread.
test("Me sidebar opens a captured trigger in the canonical message reader", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Me");
  const sidebar = page.getByRole("navigation", { name: "Me conversations" });
  const alpha = sidebar.locator(`[data-me-channel-id="${id}"]`);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const key = generateSecretKey();
  const target = app.histories.get(`primary/${id}`)[0];
  app.observer(
    {
      kind: "turn_started",
      seq: 1,
      timestamp: new Date().toISOString(),
      channelId: id,
      sessionId: "S",
      turnId: "captured-trigger",
      payload: { triggeringEventIds: [target.id] },
    },
    key,
  );
  await expect(
    alpha.getByRole("img", { name: /working in Alpha$/ }),
  ).toBeVisible();
  await alpha.hover();
  const popup = page.getByRole("dialog", {
    name: "Activity in Alpha",
    exact: true,
  });
  await expect(popup).toBeVisible();
  await popup.getByRole("button", { name: /Open thread for/ }).click();
  await expect(sidebar).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(decodeURIComponent(location.hash.slice("#buzz=".length))),
      ),
    )
    .toMatchObject({
      kind: "conversation",
      channelId: id,
      messageId: target.id,
    });
  await expect(page.locator(`[data-message-id="${target.id}"]`)).toBeVisible();
});
