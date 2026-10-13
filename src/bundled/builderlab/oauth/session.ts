import type { Credential } from "./browser";

export type LoginSnapshot = Readonly<{
  status: "signed-out" | "pending" | "signed-in";
  account?: Credential["account"];
  error?: string;
}>;

/** One plugin lifetime owns the reusable credential; UI snapshots never contain it. */
export function createOAuthSession(
  acquire: (signal: AbortSignal) => Promise<Credential>,
) {
  let credential: Credential | undefined;
  let attempt: AbortController | undefined;
  let disposed = false;
  let state: LoginSnapshot = { status: "signed-out" };
  const listeners = new Set<() => void>();
  const publish = (next: LoginSnapshot) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const reset = () => {
    attempt?.abort();
    attempt = undefined;
    credential = undefined;
    publish({ status: "signed-out" });
  };
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    credential() {
      if (!credential) throw new Error("Sign in to Builderlab first.");
      return credential;
    },
    /** Creation joins Settings' login without owning or canceling that attempt. */
    async ensureSignedIn(signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      if (disposed) throw new Error("Builderlab session is closed.");
      if (credential) return;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          listeners.delete(changed);
          signal.removeEventListener("abort", abort);
        };
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        const changed = () => {
          if (state.status === "pending") return;
          cleanup();
          if (credential) resolve();
          else reject(new Error(state.error ?? "Sign-in canceled."));
        };
        listeners.add(changed);
        signal.addEventListener("abort", abort, { once: true });
        void this.signIn();
      });
    },
    cancel: reset,
    signOut: reset,
    async signIn() {
      if (disposed || attempt) return;
      credential = undefined;
      const current = new AbortController();
      attempt = current;
      publish({ status: "pending" });
      try {
        const result = await acquire(current.signal);
        current.signal.throwIfAborted();
        if (attempt !== current || disposed) return;
        credential = result;
        publish({ status: "signed-in", account: result.account });
      } catch (error) {
        if (attempt !== current || disposed) return;
        publish({
          status: "signed-out",
          error:
            error instanceof Error
              ? error.message
              : "Sign-in failed. Try again.",
        });
      } finally {
        if (attempt === current) attempt = undefined;
      }
    },
    dispose() {
      disposed = true;
      reset();
      listeners.clear();
    },
  };
}
export type OAuthSession = ReturnType<typeof createOAuthSession>;
