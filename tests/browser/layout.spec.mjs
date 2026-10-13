import { openChannelDetails } from "./channel-details.mjs";
import {
  openPage,
  pageChoices,
  selectPage,
  selectSettingsSection,
  settleShellToggle,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

import { finalizeEvent, generateSecretKey } from "nostr-tools";
import {
  wheel,
  anchor,
  settle,
  upper,
  expectAnchor,
  keyScroll,
} from "./timeline.mjs";

// These layout/navigation journeys exercise the opt-in Bestie surface.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const key = "buzzodz.plugins.v1";
    if (localStorage.getItem(key) === null)
      localStorage.setItem(
        key,
        JSON.stringify({ version: 2, enabled: { "buzz.bestie": true } }),
      );
  });
});

const scroll = test.extend({ historyCounts: { alpha: 20, beta: 1 } });
const companionTest = test.extend({ companionFixture: true });
// Resize tests must not enter the fixture’s deliberately held paging path.
const readingTest = test.extend({
  tallMessages: true,
  // Keep the old restored row visible when wheel input selects another row.
  historyCounts: { alpha: 24, beta: 1 },
});
async function expectNonPaging(page, app) {
  expect(
    await page
      .getByRole("region", { name: "Channel message history" })
      .evaluate((el) => el.scrollTop - Math.max(3000, el.clientHeight * 4)),
    "resize reading position stays outside older-page prefetch",
  ).toBeGreaterThan(0);
  expect(
    app.report.queries.filter(({ filter }) => filter.until !== undefined),
  ).toHaveLength(0);
}

const button = (page, name) => page.getByRole("button", { name, exact: true });
const companionLauncher = (page, name) =>
  button(page, name).and(page.locator("button[aria-expanded]"));
// The fixture's active plugin pages, in shell order, lead the channel sidebar.
// Sidebar rows exclude header pages; Me and Messages remain available through search.
const destinationTitles = [
  "Inbox",
  "Reminders",
  "Bestie",
  "Projects",
  "Agents",
  "Workflows",
];
const sidebarDestinations = (page, options = {}) =>
  page
    .getByRole("complementary", { name: "Channel sidebar", ...options })
    .getByRole("navigation", { name: "Pages", ...options })
    .getByRole("button", options);
const companionReadingTest = readingTest.extend({ companionFixture: true });
const box = async (locator) => {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds;
};
const near = (a, b) => expect(Math.abs(a - b)).toBeLessThan(2);
const panel = (page) =>
  page.getByRole("complementary", { name: "GitHub", exact: true });

async function open(page, app) {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .waitFor();
  await expect(page.locator("[data-message-id]").first()).toBeVisible();
}
async function link(page, app, target) {
  await page.route(
    /https:\/\/api\.github\.com\/repos\/block\/buzz\/(?:issues\/\d+\/comments|pulls\/\d+\/reviews)\?/,
    (route) => route.fulfill({ json: [] }),
  );
  await page.route("https://api.github.com/repos/block/buzz/pulls/*", (route) =>
    route.fulfill({
      json: {
        title: "A useful change",
        state: "open",
        user: { login: "Fixture Reader" },
        body: "Public fixture content.\n".repeat(100),
      },
    }),
  );
  // A return from a compose route can still be restoring the timeline.
  await settle(page);
  app.append("primary", "alpha", `Please review ${target}`);
  const trigger = page.getByRole("link", { name: target, exact: true });
  await expect(trigger).toBeVisible();
  await settle(page);
  await trigger.scrollIntoViewIfNeeded();
  // Appending and bringing an offscreen link into view can both scroll Virtua.
  // These are panel-layout checks, not clicks during an in-flight correction.
  await settle(page);
  await expect(
    page.getByRole("region", { name: "Channel message history" }).locator("ol"),
  ).toHaveCSS("pointer-events", "auto");
  await trigger.click();
  await expect(
    panel(page).getByRole("heading", {
      name: `A useful change #${new URL(target).pathname.split("/").at(-1)}`,
    }),
  ).toBeVisible();
  // Geometry assertions observe the settled overlay, not an entrance frame.
  await panel(page).evaluate(async (element) => {
    await Promise.allSettled(
      element
        .closest("[data-panel-dock]")
        .getAnimations()
        .map((animation) => animation.finished),
    );
  });
}
async function shellFits(page, width) {
  // The Projects page renders no toggle at wide widths, so settle only when
  // the drawer is in play.
  if (width <= 650) await settleShellToggle(page);
  const disclosure = button(page, "Show navigation");
  const collapsed = await disclosure.isVisible();
  if (collapsed) await disclosure.click();
  const inSettings = await page
    .getByRole("region", { name: "Settings", exact: true })
    .isVisible();
  const destinations = inSettings
    ? page
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button")
    : sidebarDestinations(page);
  if (inSettings) await expect(destinations.first()).toBeVisible();
  else await expect(destinations).toHaveText(destinationTitles);
  const sidebar = await box(
    page.getByRole("complementary", {
      name: inSettings ? "Settings sidebar" : "Channel sidebar",
    }),
  );
  const first = await box(destinations.first());
  const last = await box(destinations.last());
  for (const destination of [first, last]) {
    expect(destination.x).toBeGreaterThanOrEqual(sidebar.x);
    expect(destination.x + destination.width).toBeLessThanOrEqual(
      sidebar.x + sidebar.width,
    );
  }
  const channels = page.getByRole("navigation", {
    name: "Subscribed channels",
  });
  const section = channels.locator("[data-sidebar-section]").first();
  if (await section.count()) {
    // Primary destinations lead the roster rather than overlapping its sections.
    expect(last.y + last.height).toBeLessThanOrEqual((await box(section)).y);
    expect((await box(channels)).height).toBeGreaterThan(40);
  }
  // At short heights destinations scroll with the roster and remain reachable.
  await destinations.last().scrollIntoViewIfNeeded();
  await expect(destinations.last()).toBeInViewport();
  if (await channels.count())
    await channels.evaluate((element) => {
      element.scrollTop = 0;
    });
  // The header keeps its launchers; sidebar destinations are not duplicated
  // there. Bestie's header button is its companion launcher, not a page row.
  await expect(
    page.locator(".shell-header").getByRole("button", {
      name: new RegExp(
        `^(${destinationTitles.filter((title) => title !== "Bestie").join("|")})$`,
      ),
      includeHidden: true,
    }),
  ).toHaveCount(0);
  const actions = await box(page.locator(".shell-actions"));
  const communities = await box(
    page.getByRole("navigation", { name: "Communities", exact: true }),
  );
  expect(actions.x + actions.width).toBeLessThanOrEqual(width);
  expect(communities.x + communities.width).toBeLessThan(actions.x);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBe(width);
  if (width > 700) {
    // The compact rail meets the sidebar edge without overlapping it.
    expect(communities.x + communities.width).toBeLessThanOrEqual(sidebar.x);
  }
  if (collapsed) await button(page, "Hide navigation").click();
}

