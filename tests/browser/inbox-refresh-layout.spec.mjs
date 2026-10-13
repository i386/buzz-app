import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

// Real layout and header truncation cannot be inferred from jsdom. Hold the
// addressed refresh while ordinary unread catch-up completes so only the loading
// indicator (not the separate stale/error notices) can change row geometry.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
});

for (const width of [1280, 390, 320]) {
  test(`Inbox refresh status preserves layout at ${width}px`, async ({
    page,
    app,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(app.origin);
    await openPage(page, "Inbox");
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    const status = inbox.getByText("Checking recent activity…", {
      exact: true,
    });
    const list = inbox.getByRole("list", { name: "Inbox conversations" });
    const rows = list.getByRole("listitem");
    const filters = inbox.getByRole("button", {
      name: "Inbox filters",
      exact: true,
    });
    await expect(rows).toHaveCount(3);
    await expect(status).toHaveCount(0);
    let gate;
    await page.route("**/api/relay/primary/query", async (route) => {
      const pending = gate;
      if (
        !pending ||
        !route
          .request()
          .postDataJSON()
          .some((filter) => filter["#p"] && filter.kinds?.includes(9))
      )
        return route.continue();
      pending.started = true;
      await pending.promise;
      await route.continue();
    });
    const geometry = () =>
      inbox.evaluate((element) => {
        const box = (node) => {
          const { x, y, width, height } = node.getBoundingClientRect();
          return { x, y, width, height };
        };
        return {
          rows: [
            ...element.querySelectorAll(
              '[aria-label="Inbox conversations"] > li',
            ),
          ].map((row) => ({ ...box(row), text: row.textContent })),
          header: box(element.querySelector("header")),
          filters: box(element.querySelector('[aria-label="Inbox filters"]')),
        };
      });
    const measurements = [];
    await expect(filters).toBeVisible();
    const before = await geometry();
    gate = { ...Promise.withResolvers(), started: false };
    try {
      app.relay.disconnect("primary");
      await expect.poll(() => gate.started).toBe(true);
      await expect(status).toBeVisible();
      await expect(inbox.getByText("Showing retained activity.")).toHaveCount(
        0,
      );
      await expect.poll(geometry).toEqual(before);
      expect(
        await status.evaluate((element) => element.closest("header") !== null),
      ).toBe(true);
      const textStyle = await status.evaluate((element) => ({
        whiteSpace: getComputedStyle(element).whiteSpace,
        overflow: getComputedStyle(element).overflow,
        textOverflow: getComputedStyle(element).textOverflow,
        width: element.getBoundingClientRect().width,
        scrollWidth: element.scrollWidth,
      }));
      expect(textStyle).toMatchObject({
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      });
      if (width === 320)
        expect(textStyle.scrollWidth).toBeGreaterThan(textStyle.width);
      const during = await geometry();
      measurements.push({ width, before, during, textStyle });
    } finally {
      gate.resolve();
      gate = undefined;
    }
    await expect(status).toHaveCount(0);
    await expect.poll(geometry).toEqual(before);
    await expect(inbox.getByRole("alert")).toHaveCount(0);
    await expect(filters).toHaveText("All");
    await filters.click();
    for (const name of ["People", "Agents"]) {
      await expect(
        page.getByRole("menuitemcheckbox", { name, exact: true }),
      ).toBeChecked();
    }
    await page.keyboard.press("Escape");
    await testInfo.attach("refresh-geometry", {
      body: JSON.stringify(measurements, null, 2),
      contentType: "application/json",
    });
  });
}
