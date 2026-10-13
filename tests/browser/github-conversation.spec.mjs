import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { end, settle } from "./timeline.mjs";
import { fileURLToPath } from "node:url";

test.use({ historyCounts: { alpha: 1, beta: 0 }, hasTouch: true });
const target = "https://github.com/sample/project/pull/1";
const picture =
  "https://raw.githubusercontent.com/sample/project/main/preview.png";

// Browser-only: actual app wiring, event markers on an unboxed timeline, responsive geometry,
// keyboard/touch activation, one-line disclosure measurement and thumbnail lightboxes.
// Source recovery and paging matrices belong to colocated tests.
test("PR conversation hierarchy and disclosures survive themes, narrow panes and enlarged text", async ({
  page,
  context,
  app,
}, testInfo) => {
  // Fix the page's clock near the fixture dates. Relative dates ("6 days
  // ago" vs "on Oct 1") change header wrapping, which the layout checks
  // below measure.
  await page.clock.install({ time: new Date("2026-10-02T12:00:00Z") });
  const requests = [];
  // Exercise browser menu wiring without writing to the machine's clipboard.
  await page.addInitScript(() => {
    window.githubCopiedLinks = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value) => {
          window.githubCopiedLinks.push(value);
        },
      },
    });
  });
  await page.route(
    "https://api.github.com/repos/sample/project/**",
    (route) => {
      const url = new URL(route.request().url());
      requests.push(url.pathname);
      const common = { created_at: "2026-10-01T16:00:00Z" };
      const json = url.pathname.endsWith("/reviews")
        ? [
            {
              id: 10,
              submitted_at: "2026-10-01T18:00:00Z",
              state: "CHANGES_REQUESTED",
              user: { login: "reviewer" },
              body: `Keep the empty state useful. ${"A long review summary should stay within the pane while its actions remain separate from the disclosure. ".repeat(6)}\n\n## Review details\n\nPlease preserve the retry action.`,
            },
            {
              id: 11,
              submitted_at: "2026-10-01T20:00:00Z",
              state: "COMMENTED",
              user: { login: "reader" },
              body: "The **timeline** is easier to scan now, with all the context in place.",
            },
            {
              id: 12,
              submitted_at: "2026-10-01T21:00:00Z",
              state: "APPROVED",
              user: { login: "maintainer" },
              body: "",
            },
            {
              id: 13,
              submitted_at: "2026-10-01T20:10:00Z",
              state: "COMMENTED",
              user: { login: "inline-only" },
              body: "",
            },
            {
              id: 14,
              submitted_at: "2026-10-01T20:10:02Z",
              state: "COMMENTED",
              user: { login: "inline-only" },
              body: " \n ",
            },
          ]
        : url.pathname.endsWith("/issues/1/comments")
          ? [
              {
                ...common,
                id: 20,
                user: { login: "contributor" },
                body: "The smaller layout is easier to read.\n\n## Discussion details\n\nThanks for keeping the metadata quiet.",
              },
            ]
          : {
              ...common,
              title: "Make the conversation easier to follow",
              state: "open",
              user: { login: "author" },
              body: `A quieter conversation, with context when you need it.\n\n## Description details\n\n${Array.from({ length: 5 }, (_, index) => `![Preview ${index}](${picture}?image=${index})`).join("\n\n")}`,
              head: { label: "sample:conversation", sha: "head-sha" },
              comments: 1,
            };
      return route.fulfill({ json });
    },
  );
  let previewScreenshot;
  await context.route(`${picture}*`, (route) =>
    route.fulfill({
      ...(previewScreenshot
        ? { body: previewScreenshot }
        : {
            path: fileURLToPath(
              new URL("../../public/app-icon.png", import.meta.url),
            ),
          }),
      contentType: "image/png",
    }),
  );
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .waitFor();
  await settle(page);
  previewScreenshot = await page.screenshot();
  app.append("primary", "alpha", target);
  const link = page.locator(`a[href="${target}"]`);
  await expect(link).toBeAttached();
  await end(page);
  await link.click();
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  const conversation = panel.getByRole("region", {
    name: "Pull request conversation",
    exact: true,
  });
  await expect(conversation).toBeVisible();
  await expect(
    conversation.getByText(/some sources are incomplete/),
  ).toHaveCount(0);
  await expect(
    conversation.getByText("inline-only", { exact: true }),
  ).toHaveCount(0);
  await expect(conversation.getByRole("group")).toHaveCount(5);
  const expectDateEdge = async () => {
    await expect
      .poll(() =>
        conversation.locator("time").evaluateAll((nodes) => {
          const edges = nodes.map((node) => node.getBoundingClientRect().right);
          return Math.max(...edges) - Math.min(...edges);
        }),
      )
      .toBeLessThan(1);
  };
  await expectDateEdge();
  const longReview = conversation.getByRole("group", {
    name: "Changes requested",
    exact: true,
  });
  const expectReviewContained = async () => {
    await expect
      .poll(() =>
        longReview.evaluate((event) => {
          const header = event.querySelector('[class*="messageHeader"]');
          return (
            header.getBoundingClientRect().right <=
            event.getBoundingClientRect().right + 1
          );
        }),
      )
      .toBe(true);
  };
  await expectReviewContained();
  await longReview.hover();
  await expectReviewContained();
  await expect(
    panel.getByRole("tab", { name: "Discussion", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    panel.getByRole("tab", { name: "Checks", exact: true }),
  ).toHaveAttribute("aria-selected", "false");
  await expect(
    panel.getByRole("tabpanel", { name: "Discussion", exact: true }),
  ).toBeVisible();
  await expect(panel.locator("[data-check-state]")).toHaveCount(0);
  expect([...requests].sort()).toEqual([
    "/repos/sample/project/issues/1/comments",
    "/repos/sample/project/pulls/1",
    "/repos/sample/project/pulls/1/reviews",
  ]);
  await expect(
    panel.locator("dt").filter({ hasText: /^Comments$/ }),
  ).toHaveCount(0);
  const description = panel.getByRole("button", {
    name: "Expand Description",
    exact: true,
  });
  await expect(description).toHaveAttribute("aria-expanded", "false");
  const descriptionEvent = conversation.getByRole("group", {
    name: "Description",
    exact: true,
  });
  const thumbnails = descriptionEvent
    .locator('[class*="thumbnails"]')
    .getByRole("button", { name: "Open image fullscreen" });
  const expectLayoutBasedThumbnails = async () => {
    const expectedCapacity = await descriptionEvent
      .locator('[class*="thumbnails"]')
      .evaluate((row) => {
        const tile = row.firstElementChild.getBoundingClientRect().width;
        const gap = parseFloat(getComputedStyle(row).columnGap);
        return Math.max(1, Math.floor((row.clientWidth + gap) / (tile + gap)));
      });
    const shown = Math.min(5, expectedCapacity);
    await expect(thumbnails).toHaveCount(shown);
    const tops = await thumbnails.evaluateAll((tiles) =>
      tiles.map((tile) => tile.getBoundingClientRect().top),
    );
    expect(new Set(tops).size).toBe(1);
    const remaining = 5 - shown;
    if (remaining)
      await expect(descriptionEvent).toContainText(`+${remaining}`);
    else
      await expect(
        descriptionEvent.locator('[class*="thumbnailCount"]'),
      ).toHaveCount(0);
  };
  await expect(thumbnails).toHaveCount(5);
  await expect(thumbnails.first().locator("img")).toHaveCSS(
    "object-fit",
    "cover",
  );
  await expect(descriptionEvent).not.toContainText("+2");
  await expect(
    panel.getByRole("heading", { name: "Description details" }),
  ).toHaveCount(0);
  const comment = panel.getByRole("button", {
    name: "Expand Comment",
    exact: true,
  });
  const review = panel.getByRole("button", {
    name: "Expand Changes requested",
    exact: true,
  });
  expect((await comment.boundingBox()).y).toBeLessThan(
    (await review.boundingBox()).y,
  );
  const commentEvent = conversation.getByRole("group", {
    name: "Comment",
    exact: true,
  });
  const commentActions = commentEvent.getByRole("button", {
    name: "Comment actions",
  });
  const expectActionsCenteredUnderCarets = async () => {
    for (const event of [commentEvent, longReview]) {
      await expect
        .poll(() =>
          event.evaluate((node) => {
            const caret = node
              .querySelector('[class*="messageTrigger"] > svg')
              .getBoundingClientRect();
            const action = node
              .querySelector('[aria-label="Comment actions"]')
              .getBoundingClientRect();
            return Math.abs(
              caret.left + caret.width / 2 - (action.left + action.width / 2),
            );
          }),
        )
        .toBeLessThan(1);
    }
  };
  const actionSlot = commentActions.locator("..");
  await expectActionsCenteredUnderCarets();
  await expect(actionSlot).toHaveAttribute("data-menu-action", "true");
  await page.mouse.move(0, 0);
  const fineHover = await page.evaluate(
    () => matchMedia("(hover: hover) and (pointer: fine)").matches,
  );
  if (fineHover) await expect(actionSlot).toHaveCSS("opacity", "0");
  else await expect(actionSlot).toHaveCSS("opacity", "1");
  await comment.focus();
  await expect(actionSlot).toHaveCSS("opacity", "1");
  await comment.hover();
  await expect(commentActions).toHaveCSS("width", "20px");
  await expect(commentActions).toHaveCSS("height", "20px");
  await commentActions.hover();
  await expect(commentActions).not.toHaveAttribute("aria-describedby");
  await commentActions.click();
  await expect(page.getByRole("menu")).toHaveAttribute("data-size", "default");
  await expect(
    page.getByRole("menuitem", { name: "Copy link", exact: true }),
  ).toBeVisible();
  // Capture the shared menu after its real entrance transition has settled.
  await expect(page.getByRole("menu")).toHaveCSS("filter", "blur(0px)");
  await panel.screenshot({
    path: testInfo.outputPath("comment-copy-menu.png"),
  });
  await page.getByRole("menuitem", { name: "Copy link", exact: true }).click();
  await expect(
    page.getByText("Comment link copied", { exact: true }),
  ).toBeVisible();
  await expect(comment).toHaveAttribute("aria-expanded", "false");
  await expect
    .poll(() => page.evaluate(() => window.githubCopiedLinks))
    .toEqual([`${target}#issuecomment-20`]);
  await comment.click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveAttribute("data-size", "default");
  await page.getByRole("menuitem", { name: "Copy link", exact: true }).click();
  await expect(comment).toHaveAttribute("aria-expanded", "false");
  await expect
    .poll(() => page.evaluate(() => window.githubCopiedLinks))
    .toEqual([`${target}#issuecomment-20`, `${target}#issuecomment-20`]);
  await comment.focus();
  await page.keyboard.press("Shift+F10");
  const keyboardMenuItem = page.getByRole("menuitem", {
    name: "Copy link",
    exact: true,
  });
  await expect(keyboardMenuItem).toBeVisible();
  // Base UI applies keyboard focus after the popup mounts. Escape must originate
  // inside that popup, not race its initial focus handoff and close the host pane.
  await expect(page.getByRole("menu")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(comment).toBeFocused();
  await comment.click();
  await expect(
    panel.getByRole("heading", { name: "Discussion details" }),
  ).toBeVisible();
  await expect(commentActions).toHaveCount(0);
  const copyAction = commentEvent.getByRole("button", {
    name: "Copy link",
    exact: true,
  });
  await expect(copyAction).toHaveAttribute("data-variant", "subtle");
  await expect(copyAction.locator("svg")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  const actionsBox = await copyAction.boundingBox();
  const bodyBox = await commentEvent
    .locator('[class*="messageBody"]')
    .boundingBox();
  expect(actionsBox.y).toBeGreaterThanOrEqual(bodyBox.y + bodyBox.height);
  await panel.screenshot({
    path: testInfo.outputPath("comment-expanded-actions.png"),
  });
  await copyAction.tap();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(comment).toHaveAttribute("aria-expanded", "true");
  await comment.click();
  const reviewEvent = conversation.getByRole("group", {
    name: "Changes requested",
    exact: true,
  });
  await reviewEvent.getByRole("button", { name: "Comment actions" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Copy link", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.githubCopiedLinks))
    .toEqual([
      `${target}#issuecomment-20`,
      `${target}#issuecomment-20`,
      `${target}#issuecomment-20`,
      `${target}#pullrequestreview-10`,
    ]);
  await expect(review).toHaveAttribute("aria-expanded", "false");
  expect(requests).toHaveLength(3);

  await expect(description).toHaveCSS("font-size", "14px");
  await expect(
    conversation.locator(
      '[data-buzz-ui][aria-label="Description"] .buzz-avatar',
    ),
  ).toHaveCSS("width", "32px");
  await expect(conversation.locator(".buzz-avatar")).toHaveCount(1);
  for (const label of [
    "Comment",
    "Review comment",
    "Approved",
    "Changes requested",
  ]) {
    const marker = conversation
      .getByRole("group", { name: label, exact: true })
      .locator(":scope > div")
      .first();
    await expect(marker.locator("svg")).toHaveCSS("width", "20px");
  }
  const expectThumbnailsBelowExcerpt = async () => {
    const excerpt = description.locator("..").locator(":scope > span").last();
    const textBox = await excerpt.boundingBox();
    const imageBox = await descriptionEvent
      .locator("img")
      .first()
      .locator("..")
      .boundingBox();
    const caretBox = await description.locator(":scope > svg").boundingBox();
    expect(imageBox.y).toBeGreaterThan(textBox.y + textBox.height);
    expect(Math.abs(imageBox.x - textBox.x)).toBeLessThan(1);
    expect(caretBox.y).toBeLessThan(textBox.y + textBox.height);
  };
  const expectStationaryCarets = async () => {
    for (const trigger of [description, comment, review]) {
      const caretPosition = () =>
        trigger.evaluate((node) => {
          const content = node.parentElement.getBoundingClientRect();
          const caret = node
            .querySelector(":scope > svg")
            .getBoundingClientRect();
          return { x: caret.right - content.left, y: caret.top - content.top };
        });
      const baseline = () =>
        trigger.evaluate((node) => {
          const event = node.closest('[role="group"]');
          const content = event.lastElementChild;
          const author = content.querySelector("a").getBoundingClientRect();
          const time = content.querySelector("time").getBoundingClientRect();
          const text = [
            ...content.querySelectorAll(
              '[class*="previewText"], [class*="messageBody"] [class*="paragraph"]',
            ),
          ].find((element) => element.getClientRects().length);
          const range = document.createRange();
          range.selectNodeContents(text);
          const line = range.getClientRects()[0];
          const top = content.getBoundingClientRect().top;
          return {
            author: author.top - top,
            time: time.top - top,
            text: line.top - top,
          };
        });
      const collapsedBaseline = await baseline();
      const collapsed = await caretPosition();
      const headerBottom = await trigger.evaluate((node) => {
        const header = node.parentElement
          .querySelector("time")
          .getBoundingClientRect();
        return header.bottom - node.parentElement.getBoundingClientRect().top;
      });
      expect(collapsed.y).toBeLessThan(headerBottom);
      await trigger.locator(":scope > svg").click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect.poll(caretPosition).toEqual(collapsed);
      await expect.poll(baseline).toEqual(collapsedBaseline);
      // In narrow/enlarged headers the button's center can be the author link,
      // which deliberately stays independently clickable. Use the visible caret.
      await trigger.locator(":scope > svg").click();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect.poll(caretPosition).toEqual(collapsed);
    }
  };
  const singleLine = conversation.getByRole("group", {
    name: "Review comment",
    exact: true,
  });
  const singleLineTrigger = singleLine.getByRole("button", {
    name: "Expand Review comment",
    exact: true,
  });
  const wideViewport = page.viewportSize();
  await expect(singleLineTrigger).toHaveCount(0);
  const singleLineActions = singleLine.getByRole("button", {
    name: "Comment actions",
  });
  await expect(
    singleLine.getByRole("button", { name: "Copy link" }),
  ).toHaveCount(0);
  await singleLineActions.click();
  await expect(page.getByRole("menu")).toHaveAttribute("data-size", "default");
  await page.getByRole("menuitem", { name: "Copy link", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.githubCopiedLinks.at(-1)))
    .toBe(`${target}#pullrequestreview-11`);
  await expect(singleLineTrigger).toHaveCount(0);
  await page.setViewportSize({ width: 800, height: 950 });
  await expect(singleLineTrigger).toBeAttached();
  await singleLineTrigger.click();
  await expect(singleLineTrigger).toHaveAttribute("aria-expanded", "true");
  await page.setViewportSize(wideViewport);
  await expect(singleLineTrigger).toHaveCount(0);
  await page.setViewportSize({ width: 800, height: 950 });
  await expect(singleLineTrigger).toHaveAttribute("aria-expanded", "true");
  await singleLineTrigger.click();
  await page.setViewportSize(wideViewport);
  await expect(singleLineTrigger).toHaveCount(0);
  const expectSingleLineActionInCaretSlot = async () => {
    await expect(singleLine).toHaveAttribute("data-single-line", "true");
    await expect
      .poll(() =>
        conversation.evaluate((node) => {
          const short = node.querySelector('[aria-label="Review comment"]');
          const expandable = node.querySelector('[aria-label="Comment"]');
          const header = (row) =>
            row
              .querySelector('[class*="messageHeader"]')
              .getBoundingClientRect();
          const action = short
            .querySelector('[aria-label="Comment actions"]')
            .getBoundingClientRect();
          const caret = expandable
            .querySelector('[class*="messageTrigger"] > svg')
            .getBoundingClientRect();
          return Math.max(
            Math.abs(
              header(short).right -
                (action.left + action.width / 2) -
                (header(expandable).right - (caret.left + caret.width / 2)),
            ),
            Math.abs(
              action.top +
                action.height / 2 -
                header(short).top -
                (caret.top + caret.height / 2 - header(expandable).top),
            ),
          );
        }),
      )
      .toBeLessThan(1);
  };
  await expectSingleLineActionInCaretSlot();
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await expect(conversation).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(conversation).toHaveCSS("padding", "0px");
    await expect(conversation).toHaveCSS("border-radius", "0px");
    for (const label of [
      "Description",
      "Review comment",
      "Approved",
      "Changes requested",
    ]) {
      const event = conversation.getByRole("group", {
        name: label,
        exact: true,
      });
      await expect(event).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(event).toHaveCSS("border-radius", "0px");
      await expect(event).toHaveCSS("border-width", "0px");
      await expect(event).toHaveCSS("box-shadow", "none");
    }
    const colors = await conversation.evaluate((node) => {
      const resolved = (token) => {
        const probe = document.createElement("span");
        probe.style.color = `var(${token})`;
        node.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      };
      const markerColor = (label) =>
        getComputedStyle(
          node.querySelector(`[role="group"][aria-label="${label}"] svg`),
        ).color;
      return {
        approved: markerColor("Approved"),
        requested: markerColor("Changes requested"),
        reviewed: markerColor("Review comment"),
        comment: markerColor("Comment"),
        success: resolved("--text-success"),
        danger: resolved("--text-danger"),
        neutral: resolved("--text-subtle"),
        standard: resolved("--text-standard"),
      };
    });
    expect(colors.approved).toBe(colors.success);
    expect(colors.requested).toBe(colors.danger);
    expect(colors.reviewed).toBe(colors.standard);
    expect(colors.comment).toBe(colors.neutral);
    expect(colors.reviewed).not.toBe(colors.comment);
    expect(
      new Set([colors.approved, colors.requested, colors.reviewed]).size,
    ).toBe(3);
    const quiet = conversation.getByRole("group", {
      name: "Comment",
      exact: true,
    });
    await expect(quiet).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const geometry = await conversation.evaluate((node) => {
      const featured = node.querySelector('[aria-label="Description"]');
      const quiet = node.querySelector('[aria-label="Comment"]');
      const timeline = featured.parentElement;
      const rail = getComputedStyle(timeline, "::before");
      const commentTime = quiet.querySelector("time").getBoundingClientRect();
      const commentTrigger = quiet
        .querySelector('[aria-label="Expand Comment"]')
        .getBoundingClientRect();
      const avatar = quiet
        .querySelector('[aria-label="Toggle Comment"]')
        .getBoundingClientRect();
      const featuredTrigger = featured
        .querySelector('[aria-label="Expand Description"]')
        .getBoundingClientRect();
      return {
        railX: timeline.getBoundingClientRect().left + parseFloat(rail.left),
        markerX: avatar.left + avatar.width / 2,
        textX: featuredTrigger.left,
        authorX: quiet.querySelector("a").parentElement.getBoundingClientRect()
          .left,
        timeX: commentTime.right,
        sameRow:
          commentTime.top < commentTrigger.bottom &&
          commentTime.bottom > commentTrigger.top,
      };
    });
    expect(Math.abs(geometry.railX - geometry.markerX)).toBeLessThan(1);
    expect(Math.abs(geometry.textX - geometry.authorX)).toBeLessThan(1);
    expect(geometry.sameRow).toBe(true);
    for (const label of [
      "Description",
      "Comment",
      "Review comment",
      "Changes requested",
    ]) {
      const layout = await conversation
        .getByRole("group", { name: label, exact: true })
        .evaluate((node) => {
          const author = node
            .querySelector("a")
            .parentElement.getBoundingClientRect();
          const time = node.querySelector("time").getBoundingClientRect();
          const excerpt = node
            .querySelector('[class*="previewText"], [class*="messageBody"]')
            .getBoundingClientRect();
          return {
            authorX: author.left,
            excerptX: excerpt.left,
            authorBottom: author.bottom,
            timeBottom: time.bottom,
            timeRight: time.right,
            excerptTop: excerpt.top,
          };
        });
      expect(Math.abs(layout.authorX - layout.excerptX)).toBeLessThan(1);
      expect(layout.excerptTop).toBeGreaterThanOrEqual(layout.authorBottom);
      expect(layout.excerptTop).toBeGreaterThanOrEqual(layout.timeBottom);
      expect(Math.abs(layout.timeRight - geometry.timeX)).toBeLessThan(1);
    }
    await expectDateEdge();
    const descriptionTimeRight = await conversation
      .getByRole("group", { name: "Description", exact: true })
      .locator("time")
      .evaluate((node) => node.getBoundingClientRect().right);
    expect(Math.abs(descriptionTimeRight - geometry.timeX)).toBeLessThan(1);
    await expect(conversation.getByText("All pages loaded")).toHaveCount(0);
    await expect(thumbnails.first().locator("..")).toHaveCSS(
      "position",
      "relative",
    );
    const edge = await thumbnails
      .first()
      .locator("..")
      .evaluate((tile) => {
        const outline = getComputedStyle(tile, "::after");
        const probe = document.createElement("span");
        probe.style.color = "var(--border-standard)";
        tile.append(probe);
        const token = getComputedStyle(probe).color;
        probe.remove();
        return {
          width: outline.borderTopWidth,
          color: outline.borderTopColor,
          token,
        };
      });
    expect(edge.width).toBe("1px");
    expect(edge.color).toBe(edge.token);
    const bodyless = conversation.getByRole("group", {
      name: "Approved",
      exact: true,
    });
    const expectCentered = async () => {
      const centers = await bodyless.evaluate((row) => {
        const marker = row.firstElementChild.getBoundingClientRect();
        const metadata = row.lastElementChild.getBoundingClientRect();
        return {
          marker: marker.top + marker.height / 2,
          text: metadata.top + metadata.height / 2,
        };
      });
      expect(Math.abs(centers.marker - centers.text)).toBeLessThan(1);
    };
    await expectCentered();
    await expectThumbnailsBelowExcerpt();
    await expectStationaryCarets();
    await expectSingleLineActionInCaretSlot();
    await expectActionsCenteredUnderCarets();
    await commentActions.hover();
    await commentEvent.screenshot({
      path: testInfo.outputPath(`comment-actions-centered-${mode}.png`),
    });
    await comment.click();
    await panel.getByRole("heading").first().hover();
    await commentEvent.screenshot({
      path: testInfo.outputPath(`comment-copy-subtle-${mode}.png`),
    });
    await comment.click();
    await panel.getByRole("heading").first().hover();
    await panel.screenshot({
      path: testInfo.outputPath(`conversation-${mode}.png`),
    });
  }
  const timePositions = async () => {
    const positions = {};
    for (const label of ["Description", "Comment", "Changes requested"]) {
      positions[label] = await conversation
        .getByRole("group", { name: label, exact: true })
        .locator("time")
        .evaluate((node) => node.getBoundingClientRect().right);
    }
    return positions;
  };
  const collapsedTimes = await timePositions();
  const commentMarker = panel.getByRole("button", {
    name: "Toggle Comment",
    exact: true,
  });
  await thumbnails.first().focus();
  await expect(thumbnails.first()).toBeFocused();
  await commentMarker.tap();
  await expect(comment).toHaveAttribute("aria-expanded", "true");
  await commentMarker.focus();
  await page.keyboard.press("Space");
  await expect(comment).toHaveAttribute("aria-expanded", "false");
  // Thumbnails open the shared lightbox without changing disclosure state.
  await thumbnails.first().tap();
  const lightbox = page.getByRole("dialog", { name: "Image attachment" });
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator("img")).toHaveAttribute(
    "src",
    `${picture}?image=0`,
  );
  await lightbox.screenshot({
    path: testInfo.outputPath("thumbnail-lightbox.png"),
  });
  await page.keyboard.press("Escape");
  await expect(lightbox).toHaveCount(0);
  await expect(description).toHaveAttribute("aria-expanded", "false");
  await thumbnails.first().focus();
  await page.keyboard.press("Enter");
  await expect(lightbox).toBeVisible();
  await lightbox
    .getByRole("button", { name: "Close fullscreen viewer" })
    .click();
  await expect(thumbnails.first()).toBeFocused();
  const profile = descriptionEvent.getByRole("link", {
    name: "author",
    exact: true,
  });
  expect(
    await profile.evaluate((link) => {
      const box = link.getBoundingClientRect();
      return (
        document
          .elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
          ?.closest("a") === link
      );
    }),
  ).toBe(true);
  // Label, timestamp, excerpt and whitespace belong to the same large target.
  const header = description.locator("..");
  for (const content of [
    header.getByText("Description", { exact: true }),
    header.locator("time"),
    header.locator(":scope > span").last(),
  ]) {
    const box = await content.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(description).toHaveAttribute("aria-expanded", "true");
    await description.click();
  }
  await description.click();
  await expect(
    panel.getByRole("heading", { name: "Description details" }),
  ).toBeVisible();
  await expect(thumbnails.first()).toBeHidden();
  const fullImage = descriptionEvent
    .locator('[class*="attachment"] [data-image-preview]')
    .first();
  await expect(fullImage).toBeVisible();
  expect(
    await fullImage.evaluate(
      (node) => getComputedStyle(node, "::after").borderTopWidth,
    ),
  ).toBe("1px");
  expect(await timePositions()).toEqual(collapsedTimes);
  await description.focus();
  await page.keyboard.press("Space");
  await expect(description).toHaveAttribute("aria-expanded", "false");
  await comment.focus();
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("heading", { name: "Discussion details" }),
  ).toBeVisible();
  await review.tap();
  await expect(
    panel.getByRole("heading", { name: "Review details" }),
  ).toBeVisible();
  await expect(comment).toHaveAttribute("aria-expanded", "true");
  for (const expanded of [comment, review]) {
    await expect(
      expanded.locator("..").locator(":scope > span").last(),
    ).toBeHidden();
  }
  expect(await timePositions()).toEqual(collapsedTimes);
  await expectDateEdge();
  const approval = conversation.getByRole("group", {
    name: "Approved",
    exact: true,
  });
  await expect(
    approval.getByRole("button", { name: /Expand|Toggle/ }),
  ).toHaveCount(0);
  const approvalActions = approval.getByRole("button", {
    name: "Comment actions",
  });
  const approvalSlot = approvalActions.locator("..");
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.activeElement?.blur());
  if (fineHover) {
    await expect(approvalSlot).toHaveCSS("opacity", "0");
    await expect(approvalSlot).toHaveCSS("pointer-events", "none");
    await approval.locator('[class*="messageMarker"]').hover();
    await expect(approvalSlot).toHaveCSS("opacity", "1");
    await page.mouse.move(0, 0);
    await expect(approvalSlot).toHaveCSS("opacity", "0");
  } else await expect(approvalSlot).toHaveCSS("opacity", "1");
  await approvalActions.focus();
  await expect(approvalSlot).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("menuitem", { name: "Copy link", exact: true }),
  ).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(approvalSlot).toHaveCSS("opacity", "1");
  await page.keyboard.press("Escape");
  await expect(approvalActions).toBeFocused();
  await expect(approvalSlot).toHaveCSS("opacity", "1");
  await page.evaluate(() => document.activeElement?.blur());
  if (fineHover) await expect(approvalSlot).toHaveCSS("opacity", "0");
  await expect(approval.getByText("No message provided")).toHaveCount(0);
  await expect(approval).not.toContainText("loaded code threads");
  await expect(
    approval.locator('[class*="previewText"], [class*="messageBody"]'),
  ).toHaveCount(0);
  await panel.screenshot({
    path: testInfo.outputPath("conversation-expanded-dark.png"),
  });
  await comment.click();
  await review.click();
  for (const width of [800, 480]) {
    await page.setViewportSize({ width, height: 950 });
    await expectReviewContained();
    await expectDateEdge();
    await expectActionsCenteredUnderCarets();
    await description.scrollIntoViewIfNeeded();
    await expectThumbnailsBelowExcerpt();
    await expectLayoutBasedThumbnails();
    await description.screenshot({
      path: testInfo.outputPath(`summary-${width}.png`),
    });
    expect(
      await description.evaluate(
        (node) => node.scrollWidth <= node.clientWidth,
      ),
    ).toBe(true);
    expect(
      await conversation.evaluate(
        (node) => node.scrollWidth <= node.clientWidth,
      ),
    ).toBe(true);
  }
  // Use the host's real text-scale preference; no substitute CSS scaling.
  await page.evaluate(() => {
    localStorage.setItem("buzz-font-scale.v1", "2");
  });
  await page.reload();
  await openPage(page, "Messages");
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .waitFor();
  await settle(page);
  await page.locator(`a[href="${target}"]`).click();
  await expect(description).toHaveCSS("font-size", "28px");
  await expectLayoutBasedThumbnails();
  const enlargedCenters = await approval.evaluate((row) => {
    const marker = row.firstElementChild.getBoundingClientRect();
    const content = row.lastElementChild.getBoundingClientRect();
    return [marker.top + marker.height / 2, content.top + content.height / 2];
  });
  expect(Math.abs(enlargedCenters[0] - enlargedCenters[1])).toBeLessThan(1);
  await expect(singleLineTrigger).toBeAttached();
  await expectDateEdge();
  await expect(conversation).toBeVisible();
  await expect(
    conversation.getByText(/some sources are incomplete/),
  ).toHaveCount(0);
  await description.scrollIntoViewIfNeeded();
  await expectThumbnailsBelowExcerpt();
  await expectStationaryCarets();
  await expectActionsCenteredUnderCarets();
  const preview = description.locator("..").locator(":scope > span").last();
  expect((await preview.boundingBox()).width).toBeGreaterThan(100);
  expect(
    await description.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  expect(
    await conversation.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await description
    .locator("xpath=../..")
    .screenshot({ path: testInfo.outputPath("description-narrow-200.png") });
  await panel.screenshot({
    path: testInfo.outputPath("conversation-narrow-200.png"),
  });
  await expectReviewContained();
  await comment.locator(":scope > svg").click();
  await copyAction.scrollIntoViewIfNeeded();
  await expect(copyAction).toBeVisible();
  await copyAction.tap();
  await expect
    .poll(() => page.evaluate(() => window.githubCopiedLinks))
    .toEqual([`${target}#issuecomment-20`]);
  await expect(comment).toHaveAttribute("aria-expanded", "true");
  expect(
    await conversation.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page
    .locator(".buzz-toast-viewport")
    .getByRole("button", { name: "Dismiss notification" })
    .click();
  await expect(
    page.getByText("Comment link copied", { exact: true }),
  ).toHaveCount(0);
  await commentEvent.screenshot({
    path: testInfo.outputPath("expanded-actions-narrow-200.png"),
  });
});

// Browser-only: in-place group geometry, keyboard/touch disclosure, actual-app wiring.
// Ordering, decision boundaries, source failures and paging remain covered in Vitest.
test("conversation history expands around merge without hiding approval-only milestones", async ({
  page,
  app,
}, testInfo) => {
  const requests = [];
  await page.addInitScript(() => {
    window.githubCopiedLinks = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value) => window.githubCopiedLinks.push(value),
      },
    });
  });
  const time = (hour) => `2026-10-01T${hour}:00:00Z`;
  await page.route(
    "https://api.github.com/repos/sample/project/**",
    (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      if (path.includes("/3")) {
        return route.fulfill({
          json: /\/(?:comments|reviews)$/.test(path)
            ? []
            : {
                title: "Description without activity",
                body: "The proposal is ready to discuss.",
                state: "open",
                user: { login: "author" },
              },
        });
      }
      if (path.includes("/2/")) {
        return route.fulfill({
          json: path.endsWith("/reviews")
            ? [
                {
                  id: 30,
                  state: "APPROVED",
                  body: "",
                  submitted_at: time(16),
                  user: { login: "reviewer" },
                },
              ]
            : [],
        });
      }
      return route.fulfill({
        json: path.endsWith("/reviews")
          ? [
              {
                id: 9,
                state: "CHANGES_REQUESTED",
                body: "Please preserve the retry action.",
                submitted_at: time(12),
                user: { login: "reviewer" },
              },
              {
                id: 10,
                state: "COMMENTED",
                body: "The revised layout is clear.",
                submitted_at: time(14),
                user: { login: "reviewer" },
              },
              {
                id: 12,
                state: "DISMISSED",
                body: "",
                submitted_at: "2026-10-01T16:30:00Z",
                user: { login: "dismissed-reviewer" },
              },
              {
                id: 11,
                state: "APPROVED",
                body: "",
                submitted_at: time(16),
                user: { login: "maintainer" },
              },
            ]
          : path.endsWith("/issues/1/comments")
            ? [
                {
                  id: 20,
                  body: "Thanks for the first pass.",
                  created_at: time(13),
                  user: { login: "contributor" },
                },
                {
                  id: 21,
                  body: "The final adjustment is ready.",
                  created_at: time(15),
                  user: { login: "contributor" },
                },
                {
                  id: 22,
                  body: "Thanks for shipping this.",
                  created_at: time(19),
                  user: { login: "contributor" },
                },
              ]
            : {
                title: "Make the conversation easier to follow",
                body: "A quieter history with decisions in view.",
                state: "closed",
                merged: true,
                merged_at: time(18),
                merged_by: { login: "maintainer" },
                user: { login: "author" },
                created_at: time(12),
                head: { sha: "head-sha" },
              },
      });
    },
  );
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .waitFor();
  await settle(page);
  app.append("primary", "alpha", target);
  const link = page.locator(`a[href="${target}"]`);
  await expect(link).toBeAttached();
  await end(page);
  await link.click();
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  const conversation = panel.getByRole("region", {
    name: "Pull request conversation",
    exact: true,
  });
  await expect(conversation).toBeVisible();
  await expect(
    conversation.getByText(/some sources are incomplete/),
  ).toHaveCount(0);
  const trigger = conversation.getByRole("button", {
    name: /^(Show|Hide) 6 earlier messages$/,
  });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger.locator("svg")).toHaveCount(1);
  await expect(
    trigger.locator('[class*="commentRunSummary"] > span'),
  ).toHaveCSS("font-size", "12px");
  await expect(trigger).toHaveCSS("font-size", "14px");
  await expect(conversation.getByRole("group")).toHaveCount(2);
  const afterMerge = conversation.getByRole("button", {
    name: /^(Show|Hide) 1 message after merge$/,
  });
  await expect(afterMerge).toHaveAttribute("aria-expanded", "false");
  await expect(afterMerge).toContainText("1 message after merge");
  await expect(conversation.getByText("Thanks for shipping this.")).toHaveCount(
    0,
  );
  const approval = conversation.getByRole("group", {
    name: "Approved",
    exact: true,
  });
  const merge = conversation.getByRole("group", {
    name: "Merged",
    exact: true,
  });
  const dismissed = conversation.getByRole("group", {
    name: "Review dismissed",
    exact: true,
  });
  await expect(dismissed).toHaveCount(0);
  await expect(approval).toHaveCount(0);
  await expect(
    conversation.getByRole("group", { name: "Changes requested", exact: true }),
  ).toHaveCount(0);
  await expect(merge.locator("time")).toHaveAttribute("datetime", time(18));
  await expect
    .poll(() =>
      merge
        .locator("..")
        .evaluate((node) => getComputedStyle(node, "::before").content),
    )
    .toBe('""');
  await expect(
    merge.getByRole("link", { name: "maintainer", exact: true }),
  ).toHaveAttribute("href", "https://github.com/maintainer");
  const expectOrder = async () => {
    expect((await trigger.boundingBox()).y).toBeLessThan(
      (await merge.boundingBox()).y,
    );
    expect((await merge.boundingBox()).y).toBeLessThan(
      (await afterMerge.boundingBox()).y,
    );
  };
  await expectOrder();
  expect(requests).toHaveLength(3);
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode, reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await panel.screenshot({
      path: testInfo.outputPath(`grouped-${mode}.png`),
    });
  }
  const mergeBefore = await merge.boundingBox();
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(trigger).toHaveAccessibleName("Hide 6 earlier messages");
  await expect(trigger).toHaveText("Hide earlier messages");
  await expect(trigger).toBeFocused();
  await expect(conversation.getByRole("group")).toHaveCount(8);
  const history = conversation.locator(
    `[id="${await trigger.getAttribute("aria-controls")}"]`,
  );
  await expect
    .poll(() => history.evaluate((node) => node.style.height))
    .toBe("auto");
  await expect(history).toHaveCSS("overflow", "visible");
  await expect(
    conversation.getByRole("group", { name: "Review comment", exact: true }),
  ).toBeVisible();
  await expect(dismissed).toBeVisible();
  await expect(
    dismissed.getByRole("link", { name: "dismissed-reviewer", exact: true }),
  ).toHaveAttribute("href", "https://github.com/dismissed-reviewer");
  await expect(dismissed.locator("time")).toHaveAttribute(
    "datetime",
    "2026-10-01T16:30:00Z",
  );
  await expect(approval).toBeVisible();
  await expect(
    conversation.getByRole("group", { name: "Changes requested", exact: true }),
  ).toBeVisible();
  expect((await merge.boundingBox()).y).toBeGreaterThan(mergeBefore.y);
  expect((await approval.boundingBox()).y).toBeLessThan(
    (await merge.boundingBox()).y,
  );
  await expectOrder();
  await afterMerge.focus();
  await page.keyboard.press("Enter");
  await expect(afterMerge).toHaveText("Hide messages after merge");
  await expect(conversation.getByRole("group")).toHaveCount(9);
  await expect(conversation.getByRole("group").last()).toContainText(
    "Thanks for shipping this.",
  );
  expect((await merge.boundingBox()).y).toBeLessThan(
    (await conversation.getByRole("group").last().boundingBox()).y,
  );
  await page.keyboard.press("Space");
  await expect(afterMerge).toHaveText(/1 message after merge/);
  await expect(conversation.getByRole("group")).toHaveCount(8);
  await page.setViewportSize({ width: 800, height: 950 });
  await expectOrder();
  await panel.screenshot({
    path: testInfo.outputPath("grouped-expanded-narrow.png"),
  });
  await trigger.tap();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(conversation.getByRole("group")).toHaveCount(2);
  await expect(trigger).toHaveAccessibleName("Show 6 earlier messages");
  await expect(trigger).toContainText("6 earlier messages");
  // Hidden groups disappear from roles before the exit animation unmounts.
  // Establish a fully closed baseline; reversal during exit is exercised below.
  await expect(history).toHaveCount(0);
  // Normal pointer motion must expose intermediate heights and settle unclipped.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const motionFrames = await trigger.evaluate(async (button) => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    const samples = [];
    for (let frame = 0; frame < 120; frame++) {
      await new Promise(requestAnimationFrame);
      const node = document.getElementById(
        button.getAttribute("aria-controls"),
      );
      if (!node) continue;
      samples.push({
        height: node.getBoundingClientRect().height,
        target: node.scrollHeight,
      });
      if (node.style.height === "auto") return samples;
    }
    throw new Error("History reveal did not settle");
  });
  expect(
    motionFrames.some(({ height, target }) => height > 0 && height < target),
  ).toBe(true);
  await expect(history).toHaveCSS("overflow", "visible");
  await expect(trigger).toHaveText("Hide earlier messages");
  await panel.screenshot({
    path: testInfo.outputPath("history-motion-expanded.png"),
  });
  // Interrupt a pointer close with another pointer open in the same browser frame.
  await trigger.evaluate(async (button) => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await new Promise(requestAnimationFrame);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(conversation.getByRole("group")).toHaveCount(8);
  await expect
    .poll(() => history.evaluate((node) => node.style.height))
    .toBe("auto");
  await expect(history).toHaveCSS("overflow", "visible");
  await trigger.focus();
  await page.keyboard.press("Space");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
  await expect(conversation.getByRole("group")).toHaveCount(2);
  expect(requests).toHaveLength(3);
  // Exercise copying only after the geometry/motion sequence, so opening a menu
  // cannot move focus/scroll while the motion baseline is being established.
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(dismissed).toBeVisible();
  await dismissed.getByRole("button", { name: "Comment actions" }).click();
  await page.getByRole("menuitem", { name: "Copy link", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.githubCopiedLinks))
    .toEqual([`${target}#pullrequestreview-12`]);
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await trigger.focus();
  await page.keyboard.press("Space");
  await expect(history).toHaveCount(0);
  // Approval-only is an ordinary milestone row, not a one-event disclosure.
  await page.evaluate(() => {
    localStorage.setItem("buzz-font-scale.v1", "1");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "buzz-font-scale.v1",
        storageArea: localStorage,
      }),
    );
  });
  await page.setViewportSize({ width: 1440, height: 950 });
  const approvalTarget = target.replace("/1", "/2");
  app.append("primary", "alpha", approvalTarget);
  const approvalReference = page.locator(`a[href="${approvalTarget}"]`);
  await expect(approvalReference).toBeAttached();
  await end(page);
  await approvalReference.click();
  await expect(conversation).toBeVisible();
  await expect(
    conversation.getByText(/some sources are incomplete/),
  ).toHaveCount(0);
  await expect(approval).toBeVisible();
  await expect(merge).toBeVisible();
  await expect(
    conversation.getByText(/Conversation loaded|oldest first/),
  ).toHaveCount(0);
  await expect(
    conversation.getByRole("button", { name: /earlier|after merge/ }),
  ).toHaveCount(0);
  expect((await approval.boundingBox()).y).toBeLessThan(
    (await merge.boundingBox()).y,
  );
  await panel.screenshot({
    path: testInfo.outputPath("approval-only-milestone.png"),
  });
  const emptyTarget = target.replace("/1", "/3");
  app.append("primary", "alpha", emptyTarget);
  const emptyReference = page.locator(`a[href="${emptyTarget}"]`);
  await expect(emptyReference).toBeAttached();
  await end(page);
  await emptyReference.click();
  await expect(
    panel.getByRole("heading", { name: "Description without activity #3" }),
  ).toBeVisible();
  await expect(conversation.getByRole("group")).toHaveCount(1);
  await expect(
    conversation.getByText(/some sources are incomplete/),
  ).toHaveCount(0);
  await expect(
    conversation.getByText(
      /That’s it|No discussion comments|Conversation loaded/,
    ),
  ).toHaveCount(0);
  const timeline = conversation
    .getByRole("group", { name: "Description" })
    .locator("..");
  await expect
    .poll(() =>
      timeline.evaluate((node) => getComputedStyle(node, "::before").content),
    )
    .toBe("none");
  await panel.screenshot({ path: testInfo.outputPath("description-only.png") });
});

