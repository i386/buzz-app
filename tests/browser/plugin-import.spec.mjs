import { chooseColorMode, selectSettingsSection } from "./navigation.mjs";
import { openPage, pageChoices } from "./navigation.mjs";
import { readFile } from "node:fs/promises";
import { test, expect } from "./fixture.mjs";

test.use({ historyCounts: { alpha: 0, beta: 0 } });
const button = (page, name) => page.getByRole("button", { name, exact: true });
async function openPlugins(page, origin) {
  await page.goto(origin);
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await selectSettingsSection(page, "Plugins");
}
// Native IPC is the boundary fixture; Settings -> manager -> platform adapter are production.
async function nativeImports(page, samples = []) {
  await page.addInitScript((samples) => {
    window.isTauri = true;
    window.importCalls = [];
    window.importDelay = false;
    const plugins = ["channels", "github", "bestie", "projects"].map(
      (name) => ({
        manifest: { id: `buzz.${name}`, name, apiVersion: 1 },
        source: "bundled",
        enabled: true,
        revision: "bundled",
        previous: null,
        reloadable: false,
        error: null,
      }),
    );
    const ready = () => ({
      status: "ready",
      externalPluginsPaused: false,
      // Real IPC serializes a new snapshot; don't let later fixture writes mutate
      // the manager's previously accepted catalog and bypass reconciliation.
      catalog: {
        profile: "fixture",
        location: "isolated IPC",
        plugins: structuredClone(plugins),
      },
    });
    const preview = {
      token: "preview-one",
      source: "https://github.com/example/plugins",
      commit: "a".repeat(40),
      warnings: ["source-only: No built plugin.js"],
      candidates: samples.length
        ? samples
        : ["one", "two"].map((name) => ({
            path: `plugins/${name}/dist`,
            manifest: {
              id: `example.${name}`,
              name: `Example ${name}`,
              apiVersion: 1,
            },
            revision: name,
          })),
    };
    // Match Tauri core's callback IDs and Channel serialization, not a fake
    // Channel class: constructing the production bridge must cross real JS IPC.
    let nextCallback = 0;
    const callbacks = new Map();
    window.__TAURI_INTERNALS__ = {
      transformCallback(callback, once = false) {
        const id = ++nextCallback;
        callbacks.set(id, (value) => {
          if (once) callbacks.delete(id);
          callback?.(value);
        });
        return id;
      },
      unregisterCallback(id) {
        callbacks.delete(id);
      },
      invoke: async (command, args) => {
        window.importCalls.push({ command, args });
        if (command === "deep_link_take") return [];
        if (command === "deep_link_watch") {
          const wireChannel = args.onEvent.toJSON();
          if (
            wireChannel !== `__CHANNEL__:${args.onEvent.id}` ||
            !callbacks.has(args.onEvent.id)
          )
            throw new Error("Invalid deep-link channel");
          return;
        }
        if (command === "plugin_catalog") return ready();
        if (
          command === "plugin_import_folder" ||
          command === "plugin_import_git"
        ) {
          if (window.importDelay)
            await new Promise((resolve) => {
              window.resolveImport = resolve;
            });
          if (args?.repository === "bad")
            throw new Error("Repository unavailable");
          return preview;
        }
        if (command === "plugin_import_discard") return;
        if (command === "plugin_import_install") {
          const candidate = preview.candidates.find(
            (p) => p.path === args.path,
          );
          const existing = plugins.find(
            (p) => p.manifest.id === candidate.manifest.id,
          );
          if (!existing)
            plugins.push({
              ...candidate,
              source: "external",
              enabled: false,
              previous: null,
              reloadable: true,
              error: null,
            });
          return ready();
        }
        if (command === "plugin_reload") {
          const plugin = plugins.find((p) => p.manifest.id === args.id);
          plugin.previous = plugin.revision;
          plugin.revision = `${plugin.revision}-reload`;
          plugin.reloadable = true;
          return ready();
        }
        if (command === "plugin_change") {
          plugins.find((p) => p.manifest.id === args.id).enabled =
            args.action === "enable";
          return ready();
        }
        if (command === "plugin_module")
          return (
            samples.find((sample) => sample.manifest.id === args.id)?.code ??
            "export function apply() {}"
          );
        throw new Error(`Unexpected command ${command}`);
      },
    };
  }, samples);
}

