import type {
  AttachmentRenderer,
  ContributionReader,
} from "../conversation/contracts";
import { AttachmentView } from "../conversation/AttachmentView";
import { useConversationPresentation } from "../conversation/ConversationPresentation";
import { useRef, useState } from "react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import { useMediaCorners } from "./use-media-corners";
import { prepareReviewEntrance } from "./use-review-entrance";
import { ComposerAttachmentViewer } from "./ComposerAttachmentViewer";
import { useDraftAttachmentSource } from "./use-draft-attachment-source";
import {
  ArrowsClockwiseIcon,
  FileTextIcon,
  XIcon,
} from "../../shared/design-system/icons";
import type { DraftAttachment } from "./attachment-draft";
import styles from "./ComposerAttachments.module.css";
import { useMediaElementSource } from "./use-media-element-source";

export function ComposerAttachments({
  items,
  renderers,
  disabled,
  remove,
  retry,
  media,
}: {
  renderers?: ContributionReader<AttachmentRenderer> | undefined;
  media(url: string): string | undefined;
  items: readonly DraftAttachment[];
  disabled: boolean;
  remove(id: string): void;
  retry(id: string): void;
}) {
  const active = useConversationPresentation();
  const [selected, setSelected] = useState<string>();
  const restoreFocus = useRef<HTMLElement | null>(null);
  const instant = useReducedMotion();
  if (selected && (!active || !items.some((item) => item.id === selected)))
    setSelected(undefined);
  return (
    <>
      <AnimatePresence initial={false}>
        {items.length > 0 && (
          <motion.section
            key="attachments"
            aria-label="Attachments"
            className={styles.attachments}
            initial={false}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              duration: instant ? 0 : 0.18,
              ease: [0.23, 1, 0.32, 1],
            }}
          >
            <ul className={styles.list}>
              <AnimatePresence initial={false} propagate>
                {items.map((item) => (
                  <AttachmentItem
                    renderers={renderers}
                    media={media}
                    key={item.id}
                    item={item}
                    disabled={disabled}
                    remove={remove}
                    retry={retry}
                    preview={(trigger) => {
                      restoreFocus.current = trigger;
                      setSelected(item.id);
                    }}
                  />
                ))}
              </AnimatePresence>
            </ul>
          </motion.section>
        )}
      </AnimatePresence>
      {active && selected && (
        <ComposerAttachmentViewer
          items={items}
          selected={selected}
          select={setSelected}
          media={media}
          renderers={renderers}
          restoreFocus={restoreFocus}
          close={() => setSelected(undefined)}
        />
      )}
    </>
  );
}

