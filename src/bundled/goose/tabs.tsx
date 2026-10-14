// goose's New agent choices and agent settings. Providers, their keys and
// their models are goose's own: listed from it, and saved into its config.
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityTranscript } from "../../features/agents/ActivityTranscript";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import {
  type ModelChoice,
  ModelPicker,
} from "../../features/agents/ModelPicker";
import {
  OpenedConversation,
  useOpenedSession,
  useOpenTranscript,
} from "../../features/agents/OpenedConversation";
import type {
  AgentCreateModelMenuProps,
  AgentCreateProps,
  AgentViewProps,
} from "../../features/agents/service";
import { PanelSubview } from "../../features/panels/PanelSubview";
import { GooseLogoIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { ChoiceRow } from "../../shared/design-system/ui/ChoiceRow";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import {
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
} from "../../shared/design-system/ui/Menu";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import {
  type Config,
  DEFAULT_CONFIG,
  type GooseRuntime,
  config as readConfig,
} from "./runtime";
import {
  type GooseSetup,
  keyLabel,
  type Provider,
  type Providers,
  type Tested,
} from "./setup";
import {
  type GooseHistory,
  type GooseTranscript,
  type Place,
  TURN_LIMIT,
} from "./transcript";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const SCOPES = [
  {
    label: "",
    options: [
      { value: "thread", label: "One session per thread" },
      { value: "channel", label: "One session per channel" },
    ],
  },
];

type Choice = Readonly<{ provider: string; model: string }>;
type Read<T> =
  | { status: "loading"; value?: T }
  | { status: "ready"; value: T }
  | { status: "error"; error: string; value?: T };

/** `read()` as it settles, read again when `key` changes or on `retry`. A
 * value already shown stays while it is read again. */
function useRead<T>(read: () => Promise<T>, key: string) {
  const [state, setState] = useState<Read<T>>({ status: "loading" });
  const [round, setRound] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `read` follows `key`.
  useEffect(() => {
    let current = true;
    setState((prior) =>
      prior.value === undefined
        ? { status: "loading" }
        : { status: "loading", value: prior.value },
    );
    read().then(
      (value) => current && setState({ status: "ready", value }),
      (error: unknown) =>
        current && setState({ status: "error", error: message(error) }),
    );
    return () => {
      current = false;
    };
  }, [key, round]);
  return [state, () => setRound((value) => value + 1)] as const;
}

/** A session the profile can show: one found for a place, or one goose
 * listed by its title. */
type Row = Readonly<{
  key: string;
  sessionId: string;
  title: string;
  channelId: string;
  root?: string;
  at?: number;
}>;
const RECENT_LIMIT = 30;
/** `Anthropic · claude-opus-5-5`, or undefined for goose's own default. */
const choiceLabel = (
  { provider, model }: Choice,
  named: (id: string) => string | undefined = (id) => id,
) =>
  [provider && named(provider), model || (provider && "default model")]
    .filter(Boolean)
    .join(" · ") || undefined;
const placeOf = (key: string): Place => {
  const [channelId = key, root] = key.split("/");
  return { channelId, ...(root ? { root } : {}) };
};
/** Buzz titles a session `Agent · place · root`; the agent's name is the
 * profile's own. */
const titled = (name: string, title: string) =>
  title.startsWith(`${name} · `) ? title.slice(name.length + 3) : title;

export function createTabs({
  setup,
  runtime,
  history,
}: Readonly<{
  setup: GooseSetup;
  runtime: GooseRuntime;
  history: GooseHistory;
}>) {
  /** The provider, its key and its model, and a test that they answer. */
  function ProviderFields({
    value,
    onChange,
    disabled = false,
  }: Readonly<{
    value: Choice;
    onChange(value: Choice): void;
    disabled?: boolean;
  }>) {
    const [listing, reload] = useRead(() => setup.providers(), "providers");
    const providers: Providers | undefined = listing.value;
    const fallback = providers?.defaults.provider;
    const id = value.provider || fallback || "";
    const provider = providers?.providers.find((item) => item.id === id);
    const [models] = useRead(
      () => (id ? setup.models(id) : Promise.resolve([] as ModelChoice[])),
      `${id}:${provider?.configured ?? false}`,
    );
    // A result belongs to the choice it tested.
    const choice = `${value.provider}\u0000${value.model}`;
    const [result, setResult] = useState<{
      choice: string;
      tested: Tested | "testing";
    }>();
    const tested = result?.choice === choice ? result.tested : undefined;
    const named = (key: string | undefined) =>
      providers?.providers.find((item) => item.id === key)?.name ?? key;
    const modelDefault = value.provider
      ? provider?.defaultModel
      : (providers?.defaults.model ?? provider?.defaultModel);
    return (
      <>
        <Select
          label="Provider"
          variant="field"
          value={value.provider}
          disabled={disabled || !providers}
          {...(listing.status === "error"
            ? { error: listing.error }
            : listing.status === "loading" && !providers
              ? { description: "Loading goose's providers…" }
              : {})}
          groups={[
            {
              label: "",
              options: [
                {
                  value: "",
                  label: fallback
                    ? `From goose config (${named(fallback)})`
                    : "From goose config",
                },
                ...(providers?.providers ?? []).map((item) => ({
                  value: item.id,
                  label: item.name,
                  description: item.configured ? "Set up" : item.description,
                })),
              ],
            },
          ]}
          onValueChange={(provider) => onChange({ provider, model: "" })}
        />
        {listing.status === "error" && (
          <div>
            <Button onClick={reload}>Try again</Button>
          </div>
        )}
        {provider?.shared && setup.shared ? (
          <setup.shared.Connection
            disabled={disabled}
            onChange={() => {
              setup.refresh();
              reload();
            }}
          />
        ) : (
          provider && (
            <ProviderKeys
              key={provider.id}
              provider={provider}
              disabled={disabled}
              onSaved={reload}
            />
          )
        )}
        <ModelPicker
          allowCustomModel={!provider?.shared}
          models={models.value ?? []}
          loading={models.status === "loading"}
          value={value.model}
          defaultLabel={
            provider?.shared
              ? "Choose a Databricks model"
              : modelDefault
                ? `Provider default (${modelDefault})`
                : "Provider default"
          }
          {...(models.status === "error"
            ? { description: `Could not list models: ${models.error}` }
            : {})}
          disabled={disabled}
          onChange={(model) => onChange({ ...value, model })}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={disabled || tested === "testing"}
            loading={tested === "testing"}
            onClick={async () => {
              setResult({ choice, tested: "testing" });
              setResult({ choice, tested: await setup.test(value) });
            }}
          >
            Test connection
          </Button>
          {tested && tested !== "testing" && (
            <p
              role={tested.ok ? "status" : "alert"}
              className={
                tested.ok ? "m-0 text-body-sm" : "buzz-field-error m-0"
              }
            >
              {tested.message}
            </p>
          )}
        </div>
      </>
    );
  }

  /** A provider's key and other fields, saved into goose's config. One that
   * signs in through goose is set up there. */
  function ProviderKeys({
    provider,
    disabled,
    onSaved,
  }: Readonly<{ provider: Provider; disabled: boolean; onSaved(): void }>) {
    const [saved, reread] = useRead(
      () => setup.saved(provider.id),
      provider.id,
    );
    const [draft, setDraft] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [changing, setChanging] = useState(false);
    const entered = Object.fromEntries(
      Object.entries(draft).filter(([, text]) => text.trim()),
    );
    if (provider.signsIn && !provider.configured)
      return (
        <p className="m-0 text-body-sm">
          {provider.name} signs in through goose. Run{" "}
          <code>goose configure</code> to set it up, then choose it here.
        </p>
      );
    if (provider.signsIn || !provider.keys.length) return null;
    if (provider.configured && !changing)
      return (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="m-0 text-body-sm text-subtle">
            {provider.name} is set up in goose.
          </p>
          <Button disabled={disabled} onClick={() => setChanging(true)}>
            Change
          </Button>
        </div>
      );
    return (
      <>
        {provider.keys.map((key) => {
          const isSet = saved.value?.has(key.name);
          return (
            <Field
              key={key.name}
              label={
                key.required
                  ? keyLabel(key.name)
                  : `${keyLabel(key.name)} (optional)`
              }
              description={
                isSet
                  ? "Saved in goose. Enter a new value to replace it."
                  : key.default
                    ? `Default: ${key.default}`
                    : key.secret
                      ? provider.steps.join(" · ") || undefined
                      : undefined
              }
            >
              <Input
                type={key.secret ? "password" : "text"}
                autoComplete="off"
                value={draft[key.name] ?? ""}
                disabled={disabled || saving}
                placeholder={isSet ? "Saved" : (key.default ?? undefined)}
                onValueChange={(text) =>
                  setDraft({ ...draft, [key.name]: text })
                }
              />
            </Field>
          );
        })}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={disabled || !Object.keys(entered).length}
            loading={saving}
            onClick={async () => {
              setSaving(true);
              setError("");
              try {
                await setup.save(provider.id, entered);
                setDraft({});
                setChanging(false);
                reread();
                onSaved();
              } catch (reason) {
                setError(message(reason));
              } finally {
                setSaving(false);
              }
            }}
          >
            Save to goose
          </Button>
          {error && (
            <p role="alert" className="buzz-field-error m-0">
              {error}
            </p>
          )}
        </div>
      </>
    );
  }

  /** One session's turns, or a place's across its sessions, read on open and
   * on Refresh. A refresh keeps the last result until the new one arrives. */
  function TranscriptView({
    agent,
    row,
    working,
  }: {
    agent: AgentViewProps<Config>["agent"];
    row: Row;
    working?: string | undefined;
  }) {
    const workspace = readConfig(agent.config).workspace;
    const [read, setRead] = useState<
      | { status: "ready"; transcript: GooseTranscript }
      | { status: "missing" }
      | { status: "error"; error: string }
    >();
    const [loading, setLoading] = useState(true);
    const [attempt, setAttempt] = useState(0);
    // A turn ending rereads, so its last steps show without a Refresh.
    // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the explicit Refresh.
    useEffect(() => {
      const abort = new AbortController();
      setLoading(true);
      history
        .transcript(
          {
            agent: agent.pubkey,
            workspace,
            sessionId: row.sessionId,
            ...(row.channelId ? { place: placeOf(row.key) } : {}),
            ...(working ? { working } : {}),
          },
          abort.signal,
        )
        .then(
          (transcript) =>
            transcript
              ? ({ status: "ready", transcript } as const)
              : ({ status: "missing" } as const),
          (reason: unknown) =>
            ({ status: "error", error: message(reason) }) as const,
        )
        .then((next) => {
          if (abort.signal.aborted) return;
          setRead(next);
          setLoading(false);
        });
      return () => abort.abort();
    }, [row, workspace, working, attempt]);
    return (
      <div className="grid gap-4">
        <div>
          <Button
            type="button"
            variant="ghost"
            loading={loading}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Refresh
          </Button>
        </div>
        {!read ? (
          <p role="status" className="m-0">
            Reading the goose session…
          </p>
        ) : read.status === "missing" ? (
          <p className="m-0 text-body-sm text-subtle">
            goose has no session for this conversation on this computer. It may
            have been deleted, or it ran in a different workspace.
          </p>
        ) : read.status === "error" ? (
          <p role="alert" className="m-0">
            Could not read the goose session: {read.error}
          </p>
        ) : (
          <ActivityTranscript
            transcript={read.transcript}
            agentName={agent.name}
            state={() => (working ? "working" : undefined)}
            before={
              read.transcript.more && (
                <p className="m-0 text-body-sm text-subtle">
                  Showing the latest {TURN_LIMIT} turns.
                </p>
              )
            }
          />
        )}
      </div>
    );
  }

  /** The session of the conversation the profile was opened from, and the
   * agent's other recent sessions, each with its transcript. */
  function Conversations({
    agent,
    conversation,
  }: {
    agent: AgentViewProps<Config>["agent"];
    conversation?: AgentViewProps<Config>["conversation"];
  }) {
    const workspace = readConfig(agent.config).workspace;
    const live = useSyncExternalStore(
      (listener) => runtime.subscribe(listener),
      () => runtime.sessions(agent.pubkey),
    );
    const running = live.map(
      (session): Row => ({
        key: session.key,
        sessionId: session.sessionId ?? "",
        title: "",
        ...placeOf(session.key),
      }),
    );
    const {
      session: here,
      searching,
      error: lookupError,
    } = useOpenedSession(
      running.filter((row) => row.sessionId),
      conversation,
      async (place, signal) => {
        const found = await history.find(
          agent.pubkey,
          workspace,
          place,
          signal,
        );
        return (
          found && {
            ...found,
            ...place,
            key: place.root
              ? `${place.channelId}/${place.root}`
              : place.channelId,
          }
        );
      },
    );
    const [recent, reload] = useRead(() => {
      const abort = new AbortController();
      return history.recent(agent.name, workspace, abort.signal);
    }, `${agent.name}\u0000${workspace}`);
    const busy = (sessionId: string) =>
      live.find((session) => session.sessionId === sessionId)?.busy;
    const status = (sessionId: string) => {
      const working = busy(sessionId);
      return working === undefined ? undefined : working ? "Working" : "Idle";
    };
    const label = (row: Row) =>
      row.title
        ? titled(agent.name, row.title)
        : `${row.channelId.slice(0, 8)} · ${row.root ? `thread ${row.root.slice(0, 8)}` : "channel"}`;
    const { open, show, back } = useOpenTranscript(conversation, label);
    const rows = (recent.value ?? [])
      .filter((row) => row.sessionId !== here?.sessionId)
      .slice(0, RECENT_LIMIT)
      .map((row): Row => ({ ...row, key: row.sessionId, channelId: "" }));
    return (
      <div className="grid gap-4">
        {conversation && (
          <OpenedConversation
            conversation={conversation}
            harness="goose"
            session={here}
            searching={searching}
            error={lookupError}
            status={here && status(here.sessionId)}
            onView={() => here && show(here)}
          />
        )}
        <section className="grid gap-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="m-0 text-body">Recent sessions</h3>
            <Button
              type="button"
              variant="ghost"
              loading={recent.status === "loading"}
              onClick={reload}
            >
              Refresh
            </Button>
          </div>
          {recent.status === "error" ? (
            <p role="alert" className="buzz-field-error m-0">
              Could not list goose's sessions: {recent.error}
            </p>
          ) : rows.length ? (
            <ul className="m-0 grid list-none gap-2 p-0">
              {rows.map((row) => (
                <li
                  key={row.sessionId}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate">{label(row)}</span>
                    <span className="block text-body-sm text-subtle">
                      {[
                        status(row.sessionId),
                        row.at && new Date(row.at).toLocaleString(),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => show(row)}
                  >
                    View transcript
                  </Button>
                </li>
              ))}
            </ul>
          ) : recent.status === "ready" ? (
            <p className="m-0 text-body-sm text-subtle">
              None. A conversation's session starts when the agent is mentioned.
            </p>
          ) : null}
        </section>
        {open && (
          <PanelSubview
            title={label(open)}
            backLabel="Back to profile"
            onBack={back}
          >
            <TranscriptView
              agent={agent}
              row={open}
              working={busy(open.sessionId) ? open.sessionId : undefined}
            />
          </PanelSubview>
        )}
      </div>
    );
  }

  /** The provider, model and instructions a new agent starts with. */
  /** Whether New agent's provider dialog is open. The footer menu opens it
   * and closes before it shows, so Create, which stays, renders it. */
  const choosing = {
    open: false,
    listeners: new Set<() => void>(),
    set(open: boolean) {
      choosing.open = open;
      for (const listener of choosing.listeners) listener();
    },
    subscribe(listener: () => void) {
      choosing.listeners.add(listener);
      return () => {
        choosing.listeners.delete(listener);
      };
    },
  };

  /** The instructions a new agent starts with, and the provider dialog its
   * footer menu opens. */
  function Create({ config, onChange, disabled }: AgentCreateProps<Config>) {
    const current = readConfig(config);
    const open = useSyncExternalStore(choosing.subscribe, () => choosing.open);
    return (
      <>
        <AgentInstructions
          value={current.instructions}
          disabled={disabled}
          onChange={(instructions) => onChange({ ...current, instructions })}
        />
        {open && (
          <ChooseDialog
            value={current}
            onClose={() => choosing.set(false)}
            onChange={(choice) => {
              onChange({ ...current, ...choice });
              choosing.set(false);
            }}
          />
        )}
      </>
    );
  }

  /** A provider, its key and its model, chosen apart from the card. */
  function ChooseDialog({
    value,
    onChange,
    onClose,
  }: Readonly<{
    value: Choice;
    onChange(choice: Choice): void;
    onClose(): void;
  }>) {
    const [draft, setDraft] = useState<Choice>({
      provider: value.provider,
      model: value.model,
    });
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title="Provider and model"
        description="Choose a shared Buzz connection or a provider configured in goose."
        finalFocus={false}
        actions={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="prominent"
              disabled={draft.provider === setup.shared?.id && !draft.model}
              onClick={() => onChange(draft)}
            >
              Use
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <ProviderFields value={draft} onChange={setDraft} />
        </div>
      </Dialog>
    );
  }

  /** goose's own default and the agent's choice, in New agent's type menu. */
  function CreateModelMenu({
    config,
    onChange,
    disabled,
    active = true,
  }: AgentCreateModelMenuProps<Config>) {
    const current = readConfig(config);
    const [listing] = useRead(() => setup.providers(), "providers");
    const defaults = listing.value?.defaults;
    const named = (id: string | undefined) =>
      listing.value?.providers.find((item) => item.id === id)?.name ?? id;
    const fallback = [named(defaults?.provider), defaults?.model]
      .filter(Boolean)
      .join(" · ");
    const chosen = current.provider || current.model;
    const icon = <GooseLogoIcon size={18} aria-hidden="true" />;
    return (
      <>
        <MenuRadioGroup
          value={active ? (chosen ? "chosen" : "default") : "\0inactive"}
          onValueChange={(item) => {
            if (item === "default")
              onChange({ ...current, provider: "", model: "" });
            else onChange(current);
          }}
        >
          <MenuRadioItem value="default" disabled={disabled} closeOnClick>
            <ChoiceRow
              label={fallback ? `goose default (${fallback})` : "goose default"}
              description="From ~/.config/goose/config.yaml"
              leading={icon}
            />
          </MenuRadioItem>
          {chosen && (
            <MenuRadioItem value="chosen" disabled={disabled} closeOnClick>
              <ChoiceRow
                label={choiceLabel(current, named) ?? ""}
                description="Chosen for this agent"
                leading={icon}
              />
            </MenuRadioItem>
          )}
        </MenuRadioGroup>
        <MenuItem
          disabled={disabled}
          closeOnClick
          onClick={() => {
            // Choosing goose here also makes it the card's type.
            onChange(current);
            choosing.set(true);
          }}
        >
          <ChoiceRow
            label="Choose provider and model…"
            description="Set up a provider and its key, and test it"
            leading={icon}
          />
        </MenuItem>
      </>
    );
  }

  /** The trigger's detail for a provider or model chosen for this agent. */
  const createModelLabel = (saved: Config) => choiceLabel(readConfig(saved));

  function SettingsTab({
    agent,
    save,
    settingsHost,
    conversation,
  }: AgentViewProps<Config>) {
    const saved = readConfig(agent.config);
    const [draft, setDraft] = useState(saved);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const configChanged = JSON.stringify(draft) !== JSON.stringify(saved);
    const changed = configChanged || Boolean(settingsHost?.pendingSave);
    // A shared connection has no provider default to fall back on.
    const incomplete =
      draft.provider === setup.shared?.id && !draft.model.trim();
    const submit = async () => {
      if (incomplete) return;
      setSaving(true);
      setError("");
      try {
        await save({
          ...draft,
          model: draft.model.trim(),
          workspace: draft.workspace.trim() || DEFAULT_CONFIG.workspace,
        });
      } catch (reason) {
        setError(message(reason));
      } finally {
        setSaving(false);
      }
    };
    return (
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {settingsHost?.typeControl?.(configChanged)}
        <ProviderFields
          value={draft}
          onChange={(choice) => setDraft({ ...draft, ...choice })}
        />
        <Field
          label="Workspace"
          description="The folder goose works in. Use ~/ for your home folder."
        >
          <Input
            value={draft.workspace}
            onValueChange={(workspace) => setDraft({ ...draft, workspace })}
          />
        </Field>
        <Select
          label="Sessions"
          variant="field"
          value={draft.scope}
          groups={SCOPES}
          onValueChange={(value) =>
            setDraft({
              ...draft,
              scope: value === "channel" ? "channel" : "thread",
            })
          }
        />
        <AgentInstructions
          value={draft.instructions}
          disabled={false}
          description="Added to every session's system prompt, after Buzz's own."
          onChange={(instructions) => setDraft({ ...draft, instructions })}
        />
        {error && (
          <p role="alert" className="buzz-field-error">
            {error}
          </p>
        )}
        <div>
          <Button
            type="submit"
            variant="prominent"
            loading={saving}
            disabled={!changed || incomplete}
            focusableWhenDisabled
          >
            Save
          </Button>
        </div>
        <details className="grid gap-2">
          <summary>Runtime diagnostics</summary>
          <div className="mt-2">
            <Conversations agent={agent} conversation={conversation} />
          </div>
        </details>
      </form>
    );
  }

  return { Create, CreateModelMenu, createModelLabel, SettingsTab };
}
