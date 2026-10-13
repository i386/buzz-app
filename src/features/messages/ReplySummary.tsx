import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import type { Profile } from "../relay/contracts";
import styles from "./Messages.module.css";

/** Shared summary contents for channel threads and collapsed reply branches. */
export function ReplySummary({
  count,
  participants,
  profiles,
  agentPubkeys,
  resolveName,
  media,
  unreadLabel,
  unreadCount,
}: {
  count: number;
  participants: readonly string[];
  profiles?: ReadonlyMap<string, Profile> | undefined;
  agentPubkeys?: ReadonlySet<string> | undefined;
  resolveName(id: string, fallback: string): string;
  media(url: string, size?: "small"): string | undefined;
  unreadLabel?: string | undefined;
  unreadCount?: number;
}) {
  return (
    <>
      <AvatarStack
        size="small"
        items={participants.map((id) => {
          const profile = profiles?.get(id);
          return {
            id,
            name: resolveName(id, profile?.name ?? id.slice(0, 10)),
            src: profile?.picture ? media(profile.picture, "small") : undefined,
            shape: agentPubkeys?.has(id) ? "squircle" : "circle",
          };
        })}
      />
      <span>
        {count} {count === 1 ? "reply" : "replies"}
      </span>
      {unreadCount ? (
        <span>({unreadCount} new)</span>
      ) : unreadLabel ? (
        <span
          className={styles.threadUnread}
          aria-hidden="true"
          title={unreadLabel}
        />
      ) : null}
    </>
  );
}
