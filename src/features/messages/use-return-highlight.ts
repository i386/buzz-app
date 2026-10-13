import { useEffect, useRef, type RefObject } from "react";
import styles from "./Messages.module.css";

/** A close-time orientation cue, not a reveal request or a scroll owner. */
export function useReturnHighlight(
  conversation: RefObject<HTMLElement | null>,
  channelId: string | undefined,
) {
  const pending = useRef<() => void>(() => {});
  // biome-ignore lint/correctness/useExhaustiveDependencies: a channel change retires the prior channel's pending or painted cue.
  useEffect(() => () => pending.current(), [channelId]);
  return (messageId: string | undefined) => {
    pending.current();
    if (!messageId) return;
    let row: HTMLElement | undefined;
    const clear = () => {
      row?.classList.remove(styles.returnHighlight ?? "");
      row?.removeEventListener("animationend", finish);
    };
    const finish = (event: AnimationEvent) => {
      if (event.target === row && event.pseudoElement === "::after") clear();
    };
    // Let tab selection and the current close/navigation commit settle first.
    // Check once: hidden, unloaded and offscreen roots get no deferred cue.
    const frame = requestAnimationFrame(() => {
      const container = conversation.current;
      if (
        !container?.isConnected ||
        container.closest('[inert], [hidden], [aria-hidden="true"]')
      )
        return;
      const scroller = container.querySelector<HTMLElement>(
        "[data-channel-timeline]",
      );
      if (!scroller || scroller.dataset.channelTimeline !== channelId) return;
      const item = [
        ...scroller.querySelectorAll<HTMLElement>("[data-message-id]"),
      ].find((element) => element.dataset.messageId === messageId);
      // Paint the message itself, never its day divider.
      row =
        item?.querySelector<HTMLElement>(":scope > [data-layout]") ?? undefined;
      if (!row) return;
      const box = row.getBoundingClientRect();
      const viewport = scroller.getBoundingClientRect();
      if (
        !box.width ||
        !box.height ||
        box.bottom <= Math.max(viewport.top, 0) ||
        box.top >= Math.min(viewport.bottom, window.innerHeight) ||
        box.right <= Math.max(viewport.left, 0) ||
        box.left >= Math.min(viewport.right, window.innerWidth)
      )
        return;
      row.classList.add(styles.returnHighlight ?? "");
      row.addEventListener("animationend", finish);
    });
    pending.current = () => {
      cancelAnimationFrame(frame);
      clear();
    };
  };
}
