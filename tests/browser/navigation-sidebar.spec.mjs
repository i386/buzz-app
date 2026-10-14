import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
const button = (page, name) => page.getByRole("button", { name, exact: true });
test.use({
  largeSidebar: true,
  historyCounts: { alpha: 1, beta: 1 },
});

const sessionParent = "11111111-1111-4111-8111-111111111111";
const sessionSidebar = test.extend({
  sessionChannels: ["alpha"],
  sessionParents: { alpha: sessionParent },
});

test("channel sidebar resizes from the full gutter and persists", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebarPanel = page.getByRole("complementary", {
    name: "Channel sidebar",
  });
  const sidebar = page.locator(".shell-sidebar").filter({ has: sidebarPanel });
  const handle = page.getByRole("separator", {
    name: "Resize channel sidebar",
  });
  const channelList = page.getByRole("navigation", {
    name: "Subscribed channels",
  });
  const before = await sidebar.boundingBox();
  const grip = await handle.boundingBox();
  const listBox = await channelList.boundingBox();
  expect(before).not.toBeNull();
  expect(grip).not.toBeNull();
  expect(listBox).not.toBeNull();
  const geometry = await sidebarPanel.evaluate((panel) => {
    const content = panel.firstElementChild;
    const row = panel.querySelector('[data-channel-id="alpha"]');
    if (!(content instanceof HTMLElement) || !(row instanceof HTMLElement))
      throw new Error("Channel sidebar geometry is unavailable");
    const handle = document.querySelector(
      '[aria-label="Resize channel sidebar"]',
    );
    if (!(handle instanceof HTMLElement))
      throw new Error("Missing sidebar gutter");
    const contentStyle = getComputedStyle(content);
    const rowStyle = getComputedStyle(row);
    const rootSize = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    return {
      panelGap: Number.parseFloat(
        getComputedStyle(panel.closest(".shell-sidebar")).marginInlineEnd,
      ),
      // The redesigned sidebar keeps a symmetric inline gutter; rows use the
      // sidebar's fixed row radius rather than a concentric panel radius.
      padding: [contentStyle.paddingRight, contentStyle.paddingLeft].map(
        Number.parseFloat,
      ),
      rowRadius: Number.parseFloat(rowStyle.borderTopLeftRadius),
      // Custom properties retain rem units; computed corner values are pixels.
      rowRadiusToken:
        Number.parseFloat(contentStyle.getPropertyValue("--radius-row")) *
        rootSize,
    };
  });
  expect(new Set(geometry.padding).size).toBe(1);
  expect(geometry.padding[0]).toBeGreaterThan(0);
  expect(geometry.rowRadius).toBe(geometry.rowRadiusToken);
  const conversation = await page
    .locator("#main-content > .panel")
    .boundingBox();
  expect(geometry.panelGap).toBe(4);
  expect(conversation).not.toBeNull();
  expect(conversation.x - (before.x + before.width)).toBeCloseTo(
    geometry.panelGap,
    0,
  );
  expect(grip.width).toBeGreaterThanOrEqual(16);
  expect(grip.height).toBeGreaterThan(500);
  // Preserve the 2px scrollbar inset plus the panel’s reserved 1px border.
  expect(before.x + before.width - (listBox.x + listBox.width)).toBeCloseTo(
    3,
    0,
  );
  await expect(handle).not.toHaveAttribute("title");
  await expect(button(page, "Alpha")).not.toHaveAttribute("title");
  await expect(handle).toHaveAttribute(
    "data-tooltip",
    "Drag to resize · Double-click to reset",
  );
  const tooltip = () =>
    handle.evaluate((element) => {
      const style = getComputedStyle(element, "::before");
      return {
        delay: style.transitionDelay,
        opacity: style.opacity,
        visibility: style.visibility,
      };
    });
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await expect.poll(async () => (await tooltip()).delay).toBe("0.6s");
  await expect.poll(tooltip).toMatchObject({
    opacity: "1",
    visibility: "visible",
  });

  await handle.press("ArrowRight");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeGreaterThan(before.width);
  const keyboardWidth = (await sidebar.boundingBox()).width;
  const movedGrip = await handle.boundingBox();
  await page.mouse.move(
    movedGrip.x + movedGrip.width / 2,
    movedGrip.y + movedGrip.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    movedGrip.x + movedGrip.width / 2 + 120,
    movedGrip.y + movedGrip.height / 2,
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const hovered = document.querySelector(":hover");
        return hovered ? getComputedStyle(hovered).cursor : undefined;
      }),
    )
    .toBe("col-resize");
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeGreaterThan(keyboardWidth + 100);
  const resized = await sidebar.boundingBox();
  await openPage(page, "Projects");
  await openPage(page, "Messages");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(resized.width, 0);

  await handle.dblclick();
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(260, 0);

  await handle.press("Home");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(220, 0);
  await handle.press("End");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(520, 0);
  const wideViewport = page.viewportSize();
  await page.setViewportSize({ width: 800, height: wideViewport.height });
  const constrained = await sidebar.boundingBox();
  expect(constrained.width).toBeLessThan(520);
  await expect(handle).toHaveAttribute(
    "aria-valuenow",
    String(Math.round(constrained.width)),
  );

  await page.setViewportSize(wideViewport);
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(520, 0);
  await page.setViewportSize({ width: 800, height: wideViewport.height });
  await handle.press("ArrowLeft");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeLessThan(constrained.width - 8);
  await handle.press("End");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(constrained.width, 0);
  const constrainedGrip = await handle.boundingBox();
  await page.mouse.move(
    constrainedGrip.x + constrainedGrip.width / 2,
    constrainedGrip.y + constrainedGrip.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    constrainedGrip.x + constrainedGrip.width / 2 - 32,
    constrainedGrip.y + constrainedGrip.height / 2,
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeLessThan(constrained.width - 24);
  const explicitlyResized = await sidebar.boundingBox();
  await page.setViewportSize(wideViewport);
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(explicitlyResized.width, 0);
});

