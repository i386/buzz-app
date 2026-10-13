import { useMemo, useSyncExternalStore } from "react";
import { activityTarget } from "../../features/agents/activity-target";
import type { PanelProps } from "../../features/panels/service";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";

import { activityPreview } from "./activity-preview";
import styles from "./Profiles.module.css";

/** Read the plugin-owned capture; mounting a profile never starts telemetry. */
export function ProfileActivity({
  session,
  pubkey,
  context,
  onViewActivity,
}: {
  session: RelaySession;
  pubkey: string;
  context: PanelProps["context"];
  onViewActivity?: (() => void) | undefined;
}) {
  const snapshot = useSyncExternalStore(
    session.agentActivity.subscribe,
    session.agentActivity.snapshot,
    session.agentActivity.snapshot,
  );
  const channelId = context?.channelId;
  const target = activityTarget(pubkey, channelId);
  const items = useMemo(
    () => activityPreview(snapshot.records, pubkey, channelId ?? ""),
    [snapshot.records, pubkey, channelId],
  );
  if (!channelId || !context?.canOpen(target) || snapshot.status === "disabled")
    return null;

  // Neither public agent hints nor another identity's records grant visibility.
  // Missing conversation context must never broaden this into an all-channel view.
  const turns = snapshot.turns.filter(
    (turn) => turn.agent === pubkey && turn.channelId === channelId,
  );
  const latest = Math.max(
    ...turns.map((turn) => turn.timestamp),
    ...items.map((item) => item.timestamp),
  );
  return (
    <section aria-label="Activity preview" className={styles.activityPreview}>
      <h3 className="text-body">Latest activity</h3>
      {items.length > 0 ? (
        <ol aria-label="Recent activity" className={styles.activityItems}>
          {items.map((item) => (
            <li key={item.id}>
              <span className="text-body-sm text-secondary">{item.label}</span>
              <p className={`text-body-sm ${styles.activityText}`}>
                {item.text}
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-body-sm text-secondary">
          Live activity will appear here.
        </p>
      )}
      <p role="status" className="text-body-sm text-secondary">
        {snapshot.status === "unavailable" ? (
          "Activity unavailable"
        ) : snapshot.status === "connecting" ? (
          "Connecting…"
        ) : snapshot.status === "interrupted" ? (
          "Activity disconnected"
        ) : !Number.isFinite(latest) ? (
          "No activity yet"
        ) : (
          <time dateTime={new Date(latest).toISOString()}>
            {new Date(latest).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
        )}
      </p>
      <div>
        <Button
          size="compact"
          onClick={() => {
            if (!context.canOpen(target)) return;
            if (onViewActivity) onViewActivity();
            else (context.push ?? context.open)(target);
          }}
        >
          View activity
        </Button>
      </div>
    </section>
  );
}