scroll(
  "page overscroll is disabled while message history still scrolls",
  async ({ page, app }) => {
    await open(page, app);
    // Headless wheel input does not reproduce macOS trackpad rubber-banding.
    // Check the viewport policy as well as real panel scrolling and shell bounds.
    await expect(page.locator("html")).toHaveCSS("overscroll-behavior", "none");
    const shell = page.locator(".shell-background");
    const bounds = await box(shell);
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    await settle(page);
    const initialOffset = await history.evaluate((el) => el.scrollTop);
    await history.hover();
    await wheel(page, -300);
    await expect
      .poll(() => history.evaluate((el) => el.scrollTop))
      .toBeLessThan(initialOffset - 100);
    await settle(page);
    expect(await box(shell)).toEqual(bounds);

    // Projects has no overflowing content: gestures must leave the shell in place.
    await openPage(page, "Projects");
    await page.getByRole("heading", { name: "Projects", exact: true }).hover();
    for (const [x, y] of [
      [0, -600],
      [0, 600],
      [-600, 0],
      [600, 0],
    ]) {
      await page.mouse.wheel(x, y);
      await page.evaluate(() => new Promise(requestAnimationFrame));
      expect(await box(shell)).toEqual(bounds);
      expect(
        await page.evaluate(() => [window.scrollX, window.scrollY]),
      ).toEqual([0, 0]);
    }
  },
);

test("joined surface, sidebar pages, real link panel and compact community navigation", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 832 });
  await open(page, app);
  await shellFits(page, 1280);
  const sidebar = await box(
    page.getByRole("complementary", { name: "Channel sidebar" }),
  );
  const conversation = page.getByRole("article", {
    name: "Conversation",
    exact: true,
  });
  // Real CSS geometry is the contract: one outer surface, flush inner regions.
  await expect(page.locator(".shell-body > [data-joined]")).toHaveCSS(
    "border-top-width",
    "1px",
  );
  await expect(conversation).toHaveCSS("border-radius", "0px");
  await expect(conversation).toHaveCSS("border-top-width", "0px");
  await expect(conversation).toHaveCSS("box-shadow", "none");
  const before = await box(conversation);
  const rail = await box(
    page.getByRole("navigation", { name: "Communities", exact: true }),
  );
  near(rail.width, 48);
  near(sidebar.x, rail.x + rail.width);
  near(before.x - sidebar.x - sidebar.width, 1);
  near(before.y, 49);
  near(before.height, 766);
  const background = await page
    .locator(".shell-background")
    .evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(background).toContain("radial-gradient");
  // The full-bleed backdrop is now the shared gradient rather than a bitmap.
  const gradient = await page.locator(".shell-background").evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.backgroundImage = "var(--bg-app)";
    el.append(probe);
    const value = getComputedStyle(probe).backgroundImage;
    probe.remove();
    return value;
  });
  expect(background).toBe(gradient);
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await composer.fill("Layout draft");
  await page.screenshot({ path: testInfo.outputPath("joined-no-panel.png") });
  await link(page, app, "https://github.com/block/buzz/pull/1");
  const main = await box(conversation);
  const dock = await box(page.locator("[data-panel-workspace]"));
  near(dock.y, main.y);
  near(dock.height, main.height);
  near(dock.x - main.x - main.width, 1);
  near(dock.x + dock.width, 1264);
  await expect(composer).toHaveJSProperty("value", "Layout draft");
  await expect(composer).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("joined-one-panel.png") });
  const timeline = page.getByRole("region", {
    name: "Channel message history",
  });
  const offset = await timeline.evaluate((el) => el.scrollTop);
  // This scroll-ownership journey needs overflowing content; descriptions now
  // start collapsed, so open the real disclosure before sending wheel input.
  const description = panel(page).getByRole("button", {
    name: "Expand Description",
    exact: true,
  });
  await description.click();
  await expect(description).toHaveAttribute("aria-expanded", "true");
  await panel(page)
    .getByRole("heading", { name: "A useful change #1" })
    .hover();
  await page.mouse.wheel(0, 1000);
  await expect
    .poll(() =>
      panel(page)
        .locator("[class*='root']")
        .evaluate((el) => el.scrollTop),
    )
    .toBeGreaterThan(100);
  near(await timeline.evaluate((el) => el.scrollTop), offset);
  await page
    .locator(
      '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
    )
    .click();
  await expect(panel(page)).toHaveCount(0);
  // Inert content leaves the accessibility tree before its visual exit finishes.
  await expect(page.locator("[data-panel-dock]")).toHaveCount(0);
  near((await box(conversation)).width, before.width);
  await link(page, app, "https://github.com/block/buzz/pull/2");
  await button(page, "Beta").click();
  await expect(panel(page)).toHaveCount(0);
  await button(page, "Alpha").click();
  await expect(composer).toHaveJSProperty("value", "Layout draft");
  const railButtons = page.getByRole("navigation", {
    name: "Communities",
    exact: true,
  });
  await expect(
    railButtons.getByRole("button", { name: "Personal space" }),
  ).toBeVisible();
  const add = railButtons.getByRole("button", { name: "Add a community" });
  await add.click();
  await expect(
    page.getByRole("heading", { name: "Add a community", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(add).toBeFocused();
  await railButtons
    .getByRole("button", { name: "Switch to Secondary" })
    .click();
  await expect(composer).toHaveJSProperty("value", "");
  await railButtons.getByRole("button", { name: "Switch to Primary" }).click();
  await expect(composer).toHaveJSProperty("value", "Layout draft");
  for (const [width, height] of [
    [1200, 800],
    [800, 600],
    [480, 400],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await shellFits(page, width);
    await expect(composer).toBeInViewport();
    await button(page, "Your profile").click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Settings", exact: true }),
    ).toBeVisible();
    if (width <= 650) await button(page, "Show navigation").click();
    await openPage(page, "Messages");
    await expect(composer).toHaveJSProperty("value", "Layout draft");
    await expect(page.locator("[data-message-id]").last()).toBeInViewport();
  }
  await expect(panel(page)).toBeVisible();
  await page
    .locator(
      '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
    )
    .click();
  await expect(panel(page)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("bento-narrow.png") });
  await link(page, app, "https://github.com/block/buzz/pull/3");
  await expect(
    page.locator(
      '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
    ),
  ).toBeInViewport();
  const narrow = await box(page.locator("[data-panel-workspace]"));
  const narrowConversation = await box(conversation);
  near(narrow.x, narrowConversation.x);
  near(narrow.width, narrowConversation.width);
  await page
    .locator(
      '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
    )
    .click();
  await expect(composer).toBeInViewport();
  await openPage(page, "Projects");
  // Search selection and the sidebar share page state, so Projects is current.
  // Projects moves focus to its heading once the directory opens.
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeFocused();
  const hiddenDestinations = sidebarDestinations(page, { includeHidden: true });
  await expect(hiddenDestinations).toHaveText(destinationTitles);
  await expect(
    hiddenDestinations.and(page.locator("[aria-current]")),
  ).toHaveText(["Projects"]);
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Display name", exact: true }),
  ).toHaveValue("Fixture Reader");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await selectSettingsSection(page, "Plugins");
  // Channels has no off switch; use another page to exercise UI activation.
  const projects = page.getByRole("switch", {
    name: "Enable Projects",
    exact: true,
  });
  const search = page.getByRole("dialog", { name: "Search Buzz", exact: true });
  const expectProjectsChoice = async (count) => {
    const choices = await pageChoices(page);
    // Messages proves the Pages group rendered before counting Projects.
    await expect(
      choices.getByRole("option", { name: "Messages", exact: true }),
    ).toBeVisible();
    await expect(
      choices.getByRole("option", { name: "Projects", exact: true }),
    ).toHaveCount(count);
    await page.keyboard.press("Escape");
    await expect(search).toHaveCount(0);
  };
  await projects.click();
  await expect(projects).toHaveAttribute("aria-checked", "false");
  await expectProjectsChoice(0);
  await projects.click();
  await expect(projects).toHaveAttribute("aria-checked", "true");
  await expectProjectsChoice(1);
});

