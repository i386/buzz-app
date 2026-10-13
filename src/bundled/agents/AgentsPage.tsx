// The Agents page, in three tabs: Your agents, Import and Browse.
// - Your agents: every agent as a card. Selecting one (click, or arrow keys)
//   opens its peek beside the grid without leaving it; Enter or a double-click
//   builds: the identity rail on the left, the type's tabs and the app's
//   Attention tab on the right. The New agent tile opens the create dialog.
// - Import: identities earlier agent systems saved on this machine.
// - Browse: agents shared in the community.
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import styles from "./AgentsPage.module.css";
import cardStyles from "./AgentCard.module.css";
import { AgentBrowse } from "./AgentBrowse";
import { AgentCard, AgentPortrait } from "./AgentCard";
import { AgentCreateDialog, TypeIcon } from "./AgentCreateDialog";
import { AgentTabs } from "./AgentTabs";
import { useAgentSettingsHost } from "./AgentSettingsHost";
import { NewAgentTile } from "./NewAgentTile";
import type { ChannelChoice } from "../../features/agents/attention";
import { AgentDelete } from "../../features/agents/AgentManage";
import { AttentionSummary } from "../../features/agents/AttentionPanel";
import { AvatarEditor } from "../../features/profiles/AvatarEditor";
import { useAgents, useChannelChoices } from "../../features/agents/react";
import type {
  OldTeam,
  PortableAgent,
  PortSource,
} from "../../features/agents/native";
import type {
  Agent,
  Agents,
  FoundAgents,
  RegisteredAgentType,
  Team,
  TeamPort,
} from "../../features/agents/service";
import { useRelayConnection } from "../../features/relay/react";
import type { AgentMemories } from "../../features/agents/MemoryPanel";
import type { RelayData } from "../../features/relay/service";
import type { Navigation } from "../../features/navigation/controller";
import type { PageNavigation } from "../../features/navigation/service";
import {
  ContributionBoundary,
  contributionKey,
} from "../../features/conversation/ContributionBoundary";
import {
  ArrowLeftIcon,
  CircleNotchIcon,
  CopyIcon,
  DotsThreeIcon,
  PlusIcon,
  RobotIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Field } from "../../shared/design-system/ui/Field";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { Input } from "../../shared/design-system/ui/Input";
