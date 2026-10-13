import { useEffect, useRef, useState } from "react";
import { PageSearch } from "../../../src/app/shell/PageSearch";
import { CommunityDialog } from "../../../src/features/communities/CommunityDialog";
import { ConfirmAction } from "../../../src/bundled/workflows/ConfirmAction";
import { WorkflowWebhookSecretDialog } from "../../../src/bundled/workflows/WorkflowWebhookSecretDialog";
import { getWorkflowActivationWarning } from "../../../src/bundled/workflows/workflowActivationWarning";
import { MediaAttachment } from "../../../src/features/messages/MediaAttachment";
import { MediaReviewViewer } from "../../../src/features/messages/MediaReviewViewer";
import { Button } from "../../../src/shared/design-system/ui/Button";
import { useKeyboardFocusVisibility } from "../../../src/shared/design-system/useKeyboardFocusVisibility";
import {
  attachment,
  communityFixture,
  mediaFixture,
  sampleImage,
} from "./data";
import { confirmations, type DialogId } from "./catalog";

const pages = ["Messages", "Agents", "Sessions", "Workflows", "Projects"].map(
  (title) => ({
    id: title.toLowerCase(),
    key: `buzz.${title.toLowerCase()}/${title.toLowerCase()}`,
    pluginId: `buzz.${title.toLowerCase()}`,
    revision: "preview",
    title,
    component: () => null,
  }),
);

function ReviewScene({ close }: { close(): void }) {
  const [fixture] = useState(mediaFixture);
  useEffect(() => () => fixture.owner.dispose(), [fixture]);
  return (
    <MediaReviewViewer
      attachment={attachment}
      session={fixture.owner.session}
      scope="dialog-gallery"
      channelId="studio"
      channelName="Design studio"
      messageId={fixture.root.id}
      initialTime={0}
      close={close}
    />
  );
}

export function Scene({ id }: { id: DialogId }) {
  useKeyboardFocusVisibility();
  const [communities] = useState(communityFixture);
  const [open, setOpen] = useState(true);
  const host = useRef<HTMLDivElement>(null);
  const params = new URLSearchParams(location.search);
  const variant = params.get("variant") ?? "default";
  const close = () => setOpen(false);
  useEffect(() => {
    if (!["search", "attachment"].includes(id)) return;
    host.current?.querySelector<HTMLButtonElement>("button")?.click();
  }, [id]);
  const confirmation =
    id in confirmations
      ? confirmations[id as keyof typeof confirmations]
      : undefined;
  const warning =
    id === "enable" && variant !== "default"
      ? getWorkflowActivationWarning(
          variant === "schedule"
            ? "trigger:\n  on: schedule"
            : "trigger:\n  on: message_posted",
        )
      : null;
  return (
    <div className="scene shell-background">
      <div className="scene-context" aria-hidden="true">
        <span>Buzz</span>
        <span>Design studio</span>
        <span>Messages · Agents · Workflows</span>
      </div>
      <div className="scene-content" ref={host}>
        {id === "search" && <PageSearch pages={pages} onSelect={() => {}} />}
        {id === "attachment" && (
          <MediaAttachment attachment={attachment} media={() => sampleImage} />
        )}
        {!["search", "attachment"].includes(id) && (
          <Button onClick={() => setOpen(true)}>Reopen dialog</Button>
        )}
      </div>
      {open && id === "join" && (
        <CommunityDialog communities={communities} mode="join" close={close} />
      )}
      {open && confirmation && (
        <ConfirmAction
          {...confirmation}
          {...(warning ?? {})}
          pending={variant === "pending"}
          error={
            variant === "error"
              ? "The request could not be confirmed. Your changes are still here."
              : null
          }
          onCancel={close}
          onConfirm={close}
        />
      )}
      {open && id === "review" && <ReviewScene close={close} />}
      {open && id === "webhook" && (
        <WorkflowWebhookSecretDialog
          workflowId="55555555-5555-4555-8555-555555555555"
          hookUrl={
            variant === "noaddress"
              ? undefined
              : "https://relay.example.test/hooks/55555555-5555-4555-8555-555555555555"
          }
          take={() => "0c2f7a1e-preview-4b9d-8e61-secret000000"}
          onContinue={close}
        />
      )}
    </div>
  );
}
