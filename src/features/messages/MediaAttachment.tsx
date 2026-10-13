import { useConversationPresentation } from "../conversation/ConversationPresentation";
import { prepareReviewEntrance } from "./use-review-entrance";
import { useMediaCorners } from "./use-media-corners";
import { VideoPlayer, VideoControls } from "./VideoPlayer";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { ArrowsOutIcon, XIcon } from "../../shared/design-system/icons/index";
import { createPortal } from "react-dom";
import type { Attachment } from "../relay/contracts";
import styles from "./Messages.module.css";
import { useModalBoundary } from "./useModalBoundary";
import { useMediaElementSource } from "./use-media-element-source";

export type MediaPlayback = Readonly<{
  attachmentUrl: string;
  seconds: number;
}>;

type MediaAttachmentProps = {
  attachment: Attachment;
  media(url: string): string | undefined;
  mode?: "inline" | "thread";
  imageDescription?: string;
  preload?: "auto" | "metadata" | "none";
  seekTo?: number;
  seekRequest?: number;
  onPlayback?(playback: MediaPlayback): void;
  onOpenReview?(attachment: Attachment, seconds: number): void;
};

function useVideoPosition(
  video: RefObject<HTMLVideoElement | null>,
  seekTo: number | undefined,
  seekRequest: number | undefined,
  active: boolean,
) {
  const wasActive = useRef(active);
  useLayoutEffect(() => {
    // A monotonically increasing request lets the same timecode seek again.
    void seekRequest;
    const recovered = active && !wasActive.current;
    wasActive.current = active;
    const element = video.current;
    if (!element) return;
    if (!active) {
      element.pause();
      return;
    }
    // Recovery restores the same paused position, not an old seek intent.
    if (recovered || seekTo === undefined) return;
    const seek = () => {
      element.currentTime = Math.max(0, seekTo);
      void element.play().catch(() => {});
    };
    if (element.readyState >= HTMLMediaElement.HAVE_METADATA) seek();
    else element.addEventListener("loadedmetadata", seek, { once: true });
    return () => element.removeEventListener("loadedmetadata", seek);
  }, [seekTo, seekRequest, video, active]);
}

