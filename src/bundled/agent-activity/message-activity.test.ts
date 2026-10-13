import { expect, it } from "vitest";
import { messageActivity } from "./message-activity";
import type { RelaySession } from "../../features/relay/session";
const request = "a".repeat(64),
  sibling = "b".repeat(64);
type Snapshot = ReturnType<RelaySession["agentActivity"]["snapshot"]>;
function fixture(): Snapshot {
  return {
    status: "listening",
    trimmed: 0,
    history: "unavailable",
    hasOlder: false,
    historyOlder: false,
    historySkipped: 0,
    historyAgents: [],
    capture: "off",

    typing: [],
    records: ["agent", "peer"].map((agent) => ({
      id: agent,
      agent,
      kind: "turn_started",
      channelIds: ["channel"],
      receivedAt: 1000,
      historical: false,
      createdAt: 1,
      plaintext: JSON.stringify({
        kind: "turn_started",
        channelId: "channel",
        turnId: agent,
        seq: 1,
        timestamp: new Date(1000).toISOString(),
        payload: {
          triggeringEventIds: [agent === "agent" ? request : sibling],
        },
      }),
    })),
    turns: ["agent", "peer"].map((agent) => ({
      agent,
      turnId: agent,
      channelId: "channel",
      timestamp: 1000,
      state: "working",
    })),
  };
}
it("associates activity only with the exact triggering message and channel", () => {
  const source = fixture();
  expect(
    messageActivity(source, "channel", request).map((e) => e.agent),
  ).toEqual(["agent"]);
  expect(
    messageActivity(source, "channel", sibling).map((e) => e.agent),
  ).toEqual(["peer"]);
  expect(messageActivity(source, "other", request)).toEqual([]);
  expect(messageActivity(source, "channel", "c".repeat(64))).toEqual([]);
  expect(
    messageActivity({ ...source, records: [] }, "channel", request),
  ).toEqual([]);
});
it("stops animation on interrupted or stale evidence and removes settled work", () => {
  const source = fixture();
  expect(messageActivity(source, "channel", request)[0]?.working).toBe(true);
  expect(
    messageActivity({ ...source, status: "interrupted" }, "channel", request)[0]
      ?.working,
  ).toBe(false);
  expect(
    messageActivity({ ...source, turns: [] }, "channel", request)[0]?.working,
  ).toBe(false);
  const start = source.records[0];
  if (!start) throw new Error("Missing start fixture");
  for (const kind of ["turn_completed", "turn_error", "agent_panic"]) {
    const ended: Snapshot = {
      ...source,
      turns: source.turns.map((turn) => ({ ...turn, state: "ended" })),
      records: [
        ...source.records,
        {
          ...start,
          id: "terminal",
          kind,
          plaintext: JSON.stringify({
            kind,
            channelId: "channel",
            turnId: "agent",
            seq: 2,
            timestamp: new Date(1000).toISOString(),
          }),
        },
      ],
    };
    expect(messageActivity(ended, "channel", request)).toEqual([]);
  }
});
it("never uses typing as message association or resurrects an ended request", () => {
  const source = fixture();
  const typing = [
    {
      agent: "peer",
      channelId: "channel",
      threadRootId: request,
      timestamp: 1100,
      startedAt: 1100,
      expiresAt: 9000,
      working: true,
    },
  ];
  expect(
    messageActivity({ ...source, records: [], typing }, "channel", request),
  ).toEqual([]);
  expect(
    messageActivity({ ...source, typing }, "channel", request).map(
      (e) => e.agent,
    ),
  ).toEqual(["agent"]);
});

it("keeps restored starts out of live message bubbles even if a heartbeat has the same turn ID", () => {
  const source = fixture();
  expect(
    messageActivity(
      {
        ...source,
        records: source.records.map((record) => ({
          ...record,
          historical: true,
        })),
      },
      "channel",
      request,
    ),
  ).toEqual([]);
});
