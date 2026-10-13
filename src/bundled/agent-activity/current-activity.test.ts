import { expect, it } from "vitest";
import { currentActivity } from "./current-activity";
import type { ActivityRecord } from "../../features/agents/activity-records";
const frame = (id: string, turnId: string, update: object): ActivityRecord => ({
  id,
  envelopeId: id,
  agent: "a",
  kind: "acp_read",
  receivedAt: 1,
  plaintext: JSON.stringify({
    kind: "acp_read",
    channelId: "c",
    turnId,
    payload: { method: "session/update", params: { update } },
  }),
});
const tool = {
  sessionUpdate: "tool_call",
  toolCallId: "t",
  title: "buzz-dev-mcp__read_file",
  status: "in_progress",
  rawInput: { path: "/project/file.ts" },
};
it("does not borrow historical actions when typing has no live turn", () => {
  const records = [frame("1", "old", tool)];
  expect(currentActivity(records, [])).toBeUndefined();
  expect(
    currentActivity(records, [{ turnId: "old", state: "ended" }]),
  ).toBeUndefined();
  expect(
    currentActivity(records, [{ turnId: "old", state: "unknown" }]),
  ).toBeUndefined();
  expect(
    currentActivity(records, [{ turnId: "new", state: "working" }]),
  ).toBeUndefined();
});
it("prefers the latest tool over later prose, including folded completions and failures", () => {
  const turns = [{ turnId: "t", state: "working" }];
  const records = [
    frame("1", "t", tool),
    frame("2", "t", {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Thinking text" },
    }),
  ];
  expect(currentActivity(records, turns)).toEqual({
    title: "Read file · Running",
    detail: "file.ts",
  });
  records.push(
    frame("3", "t", {
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      status: "completed",
    }),
  );
  expect(currentActivity(records, turns)).toEqual({
    title: "Read file · Completed",
    detail: "file.ts",
  });
  records.push(
    frame("4", "t", {
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      status: "failed",
    }),
  );
  expect(currentActivity(records, turns)?.title).toBe("Read file · Failed");
});
it("bounds long preview text without rendering it as markup", () => {
  const result = currentActivity(
    [
      frame("1", "t", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "<script>".repeat(100) },
      }),
    ],
    [{ turnId: "t", state: "working" }],
  );
  expect(result?.detail).toHaveLength(241);
  expect(result?.title).toBe("Response");
});