sessionSidebar(
  "legacy child sessions do not add disclosure rows to channels",
  async ({ page, app }) => {
    await page.goto(app.origin);
    await openPage(page, "Messages");
    const parent = page.locator(`[data-channel-id="${sessionParent}"]`);
    await expect(parent).toBeVisible();
    await expect(page.locator('[data-channel-id="alpha"]')).toBeVisible();
    await expect(page.getByRole("button", { name: /sessions in/ })).toHaveCount(
      0,
    );
    await parent.click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "New session", exact: true }),
    ).toHaveCount(0);
  },
);

sessionSidebar(
  "Channels opens the shared creation dialog without nested session rows",
  async ({ page, app }) => {
    await page.goto(app.origin);
    await openPage(page, "Messages");
    await expect(page.locator('[data-channel-id="alpha"]')).toBeVisible();

    await openPage(page, "Projects");
    await expect(
      page.getByRole("heading", { name: "Projects", exact: true }),
    ).toBeVisible();
    const channels = page
      .getByRole("navigation", { name: "Subscribed channels" })
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: /^Channels$/ }) });
    const summary = channels.locator("summary");
    const create = page.getByRole("button", { name: "Create channel" });
    const createContainer = create.locator("..");
    await expect(createContainer).toHaveCSS("opacity", "0");
    await summary.hover();
    await expect(createContainer).toHaveCSS("opacity", "1");
    await expect(create).toHaveAttribute("data-icon-shape", "control");
    const [summaryBox, createBox] = await Promise.all([
      summary.boundingBox(),
      create.boundingBox(),
    ]);
    expect(summaryBox.x + summaryBox.width).toBeCloseTo(
      createBox.x + createBox.width + 4,
      0,
    );
    await create.click();

    const dialog = page.getByRole("dialog", { name: "Create a channel" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Name" })).toBeFocused();
    await expect(dialog.getByRole("radio", { name: /Ongoing/ })).toBeChecked();
    await expect(
      dialog.getByRole("switch", { name: "Private" }),
    ).not.toBeChecked();
    await expect(
      dialog.getByRole("textbox", { name: "Description" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Add a description" }),
    ).toHaveCount(0);
    const formTypography = await Promise.all(
      [
        dialog.getByText("Description", { exact: true }),
        dialog.getByText("Name", { exact: true }),
        dialog.getByText("Private", { exact: true }),
        dialog.getByText("Ongoing", { exact: true }),
      ].map((element) =>
        element.evaluate((node) => {
          const style = getComputedStyle(node);
          return { color: style.color, fontSize: style.fontSize };
        }),
      ),
    );
    const placeholderColor = await dialog
      .getByRole("textbox", { name: "Name" })
      .evaluate((node) => getComputedStyle(node, "::placeholder").color);
    const tertiaryColor = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--text-tertiary)";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    expect(formTypography[0].color).toBe(formTypography[1].color);
    expect(placeholderColor).toBe(tertiaryColor);
    expect(formTypography[2].fontSize).toBe(formTypography[3].fontSize);
    await page.keyboard.press("Tab");
    await expect(
      dialog.getByRole("textbox", { name: "Description" }),
    ).toBeFocused();
    await dialog.getByRole("radio", { name: /Temporary/ }).click();
    await expect(
      dialog.getByRole("radio", { name: /Temporary/ }),
    ).toBeChecked();
    await dialog.getByRole("switch", { name: "Private" }).click();
    await page
      .getByRole("dialog", { name: "Make channel private?" })
      .getByRole("button", { name: "Continue" })
      .click();
    await expect(dialog.getByRole("switch", { name: "Private" })).toBeChecked();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toHaveCount(0);
    await page
      .locator(".buzz-dialog-backdrop")
      .click({ position: { x: 8, y: 8 } });
    const discard = page.getByRole("dialog", { name: "Discard changes?" });
    await expect(
      discard.getByRole("button", { name: "Keep editing" }),
    ).toBeFocused();
    await discard.getByRole("button", { name: "Keep editing" }).click();
    await expect(dialog.getByRole("switch", { name: "Private" })).toBeChecked();
    await expect(
      dialog.getByRole("radio", { name: /Temporary/ }),
    ).toBeChecked();
    await dialog
      .getByRole("button", { name: "Close channel creation" })
      .click();
    await discard.getByRole("button", { name: "Discard changes" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(create).toBeFocused();
    await expect(
      page.getByRole("heading", { name: "Projects", exact: true }),
    ).toBeVisible();
    await openPage(page, "Messages");
    const conversation = page.getByRole("article", { name: "Conversation" });
    await conversation.click({ position: { x: 20, y: 20 } });
    await expect(create).not.toBeFocused();
    await expect(createContainer).toHaveCSS("opacity", "0");
  },
);

test("disabling Sessions keeps independent lifecycle actions available", async ({
  page,
  app,
}) => {
  await open(page, app);
  await button(page, "Alpha").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Actions for Alpha" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "New session" })).toHaveCount(
    0,
  );
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await button(page, "Plugins").click();
  const plugins = page.getByRole("region", { name: "Plugins", exact: true });
  const toggle = plugins.getByRole("switch", {
    name: "Enable Sessions",
    exact: true,
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  await openPage(page, "Messages");
  // Lifecycle is independent of Sessions and retains its unavailable-host explanation.
  for (const keyboard of [false, true]) {
    if (keyboard) {
      await button(page, "Alpha").focus();
      await page.keyboard.press("Shift+F10");
    } else await button(page, "Alpha").click({ button: "right" });
    await expect(menu).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "New session" }),
    ).toHaveCount(0);
    await expect(
      menu.getByRole("menuitem", {
        name: "Channel actions unavailable on this connection",
      }),
    ).toBeVisible();
    await expect(menu.getByRole("separator")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(button(page, "Alpha")).toBeFocused();
  }
});

test("channel navigation preserves sidebar DOM and group state", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const node = await sidebar.elementHandle();
  await expect(
    page.getByRole("searchbox", { name: "Search channels" }),
  ).toHaveCount(0);
  await button(page, "Beta").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  expect(await node.evaluate((element) => element.isConnected)).toBe(true);
  const group = sidebar
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Channels$/ }) });
  await group.locator("summary").click();
  await expect(group).not.toHaveAttribute("open");
  await button(page, "Go back").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  expect(await node.evaluate((element) => element.isConnected)).toBe(true);
  await expect(group).not.toHaveAttribute("open");
  await button(page, "Go forward").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  expect(await node.evaluate((element) => element.isConnected)).toBe(true);
  await expect(group).not.toHaveAttribute("open");
});

