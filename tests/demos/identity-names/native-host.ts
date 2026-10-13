// Demo-only host boundary: the local agent list the naming demo models. No
// processes or saved user data.
import type { LocalAgentsSnapshot } from "../../../src/features/agents/local";
export function createLocalAgents() {
  let state: LocalAgentsSnapshot = new URL(location.href).searchParams.has(
    "library",
  )
    ? { status: "unavailable", agents: [] }
    : { status: "loading", agents: [] };
  const listeners = new Set<() => void>();
  if (state.status === "loading")
    void fetch("/demo/agents")
      .then((response) => response.json())
      .then((agents) => {
        state = { status: "ready", agents };
        for (const listener of [...listeners]) listener();
      });
  return {
    agents: {
      snapshot: () => state,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    bind: () => () => {},
  };
}
