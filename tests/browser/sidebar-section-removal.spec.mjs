import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
// Real app/header portals, caller wiring, row relocation and cold reload through
// the production signing broker. Failure/lifecycle matrices stay in Vitest.
test.use({ productionBroker: true, savedSidebar: true, largeSidebar: false });
for (const personal of [false, true]) {
  test.describe(personal ? "personal removal" : "legacy removal", () => {
    test.use({
      personalSidebar: personal,
      initialSidebarSort: {
        [personal ? "section:personal-work" : "section:work"]: "recent",
        channels: "recent",
      },
    });
    test("confirmed section removal preserves channels and survives reload", async ({
      page,
      app,
    }) => {
      await page.goto(app.origin);
      await openPage(page, "Messages");
      const title = personal ? "Personal work" : "Work";
      const id = personal ? "personal-work" : "work";
      const channel = personal
        ? "11111111-1111-4111-8111-111111111111"
        : "beta";
      const group = page.locator(`[data-sidebar-section="group:${id}"]`);
      const row = page.locator(`[data-channel-id="${channel}"]`);
      await expect(
        group.locator(`[data-channel-id="${channel}"]`),
      ).toBeVisible();
      await page
        .getByRole("button", { name: `More actions for ${title}` })
        .click();
      await page
        .getByRole("menuitem", { name: "Remove section", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: `Remove ${title}?` });
      await expect(dialog).toHaveAccessibleDescription(
        "1 channel will move back to Channels. This does not delete any channels.",
      );
      await expect(
        dialog.getByRole("button", { name: "Cancel" }),
      ).toBeFocused();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: `More actions for ${title}` }),
      ).toBeFocused();
      expect(app.report.sidebarPublications ?? []).toHaveLength(0);
      await expect(group).toBeVisible();
      await group.locator("summary").click();
      await expect(group.locator("details")).not.toHaveAttribute("open");
      await page
        .getByRole("button", { name: `More actions for ${title}` })
        .click();
      await page
        .getByRole("menuitem", { name: "Remove section", exact: true })
        .click();
      if (personal) {
        // Fail before enqueue through the real ChannelKit preparation boundary.
        await page.route(
          "**/channel-kit-prepare",
          async (route) => {
            app.report.sidebarRemovalFailures ??= [];
            app.report.sidebarRemovalFailures.push(route.request().url());
            await route.fulfill({
              status: 502,
              contentType: "application/json",
              body: JSON.stringify({ error: "Preparation unavailable" }),
            });
          },
          { times: 1 },
        );
        await dialog
          .getByRole("button", { name: "Remove section", exact: true })
          .click();
        await expect(dialog.getByRole("alert")).toContainText(
          "Section removal could not be confirmed",
        );
        await expect(dialog.getByRole("alert")).toContainText(
          "Channel settings → Diagnostics → Outbox",
        );
        await expect(group).toHaveCount(1);
        await expect(group.locator("details")).not.toHaveAttribute("open");
        await expect(
          dialog.getByRole("button", { name: "Remove section", exact: true }),
        ).toBeEnabled();
      }
      await dialog
        .getByRole("button", { name: "Remove section", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      await expect(group).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "More actions for Channels" }),
      ).toBeFocused();
      await expect(
        page.locator(
          `[data-sidebar-section="channels"] [data-channel-id="${channel}"]`,
        ),
      ).toBeVisible();
      await expect(row).toHaveCount(1);
      await expect
        .poll(() => app.report.sidebarPublications?.length ?? 0)
        .toBe(2);
      const reset = app.report.sidebarPublications[0];
      expect(reset.coordinate).toBe("channel-sort");
      expect(reset.blob.meta.g[`section:${id}`][2]).toBeNull();
      expect(reset.blob.groups).toEqual({ channels: "recent" });
      const { coordinate, blob } = app.report.sidebarPublications.at(-1);
      if (personal) {
        expect(coordinate).toContain("buzz-channel-kit-v1:");
        expect(blob.deleted).toBe(false);
        expect(blob.value.groups).toEqual([]);
        expect(blob.value.assignments).toEqual({});
      } else {
        expect(coordinate).toBe("channel-sections");
        expect(blob.meta.s.work.live[2]).toBe(false);
        expect(blob.meta.a.beta[2]).toBeNull();
      }
      // Persist view intent through the production pagehide owner, then reload.
      await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
      const savedViews = await page.evaluate(() =>
        Object.entries(localStorage)
          .filter(
            ([key]) =>
              key.startsWith("buzz-view.v1:") &&
              JSON.parse(key.slice("buzz-view.v1:".length))[1] ===
                "channel-sidebar",
          )
          .map(([, value]) => JSON.parse(value)),
      );
      expect(savedViews.length).toBeGreaterThan(0);
      for (const view of savedViews)
        expect(view.collapsed).not.toContain(`group:${id}`);
      await page.reload();
      await openPage(page, "Messages");
      await expect(group).toHaveCount(0);
      await expect(
        page.locator(
          `[data-sidebar-section="channels"] [data-channel-id="${channel}"]`,
        ),
      ).toBeVisible();
      await expect(
        page.locator(
          '[data-sidebar-section="starred"] [data-channel-id="alpha"]',
        ),
      ).toBeVisible();
      await row.click();
      await expect(
        page.getByRole("article", { name: "Conversation" }),
      ).toBeVisible();
    });
  });
}
