import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";

test.use({
  productionBroker: true,
  dmLabels: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 3, beta: 1 },
});

// Native Tab must discover deferred controls before the browser chooses focus;
// continuation rows have no avatar that could activate them on the way in.
for (const direction of ["forward", "backward"]) {
  test(`Tab enters untouched continuation actions ${direction} without an extra stop`, async ({
    page,
    app,
  }) => {
    await open(page, app);
    await page
      .getByRole("textbox", { name: "Message #Alpha", exact: true })
      .click();
    await page.mouse.move(0, 0);
    const before = app.append(
      "primary",
      "alpha",
      "[Before](https://example.com/before)",
    );
    const target = app.append("primary", "alpha", "Untouched continuation");
    const after = app.append(
      "primary",
      "alpha",
      "Following author",
      true,
      false,
    );
    const row = (event) =>
      page.locator(`[data-channel-timeline] [data-message-id="${event.id}"]`);
    await expect(
      row(target).locator('[data-layout="continuation"]'),
    ).toBeVisible();
    await expect(row(after)).toBeVisible();
    await settle(page);
    const actions = row(target).getByRole("group", {
      name: "Message actions",
      includeHidden: true,
    });
    await expect(
      actions.getByRole("button", { includeHidden: true }),
    ).toHaveCount(0);
    if (direction === "forward")
      await row(before)
        .getByRole("link", { name: "Before", exact: true })
        .focus();
    else
      await row(after)
        .getByRole("button", { name: /^View .* profile$/ })
        .first()
        .focus();
    await expect(
      actions.getByRole("button", { includeHidden: true }),
    ).toHaveCount(0);
    await page.keyboard.press(direction === "forward" ? "Tab" : "Shift+Tab");
    await expect(
      actions.getByRole("button", {
        name:
          direction === "forward" ? "React with 👍" : "More message actions",
        exact: true,
      }),
    ).toBeFocused();
    await page.keyboard.press(direction === "forward" ? "Tab" : "Shift+Tab");
    await expect(
      actions.getByRole("button", {
        name: direction === "forward" ? "React with ❤️" : "Copy link",
        exact: true,
      }),
    ).toBeFocused();
  });
}

