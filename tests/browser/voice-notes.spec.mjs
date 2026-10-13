import { watchPageErrors } from "./page-errors.mjs";
import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
let server, origin;
test.beforeAll(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envDir: false,
    plugins: [react()],
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
});
test.afterAll(async () => {
  await server?.close();
});
test.beforeEach(async ({ page }) => {
  await page.route("**/api/relay/media?*", async (route) => {
    const url = new URL(route.request().url()).searchParams.get("url");
    const bytes = await page.evaluate(async (url) => {
      const source = window.voiceFixture.media(url);
      return Array.from(
        new Uint8Array(await (await fetch(source)).arrayBuffer()),
      );
    }, url);
    await route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: Buffer.from(bytes),
    });
  });
  await page.goto(`${origin}tests/fixtures/voice-notes.html`);
  await page.evaluate(() => {
    const mic = {
      mode: "allow",
      stopped: 0,
      started: 0,
      release: () => {},
    };
    window.voiceMic = mic;
    let captureContext;
    const microphones = new Map();
    const stopTrack = MediaStreamTrack.prototype.stop;
    MediaStreamTrack.prototype.stop = function () {
      microphones.get(this.id)?.();
      microphones.delete(this.id);
      stopTrack.call(this);
    };
    document.addEventListener(
      "click",
      (event) => {
        if (
          event.target.closest?.('[aria-label="Record voice note"]') &&
          mic.mode !== "denied"
        ) {
          captureContext = new AudioContext();
          void captureContext.resume();
        }
      },
      true,
    );
    Object.defineProperty(MediaDevices.prototype, "getUserMedia", {
      configurable: true,
      value: async () => {
        if (mic.mode === "denied")
          throw new DOMException("Denied", "NotAllowedError");
        const context = captureContext ?? new AudioContext();
        mic.context = context;
        void context.resume();
        const source = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = 0.2;
        const destination = context.createMediaStreamDestination();
        source.connect(gain);
        gain.connect(destination);
        source.start();
        mic.started++;
        for (const track of destination.stream.getTracks()) {
          microphones.set(track.id, () => {
            mic.stopped++;
            source.stop();
            void context.close();
          });
        }
        if (mic.mode === "delay")
          await new Promise((resolve) => {
            mic.release = resolve;
          });
        return destination.stream;
      },
    });
  });

  await expect(
    page.getByRole("button", { name: "Play voice note", exact: true }),
  ).toBeVisible();
});
// Attachments upload eagerly, so a preview can still be fetching media through
// the route above when a test ends. Its late errors cannot affect the result.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
async function record(page) {
  await page
    .getByRole("button", { name: "Record voice note", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Finish voice note", exact: true }),
  ).toBeEnabled();
  await expect
    .poll(() => page.evaluate(() => window.voiceMic.context.currentTime))
    .toBeGreaterThan(0.6); // Real audio frames, not a timer-only fake.
  const finishButton = page.getByRole("button", {
    name: "Finish voice note",
    exact: true,
  });
  await expect(finishButton).toHaveCSS("background-color", "rgb(0, 0, 0)");
  await expect(finishButton.locator("svg")).toHaveCSS(
    "fill",
    "rgb(255, 255, 255)",
  );
  await expect(page.getByRole("textbox")).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("voice-recording.png"),
  });
  await page
    .getByRole("button", { name: "Finish voice note", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Remove voice note", exact: true }),
  ).toBeVisible();
}
test("record, preview, send and play the chat card with speed and seeking", {
  tag: "@media-recorder",
}, async ({ page }) => {
  const errors = watchPageErrors(page);
  const initialCard = page
    .getByRole("group", { name: "Voice note", exact: true })
    .first();
  await expect(initialCard.locator("audio")).toHaveJSProperty("readyState", 0);
  await expect(initialCard.getByRole("slider")).toBeDisabled();
  await record(page);
  await expect(page.getByRole("textbox")).toBeFocused();
  const composer = page.getByRole("form", {
    name: "Send a message to general",
  });
  await expect(
    composer.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  const draftCard = composer.getByRole("group", {
    name: "Voice note",
    exact: true,
  });
  const draftPlay = draftCard.getByRole("button", {
    name: "Play voice note",
    exact: true,
  });
  await expect(draftPlay).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(draftPlay.locator("svg").first()).toHaveCSS(
    "stroke",
    "rgb(255, 255, 255)",
  );
  await expect(draftPlay).toHaveCSS("clip-path", /^path\(/);
  await expect(draftCard.locator("[data-image-outline] path")).toHaveAttribute(
    "d",
    / c .* a /,
  );
  // The background is smoothed separately so the floating remove control escapes.
  await draftCard
    .getByRole("button", { name: "Remove voice note" })
    .click({ trial: true });
  const geometry = await draftCard.boundingBox();
  expect(geometry.width).toBeGreaterThan(300);
  expect(geometry.height).toBeLessThan(65);
  await page.screenshot({ path: test.info().outputPath("voice-cards.png") });
  await composer
    .getByRole("button", { name: "Play voice note", exact: true })
    .click();
  await expect(
    composer.getByRole("button", { name: "Pause voice note", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Play voice note", exact: true })
    .first()
    .click();
  await expect(
    composer.getByRole("button", { name: "Play voice note", exact: true }),
  ).toBeVisible();
  const firstCard = page
    .getByRole("group", { name: "Voice note", exact: true })
    .first();
  const chatPlay = firstCard
    .getByRole("button", { name: /voice note/, exact: false })
    .first();
  await expect(chatPlay).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(chatPlay.locator("svg").last()).toHaveCSS(
    "stroke",
    "rgb(255, 255, 255)",
  );
  const speedButton = firstCard.getByRole("button", { name: /Playback speed/ });
  await expect(speedButton).toHaveCSS("color", "rgb(255, 255, 255)");
  const waveformBeforeSpeed = await firstCard.getByRole("slider").boundingBox();
  await firstCard
    .getByRole("button", { name: /Playback speed 1 times/ })
    .click();
  await expect(firstCard.locator("audio")).toHaveJSProperty(
    "playbackRate",
    1.5,
  );
  expect(await firstCard.getByRole("slider").boundingBox()).toEqual(
    waveformBeforeSpeed,
  );
  await firstCard
    .getByRole("button", { name: /Playback speed 1.5 times/ })
    .click();
  expect(await firstCard.getByRole("slider").boundingBox()).toEqual(
    waveformBeforeSpeed,
  );
  await expect(speedButton).toHaveCSS("color", "rgb(255, 255, 255)");
  await firstCard.hover();
  await expect(speedButton).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(firstCard.getByRole("slider")).toBeEnabled();
  await firstCard.getByRole("slider").fill("1");
  await expect
    .poll(() =>
      firstCard.locator("audio").evaluate((audio) => audio.currentTime),
    )
    .toBeGreaterThanOrEqual(1);
  await composer.getByRole("textbox").fill("Listen to this");
  await composer
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(page.getByText("Listen to this", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove voice note", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.voiceFixture.report.published))
    .toBe(1);
  await expect(
    page.getByRole("group", { name: "Voice note", exact: true }),
  ).toHaveCount(2);
  expect(errors.unexplained()).toEqual([]);
});
test("permission cancellation, denial and plugin removal release microphones", {
  tag: "@media-recorder",
}, async ({ page }) => {
  await page.evaluate(() => {
    window.voiceMic.mode = "delay";
  });
  const recordButton = page.getByRole("button", {
    name: "Record voice note",
    exact: true,
  });
  await recordButton.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "Waiting for microphone…" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Discard voice note", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox")).toBeFocused();
  await page.evaluate(() => window.voiceMic.release());
  await expect.poll(() => page.evaluate(() => window.voiceMic.stopped)).toBe(1);
  await page.evaluate(() => {
    window.voiceMic.mode = "denied";
  });
  await page
    .getByRole("button", { name: "Record voice note", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Allow Buzz");
  await expect(
    page.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox")).toBeFocused();
  await page.evaluate(() => {
    window.voiceMic.mode = "allow";
  });
  await page
    .getByRole("button", { name: "Record voice note", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Finish voice note", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Disable Voice Notes", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Finish voice note", exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.voiceMic.stopped)).toBe(2);
  await expect(
    page.getByRole("button", { name: "Enable Voice Notes", exact: true }),
  ).toBeFocused();
  expect(await page.evaluate(() => window.voiceFixture.report.published)).toBe(
    0,
  );
});
test("failed upload survives disabling the plugin and switching conversations", {
  tag: "@media-recorder",
}, async ({ page }) => {
  await page.evaluate(() => {
    window.voiceFixture.report.failUpload = true;
  });
  await record(page);
  await expect(
    page.getByRole("button", { name: "Retry voice note upload", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Disable Voice Notes", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Remove voice note", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Switch conversation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Remove voice note", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Switch conversation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry voice note upload", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.voiceFixture.report.failUpload = false;
  });
  await page
    .getByRole("button", { name: "Retry voice note upload", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Enable Voice Notes", exact: true })
    .click();
  await expect(
    page.getByRole("group", { name: "Voice note", exact: true }),
  ).toHaveCount(2);
  await page
    .getByRole("button", { name: "Remove voice note", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Record voice note", exact: true }),
  ).toBeEnabled();
});

test("rejected voice messages retry through the outbox without reuploading", {
  tag: "@media-recorder",
}, async ({ page }) => {
  await record(page);
  await page.evaluate(() => {
    window.voiceFixture.report.failSend = true;
  });
  await page.clock.install();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.voiceFixture.report.published))
    .toBe(1);
  await page.clock.runFor(11000);
  await expect(
    page.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.voiceFixture.report.failSend = false;
  });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.voiceFixture.report.published))
    .toBe(2);
  expect(await page.evaluate(() => window.voiceFixture.report.uploads)).toBe(1);
  await expect(
    page.getByRole("group", { name: "Voice note", exact: true }),
  ).toHaveCount(2);
});

test("rejects a full attachment draft before opening the microphone", async ({
  page,
}) => {
  await page.locator('input[type="file"]').setInputFiles(
    Array.from({ length: 10 }, (_, index) => ({
      name: `file-${index}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from("test"),
    })),
  );
  await page
    .getByRole("button", { name: "Record voice note", exact: true })
    .click();
  await expect(
    page.getByText("Attach at most 10 files per message."),
  ).toBeVisible();
  expect(await page.evaluate(() => window.voiceMic.started)).toBe(0);
});
