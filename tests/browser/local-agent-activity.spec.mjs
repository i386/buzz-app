import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// One real app-composition/geometry journey. Matrices stay in the host and
// adapter tests; only native identity custody and the agent's external work are fake.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 2, beta: 1 },
  localAgentActivity: true,
});
test("local agent receipt, work and failure agree across sidebar, thread and exact message", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  const agent = "b".repeat(64);
  await expect
    .poll(() => page.evaluate(() => !!window.localAgentFixture))
    .toBe(true);
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content.startsWith("Thread root"));
  const rootRow = page.locator(
    `[data-channel-timeline] [data-message-id="${root.id}"]`,
  );
  await rootRow.hover();
  await rootRow.getByRole("button", { name: /^View thread:/ }).click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeVisible();
  // Generated viewer identity, signed through the same live relay fixture as chat.
  const send = (text) => {
    const event = app.sign({
      kind: 9,
      content: text,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["h", "alpha"],
        ["e", root.id, "", "root"],
        ["e", root.id, "", "reply"],
        ["p", agent],
      ],
    });
    app.relay.publish("primary", event);
    return event;
  };
  const first = send("First local request");
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.pending().length))
    .toBe(1);
  const second = send("Second local request");
  const secondRow = thread.locator(`[data-message-id="${second.id}"]`);
  const waiting = secondRow.getByRole("button", {
    name: /^View agent activity:/,
  });
  await expect(waiting).toHaveAccessibleName(
    /Local tester, Received · waiting to start/,
  );
  await expect(
    waiting.locator('[data-state="waiting"] > span').first(),
  ).toHaveCSS("animation-duration", "2.4s");
  const sidebar = page.locator(
    '[data-channel-id="alpha"] [data-channel-working]',
  );
  // Neither request has reported a first step yet, so the sidebar breathes.
  await expect(sidebar).toHaveAccessibleName(/Local tester waiting in Alpha/);
  const summary = rootRow.getByRole("button", { name: /^View thread:/ });
  await expect(summary).toHaveAccessibleName(/Local tester waiting/);
  await page.evaluate(
    (id) => window.localAgentFixture.finish(id, true),
    first.id,
  );
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.pending().length))
    .toBe(2);
  // Claimed but no first step yet: still breathing, now "Starting".
  await expect(waiting).toHaveAccessibleName(/Local tester, Starting/);
  const firstRow = thread.locator(`[data-message-id="${first.id}"]`);
  await expect(
    firstRow.getByRole("button", { name: /^View agent activity:/ }),
  ).toHaveCount(0);
  await page.evaluate((id) => window.localAgentFixture.handover(id), second.id);
  await expect(
    waiting.locator('[data-state="working"] > span').first(),
  ).toHaveCSS("animation-duration", "1.4s");
  // Work remains after run() returns; only actual completion settles it.
  await page.evaluate(
    (id) => window.localAgentFixture.finish(id, false),
    second.id,
  );
  await expect(waiting).toContainText("Could not finish");
  await expect(sidebar).toHaveCount(0);
  await expect(summary.locator("[data-thread-working]")).toHaveCount(0);
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    for (const width of [390, 800, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      await waiting.focus();
      await page.keyboard.press("Enter");
      const popup = page.getByRole("dialog", {
        name: "Agent activity",
        exact: true,
      });
      await expect(popup).toContainText("Fixture provider unavailable");
      await expect(popup).not.toHaveAttribute("data-starting-style", "");
      const box = await popup.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      // The full reason wraps rather than truncating; Dismiss stays inside.
      await expect(popup.getByText("Fixture provider unavailable")).toHaveCSS(
        "white-space",
        "normal",
      );
      const dismiss = await popup
        .getByRole("button", { name: /^Dismiss error from / })
        .boundingBox();
      expect(dismiss.x + dismiss.width).toBeLessThanOrEqual(box.x + box.width);
      await page.screenshot({
        path: testInfo.outputPath(`local-activity-${colorScheme}-${width}.png`),
      });
      await page.keyboard.press("Escape");
      await expect(popup).toBeHidden();
      await expect(waiting).toBeFocused();
    }
  }
  // Dismiss hides only this device's view of the error; focus stays in the row.
  await waiting.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Dismiss error from / }).click();
  await expect(waiting).toHaveCount(0);
  await expect(page.locator("body")).not.toBeFocused();
});

