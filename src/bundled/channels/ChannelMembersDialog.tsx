import { archiveHides } from "../../features/relay/identity-archives";
import { motion, useReducedMotion } from "motion/react";
import { Button as BaseButton } from "@base-ui/react/button";
import referenceStyles from "../../shared/InlineReference.module.css";
import { npubEncode } from "nostr-tools/nip19";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import type { Agents, Team } from "../../features/agents/service";
import { useAgentChoices } from "../../features/agents/use-choices";
import { useIdentityNames } from "../../features/identity-names/react";
import { usePresenceStatus } from "../../features/presence/react";
import { profileTarget } from "../../features/profiles/target";
import { matchPerson } from "../../features/search/person-match";
import { MatchedLabel } from "../../features/search/MatchedLabel";
import { useSearchHighlight } from "../../features/search/use-search-highlight";
import styles from "./ChannelMembersDialog.module.css";
import { MEMBER_SEARCH_PAGE_SIZE } from "../../features/channel-members/search";
import {
  canManageMember,
  canRemoveMember,
  type MemberChange,
} from "../../features/channel-members/administration-protocol";
import { canAddMembers } from "../../features/channel-members/members";
import {
  formatPublicKey,
  publicKeyLabels,
} from "../../shared/identity/public-key";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import { Select } from "../../shared/design-system/ui/Select";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import {
  ArrowsClockwiseIcon,
  CircleNotchIcon,
  UsersIcon,
} from "../../shared/design-system/icons";
import { MemberRow, useMemberAdministration } from "./MemberAdministration";
import { useMemberSearch } from "./useMemberSearch";
import { useMemberOwners } from "./useMemberOwners";

/** How a name matches typed text: the shared person name rule, the same as
 * mentions and New message. */
const typedMatch = (name: string, needle: string) =>
  needle ? matchPerson(name, needle) : undefined;

/** Typed text, lowercased. A context, so a query change redraws only the
 * names and not every memoized row. */
const TypedText = createContext("");

function MemberName({ name }: { name: string }) {
  const needle = useContext(TypedText);
  return (
    <MatchedLabel
      label={name}
      positions={typedMatch(name, needle)?.positions}
    />
  );
}

/** Mounted rows share the same bounded presence owner as message bylines. */
function MemberAvatar({
  session,
  pubkey,
  name,
  picture,
  agent,
  descriptionId,
}: {
  session: RelaySession;
  pubkey: string;
  name: string;
  picture: string | undefined;
  agent: boolean;
  descriptionId: string;
}) {
  const presence = usePresenceStatus(session.presence, pubkey);
  return (
    <>
      <Avatar
        alt=""
        fallback={name}
        src={picture ? session.media(picture, "small") : undefined}
        size="default"
        shape={agent ? "squircle" : "circle"}
        statusBadge={presence === "unknown" ? undefined : presence}
      />
      <span className="sr-only" id={descriptionId}>
        {presence === "unknown" ? "" : `Presence: ${presence}`}
      </span>
    </>
  );
}

