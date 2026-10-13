import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open, virtuaIdle } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  // Keep the viewer's profile off the startup path: the test holds it until
  // the viewer's linked message is focused.
  threadUnreadOwnedRoot: false,
  pluginFixtures: true,
  historyCounts: { alpha: 640, beta: 1 },
});
const button = (page, name) => page.getByRole("button", { name, exact: true });
const state = (page) =>
  page.evaluate(() => window.fixtureNavigation.snapshot());

test("Buzz channel and message links render, reveal verified targets, and preserve navigation history", async ({
  page,
  app,
}) => {
  app.relay.holdProfiles([app.viewer]);
  await open(page, app);
  const libraryReads = () =>
    app.report.brokerRequests.filter(({ url }) =>
      url.endsWith("/agent-library"),
    ).length;
  // Owner inventory survives the startup roster; previews add no further read.
  await expect.poll(libraryReads).toBe(1);
  const history = app.histories.get("primary/alpha");
  const target = history.find((row) => row.content === "Broadcast reply");
  const href = `buzz://message?channel=alpha&id=${target.id}`;
  const message = app.append(
    "primary",
    "alpha",
    `Open <${href}> or <buzz://channel/beta>.`,
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${message.id}"]`,
  );
  await expect(
    row.getByRole("link", { name: "Alpha", exact: true }),
  ).toBeVisible();
  await expect(
    row.getByRole("link", { name: "#Beta", exact: true }),
  ).toBeVisible();
  await expect(row).not.toContainText("<buzz:");
  const link = row.getByRole("link", { name: "Alpha", exact: true });
  await expect(link).toHaveCSS("text-decoration-line", "none");
  await expect(link).toHaveCSS("color", "rgb(11, 95, 168)");
  // Release the held profile while the link is focused, before the navigation
  // below: profile reads give up after 10s, and a loaded engine can spend that
  // long on navigation, leaving nothing pending to release.
  const preview = page.getByLabel("Message preview", { exact: true });
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await row.getByRole("link", { name: "#Beta", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  // WebKit follows macOS's tab-to-links preference; retain keyboard modality
  // while focusing the specific trigger under test.
  await link.focus();
  await expect(link).toBeFocused();
  expect(
    await link.evaluate((element) => element.matches(":focus-visible")),
  ).toBe(true);
  const focusedTrigger = await link.elementHandle();
  app.relay.releaseProfiles();
  await expect(
    row.getByRole("button", {
      name: "View Fixture Reader profile",
      exact: true,
    }),
  ).toBeVisible();
  expect(await focusedTrigger.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  await expect(link).toBeFocused();
  await expect(preview).toBeVisible();
  expect(libraryReads()).toBe(1);
  await link.press("Tab");
  await expect(preview).toBeFocused();
  await preview.press("Enter");
  await expect(
    panel.locator(`[data-message-id="${target.id}"]`),
  ).toBeInViewport();
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"])',
    )
    .click();
  await expect(link).toBeFocused();
  await link.hover();
  await expect(
    preview.getByText("Broadcast reply", { exact: true }),
  ).toBeVisible();
  await expect(preview).toHaveClass(/buzz-preview-card/);
  await expect(preview.getByRole("img")).toHaveClass(/buzz-avatar/);
  await expect(preview).toHaveCSS("font-size", "14px");
  await expect(preview.locator("strong")).not.toBeEmpty();
  await expect(preview.locator("time")).toHaveAttribute(
    "datetime",
    new Date(target.created_at * 1000).toISOString(),
  );
  await expect(preview).toHaveRole("link");
  await expect(preview).toHaveAttribute("href", href);
  // Crossing the trigger-to-card gap must keep the destination clickable.
  await preview.hover();
  await expect(preview).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("buzz-link-preview.png"),
  });
  await preview.click();
  await expect(
    panel.locator(`[data-message-id="${target.id}"]`),
  ).toBeInViewport();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  expect((await state(page)).entry.target.messageId).toBe(target.id);
  await expect(panel.getByText("Thread root 0", { exact: true })).toBeVisible();
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"])',
    )
    .click();
  await expect(panel).toHaveCount(0);
  await button(page, "Go back").click();
  await expect(
    panel.locator(`[data-message-id="${target.id}"]`),
  ).toBeInViewport();
  await button(page, "Go back").click();
  await expect(panel).toHaveCount(0);
  expect(libraryReads()).toBe(1);
  await row.getByRole("link", { name: "#Beta", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  expect((await state(page)).entry.target.channelId).toBe("beta");
});

test("activating a panel from a linked thread retires the navigation-owned thread instead of splitting the rail", async ({
  page,
  app,
}) => {
  await open(page, app);
  const history = app.histories.get("primary/alpha");
  const target = history.find((row) => row.content === "Broadcast reply");
  const href = `buzz://message?channel=alpha&id=${target.id}`;
  const message = app.append("primary", "alpha", `Open <${href}>.`);
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${message.id}"]`,
  );
  const link = row.getByRole("link", { name: "Alpha", exact: true });
  await expect(link).toBeVisible();
  // The append scrolls the timeline to re-pin the bottom. Virtua holds the
  // list's pointer events off for 150ms after each scroll event and the row can
  // still move, so a click issued now can miss its target. Wait for idle first.
  await virtuaIdle(page);
  await link.click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    thread.locator(`[data-message-id="${target.id}"]`),
  ).toBeInViewport();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  // Open a panel while the linked thread is showing. Navigation still owns the
  // thread target, so it must be retired rather than share the rail slot with
  // the newly activated panel. (The fixture registers a catch-all panel.)
  await row
    .getByRole("button", { name: "View Fixture Reader profile", exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "Wrong panel", exact: true }),
  ).toBeVisible();
  await expect(thread).toHaveCount(0);
  // Exactly the sidebar plus one panel: the thread does not survive alongside it.
  await expect(page.getByRole("complementary")).toHaveCount(2);
});

