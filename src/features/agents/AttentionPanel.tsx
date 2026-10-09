// The owner's view of an agent's `agent-attention/v1` objects. The agent writes
// them itself, through its attention tools; the owner reads them here, turns
// attention on or off, and can remove an object this app cannot read. Watches
// and timers sit under the Interest they serve.
import { useState } from "react";
import { formatItemTimestamp } from "../../shared/datetime";
import {
  AtIcon,
  EyeIcon,
  TimerIcon,
  TrashIcon,
  WarningCircleIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { Switch } from "../../shared/design-system/ui/Switch";
import {
  attentionOf,
  describeWatch,
  interestTitle,
  parseSlug,
  plural,
  timerSpent,
  timerState,
  type AttentionObject,
  type ChannelChoice,
  type EventWatch,
  type TimerWatch,
  type Watch,
  type WatchObject,
} from "./attention";
import type { ClassifierAvailability } from "./attention-objects";
import type { Agent, AgentChange } from "./service";
import type { SkippedObject } from "./store";

/** The app's own writer: the switch, and removing unreadable objects. */
type Save = (change: AgentChange) => Promise<void>;

function unnamed(watch: EventWatch): EventWatch {
  const { name: _, ...rest } = watch;
  return rest;
}

const watchIcon = (watch: Watch) =>
  watch.type === "timer" ? (
    <TimerIcon size={14} aria-hidden="true" />
  ) : (
    <EyeIcon size={14} aria-hidden="true" />
  );

/** Read-only: what wakes the agent, one line each. For glances like the peek. */
export function AttentionSummary({
  agent,
  channels = [],
}: {
  agent: Agent;
  channels?: readonly ChannelChoice[];
}) {
  const { watches } = attentionOf(agent.attention);
  const on = watches.filter((object) => object.value.enabled);
  const paused = watches.length - on.length;
  return (
    <ul className="m-0 grid list-none gap-1.5 p-0 text-body-sm">
      <li className="flex items-center gap-2">
        <AtIcon size={14} aria-hidden="true" /> Mentions
      </li>
      {on.map((object) => (
        <li key={object.slug} className="flex min-w-0 items-center gap-2">
          {watchIcon(object.value)}
          <span className="truncate">
            {describeWatch(object.value, channels)}
          </span>
        </li>
      ))}
      {paused > 0 && (
        <li className="text-secondary">{plural(paused, "paused watch")}</li>
      )}
    </ul>
  );
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPending(false);
    }
  };
  return { pending, error, run };
}
const Problem = ({ error }: { error: string }) =>
  error ? (
    <p role="alert" className="m-0 text-body-sm text-danger">
      {error}
    </p>
  ) : null;

export function AttentionPanel({
  agent,
  save,
  channels = [],
  classifier = "unavailable",
}: {
  agent: Agent;
  save: Save;
  channels?: readonly ChannelChoice[];
  /** Whether a watch's classifier can run on this device now. */
  classifier?: ClassifierAvailability;
}) {
  const { interests, watches, orphans } = attentionOf(agent.attention);
  const switched = useAction();
  const skipped = Object.values(agent.skipped);
  const row = (object: WatchObject) => (
    <WatchRow
      key={`${object.slug}:${object.modifiedAt}`}
      object={object}
      agent={agent}
      channels={channels}
      classifier={classifier}
    />
  );
  return (
    <div className="grid content-start gap-6">
      <p className="m-0 text-body-sm text-secondary">
        What wakes this agent. Mentions always do. For anything else, including
        replies in its threads that don't mention it, the agent keeps Interests:
        things it looks after, with instructions. The watches and timers under
        an Interest decide when it wakes for it. To change them, ask the agent.
      </p>
      <SettingsGroup>
        <PreferenceRow
          icon={<AtIcon size={16} />}
          title="Mentions"
          subtitle="Messages that mention it. Always on."
        />
        <PreferenceRow
          icon={<EyeIcon size={16} />}
          title="Attention"
          subtitle={
            <>
              Lets the agent add and change its own Interests, watches and
              timers, and wakes it for them. Off, nothing below wakes it, and it
              is not offered the tools.
              <Problem error={switched.error} />
            </>
          }
          trailing={
            <Switch
              aria-label="Attention on"
              checked={agent.attentionEnabled}
              disabled={switched.pending}
              onCheckedChange={(attentionEnabled) =>
                void switched.run(() => save({ attentionEnabled }))
              }
            />
          }
        />
      </SettingsGroup>
      {interests.length === 0 && watches.length === 0 && (
        <p className="m-0 text-body-sm text-secondary">
          {agent.attentionEnabled
            ? "The agent has no Interests yet."
            : "The agent has no Interests. Turn attention on to let it add some."}
        </p>
      )}
      {interests.map((object) => {
        const id = parseSlug(object.slug)?.id ?? object.slug;
        return (
          <InterestGroup
            key={object.slug}
            id={id}
            object={object}
            watches={watches.filter((watch) => watch.value.interest_id === id)}
            row={row}
          />
        );
      })}
      {orphans.length > 0 && (
        <section className="grid gap-2" aria-label="Without an interest">
          <div className="grid gap-0.5">
            <h4 className="m-0 text-label">Without an interest</h4>
            <p className="m-0 text-body-sm text-secondary">
              These name an Interest that does not exist, so they wake the agent
              without instructions.
            </p>
          </div>
          <SettingsGroup>{orphans.map(row)}</SettingsGroup>
        </section>
      )}
      {skipped.length > 0 && (
        <section className="grid gap-2" aria-label="Skipped">
          <div className="grid gap-0.5">
            <h4 className="m-0 text-label">Skipped</h4>
            <p className="m-0 text-body-sm text-secondary">
              These are saved but never wake the agent, because they are invalid
              or over a limit. The agent cannot change them; remove one to let
              it use that name again.
            </p>
          </div>
          <SettingsGroup>
            {skipped.map((object) => (
              <SkippedRow
                key={`${object.slug}:${object.modifiedAt}`}
                object={object}
                save={save}
              />
            ))}
          </SettingsGroup>
        </section>
      )}
    </div>
  );
}

