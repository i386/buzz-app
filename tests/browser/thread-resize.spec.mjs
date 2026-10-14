import { test, expect } from "./fixture.mjs";
import { open, settle, wheel } from "./timeline.mjs";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools";

test.use({
  productionBroker: true,
  pluginFixtures: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 2, beta: 1 },
  developmentReact: true,
});

// Browser-only: child-only activity layout and composer resizing must preserve
// bottom/reading intent, including intermediate rendering opportunities.
test("thread preserves bottom and reading position through activity and composer resizing", async ({
  page,
  app,
}, testInfo) => {
  const key = generateSecretKey();
  await page.route("**/agent-library", (route) =>
    route.fulfill({
      json: {
        definitions: [],
        identities: [{ pubkey: getPublicKey(key), name: "Diagnostic Agent" }],
      },
    }),
  );
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content.startsWith("Thread root"));
  for (let i = 0; i < 30; i++) app.reply(root.id, false, false);
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  app.serveProfile(key, { name: "Diagnostic Agent", is_agent: true });
  const rootRow = page.locator(
    `[data-channel-timeline] [data-message-id="${root.id}"]`,
  );
  await rootRow.hover();
  await rootRow.getByRole("button", { name: /^View thread:/ }).click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const history = thread.getByRole("region", { name: "Thread messages" });
  const input = thread.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  const gap = () =>
    history.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect(history.locator("[data-message-id]")).toHaveCount(33);
  await expect.poll(gap).toBeLessThan(4);
  await settle(page, history);

  // Observe layout delivery after the app's observer, before paint. Sampling
  // in a task can instead catch a newer DOM mutation awaiting its next layout.
  const sampling = await history.evaluateHandle((el) => {
    const samples = [];
    const observer = new ResizeObserver(() => {
      samples.push(el.scrollHeight - el.clientHeight - el.scrollTop);
    });
    observer.observe(el);
    observer.observe(el.querySelector("[data-thread-rows]"));
    return {
      samples,
      stop() {
        observer.disconnect();
      },
    };
  });
  const start = (id, turnId) =>
    app.observer(
      {
        kind: "turn_started",
        seq: 1,
        timestamp: new Date().toISOString(),
        channelId: "alpha",
        sessionId: "resize",
        turnId,
        payload: { triggeringEventIds: [id] },
      },
      key,
    );
  const stop = (turnId) =>
    app.observer(
      {
        kind: "turn_completed",
        seq: 2,
        timestamp: new Date().toISOString(),
        channelId: "alpha",
        sessionId: "resize",
        turnId,
        payload: {},
      },
      key,
    );
  try {
    await input.fill("Short send");
    await input.press("Enter");
    await expect(input).toHaveText("");
    await expect(
      history.getByText("Short send", { exact: true }),
    ).toBeVisible();
    await settle(page, history);
    await input.fill(
      `Multiline send\n${"Another line of the draft\n".repeat(8)}`,
    );
    await settle(page, history);
    expect(await gap()).toBeLessThan(4);
    await input.press("Enter");
    await expect(input).toHaveText("");
    const sent = history
      .locator("[data-message-id]")
      .filter({ hasText: "Multiline send" })
      .last();
    await expect(sent).toBeVisible();
    const id = await sent.getAttribute("data-message-id");
    start(id, "bottom");
    await expect(
      sent.getByRole("region", { name: "Agent activity on this message" }),
    ).toBeVisible();
    await settle(page, history);
    expect(await gap()).toBeLessThan(4);
    stop("bottom");
    await expect(
      sent.getByRole("region", { name: "Agent activity on this message" }),
    ).toHaveCount(0);
    await settle(page, history);
    expect(await gap()).toBeLessThan(4);
    const samples = await sampling.evaluate((state) => {
      state.stop();
      return state.samples;
    });
    await testInfo.attach("bottom-frame-gaps", {
      body: JSON.stringify(samples),
      contentType: "application/json",
    });
    expect(samples.length).toBeGreaterThan(0);
    expect(Math.max(...samples), "no intermediate bottom cutoff").toBeLessThan(
      4,
    );
  } finally {
    await sampling.evaluate((state) => state.stop());
    await sampling.dispose();
  }

  // The center can reveal a top-layer message toolbar that consumes wheel
  // input without scrolling the thread. Aim at its left gutter instead.
  await history.hover({ position: { x: 48, y: 80 } });
  expect(
    await history.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.left + 48, bounds.top + 80);
      return !!hit && element.contains(hit) && !hit.closest("[popover]");
    }),
  ).toBe(true);
  await wheel(page, -350, history);
  expect(await gap()).toBeGreaterThan(200);
  const anchor = await history.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll("[data-message-id]")].find(
      (row) => row.getBoundingClientRect().bottom > top,
    );
    return {
      id: row.dataset.messageId,
      y: row.getBoundingClientRect().top - top,
    };
  });
  const unchanged = async () => {
    await settle(page, history);
    expect(
      await history.evaluate((el, anchor) => {
        const row = el.querySelector(`[data-message-id="${anchor.id}"]`);
        return Math.abs(
          row.getBoundingClientRect().top -
            el.getBoundingClientRect().top -
            anchor.y,
        );
      }, anchor),
    ).toBeLessThan(4);
  };
  // Activity above the reader is a child-only reflow, not a thread snapshot.
  start(root.id, "reading");
  await expect(
    history
      .locator(`[data-message-id="${root.id}"]`)
      .getByRole("region", { name: "Agent activity on this message" }),
  ).toHaveCount(1);
  await unchanged();
  await input.fill("Growing draft\n".repeat(8));
  await unchanged();
  await input.fill("");
  await unchanged();
  stop("reading");
  await expect(
    history
      .locator(`[data-message-id="${root.id}"]`)
      .getByRole("region", { name: "Agent activity on this message" }),
  ).toHaveCount(0);
  await unchanged();
});

