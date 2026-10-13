import { useLayoutEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import {
  avatarAnimation,
  type agentAvatars,
} from "../../features/agents/avatar-packs";

// The outgoing view stays mounted during a shared-layout transition. Read its
// current frame when the incoming video is ready instead of restarting at zero.
const playingAvatars = new Map<string, Set<HTMLVideoElement>>();

/** Animated avatar with a still fallback for reduced motion or playback failure. */
export function PackedAgentAvatar({
  avatar,
}: {
  avatar: (typeof agentAvatars)[number];
}) {
  const reducedMotion = useReducedMotion();
  const videoRef = useRef<HTMLVideoElement>(null);
  const synchronizing = useRef(false);
  const [ready, setReady] = useState<string>();
  useLayoutEffect(() => {
    if (reducedMotion) return;
    const video = videoRef.current;
    if (!video) return;
    video.muted = true;
    video.defaultMuted = true;
    video.setAttribute("muted", "");
    const videos = playingAvatars.get(avatar.id) ?? new Set<HTMLVideoElement>();
    videos.add(video);
    playingAvatars.set(avatar.id, videos);
    return () => {
      videos.delete(video);
      if (!videos.size) playingAvatars.delete(avatar.id);
    };
  }, [avatar.id, reducedMotion]);
  const [failed, setFailed] = useState<string>();
  const media = avatarAnimation(avatar.id);
  if (reducedMotion || failed === avatar.id)
    return <img src={avatar.preview} alt={avatar.label} />;
  // WebKit supports Apple's alpha HEVC; Chromium preserves alpha in WebM.
  const webkit =
    /AppleWebKit/.test(navigator.userAgent) &&
    !/Chrome|Chromium|Edg/.test(navigator.userAgent);
  const sources = webkit
    ? [
        { src: media.hevc, type: 'video/mp4; codecs="hvc1"' },
        { src: media.webm, type: "video/webm" },
      ]
    : [
        { src: media.webm, type: "video/webm" },
        { src: media.hevc, type: 'video/mp4; codecs="hvc1"' },
      ];
  return (
    <div
      style={{ position: "relative", width: "100%", height: "100%" }}
      onPointerEnter={() => {
        const video = videoRef.current;
        if (video?.paused) void video.play()?.catch(() => {});
      }}
    >
      {ready !== avatar.id && (
        <img
          src={avatar.preview}
          alt=""
          style={{
            position: "absolute",
            width: "100%",
            height: "100%",
            objectFit: "contain",
          }}
        />
      )}
      <video
        ref={videoRef}
        key={avatar.id}
        className="agent-packed-video"
        controls={false}
        disablePictureInPicture
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          opacity: ready === avatar.id ? 1 : 0,
          pointerEvents: "none",
        }}
        onLoadedData={(event) => {
          const video = event.currentTarget;
          const previous = [...(playingAvatars.get(avatar.id) ?? [])].find(
            (candidate) =>
              candidate !== video &&
              candidate.isConnected &&
              candidate.readyState >= 2 &&
              !candidate.paused,
          );
          synchronizing.current = false;
          if (
            previous &&
            Math.abs(previous.currentTime - video.currentTime) > 0.03
          ) {
            synchronizing.current = true;
            video.currentTime = previous.currentTime;
          } else setReady(avatar.id);
        }}
        onSeeked={() => {
          synchronizing.current = false;
          setReady(avatar.id);
        }}
        onCanPlay={(event) => {
          const video = event.currentTarget;
          video.muted = true;
          video.defaultMuted = true;
          // Autoplay can be temporarily blocked; keep the video for hover retry.
          void video.play()?.catch(() => {});
          if (!synchronizing.current) setReady(avatar.id);
        }}
        poster={avatar.preview}
        aria-label={avatar.label}
        onError={() => setFailed(avatar.id)}
      >
        {sources
          .filter((source) => source.src)
          .map((source, index, available) => (
            <source
              key={source.type}
              {...source}
              onError={
                index === available.length - 1
                  ? () => setFailed(avatar.id)
                  : undefined
              }
            />
          ))}
      </video>
    </div>
  );
}
