import type {
  ListedCommunity,
  PendingOp,
} from "../../../features/communities/known-communities";
import type { Host, HostResponse } from "../../../features/host/service";
import { oauthTarget, type Credential } from "../oauth/browser";
import type { OAuthSession } from "../oauth/session";

/** The service's named refusals. None is retried as sent: a mismatch waits
 * for the account's binding, the rest for a fresh sign-in. */
export type Refusal = {
  kind: "identity_mismatch" | "invalid_request" | "forbidden" | "limit_reached";
};
export type IdentityResult = { kind: "identity"; pubkey?: string } | Refusal;
export type ListResult =
  | { kind: "listed"; communities: ListedCommunity[] }
  | Refusal;
export type UpdateResult =
  | { kind: "accepted"; record: ListedCommunity }
  /** Another operation won. The current record comes along when a row exists. */
  | { kind: "revision_conflict"; record?: ListedCommunity }
  | Refusal;

/** Refusals the framework answers in plain text, by status alone. */
const BY_STATUS: Record<number, Refusal["kind"]> = {
  400: "invalid_request",
  403: "forbidden",
  422: "limit_reached",
};
const REFUSALS: ReadonlySet<string> = new Set<Refusal["kind"]>([
  "identity_mismatch",
  "invalid_request",
  "forbidden",
  "limit_reached",
]);
const isRefusal = (code: unknown): code is Refusal["kind"] =>
  typeof code === "string" && REFUSALS.has(code);
const failure = (status: number) =>
  Object.assign(new Error(`Builderlab request failed (HTTP ${status}).`), {
    status,
  });
const invalid = () => new Error("Builderlab returned an invalid response.");

/** One destination as the service holds it. The proto's int64 revision is
 * accepted as a number or a numeric string. */
function record(value: unknown): ListedCommunity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { relay_url, revision, removed } = value as Record<string, unknown>;
  const parsed =
    typeof revision === "string" && /^\d+$/.test(revision)
      ? Number(revision)
      : revision;
  if (
    typeof relay_url !== "string" ||
    !relay_url.startsWith("wss://") ||
    typeof parsed !== "number" ||
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    (removed !== undefined && typeof removed !== "boolean")
  )
    return undefined;
  return { url: relay_url, revision: parsed, removed: removed === true };
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
   * the service answers its refusals in JSON, a 409 with the current record,
   * while the framework's own refusals are plain text. */
  async function request(path: string, body: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    const credential = session.credential();
    let response: HostResponse;
    try {
      response = await host.request({
        url: `${oauthTarget()}/v1/buzz/${path}`,
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
  const code = (status: number, value: Record<string, unknown>) =>
    typeof value.error === "string" ? value.error : BY_STATUS[status];
  return {
    /** The key the account is bound to, or none while it has not been bound. */
    async identity(signal: AbortSignal): Promise<IdentityResult> {
      const { status, value } = await request(
        "nostr-identities/current",
        {},
        signal,
      );
      // This route names its refusals as objects; only the status is shared.
      if (status === 403) return { kind: "forbidden" };
      if (status !== 200) throw failure(status);
      const identity = value.identity;
      if (identity === undefined || identity === null)
        return { kind: "identity" };
      const hex =
        identity && typeof identity === "object" && "pubkey_hex" in identity
          ? identity.pubkey_hex
          : undefined;
      if (typeof hex !== "string" || !/^[0-9a-f]{64}$/.test(hex))
        throw invalid();
      return { kind: "identity", pubkey: hex };
    },
    async list(pubkey: string, signal: AbortSignal): Promise<ListResult> {
      const { status, value } = await request(
        "known-communities/list",
        { pubkey_hex: pubkey },
        signal,
      );
      if (status === 200) {
        // Protobuf JSON can omit an empty repeated field.
        const rows = value.communities ?? [];
        const communities = Array.isArray(rows) ? rows.map(record) : [];
        if (!Array.isArray(rows) || communities.includes(undefined))
          throw invalid();
        return {
          kind: "listed",
          communities: communities as ListedCommunity[],
        };
      }
      const refusal = code(status, value);
      if (isRefusal(refusal)) return { kind: refusal };
      throw failure(status);
    },
    /** Sends one queued operation exactly as queued, so a retry replays the
     * same operation ID with the same payload. */
    async update(
      pubkey: string,
      op: PendingOp,
      signal: AbortSignal,
    ): Promise<UpdateResult> {
      const { status, value } = await request(
        "known-communities/update",
        {
          pubkey_hex: pubkey,
          relay_url: op.url,
          expected_revision: op.expectedRevision,
          operation_id: op.operationId,
          removed: op.removed,
        },
        signal,
      );
      const current = record(value.community);
      if (status === 200) {
        if (!current) throw invalid();
        return { kind: "accepted", record: current };
      }
      const refusal = code(status, value);
      if (refusal === "revision_conflict") {
        if (
          value.community !== undefined &&
          value.community !== null &&
          !current
        )
          throw invalid();
        return current
          ? { kind: "revision_conflict", record: current }
          : { kind: "revision_conflict" };
      }
      if (isRefusal(refusal)) return { kind: refusal };
      throw failure(status);
    },
  };
}
export type KnownCommunitiesClient = ReturnType<
  typeof createKnownCommunitiesClient
>;