test("narrow link panels begin after the rendered sidebar", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1280, height: 832 });
  await open(page, app);
  await page
    .getByRole("separator", { name: "Resize channel sidebar" })
    .press("End");
  await page.setViewportSize({ width: 800, height: 600 });
  await link(page, app, "https://github.com/block/buzz/pull/7");

  const sidebar = await box(
    page.getByRole("complementary", { name: "Channel sidebar" }),
  );
  const conversation = await box(
    page.getByRole("article", { name: "Conversation", exact: true }),
  );
  const dock = await box(page.locator("[data-panel-workspace]"));
  near(conversation.x - sidebar.x - sidebar.width, 1);
  near(dock.x, conversation.x);
  expect(dock.x).toBeGreaterThanOrEqual(sidebar.x + sidebar.width);
  // Separate stacking contexts: assert actual hit testing, not unrelated z-index numbers.
  const close = page.locator(
    '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
  );
  expect(
    await close.evaluate((element) => {
      const r = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
      );
    }),
  ).toBe(true);
  await close.click();
  await expect(panel(page)).toHaveCount(0);
});

test("composer stays docked while a cold channel loads", async ({
  page,
  app,
}) => {
  // Hold Beta's head read so its loading placeholder stays rendered.
  const beta = Promise.withResolvers();
  await page.route("**/query", async (route) => {
    const filters = route.request().postDataJSON() ?? [];
    if (filters.some((filter) => filter["#h"]?.includes("beta")))
      await beta.promise;
    await route.fallback();
  });
  const composer = (name) =>
    page.getByRole("textbox", { name: `Message #${name}`, exact: true });
  let docked;
  try {
    await open(page, app);
    docked = await box(composer("Alpha"));
    await button(page, "Beta").click();
    await expect(
      page.getByRole("status").filter({ hasText: "Loading messages…" }),
    ).toBeVisible();
    near((await box(composer("Beta"))).y, docked.y);
  } finally {
    beta.resolve();
  }
  await expect(
    page.locator('[data-channel-timeline="beta"] [data-message-id]').first(),
  ).toBeVisible();
  near((await box(composer("Beta"))).y, docked.y);
});

// Virtua expires an imperative scroll 150ms after its last size update and
// restores the list's pointer events 150ms after the last scroll event. That
// observable state plus settled geometry replaces a fake clock, which would
// also reorder requestAnimationFrame against the rendering update.
async function virtuaIdle(page) {
  await expect(
    page.getByRole("region", { name: "Channel message history" }).locator("ol"),
  ).toHaveCSS("pointer-events", "auto");
  await settle(page);
}

