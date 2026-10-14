import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

test("profile plumbing: exact avatar/mention targets, thread enrichment, lifecycle and recovery", async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/profiles.html");
  const panel = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  await page.waitForFunction(() => !!window.profilesFixture);
  const npubs = await page.evaluate(() => window.profilesFixture.npubs);
  const key = page
    .getByRole("complementary", { name: "Profile", exact: true })
    .locator("code");
  const avatar = page.getByRole("button", {
    name: "View Viewer profile",
    exact: true,
  });
  await expect(avatar).toHaveCount(1);
  await expect(avatar.locator("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );
  await avatar.focus();
  await avatar.press("Enter");
  await expect(key).toHaveText(npubs.viewer);
  const viewerTab = page
    .getByRole("tablist", { name: "Panel tabs" })
    .getByRole("tab", { name: "Viewer", exact: true });
  await expect(viewerTab.locator("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );
  await expect(viewerTab.locator("img")).toHaveCount(1);

  const portrait = panel.getByRole("img", { name: "Viewer avatar" });
  await expect(portrait).toBeVisible();
  const name = panel.getByRole("heading", { name: "Viewer", exact: true });
  const portraitWidth = await portrait.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  expect(portraitWidth).toBeCloseTo(80, 0);
  expect(
    await portrait.evaluate(
      (element) => element.getBoundingClientRect().height,
    ),
  ).toBeCloseTo(portraitWidth, 0);
  expect(
    await name.evaluate(
      (element, portrait) =>
        element.getBoundingClientRect().left >=
        portrait.getBoundingClientRect().right,
      await portrait.elementHandle(),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => window.profilesFixture.report.media),
  ).toContainEqual(["https://images.test/avatar.png", undefined]);
  await expect(panel.getByText("Human profile", { exact: true })).toBeVisible();
  // Stub clipboard at the browser boundary: test the UI's exact key and
  // recovery, without relying on OS permission/pasteboard behavior in CI.
  await page.evaluate(() => {
    window.profileCopies = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value) => window.profileCopies.push(value) },
    });
  });
  await panel.getByRole("button", { name: "Copy npub" }).click();
  await expect(panel.getByRole("status")).toHaveText("Public key copied.");
  expect(await page.evaluate(() => window.profileCopies)).toEqual([
    npubs.viewer,
  ]);
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw new Error("denied");
    };
  });
  await panel.getByRole("button", { name: "Copy npub" }).click();
  await expect(panel.getByRole("status")).toHaveText(
    "Could not copy. Select the public key above to copy it.",
  );
  await expect(key).toHaveText(npubs.viewer);
  await page.getByRole("region", { name: "Profile details" }).press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(avatar).toBeFocused();
  const mention = page.getByRole("button", {
    name: "View Mic profile",
    exact: true,
  });
  await mention.click();
  await expect(key).toHaveText(npubs.mic);
  await expect(panel.getByText("📅 In a meeting")).toBeVisible();
  await expect(panel.locator("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );
  await page
    .locator(
      '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
    )
    .click();
  await expect(mention).toBeFocused();
  await mention.press("Space");
  await expect(key).toHaveText(npubs.mic);
  await page.evaluate(() =>
    window.profilesFixture.change("disable", "buzz.profiles"),
  );
  await expect(panel).toHaveCount(0);
  await expect(mention).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Channel message history" })
      .getByText("Hello @Mic", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.profilesFixture.change("enable", "buzz.profiles"),
  );
  await expect(mention).toHaveCount(1);
  await expect(panel).toHaveCount(0);
  await page
    .getByRole("button", { name: "View thread: 1 reply", exact: true })
    .click();
  const threadMention = page.getByRole("button", {
    name: "View Pinky profile",
    exact: true,
  });
  await expect(threadMention).toBeVisible();
  await threadMention.click();
  await expect(key).toHaveText(npubs.pinky);
  await expect(panel.locator("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  await expect(
    panel.getByRole("img", { name: "Pinky avatar" }),
  ).toHaveAttribute("data-size", "fill");
  await expect(panel.getByText("Agent profile", { exact: true })).toBeVisible();
  const identity = panel.getByRole("region", { name: "Agent identity" });
  await expect(identity).toContainText("Managed by");
  await expect(
    identity.getByRole("button", { name: "Open owner profile: Viewer (you)" }),
  ).toBeVisible();
  // Existing navigation journey also proves row hover/focus affordances and host toast wiring.
  await expect(panel.getByRole("tab", { name: "Memories" })).toHaveCount(0);
  await expect(panel.getByRole("tab", { name: "Runtime" })).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: /^Copy Agent type:/ }),
  ).toHaveCount(0);
  const nip05 = panel.getByRole("button", { name: /^Copy NIP-05:/ });
  await expect(nip05).toHaveText("NIP-05pinky@example.test");
  // Keyboard modality, so :focus-visible reveals the copy affordance.
  await nip05.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(nip05).toBeFocused();
  await expect(nip05.locator("[data-copied]")).toHaveCSS("opacity", "1");
  await page.evaluate(() => {
    navigator.clipboard.writeText = async (value) =>
      window.profileCopies.push(value);
  });
  await nip05.press("Enter");
  await expect(page.getByText("Copied nip-05", { exact: true })).toBeVisible();
  await expect(nip05.locator("[data-copied]")).toHaveAttribute(
    "data-copied",
    "true",
  );
  expect(await page.evaluate(() => window.profileCopies.slice(-1))).toEqual([
    "pinky@example.test",
  ]);

  await panel.getByRole("tab", { name: "Channels" }).click();
  await expect(panel.getByRole("region", { name: "Channels" })).toContainText(
    "One",
  );
  await page
    .locator(
      '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
    )
    .click();
  await expect(
    page.locator(
      '[role="tab"][data-tab-value^="thread:"][aria-selected="true"]',
    ),
  ).toBeFocused();
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"])',
    )
    .click();
  const missingKey = await page.evaluate(
    () => window.profilesFixture.keys.missing,
  );
  const unknownAvatar = page.getByRole("button", {
    name: `View ${missingKey.slice(0, 10)} profile`,
  });
  await expect(unknownAvatar.locator("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  await unknownAvatar.click();
  await expect(key).toHaveText(npubs.missing);
  await expect(panel.getByText("Could not load this profile.")).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "Unknown agent", exact: true }),
  ).toBeVisible();
  await expect(
    panel
      .getByRole("img", { name: "Unknown agent avatar" })
      .locator("[data-avatar-shape]"),
  ).toHaveAttribute("data-avatar-shape", "squircle");
  await expect(panel.getByRole("tab", { name: "Runtime" })).toHaveCount(0);
  await expect(panel.getByRole("tab", { name: "Memories" })).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: /^(Start|Stop|Restart|Delete agent)$/ }),
  ).toHaveCount(0);
  await page.evaluate(() => window.profilesFixture.recover());
  await panel.getByRole("button", { name: "Retry profile" }).click();
  await expect(panel.getByText("Recovered biography")).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "Recovered", exact: true }),
  ).toBeVisible();
  await expect(
    panel
      .getByRole("img", { name: "Recovered avatar" })
      .locator("[data-avatar-shape]"),
  ).toHaveAttribute("data-avatar-shape", "squircle");
  for (const mode of ["light", "dark"]) {
    if (mode === "dark")
      await page.getByRole("button", { name: "Toggle appearance" }).click();
    for (const width of [1280, 900, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(key).toBeVisible();
      const layout = await panel.evaluate((element) => {
        const region = element.querySelector('[aria-label="Profile details"]');
        const key = element.querySelector("code");
        return {
          padding: parseFloat(getComputedStyle(region).paddingLeft),
          overflow: element.scrollWidth > element.clientWidth,
          keyOverflow: key.scrollWidth > key.clientWidth,
        };
      });
      expect(layout.padding).toBeGreaterThanOrEqual(16);
      expect(layout.overflow).toBe(false);
      expect(layout.keyOverflow).toBe(false);
      await panel.screenshot({
        path: testInfo.outputPath(`profile-${mode}-${width}.png`),
      });
    }
  }
  await page.evaluate(() => window.profilesFixture.replace());
  await expect(panel).toHaveCount(0);
  const reads = await page.evaluate(() => ({
    reads: window.profilesFixture.report.profileReads,
    key: window.profilesFixture.keys.pinky,
  }));
  expect(reads.reads.some((batch) => batch.includes(reads.key))).toBe(true);
  expect(errors.unexplained()).toEqual([]);
});

