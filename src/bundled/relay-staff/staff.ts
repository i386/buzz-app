import type {
  ProbeDto,
  RelayStaffBackend,
  StaffContext,
  StaffFailure,
} from "../../features/relay-staff/contract";
import { unsupported } from "../../features/relay-staff/contract";
import { createWrites, type Writes } from "./writes";

/** The selected community relay and the identity that would sign for it. */
export type StaffTarget = { relay: string; signer: string };

export type Access =
  | { state: "probing" }
  | { state: "authorized"; probe: ProbeDto }
  | { state: "denied" }
  | { state: "notAdminApi" }
  | { state: "unreachable"; failure: StaffFailure };

type Discovery = {
  relay: string;
  origin: string | null | "pending" | "error";
};

/**
 * Discovery and authorization for the selected relay. While Settings is open,
 * each signing context is probed once, so only staff see the entries; opening
 * Settings again re-probes. Access is remembered per (signer, origin).
 */
export function createStaff(
  backend: RelayStaffBackend,
  target: () => StaffTarget | null,
) {
  const listeners = new Set<() => void>();
  const access = new Map<string, Access>();
  const writes = new Map<string, Writes>();
  let discovery: Discovery | null = null;
  let retained = 0;
  /** Contexts probed since Settings last opened. */
  const checked = new Set<string>();
  /** Latest probe per access key; an older one's result is dropped. */
  const attempts = new Map<string, number>();
  const emit = () => {
    for (const listener of listeners) listener();
  };

  const discover = () => {
    const relay = target()?.relay ?? null;
    if (!backend.available || !relay) {
      if (discovery) {
        discovery = null;
        emit();
      }
      return;
    }
    if (discovery?.relay === relay && discovery.origin !== "error") return;
    const current: Discovery = { relay, origin: "pending" };
    discovery = current;
    emit();
    backend.discover(relay).then(
      (origin) => settle(current, origin),
      () => settle(current, "error"),
    );
  };
  const settle = (current: Discovery, origin: Discovery["origin"]) => {
    if (discovery !== current) return;
    discovery = { relay: current.relay, origin };
    emit();
    check();
  };

  /** The signing context for the selected relay, once discovery has an origin. */
  const context = (): StaffContext | null => {
    const now = target();
    const origin = discovery?.origin;
    if (!now || discovery?.relay !== now.relay || !origin) return null;
    if (origin === "pending" || origin === "error") return null;
    return { relay: now.relay, origin, signer: now.signer };
  };
  const key = (context: StaffContext) => `${context.signer} ${context.origin}`;
  const contextKey = () => {
    const now = context();
    return now && `${key(now)} ${now.relay}`;
  };

  /** The Settings check: one probe per context while Settings stays open. */
  const check = () => {
    const now = context();
    const id = contextKey();
    if (!retained || !now || !id || checked.has(id)) return;
    checked.add(id);
    void probe(now, true);
  };

  /** Settings visibility: shown only to staff of the advertised admin host. */
  const visible = (): boolean | "pending" | "error" => {
    const origin = discovery?.origin;
    if (!origin || origin === "pending") return origin ? "pending" : false;
    if (origin === "error") return "error";
    const now = context();
    const known = now && access.get(key(now));
    if (!known || known.state === "probing") return "pending";
    if (known.state === "authorized") return true;
    return known.state === "unreachable" ? "error" : false;
  };

  /**
   * Signed probe. Reuses a remembered result unless `force`; a forced
   * re-probe keeps the current result on screen until the new one lands.
   */
  const probe = async (context: StaffContext, force = false) => {
    const id = key(context);
    if (!force && access.has(id)) return;
    if (!access.has(id) || access.get(id)?.state !== "authorized") {
      access.set(id, { state: "probing" });
      emit();
    }
    const attempt = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, attempt);
    const outcome = await backend.request(context, { route: "probe" });
    if (attempts.get(id) !== attempt) return;
    const next = toAccess(outcome);
    // An unchanged role keeps the same session, so its reads do not rerun.
    const previous = access.get(id);
    if (sameAccess(previous, next)) return;
    access.set(id, next);
    emit();
  };

  return {
    backend,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    visible,
    /** The Staff entry: operators only. */
    operatorVisible(): boolean | "pending" | "error" {
      const shown = visible();
      if (shown !== true) return shown;
      const now = context();
      const known = now && access.get(key(now));
      return known?.state === "authorized" && known.probe.role === "operator";
    },
    ensure() {
      // Opening Settings re-checks every context, so a demotion shows.
      if (retained++ === 0) checked.clear();
      discover();
      check();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        retained--;
      };
    },
    /** Re-run discovery and the check when the relay or identity changes. */
    refresh() {
      if (retained) discover();
      // An identity switch on the same relay changes the context, not discovery.
      emit();
      check();
    },
    context,
    /** Snapshot that changes whenever the signer, admin host or relay does. */
    contextKey,
    /**
     * Writes for exactly this signer, admin host and relay. Kept in memory
     * for the app session, outside every view and authorization state, so a
     * held write is resent unchanged and never under another identity or host.
     */
    writes(context: StaffContext) {
      const id = `${key(context)} ${context.relay}`;
      let held = writes.get(id);
      if (!held) {
        held = createWrites();
        writes.set(id, held);
      }
      return held;
    },
    access(context: StaffContext) {
      return access.get(key(context)) ?? null;
    },
    probe,
    /**
     * Automatic re-check (a 401 or 403, or a change to your own staff entry). Skipped once Settings has closed
     * or another identity, admin host or relay is selected.
     */
    reprobe(context: StaffContext) {
      const now = contextKey();
      if (!retained || now !== `${key(context)} ${context.relay}`) return;
      void probe(context, true);
    },
  };
}
export type Staff = ReturnType<typeof createStaff>;

function toAccess(
  outcome: Awaited<ReturnType<RelayStaffBackend["request"]>>,
): Access {
  if (outcome.ok)
    return { state: "authorized", probe: outcome.value as ProbeDto };
  const failure = outcome.failure;
  if (failure.authLost) return { state: "denied" };
  if (unsupported(failure)) return { state: "notAdminApi" };
  return { state: "unreachable", failure };
}

function sameAccess(a: Access | undefined, b: Access) {
  if (a?.state !== "authorized" || b.state !== "authorized") return false;
  const keys = Object.keys(b.probe) as (keyof ProbeDto)[];
  return keys.every((key) => a.probe[key] === b.probe[key]);
}
