import { useId, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Input } from "../../shared/design-system/ui/Input";
import styles from "./CreateSidebarSection.module.css";

/** Mounted after the launching menu closes, so focus has one modal owner. */
export function CreateSidebarSection({
  channelName,
  create,
  close,
  writable,
  refreshing,
  retry,
}: {
  channelName: string;
  /** True only after the session accepts the optimistic move. */
  create: (section: { id: string; name: string }) => boolean;
  close: () => void;
  writable: boolean;
  refreshing: boolean;
  retry: () => Promise<void>;
}) {
  const formId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const submitted = useRef(false);
  const sectionId = useRef<string | undefined>(undefined);
  const [blocked, setBlocked] = useState(false);
  return (
    <Dialog
      dismissOnOutsideClick
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Create new section"
      description={
        <span className={styles.description}>
          Move <span title={channelName}>{channelName}</span> into a new
          section.
        </span>
      }
      initialFocus={input}
      finalFocus={false}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            form={formId}
            type="submit"
            variant="prominent"
            disabled={!name.trim()}
          >
            Create and move
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          if (submitted.current || !name.trim()) return;
          sectionId.current ??= crypto.randomUUID();
          const accepted = create({ id: sectionId.current, name: name.trim() });
          submitted.current = accepted;
          setBlocked(!accepted);
        }}
      >
        <Input
          ref={input}
          aria-label="Section name"
          placeholder="Section name"
          required
          maxLength={256}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </form>
      {blocked && !writable && (
        <div role="alert">
          <p>
            Saved preferences are unavailable. Retry preferences to keep
            creating this section.
          </p>
          <Button disabled={refreshing} onClick={() => void retry()}>
            Retry preferences
          </Button>
        </div>
      )}
    </Dialog>
  );
}
