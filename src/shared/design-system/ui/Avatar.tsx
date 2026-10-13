import "../styles/avatar-shape.css";
import "../styles/avatar-status.css";
import { Avatar as BaseAvatar } from "@base-ui/react/avatar";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

type AvatarSize = "compact" | "small" | "default" | "large" | "fill";
type ImageStatus = "loading" | "loaded" | "failed";

// WebKit re-requests cached custom-scheme images on lazy remounts. Remember a
// bounded set of successful sources so only their subsequent mounts are eager.
// This is a loading hint; the real image still decides whether artwork is ready.
const loadedAvatarSources = new Set<string>();
function rememberAvatar(src: string) {
  loadedAvatarSources.delete(src);
  loadedAvatarSources.add(src);
  if (loadedAvatarSources.size > 128) {
    const oldest = loadedAvatarSources.values().next().value;
    if (oldest !== undefined) loadedAvatarSources.delete(oldest);
  }
}

function AvatarArtwork({
  src,
  fallback,
}: {
  src: string;
  fallback: ReactNode;
}) {
  const [status, setStatus] = useState<ImageStatus>("loading");
  const [showFallback, setShowFallback] = useState(false);
  const [previouslyLoaded] = useState(() => loadedAvatarSources.has(src));
  const image = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => {
    // Cached artwork is already ready at mount; reveal it before the first paint
    // instead of waiting for another asynchronous load event after navigation.
    if (image.current?.complete) {
      if (image.current.naturalWidth > 0) {
        rememberAvatar(src);
        setStatus("loaded");
      } else {
        loadedAvatarSources.delete(src);
        setStatus("failed");
      }
    }
  }, [src]);
  useEffect(() => {
    if (status !== "loading") return;
    const timer = window.setTimeout(() => setShowFallback(true), 150);
    return () => window.clearTimeout(timer);
  }, [status]);
  if (status === "failed") return <span aria-hidden="true">{fallback}</span>;
  return (
    <>
      <img
        ref={image}
        src={src}
        data-loaded={status === "loaded" ? "true" : undefined}
        alt=""
        loading={previouslyLoaded ? "eager" : "lazy"}
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={() => {
          rememberAvatar(src);
          setStatus("loaded");
        }}
        onError={() => {
          loadedAvatarSources.delete(src);
          setStatus("failed");
        }}
      />
      {status === "loading" && showFallback ? (
        <span aria-hidden="true">{fallback}</span>
      ) : null}
    </>
  );
}

export function Avatar({
  src,
  alt,
  fallback,
  fallbackContent,
  size = "default",
  shape = "circle",
  statusBadge,
}: {
  src?: string | null | undefined;
  alt: string;
  fallback: string;
  fallbackContent?: ReactNode;
  size?: AvatarSize;
  shape?: "circle" | "squircle";
  statusBadge?: "online" | "away" | "offline" | undefined;
}) {
  const initial = Array.from(fallback.trim())[0]?.toUpperCase() || "?";
  const content = fallbackContent ?? initial;
  return (
    <span
      className="buzz-avatar-status"
      data-size={size}
      data-shape={shape}
      data-status={statusBadge}
    >
      <BaseAvatar.Root
        data-buzz-ui=""
        className="buzz-avatar"
        data-size={size}
        data-avatar-shape={shape}
        role={alt ? "img" : undefined}
        aria-label={
          alt ? `${alt}${statusBadge ? `, ${statusBadge}` : ""}` : undefined
        }
        aria-hidden={!alt || undefined}
      >
        {src ? (
          <AvatarArtwork key={src} src={src} fallback={content} />
        ) : (
          <span aria-hidden="true">{content}</span>
        )}
      </BaseAvatar.Root>
      {statusBadge && (
        <span className="buzz-avatar-status-dot" aria-hidden="true" />
      )}
    </span>
  );
}