// Real host composition: dedup is about two mounted presentations, not two agents.
test("a message bubble replaces duplicate thread dots without hiding work on another reply", async ({
  page,
  app,
}) => {
  await open(page, app);
  const agent = "b".repeat(64);
  await expect
    .poll(() => page.evaluate(() => !!window.localAgentFixture))
    .toBe(true);
  const request = app.sign({
    kind: 9,
    content: "Top-level activity request",
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["h", "alpha"],
      ["p", agent],
    ],
  });
  app.relay.publish("primary", request);
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${request.id}"]`,
  );
  const bubble = row.getByRole("button", { name: /^Open thread:/ });
  await expect(bubble).toBeVisible();
  await expect(row.locator("[data-thread-working]")).toHaveCount(0);
  // Existing replies keep their navigation even while the bubble owns work here.
  app.threadSummary(request.id, [agent], 1);
  const summary = row.getByRole("button", { name: /^View thread:/ });
  await expect(summary).toContainText("1 reply");
  await expect(summary.locator("[data-thread-working]")).toHaveCount(0);
  await page.evaluate(
    (id) => window.localAgentFixture.handover(id),
    request.id,
  );
  const reply = app.sign({
    kind: 9,
    content: "Follow-up activity request",
    created_at: request.created_at + 1,
    tags: [
      ["h", "alpha"],
      ["e", request.id, "", "root"],
      ["e", request.id, "", "reply"],
      ["p", agent],
    ],
  });
  app.relay.publish("primary", reply);
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.pending().length))
    .toBe(2);
  await expect(bubble).toBeVisible();
  // Same agent, different request: the thread summary still indicates that work.
  await expect(summary.locator("[data-thread-working]")).toBeVisible();
  // Ending work keeps the same bubble through its exit: removing and
  // re-adding it would collapse and regrow the row mid-handoff.
  await row.evaluate((element) => {
    const changes = [];
    window.bubbleChanges = changes;
    const bubbles = (node) =>
      node.nodeType === 1 &&
      (node.matches("section") || !!node.querySelector("section"));
    new MutationObserver((records) => {
      for (const { addedNodes, removedNodes } of records) {
        for (const node of addedNodes) if (bubbles(node)) changes.push("add");
        for (const node of removedNodes)
          if (bubbles(node)) changes.push("remove");
      }
    }).observe(element, { subtree: true, childList: true });
  });
  await page.evaluate(
    (id) => window.localAgentFixture.finish(id, true),
    request.id,
  );
  await expect(bubble).toHaveCount(0);
  await expect(row.locator("section")).toHaveCount(0);
  expect(await page.evaluate(() => window.bubbleChanges)).toEqual(["remove"]);
  await expect(summary.locator("[data-thread-working]")).toBeVisible();
  await page.evaluate(
    (id) => window.localAgentFixture.finish(id, true),
    reply.id,
  );
  await expect(summary.locator("[data-thread-working]")).toHaveCount(0);
  await expect(summary).toContainText("1 reply");
});

