// An agent's sections, wherever they are shown (its Build view and its
// profile panel): the type's own tabs, then the app's Attention and Memory tabs.
// Hosted agents' tabs are their type's alone; an agent on another device has
// none here.
import { useState, type ReactNode } from "react";
import type { ChannelChoice } from "./attention";
import { AttentionPanel } from "./AttentionPanel";
import { MemoryPanel, type AgentMemories } from "./MemoryPanel";
import type {
  Agent,
  AgentConversation,
  AgentSettingsHost,
  Agents,
  RegisteredAgentType,
} from "./service";
import { Button } from "../../shared/design-system/ui/Button";

export type AgentSection = Readonly<{
  /** `agent:<type tab id>`, `agent:attention` or `agent:memory`; never collides with a host tab. */
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
  settingsHost,
  memories,
}: {
  agents: Agents;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  channels: readonly ChannelChoice[];
  conversation?: AgentConversation | undefined;
  settingsHost?: AgentSettingsHost;
  /** Memory reads through the owner's session; absent while it connects. */
  memories: AgentMemories | undefined;
}): readonly AgentSection[] {
  if (agent.place === "elsewhere") return [];
  const typeTabs = type?.tabs ?? [];
  const settingsTab = settingsHost
    ? typeTabs.find((tab) => tab.role === "settings")
    : undefined;
  const orderedTabs = settingsTab
    ? [settingsTab, ...typeTabs.filter((tab) => tab !== settingsTab)]
    : typeTabs;
  const tabs = orderedTabs.map(({ id, title, role, component: Component }) => ({
    value: (role === "settings"
      ? "agent:settings"
      : `agent:type:${id}`) as `agent:${string}`,
    label: title,
    render: () => (
      <Component
        agent={agent}
        {...(conversation && { conversation })}
        save={(config) =>
          settingsHost?.pendingSave
            ? settingsHost.pendingSave(config)
            : agents.save(agent.pubkey, { config })
        }
        {...(role === "settings" && settingsHost ? { settingsHost } : {})}
      />
    ),
  }));
  if (settingsHost && !settingsTab)
    tabs.unshift({
      value: "agent:settings",
      label: "Settings",
      render: () => <HostSettings host={settingsHost} />,
    });
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
    {
      value: "agent:memory",
      label: "Memory",
      render: () => <MemoryPanel agent={agent} memories={memories} />,
    },
  ];
}

function HostSettings({ host }: { host: AgentSettingsHost }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (!host.pendingSave) return;
    setSaving(true);
    setError("");
    try {
      await host.pendingSave();
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {host.typeControl?.(false)}
      {error && (
        <p role="alert" className="buzz-field-error">
          {error}
        </p>
      )}
      <div>
        <Button
          type="submit"
          variant="prominent"
          loading={saving}
          disabled={!host.pendingSave}
          focusableWhenDisabled
        >
          Save
        </Button>
      </div>
    </form>
  );
}
