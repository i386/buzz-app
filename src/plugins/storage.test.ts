import { afterEach, expect, it, vi } from "vitest";
import { createPluginStorage } from "./storage";
import type { PluginInfo } from "./types";
const catalog = (): PluginInfo[] =>
  ["buzz.channels", "buzz.github"].map((id) => ({
    manifest: { id, name: id, apiVersion: 1 },
    source: "bundled",
    enabled: true,
    revision: "bundled",
    previous: null,
    reloadable: false,
    error: null,
  }));
afterEach(() => vi.unstubAllGlobals());
it("ignores the retired Welcome setting and changes each bundled plugin independently", async () => {
  const values = new Map([
    ["buzzodz.plugins.v1", JSON.stringify({ version: 1, enabled: false })],
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const installation = createPluginStorage(catalog);
  expect(await installation.getCatalog()).toMatchObject({
    status: "ready",
    catalog: {
      plugins: [{ enabled: true }, { enabled: true }],
    },
  });
  expect(
    await installation.changePlugin("disable", "buzz.github"),
  ).toMatchObject({
    status: "ready",
    catalog: {
      plugins: [{ enabled: true }, { enabled: false }],
    },
  });
  const reopened = createPluginStorage(catalog);
  expect(await reopened.changePlugin("enable", "buzz.channels")).toMatchObject({
    status: "ready",
    catalog: {
      plugins: [{ enabled: true }, { enabled: false }],
    },
  });
});

it("restores required Channels from saved disabled settings and rejects disabling it", async () => {
  const saved = JSON.stringify({
    version: 3,
    enabled: {
      "buzz.channels": false,
      "buzz.github": false,
    },
  });
  const values = new Map([["buzzodz.plugins.v1", saved]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  for (let reopen = 0; reopen < 2; reopen++) {
    const storage = createPluginStorage(catalog);
    expect(await storage.getCatalog()).toMatchObject({
      status: "ready",
      catalog: { plugins: [{ enabled: true }, { enabled: false }] },
    });
    await expect(
      storage.changePlugin("disable", "buzz.channels"),
    ).rejects.toThrow("Channels is required");
    expect(values.get("buzzodz.plugins.v1")).toBe(saved);
  }
  expect(
    await createPluginStorage(catalog).changePlugin("enable", "buzz.github"),
  ).toMatchObject({
    status: "ready",
    catalog: { plugins: [{ enabled: true }, { enabled: true }] },
  });
});

it.each([true, undefined])(
  "preserves saved Bestie=%s over a changed default without migrating storage",
  async (saved) => {
    const flags = saved === undefined ? {} : { "buzz.bestie": saved };
    const raw = JSON.stringify({ version: 3, enabled: flags });
    const values = new Map([["buzzodz.plugins.v1", raw]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const defaults = () => [
      ...catalog(),
      {
        source: "bundled" as const,
        revision: "bundled",
        previous: null,
        reloadable: false,
        error: null,
        manifest: { id: "buzz.bestie", name: "Bestie", apiVersion: 1 as const },
        enabled: false,
      },
    ];
    const expected = saved ?? false;
    const storage = createPluginStorage(defaults);
    expect(await storage.getCatalog()).toMatchObject({
      status: "ready",
      catalog: {
        plugins: [{ enabled: true }, { enabled: true }, { enabled: expected }],
      },
    });
    expect(values.get("buzzodz.plugins.v1")).toBe(raw);
    await storage.changePlugin("disable", "buzz.github");
    expect(await createPluginStorage(defaults).getCatalog()).toMatchObject({
      status: "ready",
      catalog: {
        plugins: [{ enabled: true }, { enabled: false }, { enabled: expected }],
      },
    });
  },
);

it("migrates the Agents switch once and ignores v1's", async () => {
  const agents = (): PluginInfo[] =>
    catalog()
      .slice(0, 1)
      .map((plugin) => ({
        ...plugin,
        manifest: { id: "buzz.agents", name: "Agents", apiVersion: 1 },
      }));
  const values = new Map([
    [
      "buzzodz.plugins.v1",
      JSON.stringify({ version: 2, enabled: { "buzz.agents": false } }),
    ],
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const installation = createPluginStorage(agents);
  expect(await installation.getCatalog()).toMatchObject({
    catalog: { plugins: [{ enabled: true }] },
  });
  expect(
    await installation.changePlugin("disable", "buzz.agents"),
  ).toMatchObject({ catalog: { plugins: [{ enabled: false }] } });
  expect(await createPluginStorage(agents).getCatalog()).toMatchObject({
    catalog: { plugins: [{ enabled: false }] },
  });
  expect(JSON.parse(values.get("buzzodz.plugins.v1") ?? "").version).toBe(3);
  expect(JSON.parse(values.get("buzzodz.plugins.v1") ?? "").enabled).toEqual({
    "buzz.agents": false,
  });
});

it.each([true, false])(
  "migrates Agents2=%s over the retired v1 override",
  async (enabled) => {
    const values = new Map([
      [
        "buzzodz.plugins.v1",
        JSON.stringify({
          version: 2,
          enabled: { "buzz.agents": !enabled, "buzz.agents2": enabled },
        }),
      ],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const agents = (): PluginInfo[] =>
      catalog()
        .slice(0, 1)
        .map((plugin) => ({
          ...plugin,
          manifest: { id: "buzz.agents", name: "Agents", apiVersion: 1 },
        }));
    for (let n = 0; n < 2; n++) {
      expect(await createPluginStorage(agents).getCatalog()).toMatchObject({
        catalog: { plugins: [{ enabled }] },
      });
    }
    expect(JSON.parse(values.get("buzzodz.plugins.v1") ?? "")).toEqual({
      version: 3,
      enabled: { "buzz.agents": enabled },
    });
  },
);