/** Query and loading changes must not rebuild unchanged row/menu trees. */
const MemberIdentityRow = memo(function MemberIdentityRow({
  session,
  channelId,
  pubkey,
  name,
  keyLabel,
  adding,
  picture,
  isAgent,
  roleLabel,
  archived,
  ownerName,
  verifiedOwner,
  onChange,
  target,
  clickable,
  ownerTarget,
  ownerClickable,
  descriptionId,
  reducedMotion,
  input,
  scrollport,
  focusedAdd,
  openProfile,
  onSendMessage,
  messagePending,
  add,
  busy,
  addDisabled,
  highlightId,
  highlighted,
  onHighlightMove,
}: {
  session: RelaySession;
  channelId: string;
  pubkey: string;
  name: string;
  keyLabel: string | undefined;
  adding: boolean;
  picture: string | undefined;
  isAgent: boolean;
  roleLabel: string | undefined;
  archived: boolean;
  ownerName: string;
  verifiedOwner: string | undefined;
  onChange(change: MemberChange): void;
  target: string | undefined;
  clickable: boolean;
  ownerTarget: string | undefined;
  ownerClickable: boolean;
  descriptionId: string;
  reducedMotion: boolean | null;
  input: React.RefObject<HTMLElement | null>;
  scrollport: React.RefObject<HTMLElement | null>;
  focusedAdd: React.RefObject<{
    key: string;
    button: HTMLButtonElement;
  } | null>;
  openProfile(destination: string | undefined): boolean;
  onSendMessage: ((key: string) => Promise<void>) | undefined;
  messagePending: boolean;
  add(key: string): Promise<void>;
  busy: boolean;
  addDisabled: boolean;
  /** Set on rows the search highlight can choose. */
  highlightId?: string | undefined;
  highlighted?: boolean | undefined;
  onHighlightMove?: ((key: string, event: PointerEvent) => void) | undefined;
}) {
  const npub = npubEncode(pubkey);

  const expanded = {
    height: "auto",
    marginTop: "var(--space-half)",
    opacity: 1,
  };
  const avatar = (
    <MemberAvatar
      session={session}
      pubkey={pubkey}
      name={name}
      picture={picture}
      agent={!!isAgent}
      descriptionId={descriptionId}
    />
  );
  const viewProfile = () => openProfile(target);
  const identity = (
    <div className={styles.profileContent}>
      {clickable && (
        <div className={styles.profileHitTarget}>
          <NavigationItem
            label=""
            icon={avatar}
            aria-label={`Open profile for ${name} (${keyLabel})${isAgent ? ", agent" : ""}${adding ? ", not in this channel" : roleLabel ? `, ${roleLabel}` : ""}${!adding && archived ? ", archived" : ""}`}
            aria-describedby={descriptionId}
            onClick={viewProfile}
          />
        </div>
      )}
      <div
        className={styles.staticProfile}
        data-profile-link={clickable || undefined}
      >
        {!clickable && avatar}
        <span className="min-w-0 flex-1">
          <span className={styles.identity}>
            <span className={styles.identityName}>
              <span className={`${styles.name} text-body-sm`}>
                {adding ? <MemberName name={name} /> : name}
                {pubkey === session.viewer ? " (you)" : ""}
              </span>
            </span>
            {ownerName && (
              <span className={styles.manager}>
                {" managed by "}
                {ownerClickable ? (
                  <BaseButton
                    className={referenceStyles.link}
                    aria-label={`Open owner profile: ${ownerName}`}
                    onClick={() => openProfile(ownerTarget)}
                  >
                    {ownerName}
                  </BaseButton>
                ) : (
                  ownerName
                )}
              </span>
            )}
          </span>
          <motion.span
            className={styles.metadata}
            variants={{
              rest: { height: 0, marginTop: 0, opacity: 0 },
              revealed: expanded,
              focused: { ...expanded, transition: { duration: 0 } },
            }}
            transition={{
              duration: reducedMotion ? 0 : 0.14,
              ease: [0.23, 1, 0.32, 1],
            }}
          >
            <span className={styles.metadataContent}>
              <span
                className={`${styles.publicKey} text-mono text-body-sm text-subtle`}
                aria-hidden="true"
              >
                {`${npub.slice(0, 11)}…${npub.slice(-6)}`}
              </span>
            </span>
          </motion.span>
        </span>
      </div>
    </div>
  );
  return (
    <MemberRow
      session={session}
      channelId={channelId}
      pubkey={pubkey}
      name={name}
      verifiedOwner={verifiedOwner}
      onChange={onChange}
      returnFocus={input}
      scrollport={scrollport}
      onViewProfile={clickable ? viewProfile : undefined}
      onViewOwnerProfile={
        ownerClickable ? () => openProfile(ownerTarget) : undefined
      }
      onSendMessage={
        onSendMessage ? () => void onSendMessage(pubkey) : undefined
      }
      messagePending={messagePending}
      highlight={
        highlightId && onHighlightMove
          ? {
              id: highlightId,
              active: !!highlighted,
              onPointerMove: (event) => onHighlightMove(pubkey, event),
            }
          : undefined
      }
      invitationAction={
        adding ? (
          <span className={styles.addAction}>
            <Button
              variant="prominent"
              size="xs"
              aria-label={`Add ${name} (${keyLabel})`}
              aria-disabled={busy || undefined}
              disabled={addDisabled}
              onBlur={(event) => {
                if (focusedAdd.current?.button === event.currentTarget)
                  focusedAdd.current = null;
              }}
              onClick={(event) => {
                if (busy) return;
                if (document.activeElement === event.currentTarget)
                  focusedAdd.current = {
                    key: pubkey,
                    button: event.currentTarget,
                  };
                void add(pubkey);
              }}
            >
              {busy ? "Adding…" : "Add"}
            </Button>
          </span>
        ) : undefined
      }
    >
      {identity}
    </MemberRow>
  );
});

type MemberNavigation = {
  onOpenConversation?: ((channelId: string) => boolean) | undefined;
  canOpenLink?: ((target: string) => boolean) | undefined;
  onOpenLink?:
    | ((target: string, returnFocus?: HTMLElement) => boolean)
    | undefined;
};

export function ChannelMembersButton({
  session,
  channelId,
  canOpenLink,
  onOpenLink,
  onOpenConversation,
  presentation,
  agents,
}: {
  session: RelaySession;
  channelId: string;
  agents?: Agents | undefined;
  presentation?:
    | { open: boolean; onOpenChange(open: boolean): void }
    | undefined;
} & MemberNavigation) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = presentation ? presentation.open : localOpen;
  const setOpen = presentation ? presentation.onOpenChange : setLocalOpen;
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={trigger}
        size="sm"
        aria-label="Channel members"
        title="Channel members"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        icon={<UsersIcon size="1rem" aria-hidden="true" />}
      />
      {open && (
        <ChannelMembersDialog
          key={channelId}
          session={session}
          channelId={channelId}
          canOpenLink={canOpenLink}
          onOpenLink={onOpenLink}
          onOpenConversation={onOpenConversation}
          {...(agents ? { agents } : {})}
          close={() => setOpen(false)}
          trigger={trigger}
        />
      )}
    </>
  );
}

/** Members are shared relay truth; only search and in-progress presentation belong to this dialog. */
const noTeams = () => () => {};
const noSnapshot = () => undefined;

