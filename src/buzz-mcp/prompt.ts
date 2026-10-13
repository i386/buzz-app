// The Buzz system prompt every agent plugin starts from; each appends its
// harness's own instructions after it.
import buzzPrompt from "./prompt.md?raw";

export const BUZZ_PROMPT = buzzPrompt.trim();