// Browser-only contracts: actual hover/coarse-pointer layout, portal focus return,
// and opening a real thread then focusing its real editor. Clipboard failures and
// mention matrices live in colocated unit tests, not a browser scenario matrix.
test("message actions reveal, copy, restore focus and reply across responsive layouts", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    window.copiedMessages = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.copiedMessages.push(text);
        },
      },
    });
  });
  await open(page, app);
  const event = app.append("primary", "alpha", "Message actions browser check");
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  await expect(row).toBeVisible();
  const actions = row.getByRole("group", { name: "Message actions" });
  await page.mouse.move(0, 0);
  await expect(actions).toHaveCSS("opacity", "0");
  await row.hover();
  await expect(actions).toHaveCSS("opacity", "1");
  const trigger = row.getByRole("button", { name: "More message actions" });
  await trigger.focus();
  await trigger.press("Enter");
  await expect(
    page.getByRole("menuitem", { name: "Copy message", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page
    .getByRole("menuitem", { name: "Copy message", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "App notifications" })
      .getByText("Message copied", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.copiedMessages)).toEqual([
    event.content,
  ]);
  await row.hover();
  await row.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "App notifications" })
      .getByText("Link copied", { exact: true }),
  ).toBeVisible();
  const copiedLink = await page.evaluate(() => window.copiedMessages.at(-1));
  expect(copiedLink).toBe(`buzz://message?channel=alpha&id=${event.id}`);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const root = panel.locator(`[data-message-id="${event.id}"]`);
  await expect(root).toBeVisible();
  // A pointer click leaves focus on the control; the bar still follows hover.
  const copyLink = row.getByRole("button", { name: "Copy link", exact: true });
  await row.hover();
  await copyLink.click();
  await root.hover();
  await expect(actions).toHaveCSS("opacity", "0");
  // Tab only exercises the keyboard path if focus is still on Copy link, so
  // it lands on the row's next control. Copy link is briefly disabled while
  // copying, which would otherwise let focus fall back to the body.
  await expect(copyLink).toBeFocused();
  // Keyboard focus still reveals it while the mouse is elsewhere.
  await page.keyboard.press("Tab");
  await expect(actions).toHaveCSS("opacity", "1");
  // Assistive presses arrive without navigation keydowns; focus alone reveals
  // the bar. Clicking plain text first clears the keyboard-modality flag.
  const menu = page.getByRole("menu");
  await row.getByText(event.content, { exact: true }).click();
  await page.mouse.move(0, 0);
  await trigger.focus();
  // Script focus after a pointer click stays quiet.
  await expect(actions).toHaveCSS("opacity", "0");
  await trigger.press("Enter");
  await expect(
    page.getByRole("menuitem", { name: "Copy message", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(actions).toHaveCSS("opacity", "1");
  // Keyboard dismissal restores focus even when the menu was pointer-opened.
  // Waiting for deferred initial focus keeps Escape off the trigger.
  await row.hover();
  await trigger.click();
  await expect(menu).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.mouse.move(0, 0);
  await expect(actions).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  // Keyboard opening focuses the first item; Mark unread leads a managed row.
  await expect(
    page.getByRole("menuitem", { name: "Mark unread", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  // Pointer-only selection still leaves the bar free to follow hover.
  await row.hover();
  await trigger.click();
  await expect(menu).toBeFocused();
  await page
    .getByRole("menuitem", { name: "Copy message", exact: true })
    .click();
  await expect(menu).toHaveCount(0);
  await expect(trigger).not.toBeFocused();
  await page.mouse.move(0, 0);
  await expect(actions).toHaveCSS("opacity", "0");
  await root.hover();
  await root
    .getByRole("button", { name: "React with 👍", exact: true })
    .click();
  await expect(
    root.getByRole("button", {
      name: "👍: 1 person, including you",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    row.getByRole("button", {
      name: "👍: 1 person, including you",
      exact: true,
    }),
  ).toBeVisible();
  await root
    .getByRole("button", { name: "👍: 1 person, including you", exact: true })
    .click();
  await expect(root.getByRole("button", { name: /👍: 1/ })).toHaveCount(0);
  await expect(row.getByRole("button", { name: /👍: 1/ })).toHaveCount(0);
  await expect
    .poll(
      () =>
        app.report.publications.filter(({ event }) => event.kind === 5).length,
    )
    .toBe(1);
  const added = app.report.publications.find(
    ({ event }) => event.kind === 7,
  ).event;
  const removed = app.report.publications.find(
    ({ event }) => event.kind === 5,
  ).event;
  expect(added.tags).toContainEqual(["e", event.id]);
  expect(removed.tags).toContainEqual(["e", added.id]);
  expect(removed.pubkey).toBe(added.pubkey);
  await root.hover();
  await root.getByRole("button", { name: "Reply", exact: true }).click();
  const replyBox = panel.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await expect(replyBox).toBeFocused();
  await replyBox.fill("Keep this reply draft");
  await row.hover();
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(replyBox).toBeFocused();
  await expect(replyBox).toHaveText("Keep this reply draft");
  await root.hover();
  await root.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(
    panel.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeFocused();
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"]), button[aria-label="Close thread"]',
    )
    .click();
  await expect(
    row.getByRole("button", { name: "Reply", exact: true }),
  ).toBeFocused();

  // A broadcast reply must open its owning thread for composition, not reveal
  // the selected reply and steal focus back from the editor.
  const broadcast = app.histories
    .get("primary/alpha")
    .find((item) => item.content === "Broadcast reply");
  if (!broadcast) throw new Error("Expected broadcast reply fixture");
  const broadcastRow = page.locator(
    `[data-channel-timeline] [data-message-id="${broadcast.id}"]`,
  );
  // Closing retains the split until its transition finishes. Establish the
  // final row geometry before placing the pointer over the next message.
  await expect(page.locator("[data-panel-dock][data-closing]")).toHaveCount(0);
  await broadcastRow.hover();
  await broadcastRow
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  await expect(replyBox).toBeFocused();
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"]), button[aria-label="Close thread"]',
    )
    .click();
  await broadcastRow.getByRole("button", { name: /^View thread:/ }).click();
  await expect(
    panel.locator(`[data-message-id="${broadcast.id}"]`),
  ).toBeFocused();
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"]), button[aria-label="Close thread"]',
    )
    .click();
  for (const width of [900, 603, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await row.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await page.mouse.click(0, 0);
    await expect(actions).toHaveCSS("opacity", "0");
    await row.hover();
    await expect(actions).toHaveCSS("opacity", "1");
    await expect(
      row.getByRole("button", { name: "Copy link", exact: true }),
    ).toBeVisible();
    await trigger.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const bounds = await menu.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    // Escape starts the exit; its deferred focus return must finish before the
    // next resize/pointer transition, or that old return can reopen the bar.
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  await page.screenshot({
    path: test.info().outputPath("message-actions-narrow.png"),
  });
});

// Browser-only: clipboard -> rendered Markdown -> cross-conversation navigation
// must finish with the actual virtual row visible and focused.
test("copied Buzz links and the desktop alias reveal their destination from a conversation", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.copiedMessageLink = text;
        },
      },
    });
  });
  await open(page, app);
  const event = app.append("primary", "alpha", "Shared destination");
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  await row.hover();
  await row.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "App notifications" })
      .getByText("Link copied", { exact: true }),
  ).toBeVisible();
  const copiedLink = await page.evaluate(() => window.copiedMessageLink);
  expect(copiedLink).toBe(`buzz://message?channel=alpha&id=${event.id}`);
  const sharedConversation = page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Alice Fixture", exact: true });
  await sharedConversation.click();
  const sharedChannel = await page
    .locator("[data-channel-timeline]")
    .getAttribute("data-channel-timeline");
  app.append(
    "primary",
    sharedChannel,
    `${copiedLink}\n\n[Desktop alias](buzz://channel/alpha/${event.id})`,
  );
  for (const href of [copiedLink, `buzz://channel/alpha/${event.id}`]) {
    await sharedConversation.click();
    await page.locator(`[data-channel-timeline] a[href="${href}"]`).click();
    await expect(row).toBeVisible();
    await expect(row).toBeFocused();
  }
});