test.describe("exact history resize ownership", () => {
  test.use({
    exactMessages: true,
    historyCounts: { alpha: 103, beta: 0 },
  });
  test("held exact target resize followed by live reply", async ({
    page,
    app,
  }) => {
    const key = generateSecretKey();
    await page.route("**/agent-library", (route) =>
      route.fulfill({
        json: {
          definitions: [],
          identities: [{ pubkey: getPublicKey(key), name: "Review Agent" }],
        },
      }),
    );
    await open(page, app);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    app.serveProfile(key, { name: "Review Agent", is_agent: true });
    let release, intercepted;
    const held = new Promise((r) => (release = r)),
      seen = new Promise((r) => (intercepted = r));
    let first = true;
    await page.route("**/api/relay/**/query", async (route) => {
      if (
        !first ||
        !route
          .request()
          .postDataJSON()
          .some((f) => f.depth_limit)
      )
        return route.continue();
      first = false;
      intercepted();
      await held;
      await route.continue().catch(() => {});
    });
    const history = page.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    const target = history.locator(
      `[data-message-id="${app.exact.target.id}"]`,
    );
    let n = 0;
    const reply = () => {
      const event = finalizeEvent(
        {
          kind: 9,
          tags: [
            ["h", "alpha"],
            ["e", app.exact.root.id, "", "reply"],
          ],
          content: `Review live reply ${n++}`,
          created_at: Math.floor(Date.now() / 1000) + n,
        },
        key,
      );
      app.relay.publish("primary", event);
      return event;
    };
    // Hold the reveal's completion frame while live replies commit, so resize
    // ownership cannot rely on a later parent render to finish initialization.
    await page.evaluate((targetId) => {
      const raf = window.requestAnimationFrame;
      const cancel = window.cancelAnimationFrame;
      const heldFrames = new Map();
      let holding = true;
      window.requestAnimationFrame = (callback) => {
        const id = raf((time) => {
          if (
            holding &&
            document.activeElement?.getAttribute("data-message-id") === targetId
          )
            heldFrames.set(id, callback);
          else callback(time);
        });
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        heldFrames.delete(id);
        cancel(id);
      };
      window.releaseExactReveal = () => {
        holding = false;
        window.requestAnimationFrame = raf;
        window.cancelAnimationFrame = cancel;
        for (const callback of heldFrames.values()) raf(callback);
        heldFrames.clear();
      };
    }, app.exact.target.id);
    try {
      await page.evaluate(
        (value) => {
          void window.fixtureNavigation.open(value);
        },
        {
          version: 1,
          kind: "conversation",
          channelId: "alpha",
          messageId: app.exact.target.id,
          threadRootId: app.exact.root.id,
          scope: {
            viewer: app.viewer,
            communityOrigin: "https://primary.example",
          },
        },
      );
      await seen;
      await expect(target).toBeFocused();
      for (let i = 0; i < 15; i++) reply();
      await expect(
        history.getByText("Review live reply 14", { exact: true }),
      ).toHaveCount(1);
      await page.evaluate(() => window.releaseExactReveal());
      await settle(page, history);
      const y = () =>
        target.evaluate(
          (el) =>
            el.getBoundingClientRect().top -
            el.closest('[aria-label="Thread messages"]').getBoundingClientRect()
              .top,
        );

      // Controlled child-only geometry change above the exact row; no React parent commit.
      await target.evaluate((el) => {
        const spacer = document.createElement("div");
        spacer.style.height = "37px";
        el.before(spacer);
      });
      await settle(page, history);
      const resized = await y();
      reply();
      await expect(
        history.getByText("Review live reply 15", { exact: true }),
      ).toHaveCount(1);
      await settle(page, history);
      const later = await y();
      expect(
        Math.abs(later - resized),
        "later update must not repeat resize correction",
      ).toBeLessThan(4);
    } finally {
      await page.evaluate(() => window.releaseExactReveal());
      release();
    }
  });
});
