import { expect, test } from "@playwright/test";

const viewer = "/tests/fixtures/design-system.html";

// CSS animation phase, reduced motion and layout require real browser rendering.
test("activity dots breathe together while waiting and stagger only while working", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`${viewer}#/design/components/typing-dots`);
  const status = page.getByRole("status", { name: "Example activity" });
  const dots = status.locator("[data-state]");
  const delays = () =>
    dots
      .locator("span")
      .evaluateAll((items) =>
        items.map((item) => getComputedStyle(item).animationDelay),
      );
  for (const mode of ["light", "dark"]) {
    const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await toggle.count()) await toggle.click();
    for (const width of [390, 800, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(status).toHaveText("Received · waiting to start");
      await expect(dots.locator("span").first()).toHaveCSS(
        "animation-duration",
        "2.4s",
      );
      expect(await delays()).toEqual(["0s", "0s", "0s"]);
      const opacities = await dots.evaluate((element) => {
        for (const animation of element.getAnimations({ subtree: true })) {
          animation.pause();
          animation.currentTime = 600;
        }
        return [...element.children].map(
          (child) => getComputedStyle(child).opacity,
        );
      });
      expect(new Set(opacities).size).toBe(1);
      const waitingBox = await dots.boundingBox();
      const start = page.getByRole("button", {
        name: "Start work",
        exact: true,
      });
      await start.focus();
      await page.keyboard.press("Enter");
      await expect(status).toHaveText("Working");
      await expect(dots.locator("span").first()).toHaveCSS(
        "animation-duration",
        "1.4s",
      );
      expect(await delays()).toEqual(["0s", "0.2s", "0.4s"]);
      const workingBox = await dots.boundingBox();
      expect(workingBox?.width).toBe(waitingBox?.width);
      expect(workingBox?.height).toBe(waitingBox?.height);
      await page.getByRole("button", { name: "Reset to waiting" }).click();
    }
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const state of ["Received · waiting to start", "Working"]) {
    await expect(status).toHaveText(state);
    for (const dot of await dots.locator("span").all())
      await expect(dot).toHaveCSS("animation-name", "none");
    if (state !== "Working")
      await page
        .getByRole("button", { name: "Start work", exact: true })
        .click();
  }
});
