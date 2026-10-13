import {
  useLayoutEffect,
  useRef,
  type RefObject,
  type MouseEvent,
} from "react";
import { mediaCornerClip } from "./media-corners";

type Bounds = Pick<DOMRect, "left" | "top" | "width" | "height">;
type ReviewOrigin = Bounds & {
  aspect: number;
  preview: Element;
  previewBounds: Bounds;
  radius: string;
  smooth: boolean;
  poster?: string | undefined;
};

// One place to tune the shared-element motion, independent of the viewer UI.
const SNAPPY = { duration: 240, easing: "cubic-bezier(0.19, 1, 0.22, 1)" };

function pictureFrames(
  media: HTMLElement,
  origin: Bounds,
  aspect: number,
  previewBounds: Bounds,
  radius: string,
  smooth: boolean,
): [Keyframe, Keyframe] | undefined {
  const bounds = media.getBoundingClientRect();
  const padding = Number.parseFloat(getComputedStyle(media).paddingBottom) || 0;
  const target = contained(
    {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height - padding,
    },
    aspect,
  );
  if (target.width <= 0 || target.height <= 0) return undefined;
  const dx = origin.left + origin.width / 2 - target.left - target.width / 2;
  const dy = origin.top + origin.height / 2 - target.top - target.height / 2;
  const transformOrigin = `${target.left + target.width / 2 - bounds.left}px ${target.top + target.height / 2 - bounds.top}px`;
  const scale = origin.width / target.width;
  const left = origin.left - (target.left - bounds.left) * scale;
  const top = origin.top - (target.top - bounds.top) * scale;
  const inset = [
    (previewBounds.top - top) / scale,
    bounds.width - (previewBounds.left + previewBounds.width - left) / scale,
    bounds.height - (previewBounds.top + previewBounds.height - top) / scale,
    (previewBounds.left - left) / scale,
  ]
    .map((value) => `${value}px`)
    .join(" ");
  const corners = radius
    .split(" ")
    .map((value) => `${Number.parseFloat(value) / scale}px`)
    .join(" ");
  const originClip = smooth
    ? mediaCornerClip(
        previewBounds.width / scale,
        previewBounds.height / scale,
        Number.parseFloat(radius) / scale,
        (previewBounds.left - left) / scale,
        (previewBounds.top - top) / scale,
      )
    : `inset(${inset} round ${corners})`;
  return [
    {
      clipPath: originClip,
      transformOrigin,
      transform: `translate(${dx}px, ${dy}px) scale(${origin.width / target.width})`,
    },
    {
      transformOrigin,
      transform: "none",
      clipPath: smooth
        ? mediaCornerClip(bounds.width, bounds.height, 0)
        : "inset(0px round 0px)",
    },
  ];
}

/** Capture the actual pixels inside a contained thumbnail, excluding letterboxing. */
function contained(bounds: Bounds, aspect: number): Bounds {
  const width = Math.min(bounds.width, bounds.height * aspect);
  const height = width / aspect;
  return {
    left: bounds.left + (bounds.width - width) / 2,
    top: bounds.top + (bounds.height - height) / 2,
    width,
    height,
  };
}

export function prepareReviewEntrance(event: MouseEvent<HTMLElement>) {
  event.currentTarget.dataset.reviewMotion =
    event.detail > 0 ? "pointer" : "instant";
  event.currentTarget.focus({ preventScroll: true });
}

export function readReviewOrigin(
  opener: HTMLElement | null,
): ReviewOrigin | undefined {
  if (opener?.dataset.reviewMotion !== "pointer") return undefined;
  const preview = opener.closest("[data-media-preview]");
  const bounds = preview?.getBoundingClientRect();
  if (!preview || !bounds || bounds.width <= 0 || bounds.height <= 0)
    return undefined;
  const media = preview?.querySelector("img, video");
  const aspect =
    media instanceof HTMLImageElement &&
    media.naturalWidth &&
    media.naturalHeight
      ? media.naturalWidth / media.naturalHeight
      : media instanceof HTMLVideoElement &&
          media.videoWidth &&
          media.videoHeight
        ? media.videoWidth / media.videoHeight
        : bounds.width / bounds.height;
  return {
    ...previewPicture(preview, bounds, aspect),
    aspect,
    preview,
    previewBounds: bounds,
    radius: previewRadius(preview),
    smooth: preview.hasAttribute("data-smooth-corners"),
    poster: preview?.querySelector("video")?.poster || undefined,
  };
}

