import { test, expect } from "./fixture.mjs";

const button = (page, name) => page.getByRole("button", { name, exact: true });
// The palette scales in and its content slides in after a delay. Both hold
// still at their start before moving, so Playwright's stable check can pass
// mid-entrance. Finish the entrance before measuring rows or moving the pointer.
const entered = async (dialog) => {
  await expect(dialog).not.toHaveAttribute("data-starting-style");
  await dialog.evaluate((node) =>
    Promise.all(
      node
        .getAnimations({ subtree: true })
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().endTime !== Infinity,
        )
        .map((animation) => animation.finished),
    ),
  );
};
test("search arrows traverse the conversation action and recent activity, Enter opens and Escape restores focus", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const trigger = button(page, "Search Buzz");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Search Buzz" });
  const input = dialog.getByRole("combobox", { name: "Search Buzz" });
  await expect(input).toHaveAttribute("spellcheck", "false");
  await expect(input).toHaveAttribute("autocorrect", "off");
  await expect(input).toHaveAttribute("autocapitalize", "off");
  await expect(input).toHaveAttribute("autocomplete", "off");
  await expect(input).toBeFocused();
  const first = dialog
    .getByRole("group", { name: "This conversation" })
    .getByRole("option");
  const second = dialog
    .getByRole("group", { name: "Recent activity" })
    .getByRole("option")
    .first();
  await expect(second).toBeVisible();
  for (const [key, result] of [
    ["ArrowDown", first],
    ["ArrowDown", second],
    ["ArrowUp", first],
    ["ArrowUp", first],
  ]) {
    await input.press(key);
    await expect(input).toBeFocused();
    await expect(result).toHaveAttribute("aria-selected", "true");
    await expect(result).toHaveAttribute("data-selected", "true");
    await expect(input).toHaveAttribute(
      "aria-activedescendant",
      await result.getAttribute("id"),
    );
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  const modifier = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  await page.keyboard.press(`${modifier}+k`);
  await expect(input).toBeFocused();
  await expect(input).not.toHaveAttribute("aria-activedescendant");
  await input.fill("Alpha");
  const alpha = dialog
    .getByRole("group", { name: "Channels" })
    .getByRole("option", { name: /Alpha/ });
  await expect(alpha).toBeVisible();
  // Typed text selects its best match, so Enter needs no arrow keys.
  await expect(input).toBeFocused();
  await expect(alpha).toHaveAttribute("aria-selected", "true");
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    await alpha.getAttribute("id"),
  );
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
});

test("changing search scope returns focus to the input without clearing the query", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await button(page, "Search Buzz").click();
  const scopeAction = page
    .getByRole("dialog", { name: "Search Buzz" })
    .getByRole("group", { name: "This conversation" })
    .getByRole("option");
  await scopeAction.click();

  const scoped = page.getByRole("dialog", { name: "Search this conversation" });
  const scopedInput = scoped.getByRole("combobox", {
    name: "Search this conversation",
  });
  await expect(scopedInput).toBeFocused();
  await page.keyboard.type("hello");
  await expect(scopedInput).toHaveValue("hello");

  const chip = scoped.getByRole("button", {
    name: /Remove .* search scope/,
  });
  await chip.focus();
  await chip.press("Enter");
  const global = page.getByRole("dialog", { name: "Search Buzz" });
  const input = global.getByRole("combobox", { name: "Search Buzz" });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("hello");
  // Typed text selects the first result; no conversation is named "hello".
  await expect(
    global
      .getByRole("group", { name: "This conversation" })
      .getByRole("option"),
  ).toHaveAttribute("aria-selected", "true");
});

