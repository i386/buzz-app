import { createNameProvider } from "./directory";
import { resolveIdentityNames } from "./policy";
import type { LocalAgents } from "../agents/local";
export const defaultNamingPolicy = {
  id: "human-first",
  resolve: resolveIdentityNames,
};
export function createAgentDirectory(control?: LocalAgents) {
  return createNameProvider(defaultNamingPolicy, control);
}
export const agentDirectory = createAgentDirectory();
