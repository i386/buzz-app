// The New agent dialog: one card with the avatar and name, which the app owns,
// and the chosen type's `Create` view for the rest, such as its model and
// instructions. Its type choice sits in the card's corner.
import { useId, useMemo, useRef, useState } from "react";
import {
  CreateCardContext,
  type CardEditing,
} from "../../features/agents/create-card";
import { randomAgentAvatar } from "../../features/agents/avatar-packs";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import {
  CaretDownIcon,
  ClaudeLogoIcon,
  CodexLogoIcon,
  RobotIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import {
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { AgentCreateHeader } from "./AgentCreateHeader";
import styles from "./AgentsPage.module.css";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The type's mark, recognized from its key or title. */
export function TypeIcon({ type }: { type: RegisteredAgentType | undefined }) {
  const name = `${type?.key ?? ""} ${type?.title ?? ""}`.toLowerCase();
  const Icon = name.includes("claude")
    ? ClaudeLogoIcon
    : name.includes("codex")
      ? CodexLogoIcon
      : RobotIcon;
  return <Icon size={16} aria-hidden="true" />;
}

const startingConfig = (type: RegisteredAgentType | undefined) => {
  try {
    return type?.defaults().config;
  } catch {
    return undefined;
  }
};

export function AgentCreateDialog({
  agents,
  types,
  community,
  onClose,
  onCreated,
}: {
  agents: Agents;
  types: readonly RegisteredAgentType[];
  community?: string | undefined;
  onClose(): void;
  onCreated(agent: Agent): void;
}) {
  const [open, setOpen] = useState(true);
  const [name, setName] = useState("");
  const [picture, setPicture] = useState(() => randomAgentAvatar().url);
  const [typeKey, setTypeKey] = useState(types[0]?.key ?? "");
  const type = types.find((item) => item.key === typeKey) ?? types[0];
  const [config, setConfig] = useState(() => startingConfig(type));
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [corner, setCorner] = useState<HTMLElement | null>(null);
  const [editing, setEditing] = useState<CardEditing | null>(null);
  const [avatarActive, setAvatarActive] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarAction, setAvatarAction] = useState<HTMLDivElement | null>(null);
  const avatarNavigation = useRef<{ back(): void }>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const form = useId();
  const card = useMemo(() => ({ corner, edit: setEditing }), [corner]);
  const Create = type?.Create;
  const close = () => setOpen(false);
  const choose = (key: string) => {
    if (key === type?.key) return;
    setTypeKey(key);
    setConfig(startingConfig(types.find((item) => item.key === key)));
    setDirty(true);
  };
  const create = async () => {
    if (!type || !name.trim() || pending) return;
    setPending(true);
    setError("");
    try {
      const agent = await agents.create({
        type: type.key,
        name: name.trim(),
        ...(picture ? { picture } : {}),
        ...(config !== undefined ? { config } : {}),
      });
      onCreated(agent);
    } catch (reason) {
      setError(message(reason));
      setPending(false);
    }
  };
  const back = editing
    ? editing.back
    : avatarActive
      ? () => avatarNavigation.current?.back()
      : undefined;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClose();
      }}
      title="Create agent"
      size="wide"
      initialFocus={nameField}
      bodyLayout="flex"
      // A started draft only closes from the close button.
      dismissOnOutsideClick={!dirty}
      onEscape={() => {
        if (back) {
          back();
          return true;
        }
        return dirty || pending;
      }}
      preventClose={pending}
      leadingActions={
        back && (
          <Button disabled={pending} onClick={back}>
            Back
          </Button>
        )
      }
      actions={
        <>
          <div ref={setAvatarAction} hidden={!avatarActive} />
          {!avatarActive && (
            <Button
              variant="primary"
              // The footer is outside the form; Enter in any field submits it.
              {...(editing
                ? { onClick: editing.done }
                : { type: "submit" as const, form })}
              loading={pending}
              disabled={
                !editing && (avatarBusy || !type || !name.trim() || pending)
              }
            >
              {editing ? "Done editing" : "Create agent"}
            </Button>
          )}
        </>
      }
    >
      <form
        id={form}
        className="flex flex-col gap-3"
        aria-label="New agent"
        onSubmit={(event) => {
          event.preventDefault();
          if (!editing && !avatarActive) void create();
        }}
      >
        <CreateCardContext.Provider value={card}>
          <AgentCreateHeader
            name={name}
            picture={picture}
            disabled={pending}
            community={community}
            onBusyChange={setAvatarBusy}
            onChange={(patch) => {
              if (patch.name !== undefined) setName(patch.name);
              if (patch.picture !== undefined) setPicture(patch.picture);
              setDirty(true);
              setError("");
            }}
            nameRef={nameField}
            cornerRef={setCorner}
            corner={
              types.length > 1 ? (
                <MenuRoot>
                  <MenuTrigger
                    render={
                      <Button
                        size="compact"
                        variant="quiet"
                        disabled={pending}
                        aria-label={`Agent type: ${type?.title ?? ""}`}
                      >
                        <TypeIcon type={type} />
                        {type?.title}
                        <CaretDownIcon size={14} aria-hidden="true" />
                      </Button>
                    }
                  />
                  <MenuPopup align="end">
                    <MenuRadioGroup
                      value={type?.key}
                      onValueChange={(value) => choose(String(value))}
                    >
                      {types.map((item) => (
                        <MenuRadioItem
                          key={item.key}
                          value={item.key}
                          closeOnClick
                        >
                          <span className="flex items-center gap-2">
                            <TypeIcon type={item} />
                            {item.remote
                              ? `${item.title} (hosted)`
                              : item.title}
                          </span>
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuPopup>
                </MenuRoot>
              ) : (
                <span className={styles.typeLabel}>
                  <TypeIcon type={type} />
                  {type?.title}
                </span>
              )
            }
            details={
              Create ? (
                <Create
                  key={type.key}
                  config={config}
                  disabled={pending}
                  onChange={(next) => {
                    setConfig(next);
                    setDirty(true);
                  }}
                />
              ) : (
                <p className="m-0 text-center text-body-sm text-secondary">
                  {type?.remote
                    ? "Its provider keeps its key and runs it, whether or not this app is open."
                    : "Set it up after it is made."}
                </p>
              )
            }
            editing={!!editing}
            avatarNavigationRef={avatarNavigation}
            avatarActionTarget={avatarAction}
            onAvatarActiveChange={setAvatarActive}
          />
        </CreateCardContext.Provider>
        {error && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
