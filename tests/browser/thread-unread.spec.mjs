import { openChannelDetails } from "./channel-details.mjs";
import { test, expect } from "./fixture.mjs";
import { open, virtuaIdle } from "./timeline.mjs";
import { holdReadingFocus, releaseReadingFocus } from "./reading.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  // The viewer joined the peer's thread outside the loaded window, so its
  // replies count only after the membership lookup.
  threadUnreadJoined: true,
  historyCounts: { alpha: 20, beta: 1 },
  largeSidebar: true,
  pluginFixtures: true, // Observe the real navigation completion, not reply mount timing.
});
test.describe("mentioned reply priority", () => {
  test.use({ threadUnreadMentions: true });

  test("a mention and broadcast remain distinguishable in Activity", async ({
    page,
    app,
  }) => {
    await holdReadingFocus(page);
    await open(page, app);
    const alpha = page.locator('button[data-channel-id="alpha"]');
    await expect(
      alpha.getByRole("img", { name: /unread threads?/ }),
    ).toBeVisible();
    await alpha.hover();
    const popover = page.getByRole("dialog", { name: "Activity in Alpha" });
    await expect(popover).toBeVisible();
    const items = popover.getByRole("button", {
      name: /Open unread thread from/,
    });
    await expect(items).toHaveCount(2);
    const names = await items.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("aria-label")),
    );

    expect(
      names.every((name) => name?.startsWith("Open unread thread from ")),
    ).toBe(true);
    // Each thread previews its latest relevant reply: the nested mention in
    // the broadcast thread, and the direct mention in the other.
    expect(new Set(names.map((name) => name?.split(": ").at(-1)))).toEqual(
      new Set(["Broadcast descendant", "Unread reply 1"]),
    );
  });
});

