import { createPortal } from "react-dom";
import { Popover } from "@base-ui/react/popover";
import { useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import {
  CloudUploadIcon,
  PencilSimpleIcon,
  PlusIcon,
  LinkIcon,
} from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./AvatarEditor.module.css";
import emojiStyles from "../../bundled/emoji/Emoji.module.css";
import { Field } from "../../shared/design-system/ui/Field";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import { InputGroup } from "../../shared/design-system/ui/InputGroup";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import {
  avatarPictureError,
  emojiAvatar,
  paintEmojiAvatar,
  uploadAvatar,
} from "./avatar-upload";
import { useAvatarPreview } from "./use-avatar-preview";
import { AvatarCustomColor } from "./AvatarCustomColor";
import type { EmojiSearchSelection } from "../../bundled/emoji/emoji-mart";

type Props = {
  triggerStyle?: "dotted-squircle";
  inlinePicker?: boolean;
  /** Offers only an uploaded image, not an emoji avatar. */
  imageOnly?: boolean;
  triggerLabel?: string;
  actionTarget?: HTMLElement | null | undefined;
  value: string;
  name: string;
  community?: string | undefined;
  shape?: "circle" | "squircle";
  size?: "compact" | "default";
  disabled?: boolean;
  onChange(value: string): void;
  onBusyChange?: ((busy: boolean) => void) | undefined;
};

type DraftPreview = {
  picture: string;
  emoji?: string;
  color?: string;
  pulse?: number;
};

const colors = [
  "#FFFFFF",
  "#FFF4CC",
  "#FFE75C",
  "#FFB84D",
  "#FF8652",
  "#F6534F",
  "#FF6B9A",
  "#FB60C4",
  "#D66BFF",
  "#B141FF",
  "#7C5CFF",
  "#476CFF",
  "#3399FF",
  "#63C6F2",
  "#41EBC1",
  "#2ED3A2",
  "#73EF75",
  "#9FE870",
  "#C7D36F",
  "#CCCCCC",
  "#8A8F98",
  "#4B5563",
  "#000000",
];

/** One draft editor for humans and agents; the enclosing form owns profile Save. */
export function AvatarEditor(props: Props) {
  const [open, setOpen] = useState(!!props.inlinePicker);
  const [draftPreview, setDraftPreview] = useState<DraftPreview | null>(null);
  const preview = useAvatarPreview(
    draftPreview?.picture ?? props.value,
    props.community,
  );
  const pictureError = avatarPictureError(props.value);
  const errorId = useId();
  const callback = useRef(props.onBusyChange);
  callback.current = props.onBusyChange;
  useEffect(() => {
    callback.current?.(open);
    return () => callback.current?.(false);
  }, [open]);
  const draft = open && (
    <AvatarDraft
      key={props.community ?? "local"}
      {...props}
      onPreview={setDraftPreview}
      done={(value) => {
        props.onChange(value);
        setOpen(false);
      }}
    />
  );
  return (
    <div
      className={props.inlinePicker ? styles.inlineEditor : undefined}
      data-editing={open || undefined}
    >
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          if (!props.inlinePicker || next) setOpen(next);
        }}
      >
        {props.triggerStyle === "dotted-squircle" ? (
          <Popover.Trigger
            render={
              <button
                type="button"
                className={styles.dottedTrigger}
                aria-label="Edit avatar"
                disabled={props.disabled}
              />
            }
          >
            <svg
              className={styles.dottedOutline}
              viewBox="0 0 100 100"
              aria-hidden="true"
            >
              <path d="M 50 1 C 92.14 1 99 7.86 99 50 C 99 92.14 92.14 99 50 99 C 7.86 99 1 92.14 1 50 C 1 7.86 7.86 1 50 1 Z" />
            </svg>
            {draftPreview?.emoji ? (
              <div
                role="img"
                aria-label="Emoji avatar preview"
                data-avatar-shape="squircle"
                className={styles.emojiPreview}
                style={{ backgroundColor: draftPreview.color }}
              >
                <EmojiArtwork
                  key={`${draftPreview.emoji}-${draftPreview.pulse}`}
                  emoji={draftPreview.emoji}
                  animate={!!draftPreview.pulse}
                />
              </div>
            ) : preview ? (
              <img
                src={preview}
                alt="Avatar preview"
                data-avatar-shape="squircle"
              />
            ) : (
              <PlusIcon size={28} aria-hidden="true" />
            )}
          </Popover.Trigger>
        ) : props.triggerLabel ? (
          <Popover.Trigger
            render={
              <Button size="compact" disabled={props.disabled}>
                {props.triggerLabel}
              </Button>
            }
          />
        ) : (
          <div
            className={styles.avatarFrame}
            data-shape={props.shape ?? "circle"}
            data-size={props.size}
          >
            <div
              className={styles.avatarArtwork}
              data-shape={props.shape ?? "circle"}
            >
              {draftPreview?.emoji ? (
                <div
                  role="img"
                  aria-label="Emoji avatar preview"
                  data-avatar-shape={props.shape ?? "circle"}
                  className={styles.emojiPreview}
                  style={{ backgroundColor: draftPreview.color }}
                >
                  <EmojiArtwork
                    key={`${draftPreview.emoji}-${draftPreview.pulse}`}
                    emoji={draftPreview.emoji}
                    animate={!!draftPreview.pulse}
                  />
                </div>
              ) : (
                <Avatar
                  src={preview}
                  alt={open ? "Avatar preview" : "Avatar"}
                  fallback={props.name}
                  size="fill"
                  shape={props.shape ?? "circle"}
                />
              )}
            </div>
            <div className={styles.editBadge}>
              <Popover.Trigger
                render={
                  <IconButton
                    variant="solid"
                    size="md"
                    shape="round"
                    style={{
                      width: "100%",
                      height: "100%",
                      minWidth: 0,
                      minHeight: 0,
                    }}
                    aria-label="Edit avatar"
                    aria-describedby={pictureError ? errorId : undefined}
                    icon={
                      props.value ? (
                        <PencilSimpleIcon size={16} />
                      ) : (
                        <PlusIcon size={16} />
                      )
                    }
                    disabled={props.disabled}
                  />
                }
              />
            </div>
          </div>
        )}
        {pictureError && (
          <p id={errorId} role="alert" className="text-body-sm text-danger">
            {pictureError}
          </p>
        )}
        {props.inlinePicker ? (
          draft
        ) : (
          <Popover.Portal>
            <Popover.Positioner
              side="bottom"
              align="center"
              sideOffset={8}
              collisionPadding={12}
              collisionAvoidance={{
                side: "shift",
                align: "shift",
                fallbackAxisSide: "none",
              }}
              style={{ zIndex: "var(--layer-popover)" }}
            >
              <Popover.Popup
                data-buzz-ui=""
                className={`popover-surface ${styles.popup}`}
              >
                <Popover.Title className="sr-only">Edit avatar</Popover.Title>
                {draft}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        )}
      </Popover.Root>
    </div>
  );
}

