// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ClassifierAvailability } from "./attention-objects";
import type { Agent, Agents } from "./service";
import { agentSections } from "./tabs";

afterEach(cleanup);

const agent: Agent = {
  pubkey: "a".repeat(64),
  name: "Ada",
  type: "test/echo",
  owner: "f".repeat(64),
  relay: "wss://relay.example",
  place: "here",
  config: {},
  skipped: {},
  timers: {},
  attentionEnabled: true,
  attention: {
    "interest/triage": {
      slug: "interest/triage",
      modifiedAt: 1,
      value: { type: "interest", instructions: "Triage." },
    },
    "watch/asks": {
      slug: "watch/asks",
      modifiedAt: 1,
      value: {
        type: "event",
        interest_id: "triage",
        enabled: true,
        since: 1,
        channels: ["c1"],
        kinds: [9],
        classifier: {
          questions: { asks: { question: "Is this a question?" } },
        },
      },
    },
  },
} as Agent;

it("updates the classifier warning when the key changes while the agent does not", () => {
  let classifier: ClassifierAvailability = "unavailable";
  const listeners = new Set<() => void>();
  const agents = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    classifier: () => classifier,
    save: async () => {},
  } as unknown as Agents;
  const set = (next: ClassifierAvailability) =>
    act(() => {
      classifier = next;
      for (const listener of listeners) listener();
    });
  const section = agentSections({
    agents,
    agent,
    type: undefined,
    channels: [],
  }).find((tab) => tab.value === "agent:attention");
  render(<div>{section?.render()}</div>);
  expect(screen.getByText(/cannot run on this device/)).toBeInTheDocument();
  set("available");
  expect(screen.queryByText(/cannot run/)).not.toBeInTheDocument();
  set("unavailable");
  expect(screen.getByText(/cannot run on this device/)).toBeInTheDocument();
});
