import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test.use({ productionBroker: true, historyCounts: { alpha: 1, beta: 1 } });

// Models a laptop that wakes before its VPN is back: the relay connection
// drops and every relay request gets a non-relay 403 page. When the network
// returns, the app must recover by itself, with no restart and no Retry click.
test("relay reads recover automatically after the network returns", async ({
  page,
  app,
}, testInfo) => {
  let offline = false;
  app.report.relayFailures = [];
  await page.route("**/api/relay/**", async (route) => {
    const url = route.request().url();
    if (!offline || new URL(url).pathname.endsWith("/session"))
      return route.fallback();
    app.report.relayFailures.push(url);
    await route.fulfill({
      status: 403,
      contentType: "text/html",
      body: "<html><body>Forbidden</body></html>",
    });
  });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await expect(composer).toBeVisible();

  offline = true;
  app.relay.disconnect("primary");
  // With a conversation open, the notice sits inline above the composer.
  const notice = page.getByRole("status", {
    name: "Reconnecting to relay…",
    exact: true,
  });
  await expect(notice).toBeVisible({ timeout: 30_000 });
  // One notice and one Retry now; no per-panel Retry buttons.
  await expect(page.getByRole("button", { name: /Retry/ })).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Retry now", exact: true }),
  ).toBeVisible();
  // The notice is the one place that reports it: no floating duplicate.
  await expect(
    page.getByRole("dialog", { name: "Reconnecting to relay…", exact: true }),
  ).toHaveCount(0);
  // Loaded messages and channels stay on screen.
  await expect(page.getByText("primary alpha message 0")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("offline.png") });
  // It leaves the composer and Send usable.
  await composer.fill("Draft while offline");
  await page
    .getByRole("button", { name: "Send message", exact: true })
    .click({ trial: true });
  await composer.fill("");

  offline = false;
  // No click: the scheduled retry finds the network back.
  await expect(notice).toHaveCount(0, { timeout: 45_000 });
  await expect(page.getByRole("button", { name: /Retry/ })).toHaveCount(0);
  // Every failed panel clears, including the open timeline.
  await expect(page.getByText(/Relay request failed/)).toHaveCount(0);
  await expect(page.getByText("primary alpha message 0")).toBeVisible();
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("primary beta message 0")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("recovered.png") });
});
