// The type's tabs: Claude's setup on this computer, and the agent's
// settings; and its part of the New agent dialog.
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityTranscript } from "../../features/agents/ActivityTranscript";
import type { Transcript } from "../../features/agents/activity-transcript";
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
  type ClaudeRuntime,
  type Config,
  config as readConfig,
  type SavedConversation,
} from "./runtime";
import type { ClaudeSetup } from "./setup";
import { TURN_LIMIT } from "./transcript";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const label = ({ channelId, name, root }: SavedConversation) =>
  `${name ? `#${name}` : channelId.slice(0, 8)} · ${root ? `thread ${root.slice(0, 8)}` : "channel"}`;
/** Conversations listed below the one the profile was opened from. */
const CONVERSATION_LIMIT = 30;
type Read =
  | { status: "ready"; transcript: Transcript & { more: boolean } }
  | { status: "missing" }
  | { status: "error"; error: string };

const options = (choices: readonly (readonly [string, string])[]) => [
  { label: "", options: choices.map(([value, label]) => ({ value, label })) },
];
// ModelPicker adds Claude's own default to these.
const MODELS = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];
const DEFAULT_MODEL = "Claude default";
const SCOPES = options([
  ["thread", "One session per thread"],
  ["channel", "One session per channel"],
]);

/** The model and instructions a new agent starts with. */
export function Create({
  config,
  onChange,
  disabled,
}: AgentCreateProps<Config>) {
  const current = readConfig(config);
  return (
    <>
      <CreateCorner>
        <ModelPicker
          compact
          models={MODELS}
          value={current.model}
          defaultLabel={DEFAULT_MODEL}
          disabled={disabled}
          onChange={(model) => onChange({ ...current, model })}
        />
      </CreateCorner>
      <AgentInstructions
        value={current.instructions}
        disabled={disabled}
        onChange={(instructions) => onChange({ ...current, instructions })}
      />
    </>
  );
}

export function createTabs({
  setup,
  runtime,
}: Readonly<{ setup: ClaudeSetup; runtime: ClaudeRuntime }>) {
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

  /** Claude on this computer, and this agent's conversations. */
  function ClaudeTab({ agent, conversation }: AgentViewProps<Config>) {
    const state = useSyncExternalStore(setup.subscribe, setup.snapshot);
    const sessions = useSyncExternalStore(
      (listener) => runtime.subscribe(listener),
      () => runtime.sessions(agent.pubkey),
    );
    // Read on each render: bindings change as turns start, which also
    // changes the session list this tab subscribes to.
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
    const [code, setCode] = useState("");
    useEffect(() => {
      void setup.check();
    }, []);
    const status = state.status;
    const line =
      !status || state.checking
        ? "Checking Claude…"
        : status.state === "missing"
          ? "Claude is not installed."
          : status.state === "signed-out"
            ? `Claude ${status.version} needs you to sign in.`
            : status.state === "ready"
              ? `Claude ${status.version} is ready${status.account ? ` (${status.account})` : ""}.`
              : status.message;
    // One button per slot, so focus stays put as Install becomes Sign in and
    // Cancel becomes Check again.
    const action =
      status?.state === "missing"
        ? ({ step: "install", label: "Install Claude" } as const)
        : status?.state === "signed-out"
          ? ({ step: "login", label: "Sign in" } as const)
          : undefined;
    return (
      <div className="grid gap-4">
        <section className="grid gap-2">
          <p role="status" className="m-0">
            {line}
          </p>
          <div className="flex flex-wrap gap-2">
            {action && (
              <Button
                variant="prominent"
                loading={state.running === action.step}
                disabled={!!state.running && state.running !== action.step}
                onClick={() => void setup.run(action.step)}
              >
                {action.label}
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={!state.running && state.checking}
              focusableWhenDisabled
              onClick={() =>
                void (state.running ? setup.cancel() : setup.check())
              }
            >
              {state.running ? "Cancel" : "Check again"}
            </Button>
          </div>
          {status?.state === "missing" && (
            <p className="m-0 text-body-sm text-subtle">
              Runs the official installer,{" "}
              <code>curl -fsSL https://claude.ai/install.sh | bash</code>, which
              puts <code>claude</code> in <code>~/.local/bin</code>.
            </p>
          )}
          {state.output && (
            <pre
              role="log"
              aria-label="Setup output"
              className="m-0 max-h-60 overflow-auto whitespace-pre-wrap text-caption"
            >
              {state.output}
            </pre>
          )}
          {state.running === "login" && (
            <form
              className="flex items-end gap-2"
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
                <Input value={code} onValueChange={setCode} />
              </Field>
              <Button type="submit" disabled={!code.trim()}>
                Send
              </Button>
            </form>
          )}
        </section>
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
        <section>
          <InlineHeader title="Recent conversations" />
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
                  <Button variant="ghost" onClick={() => show(item)}>
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
  function SettingsTab({ agent, save }: AgentViewProps<Config>) {
    const saved = readConfig(agent.config);
    const [draft, setDraft] = useState(saved);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const changed = JSON.stringify(draft) !== JSON.stringify(saved);
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
    return (
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <ModelPicker
          models={MODELS}
          value={draft.model}
          defaultLabel={DEFAULT_MODEL}
          onChange={(model) => setDraft({ ...draft, model })}
        />
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
      </form>
    );
  }

  return { ClaudeTab, SettingsTab };
}
