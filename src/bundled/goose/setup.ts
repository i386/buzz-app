// goose's providers, as its own config holds them: the ones it offers, their
// models, saving a provider's key, and testing that a provider answers. Each
// call runs a short-lived `goose-acp`; keys go to goose's secret store, never
// into Buzz.
import type { ModelChoice } from "../../features/agents/ModelPicker";
import { GooseProcess, type Spawn } from "./goose";
import { absolute } from "./sessions";
import type { SharedProvider } from "../../features/providers/shared";
import { DATABRICKS_ID } from "../../features/providers/shared";
import { sharedProviderEnv } from "./shared-provider";

export type ConfigKey = Readonly<{
  name: string;
  required: boolean;
  secret: boolean;
  default?: string | null;
}>;

export type Provider = Readonly<{
  id: string;
  name: string;
  description: string;
  defaultModel: string;
  configured: boolean;
  /** The fields a key or host is entered in. */
  keys: readonly ConfigKey[];
  /** Signs in through goose rather than with a key entered here. */
  signsIn: boolean;
  steps: readonly string[];
  models: readonly ModelChoice[];
  shared?: true;
}>;

export type Providers = Readonly<{
  providers: readonly Provider[];
  /** What goose's config picks when an agent names no provider or model. */
  defaults: Readonly<{ provider?: string; model?: string }>;
}>;

export type Tested = Readonly<{ ok: boolean; message: string }>;

type Entry = {
  providerId: string;
  providerName: string;
  description?: string;
  defaultModel?: string;
  configured?: boolean;
  visibleInSetup?: boolean;
  deprecated?: boolean;
  acp?: boolean;
  setupSteps?: string[];
  configKeys?: (ConfigKey & {
    oauthFlow?: boolean;
    deviceCodeFlow?: boolean;
  })[];
  models?: { id: string; name?: string; recommended?: boolean }[];
};

const TEST_PROMPT = "Reply with exactly: OK";
const TEST_TIMEOUT_MS = 60_000;

export class GooseSetup {
  private listing: Promise<Providers> | undefined;
  private readonly live = new Map<string, Promise<readonly ModelChoice[]>>();

  constructor(
    private readonly spawn: Spawn | undefined,
    readonly shared?: SharedProvider,
  ) {}
  refresh() {
    this.listing = undefined;
    this.live.clear();
  }

  /** goose's providers, read once until something is saved. */
  async providers(): Promise<Providers> {
    this.listing ??= this.with(async (goose) => {
      const [{ entries }, defaults] = (await Promise.all([
        goose.request("_goose/unstable/providers/list", { providerIds: [] }),
        goose.request("_goose/unstable/defaults/read", {}),
      ])) as [
        { entries: Entry[] },
        { providerId?: string | null; modelId?: string | null },
      ];
      return {
        // Providers that are other agents (`claude-acp`, …) are not offered.
        providers: entries
          .filter(
            (entry) =>
              entry.visibleInSetup &&
              !entry.deprecated &&
              !entry.acp &&
              entry.providerId !== "buzz_databricks",
          )
          .map(provider)
          .sort((a, b) => a.name.localeCompare(b.name)),
        defaults: {
          ...(defaults.providerId ? { provider: defaults.providerId } : {}),
          ...(defaults.modelId ? { model: defaults.modelId } : {}),
        },
      };
    });
    this.listing.catch(() => {
      this.listing = undefined;
    });
    const listed = await this.listing;
    if (!this.shared) return listed;
    const configured = await this.shared.connected().catch(() => false);
    return {
      ...listed,
      providers: [
        {
          id: this.shared.id,
          name: this.shared.name,
          description: "Shared connection managed by Buzz",
          defaultModel: "",
          configured,
          keys: [],
          signsIn: false,
          steps: [],
          models: [],
          shared: true,
        },
        ...listed.providers,
      ],
    };
  }

  /** A provider's models: goose's catalog, or else what its API lists. */
  async models(id: string): Promise<readonly ModelChoice[]> {
    if (id === this.shared?.id)
      return (await this.shared.connected())
        ? (await this.shared.models()).filter(
            (model) => id !== DATABRICKS_ID || model.family === "gpt",
          )
        : [];
    const listed = (await this.providers()).providers.find(
      (item) => item.id === id,
    );
    if (listed?.models.length || !listed?.configured)
      return listed?.models ?? [];
    let models = this.live.get(id);
    if (!models) {
      models = this.with(async (goose) => {
        const { models } = (await goose.request(
          "_goose/unstable/providers/supported-models/list",
          { providerId: id },
        )) as { models: string[] };
        return models.map((model) => ({ id: model, label: model }));
      });
      models.catch(() => this.live.delete(id));
      this.live.set(id, models);
    }
    return models;
  }

