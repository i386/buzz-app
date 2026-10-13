import { useCallback, useLayoutEffect, useState, type RefObject } from "react";

/** Shared directional navigation recipe for sent images and draft media. */
export const galleryMotion = {
  distance: 40,
  duration: 0.2,
  ease: [0.19, 1, 0.22, 1] as const,
};

type DepartingImage = {
  url: string;
  source: string;
  transform: string;
  direction: number;
};

/** Keep the outgoing DOM image alive until its replacement can slide into view. */
export function useImageGalleryMotion(
  stage: RefObject<HTMLDivElement | null>,
  image: RefObject<HTMLImageElement | null>,
  url: string | undefined,
  source: string | undefined,
) {
  const [departing, setDeparting] = useState<DepartingImage>();
  const prepare = useCallback(
    (direction: number) => {
      if (
        !url ||
        !source ||
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ) {
        setDeparting(undefined);
        return;
      }
      // Rapid navigation while loading should keep the last decoded picture.
      const previous =
        stage.current?.hasAttribute("data-gallery-loading") && departing
          ? departing
          : {
              url,
              source,
              transform: image.current
                ? getComputedStyle(image.current).transform
                : "none",
            };
      setDeparting({ ...previous, direction });
    },
    [url, source, stage, image, departing],
  );
  useLayoutEffect(() => {
    if (!departing) return;
    const container = stage.current;
    const incoming = image.current;
    const outgoing = container?.querySelector<HTMLElement>(
      "[data-gallery-departing]",
    );
    const reducedMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    );
    if (
      departing.url === url ||
      !container ||
      !incoming?.animate ||
      !outgoing ||
      reducedMotion?.matches
    ) {
      setDeparting(undefined);
      return;
    }
    const animations: Animation[] = [];
    let cancelled = false;
    const clear = () => {
      cancelled = true;
      delete container.dataset.galleryLoading;
      for (const animation of animations) {
        animation.onfinish = null;
        animation.cancel();
      }
    };
    const finish = () => {
      outgoing.style.visibility = "hidden";
      clear();
      setDeparting((current) => (current === departing ? undefined : current));
    };
    const start = () => {
      if (cancelled) return;
      delete container.dataset.galleryLoading;
      const distance = departing.direction * galleryMotion.distance;
      const timing = {
        duration: galleryMotion.duration * 1000,
        easing: `cubic-bezier(${galleryMotion.ease.join(",")})`,
      };
      animations.push(
        outgoing.animate(
          [
            { translate: "0px 0px", opacity: 1 },
            { translate: `${-distance}px 0px`, opacity: 0 },
          ],
          { ...timing, fill: "forwards" },
        ),
      );
      const arrival = incoming.animate(
        [
          { translate: `${distance}px 0px`, opacity: 0 },
          { translate: "0px 0px", opacity: 1 },
        ],
        timing,
      );
      animations.push(arrival);
      arrival.onfinish = finish;
    };
    if (incoming.complete) start();
    else {
      container.dataset.galleryLoading = "";
      incoming.addEventListener("load", start, { once: true });
      incoming.addEventListener("error", finish, { once: true });
    }
    window.addEventListener("resize", finish, { once: true });
    reducedMotion?.addEventListener("change", finish);
    return () => {
      clear();
      incoming.removeEventListener("load", start);
      incoming.removeEventListener("error", finish);
      window.removeEventListener("resize", finish);
      reducedMotion?.removeEventListener("change", finish);
    };
  }, [stage, image, url, departing]);
  return { departing, prepare };
}
