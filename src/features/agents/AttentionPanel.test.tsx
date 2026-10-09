// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { describeWatch } from "./attention";
import { AttentionPanel } from "./AttentionPanel";
import type { Agent } from "./service";

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
    "interest/release-triage": {
      slug: "interest/release-triage",
      modifiedAt: 1,
      value: { type: "interest", instructions: "Keep releases moving." },
    },
    "watch/questions": {
      slug: "watch/questions",
      modifiedAt: 1,
      value: {
        type: "event",
        interest_id: "release-triage",
        enabled: true,
        since: 1,
        channels: ["c1"],
        kinds: [9],
      },
    },
  },
};

it("names watches by what and where they wake", () => {
  const watch = agent.attention["watch/questions"]?.value;
  if (watch?.type !== "event") throw new Error("fixture");
  expect(describeWatch(watch, [{ id: "c1", name: "releases" }])).toBe(
    "Messages in #releases",
  );
  expect(describeWatch(watch)).toBe("Messages in 1 channel");
  expect(describeWatch({ ...watch, channels: "all", kinds: [] })).toBe(
    "Any event in any channel",
  );
});

const timer = {
  type: "timer",
  interest_id: "release-triage",
  prompt: "Summarise blockers",
  enabled: true,
  interval_secs: 60,
  armed_at: 100,
  max_occurrences: 1,
  expires_at: null,
} as const;

it("shows the agent's attention without any way to author it", () => {
  render(
    <AttentionPanel
      agent={{
        ...agent,
        attention: {
          ...agent.attention,
          "watch/timer": { slug: "watch/timer", modifiedAt: 1, value: timer },
        },
        timers: { "watch/timer": { armedAt: 100, nextDue: 220, used: 1 } },
      }}
      save={vi.fn(async () => {})}
      channels={[{ id: "c1", name: "releases" }]}
    />,
  );
  const group = screen.getByRole("region", { name: "Release triage" });
  expect(within(group).getByText("Keep releases moving.")).toBeInTheDocument();
  expect(within(group).getByText("Messages in #releases")).toBeInTheDocument();
  expect(within(group).getByText("On")).toBeInTheDocument();
  expect(within(group).getByText(/Done, ran 1 of 1 time/)).toBeInTheDocument();
  expect(within(group).getByText("Spent")).toBeInTheDocument();
  // The agent authors attention; the owner has only the switch.
  expect(screen.getAllByRole("switch")).toHaveLength(1);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

it("says when a watch's classifier cannot run", () => {
  const classified: Agent = {
    ...agent,
    attention: {
      ...agent.attention,
      "watch/questions": {
        slug: "watch/questions",
        modifiedAt: 1,
        value: {
          type: "event",
          interest_id: "release-triage",
          enabled: false,
          since: 1,
          channels: ["c1"],
          kinds: [9],
          classifier: { questions: { asks: "Is this a question?" } },
        } as never,
      },
    },
  };
  const { rerender } = render(
    <AttentionPanel agent={classified} save={vi.fn(async () => {})} />,
  );
  expect(screen.getByText(/cannot run on this device/)).toBeInTheDocument();
  expect(screen.getByText("Paused")).toBeInTheDocument();
  rerender(
    <AttentionPanel
      agent={classified}
      save={vi.fn(async () => {})}
      classifier="available"
    />,
  );
  expect(screen.queryByText(/cannot run/)).not.toBeInTheDocument();
  expect(screen.getByText("has a classifier")).toBeInTheDocument();
});

it("lets the owner turn the agent's attention off", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => {});
  render(<AttentionPanel agent={agent} save={save} channels={[]} />);
  const toggle = screen.getByRole("switch", { name: "Attention on" });
  expect(toggle).toBeChecked();
  await user.click(toggle);
  expect(save).toHaveBeenLastCalledWith({ attentionEnabled: false });
});

it("says when the agent has no attention yet", () => {
  render(
    <AttentionPanel
      agent={{ ...agent, attention: {}, attentionEnabled: false }}
      save={vi.fn(async () => {})}
    />,
  );
  expect(
    screen.getByText(/no Interests\. Turn attention on to let it add some/),
  ).toBeInTheDocument();
});

it("lets the owner remove an object the agent cannot read", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => {});
  render(
    <AttentionPanel
      agent={{
        ...agent,
        skipped: {
          "watch/bad": {
            slug: "watch/bad",
            value: { type: "event" },
            modifiedAt: 1,
            problem: "Missing field: interest_id",
          },
        },
      }}
      save={save}
    />,
  );
  const skipped = screen.getByRole("region", { name: "Skipped" });
  expect(
    within(skipped).getByText("Missing field: interest_id"),
  ).toBeInTheDocument();
  await user.click(
    within(skipped).getByRole("button", { name: "Remove watch/bad" }),
  );
  expect(save).toHaveBeenLastCalledWith({ attention: { "watch/bad": null } });
});
