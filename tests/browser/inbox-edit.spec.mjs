import { test, expect } from "./fixture.mjs";

// Browser boundary: Inbox plugin routing and portalled message-menu dismissal
// must focus the same native decorated editor and preserve its reply draft.
// Publication/eligibility matrices remain in InboxDetail and shared owner tests.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 2, beta: 1 },
  viewport: { width: 1280, height: 720 },
});

// Start in Inbox. The default #Alpha view shows the broadcast reply, and its
// 300 ms reading dwell can read that reply out of Inbox before a slow runner
// finishes navigating there.
const inboxAddress = (origin) =>
  `${origin}/#buzz=${encodeURIComponent(
    JSON.stringify({
      version: 1,
      kind: "page",
      pluginId: "buzz.inbox",
      pageId: "inbox",
    }),
  )}`;

test("Inbox edits an owned reply in place and restores the reply draft", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(inboxAddress(app.origin));
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  const conversation = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem")
    .filter({ hasText: "Broadcast reply" });
  await conversation.getByRole("button", { name: /^Open / }).click();
  const detail = inbox.getByRole("region", { name: "Inbox detail" });
  const reply = detail.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await expect(reply).toBeVisible();
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  const own = app.reply(root.id, true);
  const row = detail.locator(`[data-message-id="${own.id}"]`);
  await expect(row).toBeVisible();
  await reply.fill("Unsent Inbox reply");
  const originalNode = await reply.elementHandle();
  const edit = async () => {
    await row.hover();
    await row.getByRole("button", { name: "More message actions" }).click();
    await page
      .getByRole("menuitem", { name: "Edit message", exact: true })
      .click();
  };
  await edit();
  const editor = detail.getByRole("textbox", {
    name: "Edit message",
    exact: true,
  });
  await expect(editor).toBeFocused();
  await expect(editor).toHaveJSProperty("value", "My reply");
  expect(
    await editor.evaluate(
      (element, original) => element === original,
      originalNode,
    ),
  ).toBe(true);
  await editor.fill("Discard this edit");
  await detail.getByRole("button", { name: "Cancel edit" }).click();
  await expect(reply).toBeFocused();
  await expect(reply).toHaveJSProperty("value", "Unsent Inbox reply");
  await expect(row).toContainText("My reply");
  expect(
    app.report.publications.filter(({ event }) => event.kind === 40003),
  ).toEqual([]);

  await edit();
  await editor.fill("Corrected from Inbox");
  await detail.getByRole("button", { name: "Save changes" }).click();
  await expect(row).toContainText("Corrected from Inbox");
  await expect(reply).toBeFocused();
  await expect(reply).toHaveJSProperty("value", "Unsent Inbox reply");
  await expect
    .poll(
      () =>
        app.report.publications.filter(({ event }) => event.kind === 40003)
          .length,
    )
    .toBe(1);
  const saved = app.report.publications.find(
    ({ event }) => event.kind === 40003,
  ).event;
  expect(saved.content).toBe("Corrected from Inbox");
  expect(saved.tags).toContainEqual(["e", own.id]);

  const peer = detail
    .locator("[data-message-id]")
    .filter({ hasText: "Unread reply 0" });
  await peer.hover();
  await peer.getByRole("button", { name: "More message actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: /^Mark (read|unread)$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Edit message", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Delete message", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Optional review artifact from this exact feature build and disposable data.
  if (process.env.BUZZ_CAPTURE_INBOX_EDIT) {
    await edit();
    await expect(editor).toBeFocused();
    await expect(editor).toHaveJSProperty("value", "Corrected from Inbox");
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("inbox-edit.png") });
  }
});