test("thread buttons show observed unread independently, clear only after reading, and expose hover/focus affordance", async ({
  page,
  app,
}, testInfo) => {
  // Reading needs a 300ms dwell (use-reading.ts). An installed clock still
  // flows, so pause it wherever an open surface must not earn that dwell, and
  // run the deadline exactly where the test proves reading.
  await page.clock.install();
  await holdReadingFocus(page);
  await open(page, app);
  const roots = app.histories
    .get("primary/alpha")
    .filter((row) => row.content.startsWith("Thread root"));
  const button = (root) =>
    page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
  const first = button(roots[0]);
  const other = button(roots[1]);
  const broadcast = button(
    app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Broadcast reply"),
  );
  const dot = (control) =>
    control.locator('span[title^="Observed unread replies"]');
  await expect(first).toHaveAccessibleName(
    /23 replies\. Observed unread replies/,
  );
  await expect(other).toHaveAccessibleName(
    /23 replies\. Observed unread replies/,
  );
  await expect(dot(first)).toBeVisible();
  await expect(dot(other)).toBeVisible();
  await expect(broadcast).toHaveAccessibleName(/Observed unread replies/);
  const alpha = page.locator('button[data-channel-id="alpha"]');
  const activity = alpha.getByRole("img", { name: /unread threads?/ });
  await expect(activity).toBeVisible();
  await expect(alpha.getByText("Alpha", { exact: true })).toHaveCSS(
    "font-weight",
    "600",
  );
  await openChannelDetails(page);
  await page.getByText("Diagnostics", { exact: true }).click();
  await page
    .getByRole("button", { name: "Mark unread on this device", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Close Channel settings tab", exact: true })
    .click();
  await expect(
    alpha.getByRole("img", { name: /Marked unread on this device only/ }),
  ).toBeAttached();
  await expect(activity).toHaveAccessibleName(/unread threads?/);
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "dark";
  });
  await alpha.hover();
  const popover = page.getByRole("dialog", { name: "Activity in Alpha" });
  await expect(popover).toBeVisible();
  await expect(
    popover.getByText("Activity in Alpha", { exact: true }),
  ).toHaveCount(0);
  await popover.screenshot({
    path: testInfo.outputPath("activity-popover.png"),
  });
  // The viewer's own thread and the peer thread the viewer joined. Channel
  // evidence never returns the viewer's displaced reply, so only the
  // conversation lookup can make the second thread count.
  await expect(
    popover.getByRole("button", { name: /Open unread thread from/ }),
  ).toHaveCount(2);
  expect(
    app.report.queries.some(
      ({ filter }) =>
        filter.authors?.[0] === app.viewer &&
        filter["#e"]?.includes(roots[1].id),
    ),
  ).toBe(true);
  const queries = () =>
    app.report.queries.filter(({ filter }) => filter.depth_limit);
  expect(queries()).toHaveLength(0); // Merely displaying buttons never fetches threads.
  // The sibling context trigger must not steal the activity button's props or
  // focus. Exercise the real portals while unread activity is still present.
  await alpha.click({ button: "right" });
  const actions = page.getByRole("menu", { name: "Actions for Alpha" });
  await expect(actions).toBeVisible();
  await expect(
    actions.getByRole("menuitem", { name: "New session" }),
  ).toHaveCount(0);
  // Leave the hover trigger while the context menu still owns focus. Otherwise
  // its delayed hover close can overlap the later keyboard-open assertion.
  await page.mouse.move(0, 0);
  await expect(popover).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(actions).toHaveCount(0);
  await expect(alpha).toBeFocused();
  await alpha.press("Shift+F10");
  await expect(actions).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(actions).toHaveCount(0);
  await expect(alpha).toBeFocused();
  await expect(popover).toHaveCount(0);
  await expect(alpha).toHaveAttribute("aria-expanded", "false");
  await alpha.press("Enter");
  await expect(alpha).toHaveAttribute("aria-expanded", "true");
  await expect(popover).toBeVisible();
  const item = popover
    .getByRole("button", {
      name: /Open unread thread from/,
    })
    .first();
  await item.focus();
  await expect(item).toBeFocused();
  // This open only proves the handoff. Its thread must stay unread, so a slow
  // close must not let the open panel earn reading dwell. Pause just ahead of
  // the page clock, which keeps flowing during the round trip.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  await releaseReadingFocus(page);
  await item.press("Enter");
  await expect(
    page.getByRole("complementary", { name: "Thread", exact: true }),
  ).toBeVisible();
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"]), button[aria-label="Close thread"]',
    )
    .click();
  await expect(alpha).toBeFocused();
  await page.clock.resume();
  const beforeRect = await first.boundingBox();
  await first.hover();
  const afterRect = await first.boundingBox();
  expect(afterRect).not.toBeNull();
  expect(beforeRect).not.toBeNull();
  expect(afterRect.width).toBe(beforeRect.width);
  expect(afterRect.height).toBe(beforeRect.height);
  await expect(first).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const hover = await first.evaluate((el) => {
    const s = getComputedStyle(el);
    return { border: s.borderTopWidth, radius: s.borderTopLeftRadius };
  });
  expect(hover.border).toBe("0px");
  expect(hover.radius).not.toBe("0px");
  await first.screenshot({
    path: testInfo.outputPath("thread-button-hover.png"),
  });
  // WebKit's macOS tab policy skips buttons; keyboard input still selects
  // focus-visible modality, then focus the actual control in both engines.
  await page.keyboard.press("Tab");
  await first.focus();
  await expect(first).toBeFocused();
  await expect(first).toHaveCSS("outline-style", "solid");
  await expect(first).toHaveCSS("outline-width", "2px");
  await broadcast.focus();
  const previousAttempt = await page.evaluate(
    () => window.fixtureNavigation.snapshot().attempt.id,
  );
  await broadcast.press("Enter");
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const history = panel.getByRole("region", { name: "Thread messages" });
  await expect(
    panel.getByText("Unread reply 0", { exact: true }),
  ).toBeVisible();
  // Content visibility precedes the navigation's deferred reveal/focus. Finish
  // that owner before testing composer-only dwell; faster reads expose the race.
  await expect
    .poll(() =>
      page.evaluate((previous) => {
        const { status, entry, attempt } = window.fixtureNavigation.snapshot();
        return {
          status,
          messageId: entry.target.messageId,
          freshAttempt: attempt.id !== previous,
        };
      }, previousAttempt),
    )
    .toEqual({
      status: "opened",
      freshAttempt: true,
      messageId: app.histories
        .get("primary/alpha")
        .find((row) => row.content === "Broadcast reply").id,
    });
  const replyComposer = panel.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  // Own-composer dwell acknowledges the visible reply without list focus;
  // the collapsed descendant and sibling thread remain independent.
  const directId = await panel
    .locator("[data-message-id]")
    .filter({ hasText: "Unread reply 0" })
    .getAttribute("data-message-id");
  await replyComposer.focus();
  await page.clock.runFor(300);
  await expect(replyComposer).toBeFocused();
  await expect
    .poll(
      () =>
        app.report.readPublications.some(({ blob }) =>
          Object.hasOwn(blob.contexts, `msg:${directId}`),
        ),
      { timeout: 12000 },
    )
    .toBe(true);
  await expect(replyComposer).toBeFocused();
  await expect(other).toHaveAccessibleName(/Observed unread replies/);
  await expect(
    panel.getByText("Broadcast descendant", { exact: true }),
  ).toHaveCount(0);
  await expect(first).toHaveAccessibleName(/Observed unread replies/);
  await panel.getByRole("button", { name: /^View 1 reply/ }).click();
  await expect(
    panel.getByText("Broadcast descendant", { exact: true }),
  ).toBeInViewport();
  await history.focus();
  await expect(first).toHaveAccessibleName("View thread: 23 replies");
  await expect(broadcast).toHaveAccessibleName("View thread: 23 replies");
  await expect(dot(first)).toHaveCount(0);
  await expect(dot(other)).toBeVisible();
  await expect(other).toHaveAccessibleName(/Observed unread replies/); // No channel-wide shortcut.
  // The close transition owns channel width; unread receipt does not mean its
  // resulting Virtua remeasurement and native scrolling have finished.
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"])',
    )
    .click();
  await expect(
    page.locator('[data-panel-dock][data-closing="true"]'),
  ).toHaveCount(0);
  const own = app.reply(roots[0].id, true);
  // Barrier: the session has indexed the reply, so its unread effect is final.
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.fixtureRelay.snapshot().session.unread.attention("alpha", id),
        own.id,
      ),
    )
    .toMatchObject({ status: "ineligible", unread: false });
  await expect(first).toHaveAccessibleName("View thread: 23 replies");
  app.reply(roots[0].id);
  await expect(first).toHaveAccessibleName(/Observed unread replies/);
  await virtuaIdle(page);
  // Remeasurement while geometry settles may start another native scroll.
  await expect(page.locator("[data-channel-timeline] ol")).toHaveCSS(
    "pointer-events",
    "auto",
  );
  const reopenAttempt = await page.evaluate(
    () => window.fixtureNavigation.snapshot().attempt.id,
  );
  await first.click();
  await expect
    .poll(() =>
      page.evaluate((before) => {
        const { status, entry, attempt } = window.fixtureNavigation.snapshot();
        return {
          status,
          freshAttempt: attempt.id !== before,
          messageId: entry.target.messageId,
        };
      }, reopenAttempt),
    )
    .toEqual({ status: "opened", freshAttempt: true, messageId: roots[0].id });
  await expect(
    panel.getByText("New peer reply", { exact: true }),
  ).toBeVisible();
  await history.focus();
  await expect(first).toHaveAccessibleName("View thread: 23 replies");
  await expect(other).toHaveAccessibleName(/Observed unread replies/);
  const savedEntry = await page.evaluate(
    () => window.fixtureNavigation.snapshot().entry,
  );
  const beforeReload = app.report.queries.length;
  await page.reload();
  // Reload restores this visit itself. Reopening Messages through Search races
  // startup results and could hide a broken restoration by starting a new visit.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const snapshot = window.fixtureNavigation?.snapshot();
        return snapshot && { status: snapshot.status, entry: snapshot.entry };
      }),
    )
    .toEqual({ status: "opened", entry: savedEntry });
  await expect(first).toHaveAccessibleName("View thread: 23 replies");
  await expect(other).toHaveAccessibleName(/Observed unread replies/);
  // Restoring a joined conversation waits for initial membership discovery;
  // it must not publish an early one-channel roster through exact resolution.
  expect(
    app.report.queries
      .slice(beforeReload)
      .filter(
        ({ filter }) =>
          filter.kinds?.includes(39002) && filter["#d"]?.includes("alpha"),
      ),
  ).toEqual([]);
});

