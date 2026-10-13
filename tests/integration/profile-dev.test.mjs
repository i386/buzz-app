import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { fork } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  configuredRelay,
  failureReport,
  inspectorClient,
  loadScenario,
  normalizeWebViteArgs,
  runScenario,
  safeUrl,
  takeScenario,
  viteListenerUrl,
  viteReadyToken,
} from "../../scripts/profile-dev.mjs";

test("web profiling canonicalizes its Vite port and strict-port contract", () => {
  assert.deepEqual(
    normalizeWebViteArgs(["--host", "127.0.0.1", "--port=1431"]),
    {
      port: 1431,
      mode: "development",
      args: ["--host", "127.0.0.1", "--port", "1431", "--strictPort"],
    },
  );
  assert.throws(
    () => normalizeWebViteArgs(["--port", "1431", "--port", "1432"]),
    /only one --port/,
  );
  assert.throws(
    () => normalizeWebViteArgs(["--host"]),
    /requires --host 127\.0\.0\.1/,
  );
  assert.throws(
    () => normalizeWebViteArgs(["--host", "0.0.0.0"]),
    /requires --host 127\.0\.0\.1/,
  );
  assert.throws(
    () => normalizeWebViteArgs(["--host=::1"]),
    /requires --host 127\.0\.0\.1/,
  );
  assert.throws(
    () => normalizeWebViteArgs(["--no-strictPort"]),
    /requires --strictPort/,
  );
});

test("web profiling owns the Vite mode that selects its recorded relay", () => {
  for (const values of [
    ["--mode", "staging"],
    ["--mode=staging"],
    ["-m", "staging"],
    ["-m=staging"],
  ]) {
    const { mode, args } = normalizeWebViteArgs(values);
    assert.equal(mode, "staging");
    assert.deepEqual(args.slice(-2), ["--mode", "staging"]);
    assert.equal(args.filter((value) => /^-m|^--m/.test(value)).length, 1);
  }
  for (const values of [["--mode"], ["--mode="], ["-m"]])
    assert.throws(() => normalizeWebViteArgs(values), /requires a mode name/);
  assert.throws(
    () => normalizeWebViteArgs(["-m", "a", "--mode", "b"]),
    /only one --mode/,
  );
  // Spellings Vite would accept as a mode without the profiler seeing one.
  for (const values of [
    ["-dm", "staging"],
    ["--m", "staging"],
    ["--m=staging"],
  ])
    assert.throws(
      () => normalizeWebViteArgs(values),
      /requires the mode as --mode/,
    );
  assert.equal(normalizeWebViteArgs(["--force", "-d"]).mode, "development");
});

test("profiling takes one scenario file and leaves the other arguments", () => {
  for (const values of [
    ["--port", "1431", "--scenario", "open.mjs"],
    ["--scenario=open.mjs", "--port", "1431"],
  ])
    assert.deepEqual(takeScenario(values), {
      scenario: "open.mjs",
      args: ["--port", "1431"],
    });
  assert.deepEqual(takeScenario(["--port", "1431"]), {
    scenario: undefined,
    args: ["--port", "1431"],
  });
  for (const values of [["--scenario"], ["--scenario="]])
    assert.throws(() => takeScenario(values), /requires a scenario file/);
  assert.throws(
    () => takeScenario(["--scenario", "open.mjs", "--scenario=open.mjs"]),
    /only one --scenario/,
  );
});

test("a scenario file must default-export a function", async () => {
  const file = fileURLToPath(
    new URL("./fixtures/profile-web/scenario.mjs", import.meta.url),
  );
  const scenario = await loadScenario(file);
  assert.equal(scenario.file, file);
  assert.equal(typeof scenario.run, "function");
  await assert.rejects(
    loadScenario(fileURLToPath(import.meta.url)),
    /must default-export a function/,
  );
});

test("a scenario that never finishes is aborted and fails at the timeout", {
  timeout: 10_000,
}, async () => {
  let waiting;
  const { code, error } = await runScenario(
    {
      file: "stuck.mjs",
      run: (_page, { signal }) =>
        (waiting = pause(60_000, undefined, { signal })),
    },
    {},
    "unused",
    new AbortController().signal,
    1,
  );
  assert.equal(code, 1);
  assert.match(error.message, /did not finish within 0.001 seconds/);
  await assert.rejects(waiting, { name: "AbortError" });
});