test("navigation reveals the current sidebar entry without moving a visible one", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const scrollTop = () => sidebar.evaluate((element) => element.scrollTop);
  const toBottom = () =>
    sidebar.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
  const alpha = sidebar.locator('[data-channel-id="alpha"]');
  const projects = page
    .getByRole("navigation", { name: "Pages" })
    .getByRole("button", { name: "Projects", exact: true });
  const group = sidebar
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Channels$/ }) });
  await expect(alpha).toHaveAttribute("aria-current", "page");
  expect(await toBottom()).toBeGreaterThan(100);
  await expect(alpha).not.toBeInViewport();
  // Search navigation reveals a page entry.
  await openPage(page, "Projects");
  await expect(projects).toHaveAttribute("aria-current", "page");
  await expect(projects).toBeInViewport({ ratio: 1 });
  // History navigation reveals a channel row.
  await toBottom();
  await button(page, "Go back").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await expect(alpha).toBeInViewport({ ratio: 1 });
  // An already visible entry keeps the user's scroll position.
  const settled = await scrollTop();
  await button(page, "Beta").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  expect(await scrollTop()).toBe(settled);
  // A destination without its own entry leaves the list alone; leaving it
  // still reveals the entry the user scrolled away from.
  await sidebar
    .locator("summary")
    .filter({ hasText: /^Direct messages$/ })
    .hover();
  await sidebar
    .getByRole("button", { name: "New message", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "New message", exact: true }),
  ).toBeVisible();
  const composing = await toBottom();
  expect(await scrollTop()).toBe(composing);
  await button(page, "Go back").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await expect(sidebar.locator('[data-channel-id="beta"]')).toBeInViewport({
    ratio: 1,
  });
  // A collapsed section reveals its header and stays collapsed.
  await group.locator("summary").click();
  await expect(group).not.toHaveAttribute("open");
  await toBottom();
  await button(page, "Go back").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await expect(group).not.toHaveAttribute("open");
  await expect(group.locator("summary")).toBeInViewport({ ratio: 1 });
});

