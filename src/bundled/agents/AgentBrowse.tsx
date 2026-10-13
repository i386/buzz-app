// Browse: the agents this community's members have shared, each importable
// as a new agent. The catalog is read a page at a time; an over-budget page is
// retried smaller.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AGENT_CATALOG_KIND } from "../../features/agents/catalog-envelope";
import { ModelIcon } from "../../features/agents/ModelPicker";
import type {
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import {
  type SharedAgent,
  sharedAgents,
} from "../../features/agents/shared-agents";
import { ReadError } from "../../features/relay/errors";
import type { EventData } from "../../features/relay/events";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Select } from "../../shared/design-system/ui/Select";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { useAvatarPreview } from "../../features/profiles/use-avatar-preview";
import {
  canonicalPublicKey,
  formatPublicKey,
} from "../../shared/identity/public-key";
import { AgentCard, AgentPortrait } from "./AgentCard";
import cardStyles from "./AgentCard.module.css";
import styles from "./AgentBrowse.module.css";

const pageSize = 200;

type Importing = Readonly<{
  agents: Agents;
  /** The types an import can be, which run on this computer. */
  types: readonly RegisteredAgentType[];
  onImported(): void;
}>;

export function AgentBrowse({
  relay,
  ...importing
}: Importing & { relay: RelayData }) {
  const connection = useRelayConnection(relay);
  if (connection.status !== "ready")
    return <p>Connect to a community to browse shared agents.</p>;
  // A new session (another community) starts over from the first page.
  return (
    <SharedAgentList
      key={connection.generation}
      session={connection.session}
      community={connection.origin}
      {...importing}
    />
  );
}

function SharedAgentList({
  session,
  community,
  ...importing
}: Importing & {
  session: RelaySession;
  community: string | undefined;
}) {
  const [events, setEvents] = useState<readonly EventData[]>([]);
  const [cursor, setCursor] = useState<{ until: number; before_id: string }>();
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<SharedAgent>();
  const trigger = useRef<HTMLButtonElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry reruns this finite read.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    const readPage = async () => {
      let limit = pageSize;
      for (;;) {
        controller.signal.throwIfAborted();
        try {
          const page = await session.read(
            [{ kinds: [AGENT_CATALOG_KIND], limit, ...cursor }],
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          setEvents((previous) => (cursor ? [...previous, ...page] : page));
          setMore(page.length === limit);
          return;
        } catch (problem) {
          // Match the community catalog's bounded retry at the same cursor.
          if (
            problem instanceof ReadError &&
            problem.kind === "invalid-response" &&
            problem.message === "Relay response exceeds the read budget" &&
            limit > 1
          ) {
            limit = Math.floor(limit / 2);
            continue;
          }
          throw problem;
        }
      }
    };
    void readPage()
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [session, cursor, attempt]);
  const agents = sharedAgents(events);
  return (
    <div className="flex flex-col gap-section-gap">
      {loading && <p role="status">Loading shared agents…</p>}
      {error && (
        <div role="alert">
          <p>Couldn’t load shared agents.</p>
          <Button onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </Button>
        </div>
      )}
      {!loading && !error && !agents.length && (
        <p>No shared agents found in this community yet.</p>
      )}
      <div className={cardStyles.grid}>
        {agents.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            community={community}
            detail={agent.model || "Shared agent"}
            icon={<ModelIcon model={agent.model} />}
          >
            <Button
              onClick={(event) => {
                trigger.current = event.currentTarget;
                setSelected(agent);
              }}
            >
              View details
            </Button>
          </AgentCard>
        ))}
      </div>
      {more && !error && (
        <Button
          disabled={loading}
          onClick={() => {
            const last = [...events]
              .sort(
                (a, b) =>
                  b.created_at - a.created_at || a.id.localeCompare(b.id),
              )
              .at(-1);
            if (last) setCursor({ until: last.created_at, before_id: last.id });
          }}
        >
          Load more
        </Button>
      )}
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
        title={selected?.name ?? "Shared agent"}
        description="Import makes it your own new agent, with this name, picture and instructions. The model is yours to choose after."
        size="wide"
        finalFocus={trigger}
        actions={
          selected && (
            <ImportShared
              key={selected.id}
              shared={selected}
              {...importing}
              onImported={() => {
                setSelected(undefined);
                importing.onImported();
              }}
            />
          )
        }
      >
        {selected && (
          <SharedAgentDetails
            agent={selected}
            session={session}
            community={community}
          />
        )}
      </Dialog>
    </div>
  );
}

function SharedAgentDetails({
  agent,
  session,
  community,
}: {
  agent: SharedAgent;
  session: RelaySession;
  community: string | undefined;
}) {
  return (
    <div className={styles.details}>
      <div className={styles.identity}>
        <span className={styles.portrait} aria-hidden="true">
          <AgentPortrait agent={agent} community={community} />
        </span>
        <dl className={styles.facts}>
          <dt>Model</dt>
          <dd className={styles.fact}>
            <ModelIcon model={agent.model} />
            {agent.model || "Not given"}
          </dd>
          <dt>Shared by</dt>
          <dd>
            <Sharer
              pubkey={agent.owner}
              session={session}
              community={community}
            />
          </dd>
        </dl>
      </div>
      <section className={styles.instructions} aria-label="Instructions">
        {agent.instructions || "No instructions included."}
      </section>
    </div>
  );
}

/** Who shared it, by their profile; the key itself is a hover away. */
function Sharer({
  pubkey,
  session,
  community,
}: {
  pubkey: string;
  session: RelaySession;
  community: string | undefined;
}) {
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  useEffect(() => {
    void session.profiles.ensure([pubkey]).catch(() => {});
  }, [session, pubkey]);
  const profile = profiles.get(pubkey);
  const picture = useAvatarPreview(profile?.picture ?? "", community);
  const npub = canonicalPublicKey(pubkey) ?? pubkey;
  const name =
    profile && !profile.nameIsFallback
      ? profile.name
      : (formatPublicKey(pubkey) ?? pubkey);
  return (
    <Tooltip content={npub} delay={300}>
      <span
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need access to the key in the tooltip.
        tabIndex={0}
        className={styles.fact}
      >
        <Avatar src={picture} alt="" fallback={name} size="small" />
        <span className="truncate">{name}</span>
      </span>
    </Tooltip>
  );
}

/** Imports the shared agent as a new agent of the chosen type, through the
 * same path that imports an earlier system's agents. */
function ImportShared({
  shared,
  agents,
  types,
  onImported,
}: Importing & { shared: SharedAgent }) {
  const [type, setType] = useState(types[0]?.key ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const chosen = types.find((item) => item.key === type) ?? types[0];
  if (!chosen)
    return (
      <p className="m-0 text-body-sm text-secondary">
        Enable an agent type plugin to import agents.
      </p>
    );
  const run = async () => {
    setPending(true);
    setError("");
    try {
      await agents.port({
        source: "shared",
        type: chosen.key,
        name: shared.name,
        ...(shared.picture ? { picture: shared.picture } : {}),
        instructions: shared.instructions,
      });
      onImported();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPending(false);
    }
  };
  return (
    <div className={styles.import}>
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
      )}
      {types.length > 1 && (
        <Select
          label="Import as"
          value={chosen.key}
          disabled={pending}
          groups={[
            {
              label: "Agent types",
              options: types.map((item) => ({
                value: item.key,
                label: item.title,
              })),
            },
          ]}
          onValueChange={setType}
        />
      )}
      <Button
        variant="primary"
        loading={pending}
        disabled={pending}
        onClick={() => void run()}
      >
        Import
      </Button>
    </div>
  );
}
