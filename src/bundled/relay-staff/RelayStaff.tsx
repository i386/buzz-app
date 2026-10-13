import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Header } from "../../shared/design-system/ui/Header";
import {
  CheckCircleIcon,
  CircleNotchIcon,
  WarningCircleIcon,
} from "../../shared/design-system/icons";
import { Console, SCREENS, type Screen } from "./Console";
import { createSession, SessionProvider } from "./session";
import type { Access, Staff } from "./staff";

export function RelayStaff({
  staff,
  screen,
  active,
}: {
  staff: Staff;
  screen: Screen;
  active(): boolean;
}) {
  useSyncExternalStore(staff.subscribe, () => staff.visible());
  const contextKey = useSyncExternalStore(staff.subscribe, staff.contextKey);
  const context = staff.context();
  const access = useSyncExternalStore(staff.subscribe, () =>
    context ? staff.access(context) : null,
  );
  // Settings has usually probed already; this covers an entry opened without it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by identity, host and relay
  useEffect(() => {
    if (context && active()) void staff.probe(context);
  }, [staff, contextKey]);

  if (!context) return null;
  return (
    <div className="flex flex-col gap-4">
      <Header
        title={SCREENS[screen].title}
        subtitle={`${SCREENS[screen].subtitle} ${new URL(context.origin).host}.`}
        actions={
          <Button
            size="sm"
            loading={access?.state === "probing"}
            onClick={() => void staff.probe(context, true)}
          >
            Check again
          </Button>
        }
      />
      <AccessStatus access={access} />
      {access?.state === "authorized" && (
        <Authorized
          key={contextKey}
          staff={staff}
          screen={screen}
          access={access}
        />
      )}
    </div>
  );
}

function Authorized({
  staff,
  screen,
  access,
}: {
  staff: Staff;
  screen: Screen;
  access: Extract<Access, { state: "authorized" }>;
}) {
  const context = staff.context();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the panel is keyed by identity, host and relay; only the role changes here
  const session = useMemo(
    () => context && createSession(staff, context, access.probe),
    [staff, access.probe],
  );
  if (!session) return null;
  return (
    <SessionProvider value={session}>
      <Console screen={screen} />
    </SessionProvider>
  );
}

function AccessStatus({ access }: { access: Access | null }) {
  if (access?.state !== "authorized")
    return (
      <p className="flex items-center gap-2 text-body-sm text-secondary">
        <CircleNotchIcon className="animate-spin" /> Checking your access…
      </p>
    );
  const { role, authMode } = access.probe;
  if (authMode === "disabled")
    return (
      <p
        className="flex items-center gap-2 text-body-sm text-warning"
        role="status"
      >
        <WarningCircleIcon /> Admin auth is disabled on this relay. The console
        is read-only; taking action requires BUZZ_ADMIN_AUTH=nip98.
      </p>
    );
  return (
    <p
      className="flex items-center gap-2 text-body-sm text-success"
      role="status"
    >
      <CheckCircleIcon /> Connected as {role ?? "staff"}
    </p>
  );
}
