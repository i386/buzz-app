// The tools one agent session has, whatever harness runs it: the Buzz tools,
// and the attention tools when the owner has attention on. A harness lists
// `sessionTools` in its own tool format and passes each call to
// `callSessionTool`, so every harness offers and refuses them alike.
import type { AgentAttention } from "../features/agents/service";
import {
  ATTENTION_TOOLS,
  callAttentionTool,
  isAttentionTool,
} from "./attention";
import type { BuzzClient, Context } from "./client";
import { callTool, type Reply, TOOLS, type Tool } from "./tools";

/** The attention tool set for one session. `offered` decides the tool list,
 * which a session reads once, so it is fixed when the session starts; `api` is
 * the agent's attention once a delivery has given the session a handle. */
export type AttentionTools = Readonly<{
  offered: boolean;
  api?: AgentAttention;
}>;

/** The tools a session lists: the attention tools only when it is offered them. */
export const sessionTools = (attention?: boolean): readonly Tool[] =>
  attention ? [...TOOLS, ...ATTENTION_TOOLS] : TOOLS;

/** Answers one tool call. Throws when the tool cannot run now; the message
 * is for the agent. Without a client, Buzz tools cannot be called yet. */
export async function callSessionTool(
  client: BuzzClient | undefined,
  context: Context,
  name: string,
  args: Record<string, unknown>,
  attention?: AttentionTools,
): Promise<Reply> {
  if (attention?.offered && isAttentionTool(name)) {
    const api = attention.api;
    if (!api) throw new Error("Buzz is not ready yet. Try again.");
    // The owner can turn attention off while this session runs.
    if (!api.enabled())
      throw new Error(
        `Attention is off for you: your owner turned it off, so these tools do nothing now.\n(classifier: ${api.classifier()})`,
      );
    return callAttentionTool(api, name, args);
  }
  if (!client) throw new Error("Buzz is not ready yet. Try again.");
  return callTool(client, context, name, args);
}