import {
  MenuPopup,
  MenuIcon,
  MenuItem,
  MenuRoot,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { Select } from "../../shared/design-system/ui/Select";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import {
  canonicalPublicKey,
  formatPublicKey,
  publicKeyLabels,
} from "../../shared/identity/public-key";
import { agentProviderRoute, agentProviderTarget } from "./routes";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

type Frame =
  | {
      view: "browse";
      selected?: string;
      side?: "teams";
    }
  | { view: "build"; pubkey: string };

/** The type's one-line summary of an agent; its title when it has none. */
function summaryOf(agent: Agent, type: RegisteredAgentType | undefined) {
  if (agent.place === "elsewhere") return "On another device";
  if (agent.unfinished) return "Setup unfinished";
  if (!type) return "Type unavailable";
  try {
    return type.summary?.(agent).trim() || type.title;
  } catch {
    return type.title;
  }
}

type Tab = "yours" | "import" | "browse";
const TABS = [
  { value: "yours", label: "Your agents", panelId: "agents-yours" },
  { value: "import", label: "Import", panelId: "agents-import" },
  { value: "browse", label: "Browse", panelId: "agents-browse" },
] as const;

export function AgentsPage({
  agents,
  relay,
  navigation,
  navigator,
}: {
  agents: Agents;
  relay: RelayData;
  navigation?: PageNavigation;
  navigator?: Navigation;
}) {
  const { snapshot, types } = useAgents(agents);
  const connection = useRelayConnection(relay);
  const channels = useChannelChoices(
    connection.status === "ready" ? connection.session.channels : undefined,
  );
  const [tab, setTab] = useState<Tab>("yours");
  const [frame, setFrame] = useState<Frame>({ view: "browse" });
  const [creating, setCreating] = useState(false);
  const [localProviderKey, setLocalProviderKey] = useState<string>();
  const routed = !!navigation && !!navigator;
  const providerKey = routed
    ? agentProviderRoute(
        navigation.target.kind === "page"
          ? navigation.target.route?.params
          : undefined,
      )
    : localProviderKey;
  const setProviderKey = (provider?: string, replace = false) => {
    if (!navigation || !navigator) {
      setLocalProviderKey(provider);
      return;
    }
    if (
      navigation.signal.aborted ||
      navigation.target.kind !== "page" ||
      navigation.target.pluginId !== "buzz.agents" ||
      navigation.target.pageId !== "agents" ||
      navigator.snapshot().entry.id !== navigation.entryId
    )
      return;
    const target = agentProviderTarget(navigation.target, provider);
    void (replace
      ? navigator.open(target, { replace: true })
      : navigator.open(target));
  };
  const typeOf = (agent: Agent) =>
    types.find((type) => type.key === agent.type);
  const find = (pubkey: string | undefined) =>
    snapshot.agents.find((agent) => agent.pubkey === pubkey);
  const building = frame.view === "build" ? find(frame.pubkey) : undefined;
  const selected = frame.view === "browse" ? find(frame.selected) : undefined;
  const side = frame.view === "browse" ? frame.side : undefined;
  const browse = (selected?: string) =>
    setFrame(selected ? { view: "browse", selected } : { view: "browse" });
  const build = (pubkey: string) => {
    // A just-made agent may not be shown yet.
    const agent = find(pubkey);
    if (agent?.place !== "elsewhere" && !agent?.unfinished)
      setFrame({ view: "build", pubkey });
  };
  const ready = types.length > 0 && snapshot.status === "ready";
  // Importing gives an agent a key here, so a hosted type cannot take one.
  const runnable = types.filter((type) => !type.remote);
  const openTeams = () => setFrame({ view: "browse", side: "teams" });
  const more = useRef<HTMLButtonElement>(null);

  const yours = (() => {
    if (snapshot.status === "unavailable")
      return (
        <EmptyState
          icon="✦"
          title="Agents runs in the desktop app"
          description="Agent keys stay in the desktop app's native custody."
        />
      );
    if (snapshot.status === "error")
      return (
        <EmptyState
          icon="!"
          title="Agents could not load"
          description={snapshot.error ?? "Try again."}
        />
      );
    if (snapshot.status === "ready" && !types.length && !snapshot.agents.length)
      return (
        <EmptyState
          icon="✦"
          title="No agents yet"
          description="Enable an agent type plugin to make one."
        />
      );
    return (
      <Inventory
        agents={snapshot.agents}
        selected={selected?.pubkey}
        typeOf={typeOf}
        onSelect={browse}
        onBuild={build}
        newAgent={
          types.length > 0 && (
            <NewAgentTile
              disabled={snapshot.status !== "ready"}
              onClick={() => setCreating(true)}
            />
          )
        }
      />
    );
  })();

  const body = (() => {
    if (building)
      return (
        <AgentBuild
          key={building.pubkey}
          agents={agents}
          agent={building}
          type={typeOf(building)}
          types={types}
          channels={channels}
          memories={
            connection.status === "ready"
              ? connection.session.agentMemories
              : undefined
          }
          onRemoved={() => browse()}
        />
      );
    const panel =
      tab !== "yours" ? undefined : side === "teams" ? (
        <Teams
          agents={agents}
          saved={snapshot.agents.filter((agent) => agent.place === "here")}
          teams={snapshot.teams}
          onClose={() => browse()}
        />
      ) : selected ? (
        <AgentPeek
          key={selected.pubkey}
          agents={agents}
          agent={selected}
          type={typeOf(selected)}
          channels={channels}
          onBuild={() => build(selected.pubkey)}
          onClose={() => browse()}
        />
      ) : undefined;
    return (
      <div className={styles.browse} data-side={panel ? "" : undefined}>
        <div className={styles.inventory}>
          <div className={styles.content}>
            <Tabs
              variant="panel"
              label="Agent tabs"
              value={tab}
              onValueChange={setTab}
              items={TABS}
            />
            <section
              id={`agents-${tab}`}
              role="tabpanel"
              aria-labelledby={`agents-${tab}-tab`}
            >
              {tab === "yours" ? (
                yours
              ) : tab === "import" ? (
                <ImportAgents
                  agents={agents}
                  types={runnable}
                  onImported={() => setTab("yours")}
                />
              ) : (
                <AgentBrowse
                  relay={relay}
                  agents={agents}
                  types={runnable}
                  onImported={() => setTab("yours")}
                />
              )}
            </section>
          </div>
        </div>
        {panel && <aside className={styles.side}>{panel}</aside>}
      </div>
    );
  })();

  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Agents">
        <div className="flex h-full min-h-0 flex-col">
          <PanelHeader
            {...(building
              ? {
                  navigation: (
                    <IconButton
                      aria-label="All agents"
                      size="sm"
                      icon={<ArrowLeftIcon size={16} aria-hidden="true" />}
                      onClick={() => browse(building.pubkey)}
                    />
                  ),
                }
              : {})}
            title={
              building ? (
                building.name
              ) : (
                <Tabs
                  variant="navigation"
                  label="Agents header"
                  value="agents"
                  onValueChange={() => {}}
                  showSelection={false}
                  items={[
                    {
                      value: "agents",
                      label: "Agents",
                      icon: <RobotIcon size="1rem" />,
                    },
                  ]}
                />
              )
            }
            actions={
              !building && tab === "yours" && ready ? (
                <MenuRoot>
                  <MenuTrigger
                    render={
                      <IconButton
                        ref={more}
                        aria-label="More agent actions"
                        title="More agent actions"
                        size="sm"
                        icon={<DotsThreeIcon size={16} aria-hidden="true" />}
                      />
                    }
                  />
                  <MenuPopup align="end">
                    <ProviderSubmenu types={types} onSelect={setProviderKey} />
                    <MenuItem onClick={openTeams} disabled={side === "teams"}>
                      Teams
                    </MenuItem>
                  </MenuPopup>
                </MenuRoot>
              ) : undefined
            }
          />
          <div className="min-h-0 flex-1">{body}</div>
        </div>
      </FullPageSurface>
      {creating && (
        <AgentCreateDialog
          agents={agents}
          types={types}
          community={
            connection.status === "ready" ? connection.origin : undefined
          }
          onClose={() => setCreating(false)}
          onCreated={(agent) => {
            setCreating(false);
            setTab("yours");
            build(agent.pubkey);
          }}
        />
      )}
      {providerKey && (
        <ProviderDialog
          type={types.find((type) => type.key === providerKey)}
          finalFocus={more}
          onClose={() => setProviderKey(undefined, true)}
        />
      )}
    </div>
  );
}

