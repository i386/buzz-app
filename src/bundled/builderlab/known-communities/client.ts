import type { Host, HostResponse } from "../../../features/host/service";
import { oauthTarget, type Credential } from "../oauth/browser";
import type { OAuthSession } from "../oauth/session";

/** The service's refusals. None is retried as sent: each waits for a fresh
 * sign-in. A client error the service did not name is `rejected` with its
 * status: the request as sent will not be accepted, unlike a timeout, a rate
 * limit or a server error. */
export type Refusal =
  | { kind: "invalid_request" }
  | { kind: "forbidden" }
  | { kind: "limit_reached" }
  | { kind: "rejected"; status: number };
export type ListResult = { kind: "listed"; communities: string[] } | Refusal;
export type UpdateResult = { kind: "accepted" } | Refusal;

/** Refusals the framework answers in plain text, by status alone. */
const BY_STATUS: Record<number, Refusal["kind"]> = {
  400: "invalid_request",
  403: "forbidden",
  422: "limit_reached",
};
type Named = Exclude<Refusal, { kind: "rejected" }>["kind"];
const REFUSALS: ReadonlySet<string> = new Set<Named>([
  "invalid_request",
  "forbidden",
  "limit_reached",
]);
const isRefusal = (code: unknown): code is Named =>
  typeof code === "string" && REFUSALS.has(code);
/** A status outside the route's contract: another client error is a refusal
 * of the request as sent, while a timeout, a rate limit or a server error is
 * a failure to retry. (A 401 ends the session before reaching here.) */
function unexpected(status: number): Refusal {
  if (status >= 400 && status < 500 && status !== 408 && status !== 429)
    return { kind: "rejected", status };
  throw Object.assign(
    new Error(`Builderlab request failed (HTTP ${status}).`),
    {
      status,
    },
  );
}
const invalid = () => new Error("Builderlab returned an invalid response.");

/** A listed destination's address as the service holds it. */
function address(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { relay_url } = value as Record<string, unknown>;
  return typeof relay_url === "string" && relay_url.startsWith("wss://")
    ? relay_url
    : undefined;
}

/** The known-communities routes under the signed-in Builderlab session. The
 * list is bounded by the service (1,000 rows) well inside the host transport's
 * response cap, so no smaller cap is imposed here. */
export function createKnownCommunitiesClient(
  host: Host,
  session: OAuthSession,
) {
  function check(credential: Credential, signal: AbortSignal) {
    signal.throwIfAborted();
    if (
      session.snapshot().status !== "signed-in" ||
      session.credential() !== credential
    )
      throw new DOMException("Builderlab session changed.", "AbortError");
  }
  /** Posts under the current credential and parses the body on every status:
   * the service answers its refusals in JSON, while the framework's own
   * refusals are plain text. */
  async function request(path: string, body: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    const credential = session.credential();
    let response: HostResponse;
    try {
      response = await host.request({
        url: `${oauthTarget()}/v1/buzz/known-communities/${path}`,
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-BB-Session-Credential": credential.value,
        },
        body: JSON.stringify(body),
      });
    } catch {
      check(credential, signal);
      throw new Error("Couldn’t reach Builderlab.");
    }
    check(credential, signal);
    if (response.status === 401) {
      // The session is over; the fence reports it as the cancellation it is.
      session.signOut();
      check(credential, signal);
    }
    let value: unknown;
    try {
      value = JSON.parse(response.body);
    } catch {
      /* A plain-text framework refusal; the status carries the meaning. */
    }
    return {
      status: response.status,
      value: (value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {}) as Record<string, unknown>,
    };
  }
  const refusal = (status: number, value: Record<string, unknown>): Refusal => {
    const code =
      typeof value.error === "string" ? value.error : BY_STATUS[status];
    return isRefusal(code) ? { kind: code } : unexpected(status);
  };
  /** Both edits are idempotent, so a lost answer is retried as sent. */
  async function send(
    path: "add" | "remove",
    url: string,
    signal: AbortSignal,
  ): Promise<UpdateResult> {
    const { status, value } = await request(path, { relay_url: url }, signal);
    return status === 200 ? { kind: "accepted" } : refusal(status, value);
  }
  return {
    /** Every destination the account holds, in the service's spelling. */
    async list(signal: AbortSignal): Promise<ListResult> {
      const { status, value } = await request("list", {}, signal);
      if (status !== 200) return refusal(status, value);
      // Protobuf JSON can omit an empty repeated field.
      const rows = value.communities ?? [];
      const communities = Array.isArray(rows) ? rows.map(address) : [];
      if (!Array.isArray(rows) || communities.includes(undefined))
        throw invalid();
      return { kind: "listed", communities: communities as string[] };
    },
    add: (url: string, signal: AbortSignal) => send("add", url, signal),
    remove: (url: string, signal: AbortSignal) => send("remove", url, signal),
  };
}
export type KnownCommunitiesClient = ReturnType<
  typeof createKnownCommunitiesClient
>;
