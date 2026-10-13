import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 1, beta: 1 } });
// Regressions independently reproduced by Pinky against the first wiring handoff.
const button = (page, name) => page.getByRole("button", { name, exact: true });
const entry = (page) =>
  page.evaluate(() => history.state.buzzNavigationV1.entry);

test("Back restores Personal space without inheriting the active community", async ({
  page,
  app,
}) => {
  await open(page, app);
  const rail = page.getByRole("navigation", { name: "Communities" });
  await button(page, "Personal space").click();
  await expect(
    rail.getByRole("button", { name: "Personal space" }),
  ).toHaveAttribute("aria-current", "true");
  const personal = await entry(page);
  await button(page, "Switch to Primary").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await button(page, "Go back").click();
  await expect(
    rail.getByRole("button", { name: "Personal space" }),
  ).toHaveAttribute("aria-current", "true", { timeout: 1500 });
  expect(await entry(page)).toEqual(personal);
  await expect(
    page.getByRole("heading", { name: "Your channels, one conversation." }),
  ).toBeVisible();
  await button(page, "Go forward").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
});

// An invalid address fails again synchronously, so its Retry control stays.
test("keyboard Retry keeps focus when the retry fails in place", async ({
  page,
  app,
}) => {
  await page.goto(`${app.origin}/#buzz=not-json`);
  const retry = button(page, "Retry navigation");
  await retry.focus();
  await retry.press("Enter");
  await retry.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );
  await expect(retry).toBeFocused();
});

test("keyboard Retry hands off focus while reconnecting a failed Messages tab opening", async ({
  page,
  app,
}) => {
  let requests = 0;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/relay/primary/session", async (route) => {
    requests++;
    if (requests === 1) return route.fulfill({ json: {} });
    await held;
    return route.continue();
  });
  // Start outside Messages so its header activation owns preserve-focus intent.
  // Settings also reads the community profile through /session, racing this gate.
  await page.goto(
    `${app.origin}/#buzz=${encodeURIComponent(JSON.stringify({ version: 1, kind: "page", pluginId: "buzz.me", pageId: "me" }))}`,
  );
  await expect(
    page.getByRole("tab", { name: "Me", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const messages = page.getByRole("tab", { name: "Messages", exact: true });
  await messages.focus();
  await messages.press("Enter");
  await expect(
    page.getByRole("heading", { name: "This destination couldn’t open" }),
  ).toBeVisible();
  expect(requests).toBe(1);
  const visit = await entry(page);
  const retry = button(page, "Retry navigation");
  const main = page.getByRole("main");
  try {
    await retry.focus();
    await retry.press("Enter");
    await expect.poll(() => requests, { timeout: 1500 }).toBe(2);
    await expect(retry).toHaveCount(0);
    await expect(main).toBeFocused();
  } finally {
    release();
  }
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await expect(main).toBeFocused();
  // Resolving Messages chooses its conversation in the same visit.
  expect(await entry(page)).toEqual({
    id: visit.id,
    target: {
      version: 1,
      kind: "conversation",
      channelId: "alpha",
      scope: visit.target.scope,
    },
  });
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("tabpanel", { name: "Messages", exact: true }),
  ).toBeFocused();
});

test("Skip to content focuses main without adding a visit or dropping Back", async ({
  page,
  app,
}) => {
  await open(page, app);
  await openPage(page, "Projects");
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeFocused();
  const before = await entry(page);
  const url = page.url();
  const skip = page.getByRole("link", { name: "Skip to content", exact: true });
  await skip.focus();
  await skip.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible({ timeout: 1500 });
  await expect(page.getByRole("main")).toBeFocused();
  expect(await entry(page)).toEqual(before);
  expect(page.url()).toBe(url);
  await expect(button(page, "Go back")).toBeEnabled();
  await button(page, "Go back").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
});

test("An edited navigation hash opens its destination and survives reload and Back", async ({
  page,
  app,
}) => {
  await open(page, app);
  const alpha = await entry(page);
  await page.evaluate(() => {
    location.hash =
      "#buzz=" +
      encodeURIComponent(
        JSON.stringify({ version: 1, kind: "settings", section: "appearance" }),
      );
  });
  const appearance = page.getByRole("heading", {
    name: "Appearance",
    exact: true,
  });
  await expect(appearance).toBeVisible({ timeout: 1500 });
  const settings = await entry(page);
  await page.reload();
  await expect(appearance).toBeVisible();
  expect(await entry(page)).toEqual(settings);
  await button(page, "Go back").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  expect(await entry(page)).toEqual(alpha);
  await button(page, "Go forward").click();
  await expect(appearance).toBeVisible();
});

const launchTest = test.extend({ launchAnimation: true });
launchTest(
  "malformed navigation addresses fail explicitly on cold and warm entry",
  async ({ page, app }) => {
    await page.goto(`${app.origin}/#buzz=%7B`);
    const failed = page.getByRole("heading", {
      name: "This destination couldn’t open",
      exact: true,
    });
    await expect(page.locator("#buzz-launch")).toHaveCount(0);
    await expect(failed).toBeVisible();
    await openPage(page, "Projects");
    await expect(failed).toBeHidden();
    await button(page, "Agents").first().click();
    await page.evaluate(() => {
      location.hash = "#buzz=%7B";
    });
    await expect(failed).toBeVisible({ timeout: 1500 });
    await page.reload();
    await expect(page.locator("#buzz-launch")).toHaveCount(0);
    await expect(failed).toBeVisible();
    await button(page, "Go back").click();
    await expect(
      page.getByRole("region", { name: "Agents", exact: true }),
    ).toBeVisible();
    await button(page, "Go forward").click();
    await expect(failed).toBeVisible();
  },
);