/** A quick device-wide health view. Controls stay in each provider's dialog. */
function ProviderSubmenu({
  types,
  onSelect,
}: {
  types: readonly RegisteredAgentType[];
  onSelect(key: string): void;
}) {
  const check = () => {
    for (const { provider } of types) if (provider) checkProvider(provider);
  };
  return (
    <MenuSubmenu>
      <MenuSubmenuTrigger onFocus={check} onPointerEnter={check}>
        Provider settings
      </MenuSubmenuTrigger>
      <MenuSubmenuPopup aria-label="Provider settings">
        {types.map((type) => {
          const fallback = (
            <MenuItem aria-label={`${type.title}, unavailable`} disabled>
              <ProviderIcon type={type} />
              {type.title}
            </MenuItem>
          );
          return (
            <ContributionBoundary key={type.key} fallback={fallback}>
              <ProviderMenuItem
                type={type}
                onSelect={() => onSelect(type.key)}
              />
            </ContributionBoundary>
          );
        })}
      </MenuSubmenuPopup>
    </MenuSubmenu>
  );
}

function checkProvider(provider: NonNullable<RegisteredAgentType["provider"]>) {
  try {
    void Promise.resolve(provider.check()).catch(() => {});
  } catch {
    // A failed contribution does not break host-owned provider controls.
  }
}

function ProviderIcon({ type }: { type: RegisteredAgentType }) {
  const Icon = type.icon;
  return Icon ? (
    <MenuIcon>
      <Icon size={17} />
    </MenuIcon>
  ) : null;
}

function ProviderMenuItem({
  type,
  onSelect,
}: {
  type: RegisteredAgentType;
  onSelect(): void;
}) {
  const provider = type.provider;
  if (!provider)
    return (
      <MenuItem aria-label={`${type.title}, unavailable`} disabled>
        <ProviderIcon type={type} />
        {type.title}
      </MenuItem>
    );
  return (
    <ProviderHealthMenuItem
      type={type}
      provider={provider}
      onSelect={onSelect}
    />
  );
}

