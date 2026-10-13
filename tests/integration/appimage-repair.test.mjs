import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

// Execute the production repair script. Only AppImage extraction/repacking is
// synthetic: this proves byte restoration and failure gates, not ELF/GUI behavior.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "buzz-appimage-repair-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["scripts", "tools"]) mkdirSync(join(root, name));
  copyFileSync(
    new URL("../../scripts/fix-appimage.sh", import.meta.url),
    join(root, "scripts/fix-appimage.sh"),
  );
  const extracted = join(root, "extracted");
  mkdirSync(join(extracted, "usr/lib"), { recursive: true });
  writeFileSync(join(extracted, "usr/lib/libwayland-client.so.0"), "fixture");
  writeFileSync(
    join(extracted, "AppRun.wrapped"),
    "GST_PLUGIN_SYSTEM_PATH_1_0",
  );
  mkdirSync(join(extracted, "usr/bin"));
  writeFileSync(join(extracted, "usr/bin/buzz-foundation"), "fixture app");
  const image = join(root, "fixture.AppImage");
  writeFileSync(
    image,
    '#!/bin/sh\nset -eu\ntest "$1" = --appimage-extract\ncp -a "$FIXTURE_EXTRACTED" squashfs-root\n',
    { mode: 0o755 },
  );
  // Exercise a spaced executable path even when the host Node path has none.
  const node = join(root, "tools/node with spaces");
  symlinkSync(process.execPath, node);
  writeFileSync(
    join(root, "tools/appimagetool"),
    `#!/bin/sh
exec "$FIXTURE_NODE" - "$@" <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.equal(process.argv[2], '--runtime-file');
assert.equal(process.argv[3], process.env.APPIMAGETOOL_RUNTIME_FILE);
fs.cpSync(process.argv[4], process.env.FIXTURE_REPACKED, { recursive: true });
NODE
`,
    { mode: 0o755 },
  );
  const repacked = join(root, "repacked");
  const run = () =>
    spawnSync("bash", [join(root, "scripts/fix-appimage.sh"), image], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${join(root, "tools")}:${dirname(process.execPath)}:${process.env.PATH}`,
        FIXTURE_NODE: node,
        FIXTURE_EXTRACTED: extracted,
        FIXTURE_REPACKED: repacked,
        APPIMAGETOOL_RUNTIME_FILE: join(root, "pinned-runtime"),
      },
    });
  return { extracted, repacked, run };
}

test("AppImage repair fixes libraries and installs the launch shim without an agent runtime", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    existsSync(join(f.repacked, "usr/lib/libwayland-client.so.0")),
    false,
  );
  assert.equal(
    readFileSync(join(f.repacked, "usr/bin/buzz-foundation.bin"), "utf8"),
    "fixture app",
  );
});

test("AppImage repair refuses a missing app executable before repack", (t) => {
  const f = fixture(t);
  rmSync(join(f.extracted, "usr/bin/buzz-foundation"));
  assert.notEqual(f.run().status, 0);
  assert.equal(existsSync(f.repacked), false);
});
