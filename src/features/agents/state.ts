// Agent storage: each agent's settings, the owner's teams, unfinished setups,
// and the sessions agent types save. In the desktop app it lives in the
// `agents/state` folder beside the agent identities, one file per key, so the
// standalone agent host (`buzz-agent-host`) reads and writes the same state.
// Elsewhere, as in a browser, it is this page's localStorage.
//
// Storage reads are synchronous, so the app reads every file once before it
// starts, and then keeps a copy in memory. Each write changes the copy at once
// and is then saved, in order, to its key's file. Another program's later
// writes reach this copy only when the app starts again.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { RECORD_PREFIX, STORAGE_KEY, TEAMS_KEY, UNFINISHED_KEY } from "./store";

/** The localStorage keys of agent state, moved into agent storage once. */
export function isAgentKey(key: string) {
  return (
    key === STORAGE_KEY ||
    key === TEAMS_KEY ||
    key === UNFINISHED_KEY ||
    key.startsWith(RECORD_PREFIX) ||
    // The sessions the bundled agent types save.
    key.startsWith("buzz.claude-code.sessions.") ||
    key.startsWith("buzz.codex.sessions.") ||
    // The device-wide defaults that blank agent settings inherit.
    key === "buzz.claude-code.provider-defaults.v1" ||
    key === "buzz.codex.provider-defaults.v1" ||
    // TEMPORARY agents rename: see migrate-storage.ts.
    key.startsWith("buzz.agents2.")
  );
}

let loaded: Storage | undefined;

/** Agent storage, once `loadAgentStorage` has read it; localStorage before
 * that, and outside the desktop app. */
export function agentStorage(): Storage {
  return loaded ?? globalThis.localStorage;
}

type Native = Readonly<{
  load(): Promise<Record<string, string>>;
  set(key: string, value: string | null): Promise<void>;
}>;

const native: Native = {
  load: () => invoke("app_agent_state_load"),
  set: (key, value) => invoke("app_agent_state_set", { key, value }),
};

/** Reads agent storage before the app starts. It moves agent state the app
 * kept in localStorage into it: each key it does not have yet. If agent storage
 * cannot be read, the app keeps using localStorage. */
export async function loadAgentStorage(
  local: Storage = globalThis.localStorage,
  files: Native | undefined = isTauri() ? native : undefined,
): Promise<Storage> {
  if (!files) return local;
  let items: Record<string, string>;
  try {
    items = await files.load();
  } catch (error) {
    console.error(
      "Agent storage could not be read; using this window's",
      error,
    );
    return local;
  }
  const storage = fileBacked(new Map(Object.entries(items)), files.set);
  const moved: string[] = [];
  for (let index = 0; index < local.length; index++) {
    const key = local.key(index);
    if (key && isAgentKey(key)) moved.push(key);
  }
  for (const key of moved) {
    const value = local.getItem(key);
    if (value === null) continue;
    try {
      if (storage.getItem(key) === null) {
        storage.setItem(key, value);
        await (storage as FileBacked).saved();
      }
      local.removeItem(key);
    } catch (error) {
      // Kept in localStorage, so the next start tries again.
      console.error(`Agent state ${key} could not be moved`, error);
    }
  }
  loaded = storage;
  return storage;
}

type FileBacked = Storage & {
  /** Settles when every write so far is saved; rejects if the last failed. */
  saved(): Promise<void>;
};

/** A Storage held in memory and saved through `save`, one key at a time. */
export function fileBacked(
  items: Map<string, string>,
  save: Native["set"],
): FileBacked {
  let queue: Promise<void> = Promise.resolve();
  const write = (key: string, value: string | null) => {
    const next = queue.then(() => save(key, value));
    queue = next.catch((error) => {
      console.error(`Agent state ${key} was not saved`, error);
    });
    return next;
  };
  let last: Promise<void> = Promise.resolve();
  return {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem(key, value) {
      items.set(key, String(value));
      last = write(key, String(value));
    },
    removeItem(key) {
      if (!items.delete(key)) return;
      last = write(key, null);
    },
    clear() {
      for (const key of [...items.keys()]) this.removeItem(key);
    },
    saved: () => last,
  };
}
