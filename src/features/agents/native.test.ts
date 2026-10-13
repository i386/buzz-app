import { invoke } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import { hasEventProof } from "../relay/events";
import { keypair, signed } from "../relay/testing";
import { nativeAgents } from "./native";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(),
}));

const native = nativeAgents();
if (!native) throw new Error("expected native agents under Tauri");
const agent = keypair();
const message = signed(agent, { kind: 9, content: "hi", tags: [["h", "c"]] });
const query = (response: unknown) => {
  vi.mocked(invoke).mockResolvedValueOnce(response);
  return native.query(agent.pubkey, [{ kinds: [9] }]);
};

it("admits the community's events through the relay verifier", async () => {
  const events = await query([JSON.parse(JSON.stringify(message))]);
  expect(events).toMatchObject([{ id: message.id, content: "hi" }]);
  expect(events.every(hasEventProof)).toBe(true);
  expect(invoke).toHaveBeenCalledWith("app_agent_query", {
    pubkey: agent.pubkey,
    filters: [{ kinds: [9] }],
  });
});

it.each([
  ["a forged signature", [{ ...message, sig: "0".repeat(128) }]],
  ["edited content", [{ ...message, content: "bye" }]],
  ["a malformed record", [{ ...message, tags: "h" }]],
  ["one bad event among good ones", [message, { ...message, kind: 7 }]],
  ["a non-array body", { events: [message] }],
])("rejects %s", async (_, response) => {
  await expect(query(response)).rejects.toThrow(
    /malformed or invalidly signed|not an event array/,
  );
});
