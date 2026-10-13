import { expect, it } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { profileTarget } from "../profiles/target";
import { addressedMessage } from "./audience-address";

const rivet = "b".repeat(64);
const bob = "c".repeat(64);
const row = (content: string, attachmentSeams?: number[]) =>
  ({
    content,
    mentions: [rivet, bob],
    ...(attachmentSeams ? { attachmentSeams } : {}),
  }) as unknown as ChannelMessage;
const at = (pubkey: string, name: string) => ({
  text: `@${name}`,
  target: profileTarget(pubkey),
});

it("takes every leading mention as a recipient and shifts seams past them", () => {
  const { recipients, body } = addressedMessage(
    row("@Rivet, @Bob: run it", [3, 15]),
    [at(rivet, "Rivet"), { text: ", " }, at(bob, "Bob"), { text: ": run it" }],
  );
  expect(recipients).toEqual([rivet, bob]);
  expect(body.content).toBe("run it");
  expect(body.attachmentSeams).toEqual([1]);
});

it("keeps the line break and indentation after a leading mention", () => {
  const { recipients, body } = addressedMessage(row("@Rivet\n    code"), [
    at(rivet, "Rivet"),
    { text: "\n    code" },
  ]);
  expect(recipients).toEqual([rivet]);
  expect(body.content).toBe("\n    code");
});