test("DM actions open the correct reply thread", async ({ page, app }) => {
  await open(page, app);
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Alice Fixture", exact: true })
    .click();
  const timeline = page.locator("[data-channel-timeline]");
  const channel = await timeline.getAttribute("data-channel-timeline");
  const event = app.append("primary", channel, "DM menu check");
  const row = timeline.locator(`[data-message-id="${event.id}"]`);
  await row.hover();
  await row.getByRole("button", { name: "React with 👍", exact: true }).click();
  await expect(
    row.getByRole("button", {
      name: "👍: 1 person, including you",
      exact: true,
    }),
  ).toBeVisible();
  await row
    .getByRole("button", { name: "👍: 1 person, including you", exact: true })
    .click();
  await expect(row.getByRole("button", { name: /👍: 1/ })).toHaveCount(0);
  await expect
    .poll(
      () =>
        app.report.publications.filter(({ event }) => event.kind === 5).length,
    )
    .toBe(1);
  const added = app.report.publications.find(
    ({ event }) => event.kind === 7,
  ).event;
  const removed = app.report.publications.find(
    ({ event }) => event.kind === 5,
  ).event;
  expect(added.tags).toContainEqual(["e", event.id]);
  expect(removed.tags).toContainEqual(["e", added.id]);
  expect(removed.pubkey).toBe(added.pubkey);
  await row.hover();
  await row.getByRole("button", { name: "More message actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Copy message", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(
    page
      .getByRole("complementary", { name: "Thread", exact: true })
      .locator(`[data-message-id="${event.id}"]`),
  ).toBeVisible();
  const replyBox = page.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await expect(replyBox).toBeFocused();
  await row.hover();
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(replyBox).toBeFocused();
});

test.describe("touch", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 850 } });
  test("opens the message menu without hover", async ({ page, app }) => {
    await open(page, app);
    const event = app.append("primary", "alpha", "Touch menu check");
    const row = page.locator(
      `[data-channel-timeline] [data-message-id="${event.id}"]`,
    );
    const actions = row.getByRole("group", { name: "Message actions" });
    await expect(actions).toHaveCSS("opacity", "1");
    await row.getByRole("button", { name: "More message actions" }).tap();
    await expect(
      page.getByRole("menuitem", { name: "Copy message", exact: true }),
    ).toBeVisible();
  });
});