test("the recorded relay is the validated origin of Vite's environment for its mode", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "buzz-profile-env-"));
  const original = process.env.BUZZ_RELAY_URL;
  const setProcess = (value) => {
    if (value === undefined) delete process.env.BUZZ_RELAY_URL;
    else process.env.BUZZ_RELAY_URL = value;
  };
  t.after(async () => {
    setProcess(original);
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    path.join(directory, ".env.staging"),
    "BUZZ_RELAY_URL=wss://staging.example\n",
  );
  const relay = async (file, environment, mode = "development") => {
    await writeFile(
      path.join(directory, ".env.local"),
      file === undefined ? "" : `BUZZ_RELAY_URL='${file}'\n`,
    );
    setProcess(environment);
    return await configuredRelay(mode, directory);
  };
  assert.equal(await relay(), null);
  assert.equal(await relay("wss://file.example/"), "https://file.example");
  assert.equal(
    await relay("wss://file.example", "wss://process.example"),
    "https://process.example",
  );
  // A mode's own file outranks .env.local; the process environment still wins.
  assert.equal(
    await relay("wss://file.example", undefined, "staging"),
    "https://staging.example",
  );
  assert.equal(
    await relay("wss://file.example", "wss://process.example", "staging"),
    "https://process.example",
  );
  assert.equal(
    await relay("wss://file.example", "wss://relay.example/secret", "staging"),
    null,
  );
  // A rejected value may carry a credential; neither source may record it.
  for (const rejected of [
    "wss://user:secret@relay.example",
    "wss://relay.example/?token=secret",
    "wss://relay.example/#secret",
    "wss://relay.example/secret",
    "ws://relay.example",
    "secret",
  ]) {
    assert.equal(await relay(rejected), null, rejected);
    assert.equal(await relay("wss://file.example", rejected), null, rejected);
  }
});

test("a wrapped failure reports its cause's stack", () => {
  const cause = new Error("step failed");
  assert.equal(
    failureReport(new Error("Scenario failed.", { cause })),
    `Scenario failed.\n${cause.stack}`,
  );
  assert.equal(failureReport(new Error("plain")), "plain");
  assert.equal(
    failureReport(new Error("cancelled", { cause: undefined })),
    "cancelled",
  );
});

test("web profiling derives navigation from its owned listener", () => {
  assert.equal(
    viteListenerUrl({ address: "127.0.0.1", port: 1430 }),
    "http://127.0.0.1:1430",
  );
  assert.throws(
    () => viteListenerUrl({ address: "::1", port: 1430 }),
    /required profiling host/,
  );
  assert.throws(
    () => viteListenerUrl({ address: "0.0.0.0", port: 1430 }),
    /required profiling host/,
  );
});

test("web profiling waits for its authenticated Vite listening marker", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const abort = new AbortController();
  const ready = viteReadyToken(child, "owned-token", abort.signal);

  child.stdout.emit(
    "data",
    'BUZZ_PROFILE_VITE_READY:other-token:{"address":"::1","port":1430}\n',
  );
  let settled = false;
  void ready.then(() => (settled = true));
  await Promise.resolve();
  assert.equal(settled, false);

  child.stderr.emit(
    "data",
    'BUZZ_PROFILE_VITE_READY:owned-token:{"address":"127.0.0.1","port":1430}\n',
  );
  assert.equal(await ready, "http://127.0.0.1:1430");
});

test("web profiling rejects Vite bind failure before readiness", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const ready = viteReadyToken(
    child,
    "owned-token",
    new AbortController().signal,
  );
  child.stderr.emit("data", "Error: Port 1430 is already in use\n");
  await assert.rejects(ready, /could not bind/);
});

test("network URLs redact opaque payloads and strip HTTP secrets", () => {
  assert.equal(safeUrl("data:text/plain,PRIVATE_BODY"), "data:<redacted>");
  assert.equal(
    safeUrl("https://user:password@example.com/path?q=secret#fragment"),
    "https://example.com/path",
  );
});

test("inspector requests reject after the transport closes", async () => {
  const original = globalThis.WebSocket;
  class ClosedSocket extends EventTarget {
    send() {}
    close() {
      this.dispatchEvent(new Event("close"));
    }
  }
  globalThis.WebSocket = ClosedSocket;
  try {
    const client = inspectorClient("ws://inspector.invalid");
    const request = client.send("Profiler.stop");
    await Promise.resolve();
    client.close();
    await assert.rejects(request, /Node inspector connection closed/);
    await assert.rejects(
      client.send("Profiler.stop"),
      /Node inspector connection closed/,
    );
  } finally {
    globalThis.WebSocket = original;
  }
});

