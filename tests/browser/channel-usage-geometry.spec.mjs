import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { openPage } from "./navigation.mjs";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
} from "nostr-tools";

test.use({
  productionBroker: true,
  archiveOnDisk: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 2, beta: 1 },
  viewport: { width: 1200, height: 800 },
});

test("channel usage opens a separate tab and leaves thread history usable", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  // Three agents exercise the full-height usage tab with multiple sessions.
  for (let agentIndex = 0; agentIndex < 3; agentIndex++) {
    const key = generateSecretKey();
    const agent = getPublicKey(key);
    for (
      let sessionIndex = 0;
      sessionIndex < (agentIndex === 0 ? 3 : 2);
      sessionIndex++
    ) {
      const payload = {
        harness: "goose",
        timestamp: new Date().toISOString(),
        channelId: "alpha",
        sessionId: `geometry-${agentIndex}-${sessionIndex}-very-long-identifier-without-spaces`,
        turnId: `turn-${agentIndex}-${sessionIndex}`,
        turnSeq: 1,
        turn: { inputTokens: 10 },
        cumulative: { totalTokens: 100 },
      };
      const event = finalizeEvent(
        {
          kind: 44200,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["p", app.viewer],
            ["agent", agent],
          ],
          content: nip44.v2.encrypt(
            JSON.stringify(payload),
            nip44.v2.utils.getConversationKey(key, app.viewer),
          ),
        },
        key,
      );
      app.relay.observer("primary", event);
    }
  }
  const actions = page.getByRole("button", { name: "Channel actions" });
  await actions.click();
  await page.getByRole("menuitem", { name: "View channel usage" }).click();
  const pane = page.getByRole("tabpanel", { name: "Usage" });
  const usage = pane.getByRole("group", { name: "Channel session usage" });
  const picker = usage.getByRole("combobox", { name: "Agent usage" });
  await picker.click();
  await expect(page.getByRole("option", { name: /sessions/ })).toHaveCount(3);
  const choices = await page
    .getByRole("option", { name: /sessions/ })
    .allTextContents();
  await page.getByRole("option", { name: choices[0] }).click();
  const totals = pane.getByRole("region", { name: "All session totals" });
  await expect(totals.getByText("Totals across 2 sessions")).toBeVisible();
  const sessions = pane.getByRole("combobox", { name: "Session" });
  await sessions.click();
  await page.getByRole("option", { name: /Session 2 ·/ }).click();
  await expect(sessions).toContainText("Session 2");
  const details = pane.getByRole("region", { name: "Session usage details" });
  await expect(details).toBeVisible();
  // A long identifier must wrap in its value column, not squeeze labels to letters.
  await details
    .getByRole("button", { name: /Show turn/ })
    .first()
    .click();
  await details.getByText("Identifiers and provenance").click();
  const identifierRows = details.locator("details dl");
  for (const width of [1200, 1600]) {
    await page.setViewportSize({ width, height: 800 });
    const geometry = await identifierRows.evaluate((list) => {
      const label = list.querySelector("dt");
      const value = list.querySelector("dd");
      return {
        labelWidth: label.getBoundingClientRect().width,
        valueWidth: value.getBoundingClientRect().width,
        labelFontSize: parseFloat(getComputedStyle(label).fontSize),
        valueOverflows: value.scrollWidth > value.clientWidth + 1,
        listOverflows: list.scrollWidth > list.clientWidth + 1,
      };
    });
    expect(geometry.labelWidth).toBeGreaterThanOrEqual(90);
    expect(geometry.valueWidth).toBeGreaterThanOrEqual(90);
    expect(geometry.labelFontSize).toBeGreaterThanOrEqual(14);
    expect(geometry.valueOverflows).toBe(false);
    expect(geometry.listOverflows).toBe(false);
  }
  await page.setViewportSize({ width: 1200, height: 400 });
  const owner = usage.locator("..");
  for (const index of [1, 2, 0]) {
    await picker.click();
    await page.getByRole("option", { name: choices[index] }).click();
    await expect(picker).toBeInViewport();
    expect(
      await owner.evaluate((element) => element.scrollWidth),
    ).toBeLessThanOrEqual(
      (await owner.evaluate((element) => element.clientWidth)) + 1,
    );
  }
  await expect(usage.getByRole("button", { name: "Refresh" })).toBeInViewport();
  await usage.getByRole("button", { name: "Refresh" }).click();
  await page.setViewportSize({ width: 1200, height: 800 });
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content.startsWith("Thread root"));
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${root.id}"]`,
  );
  await row.hover();
  await row.getByRole("button", { name: /^View thread:/ }).click();
  await expect(page.getByRole("tabpanel", { name: "Usage" })).not.toBeVisible();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    thread.getByRole("region", { name: "Thread messages" }),
  ).toBeVisible();
  await expect(
    thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeInViewport();
  await page.getByRole("tab", { name: "Usage" }).click();
  await expect(details).toBeVisible();
  await expect(
    pane.getByRole("textbox", { name: "Reply to thread" }),
  ).toHaveCount(0);
  // A timeline detail replaces transient panels, not retained channel tools.
  // This contract used to run through the removed Todos tab-picker path.
  await row
    .getByRole("button", { name: /View .* profile/ })
    .first()
    .click();
  await expect(
    page.getByRole("complementary", { name: "Profile", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Usage", exact: true }).click();
  await expect(details).toBeVisible();
});

test("disabling the Channel Usage plugin retires the tab and re-enabling does not revive it", async ({
  page,
  app,
}) => {
  await open(page, app);
  const actions = page.getByRole("button", { name: "Channel actions" });
  await actions.click();
  await page.getByRole("menuitem", { name: "View channel usage" }).click();
  await expect(page.getByRole("tab", { name: "Usage" })).toBeVisible();
  await page.getByRole("button", { name: "Your profile" }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "Enable Channel Usage" });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await openPage(page, "Messages");
  await expect(page.getByRole("tab", { name: "Usage" })).toHaveCount(0);
  await actions.click();
  await expect(
    page.getByRole("menuitem", { name: "View channel usage" }),
  ).toHaveCount(0);
  await page.getByRole("menu", { name: "Channel actions" }).press("Escape");
  await expect(
    page.getByRole("menu", { name: "Channel actions" }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "Your profile" }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await openPage(page, "Messages");
  await expect(page.getByRole("tab", { name: "Usage" })).toHaveCount(0);
  await actions.click();
  await expect(
    page.getByRole("menuitem", { name: "View channel usage" }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: "View channel usage" }).click();
  await expect(page.getByRole("tab", { name: "Usage" })).toBeVisible();
});

test("switching channels retires each Usage tab without reviving an earlier visit", async ({
  page,
  app,
}) => {
  await open(page, app);
  const usageTab = page.getByRole("tab", { name: "Usage" });
  const openUsage = async () => {
    await page.getByRole("button", { name: "Channel actions" }).click();
    await page.getByRole("menuitem", { name: "View channel usage" }).click();
    await expect(usageTab).toBeVisible();
  };
  const visit = async (name) => {
    await page
      .getByRole("button", { name: new RegExp(`^${name}`) })
      .first()
      .click();
    await expect(
      page.getByRole("textbox", {
        name: new RegExp(`^Message #${name}$`, "i"),
      }),
    ).toBeVisible();
  };
  await openUsage();
  await visit("Beta");
  await expect(usageTab).toHaveCount(0);
  await openUsage();
  await visit("Alpha");
  await expect(usageTab).toHaveCount(0);
  await visit("Beta");
  await expect(usageTab).toHaveCount(0);
});
