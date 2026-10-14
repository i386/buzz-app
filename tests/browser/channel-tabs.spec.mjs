import { openChannelDetails } from "./channel-details.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { openPage, settlePanelMotion } from "./navigation.mjs";

test.use({
  productionBroker: true,
  readState: true,
  sessionChannels: ["beta"],
  historyCounts: { alpha: 2, beta: 1 },
});

// Real content links, two independent editors, browser focus and signed routing
// prove the retained tab path without a test-only way to manufacture tabs.
test("content-opened tabs restore drafts without offering blank-tab creation", async ({
  page,
  app,
}) => {
  await open(page, app);
  const main = page.getByRole("article", { name: "Conversation", exact: true });
  const workspace = page.locator("[data-panel-workspace]");
  const split = page.getByRole("button", {
    name: "Toggle tab pane",
    exact: true,
  });
  await expect(split).toHaveAttribute("aria-disabled", "true");
  await split.focus();
  await split.press("Enter");
  await expect(workspace).toHaveCount(0);
  const fullWidth = (await main.boundingBox()).width;
  const link = app.append(
    "primary",
    "alpha",
    "[Open Beta](buzz://channel/beta)",
  );
  const chip = main
    .locator(`[data-message-id="${link.id}"]`)
    .getByRole("link", { name: "Open Beta" });
  await expect(chip).toBeVisible();
  await main
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .fill("Alpha draft");
  await openChannelDetails(page);
  await chip.click();
  const beta = workspace.getByRole("region", {
    name: "Conversation in Beta",
    exact: true,
  });
  const composer = beta.getByRole("textbox", {
    name: "Message this session",
    exact: true,
  });
  await expect(composer).toBeVisible();
  await expect(
    workspace.getByRole("button", { name: "Add tab", exact: true }),
  ).toHaveCount(0);
  await expect(
    workspace.getByRole("region", { name: "Choose a tab" }),
  ).toHaveCount(0);
  await expect(
    main.getByRole("button", { name: "Toggle tab pane", exact: true }),
  ).toHaveCount(0);
  await expect(
    workspace.getByRole("button", { name: "Toggle tab pane", exact: true }),
  ).toBeVisible();
  const tabClose = workspace.getByRole("button", {
    name: "Close Beta tab",
    exact: true,
  });
  await expect(tabClose.locator("svg")).toHaveCSS("width", "16px");
  await composer.fill("Beta draft");
  await split.click();
  await expect(split).toBeFocused();
  await expect(workspace).toBeHidden();
  await expect
    .poll(async () => (await main.boundingBox()).width)
    .toBeCloseTo(fullWidth, 0);
  // An account companion is separate from this channel's hidden tabs.
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "View your profile" }).click();
  const account = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  await expect(account).toBeVisible();
  await expect(split).toHaveAttribute("aria-expanded", "false");
  await split.click();
  await expect(composer).toHaveText("Beta draft");
  await expect(account).toBeVisible();
  await account
    .getByRole("button", { name: "Close Profile panel", exact: true })
    .click();
  await openPage(page, "Settings");
  await openPage(page, "Messages");
  await expect(composer).toHaveText("Beta draft");
  await expect(
    workspace.getByRole("tab", { name: "Beta", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await split.click();
  await openPage(page, "Settings");
  await openPage(page, "Messages");
  await expect(workspace).toBeHidden();
  await expect(split).toHaveAttribute("aria-expanded", "false");
  await split.click();
  await chip.click();
  await expect(
    workspace.getByRole("tab", { name: "Beta", exact: true }),
  ).toHaveCount(1);
  await expect(composer).toHaveText("Beta draft");
  await composer.press("Enter");
  await expect
    .poll(() =>
      app.report.publications.some(
        ({ event }) =>
          event.kind === 9 &&
          event.content === "Beta draft" &&
          event.tags.some(([key, value]) => key === "h" && value === "beta"),
      ),
    )
    .toBe(true);
  const row = beta
    .locator("[data-message-id]")
    .filter({ has: page.getByText("Beta draft", { exact: true }) });
  await row.hover();
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  const reply = workspace.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await expect(reply).toBeFocused();
  await reply.fill("Beta reply draft");
  await page.locator('button[data-channel-id="beta"]').click();
  await expect(workspace).toHaveCount(0);
  await page.locator('button[data-channel-id="alpha"]').click();
  await expect(
    workspace.locator('[role="tab"][data-tab-value^="thread:beta:"]'),
  ).toHaveAttribute("aria-selected", "true");
  await expect(reply).toHaveText("Beta reply draft");
  const alphaComposer = main.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await expect(alphaComposer).toHaveText("Alpha draft");
  // Restored side content must not take focus from the main conversation.
  await expect(alphaComposer).toBeFocused();
  await workspace.getByRole("tab", { name: "Beta", exact: true }).click();
  await row.hover();
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(reply).toBeFocused();
  await expect(reply).toHaveText("Beta reply draft");
  await workspace
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:beta:"][aria-selected="true"]) > button:not([role="tab"])',
    )
    .click();
  await workspace.getByRole("tab", { name: "Beta", exact: true }).click();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, theme);
    for (const width of [1440, 800, 390]) {
      await page.setViewportSize({ width, height: 950 });
      await expect(workspace).not.toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      await expect(composer).toBeInViewport();
    }
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  app.omitChannel("beta");
  await workspace
    .getByRole("tab", { name: "Channel settings", exact: true })
    .click();
  await workspace.getByText("Diagnostics", { exact: true }).click();
  await workspace
    .getByRole("button", { name: "Refresh channels", exact: true })
    .click();
  const unavailable = workspace.getByRole("tab", {
    name: "Unavailable conversation",
    exact: true,
  });
  await expect(unavailable).toBeVisible();
  await unavailable.click();
  await expect(workspace.getByRole("status")).toHaveText(
    "This conversation is no longer available.",
  );
  await expect(composer).toHaveCount(0);
  await workspace
    .getByRole("button", {
      name: "Close Unavailable conversation tab",
      exact: true,
    })
    .click();
  await workspace
    .getByRole("button", { name: "Close Channel settings tab", exact: true })
    .click();
  await expect(workspace).toHaveCount(0);
  await expect(split).toHaveAttribute("aria-disabled", "true");
  await expect(
    page.getByRole("button", { name: "Channel actions", exact: true }),
  ).toBeFocused();
});

