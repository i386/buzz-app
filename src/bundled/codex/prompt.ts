import { BUZZ_PROMPT, coreMemory } from "../../buzz-mcp/prompt";
import type { AgentHandle } from "../../features/agents/service";
import type { EventData } from "../../features/relay/events";
import { threadReference } from "../../features/relay/thread-reference";
import type { Config } from "./config";
import basePrompt from "./base_prompt.md?raw";

export type Conversation = { channelId: string; name: string; root?: string };
const quoted = (value: unknown) =>
  JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
export const rootOf = (event: EventData) =>
  threadReference(event)?.rootId ?? event.id;
export function developerInstructions(
  agent: AgentHandle,
  settings?: Config,
  team = "",
  /** The agent's `core` memory: `null` when it has none, undefined if unread. */
  memory?: string | null,
) {
  const core = coreMemory(memory);
  return `You are ${agent.name} (pubkey ${agent.pubkey}), a coding agent in Buzz.
The buzz namespace provides the shared Buzz tools, including messages, reactions, reads, uploads, canvas, and encrypted memory. Buzz access and signing are handled by the host. Do not invoke the buzz CLI or look for credentials. Use Codex's native coding tools in the workspace.

${basePrompt.trim()}

${BUZZ_PROMPT}

${settings ? `Current Buzz custom instructions replace all prior Buzz custom instructions. An empty section means no custom instructions apply.\n<agent-instructions>\n${settings.instructions}\n</agent-instructions>\n\nCurrent team sections replace all prior team sections. None means you are on no team.${team ? `\n${team}` : ""}${core ? `\n\nCurrent core memory replaces all prior core memory.\n${core}` : ""}` : ""}`;
}

export function turnInput(
  event: EventData,
  conversation: Conversation,
  text: string,
  interest = "",
  steering = false,
) {
  const section = steering
    ? "new-message-arrived-while-you-were-working"
    : "buzz-event";
  return `<context>\n${quoted({ channel_id: conversation.channelId, channel_name: conversation.name, session_scope: conversation.root ? "thread" : "channel", session_thread: conversation.root, reply_to: rootOf(event) })}\n</context>\n<${section}>\n${quoted(event)}\nRequest: ${quoted(text)}\n</${section}>${interest ? `\n<interest>\n${quoted(interest)}\n</interest>` : ""}`;
}
/** The readable part of a conversation's thread name; earlier versions used
 * it alone. */
export function sessionTitle(agentName: string, conversation: Conversation) {
  return `Buzz #${conversation.name.replace(/\s+/g, " ").slice(0, 100)}${conversation.root ? ` · thread ${conversation.root.slice(0, 8)}` : ""} · ${agentName}`;
}
/** Names the agent's conversation in its thread names, so its threads can be
 * found from any build of the app, each of which saves its own bindings. A
 * 64-bit FNV-1a hash: stable and synchronous, so naming a thread does not
 * reorder concurrent turn starts. */
export function sessionTag(
  agentPubkey: string,
  conversation: Pick<Conversation, "channelId" | "root">,
) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(
    JSON.stringify([
      agentPubkey,
      conversation.channelId,
      conversation.root ?? "channel",
    ]),
  ))
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `buzz:${hash.toString(16).padStart(16, "0")}`;
}
export function sessionName(agent: AgentHandle, conversation: Conversation) {
  return `${sessionTitle(agent.name, conversation)} · ${sessionTag(agent.pubkey, conversation)}`;
}
