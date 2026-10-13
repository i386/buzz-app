import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { openPage } from "./navigation.mjs";

// Real CSS cascade and native scroll extents require a browser. Twenty choices
// make the short viewport overflow without the large-sidebar scale fixture.
test.use({
  channelIds: [
    "alpha",
    "beta",
    ...Array.from({ length: 18 }, (_, i) => `channel-${i}`),
  ],
  historyCounts: { alpha: 20, beta: 1 },
});

for (const mode of ["light", "dark"]) {
  test(`${mode} panels and settings share the sidebar scrollbar`, async ({
    page,
    app,
  }) => {
    await page.emulateMedia({ colorScheme: mode });
    await page.setViewportSize({ width: 1440, height: 600 });
    await open(page, app);
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
    });
    await sidebar.hover();
    const color = await sidebar.evaluate(
      (el) => getComputedStyle(el).scrollbarColor,
    );
    expect(color).not.toBe("rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)");
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    await expect(history).toHaveCSS("scrollbar-color", color);
    await expect(history).toHaveCSS("scrollbar-gutter", "stable");
    await openPage(page, "Settings");
    const detail = page.getByRole("region", { name: "Settings", exact: true });
    const settingsSidebar = page
      .getByRole("complementary", { name: "Settings sidebar" })
      .locator(":scope > div");
    for (const scroller of [detail, settingsSidebar]) {
      await expect(scroller).toHaveCSS("scrollbar-width", "thin");
      await expect(scroller).toHaveCSS("scrollbar-color", color);
    }
    await page.getByRole("button", { name: "Shortcuts", exact: true }).click();
    await expect
      .poll(() => detail.evaluate((el) => el.scrollHeight > el.clientHeight))
      .toBe(true);
    await detail.hover();
    await page.mouse.wheel(0, 300);
    await expect
      .poll(() => detail.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
  });
}
