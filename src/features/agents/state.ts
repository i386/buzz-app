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
 * kept in localStorage into it. Agent keys are in localStorage only before
 * the first move, or when an earlier start could not use agent storage, so
 * they are the newer copy and replace what agent storage has. They leave
 * localStorage only once every one is saved; if agent storage cannot be read,
 * a copy fails, or this takes longer than `timeoutMs`, the app uses
 * localStorage until the next start. */
export async function loadAgentStorage(
  local: Storage = globalThis.localStorage,
  files: Native | undefined = isTauri() ? native : undefined,
  timeoutMs = 15_000,
): Promise<Storage> {
  if (!files) return local;
  let late = false;
  const move = async () => {
    const storage = fileBacked(
      new Map(Object.entries(await files.load())),
      files.set,
    );
    const moved: string[] = [];
    for (let index = 0; index < local.length; index++) {
      const key = local.key(index);
      if (key && isAgentKey(key)) moved.push(key);
    }
    for (const key of moved) {
      const value = local.getItem(key);
      if (value !== null && storage.getItem(key) !== value) {
        storage.setItem(key, value);
      }
    }
    await storage.saved();
    // Too late: the app already started with localStorage, which keeps them.
    if (late) throw new Error("Agent storage took too long");
    for (const key of moved) local.removeItem(key);
    loaded = storage;
    return storage;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      late = true;
      reject(new Error("Agent storage took too long"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([move(), timeout]);
  } catch (error) {
    console.error(
      "Agent storage could not be used; using this window's",
      error,
    );
    return local;
  } finally {
    clearTimeout(timer);
  }
}

type FileBacked = Storage & {
  /** Settles once `key`'s value, or without a key every value, is saved;
   * rejects while the last write of one failed. */
  saved(key?: string): Promise<void>;
};

/** A Storage held in memory and saved through `save`, one key at a time. A
 * failed write puts back the key's saved value, so the copy never holds what
 * is not saved and the same value can be set again. */
export function fileBacked(
  items: Map<string, string>,
  save: Native["set"],
): FileBacked {
  /** What each key's file holds, as far as this program saved it. */
  const durable = new Map(items);
  /** Each key's last write, until it is saved. */
  const pending = new Map<string, Promise<void>>();
  let queue: Promise<void> = Promise.resolve();
  const write = (key: string, value: string | null) => {
    const next = queue.then(() => save(key, value));
    pending.set(key, next);
    queue = next.then(
      () => {
        if (value === null) durable.delete(key);
        else durable.set(key, value);
        if (pending.get(key) === next) pending.delete(key);
      },
      (error) => {
        console.error(`Agent state ${key} was not saved`, error);
        if (pending.get(key) !== next) return;
        const kept = durable.get(key);
        if (kept === undefined) items.delete(key);
        else items.set(key, kept);
      },
    );
  };
  return {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem(key, value) {
      items.set(key, String(value));
      write(key, String(value));
    },
    removeItem(key) {
      if (!items.delete(key)) return;
      write(key, null);
    },
    clear() {
      for (const key of [...items.keys()]) this.removeItem(key);
    },
    async saved(key) {
      // Writes settle in order, so after the queue each pending one is done.
      await queue;
      const failed =
        key === undefined ? [...pending.values()] : [pending.get(key)];
      await Promise.all(failed);
    },
  };
}
