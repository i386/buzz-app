// @vitest-environment node
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { expect, it, vi } from "vitest";
import type { BuzzClient } from "../buzz-mcp/client";
import { fromOwner, workflowOf } from "../features/agents/owner-attestation";
import { eventDto } from "../features/relay/events";
import { keypair, signed } from "../features/relay/testing";
import { agentReads } from "./reads";

const RELAY = "wss://relay.example";

function setup() {
  const relay = keypair(),
    owner = keypair(),
    sibling = keypair(),
    agent = keypair();
  const attestation = [
    "auth",
    owner.pubkey,
    "",
    bytesToHex(
      schnorr.sign(
        createHash("sha256")
          .update(`nostr:agent-auth:${sibling.pubkey}:`)
          .digest(),
        owner.secret,
      ),
    ),
  ];
  const profile = signed(sibling, {
    kind: 0,
    content: JSON.stringify({ name: "Sibling" }),
    tags: [attestation],
  });
  const query = vi.fn(async () => [profile]);
  const client = { pubkey: agent.pubkey, query } as unknown as BuzzClient;
  const mention = eventDto(
    signed(relay, {
      kind: 9,
      content: "@Agent workflow",
      tags: [
        ["h", "channel"],
        ["p", agent.pubkey],
        ["buzz:workflow", "true"],
        ["buzz:workflow-owner", sibling.pubkey],
        ["buzz:workflow-mention", agent.pubkey],
      ],
    }),
  );
  return { relay, owner, sibling, agent, client, query, mention };
}

it("accepts a workflow mention from the owner's attested agent, as the app does", async () => {
  const f = setup();
  const reads = agentReads(f.client, RELAY, async () => f.relay.pubkey);
  await vi.waitFor(() =>
    expect(reads.workflowAuthority()).toBe(f.relay.pubkey),
  );
  expect(
    await fromOwner(
      f.mention,
      f.owner.pubkey,
      workflowOf(reads, f.agent.pubkey),
    ),
  ).toBe(true);
  expect(f.query).toHaveBeenCalledWith([
    { kinds: [0], authors: [f.sibling.pubkey], limit: 1 },
  ]);
  expect(reads.name(f.sibling.pubkey, [])).toBe("Sibling");
});

it("ignores workflow mentions until the community gives its key, then asks again", async () => {
  const f = setup();
  const self = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(f.relay.pubkey);
  const reads = agentReads(f.client, RELAY, self);
  await vi.waitFor(() => expect(self).toHaveBeenCalledOnce());
  await Promise.resolve();
  expect(
    await fromOwner(
      f.mention,
      f.owner.pubkey,
      workflowOf(reads, f.agent.pubkey),
    ),
  ).toBe(false);
  await vi.waitFor(() =>
    expect(reads.workflowAuthority()).toBe(f.relay.pubkey),
  );
  expect(self).toHaveBeenCalledTimes(2);
});

it("does not trust a workflow message signed by another key", async () => {
  const f = setup();
  const reads = agentReads(f.client, RELAY, async () => keypair().pubkey);
  await vi.waitFor(() => expect(reads.workflowAuthority()).toBeDefined());
  expect(
    await fromOwner(
      f.mention,
      f.owner.pubkey,
      workflowOf(reads, f.agent.pubkey),
    ),
  ).toBe(false);
});
