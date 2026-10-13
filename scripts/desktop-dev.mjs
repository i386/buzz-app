import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { desktopOverlay, options } from "./desktop-config.mjs";
import { worktreePort } from "./worktree-port.mjs";

const args = process.argv.slice(2);
const { values, forwarded, rest } = options(args, ["port"]);
if (
  values.port !== undefined &&
  (!/^[0-9]+$/.test(values.port) ||
    Number(values.port) < 1 ||
    Number(values.port) > 65535)
) {
  console.error("--port must be an integer between 1 and 65535.");
  process.exit(1);
}
const port = values.port === undefined ? undefined : Number(values.port);

const help = forwarded.some((arg) => arg === "--help" || arg === "-h");
const root = fileURLToPath(new URL("../", import.meta.url));
const config = desktopOverlay(root);
// Tauri's own --port controls its static-file server, not our Vite server.
// Without --port, each worktree derives its own stable port; vite.config.ts
// derives the same one, so devUrl and Vite's strict port cannot disagree.
const devPort = port ?? worktreePort(root);
config.build = {
  devUrl: `http://localhost:${devPort}`,
  beforeDevCommand: `pnpm dev:desktop --port ${devPort}`,
};
if (!help)
  console.log(
    `Desktop dev server on ${config.build.devUrl}` +
      (port === undefined
        ? " (derived from the worktree path; pass --port to override)"
        : ""),
  );
// Prepend: Tauri treats everything after a bare positional as runner args.
// Explicit user configs merge afterward and retain precedence.
forwarded.unshift("--config", JSON.stringify(config));
// Runner/application arguments after -- belong to Tauri, including any --port.
forwarded.push(...rest);
// Vite normally reads .env.local only in its own process. Give Rust the same
// effective public pin (including an explicit empty override), so native agent
// starts select the signer that the development frontend actually uses.
const viewer =
  loadEnv("development", process.cwd(), "BUZZ_DEV_VIEWER").BUZZ_DEV_VIEWER ??
  "";
const result = spawnSync("pnpm", ["tauri", "dev", ...forwarded], {
  stdio: "inherit",
  env: { ...process.env, BUZZ_DEV_VIEWER: viewer },
});
if (result.error) console.error(result.error.message);
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
