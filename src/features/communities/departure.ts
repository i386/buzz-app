import { requestLeave, type LeaveOutcome } from "./api";
import type { PurgeFailure } from "./device-state";
import type { Communities, Membership } from "./service";

export class CommunityDepartureError extends Error {
  constructor(
    readonly phase: "relay" | "device",
    readonly reason: unknown,
    readonly outcome?: LeaveOutcome,
  ) {
    super(reason instanceof Error ? reason.message : String(reason), {
      cause: reason,
    });
  }
}

export type DeviceRemovalResult = Readonly<{
  membership: Membership;
  wasSelected: boolean;
  residue: readonly PurgeFailure[];
}>;
export type CommunityLeaveResult = DeviceRemovalResult &
  Readonly<{ outcome: LeaveOutcome }>;

async function forgetCommunityOnDevice(
  communities: Communities,
  membership: Membership,
  purge: boolean,
): Promise<DeviceRemovalResult> {
  const wasSelected = communities.snapshot().selected === membership.id;
  const residue = await communities.leave(membership.id, { purge });
  return { membership, wasSelected, residue };
}

export async function removeCommunityFromDevice(
  communities: Communities,
  membership: Membership,
): Promise<DeviceRemovalResult> {
  try {
    return await forgetCommunityOnDevice(communities, membership, true);
  } catch (error) {
    throw new CommunityDepartureError("device", error);
  }
}

/** Publishes first. Local cleanup starts only after the relay has settled the
 * membership, reported it absent, or denied the viewer as banned. */
export async function leaveCommunity(
  communities: Communities,
  membership: Membership,
): Promise<CommunityLeaveResult> {
  const viewer = communities.snapshot().viewer;
  let outcome: LeaveOutcome;
  try {
    outcome = await requestLeave(membership.id);
  } catch (error) {
    throw new CommunityDepartureError("relay", error);
  }
  try {
    if (communities.snapshot().viewer !== viewer)
      throw new Error("Account changed before device cleanup");
    return {
      ...(await forgetCommunityOnDevice(
        communities,
        membership,
        // A banned viewer remains a relay member and may regain access later.
        outcome !== "access-revoked",
      )),
      outcome,
    };
  } catch (error) {
    throw new CommunityDepartureError("device", error, outcome);
  }
}

export function removedFromDeviceText(name: string, residue: boolean) {
  const result = `${name} was removed from this device. Your membership wasn’t changed. You can add it again later.`;
  return residue ? `${result} Some saved data couldn’t be cleared.` : result;
}

/** What the relay settled, plus whether any saved data outlived the purge. */
export function leftCommunityText(
  name: string,
  outcome: LeaveOutcome,
  residue: boolean,
) {
  const settled =
    outcome === "already-absent"
      ? `You were no longer a member of ${name}, so it was removed from this device.`
      : outcome === "access-revoked"
        ? `You’re currently banned from ${name}, so the leave was refused. It was removed from this device and can be added again by its URL if access is restored.`
        : `Left ${name}.`;
  return residue ? `${settled} Some saved data couldn’t be cleared.` : settled;
}

export function deviceRemovalFailureText(name: string, error: unknown) {
  const reason =
    wordsOf(error instanceof Error ? error.cause : undefined) || wordsOf(error);
  return `Couldn’t remove ${name} from this device${reason ? ` (${reason.replace(/\.$/, "")})` : ""}. Try again.`;
}

/** The relay has answered; only the device record failed before it changed. */
export function leaveCleanupFailureText(
  name: string,
  error: unknown,
  outcome: LeaveOutcome = "left",
) {
  const reason = (
    wordsOf(error instanceof Error ? error.cause : undefined) || wordsOf(error)
  ).replace(/\.$/, "");
  const details = reason ? ` (${reason})` : "";
  if (outcome === "already-absent")
    return `The relay no longer had a membership for ${name}, but this device couldn’t finish removing it${details}. Try again.`;
  if (outcome === "access-revoked")
    return `The leave was refused because you’re currently banned from ${name}, and this device couldn’t finish removing it${details}. Try again.`;
  return `Left ${name}, but this device couldn’t finish cleaning up${details}. Leave it again to finish.`;
}

export function leaveCommunityFailureText(name: string, error: unknown) {
  const reason = error instanceof Error ? error.message : "";
  if (reason === "invalid: relay owner cannot leave")
    return `The relay owner can’t leave ${name}.`;
  return `Couldn’t leave ${name}. Check your connection and try again.`;
}

const wordsOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