// Overflow and native keyboard reveal need actual tab-strip geometry. Six
// linked sessions supply real content tabs rather than removed blank tabs.
test.describe("crowded content tabs", () => {
  const ids = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"];
  test.use({
    channelIds: ids,
    sessionChannels: ids.slice(1),
    historyCounts: Object.fromEntries(ids.map((id) => [id, 1])),
  });
  test("tab overflow stays horizontal and keyboard navigation reveals its destination", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const main = page.getByRole("article", {
      name: "Conversation",
      exact: true,
    });
    const link = app.append(
      "primary",
      "alpha",
      ids
        .slice(1)
        .map((id) => `[${id}](buzz://channel/${id})`)
        .join(" "),
    );
    const row = main.locator(`[data-message-id="${link.id}"]`);
    await row.getByRole("link", { name: "beta", exact: true }).click();
    const workspace = page.locator("[data-panel-workspace]");
    const list = workspace.getByRole("tablist", { name: "Panel tabs" });
    const tabs = list.getByRole("tab");
    const header = workspace.locator(":scope > header");
    await expect(tabs).toHaveCount(1);
    await settlePanelMotion(page);
    await expect
      .poll(() => list.evaluate((el) => el.scrollWidth > el.clientWidth))
      .toBe(false);
    const initialHeader = await header.boundingBox();
    const initialTab = await tabs.first().boundingBox();
    const expectTabPosition = async () => {
      await expect
        .poll(async () => (await tabs.last().boundingBox()).y)
        .toBeCloseTo(initialTab.y, 1);
      expect((await tabs.last().boundingBox()).height).toBeCloseTo(
        initialTab.height,
        1,
      );
      expect((await header.boundingBox()).height).toBeCloseTo(
        initialHeader.height,
        1,
      );
    };
    for (const id of ids.slice(2))
      await row.getByRole("link", { name: id, exact: true }).click();
    await expect(tabs).toHaveCount(6);
    await settlePanelMotion(page);
    const activeClose = workspace.getByRole("button", {
      name: "Close eta tab",
      exact: true,
    });
    const inactiveClose = workspace.getByRole("button", {
      name: "Close zeta tab",
      exact: true,
    });
    const outside = workspace.getByRole("button", {
      name: "Toggle tab pane",
      exact: true,
    });
    const thumbColor = () =>
      list.evaluate(
        (el) =>
          getComputedStyle(el, "::-webkit-scrollbar-thumb").backgroundColor,
      );
    await outside.hover();
    await expect(activeClose).toHaveCSS("opacity", "1");
    await expect(inactiveClose).toHaveCSS("opacity", "0");
    await tabs.nth(4).hover();
    await expect(inactiveClose).toHaveCSS("opacity", "1");
    await expect(activeClose).toHaveCSS("opacity", "1");
    await outside.hover();
    await expect(inactiveClose).toHaveCSS("opacity", "0");
    await expectTabPosition();
    await expect.poll(thumbColor).toBe("rgba(0, 0, 0, 0)");
    await list.hover();
    await expect.poll(thumbColor).not.toBe("rgba(0, 0, 0, 0)");
    await expectTabPosition();
    const geometry = await list.evaluate((el) => ({
      scrollbar: el.offsetHeight - el.clientHeight,
      nativeWidth: getComputedStyle(el).scrollbarWidth,
      trackHeight: getComputedStyle(el, "::-webkit-scrollbar").height,
    }));
    expect(geometry.scrollbar).toBeLessThanOrEqual(4);
    expect(geometry.nativeWidth).toBe("auto");
    expect(geometry.trackHeight).toBe("4px");
    await expect
      .poll(() => list.evaluate((el) => el.scrollWidth > el.clientWidth))
      .toBe(true);
    await expect(list).toHaveCSS("overflow-y", "hidden");
    const height = (await list.boundingBox()).height;
    await tabs.last().press("Home");
    await expect(tabs.first()).toBeFocused();
    await expect(tabs.first()).toBeInViewport();
    await expect(
      workspace.getByRole("button", { name: "Close Beta tab", exact: true }),
    ).toHaveCSS("opacity", "1");
    await expect(list).toHaveJSProperty("scrollTop", 0);
    await expectTabPosition();
    await tabs.first().press("End");
    await expect(tabs.last()).toBeFocused();
    await expect(tabs.last()).toBeInViewport();
    await expect(list).toHaveJSProperty("scrollTop", 0);
    await expectTabPosition();
    // Keyboard focus must not keep the scrollbar visible after hover leaves.
    await outside.hover();
    await expect(tabs.last()).toBeFocused();
    await expect.poll(thumbColor).toBe("rgba(0, 0, 0, 0)");
    await expectTabPosition();
    await list.hover();
    await expect.poll(thumbColor).not.toBe("rgba(0, 0, 0, 0)");
    await expectTabPosition();
    expect((await list.boundingBox()).height).toBeCloseTo(height, 1);
    await expect(tabs.last()).toHaveAccessibleName("eta");
    await tabs.last().press("Delete");
    await expect(tabs).toHaveCount(5);
    await expect(
      list.getByRole("tab", { name: "eta", exact: true }),
    ).toHaveCount(0);
    await expect(
      list.getByRole("tab", { name: "zeta", exact: true }),
    ).toBeFocused();
    // Closing the final content tab returns focus to the empty pane toggle.
    for (let remaining = 5; remaining > 0; remaining--) {
      await tabs.first().focus();
      await tabs.first().press("Delete");
    }
    await expect(workspace).toHaveCount(0);
    const split = main.getByRole("button", {
      name: "Toggle tab pane",
      exact: true,
    });
    await expect(split).toHaveAttribute("aria-disabled", "true");
    await expect(split).toBeFocused();
    await expect(
      workspace.getByRole("button", { name: "Add tab", exact: true }),
    ).toHaveCount(0);
  });
});
