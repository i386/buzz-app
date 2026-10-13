// The type's tabs: Codex's setup on this computer, and the agent's settings;
// and its part of the New agent dialog.
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityTranscript } from "../../features/agents/ActivityTranscript";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import { ModelPicker } from "../../features/agents/ModelPicker";
import {
  OpenedConversation,
  useOpenedSession,
  useOpenTranscript,
} from "../../features/agents/OpenedConversation";
import type {
  AgentCreateModelMenuProps,
  AgentCreateProps,
  AgentProviderSnapshot,
  AgentViewProps,
} from "../../features/agents/service";
import { PanelSubview } from "../../features/panels/PanelSubview";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import {
  config as readConfig,
  effortName,
  validWorkspace,
  type Config,
  type Model,
} from "./config";
import { AppServer, listModels, type Spawn } from "./rpc";
import type { CodexRuntime, SavedConversation } from "./runtime";
import type { CodexSetup } from "./setup";
import { readTranscript, TURN_LIMIT, type CodexTranscript } from "./transcript";

const label = ({ channelId, name, root }: SavedConversation) =>
  `${name ? `#${name}` : channelId.slice(0, 8)} · ${root ? `thread ${root.slice(0, 8)}` : "channel"}`;
type Read =
  | { status: "ready"; transcript: CodexTranscript }
  | { status: "missing" }
  | { status: "error"; error: string };

type Catalog = { models: Model[]; account: string };
type ProviderDefaults = Readonly<{ model: string; effort: string }>;
type ProviderState = AgentProviderSnapshot &
  Readonly<{
    checking: boolean;
    data: Catalog | undefined;
    error: string;
    defaults: ProviderDefaults;
  }>;
const STORAGE_KEY = "buzz.codex.provider-defaults.v1";
const SIGN_IN_ERROR = "Codex needs you to sign in.";
const NOT_INSTALLED = "Codex is not installed.";
const CONVERSATION_LIMIT = 30;
/** Read-only setup/catalog discovery uses the same declared native transport. */
async function catalog(spawn: Spawn, signal: AbortSignal) {
  const rpc = new AppServer();
  const abort = () => {
    void rpc.close();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await rpc.open(spawn);
    signal.throwIfAborted();
    const account = await rpc.request<{
      account: { type: string; email?: string } | null;
    }>("account/read");
    if (!account.account) throw new Error(SIGN_IN_ERROR);
    const models = await listModels(rpc);
    return { models, account: account.account.email ?? account.account.type };
  } finally {
    signal.removeEventListener("abort", abort);
    await rpc.close();
  }
}

/** Codex's one device-wide health/catalog view and versioned default store. */
export class CodexProvider {
  private state: ProviderState;
  private readonly listeners = new Set<() => void>();
  private abort: AbortController | undefined;
  private pending: Promise<void> | undefined;
  private readonly offSetup: (() => void) | undefined;