test("browser truthfully offers desktop-only loading", async ({
  page,
  app,
}) => {
  await openPlugins(page, app.origin);
  await expect(
    page.getByText(
      "Open the desktop app to load plugins from a folder or Git repository.",
    ),
  ).toBeVisible();
  await expect(button(page, "Load from folder")).toHaveCount(0);
});

// Real font metrics, text wrapping and icon geometry are not observable in jsdom.
test("Settings controls scale together and keep enlarged labels reachable", async ({
  page,
  app,
}, info) => {
  await nativeImports(page);
  await openPlugins(page, app.origin);
  const checkButtons = async (section, scale) => {
    await expect
      .poll(() =>
        section.evaluate((root, scale) => {
          const failures = [];
          const bounds = root.getBoundingClientRect();
          for (const label of root.querySelectorAll(
            ".buzz-choice-label, .buzz-field-label, .buzz-content-header-title",
          )) {
            // Theme choices have intentionally clipped spoken labels; measure
            // their visible thumbnails instead of the unclipped text range.
            const thumbnail = label.querySelector(".buzz-theme-thumbnail");
            if (thumbnail) {
              const box = thumbnail.getBoundingClientRect();
              if (box.left < bounds.left || box.right > bounds.right)
                failures.push("Theme preview overflows section");
              continue;
            }
            if (label.classList.contains("sr-only")) continue;
            const text = document.createRange();
            text.selectNodeContents(label);
            for (const line of text.getClientRects()) {
              if (line.left < bounds.left || line.right > bounds.right)
                failures.push(
                  `${label.textContent}: setting label overflows section`,
                );
            }
          }
          for (const button of root.querySelectorAll("button.buzz-button")) {
            const box = button.getBoundingClientRect();
            if (button.closest(".buzz-empty-state")) {
              const label = button.querySelector(".buzz-button-label");
              const context = document.createElement("canvas").getContext("2d");
              context.font = getComputedStyle(label).font;
              if (
                (label.textContent.match(/\S+/g) ?? []).some(
                  (word) =>
                    context.measureText(word).width >
                    label.getBoundingClientRect().width,
                )
              )
                failures.push(
                  `${button.textContent}: action words break apart`,
                );
            }
            // Shared controls retain their authored 32px small or 40px default
            // minimum at 100%; enlarged labels may grow.
            const minimum = button.dataset.size === "sm" ? 32 : 40;
            if (scale === 100 && box.height !== minimum)
              failures.push(`${button.textContent}: default height changed`);
            const text = document.createRange();
            text.selectNodeContents(button);
            for (const line of text.getClientRects()) {
              if (
                line.top < box.top ||
                line.bottom > box.bottom ||
                line.left < box.left ||
                line.right > box.right
              )
                failures.push(
                  `${button.textContent}: content overflows button`,
                );
            }
            if (box.left < bounds.left || box.right > bounds.right)
              failures.push(`${button.textContent}: button overflows section`);
          }
          return failures;
        }, scale),
      )
      .toEqual([]);
  };
  for (const scale of [100, 200]) {
    await selectSettingsSection(page, "Appearance");
    if (scale === 200) {
      for (let i = 0; i < 10; i++)
        await button(page, "Increase interface size").click();
    }
    await expect(
      page.getByRole("status", { name: "Interface size" }),
    ).toHaveText(`${scale}%`);
    for (const [width, mode] of [
      [320, "Light"],
      [800, "Dark"],
      [1280, "Light"],
    ]) {
      await page.setViewportSize({ width, height: 900 });
      await selectSettingsSection(page, "Appearance");
      const appearance = page.getByRole("region", {
        name: "Appearance",
        exact: true,
      });
      await chooseColorMode(page, mode);
      await expect(appearance.getByRole("button")).toHaveCount(
        scale === 100 ? 2 : 3,
      );
      await expect(
        appearance.getByRole("button", {
          name: "Reset interface size",
          exact: true,
        }),
      ).toHaveCount(scale === 100 ? 0 : 1);
      await page.evaluate(() => document.fonts.ready);
      await checkButtons(appearance, scale);
      // Icon buttons grow with the interface while keeping their square shape.
      await expect(
        page.getByRole("button", { name: "Search Buzz", exact: true }),
      ).toHaveAttribute("data-icon-size", "sm");
      await expect
        .poll(() =>
          page
            .getByRole("region", { name: "Settings", exact: true })
            .locator("button[data-icon-size]")
            .evaluateAll(
              (buttons, scale) =>
                buttons
                  .filter((button) => button.getClientRects().length)
                  .map((button) => {
                    const box = button.getBoundingClientRect();
                    const sizes = {
                      sm: 32,
                      md: 40,
                      lg: 52,
                      compact: 32,
                      toolbar: 32,
                      default: 40,
                      large: 52,
                    };
                    return (
                      box.width ===
                        sizes[button.dataset.iconSize] * (scale / 100) &&
                      box.height === box.width
                    );
                  }),
              scale,
            ),
        )
        .not.toContain(false);
      await selectSettingsSection(page, "Plugins");
      const plugins = page.getByRole("region", {
        name: "Plugins",
        exact: true,
      });
      await expect(button(page, "Load from folder")).toBeVisible();
      await expect(button(page, "Load from Git")).toBeVisible();
      await checkButtons(plugins, scale);
      if (scale === 200 && width === 320) {
        // Setup-card actions wrap inside the card instead of scrolling sideways.
        const actions = plugins.getByRole("group", { name: "Load plugins" });
        await expect
          .poll(() =>
            actions.evaluate((root) => {
              const bounds = root.getBoundingClientRect();
              return (
                root.scrollWidth <= root.clientWidth &&
                [...root.querySelectorAll("button")].every((button) => {
                  const box = button.getBoundingClientRect();
                  return box.left >= bounds.left && box.right <= bounds.right;
                })
              );
            }),
          )
          .toBe(true);
        // Both wrapped actions remain keyboard reachable.
        await button(page, "Load from folder").focus();
        await page.keyboard.press("Tab");
        await expect(button(page, "Load from Git")).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(
          page.getByRole("textbox", { name: "Git or GitHub repository" }),
        ).toBeVisible();
        await button(page, "Load from Git").click();
      }
      await page.screenshot({
        path: info.outputPath(`settings-buttons-${scale}-${width}.png`),
      });
    }
  }
});

