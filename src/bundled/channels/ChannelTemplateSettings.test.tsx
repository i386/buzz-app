// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import type { Agents } from "../../features/agents/service";
import { channelTemplates } from "../../features/channel-templates/local";
import { ChannelTemplateSettings } from "./ChannelTemplateSettings";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const snapshot = {
  status: "ready",
  agents: [{ pubkey: "a".repeat(64), name: "Ada" }],
  running: [],
  teams: [
    { id: "t1", name: "Core", instructions: "", members: [] },
    { id: "t2", name: "Docs", instructions: "", members: [] },
  ],
};
const agents = {
  snapshot: () => snapshot,
  subscribe: () => () => {},
} as unknown as Agents;

it("makes, edits and deletes a template of agents, teams and a Canvas", async () => {
  const user = userEvent.setup();
  render(<ChannelTemplateSettings agents={agents} active={() => true} />);
  await user.click(screen.getByRole("button", { name: "New template" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Launch");
  await user.click(screen.getByRole("checkbox", { name: "Ada" }));
  await user.click(screen.getByRole("checkbox", { name: "Docs" }));
  await user.type(
    screen.getByRole("textbox", { name: /Starting Canvas/ }),
    "# Goal",
  );
  await user.click(screen.getByRole("button", { name: "Save template" }));
  expect(channelTemplates.snapshot()).toMatchObject([
    {
      name: "Launch",
      teams: ["t2"],
      agents: ["a".repeat(64)],
      canvas: "# Goal",
    },
  ]);
  expect(screen.getByText("Ada, Docs · Canvas")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Edit Launch" }));
  await user.click(screen.getByRole("checkbox", { name: "Core" }));
  await user.click(screen.getByRole("button", { name: "Save template" }));
  expect(channelTemplates.snapshot()[0]?.teams).toEqual(["t2", "t1"]);

  await user.click(screen.getByRole("button", { name: "Edit Launch" }));
  await user.click(screen.getByRole("button", { name: "Delete" }));
  expect(channelTemplates.snapshot()).toEqual([]);
  expect(screen.getByText("No channel templates yet")).toBeVisible();
});
