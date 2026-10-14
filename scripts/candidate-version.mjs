import assert from "node:assert/strict";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const base = config.version.split("-")[0];
assert.match(base, /^\d+\.\d+\.\d+$/);
const {
  GITHUB_RUN_NUMBER: run,
  GITHUB_RUN_ATTEMPT: attempt,
  RUNNER_TEMP: temp,
  BUZZ_UPDATER_PUBLIC_KEY: pubkey,
  BUZZ_UPDATER_ENDPOINT: endpoint,
} = process.env;
assert.match(run ?? "", /^[1-9]\d*$/);
assert.match(attempt ?? "", /^[1-9]\d*$/);
const version = `${base}-preview.${run}.${attempt}`;
writeFileSync(
  join(temp, "candidate.json"),
  JSON.stringify({
    version,
    bundle: { createUpdaterArtifacts: false },
    // Matches build.rs: the updater is registered only when both are set.
    ...(pubkey && endpoint
      ? { plugins: { updater: { pubkey, endpoints: [endpoint] } } }
      : {}),
  }),
);
appendFileSync(process.env.GITHUB_ENV, `VERSION=${version}\n`);
