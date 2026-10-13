// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent } from "../../../features/agents/service";
import type { Host, HostResponse } from "../../../features/host/service";
import { createAgentClient } from "../agents/client";
import { createOAuthSession } from "../oauth/session";
import { deferred } from "../test-helpers";
import { builderlabType } from "./index";

const first = "ab".repeat(32);
const second = "cd".repeat(32);
const agent = (pubkey = first): Agent => ({
  pubkey,
  name: "Helper",
  type: "block.builderlab/builderlab",
  owner: "ef".repeat(32),
  relay: "wss://community.example",
  place: "hosted",
  config: {},
  attention: {},
  skipped: {},
  attentionEnabled: true,
  timers: {},
});
const response = (): HostResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify({
    status: 1,
    agents: [
      {
        agent_id: "one",
        agent_pubkey: first,
        agent_name: "Helper",
        status: 2,
        agent_instructions: "First instructions.",
      },
      {
        agent_id: "two",
        agent_pubkey: second,
        agent_name: "Other",
        status: 2,
        agent_instructions: "Second instructions.",
      },
    ],
  }),
});
beforeEach(() =>
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example"),
);
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});
function fixture() {
  let subject = "account-a";
  const session = createOAuthSession(async () => ({
    value: "credential",
    account: { subject, email: "a@example.com" },
  }));
  const request = vi.fn<Host["request"]>().mockResolvedValue(response());
  const client = createAgentClient({ request, runCommand: vi.fn() }, session);
  const Tab = builderlabType(client, session).tabs?.[0]?.component;
  if (!Tab) throw new Error("Missing Instructions tab");
  return {
    Tab,
    request,
    changeAccount: () => {
      subject = "account-b";
      session.signOut();
    },
  };
}
it("retries a failed load and refuses to save a draft through another account", async () => {
  const h = fixture();
  const user = userEvent.setup();
  h.request.mockRejectedValueOnce(new Error("offline"));
  render(<h.Tab agent={agent()} save={vi.fn()} />, { wrapper: StrictMode });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not reach Builderlab",
  );
  await user.click(screen.getByRole("button", { name: "Retry" }));
  const field = await screen.findByRole("textbox", { name: "Instructions" });
  expect(field).toHaveValue("First instructions.");
  await user.type(field, "Changed.");
  await act(async () => h.changeAccount());
  const before = h.request.mock.calls.length;
  await user.click(screen.getByRole("button", { name: "Save instructions" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "account that loaded these instructions",
  );
  expect(h.request).toHaveBeenCalledTimes(before);
  expect(field).toHaveValue("First instructions.Changed.");
});
it("switching agents hides the old draft and ignores the switched-away read", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const mounted = render(<h.Tab agent={agent()} save={vi.fn()} />, {
    wrapper: StrictMode,
  });
  const field = await screen.findByRole("textbox", { name: "Instructions" });
  await user.type(field, "Unsaved.");
  const delayed = deferred<HostResponse>();
  h.request.mockReturnValueOnce(delayed.promise);
  try {
    mounted.rerender(<h.Tab agent={agent(second)} save={vi.fn()} />);
    await waitFor(() => expect(h.request).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading instructions",
    );
    expect(
      screen.queryByRole("textbox", { name: "Instructions" }),
    ).not.toBeInTheDocument();
    mounted.rerender(<h.Tab agent={agent()} save={vi.fn()} />);
    expect(
      await screen.findByRole("textbox", { name: "Instructions" }),
    ).toHaveValue("First instructions.");
  } finally {
    await act(async () => {
      delayed.resolve(response());
      await delayed.promise;
    });
  }
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(
    "First instructions.",
  );
});
