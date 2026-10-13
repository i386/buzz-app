// Claude's provider controls, New agent choices, and agent settings.
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityTranscript } from "../../features/agents/ActivityTranscript";
import type { Transcript } from "../../features/agents/activity-transcript";
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
  AgentViewProps,
} from "../../features/agents/service";
import { PanelSubview } from "../../features/panels/PanelSubview";
import { CircleNotchIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import {
  type ClaudeRuntime,
  type Config,
  config as readConfig,
  type SavedConversation,
  modelName as resolvedModelName,
} from "./runtime";
import type { ClaudeModel } from "./claude";
import type { ClaudeSetup } from "./setup";
import type { ClaudeDefaults } from "./defaults";
import { TURN_LIMIT } from "./transcript";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const label = ({ channelId, name, root }: SavedConversation) =>
  `${name ? `#${name}` : channelId.slice(0, 8)} · ${root ? `thread ${root.slice(0, 8)}` : "channel"}`;
const CONVERSATION_LIMIT = 30;
type Read =
  | { status: "ready"; transcript: Transcript & { more: boolean } }
  | { status: "missing" }
  | { status: "error"; error: string };

const options = (choices: readonly (readonly [string, string])[]) => [
  { label: "", options: choices.map(([value, label]) => ({ value, label })) },
];
const MODEL_CHOICES = [
  ["opus", "Opus"],
  ["sonnet", "Sonnet"],
  ["haiku", "Haiku"],
] as const;
const modelOptionCopy = (
  model: ClaudeModel | undefined,
  fallbackLabel: string,
) => {
  const label = model?.resolvedModel
    ? resolvedModelName(model.resolvedModel)
    : fallbackLabel;
  const descriptionPrefix = `${label} · `;
  const description = model?.description?.startsWith(descriptionPrefix)
    ? model.description.slice(descriptionPrefix.length)
    : model?.description;

  return { label, description };
};
const modelChoices = (models: readonly ClaudeModel[]) =>
  MODEL_CHOICES.map(([id, fallbackLabel]) => ({
    id,
    ...modelOptionCopy(
      models.find((model) => model.value === id),
      fallbackLabel,
    ),
  }));
const modelName = (model: string, models: readonly ClaudeModel[]) =>
  modelChoices(models).find((choice) => choice.id === model)?.label ??
  "Claude default";
const providerDefaultLabel = (
  model: string,
  models: readonly ClaudeModel[],
) => {
  if (model) return `Provider default · ${modelName(model, models)}`;
  const native = models.find((candidate) => candidate.value === "default");
  return native?.resolvedModel
    ? `Claude default (${resolvedModelName(native.resolvedModel)})`
    : "Claude default";
};
const SCOPES = options([
  ["thread", "One session per thread"],
  ["channel", "One session per channel"],
]);

export function createTabs({
  setup,
  defaults,
  runtime,
}: Readonly<{
  setup: ClaudeSetup;
  defaults: ClaudeDefaults;
  runtime: ClaudeRuntime;
}>) {
  const createModelLabel = (saved: Config) => {
    const model = readConfig(saved).model;
    if (!model) return undefined;
    return (
      modelChoices(setup.snapshot().models).find(
        (choice) => choice.id === model,
      )?.label ?? model
    );
  };

  function useSetupCatalog() {
    const state = useSyncExternalStore(
      setup.subscribe,
      setup.snapshot,
      setup.snapshot,
    );
    useEffect(() => {
      if (!state.status && !state.checking) void setup.check();
    }, [state.status, state.checking]);
    useEffect(() => {
      if (state.status?.state === "ready" && state.models.length === 0)
        void setup.loadModels();
    }, [state.status, state.models.length]);
    return state;
  }

  /** The instructions a new agent starts with. */
  function Create({ config, onChange, disabled }: AgentCreateProps<Config>) {
    const current = readConfig(config);
    return (
      <AgentInstructions
        value={current.instructions}
        disabled={disabled}
        onChange={(instructions) => onChange({ ...current, instructions })}
      />
    );
  }

  /** Claude's model choices inside the New agent provider submenu. */
  function CreateModelMenu({
    config,
    onChange,
    disabled,
    active = true,
    requestCustomModel,
  }: AgentCreateModelMenuProps<Config>) {
    const current = readConfig(config);
    const setupState = useSetupCatalog();
    const providerDefaults = useSyncExternalStore(
      defaults.subscribe,
      defaults.snapshot,
      defaults.snapshot,
    );
    return (
      <ModelPicker
        presentation="menu"
        active={active}
        allowCustomModel
        models={modelChoices(setupState.models)}
        value={current.model}
        defaultLabel={providerDefaultLabel(
          providerDefaults.model,
          setupState.models,
        )}
        defaultDescription="Following the provider's model default"
        disabled={disabled}
        requestCustomModel={requestCustomModel}
        onChange={(model) => onChange({ ...current, model })}
      />
    );
  }

  /** Claude Code installation and account readiness on this computer. */
  function ProviderDialogBody({ onClose }: { onClose(): void }) {
    const state = useSetupCatalog();
    const savedDefaults = useSyncExternalStore(
      defaults.subscribe,
      defaults.snapshot,
      defaults.snapshot,
    );
    const [draftDefault, setDraftDefault] = useState(savedDefaults.model);
    const [defaultError, setDefaultError] = useState("");
    const [code, setCode] = useState("");
    const status = state.status;
    const ready = status?.state === "ready" && !state.checking;
    const line =
      !status || state.checking
        ? "Checking Claude…"
        : status.state === "missing"
          ? "Claude is not installed."
          : status.state === "signed-out"
            ? `Claude ${status.version} needs you to sign in.`
            : status.state === "error"
              ? status.message
              : undefined;
    const action =
      status?.state === "missing"
        ? ({ step: "install", label: "Install Claude" } as const)
        : status?.state === "signed-out"
          ? ({ step: "login", label: "Sign in" } as const)
          : undefined;
    const model = (value: string) =>
      state.models.find((candidate) => candidate.value === value);
    const nativeModel = model("default");
    const nativeLabel = nativeModel?.resolvedModel
      ? `Claude default (${resolvedModelName(nativeModel.resolvedModel)})`
      : "Claude default";
    const latestOutputLine = state.output
      .replaceAll("\r", "\n")
      .split("\n")
      .map((candidate) => candidate.trim())
      .filter(Boolean)
      .at(-1);
    return (
      <div className="grid gap-6">
        <div className="grid gap-2" hidden={ready}>
          {!state.running && (
            <p
              role={status?.state === "error" ? "alert" : "status"}
              className="m-0 text-body-sm text-primary"
            >
              <strong>{line}</strong>
            </p>
          )}
          {state.running ? (
            <div className="flex flex-wrap items-center gap-2">
              <p
                role="status"
                className="m-0 flex items-center gap-2 text-body-sm"
              >
                <CircleNotchIcon
                  size={16}
                  aria-hidden="true"
                  className="motion-safe:animate-spin"
                />
                {state.running === "login"
                  ? "Waiting for Claude Code sign-in…"
                  : (latestOutputLine ?? "Installing Claude Code…")}
              </p>
              <Button onClick={() => void setup.cancel()}>Cancel</Button>
            </div>
          ) : action ? (
            <div className="flex flex-wrap gap-2">
              <Button
                autoFocus
                variant="prominent"
                onClick={() => void setup.run(action.step)}
              >
                {action.label}
              </Button>
            </div>
          ) : null}
          {status?.state === "missing" && !state.running && (
            <p className="m-0 text-body-sm text-subtle">
              Runs the official installer,{" "}
              <code>curl -fsSL https://claude.ai/install.sh | bash</code>, which
              puts <code>claude</code> in <code>~/.local/bin</code>.
            </p>
          )}
          {state.output && state.running !== "install" && (
            <div
              role="log"
              aria-label="Setup output"
              className="m-0 max-h-60 overflow-auto whitespace-pre-wrap text-body-sm text-subtle"
            >
              {state.output}
            </div>
          )}
          {state.running === "login" && (
            <form
              className="grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void setup.answer(code);
                setCode("");
              }}
            >
              <Field
                label="Sign-in code"
                description="If the browser shows a code to paste, enter it here."
              >
                <div className="flex items-center gap-2">
                  <Input value={code} onValueChange={setCode} />
                  <Button type="submit" disabled={!code.trim()}>
                    Send
                  </Button>
                </div>
              </Field>
            </form>
          )}
          {status?.state === "error" && (
            <p className="m-0 text-body-sm text-subtle">
              Open Claude Code in a terminal for more details, then please try
              again.
            </p>
          )}
        </div>
        <form
          className="grid gap-3"
          hidden={!ready}
          onSubmit={(event) => {
            event.preventDefault();
            setDefaultError("");
            try {
              defaults.save({ model: draftDefault });
            } catch (error) {
              setDefaultError(message(error));
              return;
            }
            onClose();
          }}
        >
          <Select
            label="Default model"
            variant="field"
            value={draftDefault}
            groups={[
              {
                label: "",
                options: [
                  {
                    value: "",
                    label: nativeLabel,
                    description: nativeModel
                      ? "Following Claude Code's recommendation"
                      : undefined,
                  },
                  ...MODEL_CHOICES.map(([value, fallbackLabel]) => {
                    const copy = modelOptionCopy(model(value), fallbackLabel);
                    return { value, ...copy };
                  }),
                ],
              },
            ]}
            {...(draftDefault === "" ? { valueLabel: nativeLabel } : {})}
            onValueChange={setDraftDefault}
          />
          {defaultError && (
            <p role="alert" className="buzz-field-error">
              {defaultError}
            </p>
          )}
          <div>
            <Button
              type="submit"
              variant="prominent"
              disabled={draftDefault === savedDefaults.model}
              focusableWhenDisabled
            >
              Save defaults
            </Button>
          </div>
        </form>
      </div>
    );
  }

  /** One conversation's session file, read on open and on Refresh. A refresh
   * keeps the last result in place until the new one arrives. */
  function TranscriptView({
    agent,
    conversation,
    working,
  }: {
    agent: AgentViewProps<Config>["agent"];
    conversation: SavedConversation;
    working: boolean;
  }) {
    const workspace = readConfig(agent.config).workspace;
    const [read, setRead] = useState<Read>();
    const [loading, setLoading] = useState(true);
    const [attempt, setAttempt] = useState(0);
    // A turn ending rereads, so its last steps show without a Refresh.
    // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the explicit Refresh.
    useEffect(() => {
      const abort = new AbortController();
      setLoading(true);
      void runtime
        .transcript(conversation, workspace, working, abort.signal)
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
    }, [conversation, workspace, working, attempt]);
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
            Reading the Claude session…
          </p>
        ) : read.status === "missing" ? (
          <p className="m-0 text-body-sm text-subtle">
            Claude has no transcript for this conversation on this computer. It
            may have been deleted, or the session ran in a different workspace.
          </p>
        ) : read.status === "error" ? (
          <p role="alert" className="m-0">
            Could not read the Claude session: {read.error}
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

  function Conversations({
    agent,
    conversation,
  }: {
    agent: AgentViewProps<Config>["agent"];
    conversation?: AgentViewProps<Config>["conversation"];
  }) {
    const sessions = useSyncExternalStore(
      (listener) => runtime.subscribe(listener),
      () => runtime.sessions(agent.pubkey),
    );
    const conversations = runtime.conversations(agent.pubkey);
    const busy = new Map(
      sessions.map((session) => [session.key, session.busy]),
    );
    const workspace = readConfig(agent.config).workspace;
    const {
      session: here,
      searching,
      error: lookupError,
    } = useOpenedSession(conversations, conversation, (place, signal) =>
      runtime.find(agent.pubkey, place, workspace, signal),
    );
    const recent = conversations
      .filter((item) => item.key !== here?.key)
      .slice(0, CONVERSATION_LIMIT);
    const activity = (key: string) => {
      const running = busy.get(key);
      return running === undefined ? undefined : running ? "Working" : "Idle";
    };
    const { open, show, back } = useOpenTranscript(conversation, label);
    return (
      <div className="grid gap-4">
        {conversation && (
          <OpenedConversation
            conversation={conversation}
            harness="Claude"
            session={here}
            searching={searching}
            error={lookupError}
            status={here && activity(here.key)}
            onView={() => here && show(here)}
          />
        )}
        <section className="grid gap-1">
          <h3 className="m-0 text-body">Recent conversations</h3>
          {recent.length ? (
            <ul className="m-0 grid list-none gap-2 p-0">
              {recent.map((item) => (
                <li
                  key={item.key}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate">{label(item)}</span>
                    <span className="block text-body-sm text-subtle">
                      {[activity(item.key), new Date(item.at).toLocaleString()]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => show(item)}
                  >
                    View transcript
                  </Button>
                </li>
              ))}
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
            <TranscriptView
              agent={agent}
              conversation={open}
              working={busy.get(open.key) ?? false}
            />
          </PanelSubview>
        )}
      </div>
    );
  }

  /** What the agent runs with. Saving restarts idle sessions with the change. */
  function SettingsTab({
    agent,
    save,
    settingsHost,
    conversation,
  }: AgentViewProps<Config>) {
    const saved = readConfig(agent.config);
    const setupState = useSetupCatalog();
    const providerDefaults = useSyncExternalStore(
      defaults.subscribe,
      defaults.snapshot,
      defaults.snapshot,
    );
    const [draft, setDraft] = useState(saved);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const configChanged = JSON.stringify(draft) !== JSON.stringify(saved);
    const changed = configChanged || Boolean(settingsHost?.pendingSave);
    const submit = async () => {
      setSaving(true);
      setError("");
      try {
        await save({
          ...draft,
          workspace: draft.workspace.trim() || "~/.buzz",
        });
      } catch (reason) {
        setError(message(reason));
      } finally {
        setSaving(false);
      }
    };
    const modelControl = (
      <ModelPicker
        allowCustomModel
        models={modelChoices(setupState.models)}
        value={draft.model}
        defaultLabel={providerDefaultLabel(
          providerDefaults.model,
          setupState.models,
        )}
        defaultDescription="Following the provider's model default"
        onChange={(model) => setDraft({ ...draft, model })}
      />
    );
    return (
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {settingsHost?.typeControl?.(configChanged)}
        {modelControl}
        <Field
          label="Workspace"
          description="The folder Claude works in. Use ~/ for your home folder."
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
          {/* Stays focusable while saving and once there is nothing to save. */}
          <Button
            type="submit"
            variant="prominent"
            loading={saving}
            disabled={!changed}
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

  return {
    Create,
    CreateModelMenu,
    createModelLabel,
    ProviderDialogBody,
    SettingsTab,
  };
}