test("folder/Git preview selects the exact subfolder, installs disabled and warns on enabled updates", async ({
  page,
  app,
}) => {
  await nativeImports(page);
  await openPlugins(page, app.origin);
  await button(page, "Load from folder").click();
  await expect(page.getByRole("radio")).toHaveCount(2);
  await expect(button(page, "Install plugin")).toHaveCount(0);
  await page.getByRole("radio", { name: /Example two/ }).check();
  await selectSettingsSection(page, "Profile");
  await selectSettingsSection(page, "Plugins");
  await expect(page.getByRole("radio", { name: /Example two/ })).toBeChecked();
  await expect(
    page.getByText(
      "This plugin starts off. Turn it on in the list when you’re ready.",
    ),
  ).toBeVisible();
  await button(page, "Install plugin").click();
  const enabled = page.getByRole("switch", { name: "Enable Example two" });
  await expect(enabled).toHaveAttribute("aria-checked", "false");
  await expect(button(page, "Reload")).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        window.importCalls.find((c) => c.command === "plugin_import_install")
          .args,
    ),
  ).toEqual({ token: "preview-one", path: "plugins/two/dist" });
  await button(page, "Reload").click();
  expect(
    await page.evaluate(
      () => window.importCalls.find((c) => c.command === "plugin_reload").args,
    ),
  ).toEqual({ id: "example.two" });
  await enabled.click();
  await expect(button(page, "Reload")).toHaveCount(0);
  await expect(
    page.getByText(/It stays on and may run immediately/),
  ).toBeVisible();
  await expect(button(page, "Update plugin")).toBeVisible();
  await button(page, "Close preview").click();
  await button(page, "Load from Git").click();
  await page.getByLabel("Git or GitHub repository").fill("example/plugins");
  await page.getByLabel("Branch or tag (optional)").fill("feature/plugins");
  await button(page, "Find plugins").click();
  await expect(page.getByRole("radio")).toHaveCount(2);
  expect(
    await page.evaluate(
      () =>
        window.importCalls.find((c) => c.command === "plugin_import_git").args,
    ),
  ).toEqual({ repository: "example/plugins", reference: "feature/plugins" });
  await button(page, "Close preview").click();
  await page.getByLabel("Git or GitHub repository").fill("bad");
  await button(page, "Find plugins").click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Repository unavailable" }),
  ).toBeVisible();
  await expect(button(page, "Find plugins")).toBeEnabled();
});