// A portalled destructive confirmation owns real body modality. Withholding
// must remove that portal and release inert/focus, not merely hide its reader.
for (const submitted of [false, true])
  test(`Inbox withholding retires deletion and preserves focus (submitted: ${submitted})`, async ({
    page,
    app,
  }) => {
    await page.goto(inboxAddress(app.origin));
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
    // The preview can settle on either reply as thread inputs arrive; the
    // conversation's accessible identity is the stable target for this test.
    await inbox
      .getByRole("button", {
        name: "Open Alice Fixture in #Alpha",
        exact: true,
      })
      .click();
    const detail = inbox.getByRole("region", { name: "Inbox detail" });
    const editor = detail.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    await editor.fill("Retained reply draft");
    const originalEditor = await editor.elementHandle();
    const root = app.histories
      .get("primary/alpha")
      .find((event) => event.content === "Thread root 0");
    const own = app.reply(root.id, true);
    const row = detail.locator(`[data-message-id="${own.id}"]`);
    await row.hover();
    await row.getByRole("button", { name: "More message actions" }).click();
    await page
      .getByRole("menuitem", {
        name: submitted ? "Edit message" : "Delete message",
        exact: true,
      })
      .click();
    if (submitted) {
      await detail
        .getByRole("textbox", { name: "Edit message", exact: true })
        .fill("");
      await detail.getByRole("button", { name: "Save changes" }).click();
    }
    const dialog = page.getByRole("alertdialog", { name: "Delete message?" });
    await expect(dialog).toBeVisible();
    await expect(inbox).toHaveCount(0);

    const deletion = Promise.withResolvers();
    const dispatch = Promise.withResolvers();
    await page.route("**/api/relay/primary/publish", async (route) => {
      if (route.request().postDataJSON().kind === 5) {
        dispatch.resolve();
        await deletion.promise;
      }
      return route.continue();
    });
    if (submitted) {
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      await dispatch.promise;
    }
    const closure = Promise.withResolvers();
    let started = false;
    // Let admitted read-state requests settle before interrupting the socket;
    // queue new ones until closure proves the connection is established again.
    let publicationGate;
    const publishing = new Set();
    await page.route(
      "**/api/relay/primary/read-state-publish",
      async (route) => {
        if (publicationGate) await publicationGate.promise;
        const done = Promise.withResolvers();
        publishing.add(done.promise);
        try {
          const response = await route.fetch();
          await route.fulfill({ response });
        } finally {
          publishing.delete(done.promise);
          done.resolve();
        }
      },
    );
    await page.route("**/api/relay/**/query", async (route) => {
      if (
        !route
          .request()
          .postDataJSON()
          .some(
            (filter) =>
              filter["#e"] &&
              filter.kinds?.includes(40003) &&
              !filter.kinds.includes(39005),
          )
      )
        return route.continue();
      started = true;
      await closure.promise;
      return route.continue();
    });
    try {
      publicationGate = Promise.withResolvers();
      await Promise.all([...publishing]);
      app.relay.disconnect("primary");
      await expect.poll(() => started).toBe(true);
      const pending = publicationGate;
      publicationGate = undefined;
      pending.resolve();
      // Body scope catches a surviving portal even when it hides Inbox from ARIA.
      await expect(page.locator('[role="alertdialog"]')).toHaveCount(0);
      await expect(detail.getByText("Preview updating…")).toBeVisible();
      await expect(editor).toHaveCount(0);
      const close = detail.getByRole("button", { name: "Close detail" });
      if (!submitted) await expect(close).toBeFocused();
      const filters = inbox.getByRole("button", { name: "Inbox filters" });
      await filters.focus();
      await expect(filters).toBeFocused();
      closure.resolve();
      await expect(detail.getByText("Preview updating…")).toHaveCount(0);
      if (submitted) {
        await expect(
          detail.getByRole("textbox", { name: "Edit message", exact: true }),
        ).toBeVisible();
        await filters.focus();
        await expect(filters).toBeFocused();
        deletion.resolve();
        await expect(row).toHaveCount(0);
      } else await expect(row).toBeVisible();
      await expect(editor).toHaveJSProperty("value", "Retained reply draft");
      expect(
        await editor.evaluate(
          (element, original) => element === original,
          originalEditor,
        ),
      ).toBe(true);
      await expect(filters).toBeFocused();
      await expect(page.locator('[role="alertdialog"]')).toHaveCount(0);
      expect(
        app.report.publications.filter(({ event }) => event.kind === 5),
      ).toHaveLength(submitted ? 1 : 0);
    } finally {
      deletion.resolve();
      publicationGate?.resolve();
      closure.resolve();
    }
  });
