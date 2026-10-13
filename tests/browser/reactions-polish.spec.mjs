import { expect } from "@playwright/test";
import { test } from "./source-fixture.mjs";

// Browser-only: actual rem geometry and the line-height clipping boundary need
// the production stylesheet and layout engine, not a DOM emulator.
test("reaction counts and controls grow together without clipping", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/emoji.html?reactions");
  const message = page
    .locator("[data-message-id]")
    .filter({ hasText: "Historic" });
  const pill = message.locator('button[data-reaction=":party:"]');
  const count = pill.locator('[class*="_reactionCountMotion_"]');
  await expect(count).toBeVisible();
  for (const scale of [1, 1.5, 2, 1]) {
    await page.evaluate(
      (scale) =>
        document.documentElement.style.setProperty(
          "--buzz-text-scale",
          String(scale),
        ),
      scale,
    );
    await expect(pill).toHaveCSS("min-width", `${48 * scale}px`);
    await expect(pill).toHaveCSS("height", `${28 * scale}px`);
    await expect(count).toHaveCSS("font-size", `${12 * scale}px`);
    await expect(count).toHaveCSS("height", `${14 * scale}px`);
    await expect
      .poll(() =>
        count.evaluate(
          (el) =>
            el.clientHeight >=
            Number.parseFloat(getComputedStyle(el).lineHeight),
        ),
      )
      .toBe(true);
  }
});