readingTest(
  "panel resizing preserves bottom follow and the visible reading anchor",
  async ({ page, app }) => {
    await open(page, app);
    await settle(page);
    await link(page, app, "https://github.com/block/buzz/pull/4");
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    const expectBottom = () =>
      expect
        .poll(() =>
          history.evaluate(
            (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
          ),
        )
        .toBeLessThan(4);
    await settle(page);
    await expectBottom();
    const received = app.append("primary", "alpha");
    await expect(
      page.locator(`[data-message-id="${received.id}"]`),
    ).toBeInViewport();
    await page
      .locator(
        '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
      )
      .click();
    await expect(page.locator("[data-panel-dock][data-closing]")).toHaveCount(
      0,
    );
    await settle(page);
    await expectBottom();
    // Late layout-only reflow must not need another message or viewport resize.
    // Let Virtua's imperative-scroll scheduler expire first. Change actual
    // row layout, not scroll methods/metrics or the production observer callback.
    // Timer expiry can commit another virtualized range; native resize/scroll
    // delivery must finish before the separate late-layout change begins.
    await virtuaIdle(page);
    await expectBottom();
    const lateLayout = await page.addStyleTag({
      content: `[data-message-id="${received.id}"] p { padding-bottom: 120px; }`,
    });
    await settle(page);
    await expectBottom();
    await virtuaIdle(page);
    await expectBottom();
    await lateLayout.evaluate((element) => element.remove());
    await settle(page);
    await expectBottom();
    // Reopen by keyboard without browser click-to-scroll changing the saved position.
    const target = "https://github.com/block/buzz/pull/4";
    // Keep the offscreen opener within the virtualizer's mounted buffer after
    // focus moves to the panel; this tests restoration to a mounted trigger.
    await history.hover();
    await wheel(page, -200);
    const saved = await anchor(page);
    await expectNonPaging(page, app);
    await page
      .getByRole("link", { name: target, exact: true })
      .evaluate((el) => el.focus({ preventScroll: true }));
    await page.keyboard.press("Enter");
    await expect(panel(page)).toBeVisible();
    await settle(page);
    await expectAnchor(page, saved);
    // A panel can return focus to a mounted but offscreen link. Observe the
    // native focus call itself: eventual anchor recovery can hide a scroll jump.
    await page
      .getByRole("link", { name: target, exact: true })
      .evaluate((el) => {
        const focus = el.focus;
        el.focus = function (options) {
          const history = el.closest("[data-channel-timeline]");
          const before = history.scrollTop;
          focus.call(this, options);
          window.panelFocusScrollDelta = history.scrollTop - before;
        };
      });
    await page
      .locator(
        '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
      )
      .focus();
    await expect(
      page.getByRole("link", { name: target, exact: true }),
    ).not.toBeInViewport();
    await page
      .locator(
        '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
      )
      .click();
    const trigger = page.getByRole("link", { name: target, exact: true });
    await settle(page);
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => window.panelFocusScrollDelta)).toBe(0);
    await expectAnchor(page, saved);
    // Reflow can arrive after Virtua's 150ms imperative-scroll scheduler ends.
    // Keep the selected reading anchor, not the partially clipped row above it.
    await virtuaIdle(page);
    const preceding = await history.evaluate((element, id) => {
      const rows = [...element.querySelectorAll("[data-message-id]")];
      const index = rows.findIndex((row) => row.dataset.messageId === id);
      return rows[index - 1]?.dataset.messageId;
    }, saved.id);
    expect(preceding).toBeTruthy();
    const delayedReflow = await page.addStyleTag({
      content: `[data-message-id="${preceding}"] p { padding-bottom: 52px; }`,
    });
    await settle(page);
    await expectAnchor(page, saved);
    await delayedReflow.evaluate((element) => element.remove());
    await settle(page);
    await expectAnchor(page, saved);
    await page.setViewportSize({ width: 1200, height: 700 });
    await settle(page);
    await expectAnchor(page, saved);
    await expectNonPaging(page, app);
  },
);

readingTest(
  "a focused message stays mounted until focus leaves the timeline",
  async ({ page, app }) => {
    await open(page, app);
    await settle(page);
    const target = "https://example.com/focused-message";
    const previous = await page
      .locator("[data-message-id]")
      .last()
      .getAttribute("data-message-id");
    const message = app.append("primary", "alpha", `Keep focus on ${target}`);
    const trigger = page.getByRole("link", { name: target, exact: true });
    await expect(trigger).toBeInViewport();
    await settle(page);
    await trigger.evaluate((el) => el.focus({ preventScroll: true }));
    await expect(trigger).toBeFocused();
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    await history.hover();
    await page.mouse.wheel(0, -3500);
    // The adjacent unpinned row proves that real virtualization has evicted this
    // range; a timeout or a mocked virtualizer would not establish that boundary.
    await expect(page.locator(`[data-message-id="${previous}"]`)).toHaveCount(
      0,
    );
    await settle(page);
    await expect(trigger).toBeFocused();
    await expect(trigger).not.toBeInViewport();
    await history.evaluate((el) => el.focus({ preventScroll: true }));
    await expect(history).toBeFocused();
    await expect(page.locator(`[data-message-id="${message.id}"]`)).toHaveCount(
      0,
    );
  },
);