  constructor(
    private readonly spawn: Spawn,
    private readonly storage: Storage = localStorage,
    private readonly setup?: CodexSetup,
  ) {
    this.state = Object.freeze({
      readiness: "checking",
      checking: false,
      data: undefined,
      error: "",
      defaults: this.readDefaults(),
    });
    // An install or sign-in holds the dialog open, then Codex is checked again.
    this.offSetup = setup?.subscribe(() => {
      const running = Boolean(setup.snapshot().running);
      if (running === Boolean(this.state.blocking)) return;
      const { blocking: _, ...rest } = this.state;
      this.state = Object.freeze(running ? { ...rest, blocking: true } : rest);
      for (const listener of this.listeners) listener();
      if (!running) void this.check();
    });
  }

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private set(change: Partial<ProviderState>) {
    this.state = Object.freeze({ ...this.state, ...change });
    for (const listener of this.listeners) listener();
  }
  check() {
    if (this.pending) return this.pending;
    const pending = this.runCheck();
    this.pending = pending;
    void pending.finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    return pending;
  }
  private async runCheck() {
    const abort = new AbortController();
    this.abort = abort;
    this.set({
      ...(this.state.data ? {} : { readiness: "checking" as const }),
      checking: true,
      error: "",
    });
    try {
      const status = await this.setup?.check();
      if (status && status.state !== "ready")
        throw new Error(
          status.state === "missing"
            ? NOT_INSTALLED
            : status.state === "signed-out"
              ? SIGN_IN_ERROR
              : status.message,
        );
      const data = await catalog(this.spawn, abort.signal);
      if (this.abort === abort) {
        this.set({
          readiness: "ready",
          checking: false,
          data,
          error: "",
        });
      }
    } catch (error) {
      const reason = message(error);
      if (this.abort === abort && !abort.signal.aborted)
        this.set({
          readiness: "attention",
          attentionLabel:
            reason === NOT_INSTALLED
              ? "Install Codex"
              : reason === SIGN_IN_ERROR
                ? "Log in to Codex"
                : "Codex needs attention",
          checking: false,
          data: undefined,
          error: reason,
        });
    } finally {
      if (this.abort === abort) this.abort = undefined;
    }
  }
  saveDefaults(next: ProviderDefaults) {
    const selected = this.model(next.model);
    const effort =
      !next.effort ||
      selected?.supportedReasoningEfforts.some(
        (choice) => choice.reasoningEffort === next.effort,
      )
        ? next.effort
        : (selected?.defaultReasoningEffort ?? "");
    const defaults = Object.freeze({ model: next.model, effort });
    this.writeDefaults(defaults);
    this.set({ defaults });
  }
  resolve(raw: unknown): Config {
    const explicit = readConfig(raw);
    const inheritedModel = this.state.defaults.model;
    const unavailable = Boolean(
      inheritedModel && this.state.data && !this.model(inheritedModel),
    );
    const model = explicit.model || (unavailable ? "" : inheritedModel);
    if (explicit.effort) return { ...explicit, model };
    const selected = this.model(model);
    const preferred =
      unavailable && !explicit.model ? "" : this.state.defaults.effort;
    const effort = !preferred
      ? ""
      : !this.state.data
        ? preferred
        : selected?.supportedReasoningEfforts.some(
              (choice) => choice.reasoningEffort === preferred,
            )
          ? preferred
          : (selected?.defaultReasoningEffort ?? "");
    return { ...explicit, model, effort };
  }
  dispose() {
    this.offSetup?.();
    this.abort?.abort();
    this.abort = undefined;
  }
  private model(model: string) {
    return model
      ? this.state.data?.models.find((choice) => choice.model === model)
      : this.state.data?.models.find((choice) => choice.isDefault);
  }
  private writeDefaults(defaults: ProviderDefaults) {
    this.storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, ...defaults }),
    );
  }
  private readDefaults(): ProviderDefaults {
    try {
      const value: unknown = JSON.parse(
        this.storage.getItem(STORAGE_KEY) ?? "null",
      );
      if (
        value &&
        typeof value === "object" &&
        (value as { version?: unknown }).version === 1 &&
        typeof (value as { model?: unknown }).model === "string" &&
        typeof (value as { effort?: unknown }).effort === "string"
      )
        return Object.freeze({
          model: (value as { model: string }).model,
          effort: (value as { effort: string }).effort,
        });
    } catch {
      // Malformed local preferences preserve Codex's native defaults.
    }
    return Object.freeze({ model: "", effort: "" });
  }
}

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

/** The catalog's models, for the picker; it adds Codex's own default. */
const choices = (data?: Catalog) =>
  data?.models.map((model) => ({
    id: model.model,
    label: model.displayName,
    description: model.description,
  })) ?? [];