function previewPicture(
  preview: Element,
  bounds: Bounds,
  aspect: number,
): Bounds {
  const media = preview.querySelector("img, video");
  if (media && getComputedStyle(media).objectFit === "cover") {
    // The full image extends beyond the cropped tile; previewBounds clips it.
    const width = Math.max(bounds.width, bounds.height * aspect);
    const height = width / aspect;
    return {
      left: bounds.left + (bounds.width - width) / 2,
      top: bounds.top + (bounds.height - height) / 2,
      width,
      height,
    };
  }
  const fit = contained(bounds, aspect);
  if (
    media instanceof HTMLImageElement &&
    media.naturalWidth &&
    getComputedStyle(media).objectFit === "scale-down" &&
    fit.width > media.naturalWidth
  ) {
    return {
      left: bounds.left + (bounds.width - media.naturalWidth) / 2,
      top: bounds.top + (bounds.height - media.naturalHeight) / 2,
      width: media.naturalWidth,
      height: media.naturalHeight,
    };
  }
  return fit;
}

function previewRadius(preview: Element) {
  const style = getComputedStyle(preview);
  return [
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomRightRadius,
    style.borderBottomLeftRadius,
  ]
    .map((value) => Number.parseFloat(value) || 0)
    .join(" ");
}

/** Animate the live media into the final viewer layout, with chrome following. */
export function useReviewEntrance(
  frame: RefObject<HTMLElement | null>,
  origin: ReviewOrigin | undefined,
  close: () => void,
  returnToOrigin: boolean,
  returnOrigin?: () => ReviewOrigin | undefined,
) {
  const entranceCancel = useRef<() => void>(() => {});
  const exitAnimations = useRef<Animation[]>([]);
  const closing = useRef(false);
  const exitCleanup = useRef<() => void>(() => {});
  const revealPreview = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const preview = origin?.preview;
    const backdrop = frame.current?.parentElement;
    if (backdrop) backdrop.style.visibility = "";
    const opacity =
      preview instanceof HTMLElement ? preview.style.opacity : undefined;
    revealPreview.current = () => {
      if (preview instanceof HTMLElement) preview.style.opacity = opacity ?? "";
    };
    return () => {
      // Hide the whole shell before cancelling filled animations. WebKit can
      // otherwise composite a restored background during DOM removal.
      if (backdrop) backdrop.style.visibility = "hidden";
      revealPreview.current();
      exitCleanup.current();
      for (const animation of exitAnimations.current) {
        animation.onfinish = null;
        animation.oncancel = null;
        animation.cancel();
      }
    };
  }, [frame, origin]);
  useLayoutEffect(() => {
    const panel = frame.current;
    const media = Array.from(
      panel?.querySelectorAll<HTMLElement>("[data-review-media]") ?? [],
    ).find((element) => !element.closest("[inert]"));
    const reducedMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    );
    if (!panel || !media?.animate || !origin || reducedMotion?.matches) {
      if (panel) delete panel.dataset.reviewPending;
      return;
    }
    const animations: Animation[] = [];
    let picture: Animation | undefined;
    let cancelled = false;
    const start = () => {
      if (cancelled) return;
      delete panel.dataset.reviewPending;
      const frames = pictureFrames(
        media,
        origin,
        origin.aspect,
        origin.previewBounds,
        origin.radius,
        origin.smooth,
      );
      if (!frames) {
        return;
      }
      panel.dataset.reviewOpening = "";
      if (origin.preview instanceof HTMLElement)
        origin.preview.style.opacity = "0";
      picture = media.animate(frames, SNAPPY);
      animations.push(picture);
      for (const element of panel.querySelectorAll<HTMLElement>(
        "[data-review-chrome]",
      )) {
        animations.push(
          element.animate(
            [
              { opacity: 0, transform: "translateY(6px)" },
              { opacity: 1, transform: "none" },
            ],
            { duration: 160, delay: 80, fill: "backwards", easing: "ease-out" },
          ),
        );
      }
      // Reveal the shell behind the moving picture, rather than scaling an empty box.
      const stage = media.closest<HTMLElement>("[data-review-stage]");
      for (const element of new Set([panel, stage, media.parentElement])) {
        if (!element) continue;
        const style = getComputedStyle(element);
        animations.push(
          element.animate(
            [
              {
                backgroundColor: "transparent",
                borderColor: "transparent",
                boxShadow: "none",
              },
              {
                backgroundColor: style.backgroundColor,
                borderColor: style.borderColor,
                boxShadow: style.boxShadow,
              },
            ],
            { duration: 160, delay: 80, fill: "backwards", easing: "ease-out" },
          ),
        );
      }
      const scrim = panel.parentElement?.querySelector<HTMLElement>(
        "[data-review-backdrop]",
      );
      if (scrim)
        animations.push(
          scrim.animate([{ opacity: 0 }, { opacity: 1 }], SNAPPY),
        );
      const settle = () => {
        delete panel.dataset.reviewOpening;
      };
      picture.onfinish = settle;
      picture.oncancel = settle;
    };
    const cancel = () => {
      cancelled = true;
      delete panel.dataset.reviewPending;
      delete panel.dataset.reviewOpening;
      if (origin.preview instanceof HTMLElement)
        origin.preview.style.opacity = "0";
      for (const animation of animations) animation.cancel();
    };
    // A newly mounted img may not have decoded yet, even when the chat copy has.
    // Keep the chat pixels visible until there is a real picture to animate.
    if (media instanceof HTMLImageElement && !media.complete) {
      panel.dataset.reviewPending = "";
      media.addEventListener("load", start, { once: true });
      media.addEventListener("error", cancel, { once: true });
    } else start();
    entranceCancel.current = cancel;
    const interact = (event: Event) => {
      // Let the close action reverse from the visible frame, without first
      // snapping an unfinished entrance to its final state.
      if (
        event.target instanceof Element &&
        event.target.closest("[data-review-dismiss]")
      )
        return;
      cancel();
    };
    panel.addEventListener("pointerdown", interact);
    panel.addEventListener("keydown", cancel, { once: true });
    window.addEventListener("resize", cancel, { once: true });
    reducedMotion?.addEventListener("change", cancel);
    return () => {
      cancelled = true;
      media.removeEventListener("load", start);
      media.removeEventListener("error", cancel);
      delete panel.dataset.reviewPending;
      if (picture) {
        picture.onfinish = null;
        picture.oncancel = null;
      }
      for (const animation of animations) animation.cancel();
      delete panel.dataset.reviewOpening;
      panel.removeEventListener("pointerdown", interact);
      panel.removeEventListener("keydown", cancel);
      window.removeEventListener("resize", cancel);
      reducedMotion?.removeEventListener("change", cancel);
    };
  }, [frame, origin]);
  const dismiss = (pointer: boolean) => {
    const panel = frame.current;
    const media = Array.from(
      panel?.querySelectorAll<HTMLElement>("[data-review-media]") ?? [],
    ).find((element) => !element.closest("[inert]"));
    if (media instanceof HTMLVideoElement) media.pause();
    if (
      !pointer ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      close();
      return;
    }
    if (closing.current) return;
    if (
      !panel ||
      !media?.animate ||
      panel.hasAttribute("data-review-pending")
    ) {
      close();
      return;
    }
    closing.current = true;
    // Hold the current layout while comments and controls disappear.
    const panelStyle = getComputedStyle(panel);
    panel.style.gridTemplateColumns = panelStyle.gridTemplateColumns;
    panel.style.gridTemplateRows = panelStyle.gridTemplateRows;
    const wasOpening = panel.hasAttribute("data-review-opening");
    const transform = getComputedStyle(media).transform;
    const clipPath = getComputedStyle(media).clipPath;
    const chrome = [
      ...panel.querySelectorAll<HTMLElement>("[data-review-chrome]"),
    ].map((element) => ({
      element,
      opacity: getComputedStyle(element).opacity,
    }));
    const stage = media.closest<HTMLElement>("[data-review-stage]");
    const shells = [...new Set([panel, stage, media.parentElement])].flatMap(
      (element) => {
        if (!element) return [];
        const style = getComputedStyle(element);
        return [
          {
            element,
            style: {
              backgroundColor: style.backgroundColor,
              borderColor: style.borderColor,
              boxShadow: style.boxShadow,
            },
          },
        ];
      },
    );
    const scrim = panel.parentElement?.querySelector<HTMLElement>(
      "[data-review-backdrop]",
    );
    const scrimOpacity = scrim ? getComputedStyle(scrim).opacity : "1";
    entranceCancel.current();
    const targetOrigin = returnOrigin ? returnOrigin() : origin;
    const destination = targetOrigin?.preview.getBoundingClientRect();
    const visible =
      destination &&
      destination.width > 0 &&
      destination.height > 0 &&
      destination.right > 0 &&
      destination.bottom > 0 &&
      destination.left < window.innerWidth &&
      destination.top < window.innerHeight;
    // A different gallery image or a zoomed crop has no matching chat rectangle.
    const zoomed = media.closest("[data-review-zoomed]");
    const frames =
      targetOrigin?.preview.isConnected && visible && returnToOrigin && !zoomed
        ? pictureFrames(
            media,
            previewPicture(
              targetOrigin.preview,
              destination,
              targetOrigin.aspect,
            ),
            targetOrigin.aspect,
            destination,
            previewRadius(targetOrigin.preview),
            targetOrigin.smooth,
          )
        : undefined;
    panel.dataset.reviewClosing = frames ? "shared" : "fade";
    const animations = exitAnimations.current;
    if (frames) {
      if (
        targetOrigin?.preview instanceof HTMLElement &&
        targetOrigin.preview !== origin?.preview
      ) {
        const preview = targetOrigin.preview;
        const opacity = preview.style.opacity;
        const reveal = revealPreview.current;
        preview.style.opacity = "0";
        revealPreview.current = () => {
          reveal();
          preview.style.opacity = opacity;
        };
      }
      animations.push(
        media.animate(
          [
            {
              ...frames[1],
              transform: wasOpening ? transform : "none",
              ...(wasOpening ? { clipPath } : {}),
            },
            frames[0],
          ],
          { ...SNAPPY, fill: "forwards" },
        ),
      );
    } else {
      animations.push(
        media.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 160,
          fill: "forwards",
        }),
      );
    }
    for (const { element, opacity } of chrome) {
      animations.push(
        element.animate([{ opacity }, { opacity: 0 }], {
          duration: 100,
          fill: "forwards",
          easing: "ease-out",
        }),
      );
    }
    for (const { element, style } of shells) {
      animations.push(
        element.animate(
          [
            style,
            {
              backgroundColor: "transparent",
              borderColor: "transparent",
              boxShadow: "none",
            },
          ],
          { duration: 100, fill: "forwards", easing: "ease-out" },
        ),
      );
    }
    if (scrim)
      animations.push(
        scrim.animate([{ opacity: scrimOpacity }, { opacity: 0 }], {
          ...SNAPPY,
          fill: "forwards",
        }),
      );
    const reducedMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    );
    window.addEventListener("resize", close, { once: true });
    reducedMotion?.addEventListener("change", close, { once: true });
    exitCleanup.current = () => {
      window.removeEventListener("resize", close);
      reducedMotion?.removeEventListener("change", close);
    };
    // Keep the modal boundary alive until the picture arrives, then restore focus.
    const completion = animations[0];
    if (completion) {
      completion.onfinish = () => {
        // Reveal the thumbnail and retire the moving layer in the same paint.
        // Cancelling a forwards-filled animation during unmount must not flash
        // the full-size media for a frame (especially in WebKit).
        if (panel.parentElement)
          panel.parentElement.style.visibility = "hidden";
        revealPreview.current();
        media.style.visibility = "hidden";
        close();
      };
      completion.oncancel = close;
    }
  };
  return { dismiss };
}
