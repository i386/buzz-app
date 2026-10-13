// Browser-only native boundary and controllable plugin. Production service,
// composition, admission, activity projection and UI are unchanged.
import type {
  AgentsNative,
  AgentIdentity,
} from "../../src/features/agents/native";
import type { BundledPlugin } from "../../src/plugins/manager";
import type { WorkOutcome } from "../../src/features/agents/local-activity";

export const localAgentKey = "b".repeat(64);
let identities: AgentIdentity[] = [];
const pending: {
  id: string;
  handover(): void;
  step(tool: string, target?: string): void;
  finish(result: WorkOutcome): void;
}[] = [];
const controls = {
  pending: () => pending.map((row) => row.id),
  /** Hands over and, like a real harness, reports a first step. */
  handover(id: string) {
    const row = pending.find((row) => row.id === id);
    if (!row) throw new Error("No pending request");
    row.handover();
    row.step("Read", "notes.txt");
  },
  finish(id: string, ok: boolean) {
    const row = pending.find((row) => row.id === id);
    if (!row) throw new Error("No pending request");
    row.handover();
    row.finish(
      ok ? { ok: true } : { ok: false, error: "Fixture provider unavailable" },
    );
  },
};
declare global {
  interface Window {
    localAgentFixture: typeof controls;
  }
}
window.localAgentFixture = controls;
export function localAgentsNative(): AgentsNative {
  const unsupported = async (): Promise<never> => {
    throw new Error("Unexpected native write in local activity fixture");
  };
  return {
    list: async () => identities,
    create: async (relay, owner, type, name) => {
      const identity = {
        pubkey: localAgentKey,
        relay,
        owner,
        type,
        name,
        deleted: false,
      };
      identities = [identity];
      return identity;
    },
    portable: unsupported,
    port: unsupported,
    setPicture: unsupported,
    media: unsupported,
    rename: unsupported,
    remove: unsupported,
    forget: unsupported,
    publish: async (pubkey, event) => ({
      ...event,
      tags: event.tags?.map((tag) => [...tag]) ?? [],
      pubkey,
      id: crypto.randomUUID(),
      sig: "",
      created_at: Math.floor(Date.now() / 1000),
    }),
    query: async () => [],
    upload: unsupported,
    remember: unsupported,
    publishProfile: async () => {},
    claim: async () => true,
    release: async () => {},
  };
}
export const localAgentPlugin: BundledPlugin = {
  manifest: { id: "fixture.local-agent", name: "Local agent", apiVersion: 1 },
  enabledByDefault: true,
  module: {
    inject: ["agents", "relay"],
    apply(ctx) {
      ctx.agents.register({
        id: "tester",
        title: "Local tester",
        defaults: () => ({ config: {} }),
        run(delivery) {
          if (delivery.trigger.type !== "mention")
            throw new Error("Unexpected trigger");
          let handover!: () => void, finish!: (result: WorkOutcome) => void;
          const done = new Promise<WorkOutcome>((resolve) => {
            finish = resolve;
          });
          delivery.workingUntil?.(done);
          const transferred = new Promise<void>((resolve) => {
            handover = resolve;
          });
          pending.push({
            id: delivery.trigger.event.id,
            handover,
            step: (tool, target) => delivery.step?.(tool, target),
            finish,
          });
          return transferred;
        },
      });
      let creating = false;
      const ensure = () => {
        if (
          creating ||
          ctx.relay.snapshot().status !== "ready" ||
          ctx.agents.snapshot().status !== "ready" ||
          ctx.agents.find(localAgentKey)
        )
          return;
        creating = true;
        queueMicrotask(() => {
          void ctx.agents.create({
            type: "fixture.local-agent/tester",
            name: "Local tester",
          });
        });
      };
      const stopRelay = ctx.relay.subscribe(ensure),
        stopAgents = ctx.agents.subscribe(ensure);
      ensure();
      ctx.effect(() => () => {
        stopRelay();
        stopAgents();
        for (const row of pending) {
          row.handover();
          row.finish({ ok: true });
        }
      });
    },
  },
};