// Desktop-only CSS contract: touch coverage above deliberately keeps actions visible.
test.describe("desktop comment actions", () => {
  test.use({ hasTouch: false });
  test("bodyless and one-line ellipsis follow whole-row hover, keyboard focus and open-menu state", async ({
    page,
    app,
  }, testInfo) => {
    await page.route(
      "https://api.github.com/repos/sample/project/**",
      (route) => {
        const path = new URL(route.request().url()).pathname;
        return route.fulfill({
          json: path.endsWith("/reviews")
            ? [
                {
                  id: 1,
                  state: "APPROVED",
                  submitted_at: "2026-10-01T16:00:00Z",
                  user: { login: "reviewer" },
                  body: "",
                },
              ]
            : path.endsWith("/comments")
              ? [
                  {
                    id: 2,
                    created_at: "2026-09-20T12:00:00Z",
                    user: { login: "contributor" },
                    body: "A short update.",
                  },
                ]
              : {
                  title: "Keep review actions quiet",
                  body: "A small change.",
                  created_at: "2026-09-01T12:00:00Z",
                  state: "open",
                  user: { login: "author" },
                },
        });
      },
    );
    await page.goto(app.origin);
    await openPage(page, "Messages");
    await page
      .getByRole("textbox", { name: "Message #Alpha", exact: true })
      .waitFor();
    await settle(page);
    app.append("primary", "alpha", target);
    const link = page.locator(`a[href="${target}"]`);
    await expect(link).toBeAttached();
    await end(page);
    await link.click();
    const panel = page.getByRole("complementary", {
      name: "GitHub",
      exact: true,
    });
    const row = panel.getByRole("group", { name: "Approved", exact: true });
    await expect(row).toBeVisible();
    expect(
      await page.evaluate(
        () => matchMedia("(hover: hover) and (pointer: fine)").matches,
      ),
    ).toBe(true);
    const action = row.getByRole("button", { name: "Comment actions" });
    const slot = action.locator("..");
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.activeElement?.blur());
    await expect(slot).toHaveCSS("opacity", "0");
    await expect(slot).toHaveCSS("pointer-events", "none");
    await panel.screenshot({
      path: testInfo.outputPath("desktop-actions-idle.png"),
    });
    await row.locator('[class*="messageMarker"]').hover();
    await expect(slot).toHaveCSS("opacity", "1");
    await expect(slot).toHaveCSS("pointer-events", "auto");
    await panel.screenshot({
      path: testInfo.outputPath("desktop-actions-hover.png"),
    });
    await page.mouse.move(0, 0);
    await expect(slot).toHaveCSS("opacity", "0");
    // Reach the visually hidden control with normal Tab order, not programmatic focus.
    await row.getByRole("link", { name: "reviewer", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(action).toBeFocused();
    await expect(slot).toHaveCSS("opacity", "1");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("menuitem", { name: "Copy link", exact: true }),
    ).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(slot).toHaveCSS("opacity", "1");
    await page.keyboard.press("Escape");
    await expect(action).toBeFocused();
    await expect(slot).toHaveCSS("opacity", "1");
    await page.evaluate(() => document.activeElement?.blur());
    await expect(slot).toHaveCSS("opacity", "0");
    const short = panel.getByRole("group", { name: "Comment", exact: true });
    await expect(
      short.getByRole("button", { name: /Expand|Toggle/ }),
    ).toHaveCount(0);
    await expect(short.getByRole("button", { name: "Copy link" })).toHaveCount(
      0,
    );
    const shortAction = short.getByRole("button", { name: "Comment actions" });
    await expect(shortAction.locator("..")).toHaveCSS("opacity", "0");
    await short.locator('[class*="messageMarker"]').hover();
    await expect(shortAction.locator("..")).toHaveCSS("opacity", "1");
    const geometry = await short.evaluate((node) => {
      const bodyNode = node.querySelector('[class*="messageBody"]');
      const body = bodyNode.getBoundingClientRect();
      const contentRight =
        body.right - parseFloat(getComputedStyle(bodyNode).paddingRight);
      const action = node
        .querySelector('[aria-label="Comment actions"]')
        .getBoundingClientRect();
      const times = [...node.parentElement.querySelectorAll("time")].map(
        (time) => time.getBoundingClientRect().right,
      );
      const metadata = node
        .querySelector('[class*="messageMetadata"]')
        .getBoundingClientRect();
      return {
        metadata: { top: metadata.top, bottom: metadata.bottom },
        action: {
          left: action.left,
          right: action.right,
          top: action.top,
          bottom: action.bottom,
        },
        body: { right: contentRight, top: body.top, bottom: body.bottom },
        rowRight: node.getBoundingClientRect().right,
        dateRag: Math.max(...times) - Math.min(...times),
      };
    });
    expect(Math.abs(geometry.action.right - geometry.rowRight)).toBeLessThan(1);
    expect(geometry.action.left).toBeGreaterThanOrEqual(geometry.body.right);
    const actionCenter = (geometry.action.top + geometry.action.bottom) / 2;
    expect(actionCenter).toBeGreaterThanOrEqual(geometry.metadata.top);
    expect(actionCenter).toBeLessThanOrEqual(geometry.metadata.bottom);
    expect(geometry.dateRag).toBeLessThan(1);
    await panel.screenshot({
      path: testInfo.outputPath("desktop-single-line-hover.png"),
    });
    await shortAction.click();
    await expect(page.getByRole("menu")).toHaveAttribute(
      "data-size",
      "default",
    );
    await page.keyboard.press("Escape");
    await expect(shortAction).toBeFocused();
  });
});

