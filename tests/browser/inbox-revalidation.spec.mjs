import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

// Native inert/focus/caret, playback and body portals across broker reconnect
// cannot be inferred from jsdom. Other closure permutations stay in mounted tests.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  historyCounts: { alpha: 2, beta: 1 },
});

for (const scenario of [
  "outside focus and portals",
  "composer focus and playback",
]) {
  test(`revalidating a selected Inbox reader preserves ${scenario}`, async ({
    page,
    app,
  }) => {
    // Message images use AttachmentImage's external-link fallback in Inbox;
    // video reaches the real MediaAttachment portal/useModalBoundary owner.
    const root = app.histories
      .get("primary/alpha")
      .find((event) => event.content === "Thread root 1");
    expect(root).toBeDefined();
    const videoUrl = "https://primary.example/media/inbox-revalidation.mp4";
    const audioUrl = "https://primary.example/media/inbox-revalidation.wav";
    // sample.mp4 has no audio track. Keep a bounded, real two-second PCM tone
    // here rather than adding a fixture asset or mocking native media playback.
    const samples = 16_000;
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8_000, 24);
    wav.writeUInt32LE(16_000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(samples * 2, 40);
    for (let i = 0; i < samples; i++)
      wav.writeInt16LE(
        Math.round(2_000 * Math.sin((i * Math.PI * 440) / 4_000)),
        44 + i * 2,
      );
    await page.route("**/api/relay/primary/media?**", (route) =>
      route.fulfill(
        new URL(route.request().url()).searchParams.get("url") === audioUrl
          ? { body: wav, contentType: "audio/wav" }
          : {
              path: "tests/fixtures/message-gallery/assets/sample.mp4",
              contentType: "video/mp4",
            },
      ),
    );
    app.append(
      "primary",
      "alpha",
      "Inbox revalidation video",
      false,
      false,
      root.id,
      undefined,
      [
        ["imeta", `url ${videoUrl}`, "m video/mp4"],
        ["imeta", `url ${audioUrl}`, "m audio/wav"],
      ],
    );

    await page.goto(app.origin);
    await openPage(page, "Inbox");
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
    const choice = inbox
      .getByRole("list", { name: "Inbox conversations" })
      .getByRole("listitem")
      .filter({ hasText: "Unread reply 1" });
    await choice.getByRole("button", { name: /^Open / }).click();
    const detail = inbox.getByRole("region", { name: "Inbox detail" });
    const thread = detail.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const target = detail
      .locator("[data-message-id]")
      .filter({ hasText: "Unread reply 1" });
    await expect(target).toBeFocused();
    // Complete exact-reveal acknowledgement / scheduled focus restoration before
    // taking an outside-focus baseline, including after recovery below.
    const finishPresentation = () =>
      page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
    await finishPresentation();
    const editor = detail.getByRole("textbox", { name: "Reply to thread" });
    await expect(editor).toBeVisible();
    const draft = "Retained Inbox reply draft";
    await editor.fill(draft);
    const retainedThread = await thread.elementHandle();
    const retainedEditor = await editor.elementHandle();
    if (!retainedThread || !retainedEditor)
      throw new Error("Missing admitted reader");
    const unread = inbox.getByRole("button", {
      name: "Unread only",
      exact: true,
    });
    await unread.focus();
    await expect(unread).toBeFocused();

    const closure = (fail = false) => ({
      ...Promise.withResolvers(),
      started: false,
      fail,
    });
    const outsideClosure = closure();
    const viewerClosure = closure(true);
    const retryClosure = closure();
    const focusedClosure = closure(true);
    const focusedRecovery = closure();
    const movedClosure = closure();
    const escapeClosure = closure();
    let heldClosure = outsideClosure;
    // This journey interrupts sockets, not read-state durability. Fence incidental
    // debounced publication: let admitted requests settle, queue later ones until
    // the next closure request proves the connection has been re-established.
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
    const reconnect = async () => {
      publicationGate = Promise.withResolvers();
      await Promise.all([...publishing]);
      app.relay.disconnect("primary");
      await expect.poll(() => heldClosure.started).toBe(true);
      const pending = publicationGate;
      publicationGate = undefined;
      pending.resolve();
    };
    await page.route("**/api/relay/**/query", async (route) => {
      const held = heldClosure;
      if (
        !held ||
        !route
          .request()
          .postDataJSON()
          .some(
            (filter) =>
              filter["#e"] &&
              filter.kinds?.includes(40003) &&
              // Inbox closure, not the exact thread reader's separate overlays.
              !filter.kinds.includes(39005),
          )
      )
        return route.continue();
      held.started = true;
      await held.promise;
      if (held.fail)
        // Invalid closure evidence, not an HTTP error/console-error allowlist.
        await route.fulfill({ json: { error: "Synthetic auxiliary failure" } });
      else await route.continue();
    });
    const expectRetained = async () => {
      expect(
        await retainedThread.evaluate((element) => element.isConnected),
      ).toBe(true);
      expect(
        await retainedEditor.evaluate((element) => element.isConnected),
      ).toBe(true);
    };
    const expectWithheld = async () => {
      await expectRetained();
      await expect(thread).toHaveCount(0);
      await expect(editor).toHaveCount(0);
      expect(await detail.ariaSnapshot()).not.toContain("Unread reply 1");
    };
    const viewer = page.getByRole("dialog", { name: "Video attachment" });
    const expectNoViewer = async () => {
      // Body scope is essential: the retained detail's hidden/inert ancestor
      // cannot contain a createPortal(..., document.body) or its modal effects.
      await expect(
        page.locator('[role="dialog"][aria-label="Video attachment"]'),
      ).toHaveCount(0);
      await expect(viewer).toHaveCount(0);
      await expect(page.locator("video:visible")).toHaveCount(0);
      const accessible = await page.locator("body").ariaSnapshot();
      expect(accessible).not.toContain("Video attachment");
      expect(accessible).not.toContain("Close fullscreen viewer");
    };
    try {
      if (scenario === "outside focus and portals") {
        // Preserve the outside-toolbar focus path, without an open modal.
        await reconnect();
        await expect(detail.getByText("Preview updating…")).toBeVisible();
        await expectWithheld();
        await expect(unread).toBeFocused();
        outsideClosure.resolve();
        await expect(detail.getByText("Preview updating…")).toHaveCount(0);
        await expect(thread).toBeVisible();
        await expect(target).toBeVisible();
        await expect(editor).toHaveText(draft);
        await expectRetained();
        await finishPresentation();
        await expect(unread).toBeFocused();

        const mediaOpener = detail.getByRole("button", {
          name: "Open video fullscreen",
        });
        await detail.locator("[data-video-preview]").hover();
        await expect(mediaOpener).toHaveCSS("pointer-events", "auto");
        await mediaOpener.click();
        await expect(viewer).toBeVisible();
        await expect
          .poll(() =>
            viewer.locator("video").evaluate((video) => video.videoWidth),
          )
          .toBeGreaterThan(0);
        const viewerClose = viewer.getByRole("button", {
          name: "Close fullscreen viewer",
        });
        await expect(viewerClose).toBeFocused();
        // Establish real modality before suspending: the app root is ARIA-hidden
        // and the last modal tab stop wraps to Close, not into the Inbox below.
        await expect(inbox).toHaveCount(0);
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await expect(viewerClose).toBeFocused();

        heldClosure = viewerClosure;
        await reconnect();
        // Check the body portal FIRST: a surviving modal hides Inbox from role
        // queries, so waiting for detail here would mask the actual regression.
        await expectNoViewer();
        await expect(detail.getByText("Preview updating…")).toBeVisible();
        await expectWithheld();
        const openChannel = detail.getByRole("button", {
          name: "Open in channel",
        });
        const closeDetail = detail.getByRole("button", {
          name: "Close detail",
        });
        await openChannel.focus();
        await page.keyboard.press("Tab");
        await expect(closeDetail).toBeFocused();
        await finishPresentation();
        await expect(closeDetail).toBeFocused();

        viewerClosure.resolve();
        // Error rendering is the completion barrier for the failed request, not a
        // negative snapshot taken while a response could still reveal old content.
        await expect(
          detail.getByText("Preview unavailable. Retry inbox."),
        ).toBeVisible();
        await expectWithheld();
        await expectNoViewer();
        const activity = inbox.getByRole("button", {
          name: "Inbox filters",
          exact: true,
        });
        const retry = inbox.getByRole("button", { name: "Retry inbox" });
        await activity.focus();
        await page.keyboard.press("Shift+Tab");
        await expect(retry).toBeFocused();

        heldClosure = retryClosure;
        await page.keyboard.press("Enter");
        await expect.poll(() => retryClosure.started).toBe(true);
        await expect(detail.getByText("Preview updating…")).toBeVisible();
        await expectWithheld();
        await expectNoViewer();
        await expect(retry).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(activity).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(unread).toBeFocused();
        retryClosure.resolve();
        await expect(retry).toHaveCount(0);
        await expect(detail.getByText("Preview updating…")).toHaveCount(0);
        await expect(thread).toBeVisible();
        await expect(target).toBeVisible();
        await expect(editor).toHaveText(draft);
        await expectRetained();
        await finishPresentation();
        // Recovery exposes the same reader/editor, not the dismissed viewer, and
        // must not replay its entry focus or late modal-opener restoration.
        await expect(unread).toBeFocused();
        await expect(target).not.toBeFocused();
        await expect(editor).not.toBeFocused();
        await expect(
          page.locator('[role="dialog"][aria-label="Video attachment"]'),
        ).toHaveCount(0);
        await expect(viewer).toHaveCount(0);
        expect(await page.locator("body").ariaSnapshot()).not.toContain(
          "Video attachment",
        );
      } else {
        const closeDetail = detail.getByRole("button", {
          name: "Close detail",
        });
        // Actual inline playback, not a paused fullscreen viewer: loop these short
        // assets so natural completion cannot masquerade as the withholding pause.
        const media = detail.locator("video, audio");
        await expect(media).toHaveCount(2);
        await media.evaluateAll((elements) => {
          for (const element of elements) {
            element.loop = true;
          }
        });
        await detail.locator("[data-video-preview]").hover();
        await detail
          .getByRole("button", { name: "Play video", exact: true })
          .click();
        await detail
          .getByRole("button", {
            name: "Play inbox-revalidation.wav",
            exact: true,
          })
          .click();
        await editor.fill(draft);
        // Establish the pre-revalidation caret through the composer's public API.
        // A fill followed by ArrowLeft does not prove native/model selection has
        // settled; this journey tests retention, not arrow-key editing.
        await editor.evaluate((element, offset) => {
          element.setSelectionRange(offset, offset);
        }, draft.length - 1);
        const expectCaret = () =>
          expect
            .poll(() =>
              editor.evaluate((element) => {
                const selection = document.getSelection();
                return {
                  start: element.selectionStart,
                  end: element.selectionEnd,
                  anchor: selection?.anchorOffset,
                  head: selection?.focusOffset,
                  inside:
                    element.contains(selection?.anchorNode) &&
                    element.contains(selection?.focusNode),
                };
              }),
            )
            .toEqual({
              start: draft.length - 1,
              end: draft.length - 1,
              anchor: draft.length - 1,
              head: draft.length - 1,
              inside: true,
            });
        await expect(editor).toBeFocused();
        await expectCaret();
        const beforePlaying = await media.evaluateAll((elements) =>
          elements.map((element) => element.currentTime),
        );
        await expect
          .poll(() =>
            media.evaluateAll(
              (elements, before) =>
                elements.length === 2 &&
                elements.every(
                  (element, i) =>
                    !element.paused && element.currentTime > before[i],
                ),
              beforePlaying,
            ),
          )
          .toBe(true);

        // pause() changes `paused` before the native media task has settled its
        // final time. Observe that event instead of wrapping the method call.
        await media.evaluateAll((elements) => {
          for (const element of elements) {
            element.addEventListener(
              "pause",
              () => {
                element.dataset.inboxPausedAt = String(element.currentTime);
              },
              { once: true },
            );
          }
        });
        await expectCaret();
        heldClosure = focusedClosure;
        await reconnect();
        await expect(detail.getByText("Preview updating…")).toBeVisible();
        await expect(closeDetail).toBeVisible();
        await expect(closeDetail).toBeFocused();
        await expectWithheld();
        await expect
          .poll(() =>
            media.evaluateAll(
              (elements) =>
                elements.length === 2 &&
                elements.every(
                  (element) =>
                    element.paused &&
                    element.dataset.inboxPausedAt !== undefined,
                ),
            ),
          )
          .toBe(true);
        const pausedPositions = await media.evaluateAll((elements) =>
          elements.map((element) => Number(element.dataset.inboxPausedAt)),
        );
        for (const position of pausedPositions)
          expect(Number.isFinite(position)).toBe(true);
        const expectPaused = () =>
          expect
            .poll(() =>
              media.evaluateAll((elements) =>
                elements.map((element) => ({
                  paused: element.paused,
                  time: element.currentTime,
                })),
              ),
            )
            .toEqual(pausedPositions.map((time) => ({ paused: true, time })));
        await expectPaused();
        focusedClosure.resolve();
        await expect(
          detail.getByText("Preview unavailable. Retry inbox."),
        ).toBeVisible();
        await expectWithheld();
        await expect(closeDetail).toBeFocused();
        await expectPaused();

        // Recover through reconnect without moving focus to Retry: Close still
        // owns the handoff, so the original editor AND its caret must return.
        heldClosure = focusedRecovery;
        await reconnect();
        await expect(detail.getByText("Preview updating…")).toBeVisible();
        await expect(closeDetail).toBeFocused();
        focusedRecovery.resolve();
        await expect(thread).toBeVisible();
        await expectRetained();
        await finishPresentation();
        await expectPaused();
        await expect(editor).toBeFocused();
        await expect(editor).toHaveText(draft);
        // No focus()/locator.press()/fill() here: those would mask lost native
        // focus. Typing must insert at the pre-withholding interior caret.
        await expectCaret();
        await page.keyboard.type(" recovered ");
        const recoveredDraft = `${draft.slice(0, -1)} recovered ${draft.slice(-1)}`;
        await expect(editor).toHaveText(recoveredDraft);

        heldClosure = movedClosure;
        await reconnect();
        await expect(closeDetail).toBeVisible();
        await expect(closeDetail).toBeFocused();
        await expectWithheld();
        await unread.focus();
        await expect(unread).toBeFocused();
        movedClosure.resolve();
        await expect(thread).toBeVisible();
        await finishPresentation();
        await expect(unread).toBeFocused();
        await expect(editor).not.toBeFocused();
        await expect(editor).toHaveText(recoveredDraft);
        await expectRetained();

        // Last: native Escape from the automatically focused placeholder must
        // reach detail dismissal while the closure is still held.
        const selectedChoice = inbox
          .getByRole("list", { name: "Inbox conversations" })
          .locator('[aria-current="page"]');
        const description =
          await selectedChoice.getAttribute("aria-describedby");
        expect(description).toBeTruthy();
        const returningChoice = inbox.locator(
          `[aria-describedby="${description}"]`,
        );
        await editor.focus();
        heldClosure = escapeClosure;
        await reconnect();
        await expect(closeDetail).toBeVisible();
        await expect(closeDetail).toBeFocused();
        await expectWithheld();
        await page.keyboard.press("Escape");
        await expect(detail).toHaveCount(0);
        await expect(returningChoice).toBeFocused();
        escapeClosure.resolve();
        await expect(inbox.getByText("Preview updating…")).toHaveCount(0);
        await finishPresentation();
        await expect(detail).toHaveCount(0);
        await expect(returningChoice).toBeFocused();
      }
    } finally {
      publicationGate?.resolve();
      publicationGate = undefined;
      heldClosure = undefined;
      outsideClosure.resolve();
      viewerClosure.resolve();
      retryClosure.resolve();
      focusedClosure.resolve();
      focusedRecovery.resolve();
      movedClosure.resolve();
      escapeClosure.resolve();
      await retainedThread.dispose();
      await retainedEditor.dispose();
    }
  });
}
