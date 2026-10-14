import { useLayoutEffect, useRef, type RefObject } from "react";
import { readingPositioned } from "./use-reading";

/** One reveal per request signal, never per row/profile/image update. */
export function useMessageReveal({
  scroller,
  settled,
  messageId,
  signal,
  ready,
  complete,
  prepare,
  focus = true,
}: {
  scroller: RefObject<HTMLElement | null>;
  settled: RefObject<boolean>;
  messageId: string | undefined;
  signal: AbortSignal | undefined;
  ready: boolean;
  complete(): void;
  prepare?(): void;
  /** A covering modal owns focus; the underlying target still verifies/reveals. */
  focus?: boolean;
}) {
  const revealed = useRef<AbortSignal | undefined>(undefined);
  const focused = useRef<{ signal: AbortSignal; row: HTMLElement } | undefined>(
    undefined,
  );
  useLayoutEffect(() => {
    if (
      !ready ||
      !messageId ||
      !signal ||
      signal.aborted ||
      revealed.current === signal
    )
      return;
    const container = scroller.current;
    if (!container) return;
    let frame = 0;
    const cancel = () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      inertObserver.disconnect();
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reveal);
    };
    const observer = new MutationObserver(schedule);
    const inertObserver = new MutationObserver(schedule);
    function reveal() {
      if (!signal || signal.aborted || !container?.isConnected) return;
      const row = [
        ...container.querySelectorAll<HTMLElement>("[data-message-id]"),
      ].find((element) => element.dataset.messageId === messageId);
      if (!row) return; // Virtual rows mount asynchronously; observe the real mount.
      row.tabIndex = -1;
      row.scrollIntoView({
        block: "start",
        inline: "nearest",
        behavior: "instant",
      });
      settled.current = true;
      // A replacement may recover lost focus, but must not take it from another
      // control after this request already focused a row successfully.
      let focusPending = false;
      if (
        focus &&
        (focused.current?.signal !== signal ||
          (focused.current.row !== row &&
            (!document.activeElement ||
              document.activeElement === document.body)))
      ) {
        row.focus({ preventScroll: true });
        focusPending = document.activeElement !== row;
        if (!focusPending) focused.current = { signal, row };
      }
      frame = requestAnimationFrame(() => {
        if (signal?.aborted || !row.isConnected || !container.contains(row))
          return;
        const box = row.getBoundingClientRect();
        const viewport = container.getBoundingClientRect();
        const visible =
          box.height > 0 &&
          box.width > 0 &&
          box.bottom > Math.max(viewport.top, 0) &&
          box.top < Math.min(viewport.bottom, window.innerHeight) &&
          box.right > Math.max(viewport.left, 0) &&
          box.left < Math.min(viewport.right, window.innerWidth);
        if ((focus && (focusPending || row.closest("[inert]"))) || !visible)
          return;
        revealed.current = signal;
        cancel();
        readingPositioned(container);
        complete();
      });
    }
    signal.addEventListener("abort", cancel, { once: true });
    // Virtua attaches its scroller in an effect, after our layout effect.
    frame = requestAnimationFrame(() => {
      observer.observe(container, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style"],
      });
      const inertAncestor = container.closest("[inert]");
      if (inertAncestor)
        inertObserver.observe(inertAncestor, {
          attributes: true,
          attributeFilter: ["inert"],
        });
      prepare?.();
      schedule();
    });
    return () => {
      cancel();
      signal.removeEventListener("abort", cancel);
    };
  }, [scroller, settled, messageId, signal, ready, complete, prepare, focus]);
  return revealed;
}