test("contextual panel callbacks retire with opening, channel, contribution and session", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/profiles.html?context-probe");
  const avatar = page.getByRole("button", {
    name: "View Viewer profile",
    exact: true,
  });
  const panel = page.getByRole("complementary", {
    name: "Context probe",
    exact: true,
  });
  const capture = async () => {
    await avatar.click();
    await expect(panel).toBeVisible();
    await page.evaluate(() => {
      window.oldPanelContext = window.profilesFixture.contexts.at(-1);
    });
  };
  const invoke = () =>
    page.evaluate(() =>
      window.oldPanelContext.open(window.profilesFixture.targets.mic),
    );
  await capture();
  expect(await page.evaluate(() => window.oldPanelContext.channelId)).toBe(
    "one",
  );
  expect(await invoke()).toBe(true);
  // A second synchronous use of the old opening must not replace its successor.
  expect(await invoke()).toBe(false);
  await page
    .locator(
      '.buzz-tabs-item:not(:has([data-tab-value^="thread:"])) > button:not([role="tab"])',
    )
    .click();
  await capture();
  await page.locator('[data-channel-id="two"]').click();
  await expect(panel).toHaveCount(0);
  expect(await invoke()).toBe(false);
  await page.locator('[data-channel-id="one"]').click();
  await capture();
  await page.evaluate(() =>
    window.profilesFixture.change("disable", "context.probe"),
  );
  expect(await invoke()).toBe(false);
  await expect(panel).toHaveCount(0);
  await page.evaluate(() =>
    window.profilesFixture.change("enable", "context.probe"),
  );
  await expect(avatar).toBeVisible();
  expect(await invoke()).toBe(false);
  await capture();
  await page.evaluate(() => window.profilesFixture.replace());
  expect(await invoke()).toBe(false);
  await expect(panel).toHaveCount(0);
  await capture();
  await page.evaluate(() => window.profilesFixture.disconnect());
  expect(await invoke()).toBe(false);
  await expect(panel).toHaveCount(0);
});

