import { expect, it, vi } from "vitest";
import {
  DATABRICKS_ID,
  type SharedProvider,
} from "../../features/providers/shared";
import { GooseSetup } from "./setup";
import { fakeSpawn } from "./goose-testing";
import { sharedProviderEnv } from "./shared-provider";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("uses the shared catalog and launch credentials without saving them in goose", async () => {
  let connected = false;
  const shared: SharedProvider = {
    id: DATABRICKS_ID,
    name: "Databricks in Buzz",
    connected: async () => connected,
    models: async () => [
      {
        id: "databricks-gpt-6-sol",
        label: "Team model",
        api: "openai-responses",
        family: "gpt",
      },
      {
        id: "databricks-gemini-3-5-flash",
        label: "Gemini",
        api: "openai-responses",
        family: "gemini",
      },
    ],
    Connection: () => null,
  };
  const fake = fakeSpawn({
    reply: "OK",
    providers: [
      {
        providerId: "openrouter",
        providerName: "OpenRouter",
        visibleInSetup: true,
        configured: true,
      },
    ],
  });
  const setup = new GooseSetup(fake.spawn, shared);
  expect(
    (await setup.providers()).providers.find((p) => p.id === DATABRICKS_ID)
      ?.configured,
  ).toBe(false);
  expect(await setup.models(DATABRICKS_ID)).toEqual([]);
  connected = true;
  setup.refresh();
  expect((await setup.providers()).providers.map((p) => p.id)).toEqual([
    DATABRICKS_ID,
    "openrouter",
  ]);
  expect(await setup.models(DATABRICKS_ID)).toMatchObject([
    { id: "databricks-gpt-6-sol", label: "Team model" },
  ]);
  invoke.mockResolvedValue({
    GOOSE_PROVIDER: "buzz_databricks",
    GOOSE_MODEL: "databricks-gpt-6-sol",
  });
  expect(
    await setup.test({
      provider: DATABRICKS_ID,
      model: "databricks-gpt-6-sol",
    }),
  ).toMatchObject({ ok: true });
  expect(invoke).toHaveBeenCalledWith("databricks_provider", {
    operation: "goose",
    input: { model: "databricks-gpt-6-sol" },
  });
  expect(fake.geese.at(-1)?.env).toMatchObject({
    GOOSE_PROVIDER: "buzz_databricks",
    GOOSE_MODEL: "databricks-gpt-6-sol",
    DATABRICKS_TOKEN: null,
  });
  expect(
    fake.geese
      .flatMap((g) => g.received)
      .some((r) => r.method === "_goose/unstable/providers/config/save"),
  ).toBe(false);
  await expect(
    sharedProviderEnv(DATABRICKS_ID, "databricks-gpt-6-sol", false),
  ).rejects.toThrow("Enable the Databricks provider plugin");
});

it("keeps other Goose providers usable when the shared connection cannot be read", async () => {
  const shared: SharedProvider = {
    id: DATABRICKS_ID,
    name: "Databricks in Buzz",
    connected: async () => {
      throw new Error("Sign in again");
    },
    models: async () => [],
    Connection: () => null,
  };
  const fake = fakeSpawn({
    providers: [
      {
        providerId: "openrouter",
        providerName: "OpenRouter",
        visibleInSetup: true,
        configured: true,
      },
    ],
  });
  const result = await new GooseSetup(fake.spawn, shared).providers();
  expect(result.providers).toMatchObject([
    { id: DATABRICKS_ID, configured: false },
    { id: "openrouter", configured: true },
  ]);
});
