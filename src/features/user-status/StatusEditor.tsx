import {
  statusDurations,
  statusDeadline,
  statusDuration,
} from "./status-duration";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { EmojiPicker } from "../../bundled/emoji/EmojiPicker";
import { SmileyIcon } from "../../shared/design-system/icons";
import { Input } from "../../shared/design-system/ui/Input";
import { FieldButton } from "../../shared/design-system/ui/FieldButton";
import { StatusExpiration } from "./StatusExpiration";
import { InputGroup } from "../../shared/design-system/ui/InputGroup";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
} from "../../shared/design-system/ui/Menu";
import type { RelaySession } from "../relay/session";
import { STATUS_TEXT_LIMIT, type UserStatus } from "../relay/user-status";
import { StatusEmoji } from "./StatusEmoji";
import styles from "./Status.module.css";

const choices = [
  ["🗣️", "In a meeting"],
  ["🚌", "Commuting"],
  ["🤒", "Out sick"],
  ["🏖️", "Vacationing"],
  ["🏠", "Working remotely"],
] as const;
export function StatusEditor({
  session,
  scope,
  current,
  close,
  finalFocus,
}: {
  session: RelaySession;
  scope: string;
  current: UserStatus | undefined;
  close(): void;
  finalFocus: RefObject<HTMLButtonElement | null>;
}) {
  const [text, setText] = useState(current?.text ?? "");
  const [emoji, setEmoji] = useState(current?.emoji ?? "");
  const [duration, setDuration] = useState(
    current ? statusDuration(current.expiresAt, current.updatedAt) : "today",
  );
  const [durationChanged, setDurationChanged] = useState(false);
  const [date, setDate] = useState(
    new Date(
      (current?.expiresAt ?? statusDeadline("today", Date.now() / 1000)) * 1000,
    ),
  );
  const effectiveEmoji = emoji || (text.trim() ? "💬" : "");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const message = useRef<HTMLInputElement>(null);
  const emojiTrigger = useRef<HTMLButtonElement>(null);
  const pickerId = `status-emoji-${useId()}`;
  const formId = useId();
  const working = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const durationLabel =
    duration === "custom"
      ? "Custom date and time"
      : statusDurations.find(([value]) => value === duration)?.[1];
  async function submit(clear = false) {
    if (working.current) return;
    const expiresAt =
      clear || duration === "never"
        ? undefined
        : current &&
            !durationChanged &&
            (current.expiresAt === undefined ||
              current.expiresAt > Date.now() / 1000)
          ? current?.expiresAt
          : duration === "custom"
            ? Math.floor(date.getTime() / 1000)
            : statusDeadline(duration, Math.floor(Date.now() / 1000));
    if (
      !clear &&
      expiresAt !== undefined &&
      (!Number.isFinite(expiresAt) || expiresAt <= Date.now() / 1000)
    ) {
      setError("Choose a date and time in the future.");
      return;
    }
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await session.statuses.save({
        text: clear ? "" : text,
        emoji: clear ? "" : effectiveEmoji,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      if (mounted.current) close();
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Dialog
      open
      title="Set a status"
      closeLabel="Close status editor"
      onOpenChange={(open) => {
        if (!open) close();
      }}
      preventClose={busy}
      initialFocus={message}
      finalFocus={finalFocus}
      actions={
        <div className={styles.footer}>
          {current ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void submit(true)}
            >
              <span className="text-danger">Clear status</span>
            </Button>
          ) : (
            <span />
          )}
          <Button
            type="submit"
            form={formId}
            variant="prominent"
            loading={busy}
            disabled={busy || (!text.trim() && !emoji)}
          >
            Save status
          </Button>
        </div>
      }
    >
      <form
        id={formId}
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim() || emoji) void submit();
        }}
      >
        <fieldset className={styles.fields} disabled={busy}>
          <InputGroup
            leading={
              <IconButton
                ref={emojiTrigger}
                size="sm"
                aria-label="Choose a status emoji"
                aria-expanded={pickerOpen}
                aria-haspopup="dialog"
                aria-controls={pickerOpen ? pickerId : undefined}
                onClick={() => {
                  void session.emoji.ensure();
                  setPickerOpen(true);
                }}
                icon={
                  effectiveEmoji ? (
                    <StatusEmoji value={effectiveEmoji} session={session} />
                  ) : (
                    <SmileyIcon size={22} />
                  )
                }
              />
            }
          >
            <Input
              ref={message}
              aria-label="Status message"
              autoComplete="off"
              maxLength={STATUS_TEXT_LIMIT}
              placeholder="What's your status?"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </InputGroup>
          <div className={styles.section}>
            <span className="text-label-sm text-subtle">Duration</span>
            <MenuRoot>
              <MenuTrigger
                disabled={busy}
                aria-label={`Duration: ${durationLabel}`}
                render={<FieldButton />}
              >
                {durationLabel}
              </MenuTrigger>
              <MenuPopup align="end" data-status-menu>
                <MenuRadioGroup
                  value={duration}
                  onValueChange={(value) => {
                    setDuration(value);
                    setDurationChanged(true);
                  }}
                  aria-label="Duration"
                >
                  {statusDurations
                    .filter(
                      ([value]) =>
                        value !== "never" ||
                        (current && current.expiresAt === undefined),
                    )
                    .map(([value, label]) => (
                      <MenuRadioItem key={value} value={value} closeOnClick>
                        {label}
                      </MenuRadioItem>
                    ))}
                </MenuRadioGroup>
              </MenuPopup>
            </MenuRoot>
            {duration === "custom" && (
              <StatusExpiration
                value={date}
                disabled={busy}
                onChange={(next) => {
                  setDate(next);
                  setDurationChanged(true);
                  setError("");
                }}
              />
            )}
          </div>
          {!current && (
            <div className={styles.section}>
              <span className="text-label-sm text-subtle">Quick statuses</span>
              <div className={styles.choices}>
                {choices.map(([icon, label]) => (
                  <NavigationItem
                    variant="option"
                    key={label}
                    type="button"
                    onClick={() => {
                      setEmoji(icon);
                      setText(label);
                      message.current?.focus();
                    }}
                    icon={
                      <span aria-hidden="true" className="text-body-lg">
                        {icon}
                      </span>
                    }
                    label={label}
                  />
                ))}
              </div>
            </div>
          )}
        </fieldset>
        {pickerOpen && (
          <EmojiPicker
            session={session}
            scope={scope}
            disabled={busy}
            reaction
            insert={setEmoji}
            externalTrigger={{
              ref: emojiTrigger,
              id: pickerId,
              close: () => setPickerOpen(false),
              finalFocus: () => emojiTrigger.current ?? false,
            }}
          />
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
