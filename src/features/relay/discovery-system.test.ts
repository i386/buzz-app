import { expect, it } from "vitest";
import { DiscoveryState } from "./discovery";
import type { RelayEvent } from "./events";
import { keypair, signed } from "./testing";

const systemChannel = (
  relay: ReturnType<typeof keypair>,
  id: string,
  member: string,
): [RelayEvent, RelayEvent] => [
  signed(relay, {
    kind: 39000,
    content: "",
    tags: [
      ["d", id],
      ["name", "For You records"],
      ["private"],
      ["hidden"],
      ["t", "system"],
      ["t", "for-you"],
    ],
  }),
  signed(relay, {
    kind: 39002,
    content: "",
    tags: [
      ["d", id],
      ["t", "system"],
      ["p", member],
    ],
  }),
];

it("reads a system channel by id but never lists it", () => {
  const viewer = keypair(),
    relay = keypair();
  const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
  for (const event of systemChannel(relay, "records", viewer.pubkey))
    state.accept(event);
  expect(state.get("records")).toMatchObject({
    id: "records",
    channelType: "system",
    labels: ["for-you"],
  });
  expect(state.channels()).toEqual([]);
});

it("keeps a system channel when a complete roster read omits it", () => {
  const viewer = keypair(),
    relay = keypair();
  const state = new DiscoveryState(viewer.pubkey, relay.pubkey);
  const [metadata, members] = systemChannel(relay, "records", viewer.pubkey);
  state.accept(metadata);
  state.accept(members);
  // The relay leaves system channels out of the `#p` roster read, so a
  // complete read without this roster proves nothing about access.
  state.retain(new Set(), new Map([["records", members]]));
  expect(state.get("records")?.channelType).toBe("system");
});
