import { expect, test } from "@playwright/test";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

let server;
let directory;
let url;

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  directory = await mkdtemp(join(tmpdir(), "buzz-reminders-layout-"));
  const config = {
    root,
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    build: {
      rollupOptions: {
        input: join(root, "tests/browser/reminders-layout.html"),
      },
      outDir: join(directory, "dist"),
      emptyOutDir: true,
      target: "esnext",
    },
  };
  await build(config);
  server = await preview({
    ...config,
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/reminders-layout.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

// 480 is the desktop minimum window width; 390 is a narrower content region.
for (const width of [480, 390]) {
  test(`reminder rows stay readable and contained at ${width}px`, async ({
    page,
  }) => {
    const { errors } = watchPageErrors(page);
    await page.setViewportSize({ width: 800, height: 900 });
    await page.goto(`${url}?width=${width}`);
    const rows = page.getByRole("listitem");
    await expect(rows).toHaveCount(2);
    for (const row of await rows.all()) {
      const box = await row.boundingBox();
      const geometry = await row.evaluate((el) => ({
        overflow: el.scrollWidth - el.clientWidth,
        // The row surface's first child holds the avatar and reminder text.
        text: el.firstElementChild.firstElementChild.getBoundingClientRect()
          .width,
      }));
      expect(geometry.overflow, "row content stays inside the row").toBe(0);
      expect(geometry.text, "text keeps a readable width").toBeGreaterThan(
        width / 2,
      );
      for (const button of await row.getByRole("button").all()) {
        const control = await button.boundingBox();
        expect(control.x).toBeGreaterThanOrEqual(box.x);
        expect(control.x + control.width).toBeLessThanOrEqual(
          box.x + box.width,
        );
      }
    }
    // The due date reads on one line rather than one word per line.
    const due = rows.first().locator("time");
    const lineHeight = await due.evaluate((el) =>
      Number.parseFloat(getComputedStyle(el).lineHeight),
    );
    expect((await due.boundingBox()).height).toBeLessThan(lineHeight * 1.5);
    expect(errors).toEqual([]);
  });
}
