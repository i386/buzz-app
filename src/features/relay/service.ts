import type { LocalAgentSource } from "../agents/local-activity";
import { readView } from "../../shared/view-state";
import type { LocalAgents } from "../agents/local";
import type { IdentityNames } from "../identity-names/service";
import type { PresenceActivity } from "../presence/activity";
import type { Context } from "@deepseek-ai/cordis";
import { createRelaySession, type RelaySession } from "./session";
import { createHeadPersistence } from "./persistence";
import {
  relayPartition,
  transportOrigin,
  transportPartition,
} from "./partition";
import { ReadError, readErrorKind } from "./errors";
import type { ReadTransport } from "./transport";

export type RelaySnapshot = Readonly<{
  status: "disconnected" | "connecting" | "ready" | "error";
  generation: number;
  /** The persistence partition, `origin:viewer`. */
  scope?: string;
  /** The community's normalized origin, as `scope` was built from. */
  origin?: string;
  session: RelaySession;
  viewer?: string;
  error?: string;
  /** A usable device snapshot while the real transport is connecting/unavailable. */
  cached?: true;
  /** Only local disk bootstrap is pending; never waits for the network. */
  restoring?: true;
}>;
export type RelayData = {
  snapshot(): RelaySnapshot;
  subscribe(listener: () => void): () => void;
  retry(): void;
  disconnect(): void;
  clearCache(): Promise<void>;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    relay: RelayData;
  }
}

/** App-owned session. Plugins receive read models, never a signer or transport.
 * Reconnection replaces the session and invalidates all old async work. */