// Messaging an agent needs this machine's own agent for this community, taken
// from the LocalAgents snapshot; a profile's agent hint alone never grants it.
for (const local of [false, true]) {
  test(`profile Message for humans and agents ${local ? "kept" : "not kept"} on this machine`, async ({
    page,
  }) => {
    const errors = watchPageErrors(page);
    await page.goto(
      `/tests/fixtures/profiles.html?member-message${local ? "&local-agent" : ""}`,
    );
    const panel = page.getByRole("complementary", {
      name: "Profile",
      exact: true,
    });
    const message = panel.getByRole("button", { name: "Message", exact: true });
    await page
      .getByRole("button", { name: "View Mic profile", exact: true })
      .click();
    await expect(message).toBeVisible();
    await page
      .getByRole("button", { name: /^Close (?!Thread).* tab$/ })
      .click();
    await page
      .getByRole("button", { name: "View thread: 1 reply", exact: true })
      .click();
    await page
      .getByRole("button", { name: "View Pinky profile", exact: true })
      .click();
    await expect(
      panel.getByText("Agent profile", { exact: true }),
    ).toBeVisible();
    if (!local) {
      await expect(message).toHaveCount(0);
      expect(await page.evaluate(() => window.profilesFixture.dmOpens)).toEqual(
        [],
      );
    } else {
      await message.click();
      await expect
        .poll(() => page.evaluate(() => window.profilesFixture.dmOpens))
        .toEqual([
          [await page.evaluate(() => window.profilesFixture.keys.pinky)],
        ]);
    }
    expect(errors.unexplained()).toEqual([]);
  });
}

