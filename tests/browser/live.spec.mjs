import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import {
  open,
  settle,
  upper,
  expectAnchor,
  end,
  edge,
  anchor,
} from "./timeline.mjs";

test.use({
  productionBroker: true,
  historyCounts: { alpha: 640, beta: 20 },
});
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
const retry = (page) =>
  page.getByRole("button", { name: "Retry live updates", exact: true });
const heads = (app, channel) =>
  app.report.queries.filter(
    ({ filter }) =>
      filter.kinds?.includes(9) &&
      filter["#h"]?.length === 1 &&
      filter["#h"][0] === channel &&
      filter.top_level === true &&
      filter.until === undefined,
  );
/** Cross a quota cooldown in controlled time. The app starts its own deadline
 * when it consumes the refusal, which precedes the visible error and ignored
 * clicks; advancing the page clock by the full delay from here passes it. The
 * broker's lane uses real time, so also wait for its exact reopening. */
async function crossCooldown(page, app) {
  await page.clock.runFor(app.relay.rejected[0].retryAfterMs);
  await expect.poll(() => app.relay.brokerCooldownOver()).toBe(true);
}
/** Cross a quota cooldown in real time, for a page whose timeline must keep
 * the browser's own clock. The app arms its deadline when it consumes the
 * refusal, after the broker paused its lane and the fixture stamped the
 * response, so the broker's reopening is the earliest useful moment and only
 * the page knows the last one. Clicks before it are ignored, as asserted
 * before the crossing, so click Retry until the catch-up reaches the relay.
 * The button leaves only once a request already counted there has answered,
 * so a click that finds it is one the app can still act on, and a click
 * while that request is in flight only promotes it. */
async function retryAfterCooldown(page, app, sent) {
  await expect.poll(() => app.relay.brokerCooldownOver()).toBe(true);
  await expect
    .poll(
      async () => {
        if (!sent()) await retry(page).click();
        return sent();
      },
      { message: "Retry after the quota cooldown sends the catch-up" },
    )
    .toBe(true);
}
async function ready(page, app) {
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "alpha")).toBe(true);
  // The first head may already start after stream establishment; a duplicate
  // initial read is not required. Recovery below has its own positive gap control.
  await expect.poll(() => heads(app, "alpha").length).toBeGreaterThanOrEqual(1);
  await expect.poll(() => app.relay.hasRoute("primary", "beta")).toBe(true);
  await expect(retry(page)).toHaveCount(0);
  await settle(page);
}

test("production WS → broker → mounted UI delivers messages and retries a paused catch-up without replacing healthy routes", async ({
  page,
  app,
}) => {
  // The first roster renews the activity observer and retires presence, which
  // re-subscribes after its read gate. Either control may wait behind one in
  // flight until that fetch's own continuation sends it, so count controls in
  // the page: settlement and any resend fall in one microtask checkpoint.
  await page.addInitScript(() => {
    const native = window.fetch;
    window.liveControls = 0;
    window.fetch = (input, init) => {
      const result = native(input, init);
      if (/\/stream-(observer|presence-authors)$/.test(String(input))) {
        const settled = () => window.liveControls--;
        window.liveControls++;
        result.then(settled, settled);
      }
      return result;
    };
  });
  await ready(page, app);
  const live = app.append("primary", "alpha", "Policy-realistic live delivery");
  await expect(
    history(page).locator(`[data-message-id="${live.id}"]`),
  ).toBeInViewport();
  const reading = await upper(page);
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .fill("Keep my draft");
  const established = (kind) =>
    app.relay.sockets.some(
      ({ community, readyState, routes }) =>
        community === "primary" &&
        readyState === 1 &&
        [...routes].some(
          ([id, filters]) =>
            filters.some((filter) => filter.kinds.includes(kind)) &&
            app.report.wireFrames.some(
              (frame) => frame[0] === "EOSE" && frame[1] === id,
            ),
        ),
    );
  // The broker applies each control before it responds. Once the page has
  // handled every response, live observer and presence routes that reached
  // EOSE belong to the latest generations.
  await expect
    .poll(
      async () =>
        !(await page.evaluate(() => window.liveControls)) &&
        established(24200) &&
        established(20001),
    )
    .toBe(true);
  const socketCount = app.relay.sockets.length;
  const globalRequests = app.relay.requests.filter(({ filters }) =>
    filters.every((filter) => !filter["#h"]),
  ).length;
  app.relay.failRoute("primary", "alpha");
  const missed = app.append(
    "primary",
    "alpha",
    "Delivered by authoritative catch-up",
    false,
  );
  app.relay.quotaNextHead("alpha", 2);
  // A sidebar preview may reach the shared broker before the selected head.
  // It must not consume the failure injected specifically for head catch-up.
  const previewStatus = await page.evaluate(async () => {
    const response = await fetch("/api/relay/primary/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Buzz-Read-Priority": "background",
      },
      body: JSON.stringify([
        {
          "#h": ["alpha", "beta"],
          include_aux: true,
          kinds: [40002, 9],
          limit: 500,
        },
      ]),
    });
    return response.status;
  });
  expect(previewStatus).toBe(200);
  expect(app.relay.rejected).toHaveLength(0);
  await retry(page).click();
  await expect.poll(() => app.relay.rejected.length).toBe(1);
  await expect(
    page
      .getByRole("status", { name: "Live updates need attention", exact: true })
      .filter({ hasText: "rate-limited" }),
  ).toBeVisible();
  const calls = heads(app, "alpha").length;
  await retry(page).click();
  await retry(page).click();
  expect(heads(app, "alpha")).toHaveLength(calls);
  expect(app.relay.sockets).toHaveLength(socketCount);
  expect(
    app.relay.requests.filter(({ filters }) =>
      filters.every((filter) => !filter["#h"]),
    ),
  ).toHaveLength(globalRequests);
  await expectAnchor(page, reading);
  await retryAfterCooldown(page, app, () => heads(app, "alpha").length > calls);
  await expect(retry(page)).toHaveCount(0);
  await expect.poll(() => heads(app, "alpha").length).toBe(calls + 1);
  await settle(page);
  await expectAnchor(page, reading);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toHaveJSProperty("value", "Keep my draft");
  await end(page);
  await expect(
    history(page).locator(`[data-message-id="${missed.id}"]`),
  ).toBeInViewport();
  const after = app.append("primary", "alpha", "Live delivery still active");
  await expect(
    history(page).locator(`[data-message-id="${after.id}"]`),
  ).toBeInViewport();
});