export function MediaAttachment({
  attachment,
  media,
  mode = "inline",
  imageDescription = "Attachment preview",
  preload = "auto",
  seekTo,
  seekRequest,
  onPlayback,
  onOpenReview,
}: MediaAttachmentProps) {
  const active = useConversationPresentation();
  const corners = useMediaCorners();
  const source = media(attachment.url);
  const preview = attachment.previewUrl
    ? media(attachment.previewUrl)
    : undefined;
  const video = useRef<HTMLVideoElement>(null);
  const expandedVideo = useRef<HTMLVideoElement>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  if (!active && viewerOpen) setViewerOpen(false);
  const [currentTime, setCurrentTime] = useState(seekTo ?? 0);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [capturedPreview, setCapturedPreview] = useState<string>();
  const [measuredDimensions, setMeasuredDimensions] = useState<{
    width: number;
    height: number;
  }>();
  const dimensions = attachment.dimensions ?? measuredDimensions;
  const previewStyle = dimensions
    ? ({
        "--media-ratio": `${dimensions.width} / ${dimensions.height}`,
        aspectRatio: "var(--media-ratio)",
      } as CSSProperties)
    : undefined;
  const visiblePreview = preview ?? capturedPreview;
  useVideoPosition(video, seekTo, seekRequest, active);
  const element = useMediaElementSource(
    attachment.kind === "video" ? source : undefined,
  );
  const videoSource = element.src;

  if (!source)
    return (
      <span className={styles.attachmentUnavailable} role="status">
        {attachment.kind === "video"
          ? "Video unavailable"
          : "Image unavailable"}
      </span>
    );

  if (failed || element.unavailable)
    return (
      <span className={styles.attachmentUnavailable} role="status">
        {attachment.kind === "video"
          ? "Video unavailable"
          : "Image unavailable"}
      </span>
    );

  if (attachment.kind === "image")
    return (
      <>
        <button
          ref={corners}
          className={`${styles.mediaPreview} ${mode === "thread" ? styles.mediaPreviewThread : ""}`}
          style={previewStyle}
          type="button"
          aria-label="Open image fullscreen"
          data-image-preview=""
          data-media-preview=""
          onClick={(event) => {
            prepareReviewEntrance(event);
            if (onOpenReview) onOpenReview(attachment, 0);
            else setViewerOpen(true);
          }}
        >
          <span className={styles.mediaPreviewPixels}>
            <img
              src={source}
              alt={imageDescription}
              loading="lazy"
              onLoad={(event) =>
                setMeasuredDimensions({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              onError={() => setFailed(true)}
            />
          </span>
          <svg
            className={styles.imageOutline}
            data-image-outline=""
            aria-hidden="true"
          >
            <path />
          </svg>
        </button>
        {active &&
          viewerOpen &&
          createPortal(
            <MediaViewer
              title="Image attachment"
              close={() => setViewerOpen(false)}
            >
              <img
                className={styles.mediaViewerImage}
                src={source}
                alt={imageDescription}
              />
            </MediaViewer>,
            document.body,
          )}
      </>
    );

  if (attachment.kind !== "video")
    return (
      <span className={styles.attachmentUnavailable} role="status">
        Attachment unavailable
      </span>
    );

  const videoElement = (
    // biome-ignore lint/a11y/useMediaCaption: signed attachment metadata has no caption track URL.
    <video
      ref={video}
      className={styles.mediaVideo}
      src={videoSource}
      poster={visiblePreview}
      preload={preload}
      playsInline
      style={previewStyle}
      onLoadedData={(event) => {
        const element = event.currentTarget;
        // WebKit can emit loadeddata before nonzero dimensions are available.
        // Invalid geometry must not replace the usable preview fallback.
        if (
          Number.isFinite(element.videoWidth) &&
          element.videoWidth > 0 &&
          Number.isFinite(element.videoHeight) &&
          element.videoHeight > 0
        )
          setMeasuredDimensions({
            width: element.videoWidth,
            height: element.videoHeight,
          });
        if (!preview && element.currentTime === 0) {
          // WebKit often paints no frame at exactly zero. Seeking after actual
          // frame data arrives forces a decodable opening frame.
          element.currentTime = Math.min(0.1, element.duration || 0.1);
          return;
        }
      }}
      onSeeked={(event) => {
        const element = event.currentTarget;
        if (!preview && !capturedPreview && element.videoWidth > 0) {
          try {
            const canvas = document.createElement("canvas");
            const scale = Math.min(1, 640 / element.videoWidth);
            canvas.width = Math.max(1, Math.round(element.videoWidth * scale));
            canvas.height = Math.max(
              1,
              Math.round(element.videoHeight * scale),
            );
            canvas
              .getContext("2d")
              ?.drawImage(element, 0, 0, canvas.width, canvas.height);
            setCapturedPreview(canvas.toDataURL("image/jpeg", 0.8));
          } catch {
            // A decoded frame may still paint in the video when canvas export
            // is unavailable; the poster capture is only a compatibility aid.
          }
        }
      }}
      onError={() => setFailed(true)}
      onPause={() => setPlaying(false)}
      onPlay={() => {
        setStarted(true);
        setPlaying(true);
      }}
      onTimeUpdate={(event) => {
        const seconds = event.currentTarget.currentTime;
        setCurrentTime(seconds);
        onPlayback?.({ attachmentUrl: attachment.url, seconds });
      }}
    />
  );

  return (
    <>
      <div
        ref={corners}
        className={`${styles.mediaPreview} ${mode === "thread" ? styles.mediaPreviewThread : ""}`}
        data-video-preview=""
        data-media-preview=""
        data-started={started || undefined}
        data-playing={playing ? "true" : undefined}
        style={previewStyle}
      >
        <div
          className={`${styles.mediaPreviewPixels} dark`}
          data-color-mode="dark"
        >
          {visiblePreview && !started && (
            <img
              className={styles.mediaPoster}
              src={visiblePreview}
              alt=""
              aria-hidden="true"
            />
          )}
          {videoElement}
          {active && <VideoControls videoRef={video} inline />}
          <span className={styles.mediaExpand}>
            <IconButton
              size="compact"
              variant="media"
              type="button"
              aria-label="Open video fullscreen"
              onClick={(event) => {
                prepareReviewEntrance(event);
                video.current?.pause();
                if (onOpenReview) onOpenReview(attachment, currentTime);
                else setViewerOpen(true);
              }}
              icon={<ArrowsOutIcon size={16} aria-hidden="true" />}
            />
          </span>
        </div>
        <svg
          className={styles.imageOutline}
          data-image-outline=""
          aria-hidden="true"
        >
          <path />
        </svg>
      </div>
      {active &&
        viewerOpen &&
        createPortal(
          <MediaViewer
            title="Video attachment"
            close={() => setViewerOpen(false)}
          >
            <VideoPlayer
              source={source}
              poster={visiblePreview}
              videoRef={expandedVideo}
              initialTime={currentTime}
              onError={() => setFailed(true)}
              onTime={(seconds) => {
                setCurrentTime(seconds);
                if (video.current) video.current.currentTime = seconds;
                onPlayback?.({ attachmentUrl: attachment.url, seconds });
              }}
            />
          </MediaViewer>,
          document.body,
        )}
    </>
  );
}

/** The plain fullscreen fallback for surfaces that host no media review. */
export function MediaViewer({
  title,
  close,
  children,
}: {
  title: string;
  close(): void;
  children: ReactNode;
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useModalBoundary(backdrop, closeButton, close);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is a pointer-only shortcut; the dialog has an explicit close button and Escape behavior.
    <div
      ref={backdrop}
      className={styles.mediaViewerBackdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className={`${styles.mediaViewer} dark`}
        data-color-mode="dark"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className={styles.mediaViewerHeading} data-tauri-drag-region>
          <PanelHeader
            title={<PanelHeaderLabel title={title} />}
            actions={
              <IconButton
                size="compact"
                ref={closeButton}
                type="button"
                aria-label="Close fullscreen viewer"
                onClick={close}
                icon={<XIcon size={20} aria-hidden="true" />}
              />
            }
          />
        </div>
        {children}
      </section>
    </div>
  );
}