async function webFixture(t, scenario) {
  const directory = await mkdtemp(path.join(tmpdir(), "buzz-profile-web-"));
  const fixtures = new URL("./fixtures/profile-web/", import.meta.url);
  for (const name of [
    "scripts",
    "node_modules/vite/bin",
    "node_modules/@playwright/test",
    "src/features/communities",
    "profiles",
  ])
    await mkdir(path.join(directory, name), { recursive: true });
  for (const file of [
    "scripts/profile-dev.mjs",
    "src/features/communities/destination.ts",
  ])
    await copyFile(
      new URL(`../../${file}`, import.meta.url),
      path.join(directory, file),
    );
  for (const [source, destination] of [
    ["driver.mjs", "driver.mjs"],
    ["vite.mjs", "node_modules/vite/bin/vite.js"],
    ["browser.mjs", "node_modules/@playwright/test/index.mjs"],
    ["scenario.mjs", "scenario.mjs"],
    ["waiting-scenario.mjs", "waiting-scenario.mjs"],
  ])
    await copyFile(
      new URL(source, fixtures),
      path.join(directory, destination),
    );
  await writeFile(
    path.join(directory, "node_modules/@playwright/test/package.json"),
    JSON.stringify({ type: "module", exports: "./index.mjs" }),
  );
  // Only the dev server is a stub; the profiler reads the relay the way the
  // real Vite does, from the documented .env.local setup.
  await writeFile(
    path.join(directory, "node_modules/vite/package.json"),
    JSON.stringify({ type: "module", exports: "./index.mjs" }),
  );
  await writeFile(
    path.join(directory, "node_modules/vite/index.mjs"),
    `export { loadEnv } from ${JSON.stringify(import.meta.resolve("vite"))};\n`,
  );
  await writeFile(
    path.join(directory, ".env.local"),
    "BUZZ_RELAY_URL=wss://relay.example\n",
  );
  await writeFile(
    path.join(directory, ".env.staging"),
    "BUZZ_RELAY_URL=wss://staging.example\n",
  );
  const child = fork(path.join(directory, "driver.mjs"), [], {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      BUZZ_TEST_SCENARIO: JSON.stringify(scenario),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages = [];
  const events = new EventEmitter();
  let log = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      log += chunk;
    });
  child.on("message", (message) => {
    messages.push(message);
    events.emit("message");
  });
  const exited = once(child, "exit");
  const wait = async (type) => {
    const signal = AbortSignal.timeout(10_000);
    while (!messages.some((message) => message.type === type)) {
      try {
        await once(events, "message", { signal });
      } catch (error) {
        throw new Error(
          `Missing ${type}: ${JSON.stringify(messages)}\n${log}`,
          { cause: error },
        );
      }
    }
    return messages.find((message) => message.type === type);
  };
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
    // Only the fixture-owned Vite group may need emergency cleanup on a failed assertion.
    const pid = Number(
      await readFile(path.join(directory, "vite.pid"), "utf8").catch(() => "0"),
    );
    if (pid) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { child, directory, messages, wait, exited, log: () => log };
}

for (const held of [
  "launch",
  "newPage",
  "newCDPSession",
  "Network.enable",
  "Performance.enable",
  "Performance.getMetrics",
  "evaluate",
  "Profiler.enable",
  "Profiler.setSamplingInterval",
  "Profiler.start",
  "startTracing",
  "goto",
]) {
  for (const late of ["resolve", "reject"]) {
    test(`web startup cancels held ${held} before late ${late}`, async (t) => {
      const fixture = await webFixture(t, {
        held,
        late,
        trace: held === "startTracing",
      });
      await fixture.wait("held");
      fixture.child.kill("SIGINT");
      // Cleanup must finish without releasing the stalled startup operation.
      const settled = await fixture.wait("settled");
      assert.match(settled.error, /stopped during startup/);
      if (held !== "launch") await fixture.wait("browserClosed");
      const pid = Number(
        await readFile(path.join(fixture.directory, "vite.pid"), "utf8"),
      );
      assert.throws(() => process.kill(-pid, 0), { code: "ESRCH" });
      const calls = fixture.messages.filter(({ type }) => type === "call");
      fixture.child.send("release");
      await fixture.wait("released");
      if (held === "launch" && late === "resolve")
        await fixture.wait("browserClosed");
      fixture.child.send("finish");
      assert.deepEqual(await fixture.exited, [1, null], fixture.log());
      assert.deepEqual(
        fixture.messages.filter(({ type }) => type === "call"),
        calls,
        "late completion resumed startup",
      );
      assert.equal(
        fixture.messages.some(({ type }) => type === "navigated"),
        false,
      );
      assert.doesNotMatch(
        fixture.log(),
        /Profile saved to|fixture late rejection/,
      );
    });
  }
}

