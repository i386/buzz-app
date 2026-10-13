export const TEAM_PAYLOAD_TAG = "buzz-team-payload-v1";
export const TEAM_MANIFEST_TAG = "buzz-channel-kit-v2";
export const TEAM_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const TEAM_CHUNK_BYTES = 16 * 1024;
export const TEAM_CHUNKS = TEAM_PAYLOAD_BYTES / TEAM_CHUNK_BYTES;
export interface TeamManifest {
  version: 1;
  owner: string;
  revision: string;
  digest: string;
  bytes: number;
  chunks: number;
}
export interface TeamPayload {
  version: 1;
  community: string;
  owner: string;
  teamId: string;
  revision: string;
  index: number;
  data: string;
}
const hexKey = /^[0-9a-f]{64}$/;
const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
const revision = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export function parseTeamManifest(raw: unknown): TeamManifest {
  const value = raw as TeamManifest | undefined;
  if (
    value?.version !== 1 ||
    !hexKey.test(value.owner) ||
    !revision.test(value.revision) ||
    !hexKey.test(value.digest) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > TEAM_PAYLOAD_BYTES ||
    value.chunks !== Math.ceil(value.bytes / TEAM_CHUNK_BYTES)
  )
    throw new Error("Invalid portable team manifest");
  return {
    version: 1,
    owner: value.owner,
    revision: value.revision,
    digest: value.digest,
    bytes: value.bytes,
    chunks: value.chunks,
  };
}
export function parseTeamPayload(raw: unknown, community: string): TeamPayload {
  const value = raw as TeamPayload | undefined;
  if (
    value?.version !== 1 ||
    value.community !== community ||
    !hexKey.test(value.owner) ||
    !identifier.test(value.teamId) ||
    !revision.test(value.revision) ||
    !Number.isSafeInteger(value.index) ||
    value.index < 0 ||
    value.index >= TEAM_CHUNKS ||
    typeof value.data !== "string" ||
    value.data.length > Math.ceil(TEAM_CHUNK_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value.data,
    )
  )
    throw new Error("Invalid portable team payload");
  return {
    version: 1,
    community,
    owner: value.owner,
    teamId: value.teamId,
    revision: value.revision,
    index: value.index,
    data: value.data,
  };
}
export function payloadCoordinate(
  value: Omit<TeamPayload, "data" | "version">,
) {
  return `${TEAM_PAYLOAD_TAG}:${encodeURIComponent(value.community)}:${value.owner}:${value.teamId}:${value.revision}:${value.index}`;
}
/** Team instructions travel as ASCII `v1:` plus their raw UTF-8 bytes. */
export const TEAM_TEXT_BYTES = 128 * 1024;
const TEXT_PREFIX = "v1:";
export function parseTextManifest(raw: unknown): TeamManifest {
  const manifest = parseTeamManifest(raw);
  if (
    // Exactly the six manifest fields, as native admission requires.
    Object.keys(raw as object).length !== 6 ||
    manifest.bytes < TEXT_PREFIX.length ||
    manifest.bytes > TEXT_PREFIX.length + TEAM_TEXT_BYTES
  )
    throw new Error("Invalid team instructions manifest");
  return manifest;
}
