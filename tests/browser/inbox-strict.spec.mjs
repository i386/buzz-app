import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { openPage } from "./navigation.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
  developmentReact: true,
});

// Browser-only: the production build can opt into development React. Effects
// replay there; an inline reveal must retain a live signal and focus the target.
test("focuses an in-head DM after effect cleanup and setup replay", async ({
  page,
  app,
}) => {
  await open(page, app);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  await inbox
    .getByRole("button", { name: "Inbox filters", exact: true })
    .click();
  await page.getByRole("menuitemradio", { name: "DMs", exact: true }).click();
  await inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem")
    .first()
    .getByRole("button", { name: /^Open / })
    .click();
  const target = inbox
    .getByRole("region", { name: "Inbox detail" })
    .locator("[data-message-id]")
    .filter({ hasText: "Inbox DM fixture reply" });
  await expect(target).toBeInViewport();
  await expect(target).toBeFocused();
});
