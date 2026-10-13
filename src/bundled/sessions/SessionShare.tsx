import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Popover } from "@base-ui/react/popover";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import { archiveHides } from "../../features/relay/identity-archives";
import { useMePlacement } from "../../features/sessions/personal";
import { canShareSession } from "../../features/channel-members/members";
import {
  beginSessionShare,
  finishSessionShare,
  sessionShareAttempt,
  type ShareAttempt,
} from "../../features/sessions/share-attempt";
import { searchMembers } from "../../features/channel-members/search";
import {
  canonicalDetailsName,
  detailsDraftErrors,
  type ChannelDetails,
  type ChannelDetailsDraft,
} from "../../features/relay/channel-details-protocol";
import {
  formatPublicKey,
  publicKeyLabels,
} from "../../shared/identity/public-key";
import {
  applySharedChannelDetails,
  destinationShareAudience,
  grantSessionAccess,
  publishSessionLink,
  sessionLink,
} from "../../features/sessions/share";
import { Button } from "../../shared/design-system/ui/Button";
import { Select } from "../../shared/design-system/ui/Select";
import { Field } from "../../shared/design-system/ui/Field";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { Switch } from "../../shared/design-system/ui/Switch";
import { ChannelPrivacyConfirmation } from "../channels/ChannelPrivacyConfirmation";
import { ChannelDurationField } from "../channels/ChannelDurationField";
import { DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS } from "../../features/relay/work-sessions";
import { sessionMetadata } from "../../features/sessions/metadata";
import { ChannelTextField } from "../channels/ChannelTextField";
import { UsersIcon } from "../../shared/design-system/icons";
import styles from "./SessionShare.module.css";

type Person = { pubkey: string; name: string; isAgent?: true };
/** A share attempt keeps exact selected keys through partial failure. Access and
 * delivery still belong to the existing member, channel-creation and outbox owners. */