function ProviderHealthMenuItem({
  type,
  provider,
  onSelect,
}: {
  type: RegisteredAgentType;
  provider: NonNullable<RegisteredAgentType["provider"]>;
  onSelect(): void;
}) {
  const state = useSyncExternalStore(
    provider.subscribe,
    provider.snapshot,
    provider.snapshot,
  );
  const checking = state.readiness === "checking";
  const label =
    state.readiness === "attention"
      ? (state.attentionLabel ?? `Set up ${type.title}`)
      : type.title;
  const select = () => {
    if (state.readiness === "attention") {
      const action = provider.attentionAction;
      if (action)
        try {
          action();
          return;
        } catch {
          // Fall back to the provider's recovery guidance.
        }
    }
    onSelect();
  };
  return (
    <MenuItem
      aria-label={`${label}, ${state.readiness}`}
      aria-busy={checking || undefined}
      onClick={select}
      disabled={checking}
    >
      {checking ? (
        <MenuIcon>
          <CircleNotchIcon
            size={17}
            aria-hidden="true"
            className="motion-safe:animate-spin"
          />
        </MenuIcon>
      ) : (
        <ProviderIcon type={type} />
      )}
      {label}
    </MenuItem>
  );
}

function ProviderDialog({
  type,
  finalFocus,
  onClose,
}: {
  type: RegisteredAgentType | undefined;
  finalFocus: RefObject<HTMLButtonElement | null>;
  onClose(): void;
}) {
  const provider = type?.provider;
  if (!type || !provider) return null;
  return (
    <ContributionBoundary
      key={contributionKey(type)}
      fallback={
        <Dialog
          open
          onOpenChange={(open) => !open && onClose()}
          title={type.title}
          dismissOnOutsideClick
          finalFocus={() => finalFocus.current}
        >
          <p role="alert" className="m-0 text-body-sm text-danger">
            Provider controls are unavailable.
          </p>
        </Dialog>
      }
    >
      <ManagedProviderDialog
        type={type}
        provider={provider}
        finalFocus={finalFocus}
        onClose={onClose}
      />
    </ContributionBoundary>
  );
}

function ManagedProviderDialog({
  type,
  provider,
  finalFocus,
  onClose,
}: {
  type: RegisteredAgentType;
  provider: NonNullable<RegisteredAgentType["provider"]>;
  finalFocus: RefObject<HTMLButtonElement | null>;
  onClose(): void;
}) {
  const state = useSyncExternalStore(
    provider.subscribe,
    provider.snapshot,
    provider.snapshot,
  );
  const Icon = type.icon;
  const Body = provider.DialogBody;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={
        <span className="flex items-center gap-2">
          {Icon && <Icon size={22} aria-hidden="true" />}
          {type.title}
        </span>
      }
      headerGap="compact"
      dismissOnOutsideClick
      preventClose={!!state.blocking}
      finalFocus={() => finalFocus.current}
    >
      <Body onClose={onClose} />
    </Dialog>
  );
}

/** The grid as one listbox: a single tab stop, arrows move the selection. The
 * New agent tile leads the grid but is its own stop. */