// Browser focus plus actual controller/React wiring: a same-target open must not
// leave the timeline's trigger installed merely because the history entry is reused.
test("same-thread sidebar activity replaces timeline focus return", async ({
  page,
  app,
}) => {
  await holdReadingFocus(page);
  await open(page, app);
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Thread root 0");
  const alpha = page.locator('button[data-channel-id="alpha"]');
  await expect(
    alpha.getByRole("img", { name: /unread threads?/ }),
  ).toBeVisible();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route("**/api/relay/**/query", async (route) => {
    if (
      route
        .request()
        .postDataJSON()
        .some((filter) => filter.depth_limit)
    ) {
      requested = true;
      await held;
    }
    await route.continue().catch(() => {});
  });
  try {
    const trigger = page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
    await virtuaIdle(page);
    await releaseReadingFocus(page);
    await trigger.click();
    await expect.poll(() => requested).toBe(true);
    const before = await page.evaluate(() => {
      const { entry, attempt } = window.fixtureNavigation.snapshot();
      return { entry: entry.id, attempt: attempt.id };
    });
    await alpha.hover();
    const activity = page.getByRole("dialog", { name: "Activity in Alpha" });
    await activity
      .getByRole("button", {
        name: /Open unread thread from.*Broadcast descendant/,
      })
      .click();
    await expect
      .poll(() =>
        page.evaluate((before) => {
          const { entry, attempt } = window.fixtureNavigation.snapshot();
          return {
            sameEntry: entry.id === before.entry,
            freshAttempt: attempt.id !== before.attempt,
          };
        }, before),
      )
      .toEqual({ sameEntry: true, freshAttempt: true });
    release();
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().status),
      )
      .toBe("opened");
    await page
      .locator(
        '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"]), button[aria-label="Close thread"]',
      )
      .click();
    await expect(alpha).toBeFocused();
  } finally {
    release();
  }
});

