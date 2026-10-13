// An agent as a card: its portrait large, its name, and one line about it.
// Pack avatars play their animation; any other picture shows still.
import type { ComponentProps, ReactNode } from "react";
import { agentAvatars } from "../../features/agents/avatar-packs";
import { useAvatarPreview } from "../../features/profiles/use-avatar-preview";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import styles from "./AgentCard.module.css";
import { PackedAgentAvatar } from "./PackedAgentAvatar";

type Portrayed = Readonly<{ name: string; picture?: string | undefined }>;

/** An agent's picture: a pack avatar animates, any other shows through its
 * community's media access. */
export function AgentPortrait({
  agent,
  community,
}: {
  agent: Portrayed;
  community?: string | undefined;
}) {
  const pack = agentAvatars.find((avatar) => avatar.url === agent.picture);
  const src = useAvatarPreview(pack ? "" : (agent.picture ?? ""), community);
  if (pack) return <PackedAgentAvatar avatar={pack} />;
  return (
    <Avatar
      src={src}
      alt=""
      fallback={agent.name}
      size="fill"
      shape="squircle"
    />
  );
}

export function AgentCard({
  agent,
  community,
  detail,
  icon,
  children,
  ...props
}: Omit<ComponentProps<"div">, "className" | "children"> & {
  agent: Portrayed;
  community?: string | undefined;
  /** One line under the name, such as its model. */
  detail?: ReactNode;
  icon?: ReactNode;
  /** Actions below the detail. */
  children?: ReactNode;
}) {
  const animated = agentAvatars.some((avatar) => avatar.url === agent.picture);
  return (
    <div {...props} className={styles.card}>
      <span
        className={styles.portrait}
        data-animated={animated || undefined}
        aria-hidden="true"
      >
        <AgentPortrait agent={agent} community={community} />
      </span>
      <span className={styles.name}>{agent.name}</span>
      {detail && (
        <span className={styles.detail}>
          {icon}
          <span className={styles.detailText}>{detail}</span>
        </span>
      )}
      {children && <span className={styles.actions}>{children}</span>}
    </div>
  );
}
