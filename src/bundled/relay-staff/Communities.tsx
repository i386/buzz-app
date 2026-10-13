import { useEffect, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { ArrowLeftIcon } from "../../shared/design-system/icons";
import {
  unsupported,
  type CommunityDto,
} from "../../features/relay-staff/contract";
import { ActionsSection, MembersSection } from "./DirectActions";
import { Reports } from "./Reports";
import { Restrictions } from "./Restrictions";
import { usePages, useRead, useSession } from "./session";
import {
  CommunityBadge,
  containsSecretKey,
  Failure,
  listButton,
  Loading,
  NotConnected,
  UNSUPPORTED_BROWSING,
  type CommunityRef,
} from "./ui";

/** Each search is a signed request: wait for typing to pause. */
export const SEARCH_DEBOUNCE_MS = 250;

function useDebounced<T>(value: T, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * The relay's community directory, searched by host prefix, with the
 * connected community pinned by exact host whatever page is loaded.
 */
export function Communities({
  connectedHost,
  onOpen,
}: {
  connectedHost: string;
  onOpen(community: CommunityRef): void;
}) {
  const { context } = useSession();
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim().toLowerCase(), SEARCH_DEBOUNCE_MS);
  // A pasted secret key never leaves the device, in a search or a cursor.
  const secret = containsSecretKey(query) || containsSecretKey(q);
  const pages = usePages(
    secret
      ? null
      : (cursor) => ({
          route: "listCommunities",
          ...(q ? { q } : {}),
          ...(cursor ? { cursor } : {}),
        }),
    [context, q, secret],
  );
  const [pinnedRead] = useRead(
    connectedHost ? { route: "listCommunities", q: connectedHost } : null,
    [context, connectedHost],
  );
  const pinned =
    connectedHost && pinnedRead.state === "ok"
      ? (pinnedRead.value.items.find((c) => c.host === connectedHost) ?? null)
      : null;
  const shownPinned = pinned?.host.toLowerCase().startsWith(q) ? pinned : null;

  if (pages.failure && unsupported(pages.failure))
    return (
      <p className="text-body-sm text-secondary">{UNSUPPORTED_BROWSING}</p>
    );

  const items = secret
    ? []
    : pages.items.filter((c) => c.id !== shownPinned?.id);
  const row = (community: CommunityDto, connected: boolean) => (
    <li key={community.id}>
      <button
        type="button"
        className={`${listButton} flex items-center gap-2`}
        onClick={() => onOpen({ id: community.id, host: community.host })}
      >
        <span className="flex-1 truncate">{community.host}</span>
        {connected && (
          <span className="text-caption text-secondary">Connected</span>
        )}
      </button>
    </li>
  );

  return (
    <div className="flex flex-col gap-3">
      <SearchField
        label="Search communities"
        placeholder="Search by host (e.g. team.example.com)"
        value={query}
        onValueChange={setQuery}
      />
      {secret && (
        <p className="text-body-sm text-danger" role="alert">
          That's a secret key. Never paste it here.
        </p>
      )}
      {shownPinned && <ul>{row(shownPinned, true)}</ul>}
      {pages.failure && <Failure failure={pages.failure} />}
      {!secret &&
        !pages.loading &&
        !pages.failure &&
        items.length === 0 &&
        !shownPinned && (
          <p className="text-body-sm text-secondary">No communities found.</p>
        )}
      <ul className="flex flex-col gap-1">{items.map((c) => row(c, false))}</ul>
      {pages.loading && <Loading />}
      {!secret && pages.next && !pages.loading && (
        <div>
          <Button size="sm" variant="outline" onClick={pages.more}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}

const SECTIONS = [
  { value: "reports", label: "Reports" },
  { value: "restrictions", label: "Restrictions" },
  { value: "members", label: "Members" },
  { value: "actions", label: "Actions" },
] as const;
type Section = (typeof SECTIONS)[number]["value"];

/** One community's Reports, Restrictions, Members and Actions, by its host. */
export function CommunityPage({
  community,
  onBack,
}: {
  community: CommunityRef;
  onBack(): void;
}) {
  const [section, setSection] = useState<Section>("reports");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
        <Button size="sm" variant="ghost" aria-label="Back" onClick={onBack}>
          <ArrowLeftIcon />
        </Button>
        <CommunityBadge id={community.id} host={community.host} />
        <NotConnected host={community.host} />
      </div>
      <Tabs
        label="Community sections"
        variant="panel"
        value={section}
        onValueChange={setSection}
        items={[...SECTIONS]}
        renderPanel={(value) =>
          value === "reports" ? (
            <Reports communityId={community.id} />
          ) : value === "restrictions" ? (
            <Restrictions communityHost={community.host} />
          ) : value === "members" ? (
            <MembersSection
              communityHost={community.host}
              onAct={() => setSection("actions")}
            />
          ) : (
            <ActionsSection community={community} />
          )
        }
      />
    </div>
  );
}
