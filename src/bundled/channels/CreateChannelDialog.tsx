import type { Groups, Group } from "../../features/channel-templates/model";
import type { ChannelCreationInput } from "../../features/channel-templates/setup";
import type { RelaySession } from "../../features/relay/session";
import type { Agents } from "../../features/agents/service";
import {
  templateAgents,
  useChannelTemplates,
} from "../../features/channel-templates/local";
import { Select } from "../../shared/design-system/ui/Select";
import { useAgentsSnapshot } from "../../features/agents/react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import {
  ChannelPrivacyConfirmation,
  skipPrivacyConfirmation,
  rememberPrivacyConfirmation,
} from "./ChannelPrivacyConfirmation";
import { ChannelDurationField } from "./ChannelDurationField";
import { ChannelTextField } from "./ChannelTextField";
import { SidebarGroupIcon } from "./SidebarGroupIcon";
import {
  canonicalDetailsName,
  detailsDraftErrors,
} from "../../features/relay/channel-details-protocol";
import { Switch } from "../../shared/design-system/ui/Switch";
import { DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS } from "../../features/relay/work-sessions";
import styles from "./CreateChannelDialog.module.css";

export type CreateChannelInput = ChannelCreationInput;

type Props = {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreate(input: CreateChannelInput): Promise<void>;
  pending?: CreateChannelInput | undefined;
  finalFocus?: RefObject<HTMLElement | null> | undefined;
  session: RelaySession;
  /** Supplies the agents and teams a template adds. */
  agents?: Agents | undefined;
  groups: Groups | undefined;
  destinations?: readonly (Pick<Group, "id" | "name"> & { icon?: string })[];
  groupSource?: "legacy";
  initialGroup: string;
  groupsReady: boolean;
};
export function CreateChannelDialog(props: Props) {
  // Each opening owns its callbacks. Closing/reopening cannot revive an old editor.
  return props.open ? <OpenCreateChannelDialog {...props} /> : null;
}
function OpenCreateChannelDialog({
  open,
  onOpenChange,
  onCreate,
  pending,
  finalFocus,
  session,
  agents,
  groups,
  destinations = groups?.groups ?? [],
  groupSource,
  initialGroup,
  groupsReady,
}: Props) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const previousDiscard = useRef(confirmDiscard);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (confirmDiscard !== previousDiscard.current)
      (confirmDiscard ? keepEditing.current : input.current)?.focus();
    previousDiscard.current = confirmDiscard;
  }, [confirmDiscard]);
  const privateControlId = useId();
  const privateSwitch = useRef<HTMLSpanElement>(null);
  const privacyCancel = useRef<HTMLButtonElement>(null);
  const [privacyChoice, setPrivacyChoice] = useState<"private" | "public">();
  const [skipWarning, setSkipWarning] = useState(false);
  const previousPrivacyChoice = useRef(privacyChoice);
  useLayoutEffect(() => {
    if (privacyChoice !== previousPrivacyChoice.current)
      (privacyChoice ? privacyCancel.current : privateSwitch.current)?.focus();
    previousPrivacyChoice.current = privacyChoice;
  }, [privacyChoice]);
  const mounted = useRef(true);
  const previousOpen = useRef(false);
  const previousPending = useRef(pending);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [lifetime, setLifetime] = useState<"ongoing" | "temporary">("ongoing");
  const [temporaryTtl, setTemporaryTtl] = useState(
    DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS,
  );
  const [privateChannel, setPrivateChannel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [groupId, setGroupId] = useState("");
  const templates = useChannelTemplates();
  const agentsSnapshot = useAgentsSnapshot(agents);
  const [chosenTemplate, setTemplateId] = useState("");
  // A template deleted meanwhile, here or in another window, is no choice.
  const template = templates.find((item) => item.id === chosenTemplate);
  const templateId = template?.id ?? "";
  // The template's agents and team members that are the owner's agents here.
  const agentNames = new Map(
    (agentsSnapshot?.agents ?? []).map((agent) => [agent.pubkey, agent.name]),
  );
  const templateSetup = template && {
    agents: templateAgents(
      template,
      agentsSnapshot?.teams ?? [],
      new Set(agentNames.keys()),
    ),
    canvas: template.canvas,
  };
  const templateNote =
    templateSetup &&
    ([
      templateSetup.agents.length
        ? `Adds ${templateSetup.agents.map((key) => agentNames.get(key)).join(", ")}`
        : "",
      templateSetup.canvas.trim() ? "Starts the Canvas" : "",
    ]
      .filter(Boolean)
      .join(" · ") ||
      "None of its agents are in this community, and it has no Canvas.");
  const destination = destinations.find((g) => g.id === groupId);
  const summary = pending?.setup;
  const editing = useRef(false);
  editing.current = !pending && !busy && !privacyChoice && !confirmDiscard;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const opening = open && !previousOpen.current;
    const restoring =
      open && pending !== undefined && previousPending.current === undefined;
    previousOpen.current = open;
    previousPending.current = pending;
    if (!opening && !restoring) return;
    setName(pending?.name ?? "");
    setDescription(pending?.description ?? "");
    setLifetime(pending?.ttlSeconds === undefined ? "ongoing" : "temporary");
    setTemporaryTtl(
      pending?.ttlSeconds ?? DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS,
    );
    setPrivateChannel(pending?.visibility === "private");
    setPrivacyChoice(undefined);
    setConfirmDiscard(false);
    setError("");
    setGroupId(pending ? (pending.setup?.groupId ?? "") : initialGroup);
    setTemplateId("");
  }, [open, pending, initialGroup]);

  const normalizedName = canonicalDetailsName(name);
  const errors = detailsDraftErrors({
    name: normalizedName,
    description,
    visibility: privateChannel ? "private" : "public",
  });
  // Recovery must retain the original frozen request, not reinterpret its fields.
  const invalid = !pending && Object.values(errors).some(Boolean);

  const dirty =
    !pending &&
    (name !== "" ||
      description !== "" ||
      privateChannel ||
      lifetime !== "ongoing" ||
      templateId !== "");
  const requestClose = () => {
    if (busy) return;
    if (privacyChoice) setPrivacyChoice(undefined);
    else if (confirmDiscard) setConfirmDiscard(false);
    else if (dirty) setConfirmDiscard(true);
    else onOpenChange(false);
  };

  const submit = async () => {
    if (invalid || busy || privacyChoice || confirmDiscard) return;
    editing.current = false;
    setBusy(true);
    setError("");
    try {
      if (
        !pending &&
        groupId &&
        (!groupsReady || !destinations.some((g) => g.id === groupId))
      )
        throw new Error(
          groupsReady
            ? "This group is no longer available. Close this dialog and create from another sidebar group or Channels."
            : "Wait for saved sidebar groups to load, then try again.",
        );
      await onCreate(
        pending ?? {
          name: normalizedName,
          visibility: privateChannel ? "private" : "open",
          ...(lifetime === "temporary" ? { ttlSeconds: temporaryTtl } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(groupId || templateSetup?.agents.length || templateSetup?.canvas
            ? {
                setup: {
                  agents: templateSetup?.agents ?? [],
                  canvas: templateSetup?.canvas ?? "",
                  groupId,
                  templateId,
                  ...(groupId && groupSource ? { groupSource } : {}),
                },
              }
            : {}),
        },
      );
      if (mounted.current) onOpenChange(false);
    } catch (reason) {
      if (mounted.current)
        setError(
          reason instanceof Error
            ? reason.message
            : "The channel could not be created.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const recoverySummary = summary && (
    <section aria-label="Channel setup summary">
      <p>
        {summary.agents.length
          ? `${summary.agents.length} selected agent${summary.agents.length === 1 ? "" : "s"}.`
          : "Only you."}
        {summary.groupId &&
          ` Destination: ${destinations.find((g) => g.id === summary.groupId)?.name ?? "saved group"}.`}
      </p>
    </section>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
      dismissOnOutsideClick
      step={
        confirmDiscard
          ? { key: "discard", scale: 0.95 }
          : privacyChoice
            ? { key: "privacy", scale: 0.95 }
            : { key: "details", scale: 1.05 }
      }
      headerGap="compact"
      footerGap={privacyChoice ? "compact" : "default"}
      preventClose={busy}
      title={
        confirmDiscard ? (
          "Discard changes?"
        ) : privacyChoice ? (
          privacyChoice === "private" ? (
            "Make channel private?"
          ) : (
            "Make channel public?"
          )
        ) : (
          <span className={styles.title}>
            Create a channel
            {groupId && (
              <>
                {" in "}
                {destination?.icon && (
                  <>
                    <SidebarGroupIcon
                      icon={destination.icon}
                      session={session}
                    />{" "}
                  </>
                )}
                {destination?.name ?? "saved group"}
              </>
            )}
          </span>
        )
      }
      description={
        confirmDiscard ? "Your channel draft has unsaved changes." : undefined
      }
      closeLabel={
        confirmDiscard || privacyChoice
          ? "Back to channel creation"
          : "Close channel creation"
      }
      initialFocus={input}
      finalFocus={finalFocus}
      actions={
        confirmDiscard ? (
          <>
            <Button ref={keepEditing} onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!busy && !pending) onOpenChange(false);
              }}
            >
              Discard changes
            </Button>
          </>
        ) : privacyChoice ? (
          <>
            <Button
              ref={privacyCancel}
              onClick={() => setPrivacyChoice(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="prominent"
              disabled={busy || !!pending}
              onClick={() => {
                if (busy || pending) return;
                if (skipWarning) rememberPrivacyConfirmation(session.scope);
                setPrivateChannel(privacyChoice === "private");
                setPrivacyChoice(undefined);
                setError("");
              }}
            >
              Continue
            </Button>
          </>
        ) : (
          <>
            <span className={styles.privateAction}>
              <Switch
                id={privateControlId}
                ref={privateSwitch}
                aria-label="Private"
                checked={privateChannel}
                disabled={!!pending}
                readOnly={busy}
                aria-disabled={busy || !!pending || undefined}
                onCheckedChange={(checked) => {
                  if (!editing.current) return;
                  const choice = checked ? "private" : "public";
                  if (skipPrivacyConfirmation(session.scope)) {
                    setPrivateChannel(checked);
                    setError("");
                  } else {
                    setSkipWarning(false);
                    setPrivacyChoice(choice);
                  }
                }}
              />
              <label className="text-label-sm" htmlFor={privateControlId}>
                Private
              </label>
            </span>
            <Button
              variant="prominent"
              type="submit"
              form="create-channel-form"
              loading={busy}
              disabled={invalid}
            >
              {pending ? "Retry channel" : "Create channel"}
            </Button>
          </>
        )
      }
    >
      {confirmDiscard ? null : privacyChoice ? (
        <ChannelPrivacyConfirmation
          visibility={privacyChoice}
          checked={skipWarning}
          onCheckedChange={setSkipWarning}
        />
      ) : (
        <form
          id="create-channel-form"
          className={styles.form}
          inert={busy}
          aria-busy={busy || undefined}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {pending && (
            <p role="status">
              This attempt may already have created a channel. Retry checks it
              first and, if unconfirmed, resends only the same creation request.
              It will not create another channel or continue its setup.
            </p>
          )}
          <fieldset
            disabled={!!pending}
            inert={!!pending}
            style={{ display: "contents", border: 0, padding: 0 }}
          >
            <ChannelTextField
              field="name"
              creation
              inputRef={input}
              value={name}
              error={name ? errors.name : undefined}
              onChange={(value) => {
                setName(value);
                setError("");
              }}
            />
            <ChannelTextField
              field="description"
              value={description}
              error={errors.description}
              onChange={(value) => {
                setDescription(value);
                setError("");
              }}
            />
            {!pending && templates.length > 0 && (
              <Select
                label="Template"
                variant="field"
                value={templateId}
                description={templateNote}
                groups={[
                  {
                    label: "",
                    options: [
                      { value: "", label: "None" },
                      ...templates.map((item) => ({
                        value: item.id,
                        label: item.name,
                      })),
                    ],
                  },
                ]}
                onValueChange={(value) => {
                  if (!editing.current) return;
                  setTemplateId(value);
                  setError("");
                }}
              />
            )}
            <ChannelDurationField
              temporary={lifetime === "temporary"}
              ttlSeconds={temporaryTtl}
              disabled={!!pending}
              onChange={(ttlSeconds) => {
                if (!editing.current) return;
                setLifetime(ttlSeconds === undefined ? "ongoing" : "temporary");
                if (ttlSeconds !== undefined) setTemporaryTtl(ttlSeconds);
                setError("");
              }}
            />
          </fieldset>
          {recoverySummary}
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
        </form>
      )}
    </Dialog>
  );
}
