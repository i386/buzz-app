import type { PluginModule } from "../../plugins/api";
import { AgentsPage } from "./AgentsPage";

export const inject = ["pages", "agents", "relay"];
export const apply: PluginModule["apply"] = (ctx) => {
  const { agents, relay } = ctx;
  ctx.pages.register({
    id: "agents",
    title: "Agents",
    layout: "workspace",
    primary: true,
    component: () => <AgentsPage agents={agents} relay={relay} />,
  });
};
