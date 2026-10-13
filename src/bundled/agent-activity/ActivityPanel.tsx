import { publicKeyLabels } from "../../shared/identity/public-key";
import { useIdentityNames } from "../../features/identity-names/react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  activitySelection,
  type ActivitySelection,
} from "../../features/agents/activity-target";
import { activityRecords } from "../../features/agents/activity-records";
import { activityTranscript } from "../../features/agents/activity-transcript";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { ActivityTranscript } from "../../features/agents/ActivityTranscript";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Select } from "../../shared/design-system/ui/Select";
import { Button } from "../../shared/design-system/ui/Button";
import { selectProfiles } from "../../features/relay/profile-selection";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";

const scope = (channelId: string, threadRootId?: string) =>
  JSON.stringify(threadRootId ? [channelId, threadRootId] : [channelId]);

export function ActivityPanel({
  relay,
  target = "",
}: {
  relay: RelayData;
  target?: string;
}) {
  const connection = useRelayConnection(relay);
  if (connection.status !== "ready")
    return (
      <p className="p-4 text-body">
        Connect to a community to view agent activity.
      </p>
    );
  return (
    <ActivityDetails
      key={`${connection.scope}:${connection.generation}:${target}`}
      session={connection.session}
      selection={activitySelection(target)}
    />
  );
}
export function ActivityDetails({
  session,
  selection,
}: {
  session: RelaySession;
  selection?: ActivitySelection | undefined;
}) {
  const activity = session.agentActivity;
  const snapshot = useSyncExternalStore(
    activity.subscribe,
    activity.snapshot,
    activity.snapshot,
  );
  const agents = useMemo(
    () => [
      ...new Set([
        ...snapshot.historyAgents,
        ...snapshot.records.map((row) => row.agent),
      ]),
    ],
    [snapshot.records, snapshot.historyAgents],
  );
  const [selected, select] = useState(selection?.agent ?? "");
  // "" is every conversation, [channel] the whole channel and [channel, root]
  // one thread; JSON keeps any channel ID intact.
  const [conversation, selectConversation] = useState(
    selection?.channelId
      ? scope(selection.channelId, selection.threadRootId)
      : "",
  );
  const [channelId = "", threadRootId] = conversation
    ? (JSON.parse(conversation) as string[])
    : [];
  const agentChoices = useMemo(
    () => [...new Set([...agents, ...(selected ? [selected] : [])])],
    [agents, selected],
  );
  const fallbackKeys = useMemo(
    () => publicKeyLabels(agentChoices),
    [agentChoices],
  );
  const resolveName = useIdentityNames(session.names);
  const profiles = useMemo(
    () => selectProfiles(session.profiles, agentChoices),
    [session.profiles, agentChoices],
  );
  // Reuse already loaded channel labels; opening activity does not scan a directory.
  const channels = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  ).channels;
  const identities = useSyncExternalStore(
    profiles.subscribe,
    profiles.snapshot,
    profiles.snapshot,
  );
  const agent = selected || agents[0] || "";
  useEffect(() => {
    activity.selectHistory(agent);
  }, [activity, agent]);
  const [expanded, expand] = useState<string[]>([]);
  const agentRecords = snapshot.records.filter((row) => row.agent === agent);
  const records = useMemo(
    () => activityRecords(snapshot.records, agent, channelId),
    [snapshot.records, agent, channelId],
  );
  const channelChoices = [
    ...new Set([
      ...agentRecords.flatMap((row) => row.channelIds),
      ...(channelId ? [channelId] : []),
    ]),
  ];
  const channelName = (id: string) =>
    `#${channels.find((channel) => channel.id === id)?.name ?? id}`;
  const region = useRef<HTMLElement>(null);
  useEffect(() => {
    region.current?.focus();
  }, []);
  // Keep expansion intent as bounded as the underlying RAM journal.
  useEffect(() => {
    const ids = new Set(records.map((row) => row.id));
    expand((previous) =>
      previous.every((id) => ids.has(id))
        ? previous
        : previous.filter((id) => ids.has(id)),
    );
  }, [records]);
  const [view, setView] = useState<"transcript" | "raw">("transcript");
  // Threads are discovered from loaded turns, timed by their first loaded turn
  // and named by their first loaded prompt.
  const threads = useMemo(() => {
    const found = new Map<
      string,
      {
        channelId: string;
        root: string;
        time?: string;
        text?: string | undefined;
      }
    >();
    for (const turn of activityTranscript(snapshot.records, { agent }).turns) {
      if (!turn.channelId || !turn.threadRootId) continue;
      const key = scope(turn.channelId, turn.threadRootId);
      const thread = found.get(key) ?? {
        channelId: turn.channelId,
        root: turn.threadRootId,
        time: new Date(turn.startedAt).toLocaleString(undefined, {
          dateStyle: "short",
          timeStyle: "short",
        }),
      };
      found.set(key, thread);
      const prompt = turn.items.find((item) => item.type === "prompt");
      if (prompt?.type === "prompt")
        thread.text ||= prompt.text.split("\n").find(Boolean)?.slice(0, 60);
    }
    if (threadRootId && !found.has(conversation))
      found.set(conversation, { channelId, root: threadRootId });
    return [...found].map(([key, { channelId, root, time, text }]) => ({
      key,
      channelId,
      label: [time, text || `thread ${root.slice(0, 8)}`]
        .filter(Boolean)
        .join(" · "),
    }));
  }, [snapshot.records, agent, channelId, threadRootId, conversation]);
  const transcript = useMemo(
    () =>
      activityTranscript(snapshot.records, {
        agent,
        channelId: channelId || undefined,
        threadRootId,
      }),
    [snapshot.records, agent, channelId, threadRootId],
  );
  // A thread counts only its own known turns, not its channel's other conversations.
  const shown =
    threadRootId && new Set(transcript.turns.map((turn) => turn.turnId));
  const turns = snapshot.turns.filter(
    (turn) =>
      turn.agent === agent &&
      (!channelId || turn.channelId === channelId) &&
      (!shown || shown.has(turn.turnId)),
  );
  const agentLabel = (key: string) =>
    resolveName(
      key,
      identities.get(key)?.name ?? `Agent · ${fallbackKeys.get(key) ?? key}`,
      agentChoices,
    );
  const working = turns.filter((turn) => turn.state === "working").length;
  const unknown = turns.filter((turn) => turn.state === "unknown").length;
  const history = snapshot.history !== "unavailable" && (
    <Button
      size="compact"
      disabled={snapshot.history === "loading"}
      onClick={() => void activity.latestHistory()}
    >
      Show latest saved activity
    </Button>
  );
  const older = snapshot.hasOlder && (
    <Button
      size="compact"
      disabled={snapshot.history === "loading"}
      onClick={() => void activity.loadOlder()}
    >
      Load older activity
    </Button>
  );
  // Capture and completeness notices; both views show them.
  const notices = (
    <>
      {snapshot.capture === "off" && (
        <p role="status">
          Saving activity is off. Live records are not being saved; existing
          history is kept.
        </p>
      )}
      {activity.archive && snapshot.capture === "unknown" && (
        <p role="status">Activity saving status is unknown.</p>
      )}
      {snapshot.capture === "error" && (
        <p role="alert">
          Some new archive records could not be saved. Check archive settings
          and retry the connection.
        </p>
      )}
      {!!snapshot.historySkipped && (
        <p role="alert">
          {snapshot.historySkipped} saved records could not be decoded on this
          page.
        </p>
      )}
      {snapshot.trimmed > 0 && (
        <p role="status">
          Live display limited: {snapshot.trimmed} records or turn states left
          the RAM window. Saved history is paged separately.
        </p>
      )}
    </>
  );
  const diagnostics = (
    <>
      <p className="text-body-sm text-secondary">
        Owner-only activity. Capture is controlled in Settings → Agents,
        independently of this plugin. Saved records are history, not current
        working status. This is not a complete ACP recording; the agent must
        publish telemetry.
      </p>
      <p role="status">
        Feed: {snapshot.status}. Quiet or disconnected means unknown, not
        stopped.
      </p>
      {notices}
      <p role="status">
        {snapshot.history === "loading"
          ? "Loading saved history…"
          : snapshot.history === "error"
            ? "Saved history could not be read. Live activity may still appear."
            : snapshot.history === "unavailable"
              ? "Saved history is unavailable on this host."
              : "Saved history loaded."}
      </p>
      {history}
      {snapshot.historyOlder && (
        <p role="status">
          Showing an older saved page. Newer saved pages are not shown; live
          records may still appear. Use Show latest saved activity to return.
        </p>
      )}
      {older}
    </>
  );
  const footer = (
    <p className="text-body-sm text-secondary">
      The live display keeps up to 200 records / 2 MiB plus one saved page. Use
      Load older activity to browse earlier pages, even when a page contains no
      entries for this channel. Retention and capture are controlled in Settings
      → Agents; disabling this plugin only clears its live display.
    </p>
  );
  const raw = (
    <div className="flex min-w-0 flex-col gap-4">
      {diagnostics}
      {channelId && (
        <p className="text-body-sm text-secondary">
          Channel-wide, including threads. Batches show only matching channel
          entries; unscoped entries are omitted.
        </p>
      )}
      <p className="text-body-sm text-secondary">
        Working evidence expires after 30 seconds without a fresh turn record.
        Completed means ended, not necessarily succeeded.
      </p>
      {!records.length && (
        <p>
          No captured records for this identity
          {channelId ? " in this channel" : ""}. Only owner-visible agent
          telemetry appears. Activity published while capture was off cannot be
          recovered.
        </p>
      )}
      {snapshot.historyOlder && (
        <p className="text-body-sm text-secondary">
          Gap: this saved page is not continuous with the live display. Loading
          another page replaces this saved page.
        </p>
      )}
      <Accordion
        value={expanded}
        onValueChange={expand}
        items={records.map((row) => ({
          value: row.id,
          title: `${row.kind} · ${new Date(row.receivedAt).toLocaleString()}`,
          content: (
            <div className="min-w-0">
              <p className="break-all text-body-sm text-secondary">
                Event {row.envelopeId}
              </p>
              <pre className="max-h-96 overflow-auto bg-inset p-3 font-mono text-mono">
                <code>{row.plaintext}</code>
              </pre>
            </div>
          ),
        }))}
      />
      {footer}
    </div>
  );
  const state = new Map(turns.map((turn) => [turn.turnId, turn.state]));
  const timeline = (
    <ActivityTranscript
      transcript={transcript}
      agentName={agentLabel(agent)}
      state={(turnId) => state.get(turnId)}
      before={
        <>
          {notices}
          {snapshot.history === "loading" && (
            <p role="status" className="text-body-sm text-secondary">
              Loading saved history…
            </p>
          )}
          {snapshot.history === "error" && (
            <p role="alert">Saved history could not be read.</p>
          )}
          {snapshot.historyOlder && (
            <p className="text-body-sm text-secondary">
              Showing an older saved page; newer saved activity is hidden.
            </p>
          )}
          {(older || snapshot.historyOlder) && (
            <div className="flex flex-wrap gap-2">
              {older}
              {snapshot.historyOlder && history}
            </div>
          )}
          {transcript.unknownThread > 0 && (
            <p className="text-body-sm text-secondary">
              {transcript.unknownThread} turn(s) with an unknown thread appear
              only in the whole channel.
            </p>
          )}
        </>
      }
    />
  );
  return (
    <section
      ref={region}
      tabIndex={-1}
      data-buzz-ui=""
      aria-label="Agent activity"
      className="flex min-w-0 flex-col gap-4 p-4 text-body text-primary"
    >
      <h2 className="text-heading">Agent activity</h2>
      {snapshot.status === "unavailable" ? (
        <p>
          This host cannot decode agent activity. Use the desktop app or
          development broker.
        </p>
      ) : (
        <>
          {snapshot.status === "interrupted" && (
            <Button size="compact" onClick={() => session.live.retry()}>
              Retry live feed
            </Button>
          )}
          {!agents.length && !selected ? (
            <>
              {diagnostics}
              <p>
                No captured activity yet. New activity appears when an agent
                publishes telemetry while capture is enabled. There is no relay
                backfill.
              </p>
              {footer}
            </>
          ) : (
            <>
              <Select
                label="Agent"
                value={agent}
                groups={[
                  {
                    label: "Observed agents",
                    options: agentChoices.map((key) => ({
                      value: key,
                      label: agentLabel(key),
                    })),
                  },
                ]}
                onValueChange={(key) => {
                  select(key);
                  expand([]);
                }}
              />
              <code className="break-all font-mono text-mono">{agent}</code>
              <Select
                label="Conversation"
                value={conversation}
                groups={[
                  {
                    label: "Activity scope",
                    options: [
                      {
                        value: "",
                        label: "All conversations (including unscoped records)",
                      },
                    ],
                  },
                  ...channelChoices.map((id) => ({
                    label: channelName(id),
                    options: [
                      {
                        value: scope(id),
                        label: `${channelName(id)} · whole channel, including threads`,
                      },
                      ...threads
                        .filter((thread) => thread.channelId === id)
                        .map(({ key, label }) => ({
                          value: key,
                          label: `${channelName(id)} › ${label}`,
                        })),
                    ],
                  })),
                ]}
                onValueChange={(value) => {
                  selectConversation(value);
                  expand([]);
                }}
              />
              <p role="status">
                {working
                  ? `${working} observed working turn(s).`
                  : "No fresh working evidence."}{" "}
                {unknown
                  ? `${unknown} turn(s) have unknown current state.`
                  : ""}
              </p>
              <Tabs
                variant="panel"
                label="Activity view"
                value={view}
                onValueChange={setView}
                items={[
                  { value: "transcript", label: "Transcript" },
                  { value: "raw", label: "Raw" },
                ]}
                renderPanel={(value) => (value === "raw" ? raw : timeline)}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}
