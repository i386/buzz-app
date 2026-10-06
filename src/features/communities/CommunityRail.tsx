import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  CircleDashedIcon,
  GlobeIcon,
  PlusIcon,
} from "../../shared/design-system/icons/index";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { nativeIdentityEnabled } from "../identity/service";
import type { SettingsCards } from "../settings/service";
import type { OpenTarget } from "../navigation/targets";
import { readErrorKind } from "../relay/errors";
import { communityFromScope } from "../relay/gifs";
import { useRelayConnection } from "../relay/react";
import { inspectProfile, requestLeave, type LeaveOutcome } from "./api";
import type { Communities, Membership } from "./service";
import { CommunityDialog } from "./CommunityDialog";
import type { InviteLink } from "./invite-link";
import {
  CommunityRailItem,
  MEMBERSHIP_SECTION,
  type CommunityAccess,
} from "./CommunityRailItem";
import { communityDestination } from "./destination";
import type { PurgeFailure } from "./device-state";
import type { SyncStatus } from "./known-communities";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import styles from "./Communities.module.css";
import { fetchCommunityIcon } from "./community-icon";
import { useCommunityRole } from "./useCommunityRole";

const noSubscription = () => () => {};

/** Shell navigation only: selecting a community remains owned by Communities. */
export function CommunityRail({
  communities,
  invite,
  onInviteClose,
  onSelect,
  onOpenTarget,
  settingsCards,
}: {
  communities: Communities;
  invite?: (InviteLink & { requestId: number }) | undefined;
  onInviteClose?: ((requestId: number) => void) | undefined;
  settingsCards?: Pick<SettingsCards, "subscribe" | "has"> | undefined;
  onSelect?: ((id: string | null) => void) | undefined;
  /** Menu destinations (Invites, Community settings) open through the host's navigation. */
  onOpenTarget?: ((target: OpenTarget) => void) | undefined;
}) {
  const [joining, setJoining] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const wasJoining = useRef(false);
  useEffect(() => {
    if (wasJoining.current && !joining) addRef.current?.focus();
    wasJoining.current = joining;
  }, [joining]);
  // The confirm dialog belongs to the rail so it outlives the item it removes.
  const [leaving, setLeaving] = useState<{
    membership: Membership;
    pending: boolean;
  } | null>(null);
  const personalRef = useRef<HTMLButtonElement>(null);
  const buttons = useRef(new Map<string, HTMLElement>());
  const wasLeaving = useRef<Membership | null>(null);
  const notify = useToastNotification();
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  useEffect(() => {
    // Focus returns to the community when it is still saved (cancel or
    // failure). Once it is gone, focus follows the selection: the community
    // still selected, or Personal space where a left selection now lands.
    const previous = wasLeaving.current;
    if (previous && !leaving)
      (
        buttons.current.get(previous.id) ??
        (client.selected ? buttons.current.get(client.selected) : undefined) ??
        personalRef.current
      )?.focus();
    wasLeaving.current = leaving?.membership ?? null;
  }, [leaving, client.selected]);
  // The compatibility reader follows selection, so this is only ever the
  // selected community's session; inactive communities stay unacquired.
  const connection = useRelayConnection(communities.relay);
  const selectedOrigin = client.selected
    ? communityDestination(client.selected).url
    : null;
  const session =
    connection.status === "ready" &&
    connection.scope &&
    communityFromScope(connection.scope) === selectedOrigin
      ? connection.session
      : undefined;
  // Roles come from the relay-signed roster, as the Membership card derives
  // them, verified against the authority the selected session already holds
  // rather than a second session contract request. Skip the read where no
  // item could use it.
  const membershipAvailable = useSyncExternalStore(
    settingsCards?.subscribe ?? noSubscription,
    // Registration is not authorization: the rail refreshes the role on menu
    // open even if Settings last cached a non-admin role.
    () => settingsCards?.has(MEMBERSHIP_SECTION) ?? false,
  );
  const invites = !!onOpenTarget && membershipAvailable;
  const role = useCommunityRole(invites ? session : undefined, client.viewer);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [access, setAccess] = useState<Record<string, CommunityAccess>>({});
  // The access check runs in the native app, whose host reads relays over
  // HTTP. The development broker holds lazy, scoped relay connections and has
  // no lighter route, so there the answer stays unknown, as the account sync
  // the check serves is native-only too.
  const probing = nativeIdentityEnabled();
  // Each pass reads a saved community at most once. Coming back online starts
  // a full pass; coming back to the window re-checks only what last refused
  // or could not be reached, so alt-tabbing is not a round trip per community.
  const [pass, setPass] = useState({ count: 0, full: true });
  const checked = useRef(new Map<string, number>());
  const answers = useRef(new Map<string, CommunityAccess>());
  useEffect(() => {
    if (!probing) return;
    const online = () =>
      setPass(({ count }) => ({ count: count + 1, full: true }));
    const visible = () => {
      if (document.visibilityState === "visible")
        setPass(({ count }) => ({ count: count + 1, full: false }));
    };
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [probing]);
  const membershipIds = client.memberships
    .map((membership) => membership.id)
    .join("\n");
  useEffect(() => {
    if (client.status !== "ready" || !client.relayAvailable) return;
    const controller = new AbortController();
    // Icon discovery and the access check are optional and never open a
    // session. Reserve browser connections for foreground work even when saved
    // relays hold their NIP-11 responses indefinitely, and skip communities
    // this pass has read, so a leave or a synced addition rereads no others.
    const ids = membershipIds.split("\n").filter((id) => {
      if (!id || checked.current.get(id) === pass.count) return false;
      if (pass.full || answers.current.get(id) !== "ok") return true;
      checked.current.set(id, pass.count);
      return false;
    });
    let next = 0;
    const workers = Array.from(
      { length: Math.min(2, ids.length) },
      async () => {
        while (next < ids.length && !controller.signal.aborted) {
          const id = ids[next++];
          if (id === undefined) break;
          try {
            const icon = await fetchCommunityIcon(id, controller.signal);
            if (icon !== undefined && !controller.signal.aborted)
              setIcons((previous) => ({ ...previous, [id]: icon }));
          } catch {
            // Unreachable relay: retain saved icon or initials.
          }
          if (controller.signal.aborted) return;
          if (probing) {
            // One signed read proves this identity can still read the relay.
            // Its answer is shown on the item, never acted on: a community
            // restored from the account stays saved whether the relay refuses
            // the viewer or cannot be reached.
            let state: CommunityAccess = "ok";
            try {
              await inspectProfile(id);
            } catch (error) {
              state =
                readErrorKind(error) === "denied" ? "denied" : "unavailable";
            }
            if (controller.signal.aborted) return;
            answers.current.set(id, state);
            setAccess((previous) => ({ ...previous, [id]: state }));
          }
          checked.current.set(id, pass.count);
        }
      },
    );
    void Promise.all(workers);
    return () => controller.abort();
  }, [client.status, client.relayAvailable, membershipIds, pass, probing]);
  // Only a running sync owner can say why uploads wait. Where none runs (no
  // Builderlab plugin, no configured service, a browser build) the queue is
  // not a promise anyone will keep, so nothing is shown.
  const unsynced =
    !!client.syncStatus &&
    (client.sync.outbox.length > 0 ||
      client.syncStatus.phase === "needs-binding");
  const reason = client.syncStatus ? syncReason(client.syncStatus) : "";
  const select = (id: string | null) => {
    if (onSelect) onSelect(id);
    else communities.select(id);
  };
  /** Publish first; the device forgets the community only once the relay has
   * released the membership, reports it never held one, or refuses the viewer
   * as banned. Anything else keeps the membership and the menu item for a
   * retry. */
  const leave = async () => {
    if (!leaving || leaving.pending) return;
    const { membership } = leaving;
    setLeaving({ membership, pending: true });
    let outcome: LeaveOutcome;
    try {
      outcome = await requestLeave(membership.id);
    } catch (error) {
      notify(leaveFailureText(membership.name, error), "error");
      setLeaving(null);
      return;
    }
    // From here a retry cannot reach the relay's membership; only this device
    // can still fail, and its failures read differently from a lost connection.
    let residue: PurgeFailure[];
    try {
      // A banned viewer is still a member on the relay (bans can be timed or
      // lifted), so the device keeps that origin's drafts and reading
      // positions for a later re-add instead of purging them.
      residue = await communities.leave(membership.id, {
        purge: outcome !== "access-revoked",
      });
    } catch (error) {
      // Only the device record failed to save, before anything changed: the
      // community is still in the rail, and leaving it again reaches the
      // already-absent path.
      notify(cleanupFailureText(membership.name, error), "error");
      setLeaving(null);
      return;
    }
    // The community is gone from this device whatever happens next, so only
    // the service call above may read as a cleanup failure. A left selection
    // already fell back to Personal space in the service; the host lands it
    // from the snapshot, as it does a removal synced from another device.
    notify(
      leftText(membership.name, outcome, residue.length > 0),
      outcome === "left" ? "success" : "info",
    );
    setLeaving(null);
  };
  return (
    <>
      <nav aria-label="Communities" className={styles.rail}>
        <Tooltip content="Personal space" side="right">
          <IconButton
            ref={personalRef}
            size="md"
            aria-label="Personal space"
            aria-current={client.selected === null ? "true" : undefined}
            data-selected={client.selected === null || undefined}
            icon={<GlobeIcon size={22} strokeWidth={1.5} aria-hidden="true" />}
            onClick={() => select(null)}
          />
        </Tooltip>
        {client.memberships.map((membership) => {
          const selected = client.selected === membership.id;
          return (
            <CommunityRailItem
              key={membership.id}
              membership={membership}
              icon={icons[membership.id] ?? membership.icon}
              access={access[membership.id]}
              selected={selected}
              viewer={client.viewer}
              session={selected ? session : undefined}
              manager={selected && invites && role.manager}
              leaving={
                leaving?.membership.id === membership.id && leaving.pending
              }
              onSelect={select}
              onOpenTarget={onOpenTarget}
              // Roles can change while the app runs; opening the selected
              // community's menu re-reads the roster it gates on.
              onMenuOpen={selected && invites ? role.refresh : undefined}
              onLeave={(target) =>
                setLeaving({ membership: target, pending: false })
              }
              buttonRef={(node) => {
                if (node) buttons.current.set(membership.id, node);
                else buttons.current.delete(membership.id);
              }}
            />
          );
        })}
        <Tooltip content="Add a community" side="right">
          <IconButton
            ref={addRef}
            size="md"
            aria-label="Add a community"
            icon={<PlusIcon size={22} aria-hidden="true" />}
            onClick={() => setJoining(true)}
          />
        </Tooltip>
        {unsynced && (
          <Tooltip content={reason} side="right">
            <span role="status" className={styles.syncState}>
              {/* The quietest status glyph the system already uses; the
                  final icon is the designer's call. */}
              <CircleDashedIcon size={14} aria-hidden="true" />
              <span className="sr-only">
                Community list not synced. {reason}
              </span>
            </span>
          </Tooltip>
        )}
      </nav>
      {(joining || invite) && (
        <CommunityDialog
          key={invite ? invite.requestId : "manual"}
          communities={communities}
          mode="join"
          invite={invite}
          onJoined={(id) => select(id)}
          close={() => {
            setJoining(false);
            if (invite) onInviteClose?.(invite.requestId);
          }}
        />
      )}
      {leaving && (
        <AlertDialog
          title={`Leave ${leaving.membership.name}?`}
          description={`This sends a leave request to the community’s relay, then removes ${leaving.membership.name} from this device along with its saved drafts and reading positions. Rejoining may need a new invite.`}
          pending={leaving.pending}
          onClose={() => setLeaving(null)}
          // The rail's own effect places focus once the dialog is gone.
          finalFocus={false}
          actions={
            <>
              <Button
                disabled={leaving.pending}
                onClick={() => setLeaving(null)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={leaving.pending}
                onClick={() => void leave()}
              >
                Leave community
              </Button>
            </>
          }
        />
      )}
    </>
  );
}

/** Why the account's community list and this device's differ right now. With
 * the sync owner signed out, signing in is the step. */
function syncReason(status: SyncStatus) {
  switch (status.phase) {
    case "needs-binding":
      return "Link this device’s identity to your Builderlab account in Hosted communities to sync your community list.";
    case "syncing":
      return "Syncing your community list…";
    case "pending":
      return "Changes to your community list are waiting to sync.";
    case "error":
      return (
        status.error ??
        "Couldn’t sync your community list. Check your connection and try again."
      );
    default:
      return "Sign in to Builderlab to sync your community list.";
  }
}

/** What the relay settled, plus whether any saved data outlived the purge. The
 * banned answer promises nothing about how long the ban lasts. */
function leftText(name: string, outcome: LeaveOutcome, residue: boolean) {
  const settled =
    outcome === "already-absent"
      ? `You were no longer a member of ${name}, so it was removed from this device.`
      : outcome === "access-revoked"
        ? `You’re currently banned from ${name}, so the leave was refused. It was removed from this device and can be added again by its URL if access is restored.`
        : `Left ${name}.`;
  return residue ? `${settled} Some saved data couldn’t be cleared.` : settled;
}

/** The relay has answered, and only the device record failed to save, before
 * anything changed. The storage error is named so a store that never saves
 * reads as such, rather than as the same retry promise on every attempt. */
function cleanupFailureText(name: string, error: unknown) {
  // The service wraps the storage error as the cause; prefer its own words.
  const reason = (
    wordsOf(error instanceof Error ? error.cause : undefined) || wordsOf(error)
  ).replace(/\.$/, "");
  return `Left ${name}, but this device couldn’t finish cleaning up${
    reason ? ` (${reason})` : ""
  }. Leave it again to finish.`;
}

const wordsOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";

/** Relay-authored refusals the viewer can act on read verbatim-ish; everything
 * else, including timeouts and unreachable relays, keeps one retry message. */
function leaveFailureText(name: string, error: unknown) {
  const reason = error instanceof Error ? error.message : "";
  if (reason === "invalid: relay owner cannot leave")
    return `The relay owner can’t leave ${name}.`;
  return `Couldn’t leave ${name}. Check your connection and try again.`;
}