function AttachmentItem({
  item,
  renderers,
  disabled,
  remove,
  retry,
  media,
  preview,
}: {
  preview(trigger: HTMLButtonElement): void;
  renderers?: ContributionReader<AttachmentRenderer> | undefined;
  media(url: string): string | undefined;
  item: DraftAttachment;
  disabled: boolean;
  remove(id: string): void;
  retry(id: string): void;
}) {
  const present = useIsPresent();
  const instant = useReducedMotion();
  const corners = useMediaCorners();
  const { source, image, video } = useDraftAttachmentSource(item, media);
  const [failedSource, setFailedSource] = useState<string>();
  const element = useMediaElementSource(video ? source : undefined);
  const videoSource = element.src;
  const failed = !!source && (failedSource === source || element.unavailable);
  const bytes = item.uploaded?.size ?? item.file.size;
  const size =
    bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  const status = {
    queued: "Queued",
    preparing: "Preparing…",
    uploading: "Uploading…",
    ready: "Ready",
    error: "Upload failed",
  }[item.status];
  // Preparation has no byte total; transfer progress comes from the host.
  const busy =
    item.status === "queued" ||
    item.status === "preparing" ||
    item.status === "uploading";
  if (item.voice && source && renderers)
    return (
      <li className={styles.voiceItem} data-voice-draft>
        <AttachmentView
          registry={renderers}
          attachment={{
            url: item.uploaded?.url ?? source,
            kind: "audio",
            mime: item.uploaded?.type ?? item.file.type,
            name: item.uploaded?.name ?? item.file.name,
            voiceNote: true,
            ...item.voice,
          }}
          source={source}
          onRemove={disabled ? undefined : () => remove(item.id)}
          fallback={
            <div>
              <span>{item.file.name}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => remove(item.id)}
              >
                Remove voice note
              </button>
            </div>
          }
        />
        {item.error && (
          <>
            <span role="alert">{item.error}</span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => retry(item.id)}
            >
              Retry voice note upload
            </button>
          </>
        )}
      </li>
    );
  return (
    <motion.li
      layout
      initial={false}
      exit={{ scale: instant ? 1 : 0.75, y: instant ? 0 : 12, opacity: 0 }}
      transition={{ duration: instant ? 0 : 0.18, ease: [0.23, 1, 0.32, 1] }}
      inert={!present}
      aria-hidden={!present || undefined}
      className={styles.item}
      data-media={image || video ? "" : undefined}
    >
      {source && !failed && (image || video) ? (
        <button
          ref={corners}
          data-media-preview=""
          data-draft-preview={item.id}
          className={styles.preview}
          type="button"
          aria-label={`Preview ${item.file.name}`}
          onClick={(event) => {
            prepareReviewEntrance(event);
            preview(event.currentTarget);
          }}
        >
          <svg
            className={styles.mediaOutline}
            data-image-outline=""
            aria-hidden="true"
          >
            <path />
          </svg>
          {image ? (
            <img
              key={source}
              src={source}
              alt=""
              onError={() => setFailedSource(source)}
            />
          ) : (
            <video
              key={source}
              src={videoSource}
              muted
              playsInline
              preload="metadata"
              onError={() => setFailedSource(source)}
              onLoadedMetadata={(event) => {
                event.currentTarget.currentTime = Math.min(
                  0.1,
                  event.currentTarget.duration || 0.1,
                );
              }}
            />
          )}
        </button>
      ) : (
        <button
          type="button"
          data-draft-preview={item.id}
          className={styles.preview}
          aria-label={`Preview ${item.file.name}`}
          onClick={(event) => preview(event.currentTarget)}
        >
          <FileTextIcon size={24} />
        </button>
      )}
      <div className={styles.details}>
        <span className={styles.name} tabIndex={source && !failed ? -1 : 0}>
          {item.file.name}
        </span>
        <span
          className={styles.hint}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="sr-only">{item.file.name}: </span>
          {size} · {status}
        </span>
        {failed && <span className="sr-only">Preview unavailable</span>}
      </div>
      <div
        className={styles.actions}
        data-remove={!busy && item.status !== "error" ? "" : undefined}
      >
        <IconButton
          size="xs"
          shape="round"
          variant="primary"
          type="button"
          disabled={disabled}
          aria-label={`${item.status === "error" ? "Retry" : "Remove"} ${item.file.name}`}
          title={
            item.status === "error"
              ? `${item.error || "Retry upload"} Press Delete to remove.`
              : busy
                ? "Cancel upload and remove attachment"
                : undefined
          }
          onKeyDown={(event) => {
            if (
              item.status === "error" &&
              (event.key === "Delete" || event.key === "Backspace")
            ) {
              event.preventDefault();
              remove(item.id);
            }
          }}
          onClick={() =>
            item.status === "error" ? retry(item.id) : remove(item.id)
          }
          icon={
            busy ? (
              <span className={styles.uploadControl}>
                <span
                  className={styles.progress}
                  role="progressbar"
                  aria-label={`${item.status === "queued" ? "Queued" : "Uploading"} ${item.file.name}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={
                    item.transfer
                      ? Math.round(
                          (item.transfer.sent / item.transfer.total) * 100,
                        )
                      : undefined
                  }
                  aria-valuetext={
                    item.transfer
                      ? item.transfer.sent === item.transfer.total
                        ? "Transfer complete; waiting for server confirmation"
                        : undefined
                      : item.status === "queued"
                        ? "Queued"
                        : "Preparing upload"
                  }
                >
                  <svg
                    key={item.transfer ? "transfer" : "preparation"}
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                    className={!item.transfer ? styles.preparing : undefined}
                  >
                    <circle
                      cx="12"
                      cy="12"
                      r="9"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      opacity="0.5"
                    />
                    <circle
                      data-upload-progress=""
                      className={styles.progressArc}
                      cx="12"
                      cy="12"
                      r="9"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      pathLength="100"
                      strokeDasharray={`${item.transfer ? (item.transfer.sent / item.transfer.total) * 100 : 25} 100`}
                      transform="rotate(-90 12 12)"
                    />
                  </svg>
                </span>
                <XIcon
                  size={16}
                  className={styles.uploadRemove}
                  data-upload-cancel=""
                />
              </span>
            ) : item.status === "error" ? (
              <ArrowsClockwiseIcon size={16} />
            ) : (
              <XIcon size={16} />
            )
          }
        />
        {item.status === "error" && (
          <IconButton
            size="xs"
            shape="round"
            variant="primary"
            disabled={disabled}
            aria-label={`Remove ${item.file.name}`}
            onClick={() => remove(item.id)}
            icon={<XIcon size={16} />}
          />
        )}
        {item.error && (
          <span role="alert" className="sr-only">
            {item.error}
          </span>
        )}
      </div>
    </motion.li>
  );
}
