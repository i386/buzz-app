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
 * Discovery and authorization for the selected relay. Discovery is unsigned
 * and drives the Settings entry; the signed probe only runs from `probe()`,
 * which the open card calls. Access is remembered per (signer, origin).
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

  /** Settings visibility: shown only when the relay advertises an admin host. */
  const visible = (): boolean | "pending" | "error" => {
    const origin = discovery?.origin;
    if (!origin || origin === "pending") return origin ? "pending" : false;
    return origin === "error" ? "error" : true;
  };

  return {
    backend,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    visible,
    /**
     * The Staff entry: operators only. The role comes from the signed probe
     * an open entry sends, so Staff stays hidden until one has run.
     */
    operatorVisible(): boolean | "pending" | "error" {
      const shown = visible();
      if (shown !== true) return shown;
      const now = context();
      const known = now && access.get(key(now));
      return known?.state === "authorized" && known.probe.role === "operator";
    },
    ensure() {
      retained++;
      discover();
      return () => void retained--;
    },
    /** Re-run discovery when the selected relay or identity changes. */
    refresh() {
      if (retained) discover();
      // An identity switch on the same relay changes the context, not discovery.
      emit();
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
    /**
     * Signed probe. Reuses a remembered result unless `force`; a forced
     * re-probe keeps the current result on screen until the new one lands.
     */
    async probe(context: StaffContext, force = false) {
      const id = key(context);
      if (!force && access.has(id)) return;
      if (!access.has(id) || access.get(id)?.state !== "authorized") {
        access.set(id, { state: "probing" });
        emit();
      }
      const outcome = await backend.request(context, { route: "probe" });
      const next = toAccess(outcome);
      // An unchanged role keeps the same session, so its reads do not rerun.
      const previous = access.get(id);
      if (sameAccess(previous, next)) return;
      access.set(id, next);
      emit();
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