companionTest(
  "A plugin owns the launcher and the reusable companion card across pages and disable",
  async ({ page, app }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 832 });
    await page.goto(app.origin);
    const companion = page.getByRole("complementary", {
      name: "Companion fixture",
      exact: true,
    });
    const launch = companionLauncher(page, "Companion fixture");
    await expect(launch).toBeVisible();
    await expect(companion).toHaveCount(0);
    await launch.click();
    await expect(companion).toBeVisible();
    await expect(companion).toContainText("Companion fixture content");
    await expect(launch).toHaveAttribute("aria-expanded", "true");
    await launch.click();
    await expect(companion).toHaveCount(0);
    await expect(launch).toHaveAttribute("aria-expanded", "false");
    await expect(launch).toBeFocused();
    await launch.click();
    await button(page, "Close Companion fixture panel").click();
    await expect(launch).toBeFocused();
    await launch.click();
    await button(page, "Your profile").click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await selectSettingsSection(page, "Plugins");
    await expect(companion).toHaveCount(1);
    const enabled = page.getByRole("switch", {
      name: "Enable Companion fixture",
      exact: true,
    });
    await enabled.click();
    await expect(launch).toHaveCount(0);
    await expect(companion).toHaveCount(0);
    await expect(enabled).toBeFocused();
    // The closing dock is already aria-hidden, but still narrows Settings.
    // Wait for its removal before the next click can race the layout expansion.
    await expect(page.locator("[data-panel-dock]")).toHaveCount(0);
    await enabled.click();
    await expect(launch).toBeVisible();
    await expect(companion).toHaveCount(0);
    await launch.click();
    await openPage(page, "Messages");
    const composer = page.getByRole("textbox", {
      name: "Message #Alpha",
      exact: true,
    });
    await expect(composer).toBeVisible();
    await composer.fill("Companion draft");
    const conversation = page.getByRole("article", {
      name: "Conversation",
      exact: true,
    });
    near((await box(companion)).height, (await box(conversation)).height);
    await link(page, app, "https://github.com/block/buzz/pull/5");
    const top = await box(page.locator("[data-panel-workspace]")),
      bottom = await box(companion),
      main = await box(conversation);
    near(top.height, bottom.height);
    near(top.y, main.y);
    near(bottom.y - top.y - top.height, 1);
    near(bottom.y + bottom.height, main.y + main.height);
    near(top.x, bottom.x);
    await page.screenshot({
      path: testInfo.outputPath("companion-two-panels.png"),
    });
    // Simulate a management update observed while Messages remains mounted.
    await page.evaluate(() => {
      const key = "buzzodz.plugins.v1";
      const settings = JSON.parse(localStorage.getItem(key));
      settings.enabled["fixture.companion"] = false;
      localStorage.setItem(key, JSON.stringify(settings));
    });
    await expect(launch).toHaveCount(0);
    await expect(companion).toHaveCount(0);
    await expect(panel(page)).toHaveCount(1);
    near(
      (await box(page.locator("[data-panel-workspace]"))).height,
      (await box(conversation)).height,
    );
    await page.evaluate(() => {
      const key = "buzzodz.plugins.v1";
      const settings = JSON.parse(localStorage.getItem(key));
      settings.enabled["fixture.companion"] = true;
      localStorage.setItem(key, JSON.stringify(settings));
    });
    await expect(launch).toBeVisible();
    await expect(companion).toHaveCount(0);
    await launch.click();
    await expect(composer).toHaveJSProperty("value", "Companion draft");
    await button(page, "Close Companion fixture panel").click();
    near(
      (await box(page.locator("[data-panel-workspace]"))).height,
      (await box(conversation)).height,
    );
    await launch.click();
    await page
      .locator(
        '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
      )
      .click();
    near((await box(companion)).height, (await box(conversation)).height);
    await button(page, "Beta").click();
    await expect(companion).toHaveCount(1);
    await button(page, "Alpha").click();
    await expect(composer).toHaveJSProperty("value", "Companion draft");
    await button(page, "Personal space").click();
    await expect(
      page.getByRole("heading", { name: "Your channels, one conversation." }),
    ).toBeVisible();
    await expect(companion).toHaveCount(1);
    await button(page, "Close Companion fixture panel").click();
    await launch.click();
    await expect(companion).toHaveCount(1);
    await button(page, "Your profile").click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await selectSettingsSection(page, "Plugins");
    await expect(companion).toHaveCount(1);
    for (const [width, height] of [
      [800, 600],
      [480, 400],
      [390, 844],
      [390, 400],
    ]) {
      await page.setViewportSize({ width, height });
      await shellFits(page, width);
      await expect(
        button(page, "Close Companion fixture panel"),
      ).toBeInViewport();
    }
    await button(page, "Close Companion fixture panel").click();
    await expect(companion).toHaveCount(0);
    await expect(launch).toHaveAttribute("aria-expanded", "false");
    await expect(launch).toBeFocused();

    // Plugin catalogs can outgrow the viewport. Closing restores the launcher,
    // not a Settings row: reach the toggle with real input, not scrollIntoView.
    // Settings details own scrolling independently of the sidebar.
    const settingsPage = page
      .getByRole("region", { name: "Settings", exact: true })
      .locator(":scope > div");
    await expect(enabled).not.toBeInViewport();
    const viewport = await box(settingsPage);
    await page.mouse.move(
      viewport.x + viewport.width / 2,
      viewport.y + viewport.height / 2,
    );
    const visibleTop = Math.max(viewport.y, 0);
    const visibleBottom = Math.min(viewport.y + viewport.height, 400);
    for (let gesture = 0; gesture < 30; gesture++) {
      const toggle = await box(enabled);
      if (
        toggle.y >= visibleTop + 8 &&
        toggle.y + toggle.height <= visibleBottom - 8
      )
        break;
      const distance =
        toggle.y < visibleTop + 8
          ? toggle.y - visibleTop - 8
          : toggle.y + toggle.height - visibleBottom + 8;
      const before = await settingsPage.evaluate((el) => el.scrollTop);
      await wheel(
        page,
        Math.sign(distance) * Math.max(Math.abs(distance), 24),
        settingsPage,
      );
      await expect
        .poll(() => settingsPage.evaluate((el) => el.scrollTop), {
          message:
            "Settings wheel input makes progress toward the plugin toggle",
        })
        .toBeGreaterThan(before);
    }
    await expect(enabled).toBeInViewport({ ratio: 1 });
    await enabled.click();
    await expect(enabled).toHaveAttribute("aria-checked", "false");
    await expect(enabled).toBeFocused();
    await expect(launch).toHaveCount(0);
  },
);