export function provideRelay(
  ctx: Context,
  connect?: (signal: AbortSignal) => Promise<ReadTransport>,
  presenceActivity?: PresenceActivity,
  identityNames?: IdentityNames,
  agentChoices?: LocalAgents,
  resume?: { viewer: string; scope: string },
  localAgents?: LocalAgentSource,
) {
  let disposed = false;
  let generation = 0;
  let controller: AbortController | undefined;
  let connecting = false;
  let clearing: Promise<void> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let store = createRelaySession(null, { identityNames });
  let snapshot: RelaySnapshot = Object.freeze({
    status: "disconnected",
    generation,
    session: store.session,
  });
  const listeners = new Set<() => void>();
  const publish = (next: RelaySnapshot) => {
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  const reset = () => {
    generation++;
    connecting = false;
    controller?.abort();
    clearTimeout(deadline);
    store.dispose();
    store = createRelaySession(null, { identityNames });
  };
  async function restoreLocal(current: number, signal: AbortSignal) {
    if (!resume) return;
    const persistence = createHeadPersistence(resume.viewer, resume.scope);
    let cached: ReturnType<typeof createRelaySession> | undefined;
    let handedOff = false;
    try {
      const saved = (await persistence.readStartup?.())?.discovery;
      if (
        !saved ||
        !/^[0-9a-f]{64}$/.test(saved.relayAuthor) ||
        disposed ||
        current !== generation ||
        signal.aborted
      )
        return;
      cached = createRelaySession(
        {
          viewer: resume.viewer,
          scope: resume.scope,
          relayAuthor: saved.relayAuthor,
          query: () =>
            Promise.reject(
              new ReadError(
                "unavailable",
                "Reconnect to update saved conversations.",
              ),
            ),
          media: () => undefined,
        },
        {
          identityNames,
          prepared: true,
          cachedOnly: true,
          persistence,
          initialChannelId: readView<string | undefined>(
            relayPartition(resume.scope, resume.viewer),
            "selected-channel",
            undefined,
          ),
        },
      );
      await cached.restore();
      if (
        disposed ||
        current !== generation ||
        signal.aborted ||
        !cached.session.channels.list().channels.length
      )
        return;
      store.dispose();
      store = cached;
      cached = undefined;
      handedOff = true;
      publish({
        status: connecting ? "connecting" : "error",
        cached: true,
        generation,
        viewer: resume.viewer,
        origin: resume.scope,
        scope: relayPartition(resume.scope, resume.viewer),
        session: store.session,
      });
    } catch {
      // Resume is an optimization; connection can still open an empty/corrupt cache.
    } finally {
      cached?.dispose();
      if (!handedOff) persistence.close();
      if (
        !disposed &&
        current === generation &&
        signal === controller?.signal &&
        snapshot.restoring
      ) {
        const { restoring: _restoring, ...settled } = snapshot;
        publish(settled);
      }
    }
  }
  const service: RelayData = {
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry() {
      if (disposed || !connect || connecting || clearing) return;
      const retained = snapshot.cached;
      if (!retained) reset();
      connecting = true;
      const current = generation;
      controller = new AbortController();
      const signal = controller.signal;
      if (!retained)
        publish({
          status: "connecting",
          generation,
          session: store.session,
          ...(resume ? { restoring: true as const } : {}),
        });
      else {
        const { error: _error, ...retainedSnapshot } = snapshot;
        publish({ ...retainedSnapshot, status: "connecting" });
      }
      const restoring = retained
        ? Promise.resolve()
        : restoreLocal(current, signal);
      const timer = setTimeout(() => {
        if (disposed || current !== generation || signal !== controller?.signal)
          return;
        controller.abort();
        connecting = false;
        publish({
          ...snapshot,
          status: "error",
          error: "Relay connection timed out. Try again.",
        });
      }, 8_000);
      deadline = timer;
      void Promise.resolve()
        .then(() => connect(signal))
        .then(async (transport) => {
          clearTimeout(timer);
          await restoring;
          if (
            disposed ||
            signal.aborted ||
            current !== generation ||
            signal !== controller?.signal
          )
            return;
          const successor = createRelaySession(transport, {
            identityNames,
            agentChoices,
            localAgents,
            ...(presenceActivity ? { presenceActivity } : {}),
            prepared: true,
            // Keep intent preparation, but do not fetch every unopened channel.
            warm: false,
            initialChannelId: readView<string | undefined>(
              transportPartition(transport),
              "selected-channel",
              undefined,
            ),
            persistence: createHeadPersistence(
              transport.viewer,
              transportOrigin(transport),
            ),
          });
          await successor.restore();
          if (
            disposed ||
            signal.aborted ||
            current !== generation ||
            signal !== controller?.signal
          ) {
            successor.dispose();
            return;
          }
          // Materialize retained readers before publishing so React never sees
          // an idle window between two already-hydrated owners.
          for (const id of store.retainedChannels())
            successor.session.channels.ensure(id);
          store.dispose();
          store = successor;
          publish({
            status: "ready",
            generation,
            viewer: transport.viewer,
            origin: transportOrigin(transport),
            scope: transportPartition(transport),
            session: store.session,
          });
          store.session.channels.ensureList();
        })
        .catch(async (error) => {
          await restoring;
          if (
            disposed ||
            signal.aborted ||
            current !== generation ||
            signal !== controller?.signal
          )
            return;
          if (readErrorKind(error) === "denied") {
            await store.clearCache();
            if (resume) {
              const disk = createHeadPersistence(resume.viewer, resume.scope);
              try {
                await disk.clear();
              } catch {
                /* Storage can be unavailable. */
              } finally {
                disk.close();
              }
            }
            if (
              disposed ||
              signal.aborted ||
              current !== generation ||
              signal !== controller?.signal
            )
              return;
            store.dispose();
            store = createRelaySession(null, { identityNames });
            publish({
              status: "error",
              generation,
              session: store.session,
              error: String(error),
            });
          } else
            publish({
              ...snapshot,
              status: "error",
              error: String(error),
            });
        })
        .finally(() => {
          clearTimeout(timer);
          if (current === generation && signal === controller?.signal)
            connecting = false;
        });
    },
    disconnect() {
      if (disposed) return;
      reset();
      publish({ status: "disconnected", generation, session: store.session });
    },
    clearCache() {
      if (clearing) return clearing;
      if (disposed) return Promise.resolve();
      // Clearing owns a separate fence: an aborted connection's finally cannot
      // release it and let retry restore records still being deleted from disk.
      const current = generation;
      const reconnect = connecting || snapshot.cached;
      const retainedStore = store;
      controller?.abort();
      clearTimeout(deadline);
      connecting = false;
      clearing = Promise.resolve()
        .then(async () => {
          await retainedStore.clearCache();
          if (resume) {
            const disk = createHeadPersistence(resume.viewer, resume.scope);
            try {
              await disk.clear();
            } catch {
              /* Storage can be unavailable. */
            } finally {
              disk.close();
            }
          }
        })
        .finally(() => {
          clearing = undefined;
          if (!disposed && current === generation && reconnect) service.retry();
        });
      return clearing;
    },
  };
  ctx.provide("relay", service);
  ctx.effect(() => {
    const online = () => {
      if (snapshot.cached) service.retry();
    };
    const visible = () => {
      if (document.visibilityState !== "visible") return;
      if (snapshot.cached) service.retry();
      else store.session.channels.refreshList?.();
    };
    if (typeof window !== "undefined")
      window.addEventListener("online", online);
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      reset();
      listeners.clear();
      if (typeof window !== "undefined")
        window.removeEventListener("online", online);
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", visible);
    };
  });
  service.retry();
  return service;
}