// The closed narrow drawer is display: none, and opening it does not
// rerender the sidebar, so a reveal that waited for layout must retry then.
test("a reveal while the narrow drawer is closed runs when the drawer opens", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page.setViewportSize({ width: 600, height: 700 });
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  // Role queries skip the hidden drawer; this locator does not.
  const alpha = page.locator(
    'nav[aria-label="Subscribed channels"] [data-channel-id="alpha"]',
  );
  await openPage(page, "Projects");
  await button(page, "Show navigation").click();
  await expect(sidebar).toBeVisible();
  const bottom = await sidebar.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  expect(bottom).toBeGreaterThan(100);
  await button(page, "Hide navigation").click();
  await expect(sidebar).toBeHidden();
  await button(page, "Go back").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await expect(alpha).toHaveAttribute("aria-current", "page");
  await button(page, "Show navigation").click();
  await expect(alpha).toBeInViewport({ ratio: 1 });
});

for (const destination of [
  "Projects",
  "Agents",
  "Workflows",
  "Settings",
  "Back/Forward",
]) {
  test(`sidebar state survives Messages → ${destination} → Messages`, async ({
    page,
    app,
  }) => {
    await open(page, app);
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
    });
    const group = sidebar
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: /^Channels$/ }) });
    const node = await sidebar.elementHandle();
    const toBottom = () =>
      sidebar.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        return element.scrollTop;
      });
    const pageEntry = (name) =>
      page
        .getByRole("navigation", { name: "Pages" })
        .getByRole("button", { name, exact: true });
    const leave = async () => {
      if (destination === "Settings") {
        await button(page, "Your profile").click();
        await page
          .getByRole("menuitem", { name: "Settings", exact: true })
          .click();
        await expect(
          page.getByRole("complementary", {
            name: "Settings sidebar",
            exact: true,
          }),
        ).toBeVisible();
      } else {
        await openPage(
          page,
          destination === "Back/Forward" ? "Projects" : destination,
        );
      }
      if (destination === "Settings") {
        await expect(sidebar).toHaveCount(0);
        expect(await node.evaluate((element) => element.isConnected)).toBe(
          false,
        );
      } else {
        await expect(sidebar).toBeVisible();
        expect(await node.evaluate((element) => element.isConnected)).toBe(
          true,
        );
        await expect(
          pageEntry(destination === "Back/Forward" ? "Projects" : destination),
        ).toBeInViewport({ ratio: 1 });
        await toBottom();
      }
      await expect(
        page.getByRole("region", { name: "Channel message history" }),
      ).toHaveCount(0);
      if (destination === "Back/Forward") await button(page, "Go back").click();
      else if (destination === "Settings")
        await page
          .getByRole("complementary", { name: "Settings sidebar" })
          .getByRole("button", { name: "Back", exact: true })
          .click();
      else await openPage(page, "Messages");
    };
    await group.locator("summary").click();
    await expect(group).not.toHaveAttribute("open");
    const scroll = await toBottom();
    expect(scroll).toBeGreaterThan(100);
    await leave();
    await expect(group).not.toHaveAttribute("open");
    if (destination === "Settings")
      // Settings replaces the sidebar; returning to the same channel restores
      // the saved position instead of revealing it again.
      await expect
        .poll(() => sidebar.evaluate((element) => element.scrollTop))
        .toBeCloseTo(scroll, 0);
    // The current channel is in the collapsed group; its header shows it.
    else await expect(group.locator("summary")).toBeInViewport({ ratio: 1 });
    if (destination === "Back/Forward") {
      await button(page, "Go forward").click();
      await expect(sidebar).toBeVisible();
      expect(await node.evaluate((element) => element.isConnected)).toBe(true);
      await expect(
        page.getByRole("region", { name: "Channel message history" }),
      ).toHaveCount(0);
      await expect(pageEntry("Projects")).toBeInViewport({ ratio: 1 });
      await toBottom();
      await button(page, "Go back").click();
      await expect(group).not.toHaveAttribute("open");
      await expect(group.locator("summary")).toBeInViewport({ ratio: 1 });
    }
  });
}

