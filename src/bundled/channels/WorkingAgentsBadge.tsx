import { TypingDots } from "../../shared/design-system/ui/TypingDots";
import type { Profile } from "../../features/relay/contracts";
import { publicKeyLabels } from "../../shared/identity/public-key";
import styles from "./Channels.module.css";

export function WorkingAgentsBadge({
  agents,
  profiles,
  channelName,
  waiting = false,
}: {
  agents: readonly string[];
  profiles: ReadonlyMap<string, Profile>;
  channelName: string;
  waiting?: boolean;
}) {
  if (!agents.length) return null;
  const labels = publicKeyLabels(agents);
  const name = (agent: string) =>
    profiles.get(agent)?.name ?? labels.get(agent) ?? "Agent";
  return (
    <span
      className={`${styles.thinkingBadge} buzz-arrive`}
      data-channel-working=""
      data-indicator-layer="working"
      role="img"
      aria-label={`${agents.map(name).join(", ")} ${waiting ? "waiting" : "working"} in ${channelName}`}
    >
      <TypingDots state={waiting ? "waiting" : "working"} />
    </span>
  );
}