// Real portal → routed timeline/thread ownership and focus, in both browser engines.
test.describe("public search destination", () => {
  test.use({ openSearch: true, productionBroker: true });
  test("opens a public nonmember exact reply without enabling writes or adding a sidebar row", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    // Waiting for a rendered conversation is an ordering mitigation for the
    // WebKit lost-fill failure. Its root cause is unknown, and the failing
    // schedule has not been reproduced against this change.
    await expect(page.locator("[data-message-id]").first()).toBeVisible();
    let previewSurface;
    for (const mode of ["cold", "warm"]) {
      await button(page, "Search Buzz").click();
      const input = page.getByRole("combobox", { name: "Search Buzz" });
      await input.fill("crew-search");
      await expect(input).toHaveValue("crew-search");
      const result = page.getByRole("option", {
        name: /crew-search exact public reply/,
      });
      await expect(result).toBeVisible();
      const start = performance.now();
      await result.click();
      const thread = page.getByRole("region", {
        name: "Thread messages",
        exact: true,
      });
      const row = thread.locator(`[data-message-id="${app.searchTarget.id}"]`);
      await expect(row).toBeVisible();
      await expect(row).toBeFocused();
      if (previewSurface) {
        // A new exact-message route in this channel must keep the preview
        // mounted, rather than flash the access-loading screen and replay entry.
        expect(await previewSurface.evaluate((node) => node.isConnected)).toBe(
          true,
        );
      }
      app.report.measurements.push({
        mode,
        clickToFocusedMs: performance.now() - start,
      });
      await expect(page.getByText("Join channel to send messages")).toHaveCount(
        2,
      );
      previewSurface ??= await page
        .getByRole("article", { name: "Conversation", exact: true })
        .getByRole("region", { name: "Channel preview", exact: true })
        .elementHandle();
      await expect(
        page.getByRole("textbox", { name: "Message #open", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("textbox", { name: "Reply to thread", exact: true }),
      ).toHaveCount(0);
      await expect(
        page
          .getByRole("complementary", { name: "Channel sidebar" })
          .getByRole("button", { name: "open", exact: true }),
      ).toHaveCount(0);
    }
    const threadPanel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const history = threadPanel.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    const invitation = threadPanel.getByRole("region", {
      name: "Channel preview",
      exact: true,
    });
    await history.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect
      .poll(async () => {
        const last = await history
          .locator("[data-message-id]")
          .last()
          .boundingBox();
        const overlay = await invitation.boundingBox();
        return !!last && !!overlay && last.y + last.height <= overlay.y - 20;
      })
      .toBe(true);
    await expect(
      threadPanel.getByRole("button", { name: "Join", exact: true }),
    ).toHaveAttribute("data-size", "sm");
    await threadPanel
      .getByRole("button", { name: "Join", exact: true })
      .click();
    const reply = threadPanel.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    await expect(reply).toBeFocused();
    await expect(page.getByText("Join channel to send messages")).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("textbox", { name: "Message #open", exact: true }),
    ).toBeVisible();
    expect(
      app.report.queries
        .filter(({ filter }) => filter.search)
        .every(({ filter }) => !filter["#h"]),
    ).toBe(true);
  });

  test("finds an unjoined public channel by name, previews it, joins it and sends a message", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await button(page, "Search Buzz").click();
    await page.getByRole("combobox", { name: "Search Buzz" }).fill("ope");
    const result = page
      .getByRole("group", { name: "Channels" })
      .getByRole("option", { name: /^open/ });
    await expect(result).toContainText("Public channel · not joined");
    await result.click();
    const composer = page.getByRole("textbox", {
      name: "Message #open",
      exact: true,
    });
    await expect(page.getByText("Join channel to send messages")).toBeVisible();
    // Real layout: the invitation overlays history without shortening its
    // viewport, and the last message can still scroll clear of the invitation.
    const history = page.getByRole("region", {
      name: "Channel message history",
      exact: true,
    });
    const notice = page.getByRole("region", {
      name: "Channel preview",
      exact: true,
    });
    // A short viewport makes this a real scroll-clearance check.
    await page.setViewportSize({ width: 960, height: 260 });
    await expect(history.locator("[data-message-id]").last()).toBeVisible();
    await expect
      .poll(() => history.evaluate((el) => el.scrollHeight > el.clientHeight))
      .toBe(true);
    await history.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect
      .poll(async () => {
        const feed = await history.boundingBox();
        const overlay = await notice.boundingBox();
        const last = await history
          .locator("[data-message-id]")
          .last()
          .boundingBox();
        return (
          !!feed &&
          !!overlay &&
          !!last &&
          Math.abs(feed.y + feed.height - overlay.y - overlay.height) < 1 &&
          last.y + last.height <= overlay.y - 20
        );
      })
      .toBe(true);
    await expect(composer).toHaveCount(0);
    const sidebar = page.getByRole("complementary", {
      name: "Channel sidebar",
    });
    await expect(
      sidebar.getByRole("button", { name: "open", exact: true }),
    ).toHaveCount(0);
    await button(page, "Join").click();
    await expect(composer).not.toHaveAttribute("aria-disabled", "true");
    await expect(composer).toBeFocused();
    await expect(page.getByText(/Join channel to send messages/)).toHaveCount(
      0,
    );
    await expect(
      sidebar.getByRole("button", { name: "open", exact: true }),
    ).toBeVisible();
    expect(app.report.lifecyclePublications).toEqual([
      expect.objectContaining({
        kind: 9021,
        tags: [["h", app.openChannelId]],
      }),
    ]);
    await composer.pressSequentially("Hello from a new member");
    await composer.press("Enter");
    await expect
      .poll(() =>
        app.report.publications.map(({ event }) => [
          event.kind,
          event.content,
          event.tags.find(([key]) => key === "h")?.[1],
        ]),
      )
      .toContainEqual([9, "Hello from a new member", app.openChannelId]);
  });

  test("focuses the composer when live membership arrives before the join request settles", async ({
    page,
    app,
  }) => {
    const release = app.holdJoin();
    await page.goto(app.origin);
    await button(page, "Search Buzz").click();
    await page.getByRole("combobox", { name: "Search Buzz" }).fill("ope");
    await page
      .getByRole("group", { name: "Channels" })
      .getByRole("option", { name: /^open/ })
      .click();
    const composer = page.getByRole("textbox", {
      name: "Message #open",
      exact: true,
    });
    await expect(composer).toHaveCount(0);
    await button(page, "Join").click();
    await expect(page.getByText(/Join channel to send messages/)).toHaveCount(
      0,
    );
    expect(app.report.lifecyclePublications).toHaveLength(1);
    await expect(composer).not.toHaveAttribute("aria-disabled", "true");
    await expect(composer).toBeFocused();
    release();
    await composer.pressSequentially("Joined");
    await expect(composer).toHaveText("Joined");
  });
});

