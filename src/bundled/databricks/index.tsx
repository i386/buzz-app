import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";
import { Button } from "../../shared/design-system/ui/Button";
import { Header } from "../../shared/design-system/ui/Header";
import { DatabricksProvider, DatabricksService } from "./provider";

export const inject = ["settingsCards"];
export const apply: PluginModule["apply"] = (ctx) => {
  if (!isTauri() || !/Mac|Linux/i.test(navigator.platform)) return;
  const provider = new DatabricksProvider();
  function Connection({
    onChange,
    disabled = false,
  }: {
    onChange(): void;
    disabled?: boolean;
  }) {
    const state = useSyncExternalStore(
      provider.subscribe,
      provider.snapshot,
      provider.snapshot,
    );
    useEffect(() => {
      void provider.connected().catch(() => {});
    }, []);
    const action = async (run: () => Promise<void>) => {
      await run();
      onChange();
    };
    return (
      <div className="grid gap-3">
        <p className="m-0 text-body-sm text-secondary">
          Connect to Block’s Databricks workspace once. This connection can be
          used by every Goose agent.
        </p>
        <p role="status" className="m-0 text-body-sm">
          {state.committing
            ? "Completing sign-in…"
            : state.pending
              ? "Finish sign-in in your browser, then return to Buzz."
              : state.connected
                ? "Connected to Databricks"
                : "Sign in to list and use Databricks models."}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {state.committing ? null : state.pending ? (
            <Button onClick={provider.cancel}>Cancel sign-in</Button>
          ) : state.connected ? (
            <Button
              disabled={disabled}
              onClick={() => void action(() => provider.signOut())}
            >
              Sign out
            </Button>
          ) : (
            <Button
              disabled={disabled}
              onClick={() => void action(() => provider.signIn())}
            >
              Sign in to Databricks
            </Button>
          )}
        </div>
        {state.error && (
          <p role="alert" className="buzz-field-error m-0">
            {state.error}
          </p>
        )}
      </div>
    );
  }
  new DatabricksService(ctx, provider, {
    id: provider.id,
    name: provider.name,
    connected: () => provider.connected(),
    models: provider.models,
    Connection,
  });
  ctx.settingsCards.register({
    id: "databricks",
    title: "Databricks",
    group: "Providers",
    component: () => (
      <div className="grid gap-4">
        <Header
          title="Databricks"
          subtitle="Shared credentials and model discovery for Block’s Databricks workspace."
        />
        <Connection onChange={() => {}} />
      </div>
    ),
  });
};
