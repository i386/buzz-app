import { avatarSource } from "../src/shared/avatar-source.ts";
// Read-only display projection of installed Buzz 1.0 agents. Explicit legacy
// input remains supported for compatibility tests/import readers; never discover
// Classic stores or call loaders that migrate keys or write configuration.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 2000;
const HEX = /^[0-9a-f]{64}$/;
const failure = () =>
  new Error(
    "Could not read the current Buzz agent library. Open Buzz and retry; its saved library is left unchanged.",
  );
function text(value, max = 256) {
  if (typeof value !== "string" || value.length > max) throw failure();
  return value;
}
export function projectAgentLibrary(raw) {
  if (!Array.isArray(raw)) {
    if (
      raw?.version !== 1 ||
      !Array.isArray(raw.agents) ||
      raw.agents.length > MAX_ROWS
    )
      throw failure();
    // Parked identities are import candidates, not saved Buzz 1.0 agents.
    // Retained unconfigured custody can share a key with its configured setup.
    // Prefer that setup; equal-status records keep document order.
    const selected = new Map();
    for (const row of raw.agents) {
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        !HEX.test(text(row.pubkey, 64))
      )
        throw failure();
      const projected = {
        pubkey: row.pubkey,
        name: text(row.name),
        avatar_url: row.picture,
      };
      const previous = selected.get(row.pubkey);
      if (
        !previous ||
        (previous.configured === false && row.configured !== false)
      )
        selected.set(row.pubkey, { ...projected, configured: row.configured });
    }
    raw = [...selected.values()];
  }
  if (!Array.isArray(raw) || raw.length > MAX_ROWS) throw failure();
  const definitions = [],
    identities = [];
  const slugs = new Set(),
    keys = new Set();
  for (const row of raw) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw failure();
    const pubkey = text(row.pubkey, 64);
    const name = text(row.name);
    const avatar = avatarSource(row.avatar_url);
    const artwork = avatar ? { avatar } : {};
    if (!pubkey) {
      // Old to_definition_view skips keyless records without a slug.
      if (row.slug == null) continue;
      const id = text(row.slug);
      if (!id || slugs.has(id)) throw failure();
      slugs.add(id);
      if (row.is_active !== undefined && typeof row.is_active !== "boolean")
        throw failure();
      if (row.is_active === false) continue;
      definitions.push({
        id,
        ...artwork,
        name: row.display_name == null ? name : text(row.display_name),
      });
    } else {
      if (!HEX.test(pubkey) || keys.has(pubkey)) throw failure();
      keys.add(pubkey);
      const definitionId =
        row.persona_id == null ? undefined : text(row.persona_id);
      identities.push({
        pubkey,
        ...artwork,
        name,
        ...(definitionId ? { definitionId } : {}),
      });
    }
  }
  return { definitions, identities };
}
/**
 * Installed Buzz desktop's app-data directory, resolved the way Tauri does it
 * (the `dirs` crate): `Library/Application Support` on macOS; on Linux
 * `XDG_DATA_HOME` only when it is an absolute path, otherwise `~/.local/share`.
 * Other platforms return nothing: the live broker refuses them before this
 * reader could run, so guessing a path here would only mislead.
 */
export function installedBuzzDataDir(
  platform = process.platform,
  env = process.env,
  home = homedir(),
) {
  if (platform === "darwin")
    return join(home, "Library/Application Support/dev.local.buzz.foundation");
  if (platform === "linux") {
    const xdg = env.XDG_DATA_HOME;
    const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local/share");
    return join(base, "dev.local.buzz.foundation");
  }
  return undefined;
}
export async function readAgentLibrary(
  path = (() => {
    const dir = installedBuzzDataDir();
    return dir ? join(dir, "agent-controller/agents.json") : undefined;
  })(),
) {
  if (!path) throw failure();
  let file;
  const buffer = Buffer.alloc(MAX_BYTES + 1);
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw failure();
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        size,
        buffer.length - size,
        size,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw failure();
    // No raw contents or parser errors escape this host-only function.
    return projectAgentLibrary(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, size),
        ),
      ),
    );
  } catch {
    throw failure();
  } finally {
    buffer.fill(0);
    await file?.close();
  }
}