const providerDefaultLabel = (model: string, data?: Catalog) => {
  if (model) {
    const selected = data?.models.find(
      (candidate) => candidate.model === model,
    );
    if (!data || selected)
      return `Provider default · ${selected?.displayName || selected?.model || model}`;
  }
  const native = data?.models.find((candidate) => candidate.isDefault);
  const name = native?.displayName || native?.model;
  return name ? `Codex default (${name})` : "Codex default";
};
const codexDefaultEffortLabel = (effort: string, model?: Model) => {
  const resolved = effort || model?.defaultReasoningEffort;
  return resolved ? `Codex default (${effortName(resolved)})` : "Codex default";
};
/** A model's choice also resets the effort to that model's default. */
const modelChange = (model: string, data?: Catalog) => ({
  model,
  effort:
    data?.models.find((candidate) => candidate.model === model)
      ?.defaultReasoningEffort ?? "",
});

export function createTabs(
  provider: CodexProvider,
  runtime: CodexRuntime,
  spawn: Spawn,
  setup: CodexSetup,
) {
  const createModelLabel = (saved: Config) => {
    const model = readConfig(saved).model;
    if (!model) return undefined;
    return (
      choices(provider.snapshot().data).find((choice) => choice.id === model)
        ?.label ?? model
    );
  };

  function useProvider() {
    const state = useSyncExternalStore(
      provider.subscribe,
      provider.snapshot,
      provider.snapshot,
    );
    useEffect(() => {
      if (state.readiness === "checking" && !state.checking)
        void provider.check();
    }, [state.readiness, state.checking]);
    return state;
  }

  function ProviderDialogBody({ onClose }: { onClose(): void }) {
    const state = useProvider();
    const { data, error, checking } = state;
    const installing = useSyncExternalStore(
      setup.subscribe,
      setup.snapshot,
      setup.snapshot,
    );
    const [draft, setDraft] = useState(state.defaults);
    const [saveError, setSaveError] = useState("");
    const action =
      error === NOT_INSTALLED
        ? ({ step: "install", label: "Install Codex" } as const)
        : error === SIGN_IN_ERROR
          ? ({ step: "login", label: "Sign in" } as const)
          : undefined;
    useEffect(() => setDraft(state.defaults), [state.defaults]);
    const nativeModel = data?.models.find((model) => model.isDefault);
    const selected = draft.model
      ? data?.models.find((model) => model.model === draft.model)
      : nativeModel;
    const efforts = [
      { value: "", label: codexDefaultEffortLabel("", selected) },
      ...(draft.effort &&
      !selected?.supportedReasoningEfforts.some(
        (effort) => effort.reasoningEffort === draft.effort,
      )
        ? [
            {
              value: draft.effort,
              label: `${effortName(draft.effort)} (unavailable)`,
            },
          ]
        : []),
      ...(selected?.supportedReasoningEfforts.map((effort) => ({
        value: effort.reasoningEffort,
        label: effortName(effort.reasoningEffort),
      })) ?? []),
    ];
    return (
      <div className="grid gap-6">
        {installing.notice && (
          <p role="status" className="m-0 text-body-sm">
            {installing.notice}
          </p>
        )}
        <div className="grid gap-2" hidden={state.readiness === "ready"}>
          {installing.running ? (
            <div className="flex flex-wrap items-center gap-2">
              <p role="status" className="m-0 text-body-sm">
                {installing.running === "login"
                  ? "Waiting for Codex sign-in…"
                  : "Installing Codex…"}
              </p>
              <Button onClick={() => void setup.cancel()}>Cancel</Button>
            </div>
          ) : checking ? (
            <p role="status" className="m-0">
              Checking Codex…
            </p>
          ) : error ? (
            <p role="alert" className="m-0 text-body-sm text-primary">
              <strong>{error}</strong>
            </p>
          ) : null}
          {action && !installing.running && !checking && (
            <div className="flex flex-wrap gap-2">
              <Button
                autoFocus
                variant="prominent"
                onClick={() => void setup.run(action.step)}
              >
                {action.label}
              </Button>
            </div>
          )}
          {action?.step === "install" && !installing.running && (
            <p className="m-0 text-body-sm text-subtle">
              Downloads Buzz's own copy of Codex (about 130 MB) from
              releases.openai.com and keeps it on the latest release. It does
              not change the <code>codex</code> in your terminal, and uses the
              same sign-in and settings.
            </p>
          )}
          {installing.output && (
            <div
              role="log"
              aria-label="Setup output"
              className="m-0 max-h-60 overflow-auto whitespace-pre-wrap text-body-sm text-subtle"
            >
              {installing.output}
            </div>
          )}
        </div>
        <form
          className="grid gap-3"
          hidden={state.readiness !== "ready"}
          onSubmit={(event) => {
            event.preventDefault();
            setSaveError("");
            try {
              provider.saveDefaults(draft);
            } catch (reason) {
              setSaveError(message(reason));
              return;
            }
            onClose();
          }}
        >
          <Select
            label="Default model"
            variant="field"
            value={draft.model}
            disabled={checking || !data}
            groups={[
              {
                label: "",
                options: [
                  {
                    value: "",
                    label: nativeModel
                      ? `Codex default (${nativeModel.displayName})`
                      : "Codex default",
                    description: nativeModel
                      ? "Following Codex's recommendation"
                      : undefined,
                  },
                  ...(draft.model &&
                  !data?.models.some((model) => model.model === draft.model)
                    ? [
                        {
                          value: draft.model,
                          label: `${draft.model} (unavailable)`,
                        },
                      ]
                    : []),
                  ...(data?.models.map((model) => ({
                    value: model.model,
                    label: model.displayName,
                    description: model.description,
                  })) ?? []),
                ],
              },
            ]}
            onValueChange={(model) => setDraft({ ...draft, model, effort: "" })}
          />
          <Select
            label="Default thinking"
            variant="field"
            value={draft.effort}
            groups={[{ label: "", options: efforts }]}
            disabled={checking || !selected}
            onValueChange={(effort) => setDraft({ ...draft, effort })}
          />
          {saveError && (
            <p role="alert" className="buzz-field-error">
              {saveError}
            </p>
          )}
          <div>
            <Button
              type="submit"
              variant="prominent"
              disabled={
                JSON.stringify(draft) === JSON.stringify(state.defaults)
              }
              focusableWhenDisabled
            >
              Save defaults
            </Button>
          </div>
        </form>
      </div>
    );
  }

  /** The instructions a new agent starts with. */
  function Create({ config, onChange, disabled }: AgentCreateProps<Config>) {
    const current = readConfig(config);
    return (
      <AgentInstructions
        value={current.instructions}
        disabled={disabled}
        onChange={(instructions) =>
          onChange(readConfig({ ...current, instructions }))
        }
      />
    );
  }

  /** Codex's model choices inside the New agent provider submenu. */
  function CreateModelMenu({
    config,
    onChange,
    disabled,
    active = true,
  }: AgentCreateModelMenuProps<Config>) {
    const current = readConfig(config);
    const state = useProvider();
    const { data, checking } = state;
    return (
      <ModelPicker
        presentation="menu"
        active={active}
        allowCustomModel={false}
        models={choices(data)}
        value={current.model}
        defaultLabel={providerDefaultLabel(state.defaults.model, data)}
        defaultDescription="Following the provider's model default"
        loading={checking}
        disabled={disabled}
        onChange={(model) =>
          onChange(readConfig({ ...current, ...modelChange(model, data) }))
        }
      />
    );
  }

  /** One conversation's Codex thread, read on open and on Refresh. A refresh
   * keeps the last result in place until the new one arrives. */
  function TranscriptView({
    agent,
    conversation,
  }: {
    agent: AgentViewProps<Config>["agent"];
    conversation: SavedConversation;
  }) {
    const [read, setRead] = useState<Read>();
    const [loading, setLoading] = useState(true);
    const [attempt, setAttempt] = useState(0);
    // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the explicit Refresh.
    useEffect(() => {
      const abort = new AbortController();
      setLoading(true);
      void readTranscript(
        spawn,
        { agent: { pubkey: agent.pubkey, name: agent.name }, ...conversation },
        abort.signal,
        (pubkey) => runtime.name(agent.pubkey, pubkey),
      )
        .then(
          (transcript): Read =>
            transcript
              ? { status: "ready", transcript }
              : { status: "missing" },
          (reason): Read => ({ status: "error", error: message(reason) }),
        )
        .then((next) => {
          if (abort.signal.aborted) return;
          setRead(next);
          setLoading(false);
        });
      return () => abort.abort();
    }, [conversation, attempt]);
    return (
      <div className="grid gap-4">
        <div className="flex gap-2">
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
            Reading the Codex session…
          </p>
        ) : read.status === "missing" ? (
          <p className="m-0 text-body-sm text-subtle">
            Codex has no history for this conversation on this computer. Its
            session may have been deleted.
          </p>
        ) : read.status === "error" ? (
          <p role="alert" className="m-0">
            Could not read the Codex session: {read.error}
          </p>
        ) : (
          <ActivityTranscript
            transcript={read.transcript}
            agentName={agent.name}
            state={() => (read.transcript.working ? "working" : undefined)}
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

  function Conversations({
    agent,
    conversation,
  }: {
    agent: AgentViewProps<Config>["agent"];
    conversation?: AgentViewProps<Config>["conversation"];
  }) {
    const sessions = useSyncExternalStore(runtime.subscribe, () =>
      runtime.sessions(agent.pubkey),
    );
    const conversations = runtime.conversations(agent.pubkey);
    const {
      session: here,
      searching,
      error: lookupError,
    } = useOpenedSession(conversations, conversation, (place, signal) =>
      runtime.find({ pubkey: agent.pubkey, name: agent.name }, place, signal),
    );
    const recent = conversations
      .filter((item) => item.key !== here?.key)
      .slice(0, CONVERSATION_LIMIT);
    const { open, show, back } = useOpenTranscript(conversation, label);
    const saved = new Set(conversations.map((row) => row.key));
    const views = new Map(sessions.map((view) => [view.key, view]));
    const detail = (text: string) => (
      <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap text-caption">
        {text}
      </pre>
    );
    return (
      <div className="grid gap-4">
        {conversation && (
          <OpenedConversation
            conversation={conversation}
            harness="Codex"
            session={here}
            searching={searching}
            error={lookupError}
            status={here && views.get(here.key)?.status}
            onView={() => here && show(here)}
          />
        )}
        <section className="grid gap-1">
          <h3 className="m-0 text-body">Recent conversations</h3>
          {recent.length || sessions.length ? (
            <ul className="m-0 grid list-none gap-4 p-0">
              {/* Work that failed before Codex started a thread has no binding. */}
              {sessions
                .filter((view) => !saved.has(view.key))
                .map((view) => (
                  <li key={view.key}>
                    <p className="m-0">
                      <code>{view.key}</code> · {view.status}
                    </p>
                    {view.detail && detail(view.detail)}
                  </li>
                ))}
              {recent.map((conversation) => {
                const view = views.get(conversation.key);
                return (
                  <li key={conversation.key} className="grid gap-2">
                    <p className="m-0">
                      {label(conversation)}
                      {[
                        view?.status,
                        conversation.at
                          ? new Date(conversation.at).toLocaleString()
                          : undefined,
                      ]
                        .filter(Boolean)
                        .map((part) => ` · ${part}`)
                        .join("")}
                    </p>
                    {view?.detail && detail(view.detail)}
                    <div>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => show(conversation)}
                      >
                        View transcript
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="m-0 text-body-sm text-subtle">
              None. A conversation's session starts when the agent is mentioned.
            </p>
          )}
        </section>
        {open && (
          <PanelSubview
            title={label(open)}
            backLabel="Back to profile"
            onBack={back}
          >
            <TranscriptView agent={agent} conversation={open} />
          </PanelSubview>
        )}
      </div>
    );
  }

  /** What the agent runs with. Saving applies to the next turn. */
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
    const {
      data,
      error: catalogError,
      checking,
      defaults: providerDefaults,
    } = useProvider();
    useEffect(() => {
      setDraft(readConfig(agent.config));
    }, [agent.config]);
    const effective = provider.resolve({ ...draft, effort: "" });
    const selected = effective.model
      ? data?.models.find((model) => model.model === effective.model)
      : data?.models.find((model) => model.isDefault);
    const supported = selected?.supportedReasoningEfforts ?? [];
    const efforts = [
      {
        value: "",
        label: codexDefaultEffortLabel(effective.effort, selected),
      },
      ...(draft.effort &&
      !supported.some((effort) => effort.reasoningEffort === draft.effort)
        ? [
            {
              value: draft.effort,
              label: `${effortName(draft.effort)} (unavailable)`,
            },
          ]
        : []),
      ...supported.map((effort) => ({
        value: effort.reasoningEffort,
        label: effortName(effort.reasoningEffort),
      })),
    ];
    const configChanged = JSON.stringify(draft) !== JSON.stringify(saved);
    const changed = configChanged || Boolean(settingsHost?.pendingSave);
    const submit = async () => {
      setSaving(true);
      setError("");
      try {
        const settings = readConfig(draft);
        if (!validWorkspace(settings.workspace))
          throw new Error("Enter an absolute or ~/… workspace path.");
        await save(settings);
      } catch (reason) {
        setError(message(reason));
      } finally {
        setSaving(false);
      }
    };
    const customization = (
      <>
        {catalogError && (
          <div className="grid justify-items-start gap-2">
            <p role="alert" className="m-0">
              {catalogError}
            </p>
            <Button
              variant="ghost"
              disabled={checking}
              focusableWhenDisabled
              onClick={() => void provider.check()}
            >
              Check again
            </Button>
          </div>
        )}
        <div className="grid gap-4 [@container(min-width:36rem)]:grid-cols-2">
          <ModelPicker
            allowCustomModel={false}
            models={choices(data)}
            value={draft.model}
            defaultLabel={providerDefaultLabel(providerDefaults.model, data)}
            defaultDescription="Following the provider's model default"
            loading={checking}
            disabled={saving}
            onChange={(model) =>
              setDraft({ ...draft, ...modelChange(model, data) })
            }
          />
          <Select
            label="Thinking"
            variant="field"
            value={draft.effort}
            groups={[{ label: "", options: efforts }]}
            disabled={checking || saving || !selected}
            onValueChange={(effort) => setDraft({ ...draft, effort })}
          />
        </div>
      </>
    );
    return (
      <form
        className="grid gap-4 [container-type:inline-size]"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {settingsHost?.typeControl?.(configChanged)}
        {customization}
        <Field
          label="Workspace"
          description="Codex starts here with full access to your files and network. Buzz tools run inside the app. Inherited MCP/Apps/plugin tools are disabled."
        >
          <Input
            value={draft.workspace}
            placeholder="~/.buzz"
            disabled={saving}
            onValueChange={(workspace) => setDraft({ ...draft, workspace })}
          />
        </Field>
        <Select
          label="Sessions"
          variant="field"
          value={draft.scope}
          groups={SCOPES}
          disabled={saving}
          description="DMs always share one conversation."
          onValueChange={(value) =>
            setDraft({
              ...draft,
              scope: value === "channel" ? "channel" : "thread",
            })
          }
        />
        <AgentInstructions
          value={draft.instructions}
          disabled={saving}
          description="Buzz guidance supplements Codex’s native instructions. Saved changes apply to the next turn. A workspace change starts a fresh session."
          onChange={(instructions) => setDraft({ ...draft, instructions })}
        />
        {error && (
          <p role="alert" className="buzz-field-error">
            {error}
          </p>
        )}
        <div>
          {/* Stays focusable while saving and once there is nothing to save. */}
          <Button
            type="submit"
            variant="prominent"
            loading={saving}
            disabled={!changed}
            focusableWhenDisabled
          >
            {saving ? "Saving…" : "Save"}
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

  return {
    Create,
    CreateModelMenu,
    createModelLabel,
    ProviderDialogBody,
    SettingsTab,
  };
}