for (const reject of ["launch", "newPage", "newCDPSession"]) {
  test(`web startup cleans up ${reject} rejection`, async (t) => {
    const fixture = await webFixture(t, { reject });
    const settled = await fixture.wait("settled");
    assert.match(settled.error, /stopped during startup/);
    assert.match(settled.cause, /fixture rejection/);
    if (reject !== "launch") await fixture.wait("browserClosed");
    fixture.child.send("finish");
    assert.deepEqual(await fixture.exited, [1, null], fixture.log());
    assert.equal(
      fixture.messages.some(({ type }) => type === "navigated"),
      false,
    );
  });
}

test("web capture still finalizes renderer, broker, and network artifacts on Ctrl-C", async (t) => {
  const fixture = await webFixture(t, {});
  await fixture.wait("capturing");
  fixture.child.kill("SIGINT");
  assert.equal((await fixture.wait("settled")).error, undefined);
  await fixture.wait("browserClosed");
  fixture.child.send("finish");
  assert.deepEqual(await fixture.exited, [0, null], fixture.log());
  assert.deepEqual(
    (await readdir(path.join(fixture.directory, "profiles"))).sort(),
    [
      "chromium-renderer.cpuprofile",
      "manifest.json",
      "network.json",
      "vite-broker.cpuprofile",
    ],
  );
  for (const name of ["chromium-renderer", "vite-broker"]) {
    const profile = JSON.parse(
      await readFile(
        path.join(fixture.directory, `profiles/${name}.cpuprofile`),
        "utf8",
      ),
    );
    assert.ok(profile.nodes.length > 0);
    assert.ok(profile.endTime >= profile.startTime);
  }
  assert.match(fixture.log(), /Profile saved to/);
});

test("traced web capture replaces the renderer profile with a DevTools trace", async (t) => {
  const fixture = await webFixture(t, { trace: true });
  await fixture.wait("capturing");
  fixture.child.kill("SIGINT");
  assert.equal((await fixture.wait("settled")).error, undefined);
  await fixture.wait("browserClosed");
  fixture.child.send("finish");
  assert.deepEqual(await fixture.exited, [0, null], fixture.log());
  const calls = fixture.messages
    .filter(({ type }) => type === "call")
    .map(({ name }) => name);
  assert.equal(calls.includes("Profiler.start"), false);
  assert.ok(calls.indexOf("stopTracing") > calls.indexOf("startTracing"));
  assert.deepEqual(
    (await readdir(path.join(fixture.directory, "profiles"))).sort(),
    [
      "chromium-trace.json",
      "manifest.json",
      "network.json",
      "vite-broker.cpuprofile",
    ],
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(
        path.join(fixture.directory, "profiles/chromium-trace.json"),
        "utf8",
      ),
    ),
    { traceEvents: [] },
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(
        path.join(fixture.directory, "profiles/manifest.json"),
        "utf8",
      ),
    ).coverage,
    ["chromium-trace", "vite-broker", "chromium-network"],
  );
});

const profileFiles = async (fixture) =>
  (await readdir(path.join(fixture.directory, "profiles"))).sort();

test("a scenario ends its own capture and saves the app's client metrics", async (t) => {
  const fixture = await webFixture(t, { scenario: "scenario.mjs" });
  assert.equal((await fixture.wait("settled")).error, undefined);
  await fixture.wait("browserClosed");
  fixture.child.send("finish");
  assert.deepEqual(await fixture.exited, [0, null], fixture.log());
  const calls = fixture.messages
    .filter(({ type }) => type === "call")
    .map(({ name }) => name);
  // The harness exports the metrics after the scenario and before stopping.
  assert.ok(calls.lastIndexOf("evaluate") > calls.indexOf("click"));
  assert.ok(calls.indexOf("Profiler.stop") > calls.lastIndexOf("evaluate"));
  assert.deepEqual(await profileFiles(fixture), [
    "chromium-renderer.cpuprofile",
    "client-metrics.json",
    "manifest.json",
    "network.json",
    "vite-broker.cpuprofile",
  ]);
  const manifest = JSON.parse(
    await readFile(
      path.join(fixture.directory, "profiles/manifest.json"),
      "utf8",
    ),
  );
  assert.equal(
    manifest.scenario,
    path.join(await realpath(fixture.directory), "scenario.mjs"),
  );
  assert.equal(manifest.relay, "https://relay.example");
  assert.ok(manifest.coverage.includes("client-metrics"));
});

