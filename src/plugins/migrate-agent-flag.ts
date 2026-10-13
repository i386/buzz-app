// TEMPORARY agents rename: remove after 2026-10-18 with the version-2 reader.
// Version 3 distinguishes new Agents preferences from the retired v1 plugin.
export function migrateAgentFlag(flags: Record<string, boolean>) {
  delete flags["buzz.agents"];
  const enabled = flags["buzz.agents2"];
  if (enabled !== undefined) flags["buzz.agents"] = enabled;
  delete flags["buzz.agents2"];
}