/** A team of the owner's agents, added to the channel with one button. */
function TeamRow({
  team,
  names,
  busy,
  disabled,
  onAdd,
}: {
  team: Team;
  /** The members not yet in the channel. */
  names: readonly string[];
  busy: boolean;
  disabled: boolean;
  onAdd(): void;
}) {
  return (
    <li className={styles.member}>
      <div className={styles.profileContent}>
        <div className={styles.staticProfile}>
          <Avatar alt="" fallback={team.name} size="small" shape="squircle" />
          <span className="min-w-0 flex-1">
            <span className={`${styles.name} text-body-sm`}>
              <MemberName name={team.name} />
            </span>
            <span className="block truncate text-caption text-subtle">
              {names.join(", ")}
            </span>
          </span>
        </div>
      </div>
      <span className={styles.addAction}>
        <Button
          variant="prominent"
          size="xs"
          aria-label={`Add team ${team.name}`}
          aria-disabled={busy || undefined}
          disabled={disabled}
          onClick={() => {
            if (!busy) onAdd();
          }}
        >
          {busy ? "Adding…" : "Add team"}
        </Button>
      </span>
    </li>
  );
}

export function ChannelMembersDialog({
  session,
  channelId,
  close,
  trigger,
  canOpenLink,
  onOpenLink,
  onOpenConversation,
  agents,
}: {
  session: RelaySession;
  channelId: string;
  close(): void;
  trigger: React.RefObject<HTMLButtonElement | null>;
  agents?: Agents;
} & MemberNavigation) {
  const reducedMotion = useReducedMotion();
  const presenceId = useId();
  const openingDestination = useRef(false);
  const messagePending = useRef(false);
  const [openingMessage, setOpeningMessage] = useState(false);
  const [messageError, setMessageError] = useState("");
  const input = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [changeError, setChangeError] = useState<{
    session: RelaySession;
    channelId: string;
    message: string;
  }>();
  const [intent, setIntent] = useState<{
    session: RelaySession;
    channelId: string;
    change: MemberChange;
  }>();
  const selection =
    intent?.session === session && intent.channelId === channelId
      ? intent.change
      : undefined;
  const chooseChange = useCallback(
    (change: MemberChange) => {
      setChangeError(undefined);
      setIntent({ session, channelId, change });
    },
    [session, channelId],
  );
  const previousSelection = useRef(selection);
  useLayoutEffect(() => {
    if (selection !== previousSelection.current)
      (selection ? cancel.current : input.current)?.focus();
    previousSelection.current = selection;
  }, [selection]);
  const scrollport = useRef<HTMLElement>(null);
  const focusedAdd = useRef<{ key: string; button: HTMLButtonElement } | null>(
    null,
  );
  const lifetime = useRef<AbortController>(undefined);
  const [query, setQuery] = useState("");
  const [selectedRole, setSelectedRole] = useState("All");
  const additions = useSyncExternalStore(
    session.memberAdditions.subscribe,
    session.memberAdditions.snapshot,
    session.memberAdditions.snapshot,
  ).filter((item) => item.channelId === channelId);
  const busy = new Set(
    additions.filter((item) => item.pending).map((item) => item.pubkey),
  );
  const errors = Object.fromEntries(
    additions
      .filter((item) => item.error)
      .map((item) => [item.pubkey, item.error]),
  );
  const [notice, setNotice] = useState("");
  const [rosterError, setRosterError] = useState("");
  const [nameError, setNameError] = useState("");
  const [rosterBusy, setRosterBusy] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [namesSettledFor, setNamesSettledFor] = useState<{
    session: RelaySession;
    memberKey: string;
  }>();
  const [agentsBusy, setAgentsBusy] = useState(false);
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const archives = useSyncExternalStore(
    session.archives.subscribe,
    session.archives.snapshot,
    session.archives.snapshot,
  );
  const agentChoices = useAgentChoices(session);
  const agentsSnapshot = useSyncExternalStore(
    agents?.subscribe ?? noTeams,
    agents?.snapshot ?? noSnapshot,
    agents?.snapshot ?? noSnapshot,
  );
  const resolveName = useIdentityNames(session.names);
  const channel =
    list.channels.find((item) => item.id === channelId) ??
    session.channels.get?.(channelId);
  const canAdd = canAddMembers(session, channel);
  const text = query.trim();
  const [invitationPage, setInvitationPage] = useState({
    text,
    size: MEMBER_SEARCH_PAGE_SIZE,
  });
  if (invitationPage.text !== text)
    setInvitationPage({ text, size: MEMBER_SEARCH_PAGE_SIZE });
  // biome-ignore lint/correctness/useExhaustiveDependencies: destination changes retire addition notices.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setAgentsBusy(false);
    messagePending.current = false;
    setOpeningMessage(false);
    setMessageError("");
    return () => {
      controller.abort();
      lifetime.current = undefined;
    };
  }, [session, channelId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly retries the roster read.
  useEffect(() => {
    let current = true;
    setRosterBusy(true);
    setRosterError("");
    void session
      .read([{ kinds: [39002], "#d": [channelId], limit: 1 }], { fresh: true })
      .then(
        (events) => {
          if (
            current &&
            !events.some(
              (event) =>
                event.kind === 39002 &&
                event.tags.some(
                  ([tag, value]) => tag === "d" && value === channelId,
                ),
            )
          )
            setRosterError(
              "The member list could not be confirmed. Try again.",
            );
        },
        () => {
          if (current)
            setRosterError("The member list could not load. Try again.");
        },
      )
      .finally(() => {
        if (current) setRosterBusy(false);
      });
    void session.archives.ensure();
    return () => {
      current = false;
    };
  }, [session, channelId, refresh]);
  const memberKey = channel?.members?.join(":") ?? "";
  const administration = useMemberAdministration(
    session,
    channelId,
    memberKey,
    !!channel && !channel.cached,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh retries missing names with the other dialog reads.
  useEffect(() => {
    setNameError("");
    setNamesSettledFor(undefined);
    if (!memberKey) {
      setNamesSettledFor({ session, memberKey });
      return;
    }
    let current = true;
    void session.profiles
      .ensure(memberKey.split(":"), "foreground")
      .catch(() => {
        if (current)
          setNameError(
            "Some names could not load. Public keys still identify members. Try again.",
          );
      })
      .finally(() => {
        if (current) setNamesSettledFor({ session, memberKey });
      });
    return () => {
      current = false;
    };
  }, [session, memberKey, refresh]);
  const namesBusy =
    namesSettledFor?.session !== session ||
    namesSettledFor?.memberKey !== memberKey;
  // Reopen immediately only when the session already has a resolved presentation.
  // This is a reveal latch, not a second roster/profile/permission cache.
  const [revealedFor, setRevealedFor] = useState(() =>
    channel &&
    !channel.cached &&
    (administration.status === "ready" || administration.status === "error") &&
    (channel.members ?? []).every((key) => profiles.has(key))
      ? session
      : undefined,
  );
  const rolesSettled =
    administration.status === "ready" ||
    administration.status === "error" ||
    !channel ||
    channel.cached;
  useEffect(() => {
    // The authority hook may have started a new roster's read in this effect
    // flush. Do not reveal using the previous render's settled role snapshot.
    const status = session.memberAdministration.snapshot(channelId).status;
    if (!rosterBusy && !namesBusy && rolesSettled && status !== "loading")
      setRevealedFor(session);
  }, [session, channelId, rosterBusy, namesBusy, rolesSettled]);
  const initialLoading = revealedFor !== session;
  const known = useMemo(
    () =>
      new Map(agentChoices.identities.map((agent) => [agent.pubkey, agent])),
    [agentChoices.identities],
  );
  const members = new Set(channel?.members ?? []);
  const archived = new Set(archives.archived);
  const label = (key: string, fallback?: string) =>
    resolveName(
      key,
      profiles.get(key)?.name ??
        fallback ??
        formatPublicKey(key) ??
        "Unknown member",
    );
  // Filters the fully loaded member list.
  const matches = (key: string, name: string) =>
    `${name} ${key} ${npubEncode(key)}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());
  // People to add use the shared name rule, like the relay's people page; a
  // whole key or npub finds its owner.
  const addable = (key: string, ...names: (string | undefined)[]) => {
    const typed = query.trim().toLowerCase();
    return (
      names.some((name) => name && matchPerson(name, query)) ||
      typed === key ||
      typed === npubEncode(key)
    );
  };
  const currentMembers = [...members].sort(
    (a, b) => label(a).localeCompare(label(b)) || a.localeCompare(b),
  );
  const groups = ["Owners", "Admins", "Members", "Agents"].map((name) => {
    const keys = currentMembers.filter((key) => {
      const role = administration.authority.roles[key];
      const group =
        role === "owner"
          ? "Owners"
          : role === "admin"
            ? "Admins"
            : known.has(key) || profiles.get(key)?.isAgent
              ? "Agents"
              : "Members";
      return group === name;
    });
    return {
      name,
      count: keys.length,
      keys: keys.filter((key) => matches(key, label(key))),
    };
  });
  const presentGroups = groups.filter((group) => group.count > 0);
  const roleFilter =
    query.length === 0 &&
    presentGroups.length > 1 &&
    presentGroups.some((group) => group.name === selectedRole)
      ? selectedRole
      : "All";
  if (
    !initialLoading &&
    administration.status !== "loading" &&
    selectedRole !== roleFilter
  )
    setSelectedRole(roleFilter);
  const filteredGroups = groups.filter(
    (group) => roleFilter === "All" || group.name === roleFilter,
  );
  const search = useMemberSearch(session, query, canAdd);
  const candidates = new Map(
    search.people.map((person) => [person.pubkey, person]),
  );
  if (query.trim())
    for (const agent of agentChoices.identities) {
      if (addable(agent.pubkey, label(agent.pubkey, agent.name), agent.name))
        candidates.set(agent.pubkey, {
          pubkey: agent.pubkey,
          name: agent.name,
          isAgent: true,
        });
    }
  const needle = text.toLowerCase();
  // The relay ranks each page exact, then prefix, then other. Rank merged
  // agents the same way; the stable sort keeps the relay's order within a rank.
  const candidateRank = (person: { pubkey: string; name: string }) =>
    typedMatch(label(person.pubkey, person.name), needle)?.tier ?? 4;
  const available = [...candidates.values()]
    .filter(
      (person) =>
        !members.has(person.pubkey) &&
        !archiveHides(session.archives, person.pubkey, session.viewer),
    )
    .sort((a, b) => candidateRank(a) - candidateRank(b));
  // Known agents supplement the server page, not its rendering bound. Keep all
  // matches reachable through the existing More action without mounting them all.
  const invitationSize =
    invitationPage.text === text
      ? invitationPage.size
      : MEMBER_SEARCH_PAGE_SIZE;
  const visibleCandidates =
    roleFilter === "All" ? available.slice(0, invitationSize) : [];
  const moreCandidates = available.length > invitationSize;
  const offering = !initialLoading && canAdd && roleFilter === "All" && !!text;
  // Keep roster ownership observed while filtering; retiring the view clears
  // valid hints and forces every retained agent row through recovery renders.
  const agentKeys = [
    ...new Set([
      ...currentMembers.filter(
        (key) => known.has(key) || profiles.get(key)?.isAgent,
      ),
      ...visibleCandidates
        .filter(
          (person) =>
            person.isAgent ||
            known.has(person.pubkey) ||
            profiles.get(person.pubkey)?.isAgent,
        )
        .map((person) => person.pubkey),
    ]),
  ]
    .sort()
    .join(":");
  const ownership = useMemberOwners(session, agentKeys, refresh);
  const changePermitted =
    selection &&
    administration.status === "ready" &&
    administration.authority.roles[selection.pubkey] ===
      selection.expectedRole &&
    administration.operation?.status !== "pending" &&
    administration.operation?.status !== "uncertain" &&
    (selection.role === "remove"
      ? canRemoveMember(
          administration.authority,
          session.viewer ?? "",
          selection.pubkey,
          ownership.owners.get(selection.pubkey),
        )
      : canManageMember(
          administration.authority,
          session.viewer ?? "",
          selection.pubkey,
        ));
  const refreshing =
    ownership.busy ||
    rosterBusy ||
    administration.status === "loading" ||
    namesBusy ||
    search.loading ||
    agentChoices.pending ||
    agentsBusy ||
    archives.status === "loading";
  const mutationPending =
    busy.size > 0 || administration.operation?.status === "pending";
  const administrationError =
    administration.status !== "loading" &&
    administration.operation?.status !== "pending" &&
    (administration.error ||
      (changeError?.session === session &&
        changeError.channelId === channelId &&
        changeError.message));
  const refreshMembers = () => {
    if (refreshing || mutationPending) return;
    setChangeError(undefined);
    setRosterBusy(true);
    setRefresh((value) => value + 1);
    setInvitationPage({ text, size: MEMBER_SEARCH_PAGE_SIZE });
    void session.memberAdministration.refresh(channelId).catch(() => {});
    // Native inventory retains ready data during refresh, so its snapshot alone
    // does not expose every in-flight read.
    const signal = lifetime.current?.signal;
    setAgentsBusy(true);
    void session.agentChoices.refresh().finally(() => {
      if (!signal?.aborted) setAgentsBusy(false);
    });
    void session.archives.refresh();
    search.refresh();
  };
  // Teams match by name; each adds its members in this community not here yet.
  const teamNames = new Map(
    (agentsSnapshot?.agents ?? []).map((agent) => [agent.pubkey, agent.name]),
  );
  const teams = (agentsSnapshot?.teams ?? []).flatMap((team) => {
    const missing = team.members.filter(
      (key) => teamNames.has(key) && !members.has(key),
    );
    return missing.length && matchPerson(team.name, query)
      ? [{ team, missing }]
      : [];
  });
  const keys = publicKeyLabels([...members, ...candidates.keys()]);
  // A confirmed addition replaces its focused Add button with a member row.
  // DOM removal does not emit blur, so restore focus only if it was not moved elsewhere.
  useLayoutEffect(() => {
    const previous = focusedAdd.current;
    if (!previous || !memberKey.split(":").includes(previous.key)) return;
    focusedAdd.current = null;
    if (
      document.activeElement === previous.button ||
      document.activeElement === document.body
    )
      input.current?.focus();
  }, [memberKey]);
  const add = useCallback(
    async (key: string) => {
      const signal = lifetime.current?.signal;
      if (!signal) return;
      setNotice("");
      try {
        await session.memberAdditions.add(channelId, key);
        if (!signal.aborted)
          setNotice(
            `${session.names.resolve(key, session.profiles.snapshot().get(key)?.name ?? formatPublicKey(key) ?? "Unknown member")} is in the channel.`,
          );
      } catch {
        // Session-owned recovery remains visible if this dialog closes and reopens.
      }
    },
    [session, channelId],
  );

  const addTeam = useCallback(
    async (team: Team, missing: readonly string[]) => {
      const signal = lifetime.current?.signal;
      if (!signal) return;
      setNotice("");
      const added = await Promise.allSettled(
        missing.map((key) => session.memberAdditions.add(channelId, key)),
      );
      // A failed member shows its own error and Retry below.
      if (!signal.aborted && added.every((item) => item.status === "fulfilled"))
        setNotice(`${team.name} is in the channel.`);
    },
    [session, channelId],
  );

  // Typed text highlights the first person not in the channel, so Enter adds
  // them. Rows keep their own buttons; the highlight only marks one of them.
  const highlight = useSearchHighlight({
    query,
    keys: offering ? visibleCandidates.map((person) => person.pubkey) : [],
    onChoose: (key) => {
      if (!busy.has(key) && !rosterBusy && !rosterError) void add(key);
    },
  });
  const latestHighlight = useRef(highlight);
  latestHighlight.current = highlight;
  // Stable, so a highlight move does not rebuild every memoized row.
  const moveHighlight = useCallback(
    (key: string, event: PointerEvent) =>
      latestHighlight.current.rowProps(key).onPointerMove(event),
    [],
  );
  const highlightedPerson = visibleCandidates.find(
    (person) => person.pubkey === highlight.active,
  );

  const searchAgents = search.people
    .filter((person) => person.isAgent)
    .map((person) => person.pubkey)
    .sort()
    .join(":");
  const openMessage = useCallback(
    async (key: string) => {
      const signal = lifetime.current?.signal;
      if (
        !signal ||
        signal.aborted ||
        messagePending.current ||
        !onOpenConversation ||
        !session.directMessages.available ||
        !session.viewer ||
        key === session.viewer ||
        known.has(key) ||
        profiles.get(key)?.isAgent ||
        searchAgents.split(":").includes(key) ||
        administration.authority.roles[key] === "bot"
      )
        return;
      messagePending.current = true;
      setOpeningMessage(true);
      setMessageError("");
      try {
        const destination = await session.directMessages.open([key], signal);
        if (signal.aborted) return;
        // The destination owns focus; closing Members must not return it to this header.
        openingDestination.current = true;
        if (onOpenConversation(destination)) close();
        else {
          openingDestination.current = false;
          setMessageError(
            "Could not open the conversation. Try Send message again.",
          );
        }
      } catch (reason) {
        openingDestination.current = false;
        if (!signal.aborted)
          setMessageError(
            reason instanceof Error
              ? reason.message
              : "Could not open the conversation. Try Send message again.",
          );
      } finally {
        if (!signal.aborted) {
          messagePending.current = false;
          setOpeningMessage(false);
        }
      }
    },
    [
      session,
      onOpenConversation,
      close,
      profiles,
      known,
      searchAgents,
      administration.authority.roles,
    ],
  );

  const openProfile = useCallback(
    (destination: string | undefined) => {
      if (!destination || !canOpenLink?.(destination)) return false;
      openingDestination.current = true;
      if (onOpenLink?.(destination, trigger.current ?? undefined)) {
        close();
        return true;
      }
      openingDestination.current = false;
      return false;
    },
    [canOpenLink, onOpenLink, trigger, close],
  );
  const row = (
    key: string,
    name: string,
    adding: boolean,
    picture?: string,
    agent?: boolean,
  ) => {
    const role = administration.authority.roles[key];
    const isAgent = !!(agent || known.has(key) || profiles.get(key)?.isAgent);
    const owner = isAgent ? ownership.owners.get(key) : undefined;
    const target = profileTarget(key);
    const ownerTarget = owner ? profileTarget(owner) : undefined;
    return (
      <MemberIdentityRow
        key={key}
        session={session}
        channelId={channelId}
        pubkey={key}
        name={name}
        keyLabel={keys.get(key)}
        adding={adding}
        picture={picture ?? profiles.get(key)?.picture}
        isAgent={isAgent}
        archived={archived.has(key)}
        roleLabel={
          isAgent && role === "bot"
            ? "member"
            : (role ??
              (administration.status === "idle" ||
              administration.status === "loading"
                ? undefined
                : "Role unverified"))
        }
        verifiedOwner={owner}
        onChange={chooseChange}
        ownerName={
          owner
            ? `${label(owner)}${owner === session.viewer ? " (you)" : ""}`
            : ""
        }
        target={target}
        clickable={!!target && !!onOpenLink && !!canOpenLink?.(target)}
        ownerTarget={ownerTarget}
        ownerClickable={
          !!ownerTarget && !!onOpenLink && !!canOpenLink?.(ownerTarget)
        }
        descriptionId={`${presenceId}-${key}`}
        reducedMotion={reducedMotion}
        input={input}
        scrollport={scrollport}
        focusedAdd={focusedAdd}
        openProfile={openProfile}
        onSendMessage={
          !isAgent &&
          role !== "bot" &&
          key !== session.viewer &&
          session.viewer &&
          session.directMessages.available &&
          onOpenConversation
            ? openMessage
            : undefined
        }
        messagePending={openingMessage}
        add={add}
        busy={busy.has(key)}
        addDisabled={rosterBusy || !!rosterError}
        highlightId={adding ? highlight.rowId(key) : undefined}
        highlighted={adding && highlight.active === key}
        onHighlightMove={adding ? moveHighlight : undefined}
      />
    );
  };
  const selectedAgent =
    selection &&
    (known.has(selection.pubkey) || profiles.get(selection.pubkey)?.isAgent);
  const removalTarget = selectedAgent ? "agent" : "member";
  const selectedPicture = selection && profiles.get(selection.pubkey)?.picture;
  const dialog = (
    <Dialog
      open
      dismissOnOutsideClick
      step={
        selection
          ? { key: "confirmation", scale: 0.95 }
          : { key: "members", scale: 1.05 }
      }
      onOpenChange={(open) => {
        if (!open) {
          if (selection) setIntent(undefined);
          else close();
        }
      }}
      title={
        selection
          ? selection.role === "remove"
            ? `Remove ${removalTarget} from channel`
            : "Change member role?"
          : "Channel members"
      }
      height={selection ? "content" : "stable"}
      bodyLayout={selection ? "flow" : "flex"}
      headerGap={selection?.role === "remove" ? "compact" : "default"}
      footerGap={selection?.role === "remove" ? "compact" : "default"}
      description={
        selection ? (
          <span className="flex min-w-0 items-center gap-2">
            <Avatar
              alt=""
              fallback={label(selection.pubkey)}
              src={
                selectedPicture
                  ? session.media(selectedPicture, "small")
                  : undefined
              }
              size="small"
              shape={selectedAgent ? "squircle" : "circle"}
            />
            <span className="min-w-0 break-words">
              {label(selection.pubkey)}
            </span>
          </span>
        ) : (
          channel?.name
        )
      }
      closeLabel={
        selection ? "Back to channel members" : "Close channel members"
      }
      actions={
        selection && (
          <>
            <Button
              variant="subtle"
              ref={cancel}
              onClick={() => setIntent(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant={
                selection.role === "remove" ? "destructive" : "prominent"
              }
              disabled={!changePermitted}
              onClick={() => {
                if (!changePermitted) return;
                setIntent(undefined);
                void session.memberAdministration
                  .run(channelId, selection)
                  .catch((error: unknown) => {
                    setChangeError({
                      session,
                      channelId,
                      message:
                        error instanceof Error ? error.message : String(error),
                    });
                  });
              }}
            >
              {selection.role === "remove"
                ? `Remove ${removalTarget}`
                : `Make ${selection.role}`}
            </Button>
          </>
        )
      }
      headerActions={
        !selection && (
          <IconButton
            variant="ghost"
            size="compact"
            aria-label="Refresh member data"
            title="Refresh member data"
            aria-busy={refreshing}
            disabled={refreshing || mutationPending}
            focusableWhenDisabled
            onClick={refreshMembers}
            icon={
              <ArrowsClockwiseIcon
                size={16}
                aria-hidden="true"
                className={
                  refreshing && !initialLoading
                    ? "motion-safe:animate-spin"
                    : undefined
                }
              />
            }
          />
        )
      }
      initialFocus={input}
      finalFocus={() => (openingDestination.current ? false : trigger.current)}
    >
      {selection ? (
        selection.role !== "remove" && (
          <p className="text-body-sm">
            {`Change this member’s role from ${selection.expectedRole} to ${selection.role}. ${selection.role === "admin" ? "Admins can manage this channel and its members." : "This changes their authority in this channel."}`}
          </p>
        )
      ) : (
        <div className={styles.layout}>
          <div className="flex shrink-0 items-center">
            <div className="min-w-0 flex-1">
              <SearchField
                inputRef={input}
                label="Search people and agents"
                placeholder={
                  canAdd ? "Add people and agents" : "Search members"
                }
                value={query}
                onValueChange={(value) => {
                  setQuery(value);
                  if (value.length > 0) setSelectedRole("All");
                }}
                onKeyDown={(event) => {
                  highlight.keyDown(event);
                }}
                maxLength={256}
              />
              <span className="sr-only" role="status">
                {highlightedPerson
                  ? `${label(highlightedPerson.pubkey, highlightedPerson.name)}. Press Enter to add.`
                  : ""}
              </span>
            </div>
            {!initialLoading && presentGroups.length > 1 && (
              <motion.div
                className="shrink-0 overflow-hidden"
                initial={false}
                animate={
                  query.length > 0
                    ? { width: 0, opacity: 0, marginLeft: 0 }
                    : {
                        width: "auto",
                        opacity: 1,
                        marginLeft: "var(--space-2)",
                      }
                }
                transition={{
                  duration: reducedMotion ? 0 : 0.14,
                  ease: [0.23, 1, 0.32, 1],
                }}
                inert={query.length > 0}
                aria-hidden={query.length > 0 || undefined}
              >
                <Select
                  variant="compact"
                  label="Filter members by role"
                  align="end"
                  value={roleFilter}
                  valueLabel={roleFilter}
                  groups={[
                    {
                      label: "",
                      options: [
                        { name: "All", count: members.size },
                        ...presentGroups,
                      ].map((group) => ({
                        value: group.name,
                        label: `${group.name} · ${group.count}`,
                      })),
                    },
                  ]}
                  onValueChange={(value) => {
                    setSelectedRole(value);
                    if (scrollport.current) scrollport.current.scrollTop = 0;
                  }}
                />
              </motion.div>
            )}
          </div>
          {administrationError && (
            <p role="alert" className="shrink-0 text-body-sm text-danger">
              {administrationError}
            </p>
          )}
          <section
            ref={scrollport}
            className={styles.memberList}
            aria-label="Member list"
          >
            {!canAdd && (
              <p className="text-body-sm text-subtle">
                {channel?.channelType === "dm"
                  ? "DM membership cannot be changed here."
                  : channel?.archived
                    ? "Archived channels cannot add members."
                    : !session.outbox?.supports(9000)
                      ? "Adding members is unavailable in this connection."
                      : "Join this channel to add people and agents."}
              </p>
            )}
            {rosterError && (
              <p role="alert" className="text-body-sm text-danger">
                {rosterError}
              </p>
            )}
            {initialLoading ? (
              <div
                className={styles.loadingMembers}
                role="status"
                aria-label="Loading members"
              >
                <CircleNotchIcon
                  size={24}
                  aria-hidden="true"
                  className="motion-safe:animate-spin"
                />
                <span className="sr-only">Loading members…</span>
              </div>
            ) : (
              filteredGroups
                .filter(
                  (group) =>
                    group.keys.length ||
                    group.name ===
                      (roleFilter === "All" ? "Members" : roleFilter),
                )
                .map((group) => (
                  <section key={group.name} aria-label={group.name}>
                    <h3
                      className={`${styles.groupHeading} px-control-inset pb-2 text-caption text-subtle`}
                    >
                      {group.name} · {group.count}
                    </h3>
                    <ul>
                      {group.keys.map((key) => row(key, label(key), false))}
                    </ul>
                    {!filteredGroups.some((item) => item.keys.length) &&
                      !rosterBusy && (
                        <p className="px-control-inset text-body-sm text-subtle">
                          {query
                            ? "No members match your search."
                            : "No members to show."}
                        </p>
                      )}
                  </section>
                ))
            )}
            {!initialLoading &&
              canAdd &&
              roleFilter === "All" &&
              query.trim() && (
                <section
                  className={styles.memberGroup}
                  aria-label="Not in this channel"
                  {...highlight.listProps}
                >
                  <h3
                    className={`${styles.groupHeading} px-control-inset pb-2 text-caption text-subtle`}
                  >
                    Not in this channel
                  </h3>
                  {teams.length > 0 && (
                    <ul aria-label="Teams">
                      {teams.map(({ team, missing }) => (
                        <TeamRow
                          key={team.id}
                          team={team}
                          names={missing.map((key) =>
                            label(key, teamNames.get(key)),
                          )}
                          busy={missing.some((key) => busy.has(key))}
                          disabled={rosterBusy || !!rosterError}
                          onAdd={() => void addTeam(team, missing)}
                        />
                      ))}
                    </ul>
                  )}
                  {visibleCandidates.map((person) =>
                    row(
                      person.pubkey,
                      label(person.pubkey, person.name),
                      true,
                      person.picture,
                      person.isAgent,
                    ),
                  )}
                  {search.loading && (
                    <p
                      role="status"
                      className="px-control-inset text-body-sm text-subtle"
                    >
                      Searching…
                    </p>
                  )}
                  {!search.loading && !search.error && !available.length && (
                    <p className="px-control-inset text-body-sm text-subtle">
                      No other matching people or agents.
                    </p>
                  )}
                  {search.error && (
                    <p
                      role="alert"
                      className="px-control-inset text-body-sm text-danger"
                    >
                      {search.error}
                    </p>
                  )}
                  {(moreCandidates || search.more) && (
                    <div className="flex justify-center">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setInvitationPage({
                            text,
                            size: invitationSize + MEMBER_SEARCH_PAGE_SIZE,
                          });
                          if (!moreCandidates) search.next();
                        }}
                        disabled={search.loading}
                      >
                        Show more results
                      </Button>
                    </div>
                  )}
                </section>
              )}
            {nameError && (
              <p role="status" className="text-body-sm text-subtle">
                {nameError}
              </p>
            )}
            {ownership.failed && (
              <p role="status" className="text-body-sm text-subtle">
                Some agent managers or their names could not load. Try again.
              </p>
            )}
            {agentChoices.error && (
              <p role="alert" className="text-body-sm text-danger">
                Some agents could not load.
              </p>
            )}
            {archives.status === "error" && (
              <p role="alert" className="text-body-sm text-danger">
                Archived identities could not be checked.
              </p>
            )}
            {Object.entries(errors).map(([key, error]) => (
              <p role="alert" key={key} className="text-body-sm text-danger">
                {label(key)}: {error}{" "}
                <Button
                  variant="outline"
                  disabled={busy.has(key) || !canAdd}
                  onClick={() => void add(key)}
                >
                  {busy.has(key) ? "Retrying…" : "Retry"}
                </Button>
              </p>
            ))}
            {openingMessage && (
              <p role="status" className="text-body-sm text-subtle">
                Opening conversation…
              </p>
            )}
            {messageError && (
              <p role="alert" className="text-body-sm text-danger">
                {messageError}
              </p>
            )}
            {notice && (
              <p role="status" className="text-body-sm text-subtle">
                {notice}
              </p>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
  return <TypedText.Provider value={needle}>{dialog}</TypedText.Provider>;
}
