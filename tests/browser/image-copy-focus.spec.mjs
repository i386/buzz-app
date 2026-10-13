import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const fixtureImage = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#666"/></svg>`;

function fixtureMediaPlugin() {
  return {
    name: "messages-fixture-media",
    configureServer(server) {
      server.middlewares.use("/api/relay/media", (req, res, next) => {
        if (req.method !== "GET") return next();
        const url = new URL(req.url ?? "", "http://fixture.local");
        const target = url.searchParams.get("url") ?? "";
        if (!target.startsWith("https://fixture.test/media/")) return next();
        res.writeHead(200, {
          "Content-Type": "image/svg+xml",
          "Content-Length": Buffer.byteLength(fixtureImage),
        });
        res.end(fixtureImage);
      });
    },
  };
}

function createMessagesServer() {
  return createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [fixtureMediaPlugin(), react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
}

async function withMessagesFixture(page, run) {
  const server = await createMessagesServer();
  await server.listen();
  try {
    const address = server.httpServer.address();
    await page.goto(
      `http://127.0.0.1:${address.port}/tests/fixtures/messages.html`,
    );
    await run();
  } finally {
    await server.close();
  }
}

async function installDeferredImageClipboard(page, outcome) {
  await page.evaluate(
    (nextOutcome) =>
      window.messagesFixture.imageClipboard(nextOutcome, "deferred"),
    outcome,
  );
}

async function releaseClipboardGate(page) {
  await page.evaluate(() => window.messagesFixture.clipboardGate.release());
}

async function clipboardWrites(page) {
  return page.evaluate(() => window.messagesFixture.clipboardGate.writes);
}

async function expectVisibleFeedback(dialog, message) {
  const notice = dialog.getByText(message);
  await expect(notice).toBeVisible();
  await expect
    .poll(async () =>
      notice.evaluate((element) => {
        const style = getComputedStyle(element);
        return { opacity: style.opacity, visibility: style.visibility };
      }),
    )
    .toEqual({ opacity: "1", visibility: "visible" });
}

async function expectFeedbackClears(dialog, message, page) {
  await page.clock.runFor(message === "Image copied" ? 4000 : 6000);
  await expect(dialog.getByText(message)).toHaveCount(0);
}

test("image copy keeps keyboard focus while clipboard write is pending", async ({
  page,
}) => {
  await withMessagesFixture(page, async () => {
    for (const outcome of ["success", "failure"]) {
      await installDeferredImageClipboard(page, outcome);
      await page
        .getByRole("button", { name: "Review image", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "Image viewer" });
      await expect(dialog).toBeVisible();

      const controls = dialog.locator(
        "[data-review-chrome][data-image-controls]",
      );
      await expect(controls).toBeVisible();
      // Programmatic keyboard focus makes the toolbar visible independent of
      // useMediaControls' pointer-idle timer.
      await controls.getByRole("button", { name: "Zoom in" }).focus();
      await page.keyboard.press("Tab");
      const copy = controls.getByRole("button", { name: "Copy image" });
      await expect(copy).toBeFocused();
      await expect(page.locator("html")).toHaveAttribute(
        "data-keyboard-navigation",
        "",
      );

      await page.keyboard.press("Enter");
      try {
        await expect.poll(() => clipboardWrites(page)).toBe(1);
        await expect(copy).toBeFocused();
        await expect(copy).toHaveAttribute("aria-busy", "true");
        await page.keyboard.press("Enter");
        expect(await clipboardWrites(page)).toBe(1);
      } finally {
        await releaseClipboardGate(page);
      }

      const message =
        outcome === "success" ? "Image copied" : "Couldn't copy image";
      await expect(dialog.getByText(message)).toBeVisible();
      await expect(copy).toBeFocused();
      await expect(copy).not.toHaveAttribute("aria-busy", "true");
      await dialog
        .getByRole("button", { name: "Close fullscreen viewer" })
        .click();
      await expect(dialog).toHaveCount(0);
    }
  });
});

test("image copy feedback remains visible after pointer controls hide", async ({
  page,
}) => {
  await page.clock.install();
  await withMessagesFixture(page, async () => {
    for (const outcome of ["success", "failure"]) {
      await installDeferredImageClipboard(page, outcome);
      await page
        .getByRole("button", { name: "Review image", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "Image viewer" });
      await expect(dialog).toBeVisible();

      const controls = dialog.locator(
        "[data-review-chrome][data-image-controls]",
      );
      const copy = controls.getByRole("button", { name: "Copy image" });
      await expect(copy).toBeVisible();
      await copy.click();
      try {
        await expect.poll(() => clipboardWrites(page)).toBe(1);
        await page.clock.runFor(2200);
      } finally {
        await releaseClipboardGate(page);
      }

      const message =
        outcome === "success" ? "Image copied" : "Couldn't copy image";
      await expectVisibleFeedback(dialog, message);
      await expectFeedbackClears(dialog, message, page);
      await dialog
        .getByRole("button", { name: "Close fullscreen viewer" })
        .click();
      await expect(dialog).toHaveCount(0);
    }
  });
});