const todosOverlapTest = companionTest.extend({
  threadUnread: true,
  readState: true,
  historyCounts: { alpha: 3, beta: 1 },
});
todosOverlapTest(
  "Todos stacks beside threads and linked panels in either opening order",
  async ({ page, app }) => {
    await page.setViewportSize({ width: 1440, height: 950 });
    await open(page, app);
    await button(page, "Your profile").click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await selectSettingsSection(page, "Plugins");
    await page
      .getByRole("switch", { name: "Enable Todos", exact: true })
      .click();
    await openPage(page, "Messages");
    const todos = page.getByRole("region", {
      name: "Todos panel",
      exact: true,
    });
    const toggle = button(page, "Toggle channel todos");
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const linked = panel(page);
    const settings = page.getByRole("complementary", {
      name: "Channel settings",
      exact: true,
    });
    const companion = page.getByRole("complementary", {
      name: "Companion fixture",
      exact: true,
    });
    const stacked = async (primary) => {
      await expect(primary).toBeVisible();
      await expect(todos).toBeVisible();
      near((await box(todos.locator("header.panel-header"))).height, 40);
      const top = await box(primary);
      const bottom = await box(todos);
      near(top.x, bottom.x);
      near(top.width, bottom.width);
      near(bottom.y - top.y - top.height, 1);
      const conversation = await box(
        page.getByRole("article", {
          name: "Conversation",
          exact: true,
        }),
      );
      near(bottom.y + bottom.height, conversation.y + conversation.height);
    };
    const openThread = async () => {
      const root = app.histories
        .get("primary/alpha")
        .find((event) => event.content === "Thread root 0");
      await page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ })
        .click();
      await expect(thread).toBeVisible();
      await expect(thread).toHaveCSS("border-radius", "0px");
      await expect(thread).toHaveCSS("border-width", "0px");
      await expect(thread).toHaveCSS("box-shadow", "none");
      const threadHeader = await box(
        page.locator("[data-panel-dock] header.panel-header").first(),
      );
      const channelHeader = await box(
        page
          .getByRole("article", { name: "Conversation", exact: true })
          .locator("header.panel-header"),
      );
      near(threadHeader.height, channelHeader.height);
      near(threadHeader.y, channelHeader.y);
    };

    await toggle.click();
    await openThread();
    await stacked(thread);
    await page
      .locator(
        '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"])',
      )
      .click();
    await button(page, "Hide todos").click();
    await openThread();
    await toggle.click();
    await stacked(thread);
    await page
      .locator(
        '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"])',
      )
      .click();

    await link(page, app, "https://github.com/block/buzz/pull/6");
    await stacked(linked);
    await page
      .locator(
        '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
      )
      .click();
    await button(page, "Hide todos").click();
    await link(page, app, "https://github.com/block/buzz/pull/7");
    await toggle.click();
    await stacked(linked);
    await openChannelDetails(page);
    await expect(settings).toBeVisible();
    await expect(todos).toHaveCount(0); // Settings intentionally retires the drawer.
    await button(page, "Close Channel settings tab").click();
    await expect(linked).toBeVisible();
    await companionLauncher(page, "Companion fixture").click();
    await expect(companion).toBeVisible();
    await expect(linked).toBeVisible();
    near(
      (await box(companion)).y -
        (await box(linked)).y -
        (await box(linked)).height,
      1,
    );
    await button(page, "Close Companion fixture panel").click();
  },
);

companionReadingTest(
  "companion resize preserves the timeline anchor and both cards at narrow sizes",
  async ({ page, app }) => {
    await open(page, app);
    await settle(page);
    const saved = await upper(page);
    await expectNonPaging(page, app);
    await companionLauncher(page, "Companion fixture").click();
    await settle(page);
    await expectAnchor(page, saved);
    await button(page, "Close Companion fixture panel").click();
    await settle(page);
    await expectAnchor(page, saved);
    await link(page, app, "https://github.com/block/buzz/pull/6");
    await companionLauncher(page, "Companion fixture").click();
    for (const [width, height] of [
      [1440, 950],
      [800, 600],
      [480, 400],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      const top = await box(page.locator("[data-panel-workspace]"));
      const bottom = await box(
        page.getByRole("complementary", {
          name: "Companion fixture",
          exact: true,
        }),
      );
      near(top.height, bottom.height);
      near(bottom.y - top.y - top.height, 1);
      await expect(
        page.locator(
          '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
        ),
      ).toBeInViewport();
      await expect(
        button(page, "Close Companion fixture panel"),
      ).toBeInViewport();
      await openChannelDetails(page, { programmatic: true });
      const settings = page.getByRole("complementary", {
        name: "Channel settings",
        exact: true,
      });
      await expect(settings).toBeVisible();
      const covered = await box(page.locator("[data-panel-workspace]"));
      const retainedCompanion = await box(
        page.getByRole("complementary", {
          name: "Companion fixture",
          exact: true,
        }),
      );
      near(covered.height, top.height);
      near(retainedCompanion.height, bottom.height);
      near(retainedCompanion.y, bottom.y);
      await button(page, "Close Channel settings tab").click();
      await expect(
        page.locator(
          '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
        ),
      ).toBeInViewport();
    }
  },
);

companionReadingTest(
  "panel restoration yields to a new wheel reading position",
  async ({ page, app }) => {
    await open(page, app);
    await settle(page);
    const original = await upper(page);
    await companionLauncher(page, "Companion fixture").click();
    await settle(page);
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    await history.hover();
    // A tall row above the anchor can exceed one wheel step, and a tall
    // paragraph need not fit wholly in the narrowed viewport. Keep making real
    // progress until the visible reading row (including the production
    // clipped-row fallback) belongs to another message; never repeat a read
    // until an immobile timeline happens to pass.
    let reading = original;
    for (
      let gesture = 0;
      gesture < 6 && reading.id === original.id;
      gesture++
    ) {
      const before = await history.evaluate((el) => el.scrollTop);
      await wheel(page, -300);
      await expect
        .poll(() => history.evaluate((el) => el.scrollTop))
        .toBeLessThan(before);
      await settle(page);
      reading = await anchor(page);
    }
    expect(reading.id).not.toBe(original.id);
    // An offscreen restored row is ignored even if gesture() fails to clear it.
    // Keep that row intersecting so the final assertion detects a stale anchor.
    await expect(
      history.locator(`[data-message-id="${original.id}"]`),
    ).toBeInViewport();
    await button(page, "Close Companion fixture panel").click();
    await settle(page);
    await expectAnchor(page, reading);
    await expectNonPaging(page, app);
  },
);

test("Projects directory fits the workspace and page navigation survives plugin re-enable order", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 832 });
  await page.goto(app.origin);
  // Header search owns page navigation, including while narrow Settings
  // collapses the sidebar; its Pages group must preserve plugin ordering.
  const search = page.getByRole("dialog", { name: "Search Buzz", exact: true });
  const titles = [
    "Me",
    "Messages",
    "Inbox",
    "Reminders",
    "Bestie",
    "Projects",
    "Agents",
    "Sessions (now in Me)",
    "Workflows",
  ];
  const expectPageOrder = async (expected) => {
    const choices = await pageChoices(page);
    await expect(choices.getByRole("option")).toHaveText([
      ...expected,
      "Settings",
    ]);
    return choices;
  };
  const closeSearch = async () => {
    await page.keyboard.press("Escape");
    await expect(search).toHaveCount(0);
  };
  await expectPageOrder(titles);
  await selectPage(page, "Projects");
  const surface = page.getByRole("region", { name: "Projects", exact: true });
  const title = surface.getByRole("heading", {
    name: "Projects",
    level: 1,
    exact: true,
  });
  await expect(title).toBeVisible();
  const directory = surface.locator(".projects-page");
  const subtitle = surface.getByText("Recent projects and repositories", {
    exact: true,
  });
  const empty = surface.getByText("No recent projects or repositories found.", {
    exact: true,
  });
  await expect(subtitle).toBeVisible();
  await expect(empty).toBeVisible();
  await expect(title).toBeFocused();
  for (const [width, height] of [
    [1280, 832],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    const bounds = await box(surface);
    const workspace = await box(surface.locator("..").locator(".."));
    const heading = await box(title);
    near(bounds.x, workspace.x);
    near(bounds.y, workspace.y);
    near(bounds.width, workspace.width);
    near(bounds.height, workspace.height);
    const padding = await directory.evaluate((element) => ({
      left: Number.parseFloat(getComputedStyle(element).paddingLeft),
      top: Number.parseFloat(getComputedStyle(element).paddingTop),
    }));
    near(heading.x, bounds.x + padding.left);
    near(heading.y, bounds.y + padding.top);
    const description = await box(subtitle);
    const emptyState = await box(empty);
    expect(description.y).toBeGreaterThanOrEqual(heading.y + heading.height);
    expect(emptyState.y).toBeGreaterThanOrEqual(
      description.y + description.height,
    );
    await expect(empty).toBeInViewport();
    await expect(directory).toHaveCSS("overflow", "auto");
    await expect(surface).toHaveCSS("overflow", "hidden");
    await shellFits(page, width);
    await page.screenshot({
      path: testInfo.outputPath(`projects-${width}.png`),
    });
  }
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await selectSettingsSection(page, "Plugins");
  const projects = page.getByRole("switch", {
    name: "Enable Projects",
    exact: true,
  });
  await projects.click();
  await expect(projects).toHaveAttribute("aria-checked", "false");
  await expectPageOrder([
    "Me",
    "Messages",
    "Inbox",
    "Reminders",
    "Bestie",
    "Agents",
    "Sessions (now in Me)",
    "Workflows",
  ]);
  await closeSearch();
  await projects.click();
  await expect(projects).toHaveAttribute("aria-checked", "true");
  // Re-enabled Projects registered last; navigation surfaces must still sort it.
  await expectPageOrder(titles);
  await selectPage(page, "Projects");
  await expect(title).toBeVisible();
  // The narrow drawer is closed here, but the sidebar keeps the same order
  // for its primary rows.
  await expect(sidebarDestinations(page, { includeHidden: true })).toHaveText(
    destinationTitles,
  );
});