test("member rows hand off to Profiles without trapping or losing keyboard focus", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/profiles.html");
  const members = page.getByRole("button", {
    name: "Channel members",
    exact: true,
  });
  await members.click();
  const dialog = page.getByRole("dialog", {
    name: "Channel members",
    exact: true,
    includeHidden: true,
  });
  // The popup owns modal semantics; the active step owns the visible card.
  const surface = dialog.locator(".buzz-dialog-step:not([inert])");
  const body = dialog.locator(".buzz-dialog-body");
  const group = dialog.getByRole("region", { name: "Members", exact: true });
  const list = dialog.getByRole("region", { name: "Member list", exact: true });
  const search = dialog.getByRole("searchbox");
  // Browser-only: one flexing list owns scrolling; title, channel and search
  // remain fixed across themes and viewport widths.
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    for (const width of [1280, 900, 390]) {
      await page.setViewportSize({ width, height: 320 });
      await expect(surface).toBeInViewport({ ratio: 1 });
      await expect(surface).toHaveCSS(
        "background-color",
        mode === "light" ? "rgb(255, 255, 255)" : "rgb(40, 40, 40)",
      );
      await expect(surface).toHaveCSS("backdrop-filter", "none");
      await expect(body).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(body).toHaveCSS("border-top-width", "0px");
      await expect(body).toHaveCSS("overflow-y", "hidden");
      await expect(body).toHaveCSS("padding-bottom", "0px");
      const surfaceBounds = await surface.boundingBox();
      const frameBounds = await list.boundingBox();
      // A footerless flex body must not double the outer bottom gutter.
      expect(
        surfaceBounds.y +
          surfaceBounds.height -
          frameBounds.y -
          frameBounds.height,
      ).toBeCloseTo(frameBounds.x - surfaceBounds.x, 0);
      await expect(list).toHaveCSS("overflow-y", "auto");
      await expect(list).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      // The viewport owns the border, not a scrolling child: the native
      // scrollbar and clipping area must lie inside its fixed perimeter.
      for (const edge of ["top", "right", "bottom", "left"]) {
        await expect(list).toHaveCSS(`border-${edge}-width`, "1px");
      }
      await expect(list).toHaveCSS(
        "border-top-color",
        mode === "light" ? "rgb(232, 232, 232)" : "rgb(35, 35, 35)",
      );
      await expect(group).toHaveCSS("border-top-width", "0px");
      await expect(group).toHaveCSS("overflow-y", "visible");
      const member = group.getByRole("listitem").first();
      await expect(member).toHaveCSS("padding-inline-end", "0px");
      const header = dialog.locator(".buzz-dialog-header");
      const refresh = header.getByRole("button", {
        name: "Refresh member data",
      });
      const close = header.getByRole("button", {
        name: "Close channel members",
      });
      await expect(refresh).toHaveAttribute("data-variant", "ghost");
      await expect(refresh).toHaveAttribute("data-icon-size", "compact");
      const refreshBounds = await refresh.boundingBox();
      const closeBounds = await close.boundingBox();
      expect(refreshBounds.x + refreshBounds.width).toBeLessThanOrEqual(
        closeBounds.x,
      );
      expect(refreshBounds.y).toBe(closeBounds.y);
      expect(refreshBounds.width).toBe(closeBounds.width);
      expect(refreshBounds.height).toBe(closeBounds.height);
      for (const button of [refresh, close]) {
        await expect(button.locator("svg")).toHaveCSS("width", "16px");
        await expect(button.locator("svg")).toHaveCSS("height", "16px");
      }
      expect(await body.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
        false,
      );
      const headerBounds = await header.boundingBox();
      const searchBounds = await search.boundingBox();
      const listBounds = await list.boundingBox();
      const groupBounds = await group.boundingBox();
      expect(await list.evaluate((el) => el.clientTop)).toBe(1);
      expect(await list.evaluate((el) => el.clientLeft)).toBe(1);
      expect(await list.evaluate((el) => el.clientHeight)).toBeLessThan(
        listBounds.height,
      );
      expect(await list.evaluate((el) => el.clientWidth)).toBeLessThan(
        listBounds.width,
      );
      expect(await list.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
        false,
      );
      // This read-only fixture has a notice before the first group. Once that
      // content scrolls out, the heading pins without an extra padding slide.
      await expect(list).toHaveCSS("padding-top", "0px");
      const firstHeading = list.getByRole("heading").first();
      const headingBounds = await firstHeading.boundingBox();
      const leadingContent = headingBounds.y - listBounds.y - 1;
      for (const scrollTop of [0, 1, 8, 16]) {
        await list.evaluate((el, top) => {
          el.scrollTop = top;
        }, leadingContent + scrollTop);
        await expect
          .poll(() => list.evaluate((el) => el.scrollTop))
          .toBe(leadingContent + scrollTop);
        await expect
          .poll(async () => (await firstHeading.boundingBox()).y)
          .toBe(listBounds.y + 1);
      }
      await list.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect
        .poll(() => list.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(0);
      expect(await header.boundingBox()).toEqual(headerBounds);
      expect(await search.boundingBox()).toEqual(searchBounds);
      expect(await list.boundingBox()).toEqual(listBounds);
      expect((await group.boundingBox()).y).toBeLessThan(groupBounds.y);
      expect(await body.evaluate((el) => el.scrollTop)).toBe(0);
      expect(await dialog.evaluate((el) => el.scrollTop)).toBe(0);
      expect(
        await dialog.evaluate((el) =>
          [...el.querySelectorAll("*")]
            .filter(
              (child) =>
                /^(auto|scroll)$/.test(getComputedStyle(child).overflowY) &&
                child.scrollHeight > child.clientHeight,
            )
            .map((child) => child.getAttribute("aria-label")),
        ),
      ).toEqual(["Member list"]);
      await list.evaluate((el) => {
        el.scrollTop = 0;
      });
      // The viewport fills spare height, not the Members group. Search results
      // and recovery content must follow the short roster without a flex spacer.
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(() => list.evaluate((el) => el.clientHeight))
        .toBeGreaterThan(300);
      await expect(group).toHaveCSS("flex-grow", "0");
      expect((await group.boundingBox()).height).toBeLessThan(
        (await list.boundingBox()).height,
      );
    }
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  const row = dialog.getByRole("button", {
    name: /^Open profile for Viewer/,
    includeHidden: true,
  });
  const memberRow = row.locator("xpath=ancestor::li");
  const name = memberRow.getByText("Viewer (you)", { exact: true });
  await expect(name).toBeVisible();
  const npub = memberRow.locator('[aria-hidden="true"].text-mono');
  const metadata = npub.locator("../..");
  await search.hover();
  await expect(metadata).toHaveCSS("height", "0px");
  await expect(npub).toBeHidden();
  const nameAtRest = await name.boundingBox();
  const rowAtRest = await row.boundingBox();
  await row.hover();
  await expect(npub).toBeVisible();
  await expect(metadata).toHaveAttribute("style", /height: auto/);
  await expect(name).toBeVisible();
  await expect(name.locator("..")).toHaveCSS("opacity", "1");
  expect((await name.boundingBox()).y).toBeLessThan(nameAtRest.y);
  expect(await row.boundingBox()).toEqual(rowAtRest);
  await row.locator("[data-avatar-shape]").click();
  const panel = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  // Mainline panel navigation focuses the selected tab, not the details body.
  const profileTab = page
    .getByRole("tablist", { name: "Panel tabs" })
    .getByRole("tab", { name: "Viewer", exact: true });
  await expect(dialog).toHaveCount(0);
  await expect(profileTab).toBeFocused();
  await expect(
    panel.getByRole("heading", { name: "Viewer", exact: true }),
  ).toBeVisible();
  await profileTab.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(members).toBeFocused();
  await members.press("Enter");
  await row.focus();
  await expect(npub).toBeVisible();
  await row.press("Enter");
  await expect(profileTab).toBeFocused();
  await profileTab.press("Escape");
  await expect(members).toBeFocused();
  // Every row, including the viewer and protected identities, has one action
  // slot. Hover/focus only changes visibility, never row or profile geometry.
  await members.click();
  const actions = memberRow.getByRole("button", {
    name: "Actions for Viewer",
    includeHidden: true,
  });
  const actionSlot = actions.locator("..");
  await search.focus();
  await search.hover();
  await expect(actionSlot).toHaveCSS("opacity", "0");
  const restingBounds = await row.boundingBox();
  await memberRow.hover();
  await expect(actionSlot).toHaveCSS("opacity", "1");
  expect(await row.boundingBox()).toEqual(restingBounds);
  await actions.click();
  const menu = page.getByRole("menu", { name: "Actions for Viewer" });
  await expect(menu.getByRole("menuitem")).toHaveText(["View profile"]);
  await expect(menu).toBeFocused();
  await page.mouse.move(0, 0);
  await expect(actionSlot).toHaveCSS("opacity", "1");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(actions).toBeFocused();
  await expect(dialog).toBeVisible();
  await row.focus();
  await expect(actionSlot).toHaveCSS("opacity", "1");
  await page.keyboard.press("Tab");
  await expect(actions).toBeFocused();
  await actions.press("Enter");
  await page.keyboard.press("Escape");
  await expect(actions).toBeFocused();
  await expect(dialog).toBeVisible();

  // Browser-only: portal menus inside a modal must hand focus to the profile
  // panel, or restore the correct row control on Escape, without closing both.
  for (const entry of ["ellipsis", "right-click", "Shift+F10", "ContextMenu"]) {
    if (entry === "ellipsis") await actions.press("Enter");
    else if (entry === "right-click") await row.click({ button: "right" });
    else await row.press(entry);
    await expect(menu.getByRole("menuitem")).toHaveText(["View profile"]);
    if (entry === "right-click") {
      await expect(menu).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(row).toBeFocused();
      await row.click({ button: "right" });
    }
    await menu.getByRole("menuitem", { name: "View profile" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(profileTab).toBeFocused();
    await profileTab.press("Escape");
    await expect(members).toBeFocused();
    await members.press("Enter");
  }
  await dialog.getByRole("button", { name: "Close channel members" }).click();
  await page.evaluate(() =>
    window.profilesFixture.change("disable", "buzz.profiles"),
  );
  await members.click();
  await expect(
    dialog.getByRole("button", { name: /^Open profile for/ }),
  ).toHaveCount(0);
  await expect(dialog.getByText("Viewer (you)", { exact: true })).toBeVisible();
  const staticActions = dialog.getByRole("button", {
    name: "Actions for Viewer",
  });
  const staticMember = staticActions.locator("xpath=ancestor::li");
  await staticMember.hover();
  await staticActions.click();
  await expect(
    menu.getByRole("menuitem", { name: "View profile" }),
  ).toBeDisabled();
  await expect(menu).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(staticActions).toBeFocused();
  expect(errors.unexplained()).toEqual([]);
});

// Touch has no hover discovery. The action must be visible and operable at rest,
// with the real Base UI menu/modal focus layers rather than a DOM-only substitute.
test.describe("touch member actions", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("keeps the ellipsis available without hover", async ({ page }) => {
    await page.goto("/tests/fixtures/profiles.html");
    const members = page.getByRole("button", {
      name: "Channel members",
      exact: true,
    });
    await members.tap();
    const dialog = page.getByRole("dialog", {
      name: "Channel members",
      exact: true,
    });
    const actions = dialog.getByRole("button", { name: "Actions for Viewer" });
    await expect(actions.locator("..")).toHaveCSS("opacity", "1");
    await actions.tap();
    await page.getByRole("menuitem", { name: "View profile" }).tap();
    await expect(dialog).toHaveCount(0);
    const profileTab = page
      .getByRole("tablist", { name: "Panel tabs" })
      .getByRole("tab", { name: "Viewer", exact: true });
    await expect(profileTab).toBeFocused();
    await profileTab.press("Escape");
    await expect(members).toBeFocused();
  });
});

// Real Members -> verified session DM -> ChannelsPage navigation/focus handoff.
// Only the relay transport is synthetic; this must never send a live message.
test("member Send message navigates a human DM without sending or returning focus to Members", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/profiles.html?member-message");
  await page
    .getByRole("button", { name: "Channel members", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Channel members",
    exact: true,
  });
  const actions = dialog.getByRole("button", {
    name: "Actions for Mic",
    exact: true,
  });
  await actions.locator("xpath=ancestor::li").hover();
  await actions.click();
  const menu = page.getByRole("menu", { name: "Actions for Mic", exact: true });
  await expect(menu.getByRole("menuitem")).toHaveText([
    "View profile",
    "Send message",
  ]);
  await menu
    .getByRole("menuitem", { name: "Send message", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.profilesFixture.dmOpens))
    .toEqual([[await page.evaluate(() => window.profilesFixture.keys.mic)]]);
  await expect(
    page.getByRole("tab", { name: "Mic", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message #Mic", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Channel members", exact: true }),
  ).not.toBeFocused();
  expect(
    await page.evaluate(() => window.profilesFixture.report.publications),
  ).toBe(0);
  // Returning to the Members visit must not repeat the DM open or send.
  await page.evaluate(() => window.profilesFixture.navigation.back());
  await expect(dialog.getByRole("searchbox")).toBeFocused();
  expect(
    await page.evaluate(
      () => window.profilesFixture.navigation.snapshot().entry.target.panel,
    ),
  ).toBe("members");
  await page.evaluate(() => window.profilesFixture.navigation.forward());
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message #Mic", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.profilesFixture.dmOpens)).toEqual([
    [await page.evaluate(() => window.profilesFixture.keys.mic)],
  ]);
  expect(
    await page.evaluate(() => window.profilesFixture.report.publications),
  ).toBe(0);
  expect(errors.unexplained()).toEqual([]);
});
