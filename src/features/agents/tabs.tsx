// An agent's sections, wherever they are shown (its Build view and its
// profile panel): the type's own tabs, then the app's Attention tab, which every
// agent here shares because the app is what wakes it. Hosted agents' tabs are
// their type's alone; an agent on another device has none here.
import type { ReactNode } from "react";
import type { ChannelChoice } from "./attention";
import { AttentionPanel } from "./AttentionPanel";
import type {
  Agent,
  AgentConversation,
  Agents,
  RegisteredAgentType,
} from "./service";

export type AgentSection = Readonly<{
  /** `agent:<type tab id>` or `agent:attention`; never collides with a host tab. */
  value: `agent:${string}`;
  label: string;
  render(): ReactNode;
}>;

export function agentSections({
  agents,
  agent,
  type,
  channels,
  conversation,
}: {
  agents: Agents;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  channels: readonly ChannelChoice[];
  conversation?: AgentConversation | undefined;
}): readonly AgentSection[] {
  if (agent.place === "elsewhere") return [];
  const tabs = (type?.tabs ?? []).map(
    ({ id, title, component: Component }) => ({
      value: `agent:type:${id}` as const,
      label: title,
      render: () => (
        <Component
          agent={agent}
          {...(conversation && { conversation })}
          save={(config) => agents.save(agent.pubkey, { config })}
        />
      ),
    }),
  );
  if (agent.place === "hosted") return tabs;
  return [
    ...tabs,
    {
      value: "agent:attention",
      label: "Attention",
      render: () => (
        <AttentionPanel
          agent={agent}
          save={(change) => agents.save(agent.pubkey, change)}
          channels={channels}
        />
      ),
    },
  ];
}
