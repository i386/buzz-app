// Claude agents: an agent type whose agents are Claude sessions on
// this computer. Each conversation the agent is in is one continuing session;
// Claude answers with the in-process Buzz tools.
import { isTauri } from "@tauri-apps/api/core";
import { ownerReads } from "../../features/agents/reads";
import type { PluginModule } from "../../plugins/api";
import { ClaudeLogoIcon } from "../../shared/design-system/icons";
import { claudeRun, TYPE_ID } from "./run";
import { ClaudeDefaults } from "./defaults";
import { ClaudeRuntime, type Config, config, DEFAULT_CONFIG } from "./runtime";
import { ClaudeSetup, withScript } from "./setup";
import { createTabs } from "./tabs";

export { TYPE_ID };
/** How often Buzz's copy of Claude looks for a new release. */
const UPDATE_MS = 6 * 60 * 60_000;

export const inject = ["agents", "host"];
export const apply: PluginModule["apply"] = (ctx) => {
  // Only the desktop app can start `claude`, and setup and file uploads run
  // `bash` and `base64`, which stock Windows lacks; no unusable type elsewhere.
  if (!isTauri() || !/Mac|Linux/i.test(navigator.platform)) return;
  const { agents, host } = ctx;
  const typeKey = `${ctx.pluginOwner?.id ?? "buzz.claude-code"}/${TYPE_ID}`;
  const spawn = host.spawn && withScript(host.spawn.bind(host));
  const setup = new ClaudeSetup(spawn, (input) => host.request(input));
  const providerDefaults = new ClaudeDefaults();
  const runtime = new ClaudeRuntime(
    spawn ? { spawn } : {},
    (pubkey) => ownerReads(agents.relay(pubkey), pubkey),
    localStorage,
    (raw) => providerDefaults.resolve(raw),
  );
  /** A Claude agent is running, so Buzz's copy is needed; unknown until the
   * agents have loaded. */
  let needed: boolean | undefined;
  const sync = () => {
    const snapshot = agents.snapshot();
    // Agents that stop running, the app signing out included, stop their
    // processes; switching communities does not.
    if (snapshot.status === "loading") return;
    const running = snapshot.running.filter((agent) => agent.type === typeKey);
    runtime.sync(running);
    // Once loaded, and when the first Claude agent runs, the copy is brought
    // up to date; that is also when a first copy is downloaded.
    const was = needed;
    needed = running.length > 0;
    if (was === undefined || (needed && !was)) void setup.update(needed);
  };
  // One spare session waits for whichever running agent needs it next.
  if (spawn) {
    const unsubscribe = agents.subscribe(sync);
    const unsubscribeDefaults = providerDefaults.subscribe(sync);
    sync();
    const timer = setInterval(
      () => void setup.update(needed ?? false),
      UPDATE_MS,
    );
    ctx.effect(() => () => {
      clearInterval(timer);
      unsubscribe();
      unsubscribeDefaults();
      runtime.dispose();
      setup.dispose();
    });
  }

  const {
    Create,
    CreateModelMenu,
    createModelLabel,
    ProviderDialogBody,
    SettingsTab,
  } = createTabs({ setup, defaults: providerDefaults, runtime });
  agents.register<Config>({
    id: TYPE_ID,
    title: "Claude",
    icon: ClaudeLogoIcon,
    description:
      "Claude on this computer. Each thread it is mentioned in is one continuing session.",
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
    describeMigration: (saved) => {
      const { model, scope } = config(saved);
      return [
        { id: "model", label: "Model", isOverride: Boolean(model.trim()) },
        {
          id: "sessions",
          label: "Sessions",
          isOverride: scope !== DEFAULT_CONFIG.scope,
          unchangedKey: scope,
        },
      ];
    },
    summary: (agent) => config(agent.config).model || "Claude",
    provider: {
      snapshot: setup.providerSnapshot,
      subscribe: setup.subscribe,
      check: () => setup.check(),
      get attentionAction() {
        const state = setup.snapshot();
        if (state.running) return undefined;
        return state.status?.state === "missing" ||
          state.status?.state === "outdated"
          ? () => void setup.run("install")
          : state.status?.state === "signed-out"
            ? () => void setup.run("login")
            : undefined;
      },
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
    // A mention during the first download waits for it, within its deadline.
    ...claudeRun(runtime, (signal) => setup.installed(signal)),
  });
};
