import type { EventData } from "./events";

/** The message's signed `audience` tag names agents: coordination between
 * agents, which people see quietly and are not notified of. Any other value,
 * or none, is for everyone. */
export const agentAudience = (event: EventData) =>
  event.tags.some(([name, value]) => name === "audience" && value === "agents");