function EmojiArtwork({ emoji, animate }: { emoji: string; animate: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    if (canvas.current) paintEmojiAvatar(canvas.current, emoji);
  }, [emoji]);
  return (
    <canvas
      ref={canvas}
      width={512}
      height={512}
      data-animate={animate || undefined}
      className={styles.emojiArtwork}
      tabIndex={-1}
      aria-hidden="true"
    />
  );
}

function AvatarDraft({
  actionTarget,
  inlinePicker,
  imageOnly = false,
  value,
  community,
  onPreview,
  disabled = false,
  done,
}: Props & {
  done(value: string): void;
  onPreview(value: DraftPreview | null): void;
}) {
  const [customColorOpen, setCustomColorOpen] = useState(false);
  const customColorTrigger = useRef<HTMLButtonElement>(null);
  const wasCustomColorOpen = useRef(false);
  useLayoutEffect(() => {
    if (wasCustomColorOpen.current && !customColorOpen)
      customColorTrigger.current?.focus({ preventScroll: true });
    wasCustomColorOpen.current = customColorOpen;
  }, [customColorOpen]);
  const panels = useRef<HTMLFieldSetElement>(null);
  const [panelHeight, setPanelHeight] = useState<number>();
  useLayoutEffect(() => {
    const element = panels.current;
    if (!element) return;
    // The popover scales on entry; measure layout rather than transformed size.
    const measure = () => setPanelHeight(element.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [picture, setPicture] = useState(value);
  const [mode, setMode] = useState<"image" | "emoji" | "background">("image");
  const [emoji, setEmoji] = useState("😀");
  const [color, setColor] = useState("#FFF4CC");
  const [pulse, setPulse] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  useEffect(() => {
    onPreview({
      picture,
      ...(mode !== "image" ? { emoji, color, pulse } : {}),
    });
  }, [picture, mode, emoji, color, pulse, onPreview]);
  useEffect(() => () => onPreview(null), [onPreview]);
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      pending.current?.abort();
    },
    [],
  );
  async function upload(makeFile: () => Promise<File>, apply = false) {
    if (disabled || pending.current || !community) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError("");
    try {
      const file = await makeFile();
      request.signal.throwIfAborted();
      const url = await uploadAvatar(file, community, request.signal);
      if (!request.signal.aborted) {
        if (apply) done(url);
        else setPicture(url);
      }
    } catch (reason) {
      if (!request.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Image upload failed. Try again.",
        );
    } finally {
      if (!request.signal.aborted) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  const pictureError = avatarPictureError(picture);
  const doneButton = (
    <Button
      variant="prominent"
      disabled={
        disabled ||
        busy ||
        (mode !== "image" ? !community || !emoji.trim() : !!pictureError)
      }
      onClick={() => {
        if (mode !== "image")
          void upload(() => emojiAvatar(emoji, color), true);
        else done(picture);
      }}
    >
      Done
    </Button>
  );

  const renderPanel = (tab: string) =>
    tab === "image" ? (
      <div className={styles.imagePanel}>
        <button
          type="button"
          className={styles.dropzone}
          disabled={disabled || busy || !community}
          onClick={() => input.current?.click()}
        >
          <CloudUploadIcon size={24} aria-hidden="true" />
          <span>
            {busy
              ? "Uploading…"
              : dragging
                ? "Drop image here"
                : "Drop or browse"}
          </span>
        </button>
        <input
          ref={input}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-label="Upload an image"
          accept="image/png,image/jpeg,image/gif,image/webp,image/heic,image/heif"
          disabled={disabled || busy || !community}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void upload(async () => file);
          }}
        />
        <Field
          label="Picture URL (optional)"
          labelVisibility="hidden"
          error={pictureError}
        >
          <InputGroup leading={<LinkIcon size={18} aria-hidden="true" />}>
            <Input
              type="url"
              placeholder="Paste an image URL"
              maxLength={2048}
              disabled={disabled || busy}
              value={picture}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (!disabled && !busy && !pictureError) done(picture);
                }
              }}
              onChange={(event) => {
                setPicture(event.target.value);
                setError("");
              }}
            />
          </InputGroup>
        </Field>
      </div>
    ) : tab === "emoji" ? (
      <div className={styles.emojiPanel}>
        <AvatarEmojiPicker
          disabled={disabled || busy}
          onSelect={(value, animate) => {
            setEmoji(value);
            setPulse((current) => (animate ? current + 1 : 0));
          }}
        />
      </div>
    ) : (
      <div className={styles.backgroundPanel}>
        {customColorOpen ? (
          <AvatarCustomColor
            color={color}
            disabled={disabled || busy}
            onChange={setColor}
            onClose={() => setCustomColorOpen(false)}
          />
        ) : (
          <fieldset className={styles.swatches} aria-label="Avatar background">
            {colors.map((swatch) => (
              <button
                key={swatch}
                type="button"
                className={styles.swatch}
                aria-label={`Use ${swatch} background`}
                aria-pressed={color.toUpperCase() === swatch}
                disabled={disabled || busy}
                style={{ backgroundColor: swatch }}
                onClick={() => setColor(swatch)}
              />
            ))}
            <button
              ref={customColorTrigger}
              type="button"
              className={styles.customColor}
              aria-label="Custom background color"
              aria-pressed={!colors.includes(color.toUpperCase())}
              disabled={disabled || busy}
              onClick={() => setCustomColorOpen(true)}
            />
          </fieldset>
        )}
      </div>
    );
  return (
    <div className={styles.panelViewport} style={{ height: panelHeight }}>
      <fieldset
        ref={panels}
        aria-label="Avatar picker"
        className={styles.picker}
        data-dragging={dragging || undefined}
        onDragEnter={(event) => {
          if (
            !event.dataTransfer.types.includes("Files") ||
            disabled ||
            busy ||
            !community
          )
            return;
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
          setMode("image");
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect =
            disabled || busy || !community ? "none" : "copy";
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          const file = event.dataTransfer.files[0];
          if (file && !disabled && !busy && community) {
            setMode("image");
            void upload(async () => file);
          }
        }}
      >
        {imageOnly ? (
          renderPanel("image")
        ) : (
          <Tabs
            value={mode}
            label="Avatar source"
            variant="panel"
            items={[
              { value: "image", label: "Image" },
              { value: "emoji", label: "Emoji" },
              { value: "background", label: "Background" },
            ]}
            onValueChange={(next) => {
              if (!busy && !disabled) {
                setMode(next);
                setCustomColorOpen(false);
                setError("");
              }
            }}
            renderPanel={renderPanel}
          />
        )}
        {busy && (
          <p role="status" className="text-body-sm">
            Uploading avatar…
          </p>
        )}
        {error && (
          <p role="alert" className="text-body-sm text-danger">
            {error}
          </p>
        )}
        {!community && (
          <p className="text-body-sm text-subtle">
            Select a community in the sidebar to upload an image or emoji. Your
            local default can use a public HTTPS image URL.
          </p>
        )}
        {!(mode === "background" && customColorOpen) && (
          <div className="flex flex-wrap justify-between gap-2">
            {!imageOnly && !inlinePicker && (
              <Button
                variant="destructive"
                disabled={(!value && !picture) || disabled || busy}
                onClick={() => done("")}
              >
                Remove avatar
              </Button>
            )}
            {actionTarget ? createPortal(doneButton, actionTarget) : doneButton}
          </div>
        )}
      </fieldset>
    </div>
  );
}