test("keyboard selection follows its action while recent conversations arrive above it", async ({
  page,
  app,
}) => {
  const rail = page.getByRole("button", {
    name: "Switch to Primary",
    exact: true,
  });
  // Hold startup membership before navigation so the channel list arrives after
  // the palette opens. A reload here can retire a live stream while its initial
  // control request is still in flight; that race is unrelated to selection.
  const held = [];
  let holding = true;
  await page.route("**/api/relay/*/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (holding && filters.some(({ kinds }) => kinds?.includes(39002)))
      await new Promise((resolve) => held.push(resolve));
    await route.continue();
  });
  try {
    await page.goto(app.origin);
    await expect(rail).toBeVisible();
    await button(page, "Search Buzz").click();
    const dialog = page.getByRole("dialog", {
      name: "Search Buzz",
      exact: true,
    });
    const input = dialog.getByRole("combobox", { name: "Search Buzz" });
    const recent = dialog
      .getByRole("group", { name: "Recent activity" })
      .getByRole("option");
    const projects = dialog
      .getByRole("group", { name: "Actions" })
      .getByRole("option", { name: "Projects", exact: true });
    await expect(projects).toBeVisible();
    // The connected palette is mounted, but its channel list is still held.
    await expect(
      dialog.getByText("Connecting to this community…", { exact: true }),
    ).toHaveCount(0);
    await expect(recent).toHaveCount(0);
    await entered(dialog);
    const id = await projects.getAttribute("id");
    while ((await input.getAttribute("aria-activedescendant")) !== id)
      await input.press("ArrowDown");
    const before = await projects.boundingBox();
    holding = false;
    for (const resolve of held.splice(0)) resolve();
    await expect(recent.first()).toBeVisible();
    await expect(
      page.getByRole("textbox", {
        name: "Message #Alpha",
        exact: true,
        includeHidden: true,
      }),
    ).toBeAttached();
    await expect(input).toBeFocused();
    // The arrivals moved the action; the selection stays with it.
    expect((await projects.boundingBox()).y).toBeGreaterThan(before.y);
    await expect(input).toHaveAttribute("aria-activedescendant", id);
    await input.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Projects", exact: true }),
    ).toBeVisible();
  } finally {
    holding = false;
    for (const resolve of held.splice(0)) resolve();
  }
});

