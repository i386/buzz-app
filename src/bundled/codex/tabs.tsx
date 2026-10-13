// The type's tabs: Codex's setup on this computer, and the agent's settings;
// and its part of the New agent dialog.
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityTranscript } from "../../features/agents/ActivityTranscript";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import { CreateCorner } from "../../features/agents/create-card";
import { ModelPicker } from "../../features/agents/ModelPicker";
import {
  OpenedConversation,
  useOpenedSession,
  useOpenTranscript,
} from "../../features/agents/OpenedConversation";
import type {
  AgentCreateProps,
  AgentViewProps,
} from "../../features/agents/service";
import { PanelSubview } from "../../features/panels/PanelSubview";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { InlineHeader } from "../../shared/design-system/ui/Header";
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
import { readTranscript, TURN_LIMIT, type CodexTranscript } from "./transcript";

type Catalog = { models: Model[]; account: string };
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
    if (!account.account)
      throw new Error(
        "Codex needs you to sign in. Run codex login in a terminal, then check again.",
      );
    const models = await listModels(rpc);
    return { models, account: account.account.email ?? account.account.type };
  } finally {
    signal.removeEventListener("abort", abort);
    await rpc.close();
  }
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const label = ({ channelId, name, root }: SavedConversation) =>
  `${name ? `#${name}` : channelId.slice(0, 8)} · ${root ? `thread ${root.slice(0, 8)}` : "channel"}`;
/** Conversations listed below the one the profile was opened from. */
const CONVERSATION_LIMIT = 30;
type Read =
  | { status: "ready"; transcript: CodexTranscript }
  | { status: "missing" }
  | { status: "error"; error: string };

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
const defaultLabel = (data?: Catalog) => {
  const model = data?.models.find((candidate) => candidate.isDefault);
  return model ? `Codex default · ${model.displayName}` : "Codex default";
};
/** A model's choice also resets the effort to that model's default. */
const modelChange = (model: string, data?: Catalog) => ({
  model,
  effort:
    data?.models.find((candidate) => candidate.model === model)
      ?.defaultReasoningEffort ?? "",
});