  /** Which of a provider's fields goose already holds. */
  saved(id: string): Promise<ReadonlySet<string>> {
    return this.with(async (goose) => {
      const { fields } = (await goose.request(
        "_goose/unstable/providers/config/read",
        { providerId: id },
      )) as { fields: { key: string; isSet: boolean }[] };
      return new Set(
        fields.filter((field) => field.isSet).map((field) => field.key),
      );
    });
  }

  /** Saves a provider's fields in goose's config and secret store. */
  async save(id: string, fields: Readonly<Record<string, string>>) {
    await this.with((goose) =>
      goose.request("_goose/unstable/providers/config/save", {
        providerId: id,
        fields: Object.entries(fields).map(([key, value]) => ({ key, value })),
      }),
    );
    this.listing = undefined;
    this.live.delete(id);
  }

  /** Asks the provider for one short reply, without tools. goose reports a
   * failed call as its reply, so only the expected answer passes. */
  test(choice: Readonly<{ provider: string; model: string }>): Promise<Tested> {
    const env = {
      GOOSE_MODE: "chat",
      ...(choice.provider ? { GOOSE_PROVIDER: choice.provider } : {}),
      ...(choice.model ? { GOOSE_MODEL: choice.model } : {}),
    };
    const run = (launch: Readonly<Record<string, string | null>>) =>
      briefly(
        this.spawn,
        async (goose, cwd) => {
          const session = await goose.open({
            cwd,
            systemPrompt: "",
            bare: true,
          });
          try {
            const settled = await Promise.race([
              session.send(TEST_PROMPT),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () =>
                    reject(new Error("The provider did not answer in time")),
                  TEST_TIMEOUT_MS,
                ),
              ),
            ]);
            const reply = settled.text?.trim() ?? "";
            if (/^\W*ok\W*$/i.test(reply))
              return { ok: true, message: "Connected" };
            return {
              ok: false,
              message: reply || settled.error || "The provider sent no reply",
            };
          } finally {
            await goose.close(session);
            // goose keeps every session; this one is not worth keeping.
            await goose
              .request("session/delete", { sessionId: session.id })
              .catch(() => undefined);
          }
        },
        launch,
      );
    return sharedProviderEnv(
      choice.provider,
      choice.model,
      Boolean(this.shared),
    )
      .then((shared) => run({ ...env, ...shared }))
      .catch((error: unknown) => ({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }));
  }

  private with<T>(
    run: (goose: GooseProcess, cwd: string) => Promise<T>,
    env: Readonly<Record<string, string>> = {},
  ): Promise<T> {
    return briefly(this.spawn, run, env);
  }
}

/** Runs `run` against a `goose-acp` started for it in the home folder, and
 * stops it after. It serves no Buzz tools. */
export async function briefly<T>(
  spawn: Spawn | undefined,
  run: (goose: GooseProcess, cwd: string) => Promise<T>,
  env: Readonly<Record<string, string | null>> = {},
): Promise<T> {
  if (!spawn) throw new Error("goose runs only in the desktop app");
  const cwd = await absolute(spawn, "~");
  const goose = await GooseProcess.start(spawn, {
    cwd,
    env,
    tools: async () => {
      throw new Error("No Buzz tools here");
    },
  });
  try {
    return await run(goose, cwd);
  } finally {
    await goose.kill();
  }
}

function provider(entry: Entry): Provider {
  const keys = entry.configKeys ?? [];
  const models = [...(entry.models ?? [])].sort(
    (a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)),
  );
  return {
    id: entry.providerId,
    name: entry.providerName,
    description: entry.description ?? "",
    defaultModel: entry.defaultModel ?? "",
    configured: Boolean(entry.configured),
    keys: keys
      .filter((key) => !key.oauthFlow && !key.deviceCodeFlow)
      .map(({ name, required, secret, default: fallback }) => ({
        name,
        required,
        secret,
        default: fallback ?? null,
      })),
    signsIn: keys.some((key) => key.oauthFlow || key.deviceCodeFlow),
    steps: entry.setupSteps ?? [],
    models: models.map((model) => ({
      id: model.id,
      label: model.name ?? model.id,
      ...(model.name && model.name !== model.id
        ? { description: model.id }
        : {}),
    })),
  };
}

/** `ANTHROPIC_API_KEY` reads as `API key`, `OPENAI_HOST` as `Host`. */
export function keyLabel(name: string) {
  const words = name.split("_").slice(1);
  const text = (words.length ? words : [name]).join(" ").toLowerCase();
  return (text.charAt(0).toUpperCase() + text.slice(1))
    .replace(/\bapi\b/i, "API")
    .replace(/\burl\b/i, "URL");
}
