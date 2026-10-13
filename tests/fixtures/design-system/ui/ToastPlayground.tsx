import { useRef, useState } from "react";
import { Button } from "../../../../src/shared/design-system/ui/Button";
import { Field } from "../../../../src/shared/design-system/ui/Field";
import { Input } from "../../../../src/shared/design-system/ui/Input";
import { Select } from "../../../../src/shared/design-system/ui/Select";
import { Switch } from "../../../../src/shared/design-system/ui/Switch";
import { Textarea } from "../../../../src/shared/design-system/ui/Textarea";
import { ToastNotice } from "../../../../src/shared/design-system/ui/Toast";

type Sample = {
  label: string;
  title: string;
  description: string;
  tone: "success" | "info" | "warning" | "error";
  action: string;
  dismissible: boolean;
};
const samples: [Sample, ...Sample[]] = [
  {
    label: "Copied",
    title: "Community URL copied.",
    description: "",
    tone: "success",
    action: "",
    dismissible: true,
  },
  {
    label: "Undo",
    title: "Message deleted",
    description: "",
    tone: "info",
    action: "Undo",
    dismissible: true,
  },
  {
    label: "Information",
    title: "Update available",
    description: "Restart Buzz when you’re ready to use the latest version.",
    tone: "info",
    action: "Restart",
    dismissible: true,
  },
  {
    label: "Warning",
    title: "You’re working offline",
    description: "Your changes will sync when the connection returns.",
    tone: "warning",
    action: "",
    dismissible: true,
  },
  {
    label: "Error",
    title: "Couldn’t upload the file",
    description: "Check your connection and try again.",
    tone: "error",
    action: "Try again",
    dismissible: true,
  },
  {
    label: "Persistent recovery",
    title: "Changes weren’t saved",
    description:
      "Your choices still apply for this session. Retry to save them on this device.",
    tone: "error",
    action: "Retry saving",
    dismissible: false,
  },
  {
    label: "Wrapped title",
    title:
      "Your changes to the community notification preferences have been saved",
    description: "You can update these preferences again in Settings.",
    tone: "success",
    action: "",
    dismissible: true,
  },
  {
    label: "Long filename",
    title: "Couldn’t upload attachment",
    description:
      "community-notification-preferences-and-channel-settings-backup-2026-10-09.json",
    tone: "error",
    action: "Choose another file",
    dismissible: true,
  },
];
const tones = ["success", "info", "warning", "error"] as const;

/** Local sample data only; all rendered notices use the production Toast owner. */
export function ToastPlayground() {
  const [draft, setDraft] = useState<Sample>(samples[0]);
  const [keepVisible, setKeepVisible] = useState(true);
  const [preview, setPreview] = useState<number>();
  const [stack, setStack] = useState<(Sample & { id: number })[]>([]);
  const [feedback, setFeedback] = useState("");
  const nextId = useRef(0);
  const show = () => setPreview(++nextId.current);
  const clear = () => {
    setPreview(undefined);
    setStack([]);
    setFeedback("");
  };
  const activate = (label: string, close: () => void) => {
    close();
    setFeedback(
      `“${label}” activated. This is a local demo; no data was changed.`,
    );
  };
  return (
    <section className="mt-8 flex flex-col gap-4" aria-label="Toast playground">
      <div>
        <h2 className="text-heading">Toast playground</h2>
        <p className="text-body-sm text-subtle">
          Choose a sample, then edit it live. Use the theme toggle above and
          resize the window to compare layouts. F6 focuses the toast stack.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {samples.map((sample) => (
          <Button
            key={sample.label}
            size="sm"
            variant="outline"
            onClick={() => {
              setDraft(sample);
              setStack([]);
              setFeedback("");
              show();
            }}
          >
            {sample.label}
          </Button>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Toast title">
          <Input
            value={draft.title}
            onValueChange={(title) => setDraft({ ...draft, title })}
          />
        </Field>
        <Select
          label="Tone"
          variant="field"
          value={draft.tone}
          groups={[
            {
              label: "",
              options: tones.map((tone) => ({
                value: tone,
                label: tone.charAt(0).toUpperCase() + tone.slice(1),
              })),
            },
          ]}
          onValueChange={(tone) => {
            if (tones.some((value) => value === tone))
              setDraft({ ...draft, tone: tone as Sample["tone"] });
          }}
        />
        <Field
          label="Description"
          description="Leave empty for a title-only toast."
        >
          <Textarea
            rows={3}
            value={draft.description}
            onChange={(event) =>
              setDraft({ ...draft, description: event.target.value })
            }
          />
        </Field>
        <div className="flex flex-col gap-4">
          <Field
            label="Action label"
            description="Leave empty to hide the action."
          >
            <Input
              value={draft.action}
              onValueChange={(action) => setDraft({ ...draft, action })}
            />
          </Field>
          <Switch
            label="Show close button"
            checked={draft.dismissible}
            onCheckedChange={(dismissible) =>
              setDraft({ ...draft, dismissible })
            }
          />
          <Switch
            label="Keep visible while inspecting"
            checked={keepVisible}
            onCheckedChange={setKeepVisible}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={show} disabled={!draft.title.trim()}>
          Show toast
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setPreview(undefined);
            setStack(
              samples.map((sample) => ({ ...sample, id: ++nextId.current })),
            );
            setFeedback("");
          }}
        >
          Show all variations
        </Button>
        <Button size="sm" variant="ghost" onClick={clear}>
          Clear playground toasts
        </Button>
      </div>
      <p className="text-body-sm text-subtle">
        {keepVisible
          ? "Toasts stay until you dismiss, resolve, or clear them."
          : "Dismissible samples expire after 5 seconds. Persistent recovery stays until resolved."}
      </p>
      <p role="status" className="text-body-sm">
        {feedback}
      </p>
      {preview !== undefined && (
        <ToastNotice
          key={preview}
          title={draft.title}
          description={draft.description}
          tone={draft.tone}
          timeout={!keepVisible && draft.dismissible ? 5000 : 0}
          {...(draft.dismissible
            ? { onDismiss: () => setPreview(undefined) }
            : {})}
        >
          {draft.action && (
            <Button
              size="sm"
              onClick={() =>
                activate(draft.action, () => setPreview(undefined))
              }
            >
              {draft.action}
            </Button>
          )}
        </ToastNotice>
      )}
      {stack.map((sample) => {
        const close = () =>
          setStack((current) =>
            current.filter((item) => item.id !== sample.id),
          );
        return (
          <ToastNotice
            key={sample.id}
            title={sample.title}
            description={sample.description}
            tone={sample.tone}
            timeout={!keepVisible && sample.dismissible ? 5000 : 0}
            {...(sample.dismissible ? { onDismiss: close } : {})}
          >
            {sample.action && (
              <Button size="sm" onClick={() => activate(sample.action, close)}>
                {sample.action}
              </Button>
            )}
          </ToastNotice>
        );
      })}
    </section>
  );
}
