import type { ActivityRecord } from "../../features/agents/activity-records";
import {
  activityTranscript,
  type TranscriptItem,
} from "../../features/agents/activity-transcript";
import { activityPresentation } from "./activity-presentation";

/** Compact preview of the same transcript shown in the full activity panel. */
export function currentActivity(
  records: readonly ActivityRecord[],
  turns: readonly { turnId: string; state: string }[],
) {
  const agent = records[0]?.agent;
  if (!agent) return;
  const live = new Set(
    turns.filter((turn) => turn.state === "working").map((turn) => turn.turnId),
  );
  const entries = activityTranscript(records, { agent })
    .turns.filter((turn) => live.has(turn.turnId))
    .flatMap((turn) => turn.items)
    .filter((item) =>
      ["tool", "thought", "message", "plan"].includes(item.type),
    )
    .sort((a, b) => b.at - a.at);
  const latest = entries.find((item) => item.type === "tool") ?? entries[0];
  if (!latest) return;
  const presentation =
    latest.type === "tool" ? activityPresentation(latest) : undefined;
  const title =
    presentation?.title ??
    (latest.type === "thought"
      ? "Thinking"
      : latest.type === "plan"
        ? "Plan"
        : "Response");
  const status =
    latest.type === "tool"
      ? presentation?.shellOutput?.failed || latest.status === "failed"
        ? " · Failed"
        : latest.status === "completed"
          ? " · Completed"
          : latest.status === "pending"
            ? " · Pending"
            : latest.status === "in_progress"
              ? " · Running"
              : ""
      : "";
  const detail = presentation?.target ?? text(latest);
  return {
    title: `${title}${status}`,
    detail: detail.length > 240 ? `${detail.slice(0, 240)}…` : detail,
  };
}

function text(item: TranscriptItem): string {
  if (item.type === "message" || item.type === "thought") return item.text;
  if (item.type === "plan")
    return item.entries.map((entry) => entry.content).join("\n");
  return "";
}
