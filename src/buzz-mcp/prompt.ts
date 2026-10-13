// The Buzz system prompt every agent plugin starts from; each appends its
// harness's own instructions after it.
import buzzPrompt from "./prompt.md?raw";

export const BUZZ_PROMPT = buzzPrompt.trim();

/** The agent's `core` memory as the section the prompt above promises: its
 * text, a prompt to create one when it is `null`, or nothing when it is unread
 * (`undefined`) or blank. */
export function coreMemory(memory: string | null | undefined) {
  const body =
    memory === null
      ? "No core memory found. Use `mem_set` with slug `core` to create one (it will hold your identity, rules, and goals across sessions). Ask your user about yourself."
      : memory?.trim();
  return body ? `<core-memory>\n${body.trim()}\n</core-memory>` : "";
}
