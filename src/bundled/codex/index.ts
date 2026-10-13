import { isTauri } from "@tauri-apps/api/core";
import type { PluginModule } from "../../plugins/api";
import { CodexLogoIcon } from "../../shared/design-system/icons";
import { config, defaults, validWorkspace } from "./config";
import { CodexRuntime } from "./runtime";
import { CodexProvider, createTabs } from "./tabs";
export const inject = ["agents", "host"];
export const apply: PluginModule["apply"] = (ctx) => {
  // Only the desktop app can start `codex`, and file uploads run `base64`,
  // which stock Windows lacks; no unusable type elsewhere.
  if (!isTauri() || !/Mac|Linux/i.test(navigator.platform)) return;
  const spawn = ctx.host.spawn?.bind(ctx.host);
  const start =
    spawn ??
    (async () => {
      throw new Error("Codex agents run only in the desktop app");
    });
  const providerController = new CodexProvider(start);
  const runtime = new CodexRuntime(
    start,
    ctx.agents.relay,
    localStorage,
    (raw) => providerController.resolve(raw),
  );
  const typeKey = `${ctx.pluginOwner?.id ?? "buzz.codex"}/codex`;
  // Agents that stop running stop their turns, and the last one stops the
  // server; switching communities or a reconnect does not.
  const sync = () => {
    const snapshot = ctx.agents.snapshot();
    if (snapshot.status === "loading") return;
    runtime.sync(snapshot.running.filter((agent) => agent.type === typeKey));
  };
  const offAgents = ctx.agents.subscribe(sync);
  const offProvider = providerController.subscribe(sync);
  sync();
  ctx.effect(() => () => {
    offAgents();
    offProvider();
    providerController.dispose();
    runtime.dispose();
  });
  const {
    Create,
    CreateModelMenu,
    createModelLabel,
    ProviderDialogBody,
    SettingsTab,
  } = createTabs(providerController, runtime, start);
  ctx.agents.register({
    id: "codex",
    title: "Codex",
    icon: CodexLogoIcon,
    description:
      "Codex on this computer, using its native coding tools and your account.",
    defaults: () => ({ config: { ...defaults } }),
    Create,
    CreateModelMenu,
    createModelLabel,
    adopt: (carry, saved) => ({
      ...saved,
      instructions: carry.instructions ?? saved.instructions,
      // Codex runs only in an absolute or home workspace.
      workspace:
        carry.workspace && validWorkspace(carry.workspace)
          ? carry.workspace
          : saved.workspace,
    }),
    carry: (saved) => {
      const { instructions, workspace } = config(saved);
      return {
        ...(instructions.trim() && { instructions }),
        ...(workspace !== defaults.workspace && { workspace }),
      };
    },
    describeMigration: (saved) => {
      const { model, effort, scope } = config(saved);
      return [
        { id: "model", label: "Model", isOverride: Boolean(model.trim()) },
        {
          id: "thinking",
          label: "Thinking",
          isOverride: Boolean(effort),
        },
        {
          id: "sessions",
          label: "Sessions",
          isOverride: scope !== defaults.scope,
          unchangedKey: scope,
        },
      ];
    },
    migrationWarning: "Any commands Codex left running will stop.",
    summary: (agent) => config(agent.config).model || "Codex",
    provider: {
      snapshot: providerController.snapshot,
      subscribe: providerController.subscribe,
      check: () => providerController.check(),
      DialogBody: ProviderDialogBody,
    },
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        component: SettingsTab,
      },
    ],
    models: (agent) => runtime.preview(agent),
    run: async (delivery) => {
      if (providerController.snapshot().readiness === "checking")
        await providerController.check();
      return runtime.run(delivery);
    },
    timeoutMs: 2 * 60_000,
  });
};
