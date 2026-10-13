import { useState } from "react";
import type { ChannelChoice } from "../../features/agents/attention";
import type {
  Agent,
  AgentSettingsHost,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import type { AgentMemories } from "../../features/agents/MemoryPanel";
import { agentSections } from "../../features/agents/tabs";
import { Tabs } from "../../shared/design-system/ui/Tabs";

/** An agent's sections as tabs, opening on the first. */
export function AgentTabs(props: {
  agents: Agents;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  channels: readonly ChannelChoice[];
  settingsHost: AgentSettingsHost;
  memories: AgentMemories | undefined;
}) {
  const sections = agentSections(props);
  const [tab, setTab] = useState<string>(sections[0]?.value ?? "");
  const selected =
    sections.find((section) => section.value === tab) ?? sections.at(-1);
  return (
    <Tabs
      value={selected?.value ?? ""}
      onValueChange={setTab}
      items={sections.map(({ value, label }) => ({ value, label }))}
      label={`${props.agent.name} sections`}
      variant="panel"
      renderPanel={(value) => (
        <div className="pt-4">
          {sections.find((section) => section.value === value)?.render()}
        </div>
      )}
    />
  );
}