export function SessionShare({
  session,
  channel,
  direct = false,
  onShared,
  signal,
  renderTrigger,
  initialOpen = false,
  onClose,
  finalFocus,
}: {
  session: RelaySession;
  channel: ChannelSummary;
  direct?: boolean;
  initialOpen?: boolean;
  onClose?: () => void;
  finalFocus?: () => HTMLElement | false;
  renderTrigger?: (open: () => void, disabled: boolean) => ReactNode;
  onShared?: () => void;
  signal?: AbortSignal | undefined;
}) {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const visible = () => mounted.current && !signal?.aborted;
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
  const agents = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
    session.agentChoices.snapshot,
  );
  const pendingCreation = useSyncExternalStore(
    session.channelCreation.subscribe,
    session.channelCreation.snapshot,
    session.channelCreation.snapshot,
  );
  const pendingDetails = useSyncExternalStore(
    session.channelDetails.subscribe,
    () => session.channelDetails.snapshot(channel.id),
  );
  const [open, setOpen] = useState(initialOpen);
  const [base, setBase] = useState<ChannelDetails>();
  const [detailsDraft, setDetailsDraft] = useState<ChannelDetailsDraft>();
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsReload, setDetailsReload] = useState(0);
  const [confirmPublic, setConfirmPublic] = useState(false);
  const [destination, setDestination] = useState("");
  const [newName, setNewName] = useState("");
  const [newPrivate, setNewPrivate] = useState(false);
  const [audience, setAudience] = useState<"selected" | "everyone">(
    direct ? "selected" : "everyone",
  );
  const [people, setPeople] = useState<Person[]>([]);
  const [channelPeople, setChannelPeople] = useState<Person[]>([]);
  const [query, setQuery] = useState("");
  const [searchTarget, setSearchTarget] = useState<"channel" | "session">(
    "session",
  );
  const [results, setResults] = useState<Person[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [resultsOpen, setResultsOpen] = useState(false);
  const [showSelected, setShowSelected] = useState(false);
  const [activeKey, setActiveKey] = useState("");
  const searchInput = useRef<HTMLElement>(null);
  const searchAnchor = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const dialogContainer = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [busy, setBusy] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [frozen, setFrozen] = useState<ShareAttempt | undefined>(() =>
    sessionShareAttempt(session, channel.id),
  );
  // A mounted page may remain while another entry point resumes this session's attempt.
  const saved = frozen ?? sessionShareAttempt(session, channel.id);
  const directShare = saved ? saved.intent.destination === channel.id : direct;
  const placement = useMePlacement(session);
  const source = list.channels.find((item) => item.id === channel.id);
  const eligible = directShare
    ? !!(
        source &&
        !source.readOnly &&
        !source.cached &&
        !source.archived &&
        ["session", "stream"].includes(source.channelType ?? "") &&
        source.members?.includes(session.viewer ?? "") &&
        session.channelDetails.available &&
        session.mePlacement.available &&
        placement.status === "ready"
      )
    : canShareSession(session, source);
  useEffect(() => {
    void detailsReload;
    if (!open || !directShare) return;
    const controller = new AbortController();
    setDetailsLoading(true);
    setBase(undefined);
    void session.channelDetails
      .load(channel.id, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setBase(next);
        setDetailsDraft(
          (old) =>
            old ?? {
              name: next.name,
              description: sessionMetadata(next.description)
                ? ""
                : next.description,
              visibility: next.visibility,
              ttlSeconds: next.ttlSeconds,
            },
        );
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailsLoading(false);
      });
    return () => controller.abort();
  }, [open, directShare, session, channel.id, detailsReload]);
  const sharedDetails = saved?.intent.details ?? detailsDraft;
  const normalizedDetails = sharedDetails && {
    ...sharedDetails,
    name: canonicalDetailsName(sharedDetails.name),
  };
  const detailsErrors = normalizedDetails
    ? detailsDraftErrors(normalizedDetails)
    : undefined;
  const detailsInvalid =
    directShare &&
    (!base?.canEdit ||
      detailsLoading ||
      !normalizedDetails ||
      Object.values(detailsErrors ?? {}).some(Boolean));
  const destinations = list.channels.filter(
    (item) =>
      !item.readOnly &&
      !item.cached &&
      !item.archived &&
      (item.channelType === "stream" || item.channelType === "forum") &&
      item.members?.includes(session.viewer ?? ""),
  );
  useEffect(() => {
    void attempt;
    const text = query.trim();
    if (!open || !text) {
      setResults([]);
      setSearching(false);
      setSearchError("");
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    setResults([]);
    setSearchError("");
    const timer = setTimeout(() => {
      void searchMembers(session, text, 1, controller.signal).then(
        (page) => {
          if (!controller.signal.aborted) {
            setResults(page.people);
            setSearching(false);
          }
        },
        (reason: unknown) => {
          if (!controller.signal.aborted) {
            setSearchError(
              reason instanceof Error ? reason.message : "Search failed.",
            );
            setSearching(false);
          }
        },
      );
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [session, query, open, attempt]);
  const reset = () => {
    setOpen(false);
    setDestination("");
    setDetailsDraft(undefined);
    setBase(undefined);
    setConfirmPublic(false);
    setNewName("");
    setNewPrivate(false);
    setAudience(direct ? "selected" : "everyone");
    setPeople([]);
    setChannelPeople([]);
    setQuery("");
    setSearchTarget("session");
    setResultsOpen(false);
    setShowSelected(false);
    setActiveKey("");
    setError("");
    setProgress("");
    setFrozen(sessionShareAttempt(session, channel.id));
  };
  const startOver = () => {
    if (!visible() || busy || !saved) return;
    if (saved.running) {
      setError("This share is already in progress in another view.");
      return;
    }
    if (sessionShareAttempt(session, channel.id) !== saved) {
      setError(
        "This share finished or changed. Close and reopen to start a new share.",
      );
      return;
    }
    // Forget only this settled intent. Durable operations and existing access
    // remain with their owners; starting over is not cancellation or revocation.
    finishSessionShare(session, channel.id);
    reset();
    if (directShare) setDetailsReload((value) => value + 1);
    setOpen(true);
  };
  const copy = async () => {
    setCopyStatus("");
    try {
      await navigator.clipboard.writeText(sessionLink(channel.id));
      setCopyStatus("Link copied");
    } catch {
      setCopyStatus("Couldn’t copy the link.");
    }
  };
  const newChannel = (saved?.intent.destination ?? destination) === "new";
  const chosenAudience = saved?.intent.audience ?? audience;
  const chosen = destinations.find(
    (item) =>
      item.id === (saved?.created ?? saved?.intent.destination ?? destination),
  );
  const shown = [
    ...new Map(
      [...people, ...channelPeople, ...results].map((person) => [
        person.pubkey,
        person,
      ]),
    ).values(),
  ];
  const selectedPeople = searchTarget === "channel" ? channelPeople : people;
  const candidates = results.filter(
    (person) =>
      !agents.identities.some((item) => item.pubkey === person.pubkey) &&
      !profiles.get(person.pubkey)?.isAgent &&
      !person.isAgent &&
      !selectedPeople.some((item) => item.pubkey === person.pubkey),
  );
  const available = candidates.filter(
    (person) =>
      !archiveHides(session.archives, person.pubkey, session.viewer) &&
      !(searchTarget === "channel" ? chosen : source)?.members?.includes(
        person.pubkey,
      ),
  );
  const active = available.find((person) => person.pubkey === activeKey);
  const popupVisible = resultsOpen && (!!query.trim() || showSelected);
  const keys = publicKeyLabels(shown.map((person) => person.pubkey));
  const names = (key: string) =>
    session.names.resolve(
      key,
      profiles.get(key)?.name ??
        shown.find((person) => person.pubkey === key)?.name ??
        formatPublicKey(key) ??
        "Member",
    );
  const knownAgent = (key: string) =>
    !!(
      agents.identities.some((item) => item.pubkey === key) ||
      profiles.get(key)?.isAgent ||
      shown.find((person) => person.pubkey === key)?.isAgent
    );
  const choosePerson = (person: Person) => {
    if (
      busy ||
      saved ||
      knownAgent(person.pubkey) ||
      archiveHides(session.archives, person.pubkey, session.viewer)
    )
      return;
    const already = (
      searchTarget === "channel" ? chosen : source
    )?.members?.includes(person.pubkey);
    if (already || selectedPeople.some((item) => item.pubkey === person.pubkey))
      return;
    if (searchTarget === "channel")
      setChannelPeople([...channelPeople, person]);
    else setPeople([...people, person]);
    setActiveKey("");
    setQuery("");
    setShowSelected(false);
    setResultsOpen(false);
    searchInput.current?.focus();
  };
  const searchControl = (target: "channel" | "session", label: string) => (
    <div
      className={styles.searchAnchor}
      ref={(node) => {
        if (node && searchTarget === target) searchAnchor.current = node;
      }}
    >
      <SearchField
        inputRef={(node) => {
          if (node && searchTarget === target) searchInput.current = node;
        }}
        label={label}
        placeholder="Search by name or public key…"
        value={searchTarget === target ? query : ""}
        disabled={busy || !!saved}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={popupVisible && searchTarget === target}
        aria-controls={
          popupVisible && searchTarget === target ? listId : undefined
        }
        aria-activedescendant={
          active && popupVisible ? `${listId}-${active.pubkey}` : undefined
        }
        onFocus={() => {
          if (searchTarget !== target) {
            setSearchTarget(target);
            setQuery("");
            setShowSelected(false);
            setActiveKey("");
          }
          setResultsOpen(true);
        }}
        onValueChange={(value) => {
          setSearchTarget(target);
          setShowSelected(false);
          setActiveKey("");
          setQuery(value);
          setResultsOpen(true);
        }}
        onKeyDown={(event) => {
          if (
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229 ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          )
            return;
          if (event.key === "Escape" && popupVisible) {
            event.preventDefault();
            event.stopPropagation();
            setResultsOpen(false);
          } else if (
            (event.key === "ArrowDown" || event.key === "ArrowUp") &&
            available.length
          ) {
            event.preventDefault();
            setResultsOpen(true);
            const index = available.findIndex(
              (person) => person.pubkey === activeKey,
            );
            const next =
              index < 0
                ? event.key === "ArrowDown"
                  ? 0
                  : available.length - 1
                : Math.max(
                    0,
                    Math.min(
                      available.length - 1,
                      index + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  );
            setActiveKey(available[next]?.pubkey ?? "");
            const row = document.getElementById(
              `${listId}-${available[next]?.pubkey}`,
            );
            row?.scrollIntoView({ block: "nearest" });
          } else if (event.key === "Enter" && popupVisible) {
            event.preventDefault();
            if (active) choosePerson(active);
          }
        }}
      />
    </div>
  );
  const submit = async () => {
    if (
      !visible() ||
      !eligible ||
      busy ||
      detailsInvalid ||
      (!directShare && !newChannel && !chosen)
    )
      return;
    if (
      newChannel &&
      !saved &&
      pendingCreation &&
      (pendingCreation.name !== canonicalDetailsName(newName) ||
        pendingCreation.visibility !== (newPrivate ? "private" : "open"))
    ) {
      setError(
        "Finish the pending channel creation with its saved details before starting another.",
      );
      return;
    }
    if (
      !saved &&
      (people.length > 100 ||
        channelPeople.length > 100 ||
        [...people, ...channelPeople].some((person) =>
          knownAgent(person.pubkey),
        ))
    ) {
      setError(
        "Choose at most 100 people in each group; add agents separately.",
      );
      return;
    }
    // A blocked dialog may outlive another view's successful completion.
    // Never reinterpret its frozen Retry as a new share (or as a replacement).
    if (saved && sessionShareAttempt(session, channel.id) !== saved) {
      setError(
        "This share finished or changed. Close and reopen to start a new share.",
      );
      return;
    }
    const exact = beginSessionShare(session, channel.id, {
      destination: directShare ? channel.id : newChannel ? "new" : destination,
      audience: directShare ? "selected" : audience,
      ...(newChannel
        ? {
            name: canonicalDetailsName(newName),
            visibility: newPrivate ? ("private" as const) : ("open" as const),
          }
        : {}),
      channelPeople: newChannel
        ? channelPeople.map((person) => person.pubkey)
        : [],
      sessionPeople: people.map((person) => person.pubkey),
      ...(directShare && normalizedDetails && base
        ? { details: normalizedDetails, detailsBase: base }
        : {}),
    });
    setFrozen(exact);
    if (exact.running) {
      setError("This share is already in progress in another view.");
      return;
    }
    setBusy(true);
    setError("");
    const controller = new AbortController();
    const confirmed: string[] = [];
    // Submitted work belongs to the session, not to this page visit.
    const progress = (text: string) => {
      if (visible()) setProgress(text);
    };
    exact.running = true;
    try {
      if (
        exact.intent.sessionPeople.length > 100 ||
        exact.intent.channelPeople.length > 100
      )
        throw new Error("Choose at most 100 people in each group.");
      if (
        [...exact.intent.sessionPeople, ...exact.intent.channelPeople].some(
          knownAgent,
        )
      )
        throw new Error(
          "Add agents from their own channel or session controls instead.",
        );
      let target = exact.intent.destination;
      if (target === "new") {
        if (!exact.intent.name || !exact.intent.visibility)
          throw new Error("Enter a channel name.");
        progress("Creating channel…");
        target =
          exact.created ??
          (await session.channelCreation.create({
            name: exact.intent.name,
            visibility: exact.intent.visibility,
          }));
        exact.created = target;
        for (const key of exact.intent.channelPeople) {
          if (
            session.agentChoices
              .snapshot()
              .identities.some((item) => item.pubkey === key) ||
            session.profiles.snapshot().get(key)?.isAgent
          )
            throw new Error("Add agents separately.");
          progress(`Adding ${names(key)} to the new channel…`);
          await session.memberAdditions.add(target, key);
        }
      }
      if (exact.intent.audience === "everyone" && !exact.audienceKeys) {
        progress("Checking channel members…");
        exact.audienceKeys = await destinationShareAudience(
          session,
          target,
          controller.signal,
        );
      }
      progress("Confirming session access…");
      await grantSessionAccess(
        session,
        channel.id,
        exact.intent.audience === "everyone"
          ? (exact.audienceKeys ?? [])
          : directShare
            ? exact.intent.sessionPeople.filter(
                (key) => !exact.grants.get(key)?.confirmed,
              )
            : exact.intent.sessionPeople,
        exact.grants,
        controller.signal,
        (key) => confirmed.push(key),
        exact.intent.audience === "everyone",
        !directShare || source?.channelType === "session",
      );
      if (target === channel.id) {
        if (!exact.intent.details || !exact.intent.detailsBase)
          throw new Error("Reload channel details before sharing.");
        progress("Saving channel settings…");
        await applySharedChannelDetails(
          session,
          channel.id,
          exact.intent.details,
          exact.intent.detailsBase,
          controller.signal,
        );
        exact.detailsApplied = true;
        progress("Moving to Messages…");
        await session.mePlacement.set(channel.id, false, {
          signal: controller.signal,
        });
      }
      if (target !== channel.id) {
        progress("Posting session link…");
        await publishSessionLink(
          session,
          channel.id,
          target,
          exact.messageId,
          controller.signal,
          (id) => {
            exact.messageId = id;
          },
        );
      }
      finishSessionShare(session, channel.id);
      if (visible()) {
        reset();
        onShared?.();
      }
    } catch (reason) {
      if (!visible()) return;
      const message =
        reason instanceof Error
          ? reason.message
          : "Couldn’t share this session.";
      progress("");
      setError(
        `${message}${exact.detailsApplied ? " Channel settings were saved; retry to finish moving to Messages." : ""}${directShare && !session.mePlacement.has(channel.id) && session.mePlacement.snapshot().status === "ready" ? " Conversation is in Messages; access already granted is not revoked." : ""}${confirmed.length ? ` ${confirmed.length} session participant${confirmed.length === 1 ? "" : "s"} confirmed.` : ""}`,
      );
    } finally {
      delete exact.running;
      if (visible()) setBusy(false);
    }
  };
  const popupResults = (
    <Popover.Portal container={dialogContainer}>
      <Popover.Positioner
        anchor={searchAnchor}
        side="bottom"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        collisionAvoidance={{
          side: "shift",
          align: "shift",
          fallbackAxisSide: "none",
        }}
        className="buzz-popover-positioner"
      >
        <Popover.Popup
          ref={popup}
          role="presentation"
          initialFocus={false}
          finalFocus={false}
          data-buzz-ui=""
          data-padding="list"
          className={`buzz-popover-popup text-body ${styles.results}`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setResultsOpen(false);
              searchInput.current?.focus();
            }
          }}
        >
          <div
            id={listId}
            role="listbox"
            aria-label="People"
            className={styles.people}
          >
            {showSelected && !query.trim() ? (
              selectedPeople.map((person) => (
                <button
                  key={person.pubkey}
                  type="button"
                  className={styles.person}
                  aria-label={`Remove ${names(person.pubkey)}`}
                  onClick={() => {
                    if (searchTarget === "channel")
                      setChannelPeople(
                        channelPeople.filter(
                          (item) => item.pubkey !== person.pubkey,
                        ),
                      );
                    else
                      setPeople(
                        people.filter((item) => item.pubkey !== person.pubkey),
                      );
                    searchInput.current?.focus();
                  }}
                >
                  <span>{names(person.pubkey)} · Remove</span>
                  <small className="text-body-sm text-subtle">
                    {keys.get(person.pubkey)}
                  </small>
                </button>
              ))
            ) : searching ? (
              <p role="status" className="text-body-sm text-subtle">
                Searching…
              </p>
            ) : searchError ? (
              <p role="alert" className="text-body-sm">
                {searchError}{" "}
                <Button
                  size="xs"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  Retry
                </Button>
              </p>
            ) : candidates.length ? (
              candidates.map((person) => {
                const already = (
                  searchTarget === "channel" ? chosen : source
                )?.members?.includes(person.pubkey);
                const archived = archiveHides(
                  session.archives,
                  person.pubkey,
                  session.viewer,
                );
                return (
                  <button
                    key={person.pubkey}
                    id={`${listId}-${person.pubkey}`}
                    type="button"
                    role="option"
                    aria-selected={activeKey === person.pubkey}
                    aria-disabled={!!saved || busy || !!already || archived}
                    disabled={!!saved || busy || !!already || archived}
                    className={styles.person}
                    onMouseEnter={() => {
                      if (!already && !archived) setActiveKey(person.pubkey);
                    }}
                    onClick={() => choosePerson(person)}
                  >
                    <span>{names(person.pubkey)}</span>
                    <small className="text-body-sm text-subtle">
                      {keys.get(person.pubkey)}
                      {already ? " · Already has access" : ""}
                      {archived ? " · Archived" : ""}
                    </small>
                  </button>
                );
              })
            ) : (
              <p className="text-body-sm text-subtle">No people found.</p>
            )}
          </div>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  );
  return (
    <>
      {renderTrigger ? (
        renderTrigger(() => {
          setCopyStatus("");
          setFrozen(sessionShareAttempt(session, channel.id));
          setOpen(true);
        }, !eligible)
      ) : (
        <Button
          variant="ghost"
          size="sm"
          disabled={!eligible}
          onClick={() => {
            setCopyStatus("");
            setFrozen(sessionShareAttempt(session, channel.id));
            setOpen(true);
          }}
        >
          Share
        </Button>
      )}
      <Dialog
        finalFocus={finalFocus}
        open={open}
        onOpenChange={(next) => {
          if (!next && !busy) {
            reset();
            onClose?.();
          }
        }}
        onEscape={() => {
          if (!popupVisible) return false;
          setResultsOpen(false);
          return true;
        }}
        title={directShare ? "Share conversation" : "Share session"}
        preventClose={busy}
        headerGap="compact"
        leadingActions={
          <Button variant="ghost" disabled={busy} onClick={() => void copy()}>
            {copyStatus || "Copy link"}
          </Button>
        }
        actions={
          <>
            {saved && (
              <Button disabled={busy} onClick={startOver}>
                Start over
              </Button>
            )}
            <Button
              variant="prominent"
              disabled={
                busy ||
                !eligible ||
                (!directShare && !newChannel && !chosen) ||
                detailsInvalid ||
                (newChannel &&
                  !saved &&
                  (!canonicalDetailsName(newName) ||
                    !session.channelCreation.available))
              }
              onClick={() => {
                if (
                  directShare &&
                  normalizedDetails?.visibility === "public" &&
                  !saved &&
                  !confirmPublic
                )
                  setConfirmPublic(true);
                else void submit();
              }}
            >
              {confirmPublic
                ? "Make public and share"
                : busy
                  ? "Sharing…"
                  : saved
                    ? "Retry share"
                    : "Share"}
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          {directShare && (
            <p>
              Move this conversation to Messages with its full history, Canvas
              and existing agents. No new conversation is created.
            </p>
          )}
          {directShare &&
            (sharedDetails ? (
              <>
                <ChannelTextField
                  field="name"
                  value={sharedDetails.name}
                  error={detailsErrors?.name}
                  disabled={busy || !!saved || detailsLoading}
                  onChange={(name) =>
                    setDetailsDraft({ ...sharedDetails, name })
                  }
                />
                <ChannelDurationField
                  temporary={sharedDetails.ttlSeconds !== undefined}
                  ttlSeconds={
                    sharedDetails.ttlSeconds ??
                    DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS
                  }
                  error={detailsErrors?.lifetime}
                  disabled={busy || !!saved || detailsLoading}
                  onChange={(ttlSeconds) =>
                    setDetailsDraft({ ...sharedDetails, ttlSeconds })
                  }
                />
                {sharedDetails.ttlSeconds !== undefined && (
                  <p className="text-body-sm text-subtle">
                    This conversation is automatically archived when its
                    duration ends. Its history is not deleted.
                  </p>
                )}
                <Switch
                  label="Private"
                  checked={sharedDetails.visibility === "private"}
                  disabled={busy || !!saved || detailsLoading}
                  onCheckedChange={(checked) => {
                    setDetailsDraft({
                      ...sharedDetails,
                      visibility: checked ? "private" : "public",
                    });
                    setConfirmPublic(false);
                  }}
                />
                <p className="text-body-sm text-subtle">
                  {sharedDetails.visibility === "private"
                    ? "Only channel members can read its history and participate. Add people below (optional)."
                    : "Everyone in this community will be able to view this channel’s full history."}
                </p>
                {confirmPublic && (
                  <ChannelPrivacyConfirmation
                    visibility="public"
                    hidePreference
                    checked={false}
                    onCheckedChange={() => {}}
                  />
                )}
              </>
            ) : (
              <p role="status">
                {detailsLoading
                  ? "Loading channel settings…"
                  : "Channel settings could not be loaded."}
              </p>
            ))}
          {directShare && !detailsLoading && !base && (
            <Button
              onClick={() => {
                setError("");
                setDetailsReload((value) => value + 1);
              }}
            >
              Reload channel settings
            </Button>
          )}
          {directShare && pendingDetails?.status === "unconfirmed" && (
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await session.channelDetails.check(channel.id);
                  if (visible()) setDetailsReload((value) => value + 1);
                } catch (reason) {
                  if (visible())
                    setError(
                      reason instanceof Error ? reason.message : String(reason),
                    );
                } finally {
                  if (visible()) setBusy(false);
                }
              }}
            >
              Check channel settings status
            </Button>
          )}
          {directShare && base && !base.canEdit && (
            <p role="alert">
              Only a channel owner or admin can change these settings and share
              to Messages.
            </p>
          )}
          {!directShare && (
            <Select
              label="Share to"
              placeholder="Choose a channel"
              variant="field"
              value={saved?.intent.destination ?? destination}
              disabled={busy || !!saved}
              groups={[
                {
                  label: "Channels",
                  options: destinations.map((item) => ({
                    value: item.id,
                    label: item.name,
                  })),
                },
                {
                  label: "",
                  options: [{ value: "new", label: "Create new channel…" }],
                },
              ]}
              onValueChange={(value) => {
                setDestination(value);
                setError("");
              }}
            />
          )}
          {newChannel && (
            <div className={styles.newChannel}>
              <ChannelTextField
                field="name"
                creation
                value={saved?.intent.name ?? newName}
                onChange={setNewName}
                disabled={busy || !!saved}
              />
              <Switch
                label="Private channel"
                checked={
                  saved ? saved.intent.visibility === "private" : newPrivate
                }
                disabled={busy || !!saved}
                onCheckedChange={setNewPrivate}
              />
              <span className="text-label-sm">Add to new channel</span>
              {saved && (
                <p className="text-body-sm text-subtle">
                  {saved.intent.channelPeople.length} chosen for this channel
                </p>
              )}
              {searchControl("channel", "Find people to add to new channel")}
            </div>
          )}
          {!directShare && (
            <Field label="Who has session access">
              <RadioGroup
                value={saved?.intent.audience ?? audience}
                disabled={busy || !!saved}
                onValueChange={setAudience}
              >
                <Radio value="everyone" label="Everyone in this channel" />
                <Radio value="selected" label="Selected people" />
              </RadioGroup>
            </Field>
          )}
          <div className={styles.audienceRow}>
            {chosenAudience === "everyone" ? (
              <p className={`${styles.selection} text-body-sm text-subtle`}>
                <UsersIcon size={16} aria-hidden="true" />
                Current channel members
              </p>
            ) : (
              <>
                {searchControl(
                  "session",
                  newChannel ? "Find people for session access" : "Find people",
                )}
                {!newChannel && people.length > 0 && (
                  <button
                    type="button"
                    className={`${styles.count} text-body-sm text-subtle`}
                    onClick={() => {
                      setSearchTarget("session");
                      setQuery("");
                      setShowSelected(true);
                      setResultsOpen(true);
                      searchInput.current?.focus();
                    }}
                  >
                    {people.length} selected
                  </button>
                )}
              </>
            )}
          </div>
          {newChannel && channelPeople.length > 0 && (
            <button
              type="button"
              className={`${styles.selection} text-body-sm text-subtle`}
              onClick={() => {
                setSearchTarget("channel");
                setQuery("");
                setShowSelected(true);
                setResultsOpen(true);
                searchInput.current?.focus();
              }}
            >
              <UsersIcon size={16} aria-hidden="true" />
              {channelPeople.length} for the new channel · Edit
            </button>
          )}
          {newChannel && chosenAudience === "selected" && people.length > 0 && (
            <button
              type="button"
              className={`${styles.selection} text-body-sm text-subtle`}
              onClick={() => {
                setSearchTarget("session");
                setQuery("");
                setShowSelected(true);
                setResultsOpen(true);
                searchInput.current?.focus();
              }}
            >
              <UsersIcon size={16} aria-hidden="true" />
              {people.length} for session access · Edit
            </button>
          )}
          {saved && !error && !busy && (
            <p role="status" className="text-body-sm text-subtle">
              Retry to{" "}
              {saved.created
                ? (destinations.find((item) => item.id === saved.created)
                    ?.name ?? "the created channel")
                : saved.intent.destination === "new"
                  ? (saved.intent.name ?? "new channel")
                  : (destinations.find(
                      (item) => item.id === saved.intent.destination,
                    )?.name ?? "the chosen channel")}
              {saved.intent.audience === "everyone"
                ? ", with the saved channel audience."
                : `, with ${saved.intent.sessionPeople.length} selected for session access.`}
              {saved.intent.destination === "new" &&
              saved.intent.channelPeople.length > 0
                ? ` ${saved.intent.channelPeople.length} chosen for the new channel.`
                : ""}
            </p>
          )}
          {saved && (
            <p className="text-body-sm text-subtle">
              {directShare
                ? "Starting over clears these choices, not settings or access already saved."
                : "Starting over clears these choices, not work already submitted. Existing access, created channels, Messages placement and queued operations are kept. A new share may post another link."}
            </p>
          )}
          {pendingCreation && !saved && !error && (
            <p role="status">
              A channel creation is awaiting confirmation. Retry its saved
              details before creating another channel.
            </p>
          )}
          {error ? (
            <p role="alert" className="text-body-sm">
              {error}
            </p>
          ) : progress ? (
            <p role="status" className="text-body-sm text-subtle">
              {progress}
            </p>
          ) : null}
          {!eligible && !error && (
            <p role="alert">Session access changed. Refresh and try again.</p>
          )}
        </div>
        <div ref={dialogContainer} />
        <Popover.Root
          open={open && popupVisible && !busy && !saved}
          onOpenChange={(next) => setResultsOpen(next)}
          modal={false}
        >
          {popupResults}
        </Popover.Root>
      </Dialog>
    </>
  );
}