test("a resting pointer does not steal the typed selection when results move under it", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await button(page, "Search Buzz").click();
  const dialog = page.getByRole("dialog", { name: "Search Buzz" });
  const input = dialog.getByRole("combobox", { name: "Search Buzz" });
  const rows = dialog.getByRole("option");
  // Measure where the row stays: after the entrance and recent activity load.
  await expect(
    dialog
      .getByRole("group", { name: "Recent activity" })
      .getByRole("option", { name: /Beta/ }),
  ).toBeVisible();
  await entered(dialog);
  const row = rows.nth(2);
  // The first move inside the palette only records the pointer; the next
  // one is a real move and selects.
  await row.hover({ position: { x: 20, y: 10 } });
  const box = await row.boundingBox();
  const y = box.y + 10;
  await page.mouse.move(box.x + 30, y);
  await expect(row).toHaveAttribute("aria-selected", "true");
  await input.fill("a");
  const alpha = dialog
    .getByRole("group", { name: "Channels" })
    .getByRole("option", { name: /Alpha/ });
  await expect(alpha).toHaveAttribute("aria-selected", "true");
  // WebKit replays the resting position when rows move; that is not a hover.
  await page.mouse.move(box.x + 30, y);
  await expect(alpha).toHaveAttribute("aria-selected", "true");
  // A real move selects whichever result is now under the pointer.
  await page.mouse.move(box.x + 40, y);
  const hovered = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest('[role="option"]')?.id,
    [box.x + 40, y],
  );
  expect(hovered).toBeTruthy();
  expect(hovered).not.toBe(await alpha.getAttribute("id"));
  await expect(dialog.locator(`[id="${hovered}"]`)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(alpha).toHaveAttribute("aria-selected", "false");
});

// The real rendered palette and verified finite reader must carry operator constraints
// into the relay query, rather than filtering a truncated first result page.
test.describe("message search operators", () => {
  test.use({
    openSearch: true,
    productionBroker: true,
    historyCounts: { alpha: 1, beta: 1 },
  });
  test("combines author, channel and inclusive/exclusive day boundaries in the rendered flow", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await button(page, "Search Buzz").click();
    const input = page.getByRole("combobox", { name: "Search Buzz" });
    await input.fill(
      `crew-search in:${app.openChannelId} from:${app.searchTarget.pubkey} after:2023-11-14 before:2023-11-15`,
    );
    await expect(
      page.getByRole("option", { name: /crew-search exact public reply/ }),
    ).toBeVisible();
    const filter = app.report.queries.find(
      ({ filter }) => filter.search === "crew-search" && filter.authors?.length,
    );
    expect(filter?.filter).toMatchObject({
      "#h": [app.openChannelId],
      authors: [app.searchTarget.pubkey],
      since: Date.UTC(2023, 10, 14) / 1000,
      until: Date.UTC(2023, 10, 15) / 1000 - 1,
    });
    await input.fill(
      `crew-search in:${app.openChannelId} from:${app.searchTarget.pubkey} before:2023-11-14`,
    );
    await expect(
      page.getByRole("option", { name: /crew-search exact public reply/ }),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        app.report.queries.some(
          ({ filter }) =>
            filter.search === "crew-search" &&
            filter.until === Date.UTC(2023, 10, 14) / 1000 - 1,
        ),
      )
      .toBe(true);
  });
});
