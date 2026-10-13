// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentsSnapshot } from "../../features/agents/service";
import { ClassifierSettings } from "./ClassifierSettings";

afterEach(cleanup);

/** Agents as far as the card uses it, with a key store that can fail. */
function fake(
  status: AgentsSnapshot["status"] = "ready",
  classifierKey: AgentsSnapshot["classifierKey"] = "missing",
) {
  let state: AgentsSnapshot = {
    status,
    classifier: "unavailable",
    classifierKey,
    agents: [],
    running: [],
    teams: [],
  };
  const listeners = new Set<() => void>();
  const set = (classifierKey: AgentsSnapshot["classifierKey"]) => {
    state = { ...state, classifierKey };
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setClassifierKey: vi.fn(async (_key: string) => set("saved")),
    clearClassifierKey: vi.fn(async () => set("missing")),
  };
}

it("asks for the desktop app in the browser", () => {
  render(
    <ClassifierSettings agents={fake("unavailable")} active={() => true} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("desktop app");
  expect(screen.queryByLabelText("TypeSafe API key")).not.toBeInTheDocument();
});

it("saves a key without showing it again, and removes it", async () => {
  const user = userEvent.setup();
  const agents = fake();
  render(<ClassifierSettings agents={agents} active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent("No TypeSafe key");
  const input = screen.getByLabelText("TypeSafe API key");
  expect(input).toHaveAttribute("type", "password");
  expect(screen.getByRole("button", { name: "Save key" })).toBeDisabled();
  await user.type(input, "  tk-secret  ");
  await user.click(screen.getByRole("button", { name: "Save key" }));
  expect(agents.setClassifierKey).toHaveBeenCalledWith("tk-secret");
  expect(input).toHaveValue("");
  expect(screen.getByRole("status")).toHaveTextContent(
    "A TypeSafe key is saved",
  );
  await user.click(screen.getByRole("button", { name: "Remove key" }));
  expect(agents.clearClassifierKey).toHaveBeenCalledOnce();
  expect(screen.getByRole("status")).toHaveTextContent("No TypeSafe key");
});

it("keeps the typed key and shows why a save failed", async () => {
  const user = userEvent.setup();
  const agents = fake();
  agents.setClassifierKey.mockRejectedValueOnce(
    new Error("That does not look like a TypeSafe API key"),
  );
  render(<ClassifierSettings agents={agents} active={() => true} />);
  await user.type(screen.getByLabelText("TypeSafe API key"), "bad key");
  await user.click(screen.getByRole("button", { name: "Save key" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "does not look like",
  );
  expect(screen.getByLabelText("TypeSafe API key")).toHaveValue("bad key");
});

it("says what each classified event sends to TypeSafe", () => {
  render(<ClassifierSettings agents={fake()} active={() => true} />);
  expect(screen.getByText(/api\.typesafe\.ai/)).toHaveTextContent(
    /whole event.*display name.*channel name.*600 characters.*mentions.*private channels/,
  );
});

it("does not call a key missing until its status is read, or when it cannot be", async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <ClassifierSettings
      agents={fake("ready", "checking")}
      active={() => true}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Checking");
  expect(screen.queryByRole("button", { name: "Remove key" })).toBeNull();
  const unreadable = fake("ready", "unreadable");
  rerender(<ClassifierSettings agents={unreadable} active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent("could not be read");
  expect(screen.getByRole("button", { name: "Replace key" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Remove key" }));
  expect(unreadable.clearClassifierKey).toHaveBeenCalledOnce();
  rerender(
    <ClassifierSettings
      agents={fake("ready", "refused")}
      active={() => true}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "TypeSafe refused the saved key",
  );
  expect(screen.getByRole("button", { name: "Replace key" })).toBeVisible();
});
