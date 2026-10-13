import { test, expect } from "./source-fixture.mjs";

// Native scroll reset on DOM reparent + retained source dock cleanup; equal
// widths isolate this contract from the separate channel reflow behavior.
test("last side-tab transfer captures the current reader position", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/thread-tab-moves.html");
  const scroller = page.locator("[data-message-scroller]");
  await expect(scroller).toBeVisible();
  const reader = await scroller.elementHandle();
  await scroller.evaluate((el) => {
    el.scrollTop = 250;
  });
  await page.getByRole("button", { name: "Move thread" }).click();
  await expect(page.locator("[data-panel-dock]")).toBeVisible();
  await scroller.evaluate((el) => {
    el.scrollTop = 350;
  });
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(350);
  await page.getByRole("button", { name: "Move thread" }).click();
  await expect(page.locator("[data-panel-dock]")).toHaveCount(0);
  expect(await reader.evaluate((el) => el.isConnected)).toBe(true);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(350);
});
