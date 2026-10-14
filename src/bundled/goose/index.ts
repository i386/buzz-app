// goose agents: an agent type whose agents are goose on this computer, one
// `goose-acp` process per agent. Each conversation the agent is in is one ACP
// session in it; goose answers with the in-process Buzz tools, served to it
// over the same ACP connection.
import { isTauri } from "@tauri-apps/api/core";
import type { PluginModule } from "../../plugins/api";
import { GooseLogoIcon } from "../../shared/design-system/icons";
import { type Config, config, DEFAULT_CONFIG, GooseRuntime } from "./runtime";
import { GooseSetup } from "./setup";
import { createTabs } from "./tabs";
import { GooseHistory } from "./transcript";
import { sharedProviderEnv } from "./shared-provider";

export const TYPE_ID = "goose";
/** A turn's run returns once goose has it, so this bounds only the hand-over. */
const HANDOVER_MS = 2 * 60_000;

export const inject = {
  agents: { required: true },
  host: { required: true },
  databricks: { required: false },
};
export const apply: PluginModule["apply"] = (ctx) => {
  // Only the desktop app can start `goose-acp`, and file uploads run `base64`,
  // which stock Windows lacks; no unusable type elsewhere.
  if (!isTauri() || !/Mac|Linux/i.test(navigator.platform)) return;
  const { agents, host } = ctx;
  const typeKey = `${ctx.pluginOwner?.id ?? "buzz.goose"}/${TYPE_ID}`;
  const shared = ctx.databricks?.shared;
  const runtime = new GooseRuntime(host, agents.relay, (config) =>
    sharedProviderEnv(config.provider, config.model, Boolean(shared)),
  );
  const spawn = host.spawn?.bind(host);
  const { Create, CreateModelMenu, createModelLabel, SettingsTab } = createTabs(
    {
      setup: new GooseSetup(spawn, shared),
      runtime,
      history: new GooseHistory(spawn),
    },
  );
  const sync = () => {
    const snapshot = agents.snapshot();
    if (snapshot.status === "loading") return;
    runtime.sync(snapshot.running.filter((agent) => agent.type === typeKey));
  };
  if (host.spawn) {
    const unsubscribe = agents.subscribe(sync);
    sync();
    ctx.effect(() => () => {
      unsubscribe();
      runtime.dispose();
    });
  }

  agents.register<Config>({
    id: TYPE_ID,
    title: "Goose",
    icon: GooseLogoIcon,
    description:
      "goose on this computer, with any provider goose supports. Each thread it is mentioned in is one continuing session.",
    defaults: () => ({ config: DEFAULT_CONFIG }),
    Create,
    CreateModelMenu,
    createModelLabel,
    adopt: (carry, saved) => ({
      ...saved,
      instructions: carry.instructions ?? saved.instructions,
      workspace: carry.workspace ?? saved.workspace,
    }),
    carry: (saved) => {
      const { instructions, workspace } = config(saved);
      return {
        ...(instructions.trim() && { instructions }),
        ...(workspace !== DEFAULT_CONFIG.workspace && { workspace }),
      };
    },
    summary: (agent) => {
      const { model, provider } = config(agent.config);
      return [provider, model].filter(Boolean).join(" · ") || "Goose";
    },
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        component: SettingsTab,
      },
    ],
    run: (delivery) => runtime.run(delivery),
    timeoutMs: HANDOVER_MS,
  });
};
