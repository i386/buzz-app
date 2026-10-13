import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

// CSS starting styles, direction, modality and reduced motion need real engines.
test("terminal drawer shares panel motion without delaying close or losing the session", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envDir: false,
    plugins: [react()],
    server: { host: "127.0.0.1", port: 0 },
  });
  const errors = watchPageErrors(page);
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/terminal-panel.html?motion`,
    );
    // Hold entry at its DOM insertion boundary, independent of renderer speed.
    await page.evaluate(() => {
      new MutationObserver(() => {
        for (const dock of document.querySelectorAll("[data-panel-dock]")) {
          for (const animation of dock.getAnimations()) animation.pause();
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    const launcher = page.getByRole("button", {
      name: "Toggle channel terminal",
      exact: true,
    });
    const hide = page.getByRole("button", {
      name: "Hide terminal",
      exact: true,
    });
    const dock = page.locator("[data-panel-dock]");
    const finish = () =>
      dock.evaluateAll((elements) => {
        for (const element of elements)
          for (const animation of element.getAnimations()) animation.finish();
      });
    await launcher.click();
    await expect(dock).toHaveCSS("transition-duration", "0.18s, 0.18s");
    await expect
      .poll(() =>
        dock.evaluate((el) =>
          el.getAnimations().map((animation) => ({
            state: animation.playState,
            frames: animation.effect
              .getKeyframes()
              .map((frame) => frame.transform)
              .filter(Boolean),
          })),
        ),
      )
      .toContainEqual({
        state: "paused",
        frames: ["translateY(12px)", "none"],
      });
    await expect(page.locator(".xterm-rows")).toContainText(
      "FIXTURE_SHELL_READY",
    );
    await page.evaluate(() => {
      window.retainedTerminal = document.querySelector(".xterm");
    });
    await finish();
    await expect(dock).toHaveCSS("transform", "none");
    await hide.click();
    await expect(dock).toHaveCount(0);
    await expect(launcher).toBeFocused();

    await launcher.press("Enter");
    await expect(hide).toBeVisible();
    await expect(dock).toHaveCSS("transition-duration", "0s");
    expect(
      await page.evaluate(
        () => window.retainedTerminal === document.querySelector(".xterm"),
      ),
    ).toBe(true);
    await hide.press("Enter");
    await expect(dock).toHaveCount(0);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await launcher.click();
    await expect(dock).toHaveCSS("transition-property", "opacity");
    await expect(dock).toHaveCSS("transform", "none");
    await finish();
    await hide.click();
    await expect(dock).toHaveCount(0);

    // A close during entry must also release the conversation space immediately.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await launcher.click();
    await expect
      .poll(() =>
        dock.evaluate((el) =>
          el
            .getAnimations()
            .some((animation) => animation.playState === "paused"),
        ),
      )
      .toBe(true);
    await launcher.click();
    await expect(dock).toHaveCount(0);
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await page
      .locator("[data-panel-dock]")
      .evaluateAll((elements) => {
        for (const element of elements)
          for (const animation of element.getAnimations()) animation.finish();
      })
      .catch(() => {});
    await page.close();
    await server.close();
  }
});