// Real App navigation must retire page-local targets, without closing the
// independently owned companion intent. Each return stays in Channels.
const sidebarActions = companionTest.extend({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  largeSidebar: true,
  historyCounts: { alpha: 20, beta: 1 },
});
sidebarActions(
  "sidebar activity retains channel tabs while compose routes retire them and preserve companion intent",
  async ({ page, app }) => {
    await open(page, app);
    const companion = page.getByRole("complementary", {
      name: "Companion fixture",
      exact: true,
    });
    await companionLauncher(page, "Companion fixture").click();
    await expect(companion).toBeVisible();
    const alpha = page.locator('button[data-channel-id="alpha"]');
    for (const [index, action] of ["activity", "message"].entries()) {
      await link(page, app, `https://github.com/block/buzz/pull/${20 + index}`);
      if (action === "activity") {
        await alpha.hover();
        await page
          .getByRole("dialog", { name: "Activity in Alpha" })
          .getByRole("button", { name: /Open unread thread from/ })
          // Unlike the broadcast row, this reply cannot be marked read by the
          // visible main timeline while Playwright is moving the pointer.
          .filter({ hasText: "Unread reply 1" })
          .click();
        await expect(
          page.getByRole("complementary", { name: "Thread", exact: true }),
        ).toBeVisible();
      } else if (action === "message") {
        const sidebar = page.getByRole("navigation", {
          name: "Subscribed channels",
        });
        await sidebar
          .locator("summary", { hasText: /^Direct messages$/ })
          .hover();
        await sidebar
          .getByRole("button", { name: "New message", exact: true })
          .click();
        await expect(
          page.getByRole("region", { name: "New message", exact: true }),
        ).toBeVisible();
      }
      await expect(panel(page)).toHaveCount(0);
      await expect(
        companionLauncher(page, "Companion fixture"),
      ).toHaveAttribute("aria-expanded", "true");
      await button(page, "Go back").click();
      await expect(
        page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
      ).toBeVisible();
      await expect(panel(page)).toHaveCount(action === "activity" ? 1 : 0);
      if (action === "activity")
        await page
          .locator(
            '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
          )
          .click();
      await expect(companion).toBeVisible();
    }
  },
);

// Probe the platform's native default separately from the app: Linux and macOS
// WebKit differ for Control+Home and keyboard chaining through CSS containment.
// The app must preserve native behavior, not invent a cross-platform shortcut.
async function nativeUpwardScroll(context, key, containment) {
  const probe = await context.newPage();
  try {
    await probe.setContent(`
      <div id="outer" style="height:400px;overflow:auto">
        <div style="height:1600px"></div>
        <div id="inner" style="${containment ? `height:160px;overflow:auto;overscroll-behavior-y:${containment}` : ""}">
          <a id="control" href="#">Message link</a>
          ${containment ? '<div style="height:1600px"></div>' : ""}
        </div>
      </div>`);
    const outer = probe.locator("#outer");
    await outer.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await probe
      .locator("#control")
      .evaluate((el) => el.focus({ preventScroll: true }));
    await settle(probe, outer);
    const before = await outer.evaluate((el) => el.scrollTop);
    await probe.keyboard.press(key);
    await settle(probe, outer);
    return await outer.evaluate(
      (el, start) => el.scrollTop < start - 80,
      before,
    );
  } finally {
    await probe.close();
  }
}

