import { useEffect, useState, useSyncExternalStore } from "react";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { personalGroups } from "../../features/channel-templates/setup";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { FolderSimpleIcon } from "../../shared/design-system/icons";
import { Header } from "../../shared/design-system/ui/Header";
import { Button } from "../../shared/design-system/ui/Button";
import { ChannelGroupsDialog } from "./ChannelGroupsDialog";
import { useSidebarPreferences } from "./useSidebarPreferences";

export function ChannelSetupSettings({
  relay,
  active,
}: {
  relay: RelayData;
  active(): boolean;
}) {
  const connection = useRelayConnection(relay);
  return (
    <section aria-label="Personal groups settings">
      <Header title="Personal groups" />
      {connection.status === "ready" ? (
        <GroupSettings
          key={`${connection.scope}:${connection.generation}`}
          session={connection.session}
          active={active}
        />
      ) : (
        <p role="status">
          Choose a connected community to manage personal groups.
        </p>
      )}
    </section>
  );
}
function GroupSettings({
  session,
  active,
}: {
  session: RelaySession;
  active(): boolean;
}) {
  const kit = useSyncExternalStore(
    session.channelKit.subscribe,
    session.channelKit.snapshot,
  );
  const preferences = useSidebarPreferences(session.sidebarPreferences);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    session.channelKit.ensure();
  }, [session]);
  const groups = personalGroups(kit.entries)?.record.value;
  const empty =
    kit.status === "ready" &&
    (groups?.type === "groups"
      ? groups.groups.length === 0
      : preferences.status === "ready" &&
        preferences.data?.sections.length === 0);
  const manageAction = (
    <Button
      disabled={!session.channelKit.available || kit.status !== "ready"}
      onClick={() => {
        if (active()) setOpen(true);
      }}
    >
      Manage personal groups
    </Button>
  );
  return (
    <>
      <EmptyState
        icon={<FolderSimpleIcon />}
        title={empty ? "No personal groups yet" : "Organize your channels"}
        description="Group channels privately in your sidebar. Members and Canvas stay unchanged."
        action={manageAction}
      />
      {kit.status !== "ready" && (
        <p role="status">
          {kit.error ?? "Saved groups are not ready."}{" "}
          <Button onClick={() => void session.channelKit.refresh()}>
            Reload groups
          </Button>
        </p>
      )}
      {open && (
        <ChannelGroupsDialog
          open={open}
          onOpenChange={setOpen}
          kit={session.channelKit}
          legacy={preferences.data}
          active={active}
        />
      )}
    </>
  );
}