test("community rail stays visible across pages and switches without a picker", async ({
  page,
  app,
}) => {
  await open(page, app);
  const rail = page.getByRole("navigation", {
    name: "Communities",
    exact: true,
  });
  await expect(
    rail.getByRole("button", { name: "Switch to Primary" }),
  ).toHaveAttribute("aria-current", "true");
  await rail.getByRole("button", { name: "Switch to Secondary" }).click();
  await expect(
    rail.getByRole("button", { name: "Switch to Secondary" }),
  ).toHaveAttribute("aria-current", "true");
  await openPage(page, "Projects");
  await expect(rail).toBeVisible();
  await expect(button(page, "Switch community")).toHaveCount(0);
  await rail.getByRole("button", { name: "Personal space" }).click();
  await expect(
    rail.getByRole("button", { name: "Personal space" }),
  ).toHaveAttribute("aria-current", "true");
  await rail.getByRole("button", { name: "Add a community" }).click();
  await expect(
    page.getByRole("heading", { name: "Add a community", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    rail.getByRole("button", { name: "Add a community" }),
  ).toBeFocused();
});

test("sidebar view state does not leak across communities", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const group = sidebar
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Channels$/ }) });
  await group.locator("summary").click();
  await expect(group).not.toHaveAttribute("open");
  await button(page, "Switch to Secondary").click();
  await expect(button(page, "Switch to Secondary")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(group).toHaveAttribute("open");
  await button(page, "Switch to Primary").click();
  await expect(group).not.toHaveAttribute("open");
});