// Browser-only: real keyboard focus survives the shared Button loading state and
// DOM removal in the production pane. Source/state permutations stay in Vitest.
test("source recovery retains keyboard focus and respects moving away", async ({
  page,
  app,
}) => {
  const pending = [];
  let commentCalls = 0;
  let reviewCalls = 0;
  const commentUrl =
    "https://api.github.com/repos/sample/project/issues/1/comments?per_page=30&page=1";
  app.report.githubFailures = [commentUrl, commentUrl];
  await page.route(
    "https://api.github.com/repos/sample/project/**",
    async (route) => {
      const request = new URL(route.request().url());
      if (request.pathname.endsWith("/comments")) {
        commentCalls++;
        if (commentCalls === 1) return route.fulfill({ status: 403, json: {} });
        await new Promise((resolve) => pending.push(resolve));
        if (commentCalls === 2) return route.fulfill({ status: 403, json: {} });
        return route.fulfill({
          json: [],
          headers:
            commentCalls === 3
              ? {
                  "access-control-expose-headers": "Link",
                  link: '<https://api.github.com/repositories/123/issues/1/comments?per_page=30&page=2>; rel="next"',
                }
              : {},
        });
      }
      if (request.pathname.endsWith("/reviews")) {
        reviewCalls++;
        if (reviewCalls === 1)
          return route.fulfill({
            json: [],
            headers: {
              "access-control-expose-headers": "Link",
              link: '<https://api.github.com/repositories/123/pulls/1/reviews?per_page=30&page=2>; rel="next"',
            },
          });
        await new Promise((resolve) => pending.push(resolve));
        return route.fulfill({ json: [] });
      }
      return route.fulfill({
        json: request.pathname.endsWith("/reviews")
          ? []
          : {
              title: "Keyboard recovery",
              state: "open",
              body: "Summary",
              user: { login: "author" },
            },
      });
    },
  );
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .waitFor();
  await settle(page);
  app.append("primary", "alpha", target);
  const link = page.locator(`a[href="${target}"]`);
  await expect(link).toBeAttached();
  await end(page);
  await link.click();
  const conversation = page.getByRole("region", {
    name: "Pull request conversation",
  });
  const retry = conversation.getByRole("button", { name: "Retry discussion" });
  await retry.focus();
  await page.keyboard.press("Enter");
  try {
    await expect.poll(() => pending.length).toBe(1);
    await expect(retry).toBeFocused();
    await expect(retry).toHaveAttribute("aria-busy", "true");
    await page.keyboard.press("Enter");
    expect(commentCalls).toBe(2);
  } finally {
    pending.shift()?.();
  }
  await expect(retry).not.toHaveAttribute("aria-busy", "true");
  await expect(retry).toBeFocused();
  await page.keyboard.press("Enter");
  try {
    await expect.poll(() => pending.length).toBe(1);
    await expect(retry).toBeFocused();
  } finally {
    pending.shift()?.();
  }
  const more = conversation.getByRole("button", {
    name: "Load more discussion",
  });
  await expect(more).toBeFocused();
  await page.keyboard.press("Enter");
  try {
    await expect.poll(() => pending.length).toBe(1);
    await expect(more).toBeFocused();
  } finally {
    pending.shift()?.();
  }
  await expect(more).toHaveCount(0);
  await expect(conversation).toBeFocused();
  expect(commentCalls).toBe(4);
  const reviews = conversation.getByRole("button", {
    name: "Load more reviews",
  });
  await reviews.focus();
  await page.keyboard.press("Enter");
  const title = page.getByRole("link", { name: "Keyboard recovery #1" });
  try {
    await expect.poll(() => pending.length).toBe(1);
    await expect(reviews).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(reviews).not.toBeFocused();
    await title.focus();
  } finally {
    pending.shift()?.();
  }
  await expect(reviews).toHaveCount(0);
  await expect(title).toBeFocused();
  expect(reviewCalls).toBe(2);
});
