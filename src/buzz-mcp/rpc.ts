// The Buzz tools as an MCP server inside the host process: answers one
// JSON-RPC message at a time, as Claude sends them over its stream-json
// pipe to an in-process (`sdk`) server. Holds no state between messages.
import type { BuzzClient, Context } from "./client";
import {
  type AttentionTools,
  callSessionTool,
  sessionTools,
} from "./session-tools";
import type { Reply } from "./tools";

type Message = Readonly<{
  id?: string | number | null;
  method?: string;
  params?: Readonly<Record<string, unknown>>;
}>;

/** Answers `input`. Without a client, tools are listed but cannot be called.
 * Attention tools are listed only when `attention` offers them. */
export async function respond(
  client: BuzzClient | undefined,
  context: Context,
  input: unknown,
  attention?: AttentionTools,
) {
  const { id, method, params = {} } = (input ?? {}) as Message;
  // A notification needs no answer, but the pipe expects one.
  if (id === undefined || id === null)
    return { jsonrpc: "2.0", id: 0, result: {} };
  const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });
  switch (method) {
    case "initialize":
      return result({
        protocolVersion: params.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "buzz", version: "1" },
      });
    case "ping":
      return result({});
    case "tools/list":
      return result({
        tools: sessionTools(attention?.offered),
      });
    case "tools/call":
      try {
        const name = String(params.name);
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const reply = await callSessionTool(
          client,
          context,
          name,
          args,
          attention,
        );
        return result({ content: content(reply) });
      } catch (error) {
        return result({
          content: [{ type: "text", text: errorText(error) }],
          isError: true,
        });
      }
    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `No method ${String(method)}` },
      };
  }
}

/** A tool's answer as MCP content. */
export const content = (reply: Reply) =>
  typeof reply === "string"
    ? [{ type: "text" as const, text: reply }]
    : [{ type: "image" as const, data: reply.data, mimeType: reply.type }];

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