test("post-reconnect finite catch-up keeps paged history, cursor and reading position", async ({
  page,
  app,
}) => {
  await ready(page, app);
  await edge(page, -1);
  await expect.poll(() => app.pending.length).toBe(1);
  await settle(page);
  const before = await anchor(page);
  const pageOne = app.pending.shift();
  pageOne.release();
  await expect(
    history(page).locator(`[data-message-id="${pageOne.events[0].id}"]`),
  ).toBeAttached();
  await settle(page);
  await expectAnchor(page, before);
  const reading = await upper(page);
  const calls = heads(app, "alpha").length;
  app.relay.disconnect("primary");
  const missed = app.append(
    "primary",
    "alpha",
    "Reconnect gap repaired",
    false,
  );
  await expect.poll(() => heads(app, "alpha").length).toBeGreaterThan(calls);
  await expect(retry(page)).toHaveCount(0);
  await settle(page);
  await expectAnchor(page, reading);
  await edge(page, -1);
  await expect.poll(() => app.pending.length).toBe(1);
  const pageTwo = app.pending.shift();
  expect(pageTwo.filter.until).toBeLessThan(pageOne.filter.until);
  pageTwo.release();
  await end(page);
  await expect(
    history(page).locator(`[data-message-id="${missed.id}"]`),
  ).toBeInViewport();
});

test("Live retry recovers an empty paused roster without restarting healthy global subscriptions", async ({
  page,
  app,
}) => {
  // Empty is a valid authoritative result: recovery must not depend on a
  // selected channel or on an interest change replacing the global stream.
  let displayGeneration = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/stream-observer"))
      displayGeneration = request.postDataJSON().observer;
  });
  app.relay.emptyRoster();
  app.relay.quotaNextRoster(2);
  await page.clock.install();
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await expect.poll(() => app.relay.rejected.length).toBe(1);
  await expect(
    page
      .getByRole("status", { name: "Live updates need attention", exact: true })
      .filter({ hasText: "rate-limited" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Alpha", exact: true }),
  ).toHaveCount(0);
  const globals = () =>
    app.relay.requests.filter(({ filters }) =>
      filters.some(
        (filter) => filter.kinds.includes(0) || filter.kinds.includes(44100),
      ),
    );
  const observer = () =>
    app.relay.requests.filter(({ filters }) =>
      filters.some((filter) => filter.kinds.includes(24200)),
    );
  const presence = () =>
    app.relay.requests.filter(({ filters }) =>
      filters.some((filter) => filter.kinds.includes(20001)),
    );
  await expect.poll(() => globals().length).toBe(2);
  await expect.poll(() => observer().length).toBe(1);
  await expect.poll(() => presence().length).toBe(1);
  // Presence owns a separate access/demand-scoped route. Establish startup EOSE
  // before recording healthy chat wires; a roster error is not a stream barrier.
  const healthy = globals();
  await expect
    .poll(() =>
      [...healthy, ...presence(), ...observer()].every(({ id }) =>
        app.report.wireFrames.some(
          (frame) => frame[0] === "EOSE" && frame[1] === id,
        ),
      ),
    )
    .toBe(true);
  const sockets = app.relay.sockets.length;
  const rosters = () =>
    app.report.queries.filter(({ filter }) => filter.kinds?.includes(39002));
  const calls = rosters().length;
  await retry(page).click();
  await retry(page).click();
  expect(rosters()).toHaveLength(calls);
  await crossCooldown(page, app);
  const previousGeneration = displayGeneration;
  const observerUpdated = page.waitForResponse(
    (response) =>
      response.url().endsWith("/stream-observer") &&
      response.ok() &&
      response.request().postDataJSON().observer > previousGeneration,
  );
  await retry(page).click();
  await expect(
    page.getByText("No channels yet.", { exact: true }),
  ).toBeVisible();
  await expect(retry(page)).toHaveCount(0);
  expect(rosters()).toHaveLength(calls + 1);
  expect(app.relay.sockets).toHaveLength(sockets);
  // The first authoritative (empty) roster resets the display generation, not
  // the unchanged owner capture route or healthy profile/membership globals.
  // Cross the observer control response before asserting no wire was replaced.
  await observerUpdated;
  expect(observer()).toHaveLength(1);
  expect(globals()).toHaveLength(2);
  for (const { socket, id } of [...healthy, ...observer()])
    expect(app.relay.sockets[socket].routes.has(id)).toBe(true);
  expect(observer()[0].filters[0].kinds).toEqual([24200, 44200]);
});