test("a failed scenario step finalizes the capture without client metrics", async (t) => {
  const fixture = await webFixture(t, {
    scenario: "scenario.mjs",
    reject: "click",
  });
  const settled = await fixture.wait("settled");
  assert.ok(
    settled.error.startsWith("Scenario failed; artifacts remain at "),
    settled.error,
  );
  assert.ok(settled.error.endsWith("/profiles."), settled.error);
  assert.match(settled.cause, /fixture rejection/);
  await fixture.wait("browserClosed");
  fixture.child.send("finish");
  assert.deepEqual(await fixture.exited, [1, null], fixture.log());
  assert.deepEqual(await profileFiles(fixture), [
    "chromium-renderer.cpuprofile",
    "manifest.json",
    "network.json",
    "vite-broker.cpuprofile",
  ]);
});

test("Ctrl-C during a scenario saves the capture without client metrics", async (t) => {
  const fixture = await webFixture(t, {
    scenario: "scenario.mjs",
    held: "click",
    late: "resolve",
  });
  await fixture.wait("held");
  fixture.child.kill("SIGINT");
  assert.equal((await fixture.wait("settled")).error, undefined);
  await fixture.wait("browserClosed");
  // The interrupted scenario may still finish; it must not report completion.
  fixture.child.send("release");
  await fixture.wait("released");
  fixture.child.send("finish");
  assert.deepEqual(await fixture.exited, [0, null], fixture.log());
  assert.equal(
    (await profileFiles(fixture)).includes("client-metrics.json"),
    false,
  );
});

test("a timed-out scenario is aborted so the process can exit", {
  timeout: 30_000,
}, async (t) => {
  const fixture = await webFixture(t, {
    scenario: "waiting-scenario.mjs",
    scenarioTimeoutMs: 50,
  });
  const settled = await fixture.wait("settled");
  assert.match(settled.error, /^Scenario failed; artifacts remain at /);
  assert.match(settled.cause, /did not finish within 0.05 seconds/);
  await fixture.wait("scenarioAborted");
  await fixture.wait("browserClosed");
  fixture.child.send("finish");
  // The scenario's pending timer would hold the process open if not aborted.
  assert.deepEqual(await fixture.exited, [1, null], fixture.log());
  assert.equal(
    (await profileFiles(fixture)).includes("client-metrics.json"),
    false,
  );
});

test("a scenario is aborted when Vite exits during the capture", {
  timeout: 30_000,
}, async (t) => {
  const fixture = await webFixture(t, { scenario: "waiting-scenario.mjs" });
  await fixture.wait("scenarioWaiting");
  const pid = Number(
    await readFile(path.join(fixture.directory, "vite.pid"), "utf8"),
  );
  process.kill(-pid, "SIGKILL");
  await fixture.wait("settled");
  await fixture.wait("scenarioAborted");
  await fixture.wait("browserClosed");
  fixture.child.send("finish");
  assert.deepEqual(await fixture.exited, [1, null], fixture.log());
});

test("a forwarded Vite mode selects the relay the manifest records", async (t) => {
  const fixture = await webFixture(t, {
    scenario: "scenario.mjs",
    args: ["-m", "staging"],
  });
  assert.equal((await fixture.wait("settled")).error, undefined);
  fixture.child.send("finish");
  assert.deepEqual(await fixture.exited, [0, null], fixture.log());
  const read = async (name) =>
    JSON.parse(await readFile(path.join(fixture.directory, name), "utf8"));
  assert.equal(
    (await read("profiles/manifest.json")).relay,
    "https://staging.example",
  );
  // Vite is launched in the same mode the manifest was resolved for, with the
  // dependency cache rebuilt as `pnpm dev` does.
  const viteArgs = await read("vite.args");
  assert.equal(viteArgs[0], "--force");
  assert.deepEqual(viteArgs.slice(-2), ["--mode", "staging"]);
});