function Inventory({
  agents,
  selected,
  typeOf,
  onSelect,
  onBuild,
  newAgent,
}: {
  agents: readonly Agent[];
  selected: string | undefined;
  typeOf(agent: Agent): RegisteredAgentType | undefined;
  onSelect(pubkey?: string): void;
  onBuild(pubkey: string): void;
  newAgent: ReactNode;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const index = agents.findIndex((agent) => agent.pubkey === selected);
  const columns = () =>
    grid.current
      ? getComputedStyle(grid.current).gridTemplateColumns.split(" ").length
      : 1;
  const onKeyDown = (event: KeyboardEvent) => {
    const last = agents.length - 1;
    const from = index < 0 ? -1 : index;
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: columns(),
      ArrowUp: -columns(),
    };
    let next: number | undefined;
    if (event.key in step) {
      const delta = step[event.key] ?? 0;
      next = from < 0 ? 0 : from + delta;
      if (next < 0 || next > last)
        next = Math.abs(delta) === 1 ? Math.min(Math.max(next, 0), last) : from;
    } else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Enter" && selected) {
      event.preventDefault();
      onBuild(selected);
      return;
    } else if (event.key === "Escape" && selected) {
      event.preventDefault();
      onSelect();
      return;
    }
    if (next === undefined) return;
    event.preventDefault();
    onSelect(agents[next]?.pubkey);
    grid.current
      ?.querySelectorAll<HTMLElement>('[role="option"]')
      [next]?.focus();
  };
  return (
    <div ref={grid} className={cardStyles.grid}>
      {newAgent}
      {agents.length > 0 && (
        <div
          role="listbox"
          aria-label="Agents"
          className="contents"
          onKeyDown={onKeyDown}
        >
          {agents.map((agent, position) => {
            const type = typeOf(agent);
            const active = agent.pubkey === selected;
            return (
              <AgentCard
                key={agent.pubkey}
                role="option"
                aria-selected={active}
                tabIndex={active || (index < 0 && position === 0) ? 0 : -1}
                data-unavailable={type ? undefined : ""}
                onClick={() => onSelect(active ? undefined : agent.pubkey)}
                onDoubleClick={() => onBuild(agent.pubkey)}
                agent={agent}
                community={agent.relay || undefined}
                icon={<TypeIcon type={type} />}
                detail={summaryOf(agent, type)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function SideHeader({ title, onClose }: { title: ReactNode; onClose(): void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">{title}</div>
      <IconButton
        aria-label="Close"
        size="sm"
        icon={<XIcon size={16} aria-hidden="true" />}
        onClick={onClose}
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2" aria-label={title}>
      <h4 className="m-0 text-caption text-secondary">{title}</h4>
      {children}
    </section>
  );
}

function AgentPeek({
  agents,
  agent,
  type,
  channels,
  onBuild,
  onClose,
}: {
  agents: Agents;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  channels: readonly ChannelChoice[];
  onBuild(): void;
  onClose(): void;
}) {
  const Peek = type?.Peek;
  const summary = summaryOf(agent, type);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState("");
  const finishButton = useRef<HTMLButtonElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  // Finish setup is replaced by Open on success; focus moves with it.
  const handoff = useRef(false);
  const finish = async () => {
    handoff.current = document.activeElement === finishButton.current;
    setFinishing(true);
    setError("");
    try {
      await agents.finish(agent.pubkey);
    } catch (reason) {
      handoff.current = false;
      setError(message(reason));
    }
    setFinishing(false);
  };
  useEffect(() => {
    if (agent.unfinished || !handoff.current) return;
    handoff.current = false;
    openButton.current?.focus();
  }, [agent.unfinished]);
  if (agent.place === "elsewhere")
    return (
      <div className={styles.sideBody}>
        <PeekIdentity agent={agent} detail={summary} onClose={onClose} />
        <p className="m-0 text-body-sm text-secondary">
          Its key is on another of your devices, which runs it. Open Agents
          there to change or delete it.
        </p>
      </div>
    );
  return (
    <div className={styles.sideBody}>
      <PeekIdentity
        agent={agent}
        detail={`${type?.title ?? "Type unavailable"}${
          type && !Peek && summary !== type.title ? ` · ${summary}` : ""
        }`}
        onClose={onClose}
      />
      {agent.unfinished ? (
        <>
          <p className="m-0 text-body-sm text-secondary">
            Its provider made it, but its setup did not finish.
          </p>
          <Button
            ref={finishButton}
            variant="primary"
            loading={finishing}
            onClick={() => void finish()}
          >
            Finish setup
          </Button>
          {error && (
            <p role="alert" className="m-0 text-body-sm text-danger">
              {error}
            </p>
          )}
          <AgentDelete agents={agents} agent={agent} onRemoved={onClose} />
        </>
      ) : (
        <Button ref={openButton} variant="primary" onClick={onBuild}>
          Open
        </Button>
      )}
      {Peek && !agent.unfinished ? (
        <div className={styles.peekPlugin}>
          <Peek agent={agent} />
        </div>
      ) : !type ? (
        <p className="m-0 text-body-sm text-secondary">
          Enable the plugin that provides this agent's type to run or change it.
        </p>
      ) : null}
      {agent.place === "here" && (
        <Section title="Wakes on">
          <AttentionSummary agent={agent} channels={channels} />
        </Section>
      )}
    </div>
  );
}

function PeekIdentity({
  agent,
  detail,
  onClose,
}: {
  agent: Agent;
  detail: string;
  onClose(): void;
}) {
  return (
    <div className={styles.peekIdentity}>
      <span className={styles.portraitLarge}>
        <AgentPortrait agent={agent} community={agent.relay || undefined} />
      </span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <h3 className="m-0 truncate text-heading">{agent.name}</h3>
        <p className="m-0 text-body-sm text-secondary">{detail}</p>
      </div>
      <IconButton
        aria-label="Close"
        size="sm"
        icon={<XIcon size={16} aria-hidden="true" />}
        onClick={onClose}
      />
    </div>
  );
}

const SOURCES: Record<PortSource, string> = {
  harness: "Buzz 1.0 harness agent",
  installed: "Buzz 0.X",
  development: "Buzz 0.X dev",
};
const host = (relay: string) => relay.replace(/^wss:\/\//, "");
const sentence = (text: string) => text.replace(/\.?$/, ".");

/** What a team import left undone, or "" if nothing. */
function teamPortNote({
  team,
  imported,
  failed,
  elsewhere,
  foreign,
  teamError,
}: TeamPort) {
  if (!failed.length && !elsewhere.length && !foreign.length && !teamError)
    return "";
  const came = imported.map((agent) => agent.name).join(", ");
  return [
    teamError
      ? `Couldn't save team ${teamError.name}. ${came ? `Imported ${came}; add them` : "Add its members"} in Teams.`
      : team && `Imported team ${team.name}${came ? ` with ${came}` : ""}.`,
    ...failed.map((member) =>
      sentence(`Couldn't import ${member.name}: ${member.error}`),
    ),
    elsewhere.length &&
      `Kept out: ${elsewhere.join(", ")}, in another community.`,
    foreign.length &&
      `Kept out: ${foreign.join(", ")}, which another account on this device has.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Identities earlier agent systems saved on this machine, each imported
 * with its key, name and picture as an agent of the chosen type. */
function ImportAgents({
  agents,
  types,
  onImported,
}: {
  agents: Agents;
  types: readonly RegisteredAgentType[];
  onImported(): void;
}) {
  const [found, setFound] = useState<FoundAgents>();
  const [type, setType] = useState(types[0]?.key ?? "");
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    agents.portable().then(
      (next) => live && setFound(next),
      (reason) => live && setError(message(reason)),
    );
    return () => {
      live = false;
    };
  }, [agents]);
  const chosen = types.find((item) => item.key === type) ?? types[0];
  const labels = publicKeyLabels(found?.agents.map((a) => a.pubkey) ?? []);
  const named = new Map<string, number>();
  for (const agent of found?.agents ?? [])
    named.set(agent.name, (named.get(agent.name) ?? 0) + 1);
  const port = async (agent: PortableAgent) => {
    if (!chosen || pending) return;
    setPending(agent.pubkey);
    setError("");
    try {
      await agents.port({
        source: agent.source,
        pubkey: agent.pubkey,
        type: chosen.key,
      });
      setFound(
        (last) =>
          last && {
            ...last,
            agents: last.agents.filter((item) => item.pubkey !== agent.pubkey),
          },
      );
      onImported();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPending(undefined);
    }
  };
  const portTeam = async (team: OldTeam) => {
    if (!chosen || pending) return;
    setPending(team.id);
    setError("");
    try {
      const result = await agents.portTeam({ id: team.id, type: chosen.key });
      const came = new Set(result.imported.map((agent) => agent.pubkey));
      setFound(
        (last) =>
          last && {
            ...last,
            agents: last.agents.filter((item) => !came.has(item.pubkey)),
            here: [...last.here, ...came],
          },
      );
      // Leaving would hide the one place that names what still needs a hand.
      const note = teamPortNote(result);
      if (note) setError(note);
      else onImported();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPending(undefined);
    }
  };
  const yours = new Set(found?.here);
  if (!types.length)
    return (
      <p className="m-0 text-body-sm text-secondary">
        Enable an agent type plugin to import agents.
      </p>
    );
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-body-sm text-secondary">
        {chosen?.adopt
          ? "Keeps each agent's key, name, picture and instructions in this community. Its other settings stay behind."
          : "Keeps each agent's key, name and picture in this community. Its instructions and settings stay behind."}{" "}
        Stop it where it runs now first, or both will answer.
      </p>
      {types.length > 1 && (
        <div className="flex">
          <Select
            label="Import as"
            value={chosen?.key ?? ""}
            disabled={!!pending}
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
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
      )}
      {found?.warnings.map((warning) => (
        <p key={warning} className="m-0 text-body-sm text-secondary">
          {warning}
        </p>
      ))}
      {!found ? (
        !error && (
          <p role="status" className="m-0 text-body-sm text-secondary">
            Looking for agents…
          </p>
        )
      ) : found.agents.length || found.teams.length ? (
        <>
          {found.teams.length > 0 && (
            <section aria-label="Teams to import">
              <InlineHeader title="Teams" />
              <ul className={styles.portList}>
                {found.teams.map((team) => {
                  const here = team.members.filter((member) =>
                    yours.has(member.pubkey),
                  ).length;
                  return (
                    <li key={team.id} className={styles.portRow}>
                      <span className="grid min-w-0 flex-1">
                        <span className="truncate text-body">{team.name}</span>
                        <span className="truncate text-caption text-secondary">
                          {[
                            `${team.members.length} ${team.members.length === 1 ? "member" : "members"}`,
                            here > 0 && `${here} already here`,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      <Button
                        size="compact"
                        variant="outline"
                        aria-label={`Import team ${team.name}`}
                        loading={pending === team.id}
                        disabled={!chosen || (!!pending && pending !== team.id)}
                        onClick={() => void portTeam(team)}
                      >
                        Import team
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {found.agents.length > 0 && (
            <section aria-label="Agents to import" className={cardStyles.grid}>
              {found.agents.map((agent) => (
                <AgentCard
                  key={agent.pubkey}
                  agent={agent}
                  community={agent.relay || undefined}
                  detail={
                    <Tooltip
                      content={[
                        canonicalPublicKey(agent.pubkey),
                        agent.relay && host(agent.relay),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      delay={300}
                    >
                      <span
                        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need access to its key and community in the tooltip.
                        tabIndex={0}
                      >
                        {[
                          SOURCES[agent.source],
                          // Its key tells it apart only from one of the same name.
                          named.get(agent.name) !== 1 &&
                            labels.get(agent.pubkey),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </Tooltip>
                  }
                >
                  <Button
                    size="compact"
                    variant="outline"
                    aria-label={`Import ${agent.name}`}
                    loading={pending === agent.pubkey}
                    disabled={
                      !chosen || (!!pending && pending !== agent.pubkey)
                    }
                    onClick={() => void port(agent)}
                  >
                    Import
                  </Button>
                </AgentCard>
              ))}
            </section>
          )}
        </>
      ) : (
        <p className="m-0 text-body-sm text-secondary">
          No other agents found to import.
        </p>
      )}
    </div>
  );
}

/** The owner's teams: each a name, instructions and members, given to every
 * member's prompt with a roster. Agents record nothing about their teams. */
function Teams({
  agents,
  saved,
  teams,
  onClose,
}: {
  agents: Agents;
  saved: readonly Agent[];
  teams: readonly Team[];
  onClose(): void;
}) {
  // A team's id while it is edited, or "new" for one being made.
  const [editing, setEditing] = useState<string>();
  const team = teams.find((item) => item.id === editing);
  if (editing === "new" || team)
    return (
      <TeamEditor
        key={editing}
        agents={agents}
        saved={saved}
        {...(team ? { team } : {})}
        onDone={() => setEditing(undefined)}
      />
    );
  const names = new Map(saved.map((agent) => [agent.pubkey, agent.name]));
  return (
    <section className={styles.sideBody} aria-label="Teams">
      <SideHeader
        title={<h3 className="m-0 text-heading">Teams</h3>}
        onClose={onClose}
      />
      <p className="m-0 text-body-sm text-secondary">
        Each member is told who its teammates are, and follows the team's
        instructions after its own.
      </p>
      {teams.length ? (
        <ul className={styles.portList} aria-label="Teams">
          {teams.map((item) => (
            <li key={item.id} className={styles.portRow}>
              <span className="grid min-w-0 flex-1">
                <span className="truncate text-body">{item.name}</span>
                <span className="truncate text-caption text-secondary">
                  {item.members
                    .map((pubkey) => names.get(pubkey))
                    .filter(Boolean)
                    .join(", ") || "No members"}
                </span>
              </span>
              <Button
                size="compact"
                aria-label={`Edit ${item.name}`}
                onClick={() => setEditing(item.id)}
              >
                Edit
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-body-sm text-secondary">No teams yet.</p>
      )}
      <Button variant="primary" onClick={() => setEditing("new")}>
        <PlusIcon size={14} aria-hidden="true" /> New team
      </Button>
    </section>
  );
}

function TeamEditor({
  agents,
  saved,
  team,
  onDone,
}: {
  agents: Agents;
  saved: readonly Agent[];
  team?: Team;
  onDone(): void;
}) {
  const [name, setName] = useState(team?.name ?? "");
  const [instructions, setInstructions] = useState(team?.instructions ?? "");
  const [members, setMembers] = useState<readonly string[]>(
    team?.members ?? [],
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const act = async (work: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await work();
      onDone();
    } catch (reason) {
      setError(message(reason));
      setPending(false);
    }
  };
  const save = () =>
    act(() =>
      agents.saveTeam({
        ...(team ? { id: team.id } : {}),
        name: name.trim(),
        instructions,
        members,
      }),
    );
  return (
    <form
      className={styles.sideBody}
      aria-label={team ? `Edit ${team.name}` : "New team"}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !pending) onDone();
      }}
    >
      <SideHeader
        title={
          <h3 className="m-0 text-heading">
            {team ? "Edit team" : "New team"}
          </h3>
        }
        onClose={onDone}
      />
      <Field label="Name">
        <Input
          autoFocus
          value={name}
          disabled={pending}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field
        label="Instructions"
        description="Every member follows these after its own instructions."
      >
        <Textarea
          rows={5}
          value={instructions}
          disabled={pending}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </Field>
      <Section title="Members">
        {saved.length ? (
          <div className="grid gap-2">
            {saved.map((agent) => (
              <Checkbox
                key={agent.pubkey}
                label={agent.name}
                checked={members.includes(agent.pubkey)}
                disabled={pending}
                onCheckedChange={(checked) =>
                  setMembers((last) =>
                    checked
                      ? [...last, agent.pubkey]
                      : last.filter((pubkey) => pubkey !== agent.pubkey),
                  )
                }
              />
            ))}
          </div>
        ) : (
          <p className="m-0 text-body-sm text-secondary">No agents yet.</p>
        )}
      </Section>
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          loading={pending}
          disabled={!name.trim()}
        >
          {team ? "Save" : "Create team"}
        </Button>
        {team && (
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => void act(() => agents.removeTeam(team.id))}
          >
            Delete team
          </Button>
        )}
      </div>
    </form>
  );
}

function AgentBuild({
  agents,
  agent,
  type,
  types,
  channels,
  memories,
  onRemoved,
}: {
  agents: Agents;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  types: readonly RegisteredAgentType[];
  channels: readonly ChannelChoice[];
  memories: AgentMemories | undefined;
  onRemoved(): void;
}) {
  const [copied, setCopied] = useState(false);
  const [pictureError, setPictureError] = useState("");
  const settings = useAgentSettingsHost({ agents, agent, type, types });
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className={styles.build}>
      <aside className={styles.rail} aria-label={`${agent.name} identity`}>
        <div className={styles.portraitEdit}>
          <AvatarEditor
            size="compact"
            shape="squircle"
            value={agent.picture ?? ""}
            name={agent.name}
            community={agent.relay}
            onChange={(picture) => {
              setPictureError("");
              agents
                .save(agent.pubkey, { picture: picture || null })
                .catch((error: unknown) => setPictureError(message(error)));
            }}
          />
          {pictureError && (
            <p role="alert" className="m-0 text-body-sm">
              {pictureError}
            </p>
          )}
        </div>
        <NameField
          name={agent.name}
          onSave={(name) => agents.save(agent.pubkey, { name })}
        />
        <dl className={styles.facts}>
          <dt>Key</dt>
          <dd className="flex items-center gap-1">
            <code className="truncate">{formatPublicKey(agent.pubkey, 8)}</code>
            <IconButton
              aria-label={copied ? "Copied" : "Copy public key"}
              size="sm"
              icon={<CopyIcon size={14} aria-hidden="true" />}
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(agent.pubkey)
                  .then(() => setCopied(true))
              }
            />
          </dd>
        </dl>
        <div className="mt-auto">
          <AgentDelete agents={agents} agent={agent} onRemoved={onRemoved} />
        </div>
      </aside>
      <section className={styles.work} aria-label={`${agent.name} settings`}>
        {!type && (
          <p className="m-0 mb-4 text-body-sm text-secondary">
            Enable the plugin that provides this agent's type to change its
            settings. Its attention can still be edited.
          </p>
        )}
        <AgentTabs
          agents={agents}
          agent={settings.agent}
          type={settings.type}
          channels={channels}
          settingsHost={settings.settingsHost}
          memories={memories}
        />
      </section>
    </div>
  );
}

/** Rename in place: saves on Enter or blur, Escape puts the name back. */
function NameField({
  name,
  onSave,
}: {
  name: string;
  onSave(name: string): Promise<void>;
}) {
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState("");
  // Escape blurs too, and blur saves; this skips that one save.
  const cancelled = useRef(false);
  useEffect(() => setDraft(name), [name]);
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const next = draft.trim();
    if (!next) return setDraft(name);
    if (next === name) return;
    setError("");
    onSave(next).catch((reason) => {
      setError(message(reason));
      setDraft(name);
    });
  };
  return (
    <Field label="Name" labelVisibility="hidden" error={error || undefined}>
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            cancelled.current = true;
            setDraft(name);
            event.currentTarget.blur();
            cancelled.current = false;
          }
        }}
      />
    </Field>
  );
}
