import { isTauri } from "@tauri-apps/api/core";
import type { PluginModule } from "../../plugins/api";
import { config, defaults, validWorkspace } from "./config";
import { CodexRuntime } from "./runtime";
import { createTabs } from "./tabs";
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
  const runtime = new CodexRuntime(start, ctx.agents.relay);
  const typeKey = `${ctx.pluginOwner?.id ?? "buzz.codex"}/codex`;
  // Agents that stop running stop their turns, and the last one stops the
  // server; switching communities or a reconnect does not.
  const sync = () => {
    const snapshot = ctx.agents.snapshot();
    if (snapshot.status === "loading") return;
    runtime.sync(snapshot.running.filter((agent) => agent.type === typeKey));
  };
  const offAgents = ctx.agents.subscribe(sync);
  sync();
  ctx.effect(() => () => {
    offAgents();
    runtime.dispose();
  });
  const { CodexTab, SettingsTab, Create } = createTabs(start, runtime);
  ctx.agents.register({
    id: "codex",
    title: "Codex",
    description:
      "Codex on this computer, using its native coding tools and your account.",
    defaults: () => ({ config: { ...defaults } }),
    Create,
    adopt: (carry, saved) => ({
      ...saved,
      instructions: carry.instructions ?? saved.instructions,
      // Codex runs only in an absolute workspace or the default.
      workspace:
        carry.workspace && validWorkspace(carry.workspace)
          ? carry.workspace
          : saved.workspace,
    }),
    summary: (agent) => config(agent.config).model || "Codex",
    tabs: [
      { id: "codex", title: "Codex", component: CodexTab },
      { id: "settings", title: "Settings", component: SettingsTab },
    ],
    models: (agent) => runtime.preview(agent),
    run: (delivery) => runtime.run(delivery),
    timeoutMs: 2 * 60_000,
  });
};