export function createTabs(spawn: Spawn, runtime: CodexRuntime) {
  /** The catalog check starts with the view and aborts when it unmounts. */
  function useCatalog() {
    const [data, setData] = useState<Catalog>();
    const [error, setError] = useState("");
    const [checking, setChecking] = useState(true);
    const [attempt, setAttempt] = useState(0);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Check again re-runs the check.
    useEffect(() => {
      let current = true;
      const abort = new AbortController();
      setChecking(true);
      setError("");
      void catalog(spawn, abort.signal)
        .then(
          (value) => {
            if (current) setData(value);
          },
          (reason) => {
            if (current) {
              setData(undefined);
              setError(message(reason));
            }
          },
        )
        .finally(() => {
          if (current) setChecking(false);
        });
      return () => {
        current = false;
        abort.abort();
      };
    }, [attempt]);
    return {
      data,
      error,
      checking,
      retry: () => setAttempt((value) => value + 1),
    };
  }

  /** The model and instructions a new agent starts with. */
  function Create({ config, onChange, disabled }: AgentCreateProps<Config>) {
    const current = readConfig(config);
    const { data, checking } = useCatalog();
    return (
      <>
        <CreateCorner>
          <ModelPicker
            compact
            models={choices(data)}
            value={current.model}
            defaultLabel={defaultLabel(data)}
            loading={checking}
            disabled={disabled}
            onChange={(model) =>
              onChange(readConfig({ ...current, ...modelChange(model, data) }))
            }
          />
        </CreateCorner>
        <AgentInstructions
          value={current.instructions}
          disabled={disabled}
          onChange={(instructions) =>
            onChange(readConfig({ ...current, instructions }))
          }
        />
      </>
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
    }, [conversation, agent.pubkey, agent.name, attempt]);
    return (
      <div className="grid gap-4">
        <div>
          <Button
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

  /** Codex on this computer, and what this agent has running. */
  function CodexTab({ agent, conversation }: AgentViewProps<Config>) {
    const { data, error, checking, retry } = useCatalog();
    const sessions = useSyncExternalStore(runtime.subscribe, () =>
      runtime.sessions(agent.pubkey),
    );
    // Read on each render: bindings change as turns start, which also
    // changes the session list this tab subscribes to.
    const conversations = runtime.conversations(agent.pubkey);
    const {
      session: here,
      searching,
      error: lookupError,
    } = useOpenedSession(conversations, conversation, (place, signal) =>
      runtime.find({ pubkey: agent.pubkey, name: agent.name }, place, signal),
    );
    const { open, show, back } = useOpenTranscript(conversation, label);
    const saved = new Set(conversations.map((row) => row.key));
    const views = new Map(sessions.map((view) => [view.key, view]));
    const recent = conversations
      .filter((row) => row.key !== here?.key)
      .slice(0, CONVERSATION_LIMIT);
    const detail = (text: string) => (
      <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap text-caption">
        {text}
      </pre>
    );
    return (
      <div className="grid gap-4">
        <section className="grid gap-2">
          <p role="status" className="m-0">
            {checking
              ? "Checking Codex…"
              : data
                ? `Codex is ready (${data.account}).`
                : "Codex needs attention."}
          </p>
          {error && (
            <p role="alert" className="m-0">
              {error}
            </p>
          )}
          <div>
            <Button
              variant="ghost"
              disabled={checking}
              focusableWhenDisabled
              onClick={retry}
            >
              Check again
            </Button>
          </div>
          <p className="m-0 text-body-sm text-subtle">
            Uses your existing Codex sign-in. Install Codex and run codex login
            in a terminal if needed.
          </p>
        </section>
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
          <InlineHeader title="Recent conversations" />
          {recent.length || sessions.some((view) => !saved.has(view.key)) ? (
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
              {recent.map((row) => {
                const view = views.get(row.key);
                return (
                  <li key={row.key} className="grid gap-2">
                    <p className="m-0">
                      {label(row)}
                      {[
                        view?.status,
                        row.at ? new Date(row.at).toLocaleString() : undefined,
                      ]
                        .filter(Boolean)
                        .map((part) => ` · ${part}`)
                        .join("")}
                    </p>
                    {view?.detail && detail(view.detail)}
                    <div>
                      <Button variant="ghost" onClick={() => show(row)}>
                        View transcript
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="m-0 text-body-sm text-subtle">
              Mention this agent in a channel to start a conversation.
            </p>
          )}
          <p className="m-0 text-body-sm text-subtle">
            Only your messages trigger this agent. New mentions steer active
            work and continue the same session when idle. Event watches work for
            your messages; timers are not supported yet.
          </p>
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
  function SettingsTab({ agent, save }: AgentViewProps<Config>) {
    const saved = readConfig(agent.config);
    const [draft, setDraft] = useState(saved);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const { data, error: catalogError, checking, retry } = useCatalog();
    useEffect(() => {
      setDraft(readConfig(agent.config));
    }, [agent.config]);
    const selected =
      data?.models.find((model) => model.model === draft.model) ??
      (!draft.model
        ? data?.models.find((model) => model.isDefault)
        : undefined);
    const supported = selected?.supportedReasoningEfforts ?? [];
    const efforts = [
      { value: "", label: "Model default" },
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
    const changed = JSON.stringify(draft) !== JSON.stringify(saved);
    const submit = async () => {
      setSaving(true);
      setError("");
      try {
        const settings = readConfig(draft);
        if (!validWorkspace(settings.workspace))
          throw new Error("Enter an absolute workspace path or ~/.buzz.");
        await save(settings);
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
        {catalogError && (
          <div className="grid justify-items-start gap-2">
            <p role="alert" className="m-0">
              {catalogError}
            </p>
            <Button
              variant="ghost"
              disabled={checking}
              focusableWhenDisabled
              onClick={retry}
            >
              Check again
            </Button>
          </div>
        )}
        <ModelPicker
          models={choices(data)}
          value={draft.model}
          defaultLabel={defaultLabel(data)}
          loading={checking}
          disabled={saving}
          description={selected?.description}
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
      </form>
    );
  }

  return { CodexTab, SettingsTab, Create };
}
