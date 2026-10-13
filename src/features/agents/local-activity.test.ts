import { expect, it } from "vitest";
import {
  createLocalAgentActivity,
  localActivity,
  localWorkLabel,
  stepText,
} from "./local-activity";
import { createAgentActivity } from "../agents/activity";
import { messageActivity } from "../../bundled/agent-activity/message-activity";
import { workingAgents } from "../../bundled/channels/working-agents";
import { threadWorkingAgents } from "../agents/thread-working";

const scope = "https://relay.test:viewer",
  agent = "a".repeat(64),
  root = "b".repeat(64),
  reply = "c".repeat(64);
it("projects one local source into channel, exact thread and message without needing observer telemetry", () => {
  const local = createLocalAgentActivity();
  let allowed = true;
  const activity = createAgentActivity(
    false,
    () => {},
    (channel) => allowed && channel === "channel",
    undefined,
    undefined,
    undefined,
    { source: local.reader, scope },
  );
  const snapshot = activity.queries.snapshot;
  try {
    local.begin({
      scope: "other",
      agent,
      channelId: "channel",
      threadRootId: root,
      messageId: root,
    });
    expect(snapshot().local).toEqual([]);
    const work = local.begin({
      scope,
      agent,
      channelId: "channel",
      threadRootId: root,
      messageId: reply,
    });
    expect(localActivity(snapshot(), "channel").get(agent)?.state).toBe(
      "waiting",
    );
    expect(workingAgents(snapshot(), "channel")).toEqual([agent]);
    expect(threadWorkingAgents(snapshot(), [], "channel", root)).toEqual([
      agent,
    ]);
    expect(threadWorkingAgents(snapshot(), [], "channel", reply)).toEqual([]);
    expect(messageActivity(snapshot(), "channel", reply)[0]?.state).toBe(
      "waiting",
    );
    expect(messageActivity(snapshot(), "channel", root)).toEqual([]);
    work.started();
    expect(messageActivity(snapshot(), "channel", reply)[0]?.working).toBe(
      true,
    );
    work.finish({ ok: false, error: "Provider unavailable" });
    expect(workingAgents(snapshot(), "channel")).toEqual([]);
    expect(threadWorkingAgents(snapshot(), [agent], "channel", root)).toEqual(
      [],
    );
    expect(messageActivity(snapshot(), "channel", reply)[0]).toMatchObject({
      state: "error",
      reason: "Provider unavailable",
    });
    const next = local.begin({
      scope,
      agent,
      channelId: "channel",
      threadRootId: root,
      messageId: reply,
    });
    work.finish({ ok: true });
    expect(messageActivity(snapshot(), "channel", reply)[0]?.state).toBe(
      "waiting",
    );
    next.started();
    next.finish({ ok: true });
    expect(messageActivity(snapshot(), "channel", reply)).toEqual([]);
    allowed = false;
    activity.accessChanged();
    expect(snapshot().local).toEqual([]);
  } finally {
    activity.dispose();
  }
});

it("keeps storage bounded and prevents evicted or removed callbacks from recreating state", () => {
  const local = createLocalAgentActivity();
  const old = local.begin({
    scope,
    agent,
    channelId: "channel",
    messageId: "old",
    threadRootId: root,
  });
  for (let i = 0; i < 520; i++)
    local.begin({
      scope,
      agent,
      channelId: "channel",
      messageId: String(i),
      threadRootId: root,
    });
  expect(local.reader.work()).toHaveLength(512);
  old.finish({ ok: false, error: "Late error" });
  expect(local.reader.work().some((row) => row.messageId === "old")).toBe(
    false,
  );
  const pending = local.begin({
    scope,
    agent,
    channelId: "channel",
    messageId: reply,
    threadRootId: root,
  });
  local.clear(scope, agent);
  pending.started();
  pending.finish({ ok: true });
  expect(local.reader.work()).toEqual([]);
});

it("shows the latest live step while working and drops it once settled", () => {
  const activity = createLocalAgentActivity();
  const work = activity.begin({
    scope: "s",
    agent: "a",
    channelId: "c",
    messageId: "m",
    threadRootId: "m",
  });
  const row = () => {
    const current = activity.reader.work()[0];
    if (!current) throw new Error("Expected local work");
    return current;
  };
  work.step("Read", "  notes.txt ");
  expect(row()).toMatchObject({
    state: "working",
    step: { tool: "Read", target: "notes.txt" },
  });
  expect(localWorkLabel(row())).toBe("Reading notes.txt");
  work.step("   ");
  expect(row()?.step?.tool).toBe("Read");
  work.finish({ ok: true });
  expect(row()?.step).toBeUndefined();
  work.step("Late");
  expect(row()).toMatchObject({ state: "done" });
  expect(localWorkLabel(row())).toBe("Finished");
});

it("words readable steps from the harness's own tool names and targets", () => {
  const text = (tool: string, target?: string) =>
    stepText(target ? { tool, target } : { tool });
  expect(text("Bash", "Custom harness catalog build")).toBe(
    "Custom harness catalog build",
  );
  expect(text("Shell", "ls")).toBe("Running ls");
  expect(text("Shell")).toBe("Running a command");
  expect(text("Edit", "discovery.rs")).toBe("Editing discovery.rs");
  expect(text("Agent", "Find harness")).toBe("Subagent · Find harness");
  expect(text("send")).toBe("Sending a message");
  expect(text("Bash")).toBe("Running a command");
  expect(text("custom_tool", "x")).toBe("custom_tool · x");
  expect(text("custom_tool")).toBe("custom_tool");
});
