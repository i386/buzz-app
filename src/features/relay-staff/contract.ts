/**
 * Contract between the relay staff plugin and the native admin client.
 *
 * Only native code talks to a relay's admin API: it validates the admin
 * origin, connects only to vetted public addresses, builds every URL from
 * the closed request union below and signs each request with NIP-98. The
 * webview supplies typed fields, never a URL, path or method.
 */

/** Wire shapes. Field names match the relay's `/api/admin/v1` JSON. */
export type StaffRole = "operator" | "moderator";
export type StaffRoleSource = "config" | "owner_fallback" | "db";

export type ProbeDto = {
  status: string;
  authMode: "nip98" | "disabled";
  role: StaffRole | null;
  source: StaffRoleSource | null;
  canAct: boolean;
  canStaff: boolean;
};

export type ReportAction =
  | "delete"
  | "kick"
  | "ban"
  | "timeout"
  | "dismiss"
  | "escalate";

export type ActionRecordDto = {
  id: string;
  requestId: string;
  actorPubkey: string;
  actorRole: StaffRole;
  action: ReportAction;
  status: "pending" | "enforcing" | "succeeded" | "failed" | "cancelled";
  reason: string | null;
  expiresAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ReportStatus =
  | "open"
  | "processing"
  | "resolved"
  | "dismissed"
  | "escalated";

export type ReportDto = {
  id: string;
  communityId: string;
  communityHost: string;
  reportEventId: string;
  reporterPubkey: string;
  targetKind: string;
  target: string;
  targetAuthorPubkey?: string | null;
  channelId?: string | null;
  reportType: string;
  note?: string | null;
  status: ReportStatus;
  resolvedBy?: string | null;
  resolvedAt?: string | null;
  actionId?: string | null;
  activeAction?: ActionRecordDto | null;
  createdAt: string;
};

export type ReportDetailDto = ReportDto & {
  message?: {
    authorPubkey: string;
    content: string;
    createdAt: string;
    deletedAt?: string | null;
  } | null;
};

export type ReportResolution = {
  status: ReportStatus;
  activeAction: ActionRecordDto | null;
};

export type FeedbackStatus = "new" | "reviewed" | "archived";

export type FeedbackSummaryDto = {
  id: string;
  communityId: string | null;
  communityHost: string | null;
  submitterPubkey: string;
  category?: string | null;
  bodySummary: string;
  status: FeedbackStatus;
  receivedAt: string;
};

export type FeedbackDto = {
  id: string;
  communityId: string | null;
  communityHost: string | null;
  eventId: string;
  submitterPubkey: string;
  category?: string | null;
  body: string;
  status: FeedbackStatus;
  /** Source event tags; `imeta` tags describe attachments. */
  tags: unknown;
  eventCreatedAt: string;
  receivedAt: string;
};

export type OperatorDto = {
  pubkey: string;
  effectiveRole: StaffRole;
  sources: StaffRoleSource[];
};

export type RestrictionDto = {
  pubkey: string;
  banned: boolean;
  banExpiresAt: string | null;
  banReason: string | null;
  mutedUntil: string | null;
  muteReason: string | null;
  actorPubkey: string;
  updatedAt: string;
};

export type Page<T> = { items: T[]; nextCursor: string | null };

export type CommunityDto = { id: string; host: string; icon: string | null };

export type MemberSearchDto = {
  pubkey: string;
  displayName: string | null;
  nip05: string | null;
  avatarUrl: string | null;
};

export type MemberDetailDto = {
  pubkey: string;
  profile: {
    displayName: string | null;
    nip05: string | null;
    avatarUrl: string | null;
    about: string | null;
  } | null;
  role: "owner" | "admin" | "member" | null;
  banned: boolean;
  mutedUntil: string | null;
  isStaff: boolean | null;
};

export type EventPreviewDto = {
  id: string;
  authorPubkey: string;
  kind: number;
  content: string;
  createdAt: string;
  deletedAt: string | null;
  channelId: string | null;
};

/** `pending`: the relay accepted the action but has not finished it. */
export type DirectActionDto =
  | { state: "succeeded"; actionId: string; replayed: boolean }
  | { state: "pending"; actionId: string; replayed: boolean };

/**
 * What a request is bound to. Native code refuses to send (`notSent`) unless
 * the signed-in identity is `signer` and a fresh discovery on `relay` still
 * advertises `origin`. A retry reuses the same context; it never retargets.
 */
export type StaffContext = {
  /** The community relay whose NIP-11 advertised the admin host (https origin). */
  relay: string;
  /** The validated admin origin returned by discovery. */
  origin: string;
  /** Hex pubkey that must sign. */
  signer: string;
};

export type ReportsQuery = {
  communityId?: string;
  status?: ReportDto["status"];
  limit?: number;
  /** Omit for the relay's escalated-only default; the console sends `"all"`. */
  scope?: "all";
};

/**
 * Every admin call the app can make. Writes carry their full frozen intent,
 * including `requestId`: mint it once per operation and reuse it on every
 * retry of an ambiguous outcome.
 */
export type StaffRequest =
  | { route: "probe" }
  | { route: "listReports"; query: ReportsQuery }
  | { route: "getReport"; id: string }
  | {
      route: "resolveReport";
      id: string;
      action: ReportAction;
      requestId: string;
      /** Only for `timeout`. */
      expirationSecs?: number;
      reason?: string;
    }
  | { route: "reopenReport"; id: string; requestId: string; reason?: string }
  | { route: "cancelReport"; id: string; actionId: string }
  | { route: "listFeedback" }
  | { route: "getFeedback"; id: string }
  | { route: "setFeedbackStatus"; id: string; status: FeedbackStatus }
  | { route: "listOperators" }
  | { route: "putOperator"; pubkey: string; role: StaffRole }
  | { route: "deleteOperator"; pubkey: string }
  | {
      route: "listRestrictions";
      communityHost: string;
      cursor?: string;
      limit?: number;
    }
  | {
      route: "liftRestriction";
      communityHost: string;
      kind: "ban" | "timeout";
      pubkey: string;
    }
  | {
      route: "directAction";
      communityHost: string;
      action: "ban" | "timeout" | "delete";
      /** Hex pubkey for ban/timeout, hex event ID for delete. */
      target: string;
      requestId: string;
      reason?: string;
      /** Timeout only: required for timeout, absent for ban and delete. */
      expirationSecs?: number;
    }
  | { route: "listCommunities"; q?: string; cursor?: string; limit?: number }
  | {
      route: "searchMembers";
      communityHost: string;
      q: string;
      limit?: number;
    }
  | { route: "getMember"; communityHost: string; pubkey: string }
  | { route: "getEvent"; communityHost: string; id: string };

export type StaffRoute = StaffRequest["route"];

export type StaffResults = {
  probe: ProbeDto;
  listReports: ReportDto[];
  getReport: ReportDetailDto;
  resolveReport: ReportResolution;
  reopenReport: { status: "open" };
  cancelReport: ReportResolution;
  listFeedback: FeedbackSummaryDto[];
  getFeedback: FeedbackDto;
  setFeedbackStatus: { status: FeedbackStatus };
  listOperators: OperatorDto[];
  putOperator: OperatorDto;
  deleteOperator: { deleted: string };
  listRestrictions: Page<RestrictionDto>;
  liftRestriction: null;
  directAction: DirectActionDto;
  listCommunities: Page<CommunityDto>;
  searchMembers: { items: MemberSearchDto[] };
  getMember: MemberDetailDto;
  getEvent: EventPreviewDto;
};

/**
 * Presentation category. The raw facts beside it are authoritative.
 * - `notSent`: refused before any byte left the app (bad input, context
 *   changed, address policy, DNS failure, signer locked). Safe to rebuild.
 * - `unauthorized`: 401, the relay did not accept the signature or roster.
 *   After a sent write, only beta's own error envelope (with its
 *   `WWW-Authenticate: Nostr` challenge) counts; otherwise `ambiguous`.
 * - `forbidden`: 403 (not staff, read-only mode, staff target refused).
 *   After a sent write, only beta's `forbidden` envelope counts.
 * - `unsupported`: a complete, zero-byte 404 or 405. The route is absent.
 * - `rejected`: any other complete 4xx (including coded 404, 409, 422). After
 *   a sent write, only with beta's exact error envelope; otherwise `ambiguous`.
 * - `intercepted`: an HTML page or redirect, such as an SSO or VPN gateway.
 * - `ambiguous`: transport error, 5xx, truncated or unreadable body. A write
 *   may have committed: retry with the same request.
 */
export type StaffFailureCategory =
  | "notSent"
  | "unauthorized"
  | "forbidden"
  | "unsupported"
  | "rejected"
  | "intercepted"
  | "ambiguous";

export type StaffFailure = {
  category: StaffFailureCategory;
  /** HTTP status, or null when no response arrived. */
  status: number | null;
  /** The whole response body was read within its cap. */
  bodyComplete: boolean;
  /** The body was read completely and was zero bytes. */
  bodyEmpty: boolean;
  /** The relay's `error.code`, e.g. `request_id_conflict`, `conflict`. */
  code: string | null;
  /** True only when native code refused before sending anything. */
  notSent: boolean;
  /**
   * The response was a 401 or 403 from anyone (relay or gateway): re-check
   * access. Independent of `category`; a sent write may still be ambiguous.
   */
  authLost: boolean;
  /** Plain-language detail, safe to show. */
  message: string;
};

export type StaffOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; failure: StaffFailure };