test("leaving Settings discards a late preview without installing", async ({
  page,
  app,
}) => {
  await nativeImports(page);
  await openPlugins(page, app.origin);
  await page.evaluate(() => {
    window.importDelay = true;
  });
  await button(page, "Load from folder").click();
  await expect(page.getByText(/Reading plugin folders/)).toBeVisible();
  await openPage(page, "Projects");
  await page.evaluate(() => window.resolveImport());
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.importCalls.filter(
            (c) => c.command === "plugin_import_discard",
          ).length,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(() =>
      window.importCalls.filter((c) => c.command === "plugin_import_install"),
    ),
  ).toEqual([]);
});

test("checked-in local examples activate and work independently", async ({
  page,
  app,
}) => {
  const samples = await Promise.all(
    ["counter", "notes"].map(async (name) => {
      const folder = new URL(
        `../../examples/plugins/${name}/`,
        import.meta.url,
      );
      return {
        path: name,
        manifest: JSON.parse(
          await readFile(new URL("manifest.json", folder), "utf8"),
        ),
        code: await readFile(new URL("plugin.js", folder), "utf8"),
        revision: name,
      };
    }),
  );
  await nativeImports(page, samples);
  await openPlugins(page, app.origin);
  await button(page, "Load from folder").click();
  for (const sample of samples) {
    await page
      .getByRole("radio", { name: new RegExp(sample.manifest.name) })
      .check();
    await button(page, "Install plugin").click();
    const toggle = page.getByRole("switch", {
      name: `Enable ${sample.manifest.name}`,
    });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
  }
  await openPage(page, "Counter playground");
  await button(page, "Clicked 0 times").click();
  await expect(button(page, "Clicked 1 times")).toBeVisible();
  await openPage(page, "Notes playground");
  await page.getByLabel("Scratch note").fill("Hello plugin");
  await expect(page.getByRole("main").getByRole("status")).toHaveText(
    "12 characters",
  );
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await selectSettingsSection(page, "Plugins");
  await page.getByRole("switch", { name: "Enable Counter playground" }).click();
  const navigation = await pageChoices(page);
  await expect(
    navigation.getByRole("option", { name: "Counter playground", exact: true }),
  ).toHaveCount(0);
  await expect(
    navigation.getByRole("option", { name: "Notes playground", exact: true }),
  ).toBeVisible();
});
