import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });

const button = (page, name) => page.getByRole("button", { name, exact: true });
const composer = (page, name) =>
  page.getByRole("textbox", { name: `Message #${name}`, exact: true });
const entry = (page) =>
  page.evaluate(() => history.state.buzzNavigationV1.entry);

test("a collapsible sidebar yields to narrow drawer styles during resize", async ({
  page,
  app,
}) => {
  await open(page, app);
  const navigation = page.locator("#shell-navigation");
  await expect(navigation).toHaveAttribute("data-sidebar-collapsible", "true");

  await page.setViewportSize({ width: 390, height: 900 });
  // Model the desktop marker remaining for a frame until React observes the
  // media-query change; narrow drawer CSS must still win during that interval.
  await navigation.evaluate((element) => {
    element.setAttribute("data-sidebar-collapsible", "true");
  });
  await expect(navigation).toHaveCSS("display", "none");

  await button(page, "Show navigation").click();
  await expect(navigation).toHaveAttribute("data-expanded", "true");
  await expect(navigation).toHaveCSS("display", "flex");
  await expect(navigation).toBeVisible();
});

test("a retired contributed Settings destination fails promptly on Back", async ({
  page,
  app,
}) => {
  await open(page, app);
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const sections = page.getByRole("navigation", { name: "Settings sections" });
  await sections.getByRole("button", { name: "Plugins", exact: true }).click();
  const pairingEnabled = page.getByRole("switch", {
    name: "Enable Pair mobile",
    exact: true,
  });
  if (!(await pairingEnabled.isChecked())) await pairingEnabled.click();
  const pairing = sections.getByRole("button", {
    name: "Pair mobile",
    exact: true,
  });
  await expect(pairing).toBeVisible();
  await pairing.click();
  await expect(pairing).toHaveAttribute("aria-current", "page");
  await sections.getByRole("button", { name: "Plugins", exact: true }).click();
  await pairingEnabled.click();
  await expect(pairing).toHaveCount(0);
  await button(page, "Go back").click();
  await expect(
    page.getByRole("alert").getByRole("heading", {
      name: "This destination couldn’t open",
      exact: true,
    }),
  ).toBeVisible({ timeout: 3000 });
});

test("channel visits, toolbar, browser traversal and Settings sections share one history", async ({
  page,
  app,
}) => {
  await open(page, app);
  const alpha = await entry(page);
  expect(alpha.target.channelId).toBe("alpha");
  await button(page, "Beta").click();
  await expect(composer(page, "Beta")).toBeVisible();
  const beta = await entry(page);
  expect(beta.id).not.toBe(alpha.id);
  await button(page, "Go back").click();
  await expect(composer(page, "Alpha")).toBeVisible();
  expect((await entry(page)).id).toBe(alpha.id);
  // Reclick is retry, not a new visit or forward-stack truncation.
  await button(page, "Alpha").click();
  expect((await entry(page)).id).toBe(alpha.id);
  await expect(button(page, "Go forward")).toBeEnabled();
  await button(page, "Go forward").click();
  await expect(composer(page, "Beta")).toBeVisible();
  expect((await entry(page)).id).toBe(beta.id);
  await page.goBack();
  await expect(composer(page, "Alpha")).toBeVisible();
  await page.goForward();
  await expect(composer(page, "Beta")).toBeVisible();
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const sections = page.getByRole("navigation", { name: "Settings sections" });
  await expect(
    sections.getByRole("button", { name: "Profile", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await sections
    .getByRole("button", { name: "Appearance", exact: true })
    .click();
  await expect(
    sections.getByRole("button", { name: "Appearance", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  // Option/Alt arrows are native editing controls, not Buzz history shortcuts.
  await page.keyboard.press("Alt+ArrowLeft");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(
    sections.getByRole("button", { name: "Appearance", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.reload();
  await expect(
    sections.getByRole("button", { name: "Appearance", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await button(page, "Go back").click();
  await expect(
    sections.getByRole("button", { name: "Profile", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await button(page, "Go back").click();
  await expect(composer(page, "Beta")).toBeVisible();
});
