import { useEffect, useRef, useState } from "react";
import type { AgentViewProps } from "../../../features/agents/service";
import { Button } from "../../../shared/design-system/ui/Button";
import { Field } from "../../../shared/design-system/ui/Field";
import { Textarea } from "../../../shared/design-system/ui/Textarea";
import {
  MAX_INSTRUCTIONS_LENGTH,
  validInstructions,
  type AgentClient,
  type RemoteAgent,
} from "../agents/client";
import type { OAuthSession } from "../oauth/session";

const message = (reason: unknown) =>
  reason instanceof Error
    ? reason.message
    : "Could not update Builderlab instructions.";

/** Hosted settings belong to Builderlab, rather than Agents' local config. */
export function createInstructionsTab(
  client: AgentClient,
  session: OAuthSession,
) {
  function Editor({ pubkey, retry }: { pubkey: string; retry(): void }) {
    const [loaded, setLoaded] = useState<{
      agent: RemoteAgent;
      subject: string;
    }>();
    const [draft, setDraft] = useState("");
    const [busy, setBusy] = useState(true);
    const [error, setError] = useState("");
    const controller = useRef<AbortController | null>(null);
    useEffect(() => {
      const current = new AbortController();
      controller.current = current;
      const load = async () => {
        await session.ensureSignedIn(current.signal);
        const credential = session.credential();
        const remote = (await client.list(current.signal)).find(
          (row) => row.pubkey === pubkey,
        );
        current.signal.throwIfAborted();
        if (session.credential() !== credential)
          throw new DOMException("Builderlab session changed.", "AbortError");
        if (!remote)
          throw new Error("Agent not found in this Builderlab account.");
        if (remote.status !== "Active")
          throw new Error(
            "Only Active agents can have their instructions edited.",
          );
        setLoaded({ agent: remote, subject: credential.account.subject });
        setDraft(remote.instructions ?? "");
      };
      void load()
        .catch((reason: unknown) => {
          if (!current.signal.aborted) setError(message(reason));
        })
        .finally(() => {
          if (!current.signal.aborted) setBusy(false);
        });
      return () => current.abort();
    }, [pubkey]);
    const submit = async () => {
      const signal = controller.current?.signal;
      if (!loaded || !signal || busy || !validInstructions(draft)) return;
      setBusy(true);
      setError("");
      try {
        await session.ensureSignedIn(signal);
        if (session.credential().account.subject !== loaded.subject)
          throw new Error(
            "Sign in to the Builderlab account that loaded these instructions.",
          );
        await client.updateInstructions(loaded.agent, draft, signal);
        signal.throwIfAborted();
        setLoaded({
          ...loaded,
          agent: { ...loaded.agent, instructions: draft },
        });
      } catch (reason) {
        if (!signal.aborted) setError(message(reason));
      } finally {
        if (!signal.aborted) setBusy(false);
      }
    };
    return (
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {loaded ? (
          <>
            <Field
              label="Instructions"
              description="Saved in Builderlab. Leave empty to clear instructions."
              error={
                !validInstructions(draft)
                  ? "Use text or leave this empty."
                  : undefined
              }
            >
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={busy}
                rows={8}
                maxLength={MAX_INSTRUCTIONS_LENGTH}
              />
            </Field>
            <div>
              <Button
                type="submit"
                variant="prominent"
                loading={busy}
                disabled={
                  !validInstructions(draft) ||
                  draft === (loaded.agent.instructions ?? "")
                }
                focusableWhenDisabled
              >
                Save instructions
              </Button>
            </div>
          </>
        ) : busy ? (
          <p role="status" className="m-0 text-body-sm text-secondary">
            Loading instructions…
          </p>
        ) : (
          <div>
            <Button onClick={retry}>Retry</Button>
          </div>
        )}
        {error && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        )}
      </form>
    );
  }
  return function Instructions({ agent }: AgentViewProps) {
    const [revision, setRevision] = useState(0);
    return (
      <Editor
        key={`${agent.pubkey}/${revision}`}
        pubkey={agent.pubkey}
        retry={() => setRevision((value) => value + 1)}
      />
    );
  };
}
