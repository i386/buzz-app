import { invoke } from "@tauri-apps/api/core";
import { Service, type Context } from "@deepseek-ai/cordis";
import {
  DATABRICKS_ID,
  type ProviderModel,
  type SharedProvider,
} from "../../features/providers/shared";

type State = Readonly<{
  connected: boolean;
  pending: boolean;
  committing?: true;
  error?: string;
}>;
type Native = <T>(operation: string, input?: object) => Promise<T>;
const native: Native = (operation, input = {}) =>
  invoke("databricks_provider", { operation, input });
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export type BrowserCallback = {
  begin(url: string): Promise<{ id: string; callbackUrl: string }>;
  wait(id: string): Promise<{ parameters: [string, string][] }>;
  cancel(id: string): Promise<void>;
};
const browser: BrowserCallback = {
  begin: (authorizationUrl) =>
    invoke("oauth_callback_begin", {
      authorizationUrl,
      // databricks-cli is registered for http://localhost with any port.
      callbackPath: "",
      callbackHost: "localhost",
      useState: true,
    }),
  wait: (id) => invoke("oauth_callback_wait", { id }),
  cancel: (id) => invoke("oauth_callback_cancel", { id }),
};

/** One provider owns login and catalog; its snapshots never contain tokens. */
export class DatabricksProvider {
  readonly id = DATABRICKS_ID;
  readonly name = "Databricks in Buzz";
  private state: State = { connected: false, pending: false };
  private listeners = new Set<() => void>();
  private attempt: AbortController | undefined;
  private disposed = false;

  constructor(
    private readonly call: Native = native,
    private readonly callback = browser,
  ) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(next: State) {
    if (this.disposed) return;
    this.state = Object.freeze(next);
    for (const listener of this.listeners) listener();
  }
  async connected() {
    try {
      const result = await this.call<{ connected: boolean }>("status");
      if (!this.attempt)
        this.publish({ connected: result.connected, pending: false });
      return result.connected;
    } catch (error) {
      this.publish({ ...this.state, error: message(error) });
      throw error;
    }
  }
  models = () => this.call<readonly ProviderModel[]>("models");

  async signIn() {
    if (this.attempt || this.disposed) return;
    const attempt = new AbortController();
    this.attempt = attempt;
    this.publish({ connected: this.state.connected, pending: true });
    let id: string | undefined;
    const cancel = () => {
      if (id) void this.callback.cancel(id).catch(() => {});
    };
    try {
      const { url } = await this.call<{ url: string }>("authorize");
      attempt.signal.throwIfAborted();
      const verifier = encode(crypto.getRandomValues(new Uint8Array(32)));
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(verifier),
      );
      attempt.signal.throwIfAborted();
      const authorization = new URL(url);
      authorization.search = new URLSearchParams({
        client_id: "databricks-cli",
        response_type: "code",
        scope: "all-apis offline_access",
        code_challenge: encode(new Uint8Array(digest)),
        code_challenge_method: "S256",
      }).toString();
      const started = await this.callback.begin(authorization.href);
      id = started.id;
      attempt.signal.addEventListener("abort", cancel, { once: true });
      attempt.signal.throwIfAborted();
      const result = await this.callback.wait(id);
      attempt.signal.throwIfAborted();
      const params = new URLSearchParams(result.parameters);
      const codes = params.getAll("code");
      if (params.has("error") || codes.length !== 1 || !codes[0])
        throw new Error("Databricks sign-in failed. Try again.");
      // The validated callback starts a commit. Cancellation applies only to
      // browser waiting; native saving may finish even if this view closes.
      this.publish({
        connected: this.state.connected,
        pending: true,
        committing: true,
      });
      await this.call("connect", {
        code: codes[0],
        verifier,
        redirect: started.callbackUrl,
      });
      this.publish({ connected: true, pending: false });
    } catch (error) {
      if (this.attempt === attempt)
        this.publish({
          connected: this.state.connected,
          pending: false,
          ...(!attempt.signal.aborted ? { error: message(error) } : {}),
        });
    } finally {
      attempt.signal.removeEventListener("abort", cancel);
      try {
        if (id) await this.callback.cancel(id);
      } finally {
        if (this.attempt === attempt) this.attempt = undefined;
      }
    }
  }
  cancel = () => {
    if (!this.state.committing) this.attempt?.abort();
  };
  async signOut() {
    this.cancel();
    try {
      await this.call("disconnect");
      this.publish({ connected: false, pending: false });
    } catch (error) {
      this.publish({ ...this.state, error: message(error) });
    }
  }
  dispose() {
    this.cancel();
    this.disposed = true;
    this.listeners.clear();
  }
}
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Databricks connection failed. Try again.";

export class DatabricksService extends Service {
  constructor(
    ctx: Context,
    readonly provider: DatabricksProvider,
    readonly shared: SharedProvider,
  ) {
    super(ctx, "databricks");
    ctx.effect(() => () => provider.dispose());
  }
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    databricks: DatabricksService;
  }
}