// Real host navigation and hover/keyboard coexistence require a browser: no reply
// exists yet, and the same root's accessory must change behavior inside the pane.
test("opens an active message's empty thread without losing its activity preview", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect
    .poll(() => page.evaluate(() => !!window.localAgentFixture))
    .toBe(true);
  const request = app.sign({
    kind: 9,
    content: "Open this active thread before its first reply",
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["h", "alpha"],
      ["p", "b".repeat(64)],
    ],
  });
  app.histories.get("primary/alpha").push(request);
  app.relay.publish("primary", request);
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${request.id}"]`,
  );
  const trigger = row.getByRole("button", { name: /^Open thread:/ });
  await expect(trigger).toBeVisible();
  await trigger.hover();
  const preview = page.getByRole("dialog", {
    name: "Agent activity",
    exact: true,
  });
  await expect(preview).toBeVisible();
  await trigger.click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeVisible();
  await expect(preview).toHaveCount(0);
  const root = thread.locator(`[data-message-id="${request.id}"]`);
  await expect(root).toContainText(request.content);
  const activity = root.getByRole("button", { name: /^View agent activity:/ });
  await expect(activity).toBeVisible();
  await activity.click();
  await expect(preview).toBeVisible();
  await expect(
    preview.getByRole("button", { name: "View activity for Local tester" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  // The tab title may be the loaded message preview, not literally "Thread".
  await page
    .locator(
      '[data-panel-workspace] :is([data-tab-value="thread"], [data-tab-value^="thread:"])[aria-selected="true"]',
    )
    .locator("..")
    .getByRole("button", { name: /^Close .+ tab$/ })
    .click();
  await expect(thread).toHaveCount(0);
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(
    thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeVisible();
  await expect(activity).toBeVisible();
  await page.evaluate(
    (id) => window.localAgentFixture.finish(id, true),
    request.id,
  );
});

for (const focusOn of ["bubble", "popup", "composer"]) {
  test(`finishing activity retires keyboard controls without stealing focus: ${focusOn}`, async ({
    page,
    app,
  }) => {
    await open(page, app);
    await expect
      .poll(() => page.evaluate(() => !!window.localAgentFixture))
      .toBe(true);
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content.startsWith("Thread root"));
    const row = page.locator(
      `[data-channel-timeline] [data-message-id="${root.id}"]`,
    );
    await row.hover();
    await row.getByRole("button", { name: /^View thread:/ }).click();
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const composer = thread.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    await expect(composer).toBeVisible();
    const request = app.sign({
      kind: 9,
      content: "Finish while focused",
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["h", "alpha"],
        ["e", root.id, "", "reply"],
        ["p", "b".repeat(64)],
      ],
    });
    app.relay.publish("primary", request);
    const message = thread.locator(`[data-message-id="${request.id}"]`);
    const bubble = message.getByRole("button", {
      name: /^View agent activity:/,
    });
    await expect(bubble).toBeVisible();
    // Finish entrance and hold only the exit so the intermediate state is testable.
    await message.locator("section").evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .filter((a) => a.effect.getTiming().iterations !== Infinity)
          .map((a) => a.finished),
      );
    });
    // Hold the actual exit animation before its first frame, rather than racing
    // a delayed animationstart event on a busy runner. Release in finally.
    const exitGate = await page.addStyleTag({
      content: "[data-leaving] { animation-play-state: paused !important; }",
    });
    const popup = page.getByRole("dialog", {
      name: "Agent activity",
      exact: true,
    });
    if (focusOn === "popup") {
      await bubble.click();
      await popup
        .getByRole("button", { name: "View activity for Local tester" })
        .focus();
    } else if (focusOn === "bubble") await bubble.focus();
    else await composer.focus();
    const section = message.locator("section");
    try {
      await page.evaluate(
        (id) => window.localAgentFixture.finish(id, true),
        request.id,
      );
      await expect(section).toHaveAttribute("data-leaving", "");
      await expect(section).toHaveAttribute("inert", "");
      await expect(popup).toHaveCount(0);
      const destination =
        focusOn === "composer"
          ? composer
          : message.getByRole("button", { name: "More message actions" });
      await expect(destination).toBeFocused();
      await page.keyboard.press("Tab");
      expect(
        await section.evaluate((e) => e.contains(document.activeElement)),
      ).toBe(false);
    } finally {
      await exitGate.evaluate((element) => element.remove());
    }
    await expect(section).toHaveCount(0);
  });
}