test("legacy filters are ignored and invalid saved sidebar fields fall back", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const group = sidebar.locator("details").first();
  await group.locator("summary").click();
  await button(page, "Switch to Secondary").click();
  await expect(button(page, "Switch to Secondary")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) =>
      key.includes('"channel-sidebar"'),
    );
    if (!key)
      throw new Error("Sidebar state was not saved on leaving its session");
    localStorage.setItem(
      key,
      JSON.stringify({
        search: "missing-channel",
        collapsed: [null, 42],
        scrollTop: -100,
        width: "wide",
      }),
    );
  });
  await button(page, "Switch to Primary").click();
  await expect(button(page, "Switch to Primary")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(
    page.getByRole("searchbox", { name: "Search channels" }),
  ).toHaveCount(0);
  await expect(button(page, "Beta")).toBeVisible();
  await expect(sidebar.locator("details").first()).toHaveAttribute("open");
  expect(await sidebar.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
});

test("rail loads relay-owned image icons for inactive communities without acquiring sessions", async ({
  page,
  app,
}) => {
  const rasterIcon =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y79d4sAAAAASUVORK5CYII=";
  const emojiSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#ffe75c"/><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-size="258">🐝</text></svg>';
  const emojiIcon = `data:image/svg+xml,${encodeURIComponent(emojiSvg)}`;
  const infoRequests = [];
  await page.route("**/api/relay/*/icon-info", (route) => {
    infoRequests.push(route.request().url());
    const icon = route.request().url().includes("primary")
      ? rasterIcon
      : emojiIcon;
    return route.fulfill({ json: { icon } });
  });
  await open(page, app);
  const rail = page.getByRole("navigation", { name: "Communities" });
  for (const [name, icon] of [
    ["Primary", rasterIcon],
    ["Secondary", emojiIcon],
  ]) {
    const image = rail
      .getByRole("button", { name: `Switch to ${name}` })
      .locator("img");
    await expect(image).toHaveAttribute("src", icon);
    await expect(image).toHaveAttribute("data-loaded", "true");
  }
  expect(infoRequests).toHaveLength(2);
  expect(app.report.sessions).toEqual(["primary"]);
});

// Same-page navigation must update the remembered selection without a remount.
test("Messages reselects the latest sidebar channel and keyboard page search focuses main", async ({
  page,
  app,
}) => {
  await open(page, app);
  await button(page, "Beta").click();
  const composer = page.getByRole("textbox", {
    name: "Message #Beta",
    exact: true,
  });
  await expect(composer).toBeVisible();
  await button(page, "Search Buzz").focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Search Buzz", exact: true });
  const search = dialog.getByRole("combobox", { name: "Search Buzz" });
  await expect(search).toBeFocused();
  await search.pressSequentially("Messages");
  await expect(
    dialog.getByRole("option", { name: "Messages", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await search.press("Enter");
  await expect(composer).toBeVisible();
  await expect(page.locator('button[data-channel-id="beta"]')).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.locator("#main-content")).toBeFocused();
});
