import { useState, useSyncExternalStore } from "react";
import type { Agents, AgentsSnapshot } from "../../features/agents/service";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";

const STATUS: Record<AgentsSnapshot["classifierKey"], string> = {
  checking: "Checking for a saved TypeSafe key…",
  saved: "A TypeSafe key is saved. Watch classifiers run.",
  missing: "No TypeSafe key is saved. Watch classifiers do not run.",
  unreadable:
    "The saved key could not be read from secure storage. Unlock it, or replace or remove the key. Until then, watched events pass unchecked.",
  refused:
    "TypeSafe refused the saved key. Replace it. Until then, watched events pass unchecked.",
};

/** Sets or removes the TypeSafe key that lets watch classifiers run. The key
 * goes straight to native storage and is never shown again. */
export function ClassifierSettings({
  agents,
  active,
}: {
  agents: Pick<
    Agents,
    "snapshot" | "subscribe" | "setClassifierKey" | "clearClassifierKey"
  >;
  active(): boolean;
}) {
  const state = useSyncExternalStore(
    agents.subscribe,
    agents.snapshot,
    agents.snapshot,
  );
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const desktop = state.status !== "unavailable";
  const keyState = state.classifierKey;
  // A key may be saved in each state but these two.
  const saved = keyState !== "missing" && keyState !== "checking";
  const run = async (action: () => Promise<void>) => {
    if (!active() || busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      setKey("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-buzz-ui="" className="flex flex-col items-start gap-4">
      <div>
        <h2 className="text-heading text-primary">Jev classifier</h2>
        <p className="mt-2 text-body-sm text-secondary">
          An agent's watch can ask Jev whether an event is relevant before the
          agent wakes. Without a key, those watches still wake the agent, and
          the agent is told the classifier did not run. The key is kept in this
          device's secure storage, where agents cannot read it.
        </p>
        <p className="mt-2 text-body-sm text-secondary">
          For each event a classified watch matches, Buzz sends TypeSafe
          (api.typesafe.ai) the whole event, with its text and tags; the
          author's display name and whether they are the agent's owner; the
          channel name; the first 600 characters of the message it replies to;
          and who it mentions. This includes events in private channels.
        </p>
      </div>
      {!desktop ? (
        <p role="status" className="text-body-sm text-secondary">
          Open the Buzz desktop app to set a classifier key.
        </p>
      ) : (
        <>
          <p role="status" className="text-body-sm text-secondary">
            {STATUS[keyState]}
          </p>
          <form
            className="flex w-full max-w-md flex-col items-start gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const value = key.trim();
              if (value) void run(() => agents.setClassifierKey(value));
            }}
          >
            <Field label="TypeSafe API key">
              <Input
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                disabled={busy}
                value={key}
                placeholder={saved ? "Saved key unchanged" : "Paste a key"}
                onChange={(event) => setKey(event.target.value)}
              />
            </Field>
            <div className="flex gap-2">
              <Button
                type="submit"
                variant="prominent"
                disabled={busy || !key.trim()}
              >
                {saved ? "Replace key" : "Save key"}
              </Button>
              {saved && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run(() => agents.clearClassifierKey())}
                >
                  Remove key
                </Button>
              )}
            </div>
          </form>
          {error && (
            <p role="alert" className="text-body-sm text-danger">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}
