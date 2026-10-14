// @vitest-environment node
// Optional interoperability check against the installed Goose binary. A local
// gateway records its real tool payload, auth retry, replay, and history. It
// speaks Chat Completions; the Responses route Buzz writes is checked live.
import { spawn as spawnChild } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { respond } from "../../buzz-mcp/rpc";
import { GooseProcess, type Spawn } from "./goose";

const BIN = process.env.GOOSE_ACP_BIN;

describe.skipIf(!BIN)("shared-provider command auth with real Goose", () => {
  it("calls Buzz tools, refreshes rejected auth in a warm session, and exports history", {
    timeout: 60_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "buzz-goose-provider-"));
    const auth: string[] = [];
    const payloads: Record<string, unknown>[] = [];
    const sends: unknown[] = [];
    let expected = "Bearer first-access";
    let calls = 0;
    const server = createServer(async (req, res) => {
      if (req.method === "GET") {
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(
            JSON.stringify({ data: [{ id: "served-gpt", object: "model" }] }),
          );
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      auth.push(req.headers.authorization ?? "");
      if (req.headers.authorization !== expected) {
        res.writeHead(401).end('{"error":{"message":"expired"}}');
        return;
      }
      const data = JSON.parse(raw);
      payloads.push(data);
      const last = data.messages.at(-1);
      const tool = last.role !== "tool";
      const delta = tool
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call-${++calls}`,
                type: "function",
                function: {
                  name: "buzz__send",
                  arguments: JSON.stringify({
                    text: "Provider fixture reply",
                    final: true,
                  }),
                },
              },
            ],
          }
        : { role: "assistant", content: "Done." };
      const chunk = (delta: object, finish_reason: string | null) =>
        JSON.stringify({
          id: "completion",
          object: "chat.completion.chunk",
          created: 1,
          model: "served-gpt",
          choices: [{ index: 0, delta, finish_reason }],
        });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        `data: ${chunk(delta, null)}\n\ndata: ${chunk({}, tool ? "tool_calls" : "stop")}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No fixture address");
    const token = join(root, "access.txt");
    const helper = join(root, "token.mjs");
    await writeFile(token, "first-access");
    await writeFile(
      helper,
      'import { readFileSync } from "node:fs"; process.stdout.write(readFileSync(process.argv[2], "utf8"));',
    );
    await mkdir(join(root, "config/custom_providers"), { recursive: true });
    await writeFile(
      join(root, "config/custom_providers/buzz_databricks.json"),
      JSON.stringify({
        name: "buzz_databricks",
        engine: "openai",
        display_name: "Databricks in Buzz",
        base_url: `http://127.0.0.1:${address.port}/ai-gateway/mlflow/v1/chat/completions`,
        models: [{ name: "served-gpt" }],
        supports_streaming: true,
        dynamic_models: false,
        auth: {
          command: process.execPath,
          args: [helper, token],
          refresh_interval: 30,
          timeout_seconds: 45,
        },
      }),
    );
    const spawn: Spawn = async (_id, options = {}) => {
      const env: Record<string, string | undefined> = { ...process.env };
      for (const [key, value] of Object.entries(options.env ?? {}))
        if (value === null) delete env[key];
        else env[key] = value;
      const child = spawnChild(BIN ?? "goose-acp", [], {
        cwd: options.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdout
        .setEncoding("utf8")
        .on("data", (data) => options.onStdout?.(data));
      child.stderr
        .setEncoding("utf8")
        .on("data", (data) => options.onStderr?.(data));
      const exited = new Promise<number | null>((resolve) =>
        child.on("exit", resolve),
      );
      return {
        write: (data) =>
          new Promise<void>((resolve, reject) =>
            child.stdin.write(data, (error) =>
              error ? reject(error) : resolve(),
            ),
          ),
        end: async (data) => {
          child.stdin.end(data);
        },
        kill: async () => {
          child.kill();
          await exited;
        },
        exited,
      };
    };
    let goose: GooseProcess | undefined;
    try {
      goose = await GooseProcess.start(spawn, {
        cwd: root,
        env: {
          GOOSE_PATH_ROOT: root,
          GOOSE_PROVIDER: "buzz_databricks",
          GOOSE_MODEL: "served-gpt",
          OPENAI_API_KEY: null,
          DATABRICKS_TOKEN: null,
        },
        tools: async (_conversation, message) => {
          if (message.method !== "tools/call")
            return respond(undefined, {}, message);
          sends.push(message.params);
          return {
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: "Sent." }] },
          };
        },
      });
      const session = await goose.open({
        cwd: root,
        systemPrompt: "Use the Buzz send tool to reply.",
      });
      expect(await session.send("First turn")).toEqual({ ok: true });
      expect(sends).toHaveLength(1);
      expected = "Bearer second-access";
      await writeFile(token, "second-access");
      expect(await session.send("Second turn")).toEqual({ ok: true });
      expect(sends).toHaveLength(2);
      expect(auth).toContain("Bearer first-access");
      expect(auth).toContain("Bearer second-access");
      expect(payloads[0]?.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            function: expect.objectContaining({ name: "buzz__send" }),
          }),
        ]),
      );
      // History reads must still work after stopping the agent and signing out.
      const sessionId = session.id;
      await goose.kill();
      await rm(token);
      goose = await GooseProcess.start(spawn, {
        cwd: root,
        env: { GOOSE_PATH_ROOT: root, GOOSE_PROVIDER: null, GOOSE_MODEL: null },
        tools: async () => {
          throw new Error("History needs no tools");
        },
      });
      const exported = (await goose.request("_goose/unstable/session/export", {
        sessionId,
        format: "json",
      })) as { data: string };
      expect(exported.data).toContain("First turn");
      expect(exported.data).toContain("Second turn");
    } finally {
      await goose?.kill();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