// Native default keyboard scrolling from a focused descendant is browser-owned;
// deterministic same-shrink ordering is covered in ChannelTimeline.restore.test.
for (const [control, key] of [
  ["link", "PageUp"],
  ["button", "PageUp"],
  ["link", process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home"],
  ...(process.platform === "darwin" ? [["link", "Alt+ArrowUp"]] : []),
]) {
  readingTest(
    `${key} from a message ${control} preserves native scroll ownership`,
    async ({ page, app, context }) => {
      const nativeScroll = await nativeUpwardScroll(context, key);
      await open(page, app);
      await settle(page);
      const target = "https://example.com/keyboard-reading";
      const added = app.append(
        "primary",
        "alpha",
        `Read ${target}`,
        true,
        false,
      );
      const row = page.locator(`[data-message-id="${added.id}"]`);
      await expect(row).toBeInViewport();
      await settle(page);
      const history = page.getByRole("region", {
        name: "Channel message history",
      });
      const focused =
        control === "link"
          ? row.getByRole("link", { name: target, exact: true })
          : row.getByRole("button", { name: /^View .* profile$/ }).first();
      await focused.evaluate((element) =>
        element.focus({ preventScroll: true }),
      );
      await expect(focused).toBeFocused();
      const before = await history.evaluate((element) => element.scrollTop);
      // Linux WebKit can pause a native keyboard scroll and resume it after the
      // anchor is captured; only the history scrollend completes that gesture.
      if (nativeScroll) await keyScroll(page, key);
      else await page.keyboard.press(key);
      if (!nativeScroll) {
        await settle(page);
        expect(await history.evaluate((element) => element.scrollTop)).toBe(
          before,
        );
        const arrival = app.append(
          "primary",
          "alpha",
          "Still following after a native no-op key",
        );
        await expect(
          page.locator(`[data-message-id="${arrival.id}"]`),
        ).toBeInViewport();
        await settle(page);
        await expect
          .poll(() =>
            history.evaluate(
              (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
            ),
          )
          .toBeLessThan(2);
        return;
      }
      await expect
        .poll(() => history.evaluate((element) => element.scrollTop))
        .toBeLessThan(before - 80);
      await settle(page);
      const reading = await anchor(page);
      app.append("primary", "alpha", "Do not steal the reader's position");
      await expect(
        history.locator("[data-jump-to-latest]"),
      ).toHaveAccessibleName(/new message/i);
      await settle(page);
      await expectAnchor(page, reading);
      await expect(history.locator("[data-jump-to-latest]")).toBeVisible();
    },
  );
}

// Exercise both propagation and no-op lifecycle against the same engine's
// native baseline, rather than imposing macOS behavior on Linux WebKit.
for (const containment of ["auto", "contain"])
  readingTest(
    `Page Up respects the raw diff ${containment} scroll boundary`,
    async ({ page, app, context }) => {
      const nativeScroll = await nativeUpwardScroll(
        context,
        "PageUp",
        containment,
      );
      const historyEvents = app.histories.get("primary/alpha");
      historyEvents.push(
        finalizeEvent(
          {
            kind: 40008,
            created_at: historyEvents.at(-1).created_at + 1,
            tags: [
              ["h", "alpha"],
              ["file", "reading.txt"],
            ],
            content: "Raw, unparseable patch line\n".repeat(100),
          },
          generateSecretKey(),
        ),
      );
      await open(page, app);
      const raw = page.getByRole("region", { name: "Raw diff", exact: true });
      await expect(raw).toBeVisible();
      // The enabled diff renderer owns vertical overflow in its preview wrapper.
      const inner = page.getByRole("region", {
        name: "Diff preview: reading.txt",
      });
      await expect(inner).toBeVisible();
      await settle(page);
      const history = page.getByRole("region", {
        name: "Channel message history",
      });
      const before = await history.evaluate((el) => el.scrollTop);
      await inner.evaluate((el) => {
        el.scrollTop = 100;
      });
      await raw.evaluate((el) => el.focus({ preventScroll: true }));
      await expect(raw).toBeFocused();
      await page.keyboard.press("PageUp");
      await expect.poll(() => inner.evaluate((el) => el.scrollTop)).toBe(0);
      await settle(page);
      expect(await history.evaluate((el) => el.scrollTop)).toBe(before);

      await inner.evaluate((el, value) => {
        el.style.overscrollBehaviorY = value;
      }, containment);
      // Linux WebKit can pause native PageUp and resume it after the anchor is
      // captured; only the history scrollend completes that gesture.
      if (nativeScroll) await keyScroll(page, "PageUp");
      else await page.keyboard.press("PageUp");
      if (nativeScroll) {
        await expect
          .poll(() => history.evaluate((el) => el.scrollTop))
          .toBeLessThan(before - 80);
        await settle(page);
        const reading = await anchor(page);
        app.append("primary", "alpha", "Keep the reader above the diff");
        await expect(
          history.locator("[data-jump-to-latest]"),
        ).toHaveAccessibleName(/new message/i);
        await settle(page);
        await expectAnchor(page, reading);
      } else {
        await settle(page);
        expect(await history.evaluate((el) => el.scrollTop)).toBe(before);
        // No outer scrollend will retire this key. A later real layout contraction
        // must retain bottom follow, including the next incoming message.
        const height = await history.evaluate((el) => el.scrollHeight);
        await inner.evaluate((el) => {
          el.style.maxHeight = "80px";
        });
        await expect
          .poll(() => history.evaluate((el) => el.scrollHeight))
          .toBeLessThan(height);
        await settle(page);
        const arrival = app.append(
          "primary",
          "alpha",
          "Still following after an unconsumed Page Up",
        );
        await expect(
          page.locator(`[data-message-id="${arrival.id}"]`),
        ).toBeInViewport();
        await settle(page);
        await expect
          .poll(() =>
            history.evaluate(
              (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
            ),
          )
          .toBeLessThan(2);
      }
    },
  );