function InterestGroup({
  id,
  object,
  watches,
  row,
}: {
  id: string;
  object: AttentionObject;
  watches: readonly WatchObject[];
  row(object: WatchObject): React.ReactNode;
}) {
  const instructions =
    object.value.type === "interest" ? object.value.instructions : "";
  const title = interestTitle(id);
  return (
    <section className="grid gap-2" aria-label={title}>
      <h4 className="m-0 text-label">{title}</h4>
      <p className="m-0 whitespace-pre-wrap text-body-sm text-secondary">
        {instructions}
      </p>
      {watches.length > 0 ? (
        <SettingsGroup>{watches.map(row)}</SettingsGroup>
      ) : (
        <p className="m-0 text-body-sm text-secondary">
          Nothing wakes it for this yet.
        </p>
      )}
    </section>
  );
}

/** Where a timer's schedule stands, for its row. */
function timerStatus(agent: Agent, slug: string, timer: TimerWatch) {
  const at = now();
  const state = timerState(timer, agent.timers[slug], at);
  const runs =
    timer.max_occurrences !== null
      ? `ran ${state.used} of ${plural(timer.max_occurrences, "time")}`
      : state.used > 0 && `ran ${plural(state.used, "time")}`;
  if (timerSpent(timer, state, at))
    return {
      spent: true,
      text:
        timer.expires_at !== null && at >= timer.expires_at
          ? "Ended"
          : `Done, ${runs}`,
    };
  return {
    spent: false,
    text: [
      timer.enabled &&
        `next ${formatItemTimestamp(Math.max(state.nextDue, at), { withTime: true })}`,
      runs,
      timer.expires_at !== null &&
        `until ${formatItemTimestamp(timer.expires_at, { withTime: true })}`,
    ]
      .filter(Boolean)
      .join(", "),
  };
}

function WatchRow({
  object,
  agent,
  channels,
  classifier,
}: {
  object: WatchObject;
  agent: Agent;
  channels: readonly ChannelChoice[];
  classifier: ClassifierAvailability;
}) {
  const { value, slug } = object;
  const title = describeWatch(value, channels);
  const status =
    value.type === "timer" ? timerStatus(agent, slug, value) : undefined;
  const detail =
    value.type === "timer"
      ? [`“${value.prompt}”`, status?.text]
      : [
          value.name && describeWatch(unnamed(value), channels),
          value.filter && `when ${value.filter}`,
          value.classifier &&
            (classifier === "available"
              ? "has a classifier"
              : "has a classifier, which cannot run on this device, so every match passes"),
        ];
  const state = status?.spent ? "Spent" : value.enabled ? "On" : "Paused";
  return (
    <PreferenceRow
      icon={
        value.type === "timer" ? <TimerIcon size={16} /> : <EyeIcon size={16} />
      }
      title={title}
      disabled={state !== "On"}
      subtitle={
        detail.some(Boolean) ? detail.filter(Boolean).join(" · ") : undefined
      }
      trailing={<span className="text-body-sm text-secondary">{state}</span>}
    />
  );
}

/** A stored object the reader skipped: its problem, and a way to remove it. */
function SkippedRow({ object, save }: { object: SkippedObject; save: Save }) {
  const action = useAction();
  return (
    <PreferenceRow
      icon={<WarningCircleIcon size={16} />}
      title={object.slug}
      subtitle={
        <>
          {object.problem}
          <Problem error={action.error} />
        </>
      }
      trailing={
        <IconButton
          aria-label={`Remove ${object.slug}`}
          size="sm"
          disabled={action.pending}
          icon={<TrashIcon size={16} aria-hidden="true" />}
          onClick={() =>
            void action.run(() => save({ attention: { [object.slug]: null } }))
          }
        />
      }
    />
  );
}

const now = () => Math.floor(Date.now() / 1000);
