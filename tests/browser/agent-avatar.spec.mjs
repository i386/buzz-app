import { test, expect } from "./source-fixture.mjs";

// Real browser image readiness and computed visibility cannot be proved in jsdom.
test("cached agent artwork is visible immediately when avatars remount", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-avatar.html");
  await page.getByRole("button", { name: "Load cached picture" }).click();
  await expect(page.locator('section img[data-loaded="true"]')).toHaveCount(2);
  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => {
        document.documentElement.classList.toggle("dark", theme === "dark");
        document.documentElement.style.fontSize = "24px";
      }, theme);
      const remount = page.getByRole("button", { name: "Remount avatars" });
      await remount.focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByLabel("Avatars immediately after remount"),
      ).toHaveText(
        JSON.stringify([
          { complete: true, opacity: "1" },
          { complete: true, opacity: "1" },
        ]),
      );
      await expect(remount).toBeFocused();
      await remount.click();
      await expect(page.locator('section img[data-loaded="true"]')).toHaveCount(
        2,
      );
    }
  }
});

// Compare rendered glyphs: computed font-size alone cannot detect an ancestor scale.
test("agent initials retain shared avatar typography at DM and chat sizes", async ({
  page,
}) => {
  const release = Promise.withResolvers();
  await page.route(
    "https://images.example/agent-fallback.png",
    async (route) => {
      await release.promise;
      await route.abort();
    },
  );
  await page.goto("/tests/fixtures/agent-avatar.html");
  const assertFallbacks = async () => {
    for (const size of [22, 40]) {
      const group = page.getByRole("region", { name: `${size}px avatars` });
      const initial = group
        .getByRole("img", { name: /^Agent/ })
        .locator("[data-avatar-shape] > span");
      const reference = group
        .getByRole("img", { name: "Reference" })
        .locator("span");
      await expect(initial).toHaveText("A");
      const glyph = (locator) =>
        locator.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const rect = range.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        });
      const expected = await glyph(reference);
      await expect
        .poll(async () => {
          const actual = await glyph(initial);
          return Math.max(
            Math.abs(actual.width - expected.width),
            Math.abs(actual.height - expected.height),
          );
        })
        .toBeLessThan(0.1);
    }
  };
  try {
    await assertFallbacks();
    await page.getByRole("button", { name: "Toggle thinking" }).click();
    await assertFallbacks();
    await page.getByRole("button", { name: "Load picture" }).click();
    await assertFallbacks();
    release.resolve();
    await expect(page.locator("img")).toHaveCount(0);
    await assertFallbacks();
    await page.getByRole("button", { name: "Toggle thinking" }).click();
    await assertFallbacks();
  } finally {
    release.resolve();
  }
});
