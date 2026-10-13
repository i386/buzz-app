// Owner actions on an agent that every surface showing it offers: the
// Agents Build view and the profile panel.
import { useState } from "react";
import { TrashIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import type { Agent, Agents } from "./service";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Delete, after a confirmation that says what it does. */
export function AgentDelete({
  agents,
  agent,
  onRemoved,
}: {
  agents: Agents;
  agent: Agent;
  onRemoved(): void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const remove = async () => {
    setRemoving(true);
    setError("");
    try {
      await agents.remove(agent.pubkey);
      setConfirming(false);
      onRemoved();
    } catch (reason) {
      setError(message(reason));
      setRemoving(false);
    }
  };
  return (
    <>
      <Button
        size="compact"
        variant="ghost"
        onClick={() => setConfirming(true)}
      >
        <TrashIcon size={14} aria-hidden="true" /> Delete agent
      </Button>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${agent.name}?`}
        description={
          agent.place === "hosted"
            ? "Its provider deletes it and its key, then it leaves every channel and is archived so it no longer appears in member lists or mention suggestions. It can't be undone."
            : "This deletes its key from this device. Then, whenever its community is open, it leaves every channel and is archived so it no longer appears in member lists or mention suggestions. It can't be undone."
        }
        preventClose={removing}
        actions={
          <>
            <Button onClick={() => setConfirming(false)} disabled={removing}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={removing}
              onClick={() => void remove()}
            >
              Delete
            </Button>
          </>
        }
      >
        {error ? (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        ) : null}
      </Dialog>
    </>
  );
}
