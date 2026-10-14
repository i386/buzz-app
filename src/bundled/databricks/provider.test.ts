import { describe, expect, it, vi } from "vitest";
import { DatabricksProvider, type BrowserCallback } from "./provider";

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture({
  begin,
  connect,
}: {
  begin?: ReturnType<typeof gate<{ id: string; callbackUrl: string }>>;
  connect?: ReturnType<typeof gate<void>>;
} = {}) {
  let connected = false;
  const connectStarted = gate<void>();
  const beginStarted = gate<void>();
  const waitStarted = gate<void>();
  const callbackResult = gate<{ parameters: [string, string][] }>();
  const calls: { operation: string; input?: object }[] = [];
  const native: ConstructorParameters<typeof DatabricksProvider>[0] = async <T>(
    operation: string,
    input?: object,
  ) => {
    calls.push({ operation, ...(input ? { input } : {}) });
    if (operation === "authorize")
      return {
        url: "https://workspace.cloud.databricks.com/oidc/authorize",
      } as T;
    if (operation === "connect") {
      connectStarted.resolve();
      if (connect) await connect.promise;
      connected = true;
    }
    if (operation === "disconnect") connected = false;
    return { connected } as T;
  };
  const callback: BrowserCallback = {
    begin: vi.fn(async () => {
      beginStarted.resolve();
      return begin
        ? begin.promise
        : {
            id: "attempt",
            callbackUrl: "http://localhost:4567",
          };
    }),
    wait: vi.fn(async () => {
      waitStarted.resolve();
      return callbackResult.promise;
    }),
    cancel: vi.fn(async () => {}),
  };
  return {
    provider: new DatabricksProvider(native, callback),
    callback,
    calls,
    callbackResult,
    connectStarted,
    beginStarted,
    waitStarted,
    connected: () => connected,
  };
}

describe("shared Databricks login", () => {
  it("uses PKCE and one native-held connection for concurrent sign-in requests", async () => {
    const f = fixture();
    const signingIn = f.provider.signIn();
    try {
      await f.waitStarted.promise;
      expect(f.provider.snapshot()).toMatchObject({
        connected: false,
        pending: true,
      });
      await f.provider.signIn();
      expect(f.callback.begin).toHaveBeenCalledTimes(1);
      const startedUrl = vi.mocked(f.callback.begin).mock.calls[0]?.[0];
      if (!startedUrl) throw new Error("Browser sign-in did not start");
      const url = new URL(startedUrl);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.has("state")).toBe(false); // Native owns OAuth state.
      f.callbackResult.resolve({ parameters: [["code", "one-time-code"]] });
      await signingIn;
      const saved = f.calls.find((c) => c.operation === "connect")?.input as {
        verifier: string;
        redirect: string;
      };
      const hash = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(saved.verifier),
        ),
      );
      expect(Buffer.from(hash).toString("base64url")).toBe(
        url.searchParams.get("code_challenge"),
      );
      expect(saved.redirect).toBe("http://localhost:4567");
      expect(f.provider.snapshot()).toEqual({
        connected: true,
        pending: false,
      });
      expect(f.callback.cancel).toHaveBeenCalledWith("attempt");
      await f.provider.signOut();
      expect(f.connected()).toBe(false);
    } finally {
      f.callbackResult.resolve({ parameters: [["code", "unused"]] });
      await signingIn;
      f.provider.dispose();
    }
  });

  it("cleans up cancellation while native browser startup is still pending", async () => {
    const begin = gate<{ id: string; callbackUrl: string }>();
    const f = fixture({ begin });
    const signingIn = f.provider.signIn();
    try {
      await f.beginStarted.promise;
      f.provider.cancel();
    } finally {
      begin.resolve({
        id: "late-attempt",
        callbackUrl: "http://localhost:4567",
      });
      await signingIn;
    }
    expect(f.callback.cancel).toHaveBeenCalledWith("late-attempt");
    expect(f.callback.wait).not.toHaveBeenCalled();
    expect(f.calls.some((c) => c.operation === "connect")).toBe(false);
    expect(f.provider.snapshot()).toEqual({ connected: false, pending: false });
  });

  it("makes the native commit explicit and finishes it even when the view closes", async () => {
    const connect = gate<void>();
    const f = fixture({ connect });
    const signingIn = f.provider.signIn();
    try {
      await f.waitStarted.promise;
      f.callbackResult.resolve({ parameters: [["code", "one-time-code"]] });
      await f.connectStarted.promise;
      expect(f.provider.snapshot()).toMatchObject({
        pending: true,
        committing: true,
      });
      f.provider.cancel();
      f.provider.dispose();
    } finally {
      connect.resolve();
      await signingIn;
    }
    expect(f.connected()).toBe(true);
    expect(f.calls.some((c) => c.operation === "disconnect")).toBe(false);
  });
});
