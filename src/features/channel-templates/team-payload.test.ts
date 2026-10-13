import { expect, it } from "vitest";
import { parseTextManifest, payloadCoordinate } from "./team-payload";
const owner = "ab".repeat(32);
const manifest = {
  version: 1 as const,
  owner,
  revision: "00000000-0000-4000-8000-000000000000",
  digest: "cd".repeat(32),
  bytes: 9,
  chunks: 1,
};

it("reads a text manifest of exactly its six fields", () => {
  expect(parseTextManifest(manifest)).toEqual(manifest);
  expect(() => parseTextManifest({ ...manifest, extra: 1 })).toThrow(
    "manifest",
  );
});
it("keys each payload chunk by community, owner, team, revision and index", () => {
  expect(
    payloadCoordinate({
      community: "https://relay.example",
      owner,
      teamId: "team",
      revision: manifest.revision,
      index: 2,
    }),
  ).toBe(
    `buzz-team-payload-v1:https%3A%2F%2Frelay.example:${owner}:team:${manifest.revision}:2`,
  );
});
