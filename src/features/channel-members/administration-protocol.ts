import type { EventTemplate } from "nostr-tools";
import { sessionMetadata } from "../sessions/metadata.ts";
import type { RelayEvent } from "../relay/events.ts";
import {
  channelTypeTag,
  exactLifecycleTag,
  lifecycleChannelId,
  lifecycleRecord,
} from "../relay/channel-lifecycle-protocol.ts";

export const editableMemberRoles = ["admin", "member", "guest"] as const;
export type EditableMemberRole = (typeof editableMemberRoles)[number];
export type MemberRole = EditableMemberRole | "owner" | "bot" | "unknown";
export type MemberChange = Readonly<{
  pubkey: string;
  expectedRole: MemberRole;
  role: EditableMemberRole | "remove";
}>;
export type MemberAuthority = Readonly<{
  roles: Readonly<Record<string, MemberRole>>;
  canManage: boolean;
  canRemoveOwnedAgent: boolean;
}>;
const PUBKEY = /^[0-9a-f]{64}$/;

/** Inputs have already passed the session reader's signature verification. */
export function memberAuthority(
  events: readonly RelayEvent[],
  channelId: string,
  viewer: string,
  relayAuthor: string,
): MemberAuthority {
  if (events.some((event) => ![39000, 39001, 39002].includes(event.kind)))
    throw new Error("Unexpected channel membership response");
  const metadata = lifecycleRecord(events, 39000, channelId, relayAuthor);
  const admins = lifecycleRecord(events, 39001, channelId, relayAuthor);
  const roster = lifecycleRecord(events, 39002, channelId, relayAuthor);
  if (!metadata || !admins || !roster)
    throw new Error(
      "Current member roles could not be verified. Refresh members and roles.",
    );
  const type = channelTypeTag(metadata);
  const archived = exactLifecycleTag(metadata, "archived");
  if (
    !["stream", "forum", "dm", "system"].includes(type ?? "") ||
    (archived !== undefined && archived !== "true" && archived !== "false")
  )
    throw new Error("Malformed channel state");
  const roles: Record<string, MemberRole> = {};
  for (const entry of roster.tags.filter(([key]) => key === "p")) {
    const [, key, , role] = entry;
    if (
      !key ||
      !PUBKEY.test(key) ||
      key in roles ||
      entry.length < 2 ||
      entry.length > 4
    )
      throw new Error("Malformed channel membership state");
    roles[key] = ["owner", "admin", "member", "guest", "bot"].includes(
      role ?? "",
    )
      ? (role as MemberRole)
      : "unknown";
  }
  const elevated = new Map<string, string>();
  for (const entry of admins.tags.filter(([key]) => key === "p")) {
    const [, key, role] = entry;
    if (
      entry.length !== 3 ||
      !key ||
      !PUBKEY.test(key) ||
      (role !== "owner" && role !== "admin") ||
      elevated.has(key) ||
      roles[key] !== role
    )
      throw new Error(
        "Member roles are inconsistent. Refresh members and roles.",
      );
    elevated.set(key, role);
  }
  if (
    Object.entries(roles).some(
      ([key, role]) =>
        (role === "owner" || role === "admin") && elevated.get(key) !== role,
    )
  )
    throw new Error(
      "Member roles are inconsistent. Refresh members and roles.",
    );
  const activeChannel =
    type !== "dm" &&
    archived !== "true" &&
    !sessionMetadata(exactLifecycleTag(metadata, "about"));
  return Object.freeze({
    roles: Object.freeze(roles),
    canManage: activeChannel && elevated.has(viewer),
    canRemoveOwnedAgent:
      activeChannel && !!roles[viewer] && roles[viewer] !== "unknown",
  });
}

export function canManageMember(
  state: MemberAuthority,
  viewer: string,
  key: string,
) {
  const role = state.roles[key];
  return (
    state.canManage &&
    key !== viewer &&
    !!role &&
    role !== "owner" &&
    role !== "unknown"
  );
}

/** Ownership permits removal only; it never grants role-edit authority. */
export function canRemoveMember(
  state: MemberAuthority,
  viewer: string,
  key: string,
  owner?: string,
) {
  return (
    canManageMember(state, viewer, key) ||
    (state.canRemoveOwnedAgent &&
      owner === viewer &&
      key !== viewer &&
      !!state.roles[key] &&
      state.roles[key] !== "owner" &&
      state.roles[key] !== "unknown")
  );
}

export function authorizeMemberChange(
  state: MemberAuthority,
  viewer: string,
  change: MemberChange,
  owner?: string,
) {
  if (
    !(change.role === "remove"
      ? canRemoveMember(state, viewer, change.pubkey, owner)
      : canManageMember(state, viewer, change.pubkey)) ||
    state.roles[change.pubkey] !== change.expectedRole ||
    (change.role !== "remove" &&
      (change.expectedRole === change.role ||
        !editableMemberRoles.includes(change.role)))
  )
    throw new Error(
      "Membership or permissions changed. Refresh members and roles before trying again.",
    );
}

export function memberChangeConfirmed(
  state: MemberAuthority,
  change: MemberChange,
) {
  return change.role === "remove"
    ? !(change.pubkey in state.roles)
    : state.roles[change.pubkey] === change.role;
}

export function memberAdministrationTemplate(
  channelId: string,
  change: MemberChange,
): EventTemplate {
  return {
    kind: change.role === "remove" ? 9001 : 9000,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags: [
      ["h", lifecycleChannelId(channelId)],
      ["p", change.pubkey],
      ...(change.role === "remove" ? [] : [["role", change.role]]),
    ],
  };
}

/** Purpose-bound broker admission; relay remains the authoritative ACL boundary. */
export function validateMemberAdministrationTemplate(
  event: EventTemplate,
  viewer: string,
) {
  const [h, p, role] = event?.tags ?? [];
  if (
    !event ||
    ![9000, 9001].includes(event.kind) ||
    event.content !== "" ||
    !Number.isSafeInteger(event.created_at) ||
    event.created_at < 0 ||
    !Array.isArray(event.tags) ||
    event.tags.length !== (event.kind === 9000 ? 3 : 2) ||
    h?.length !== 2 ||
    h[0] !== "h" ||
    p?.length !== 2 ||
    p[0] !== "p" ||
    !PUBKEY.test(p[1] ?? "") ||
    p[1] === viewer ||
    (event.kind === 9000 &&
      (role?.length !== 2 ||
        role[0] !== "role" ||
        !editableMemberRoles.some((value) => value === role[1])))
  )
    throw new Error("Invalid member administration command");
  lifecycleChannelId(h[1] ?? "");
}