// Native geometry and hit testing protect prose/link access while controls reveal.
test("narrow timeline continuation actions never cover prose or move adjacent rows", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 900, height: 950 });
  await open(page, app);
  app.append("primary", "alpha", "Start a compact group");
  const event = app.append(
    "primary",
    "alpha",
    "Read [this reference](https://example.com/reference)",
  );
  const next = app.append("primary", "alpha", "Next message");
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  const following = page.locator(
    `[data-channel-timeline] [data-message-id="${next.id}"]`,
  );
  await expect(row.locator('[data-layout="continuation"]')).toBeVisible();
  await expect(following).toBeVisible();
  const actions = row.getByRole("group", { name: "Message actions" });
  const link = row.getByRole("link", { name: /this reference/ });
  await page.mouse.move(0, 0);
  await expect(actions).toHaveCSS("opacity", "0");
  await settle(page);
  const expectClockAligned = async () => {
    // The caption-sized clock is centered beside the first prose line, including
    // when interface scaling changes their independently owned type roles.
    await expect
      .poll(() =>
        row.evaluate((element) => {
          const clock = element
            .querySelector('time > span[aria-hidden="true"]')
            .getBoundingClientRect();
          const prose = element.querySelector("p");
          const firstLineCenter =
            prose.getBoundingClientRect().top +
            Number.parseFloat(getComputedStyle(prose).lineHeight) / 2;
          return Math.abs(clock.top + clock.height / 2 - firstLineCenter);
        }),
      )
      .toBeLessThan(0.5);
  };
  const baseline = await following.boundingBox();
  for (const mode of ["hover", "focus"]) {
    if (mode === "hover") await row.hover();
    else {
      await page.mouse.move(0, 0);
      await row.getByRole("button", { name: "More message actions" }).focus();
    }
    await expect(actions).toHaveCSS("opacity", "1");
    const prose = await row.locator("p").first().boundingBox();
    const toolbar = await actions.boundingBox();
    expect(toolbar.y + toolbar.height).toBeLessThanOrEqual(prose.y);
    await expect(actions).toHaveCSS("position", "fixed");
    expect((await following.boundingBox()).y).toBe(baseline.y);
    await expectClockAligned();
    await expect
      .poll(() =>
        link.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return node.contains(
            document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            ),
          );
        }),
      )
      .toBe(true);
  }
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "2"),
  );
  await row.scrollIntoViewIfNeeded();
  await settle(page);
  await expectClockAligned();
});

test("historical single-day DMs and their threads expose dates without hover", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Alice Fixture", exact: true })
    .click();
  const timeline = page.locator("[data-channel-timeline]");
  const channel = await timeline.getAttribute("data-channel-timeline");
  const event = app.append("primary", channel, "Historical message");
  const row = timeline.locator(`[data-message-id="${event.id}"]`);
  await expect(row).toBeVisible();
  const day = await page.evaluate((seconds) => {
    const date = new Date(seconds * 1000);
    return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
      .map((part) => String(part).padStart(2, "0"))
      .join("-");
  }, event.created_at);
  await page.mouse.move(0, 0);
  await expect(timeline.locator(`[data-day="${day}"]`)).toBeVisible();
  await expect(
    timeline.getByRole("button", { name: "Load older messages" }),
  ).toHaveCount(0);
  const reply = row.getByRole("button", { name: "Reply", exact: true });
  // Start real keyboard navigation so the untouched row prepares its controls.
  await page.keyboard.press("Tab");
  await reply.focus();
  await reply.press("Enter");
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(thread.locator(`[data-day="${day}"]`)).toBeVisible();
});