// Browser-only contract: fitting rows generate no scroll/resize when an empty
// legacy continuation finishes. Opening alone must still earn reading dwell.
test("opening a fitting thread reads after unchanged-row continuation without another gesture", async ({
  page,
  app,
}) => {
  await page.clock.install();
  await open(page, app);
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Thread root 1");
  const button = page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ });
  await expect(button).toHaveAccessibleName(/Observed unread replies/);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let continuation = false;
  await page.route("**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (
      filters.some(
        (filter) =>
          filter.depth_limit &&
          filter["#e"]?.[0] === root.id &&
          filter.thread_cursor !== undefined,
      )
    ) {
      continuation = true;
      await gate;
    }
    await route.continue();
  });
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const history = panel.getByRole("region", { name: "Thread messages" });
  try {
    await button.click();
    await expect.poll(() => continuation).toBe(true);
    await expect(
      panel.getByText("Unread reply 1", { exact: true }),
    ).toBeInViewport();
    await expect(
      page.locator(
        '[role="tab"][data-tab-value^="thread:"][aria-selected="true"]',
      ),
    ).toBeFocused();
    expect(
      await history.evaluate(
        (element) => element.scrollHeight <= element.clientHeight,
      ),
    ).toBe(true);
    await page.clock.runFor(300);
    await expect(button).toHaveAccessibleName(/Observed unread replies/);
  } finally {
    release();
  }
  await expect(button).not.toHaveAccessibleName(/Observed unread replies/);
  // An explicit retarget of the still-open panel also transfers reading focus.
  const otherRoot = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Thread root 0");
  const other = page
    .locator(`[data-channel-timeline] [data-message-id="${otherRoot.id}"]`)
    .getByRole("button", { name: /^View thread:/ });
  await other.click();
  await expect(panel).toHaveCount(1);
  await expect(
    page.locator(
      '[role="tab"][data-tab-value^="thread:"][aria-selected="true"]',
    ),
  ).toBeFocused();
  const reply = panel
    .locator("[data-message-id]")
    .filter({ hasText: "Unread reply 0" });
  await expect(reply).toBeInViewport();
  const id = await reply.getAttribute("data-message-id");
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.fixtureRelay.snapshot().session.unread.attention("alpha", id)
            .unread,
        id,
      ),
    )
    .toBe(false);
});

test("channel bottom quiets ordinary replies newer than the latest top-level message without reading their threads", async ({
  page,
  app,
}) => {
  await open(page, app);
  const alpha = page.locator('button[data-channel-id="alpha"]');
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Thread root 1");
  const button = page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ });
  await expect(button).toHaveAccessibleName(/Observed unread replies/);
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .focus();
  await expect(alpha.getByText("Alpha", { exact: true })).toHaveCSS(
    "font-weight",
    "400",
  );
  await expect(button).toHaveAccessibleName(/Observed unread replies/);
});
