// TEMPORARY agents rename: remove this module and its startup call after
// 2026-10-18, once the development users have upgraded. No runtime aliases.
import { STORAGE_KEY, TEAMS_KEY } from "./store";

export function migrateAgentStorage(storage: Storage) {
  for (const [oldKey, key] of [
    ["buzz.agents2.v1", STORAGE_KEY],
    ["buzz.agents2.teams.v1", TEAMS_KEY],
  ] as const) {
    const old = storage.getItem(oldKey);
    if (old === null) continue;
    const current = storage.getItem(key);
    // An interrupted copy can resume; conflicting data needs recovery, never
    // an implicit overwrite or merge of independently edited settings. Either
    // failure leaves the source for a later launch and must not stop startup:
    // this runs before the app can render any error.
    if (current !== null && current !== old) {
      console.error(
        `Cannot migrate ${oldKey}: ${key} already contains different data`,
      );
      continue;
    }
    try {
      if (current === null) storage.setItem(key, old);
      storage.removeItem(oldKey);
    } catch (error) {
      console.error(`Cannot migrate ${oldKey}`, error);
    }
  }
}
