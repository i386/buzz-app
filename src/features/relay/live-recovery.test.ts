import { expect, it } from "vitest";
import { isTransientFailure, ReadError } from "./errors";
import { liveRecoveryStatus, type LiveRecoveryView } from "./live-recovery";

const healthy: LiveRecoveryView = {
  status: "connected",
  routes: [
    { id: "channel:a", channelId: "a", status: "live", replay: "unknown" },
  ],
  roster: { state: "verified" },
  heads: [],
};
const route = (error: string) => ({
  ...healthy,
  routes: [
    {
      id: "channel:a",
      channelId: "a",
      status: "error",
      replay: "unknown",
      error,
    },
  ] as const,
});

it("classifies only failures a retry can fix as transient", () => {
  expect(
    isTransientFailure(new ReadError("unavailable", "Relay read failed (502)")),
  ).toBe(true);
  expect(isTransientFailure(new ReadError("cancelled", "Read cancelled"))).toBe(
    true,
  );
  expect(isTransientFailure(new TypeError("Failed to fetch"))).toBe(true);
  expect(
    isTransientFailure(new DOMException("Timed out", "TimeoutError")),
  ).toBe(true);
  // Native IPC rejects with the host's plain transport strings.
  expect(isTransientFailure("Relay request could not be confirmed")).toBe(true);
  // A context wrapper keeps its cause's classification.
  expect(
    isTransientFailure(
      new Error("Preference decode: Local decoder failed (HTTP 502)", {
        cause: new ReadError("unavailable", "Local decoder failed (HTTP 502)"),
      }),
    ),
  ).toBe(true);
  expect(
    isTransientFailure(
      new Error("Preference decode: Local decoder failed (HTTP 400)", {
        cause: new ReadError(
          "invalid-response",
          "Local decoder failed (HTTP 400)",
        ),
      }),
    ),
  ).toBe(false);
  expect(
    isTransientFailure(new ReadError("denied", "Relay read failed (403)")),
  ).toBe(false);
  expect(isTransientFailure(new ReadError("invalid-response", "Bad"))).toBe(
    false,
  );
  expect(
    isTransientFailure(
      new Error(
        "Recipe catalog reached its read limit; no partial catalog will be used",
      ),
    ),
  ).toBe(false);
  expect(isTransientFailure("Invalid outgoing signature")).toBe(false);
});

it("lets recovery own transient live failures and leaves the rest visible", () => {
  expect(liveRecoveryStatus(healthy)).toBe("settled");
  expect(liveRecoveryStatus({ ...healthy, status: "retrying" })).toBe("failed");
  expect(liveRecoveryStatus(route("error: relay busy"))).toBe("failed");
  expect(liveRecoveryStatus(route("rate-limited: slow down"))).toBe("failed");
  // Reasons outside the known needs-action set are outages until shown
  // otherwise.
  expect(
    liveRecoveryStatus(route("temporary: fixture stream interrupted")),
  ).toBe("failed");
  expect(liveRecoveryStatus(route("Relay closed live subscription"))).toBe(
    "failed",
  );
  expect(liveRecoveryStatus(route("auth-required: sign in"))).toBe("settled");
  expect(
    liveRecoveryStatus(
      route("Unsupported live cooldown; automatic setup stopped"),
    ),
  ).toBe("settled");
  expect(
    liveRecoveryStatus({
      ...healthy,
      roster: { state: "error", transient: true },
    }),
  ).toBe("failed");
  expect(
    liveRecoveryStatus({
      ...healthy,
      heads: [{ state: "error", transient: true }],
    }),
  ).toBe("failed");
  expect(liveRecoveryStatus({ ...healthy, previews: "suspended" })).toBe(
    "failed",
  );
  expect(liveRecoveryStatus({ ...healthy, previews: "checking" })).toBe("busy");
  // Denials, terminal sign-in errors and deterministic failures need someone
  // to act; retrying them forever would hide their message.
  expect(liveRecoveryStatus(route("restricted: not a channel member"))).toBe(
    "settled",
  );
  expect(liveRecoveryStatus(route("Relay supplied invalid live traffic"))).toBe(
    "settled",
  );
  expect(
    liveRecoveryStatus({
      ...healthy,
      status: "error",
      error: "Relay rejected live authentication",
    }),
  ).toBe("settled");
  // A terminal socket leaves its routes pending; nothing is in flight.
  expect(
    liveRecoveryStatus({
      ...healthy,
      status: "error",
      routes: [
        {
          id: "channel:a",
          channelId: "a",
          status: "pending",
          replay: "unknown",
        },
      ],
    }),
  ).toBe("settled");
  expect(liveRecoveryStatus({ ...healthy, roster: { state: "error" } })).toBe(
    "settled",
  );
  expect(liveRecoveryStatus({ ...healthy, heads: [{ state: "error" }] })).toBe(
    "settled",
  );
});
