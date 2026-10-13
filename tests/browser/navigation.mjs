import { expect } from "@playwright/test";

export async function pageChoices(page) {
  await page.getByRole("button", { name: "Search Buzz", exact: true }).click();
  return page
    .getByRole("dialog", { name: "Search Buzz", exact: true })
    .getByRole("group", { name: "Actions", exact: true });
}

export async function openPage(page, name, { connected = true } = {}) {
  // The community rail appears after local startup has replaced the launch view.
  await expect(
    page.getByRole("button", { name: "Switch to Primary", exact: true }),
  ).toBeVisible();
  await pageChoices(page);
  await selectPage(page, name, { connected });
}

// Select from an already-open palette, including tests that inspect page order.
export async function selectPage(page, name, { connected = true } = {}) {
  const dialog = page.getByRole("dialog", { name: "Search Buzz", exact: true });
  const input = dialog.getByRole("combobox", { name: "Search Buzz" });
  const choice = dialog
    .getByRole("group", { name: "Actions", exact: true })
    .getByRole("option", { name, exact: true });
  // Registered page actions are visible only after the plugin catalog is ready.
  await expect(choice).toBeVisible();
  // Until the community connects, the palette is a placeholder. The connected
  // palette replaces it, which resets selection and option ids, so select only
  // in the final palette. Pass `connected: false` when the test holds or fails
  // the relay session: the placeholder then stays.
  await expect(
    dialog.getByText("Connecting to this community…", { exact: true }),
  ).toHaveCount(connected ? 0 : 1);
  // Conversation groups above Actions arrive with the channel list and move
  // every row below them, so a pointer click can land between rows. Keyboard
  // selection follows the choice itself, not its position.
  const id = await choice.getAttribute("id");
  const limit = await dialog.getByRole("option").count();
  for (
    let step = 0;
    (await input.getAttribute("aria-activedescendant")) !== id;
    step++
  ) {
    // Rows that arrive later are inserted above the selection, so moving down
    // still reaches the choice. The bound only turns a regression into a failure.
    expect(step, `keyboard reaches ${name}`).toBeLessThan(limit + 16);
    await input.press("ArrowDown");
  }
  await input.press("Enter");
  await expect(dialog).not.toBeVisible();
}

// The shell toggle's label follows a matchMedia change listener in AppShell,
// which renders in a rendering update after page.setViewportSize() has
// resolved. A non-waiting isVisible() guard on "Show navigation" read before
// that render sees the previous width's label: it skips the click a narrow
// layout needs, or clicks a button a wide layout is about to relabel. Wait for
// the label that belongs to the current width before guarding. Pages without a
// collapsible sidebar render no toggle at wide widths; callers there settle
// only when narrow.
export async function settleShellToggle(page) {
  await expect(
    page.locator("[data-shell-sidebar-toggle]"),
  ).toHaveAccessibleName(
    page.viewportSize().width <= 650
      ? /^(Show|Hide) navigation$/
      : /^(Show|Hide) (?:Channel |Me )?sidebar$/,
  );
}

export async function selectSettingsSection(page, name, regionName = name) {
  await settleShellToggle(page);
  const show = page.getByRole("button", {
    name: "Show navigation",
    exact: true,
  });
  if (await show.isVisible()) await show.click();
  await page
    .getByRole("complementary", { name: "Settings sidebar", exact: true })
    .getByRole("button", { name, exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: regionName, exact: true }),
  ).toBeVisible();
}

export async function chooseColorMode(page, name) {
  const choice = page.getByRole("radio", { name, exact: true });
  await page.locator("label").filter({ has: choice }).click();
  await expect(choice).toBeChecked();
}

// Secondary panels enter with a short horizontal transform. Positions compared
// across separate reads must wait for that motion: each read sees a different
// offset, so a fixed gap between two controls can appear to overlap.
export async function settlePanelMotion(page) {
  await page.locator("[data-panel-dock]").evaluateAll((docks) =>
    Promise.allSettled(
      docks.flatMap((dock) =>
        dock
          .getAnimations({ subtree: true })
          .filter(
            (animation) =>
              animation.effect?.getComputedTiming().endTime !== Infinity,
          )
          .map((animation) => animation.finished),
      ),
    ),
  );
}