/** Only a fully read, empty 404/405 means the relay lacks the route. */
export function unsupported(failure: StaffFailure) {
  return (
    (failure.status === 404 || failure.status === 405) &&
    failure.bodyComplete &&
    failure.bodyEmpty
  );
}

/**
 * The write may have landed. Keep the frozen request (same `requestId`) and
 * offer a retry instead of minting a new operation.
 */
export function ambiguous(failure: StaffFailure) {
  return failure.category === "ambiguous";
}

/** A `pending` direct action is also unresolved: retry with the same request. */
export function unresolved(outcome: StaffOutcome<unknown>) {
  if (!outcome.ok) return ambiguous(outcome.failure);
  const value = outcome.value as { state?: unknown } | null;
  return value?.state === "pending";
}

/** The feedback attachment named by an `imeta` tag. */
export type AttachmentRef = {
  feedbackId: string;
  /** Lowercase hex SHA-256 of the blob. */
  sha256: string;
  mime: string;
  size: number;
};

export type SaveResult =
  | { state: "saved" }
  | { state: "cancelled" }
  | { state: "failed"; failure: StaffFailure };

export interface RelayStaffBackend {
  /** False in browser and dev-broker builds: show "native build required". */
  readonly available: boolean;
  /**
   * Unsigned. Reads `admin_api` from `relay`'s NIP-11 and returns the
   * validated https public origin, or null when absent or invalid. Never
   * sends `/probe`.
   */
  discover(relay: string): Promise<string | null>;
  request<R extends StaffRequest>(
    context: StaffContext,
    request: R,
  ): Promise<StaffOutcome<StaffResults[R["route"]]>>;
  /** Image preview bytes, checked against the expected hash, type and size. */
  attachment(
    context: StaffContext,
    ref: AttachmentRef,
  ): Promise<StaffOutcome<Uint8Array>>;
  /** Native save dialog, then a validated fetch written to the chosen file. */
  saveAttachment(
    context: StaffContext,
    ref: AttachmentRef,
  ): Promise<SaveResult>;
}
