// The app's agent storage (`agents/state`, see src-tauri agent_state.rs) as a
// Storage: one file per key, each replaced whole through a rename. Reads go to
// the files every time, so this host sees what the app saves while it runs.
// A key whose encoded name is too long is saved, as the app saves it, in a file
// named `~` and the key's SHA-256 that holds `{"key": …, "value": …}`.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const SAFE = /^[A-Za-z0-9._-]$/;
/** The longest file name macOS, Linux and Windows all allow, in bytes. */
const NAME_LIMIT = 255;
/** Starts the name of a file that holds its key. `encodeKey` never writes it. */
const HASHED = "~";

/** The file name for `key`, as the app names it. */
export function encodeKey(key: string) {
  let name = "";
  for (const byte of new TextEncoder().encode(key)) {
    const char = String.fromCharCode(byte);
    name += SAFE.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return name;
}

/** The key a file name holds, or undefined for a file that is not one. */
export function decodeKey(name: string) {
  if (!name || name.startsWith(".") || name.endsWith(".tmp")) return undefined;
  if (!/^(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+$/.test(name)) return undefined;
  try {
    return decodeURIComponent(name);
  } catch {
    return undefined;
  }
}

/** The file `key` is saved in, as the app names it. */
export function fileName(key: string) {
  const name = encodeKey(key);
  if (name.length <= NAME_LIMIT) return name;
  return HASHED + createHash("sha256").update(key).digest("hex");
}

export function stateStorage(dir: string): Storage {
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  /** The key and value a hashed file holds, if its key gives its name. */
  const hashed = (name: string) => {
    try {
      const saved = JSON.parse(read(name) ?? "null") as unknown;
      if (
        typeof saved === "object" &&
        saved !== null &&
        "key" in saved &&
        "value" in saved &&
        typeof saved.key === "string" &&
        typeof saved.value === "string" &&
        fileName(saved.key) === name
      )
        return { key: saved.key, value: saved.value };
    } catch {}
    return undefined;
  };
  const keys = () => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return names.flatMap(
      (name) =>
        (name.startsWith(HASHED) ? hashed(name)?.key : decodeKey(name)) ?? [],
    );
  };
  const remove = (key: string) =>
    rmSync(join(dir, fileName(key)), { force: true });
  return {
    get length() {
      return keys().length;
    },
    key: (index: number) => keys()[index] ?? null,
    getItem(key: string) {
      const name = fileName(key);
      if (!name.startsWith(HASHED)) return read(name) ?? null;
      const saved = hashed(name);
      return saved?.key === key ? saved.value : null;
    },
    setItem(key: string, value: string) {
      const name = fileName(key);
      const text = name.startsWith(HASHED)
        ? JSON.stringify({ key, value: String(value) })
        : String(value);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temporary = join(dir, `.${process.pid}.${Date.now()}.tmp`);
      writeFileSync(temporary, text, { mode: 0o600 });
      renameSync(temporary, join(dir, name));
    },
    removeItem: remove,
    clear() {
      for (const key of keys()) remove(key);
    },
  };
}
