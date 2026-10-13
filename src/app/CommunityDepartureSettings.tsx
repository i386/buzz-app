import { useEffect, useRef, useState } from "react";
import type { Communities, Membership } from "../features/communities/service";
import {
  CommunityDepartureError,
  deviceRemovalFailureText,
  leaveCleanupFailureText,
  leaveCommunity,
  leaveCommunityFailureText,
  leftCommunityText,
  removeCommunityFromDevice,
  removedFromDeviceText,
} from "../features/communities/departure";
import { AlertDialog } from "../shared/design-system/ui/AlertDialog";
import { Button } from "../shared/design-system/ui/Button";
import { Header } from "../shared/design-system/ui/Header";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { useToastNotification } from "../shared/design-system/ui/Toast";

type Intent = "remove" | "leave";

export function CommunityDepartureSettings({
  communities,
  community,
  onRemoved,
  onPending,
}: {
  communities: Communities;
  community: Membership;
  onRemoved(): void;
  onPending?: (pending: boolean) => void;
}) {
  const notify = useToastNotification();
  const [intent, setIntent] = useState<Intent | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(false);
  const removeButton = useRef<HTMLButtonElement>(null);
  const leaveButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = async () => {
    if (!intent || busy.current) return;
    const viewer = communities.snapshot().viewer;
    busy.current = true;
    setPending(true);
    onPending?.(true);
    try {
      if (intent === "leave") {
        const result = await leaveCommunity(communities, community);
        // Removing the selected community can unmount this page before cleanup
        // finishes. Its result still belongs in the host toast, not a new form.
        if (communities.snapshot().viewer === viewer)
          notify(
            leftCommunityText(
              community.name,
              result.outcome,
              result.residue.length > 0,
            ),
            result.outcome === "left" ? "success" : "info",
          );
      } else {
        const result = await removeCommunityFromDevice(communities, community);
        if (communities.snapshot().viewer === viewer)
          notify(
            removedFromDeviceText(community.name, result.residue.length > 0),
            "success",
          );
      }
      if (mounted.current && communities.snapshot().viewer === viewer) {
        setIntent(null);
        onRemoved();
      }
    } catch (error) {
      if (!mounted.current || communities.snapshot().viewer !== viewer) return;
      const departure =
        error instanceof CommunityDepartureError ? error : undefined;
      notify(
        intent === "remove"
          ? deviceRemovalFailureText(community.name, departure?.reason ?? error)
          : departure?.phase === "device"
            ? leaveCleanupFailureText(
                community.name,
                departure.reason,
                departure.outcome,
              )
            : leaveCommunityFailureText(
                community.name,
                departure?.reason ?? error,
              ),
        "error",
      );
      setIntent(null);
    } finally {
      busy.current = false;
      if (mounted.current) {
        setPending(false);
        onPending?.(false);
      }
    }
  };
  return (
    <section aria-labelledby="leave-community-title">
      <Header
        id="leave-community-title"
        title="Leave or remove"
        subtitle="Remove community from Buzz on this device or leave community completely."
      />
      <SettingsGroup>
        <PreferenceRow
          title="Remove from this device"
          subtitle="Removes community connection and data from Buzz on this device only. Your membership won't change."
          trailing={
            <Button
              ref={removeButton}
              type="button"
              disabled={pending}
              onClick={() => setIntent("remove")}
            >
              Remove from this device
            </Button>
          }
        />
        <PreferenceRow
          title="Leave community"
          subtitle="Ends your membership and removes community from this device. Rejoining may require a new invite."
          trailing={
            <Button
              ref={leaveButton}
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => setIntent("leave")}
            >
              Leave community
            </Button>
          }
        />
      </SettingsGroup>
      {intent && (
        <AlertDialog
          title={
            intent === "leave"
              ? `Leave ${community.name}?`
              : `Remove ${community.name} from this device?`
          }
          description={
            intent === "leave"
              ? "This will send a leave request to the community’s relay and remove it from this device. You may need a new invite to rejoin."
              : "The community connection and any saved drafts or data will be removed from Buzz on this device."
          }
          pending={pending}
          finalFocus={intent === "leave" ? leaveButton : removeButton}
          onClose={() => setIntent(null)}
          actions={
            <>
              <Button disabled={pending} onClick={() => setIntent(null)}>
                Cancel
              </Button>
              <Button
                variant={intent === "leave" ? "destructive" : "primary"}
                loading={pending}
                onClick={() => void run()}
              >
                {intent === "leave"
                  ? "Leave community"
                  : "Remove from this device"}
              </Button>
            </>
          }
        />
      )}
    </section>
  );
}