// Retained DOM, scroll geometry, focus, and CSS motion need a real browser.
test("thread and detail tabs preserve drafts, scroll, focus and local-detail lifetime", async ({
  page,
  app,
}) => {
  await open(page, app);
  const target = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Broadcast reply");
  await page.evaluate((target) => window.fixtureNavigation.open(target), {
    version: 1,
    kind: "conversation",
    channelId: "alpha",
    messageId: target.id,
    threadRootId: target.tags.find(
      (tag) => tag[0] === "e" && tag[3] === "root",
    )?.[1],
    scope: { viewer: app.viewer, communityOrigin: "https://primary.example" },
  });
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    thread.locator(`[data-message-id="${target.id}"]`),
  ).toBeInViewport();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  const history = thread.getByRole("region", { name: "Thread messages" });
  const editor = thread.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await editor.fill("Keep this thread draft");
  const trigger = thread
    .getByRole("button", { name: /^View .+ profile$/ })
    .first();
  await trigger.scrollIntoViewIfNeeded();
  const originalHistory = await history.elementHandle();
  const top = await history.evaluate((el) => el.scrollTop);
  await trigger.click();
  const dock = page.locator("[data-panel-dock]");
  const tablist = page.getByRole("tablist", { name: "Panel tabs" });
  const threadTab = tablist.locator('[role="tab"][data-tab-value^="thread:"]');
  const details = tablist.getByRole("tab", {
    name: "Wrong panel",
    exact: true,
  });
  await expect(threadTab).toHaveClass(/navigation-item/);
  await expect(threadTab.locator("svg")).toHaveCount(1);
  await expect(details).toHaveCount(1);
  await expect(details).toBeFocused();
  await expect(thread).toHaveCount(0);
  expect(await originalHistory.evaluate((el) => el.isConnected)).toBe(true);
  const header = dock.locator("header.panel-header");
  expect((await header.boundingBox()).height).toBe(40);
  const profileDraft = page.getByRole("textbox", { name: "Panel draft" });
  await profileDraft.fill("Keep profile state");
  const profileInput = await profileDraft.elementHandle();
  await button(page, "Open child detail").click();
  await expect(details).toHaveCount(2);
  await profileDraft.fill("Keep instance state");
  const instanceInput = await profileDraft.elementHandle();
  await details.nth(0).click();
  await expect(profileDraft).toHaveValue("Keep profile state");
  await button(page, "Open child detail").click();
  await expect(details).toHaveCount(2); // Reopening selects the retained target.
  await expect(profileDraft).toHaveValue("Keep instance state");

  await button(page, "Open local log").click();
  const log = page.getByRole("region", { name: "Fixture log", exact: true });
  const logTab = tablist.getByRole("tab", { name: "Fixture log", exact: true });
  await expect(log).toBeVisible();
  await expect(logTab).toBeFocused();
  await expect(dock.locator("header.panel-header:visible")).toHaveCount(1);
  await details.nth(1).click();
  await expect(profileDraft).toHaveValue("Keep instance state");
  await logTab.click();
  await logTab.press("Escape");
  await expect(log).toHaveCount(0);
  await expect(details.nth(1)).toBeFocused();
  expect(await instanceInput.evaluate((el) => el.isConnected)).toBe(true);
  await threadTab.click();
  await expect(thread).toBeVisible();
  expect(await originalHistory.evaluate((el) => el.scrollTop)).toBe(top);
  await expect(editor).toHaveText("Keep this thread draft");
  expect((await state(page)).entry.target.messageId).toBe(target.id);
  await trigger.press("Enter");
  await expect(details).toHaveCount(2);
  await expect(profileDraft).toHaveValue("Keep profile state");
  expect(await profileInput.evaluate((el) => el.isConnected)).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("retained-panel-tabs.png"),
  });

  for (const width of [800, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await threadTab.click();
    await expect(threadTab).toBeInViewport();
    await details.nth(1).click();
    await expect(details.nth(1)).toBeInViewport();
    expect((await header.boundingBox()).height).toBe(40);
  }
  // A newly opened tab and its close control must reveal themselves in an overflowing strip.
  await button(page, "Open child detail").click();
  await expect(details).toHaveCount(3);
  await expect(details.nth(2)).toBeInViewport();
  await expect(button(page, "Close Wrong panel tab").nth(2)).toBeInViewport();
  // Native horizontal scrolling reaches both ends without changing selection.
  await tablist.hover();
  await page.mouse.wheel(-1000, 0);
  await expect(threadTab).toBeInViewport();
  await page.mouse.wheel(1000, 0);
  await expect(details.nth(2)).toBeInViewport();
  await details.nth(2).press("Delete");
  await button(page, "Close Wrong panel tab").nth(0).click();
  await expect(profileDraft).toHaveValue("Keep instance state");
  // Returning to the same routed thread must restore its profile/detail tabs.
  await openPage(page, "Settings");
  await expect(dock).toHaveCount(0);
  await button(page, "Go back").click();
  await expect(details).toHaveCount(1);
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  await expect(details).toHaveAttribute("aria-selected", "true");
  await expect(threadTab).toHaveCount(1);
  await page.setViewportSize({ width: 1440, height: 900 });
  // Sidebar navigation must preserve the complete set, including the routed thread.
  await page.locator('button[data-channel-id="beta"]').click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await page.locator('button[data-channel-id="alpha"]').click();
  await expect(details).toHaveCount(1);
  await expect(threadTab).toHaveCount(1);
  await expect(details).toHaveAttribute("aria-selected", "true");
  await details.press("Delete");
  await expect(threadTab).toBeFocused();
  await expect(editor).toHaveText("Keep this thread draft");
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"])',
    )
    .click();
  await expect(dock).toHaveCount(0);
});

