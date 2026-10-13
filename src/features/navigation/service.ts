import type { Context } from "@deepseek-ai/cordis";
import {
  createNavigationController,
  type Navigation,
  type OpenAttempt,
  type OpenResult,
  type NavigationFocus,
} from "./controller";
import { createBrowserHistory } from "./browser-history";
import { createMemoryHistory } from "./history";
import type { JsonValue, OpenTarget } from "./targets";
import type { RelayData, RelaySnapshot } from "../relay/service";

export type PageNavigation = Readonly<{
  entryId: string;
  target: OpenTarget;
  signal: AbortSignal;
  /** Suppress destination autofocus when the opening control retains focus. */
  focus?: NavigationFocus;
  /** Bind a domain subtree to the exact connection it renders, without another visit. */
  forSession(relay: RelayData, connection: RelaySnapshot): PageNavigation;
  /** Resolve the pending visit's default destination without replacing its caller. */
  resolve(target: OpenTarget): boolean;
  complete(
    result: Extract<OpenResult, { status: "opened" | "failed" }>,
  ): boolean;
}>;
declare module "@deepseek-ai/cordis" {
  interface Context {
    navigation: Navigation;
  }
}
export function provideNavigation(
  ctx: Context,
  host = typeof window === "undefined" ? undefined : window,
) {
  const controller = createNavigationController(
    host ? createBrowserHistory(host) : createMemoryHistory(),
  );
  ctx.provide("navigation", controller.navigation);
  const positions = new Map<string, JsonValue>();
  ctx.effect(() => () => {
    controller.dispose();
    positions.clear();
  });
  return {
    ...controller,
    /** Bounded per-visit state; never drafts, message bodies, credentials or authorization. */
    position(id: string) {
      return positions.get(id);
    },
    savePosition(id: string, value: JsonValue) {
      positions.delete(id);
      positions.set(id, value);
      while (positions.size > 100) {
        const first = positions.keys().next().value;
        if (first) positions.delete(first);
      }
    },
    request(attempt: OpenAttempt, owner: PresentationOwner) {
      const presentation = bindPresentation(
        {
          entryId: attempt.entry.id,
          target: attempt.entry.target,
          signal: attempt.signal,
          focus: attempt.focus ?? "content",
          resolve: (target) => controller.resolve(attempt, target),
          complete: (result) => controller.complete(attempt, result),
        },
        {
          valid: () =>
            controller.navigation.snapshot().attempt === attempt &&
            owner.valid(),
          subscribe(listener) {
            const stopOwner = owner.subscribe(listener);
            const stopAttempt = controller.navigation.subscribe(listener);
            return () => {
              stopOwner();
              stopAttempt();
            };
          },
        },
      );
      return presentation;
    },
  };
}

/** Presentation authority is narrower than the pending visit's lifetime. */
export type PresentationOwner = {
  valid(): boolean;
  subscribe(listener: () => void): () => void;
};
function bindPresentation(
  parent: Omit<PageNavigation, "forSession">,
  owner: PresentationOwner,
) {
  const lifetime = new AbortController();
  const sessions = new WeakMap<
    RelayData,
    WeakMap<RelaySnapshot, PageNavigation>
  >();
  let stop = () => {};
  function dispose() {
    if (lifetime.signal.aborted) return;
    // Commit revocation before invoking abort listeners or other external code.
    lifetime.abort();
    stop();
    parent.signal.removeEventListener("abort", dispose);
  }
  const valid = () => {
    if (lifetime.signal.aborted) return false;
    if (parent.signal.aborted || !owner.valid()) {
      dispose();
      return false;
    }
    return true;
  };
  const request: PageNavigation = Object.freeze({
    entryId: parent.entryId,
    target: parent.target,
    signal: lifetime.signal,
    focus: parent.focus ?? "content",
    resolve: (target) => valid() && parent.resolve(target),
    complete: (result) => valid() && parent.complete(result),
    forSession(relay, connection) {
      let connections = sessions.get(relay);
      if (!connections) {
        connections = new WeakMap();
        sessions.set(relay, connections);
      }
      const existing = connections.get(connection);
      if (existing && !existing.signal.aborted) return existing;
      const bound = bindPresentation(request, {
        valid: () => {
          const current = relay.snapshot();
          return (
            current.session === connection.session &&
            current.generation === connection.generation &&
            current.scope === connection.scope &&
            current.status === connection.status
          );
        },
        subscribe: relay.subscribe,
      });
      connections.set(connection, bound.request);
      return bound.request;
    },
  });
  parent.signal.addEventListener("abort", dispose, { once: true });
  stop = owner.subscribe(() => {
    valid();
  });
  // Registration/session can already be obsolete before React commits the new tree.
  if (!valid()) stop();
  return { request, dispose };
}