test("reaction pills wrap, preview, toggle, and add from the inline control", async ({
  page,
}, testInfo) => {
  await page.route("**/emoji-media/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M2 4Q4 1 8 2q6-1 6 5 0 7-6 7Q1 14 2 8Z" fill="#82d93e"/><circle cx="6" cy="6" r="1"/><circle cx="11" cy="6" r="1"/><path d="M5 10q3 3 6 0" fill="none" stroke="#172710" stroke-width="1"/></svg>',
    }),
  );
  await page.goto("/tests/fixtures/emoji.html?reactions&wrap&narrow");
  const message = page.locator("[data-message-id]").first();
  const row = message.getByTestId("reaction-row");
  const pills = row.locator("button[data-reaction]");
  await expect(pills).toHaveCount(12);
  const order = () =>
    pills.evaluateAll((items) => items.map((item) => item.dataset.reaction));
  const initialOrder = await order();
  const tops = await pills.evaluateAll((items) =>
    items.map((item) => item.getBoundingClientRect().top),
  );
  expect(new Set(tops).size).toBeGreaterThan(1);

  const custom = row.locator('button[data-reaction=":party:"]');
  const native = row.locator('button[data-reaction="👍"]');
  await expect(custom.locator("img")).toHaveCSS("object-fit", "contain");
  await expect(custom.locator("img")).toHaveCSS("width", "14px");
  await expect(native.locator("span").first()).toHaveCSS("font-size", "14px");
  await expect(custom).toHaveCSS("height", "28px");
  const plus = row.getByRole("button", { name: "Add reaction" });
  await expect(plus).toHaveCSS("width", "28px");
  await expect(plus).toHaveCSS("height", "28px");
  await message.screenshot({ path: testInfo.outputPath("reaction-row.png") });

  await custom.hover();
  const tooltip = page.locator('.buzz-preview-card[role="tooltip"][data-open]');
  await expect(tooltip).toBeVisible({ timeout: 2500 });
  await expect(tooltip.locator("img")).toHaveCount(1);
  await expect(tooltip).toContainText(":party:");
  await expect(tooltip).toContainText("Fixture Member");
  const tipBox = await tooltip.boundingBox();
  const messageBox = await message.boundingBox();
  const x = Math.max(0, Math.min(tipBox.x, messageBox.x) - 12);
  const y = Math.max(0, Math.min(tipBox.y, messageBox.y) - 12);
  await page.screenshot({
    path: testInfo.outputPath("reaction-preview.png"),
    clip: {
      x,
      y,
      width: Math.min(
        page.viewportSize().width - x,
        Math.max(tipBox.x + tipBox.width, messageBox.x + messageBox.width) -
          x +
          12,
      ),
      height: Math.min(
        page.viewportSize().height - y,
        Math.max(tipBox.y + tipBox.height, messageBox.y + messageBox.height) -
          y +
          12,
      ),
    },
  });
  const heart = row.locator('button[data-reaction="❤️"]');
  await heart.hover();
  await expect(tooltip).toBeVisible({ timeout: 500 });
  await expect(tooltip).toContainText("heart");
  await expect(tooltip).toHaveClass(/reactionPreviewSlideRight/);
  await page.mouse.move(0, 0);

  await page.evaluate(() => window.emojiFixture.holdNextReaction(":party:"));
  try {
    await custom.click();
    await expect
      .poll(() =>
        page.evaluate(() => window.emojiFixture.report.reactionStarted),
      )
      .toBe(true);
    await expect(custom).toHaveAttribute("aria-pressed", "true");
    await expect(custom).toHaveAttribute("aria-label", /2 people/);
    await expect(native).toHaveAttribute("aria-disabled", "true");
    await expect(custom).toHaveCSS("opacity", "1");
    await expect(custom).toHaveAttribute("aria-disabled", "true");
    await native.evaluate((button) => button.click());
    await expect
      .poll(() => page.evaluate(() => window.emojiFixture.operations()))
      .toBe(1);
  } finally {
    await page.evaluate(() => window.emojiFixture.releaseReaction());
  }
  await expect
    .poll(() =>
      page.evaluate(() => window.emojiFixture.report.publications.length),
    )
    .toBe(1);
  await expect(custom).toHaveAttribute("aria-disabled", "false");
  expect(await order()).toEqual(initialOrder);
  await custom.click();
  await expect(custom).toHaveAttribute("aria-pressed", "false");
  await expect(custom).toHaveAttribute("aria-label", /1 person/);
  await row.locator('button[data-reaction="✅"]').click();
  await expect(row.locator('button[data-reaction="✅"]')).toHaveCount(0);

  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.locator("main").evaluate((element) => {
    element.style.marginTop = "500px";
  });
  await plus.click();
  const picker = page.locator('em-emoji-picker input[type="search"]');
  await expect(picker).toBeVisible();
  const pickerBox = await page.locator('[role="dialog"]').last().boundingBox();
  const plusBox = await plus.boundingBox();
  expect(pickerBox.y + pickerBox.height).toBeLessThan(plusBox.y);
  await picker.fill("aonly");
  await page.getByRole("button", { name: ":aonly:", exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(row.locator('button[data-reaction=":aonly:"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await plus.focus();
  await plus.press("Enter");
  await expect(picker).toBeVisible();
  await picker.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(plus).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await custom.hover();
  await expect(tooltip).toBeVisible({ timeout: 2500 });
  await expect(tooltip).toHaveCSS("transition-duration", "0s");
});

test("reaction previews use the delayed first open, immediate warm switch, and reset delay", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/emoji.html?reactions&wrap");
  const row = page
    .locator("[data-message-id]")
    .first()
    .getByTestId("reaction-row");
  const custom = row.locator('button[data-reaction=":party:"]');
  const heart = row.locator('button[data-reaction="❤️"]');
  const tooltip = page.locator('.buzz-preview-card[role="tooltip"][data-open]');
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:00:10Z"));
  try {
    await custom.hover();
    await expect(tooltip).toHaveCount(0);
    await page.clock.runFor(99);
    await expect(tooltip).toHaveCount(0);
    await page.clock.runFor(1);
    await expect(tooltip).toBeVisible();
    await heart.hover();
    await expect(tooltip).toContainText("heart");
    await page.mouse.move(0, 0);
    await expect(tooltip).toHaveCount(0);
    await page.clock.runFor(151);
    await custom.hover();
    await page.clock.runFor(99);
    await expect(tooltip).toHaveCount(0);
    await page.clock.runFor(1);
    await expect(tooltip).toBeVisible();
  } finally {
    await page.clock.resume();
  }
});

test("long native reactions and unavailable shortcode artwork stay inside the pill", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/emoji.html?reactions&long&narrow");
  const row = page
    .locator("[data-message-id]")
    .first()
    .getByTestId("reaction-row");
  for (const content of ["f".repeat(64), `:${"a".repeat(64)}:`]) {
    const pill = row.locator(`button[data-reaction="${content}"]`);
    await expect(pill).toHaveCount(1);
    await expect(pill).toHaveAttribute("aria-label", `${content}: 1 person`);
    const bounds = await pill.evaluate((button) => {
      const glyph = button.firstElementChild;
      const count = button.lastElementChild;
      const chip = button.getBoundingClientRect();
      return {
        chipWidth: chip.width,
        glyphRight: glyph.getBoundingClientRect().right,
        countLeft: count.getBoundingClientRect().left,
        countRight: count.getBoundingClientRect().right,
        chipRight: chip.right,
        truncated: glyph.scrollWidth > glyph.clientWidth,
      };
    });
    expect(bounds.chipWidth).toBeLessThanOrEqual(160);
    expect(bounds.truncated).toBe(true);
    expect(bounds.glyphRight).toBeLessThan(bounds.countLeft);
    expect(bounds.countRight).toBeLessThan(bounds.chipRight);
  }
});