const rootScale = () =>
  (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) ||
    16) / 16;

function AvatarEmojiPicker({
  onSelect,
  disabled,
}: {
  onSelect(value: string, animate: boolean): void;
  disabled: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const pointer = useRef(false);
  const callback = useRef<(value: string) => void>(() => {});
  callback.current = (value) => {
    if (disabled) return;
    const fromPointer = pointer.current;
    pointer.current = false;
    const animate =
      fromPointer &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    onSelect(value, animate);
  };
  const [error, setError] = useState(false);
  const [{ scale, perLine }, setLayout] = useState({
    scale: rootScale(),
    perLine: 0,
  });
  const search = useRef("");
  const focusPicker = useRef(true);
  const searchSelection = useRef<EmojiSearchSelection | undefined>(undefined);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const resize = () => {
      const scale = rootScale();
      // Up to six 48px slots, leaving room for a non-overlay scrollbar.
      const perLine = Math.max(
        1,
        Math.min(
          6,
          Math.floor((element.clientWidth - 20 * scale) / (48 * scale)),
        ),
      );
      setLayout((current) =>
        current.scale === scale && current.perLine === perLine
          ? current
          : { scale, perLine },
      );
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    const appearance = new MutationObserver(resize);
    appearance.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style"],
    });
    return () => {
      observer.disconnect();
      appearance.disconnect();
    };
  }, []);
  useEffect(() => {
    const element = host.current;
    if (!element || !perLine) return;
    let retired = false;
    let dispose: (() => void) | undefined;
    void import("../../bundled/emoji/emoji-mart")
      .then(({ mountEmojiMart }) => {
        if (retired) return;
        dispose = mountEmojiMart({
          host: element,
          scope: "avatar",
          autoFocus: focusPicker.current,
          perLine,
          emojiSize: 36 * scale,
          emojiButtonSize: 48 * scale,
          search: search.current,
          searchSelection,
          searchChange(value) {
            search.current = value;
          },
          entries: [],
          media: () => undefined,
          select: (value) => callback.current(value),
          close() {},
        });
      })
      .catch(() => {
        if (!retired) setError(true);
      });
    return () => {
      retired = true;
      // Shadow focus is retargeted to the picker host. Geometry changes must
      // not reclaim focus from the background controls.
      if (dispose)
        focusPicker.current = element.contains(
          element.ownerDocument.activeElement,
        );
      dispose?.();
    };
  }, [scale, perLine]);
  if (error)
    return (
      <p role="alert" className={emojiStyles.emojiStatus}>
        Could not load the emoji picker. Reopen it to retry.
      </p>
    );
  return (
    <div
      onPointerDownCapture={() => {
        pointer.current = true;
      }}
      onKeyDownCapture={() => {
        pointer.current = false;
      }}
      inert={disabled}
      className={emojiStyles.emojiMart}
    >
      <div ref={host} tabIndex={-1} />
    </div>
  );
}