test("a mixed-case Buzz scheme activates in-app instead of falling through to an external tab", async ({
  page,
  app,
}) => {
  await open(page, app);
  // parseBuzzLink normalizes the scheme via URL, so a BUZZ:// link is a valid
  // internal destination; activation must classify it the same way rather than
  // treating it as an external _blank link.
  const message = app.append(
    "primary",
    "alpha",
    "Jump to <BUZZ://channel/beta>.",
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${message.id}"]`,
  );
  const link = row.getByRole("link", { name: "#Beta", exact: true });
  await expect(link).toBeVisible();
  // Same post-append click as above: wait out Virtua's re-pin first.
  await virtuaIdle(page);
  await link.click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  expect((await state(page)).entry.target.channelId).toBe("beta");
});

test("unavailable messages fail honestly and legacy links still open when Links is disabled", async ({
  page,
  app,
}) => {
  await open(page, app);
  const target = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Thread root 0");
  const href = `buzz://message?channel=alpha&id=${target.id}&thread=${"f".repeat(64)}`;
  const message = app.append(
    "primary",
    "alpha",
    `<${href}> <buzz://message?channel=alpha&id=${"0".repeat(64)}>`,
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${message.id}"]`,
  );
  await expect(
    row.getByRole("link", { name: "Alpha", exact: true }).first(),
  ).toBeVisible();
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await button(page, "Plugins").click();
  await page
    .getByRole("switch", { name: "Enable Links", exact: true })
    .uncheck();
  await openPage(page, "Messages");
  await row.locator("a").first().click();
  const targetRow = page.locator(`[data-message-id="${target.id}"]`);
  await expect(targetRow).toBeFocused();
  await expect(targetRow).toBeInViewport();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  // The deliberately wrong hint must not select a different root or force a
  // visible root out of the ordinary timeline.
  // Revealing the prior target can still reposition the timeline. Activate the
  // unavailable link by keyboard so this routing check does not click a moving row.
  const unavailable = row.locator("a").nth(1);
  await unavailable.focus();
  await expect(unavailable).toBeFocused();
  await unavailable.press("Enter");
  await expect
    .poll(async () => (await state(page)).entry.target.messageId)
    .toBe("0".repeat(64));
  await expect(button(page, "Retry navigation")).toBeVisible();
  expect((await state(page)).status).toBe("failed");
});

test.describe("links to channels the reader hasn't joined", () => {
  test.use({ openSearch: true });
  test("name an open channel with a hover card and lock a withheld one", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const secret = "5ec2e700-0000-4000-8000-000000000001";
    const message = app.append(
      "primary",
      "alpha",
      `See <buzz://channel/${app.openChannelId}>, <buzz://channel/${secret}> and [#launch-plans](buzz://channel/${secret}).`,
    );
    const row = page.locator(
      `[data-channel-timeline] [data-message-id="${message.id}"]`,
    );
    const named = row.getByRole("link", { name: "#open", exact: true });
    await expect(named).toBeVisible();
    const locked = row.getByRole("link", {
      name: "Private channel",
      exact: true,
    });
    await expect(locked).toHaveAttribute("title", /aren’t a member/);
    // The authored label is message text; it stays beside the lock.
    const authored = row.getByRole("link", {
      name: "#launch-plans",
      exact: true,
    });
    await expect(authored).toHaveAttribute("title", /aren’t a member/);
    await virtuaIdle(page);
    await named.hover();
    const card = page.getByLabel("Channel preview", { exact: true });
    await expect(card).toContainText("Public channel · Not joined");
  });
});
