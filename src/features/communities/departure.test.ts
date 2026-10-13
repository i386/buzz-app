import { beforeEach, expect, it, vi } from "vitest";
import type { Communities, Membership } from "./service";
import {
  CommunityDepartureError,
  leaveCleanupFailureText,
  leaveCommunity,
  leftCommunityText,
  removeCommunityFromDevice,
  removedFromDeviceText,
} from "./departure";

const api = vi.hoisted(() => ({ requestLeave: vi.fn() }));
vi.mock("./api", async (actual) => ({
  ...(await actual<typeof import("./api")>()),
  requestLeave: api.requestLeave,
}));

const membership: Membership = {
  id: "https://acme.example",
  name: "Acme",
};

const viewer = "a".repeat(64);

const communities = (
  leave: Communities["leave"],
  selected: string | null = membership.id,
  currentViewer: string | (() => string) = viewer,
) =>
  ({
    snapshot: () => ({
      selected,
      viewer:
        typeof currentViewer === "function" ? currentViewer() : currentViewer,
    }),
    leave,
  }) as unknown as Communities;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  api.requestLeave.mockReset();
});

it("keeps device removal local and purges saved community state", async () => {
  const leave = vi.fn(async () => []);
  const result = await removeCommunityFromDevice(
    communities(leave),
    membership,
  );
  expect(api.requestLeave).not.toHaveBeenCalled();
  expect(leave).toHaveBeenCalledWith(membership.id, { purge: true });
  expect(result).toMatchObject({ membership, wasSelected: true, residue: [] });
});

it("records whether the forgotten community was selected before removal", async () => {
  const leave = vi.fn(async () => []);
  const result = await removeCommunityFromDevice(
    communities(leave, "https://other.example"),
    membership,
  );
  expect(result.wasSelected).toBe(false);
});

it.each([
  ["left", true],
  ["already-absent", true],
  ["access-revoked", false],
] as const)(
  "forgets locally after the relay settles as %s with purge %s",
  async (outcome, purge) => {
    api.requestLeave.mockResolvedValueOnce(outcome);
    const leave = vi.fn(async () => [{ store: "outbox", error: "blocked" }]);
    const result = await leaveCommunity(communities(leave), membership);
    expect(api.requestLeave).toHaveBeenCalledWith(membership.id);
    expect(leave).toHaveBeenCalledWith(membership.id, { purge });
    expect(result).toMatchObject({
      membership,
      wasSelected: true,
      outcome,
      residue: [{ store: "outbox", error: "blocked" }],
    });
  },
);

it("does not clean up device state when the viewer changes after relay settlement", async () => {
  const request = deferred<"left">();
  api.requestLeave.mockReturnValueOnce(request.promise);
  const leave = vi.fn(async () => []);
  let currentViewer = viewer;
  const pending = leaveCommunity(
    communities(leave, membership.id, () => currentViewer),
    membership,
  );
  expect(api.requestLeave).toHaveBeenCalledWith(membership.id);
  currentViewer = "b".repeat(64);
  request.resolve("left");
  const error = await pending.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CommunityDepartureError);
  expect(error).toMatchObject({
    phase: "device",
    outcome: "left",
  });
  expect(error).toHaveProperty(
    "reason",
    expect.objectContaining({
      message: "Account changed before device cleanup",
    }),
  );
  expect(leave).not.toHaveBeenCalled();
});

it("does not remove the device record when the relay owner cannot leave", async () => {
  api.requestLeave.mockRejectedValueOnce(
    new Error("invalid: relay owner cannot leave"),
  );
  const leave = vi.fn(async () => []);
  await expect(leaveCommunity(communities(leave), membership)).rejects.toEqual(
    expect.objectContaining({ phase: "relay" }),
  );
  expect(leave).not.toHaveBeenCalled();
});

it("wraps device removal failures without contacting the relay", async () => {
  const storage = new Error("storage");
  await expect(
    removeCommunityFromDevice(
      communities(
        vi.fn(async () => {
          throw storage;
        }),
      ),
      membership,
    ),
  ).rejects.toMatchObject({ phase: "device", reason: storage });
  expect(api.requestLeave).not.toHaveBeenCalled();
});

it("distinguishes relay and post-settlement device failures", async () => {
  api.requestLeave.mockRejectedValueOnce(new Error("offline"));
  await expect(
    leaveCommunity(communities(vi.fn()), membership),
  ).rejects.toMatchObject({ phase: "relay" });

  api.requestLeave.mockResolvedValueOnce("already-absent");
  const storage = new Error("storage");
  const deviceFailure = await leaveCommunity(
    communities(
      vi.fn(async () => {
        throw storage;
      }),
    ),
    membership,
  ).catch((error: unknown) => error);
  expect(deviceFailure).toBeInstanceOf(CommunityDepartureError);
  expect(deviceFailure).toMatchObject({
    phase: "device",
    reason: storage,
    outcome: "already-absent",
  });
});

it("uses outcome-specific success and cleanup-failure copy", () => {
  expect(removedFromDeviceText("Acme", false)).toBe(
    "Acme was removed from this device. Your membership wasn’t changed. You can add it again later.",
  );
  expect(removedFromDeviceText("Acme", true)).toBe(
    "Acme was removed from this device. Your membership wasn’t changed. You can add it again later. Some saved data couldn’t be cleared.",
  );
  expect(leftCommunityText("Acme", "left", false)).toBe("Left Acme.");
  expect(leftCommunityText("Acme", "already-absent", false)).toBe(
    "You were no longer a member of Acme, so it was removed from this device.",
  );
  expect(leftCommunityText("Acme", "access-revoked", true)).toBe(
    "You’re currently banned from Acme, so the leave was refused. It was removed from this device and can be added again by its URL if access is restored. Some saved data couldn’t be cleared.",
  );
  expect(
    leaveCleanupFailureText(
      "Acme",
      new Error("Quota exceeded."),
      "already-absent",
    ),
  ).toBe(
    "The relay no longer had a membership for Acme, but this device couldn’t finish removing it (Quota exceeded). Try again.",
  );
  expect(
    leaveCleanupFailureText(
      "Acme",
      new Error("Storage locked."),
      "access-revoked",
    ),
  ).toBe(
    "The leave was refused because you’re currently banned from Acme, and this device couldn’t finish removing it (Storage locked). Try again.",
  );
});
