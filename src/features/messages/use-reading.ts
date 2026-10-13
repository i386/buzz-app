import { useEffect, type RefObject } from "react";
import type { RelaySession } from "../relay/session";
import type { ReadingHandle } from "../relay/unread";
import { useMessageEditScope } from "./MessageEditScope";

/** Wake dwell after owner-controlled positioning, even when geometry is unchanged. */
export function readingPositioned(element: HTMLElement | null) {
  element?.dispatchEvent(new Event("reading-positioned"));
}

type Reading = {
  session: RelaySession;
  channelId: string;
  latestMessageId?: string | undefined;
  rootId?: string | undefined;
  scroller: RefObject<HTMLElement | null>;
  settled: RefObject<boolean>;
};
/** `useReading` for an owner that renders its own `MessageEditScope`. */
export function Reading(props: Reading) {
  useReading(props);
  return null;
}
/**
 * Consumer-owned observation: focused, visible, settled rows, never virtualizer
 * overscan. Call it inside the `MessageEditScope` this message list shares with
 * its composer, so focus in that composer counts and another surface's does not.
 */
export function useReading({
  session,
  channelId,
  latestMessageId,
  rootId,
  scroller,
  settled,
}: Reading) {
  const composer = useMessageEditScope()?.input;
  useEffect(() => {
    if (!scroller.current) return;
    const element: HTMLElement = scroller.current;
    let handle: ReadingHandle | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const observing = new Set<ReadingHandle>();
    // The message list or its own composer: typing under a conversation is
    // reading it. A parent scope's composer belongs to another surface. A panel
    // that owns the list opts in whole, so opening it is enough.
    const surface = element.closest("[data-reading-surface]");
    // A tabbed thread's header is outside its content, but aria-labelledby
    // identifies its owning tab. Never borrow focus from a sibling tab.
    const focusedTab = (node: EventTarget | null) => {
      // Retained content can move panes without restarting this observation.
      const tabPanel = surface?.closest('[role="tabpanel"]');
      const label = tabPanel?.getAttribute("aria-labelledby");
      const tab = label ? document.getElementById(label) : null;
      return (
        tab?.getAttribute("role") === "tab" &&
        tab.getAttribute("aria-selected") === "true" &&
        tab.contains(node as Node | null)
      );
    };
    const focused = (node: EventTarget | null) =>
      node instanceof Node &&
      (element.contains(node) ||
        !!surface?.contains(node) ||
        focusedTab(node) ||
        !!composer?.current?.contains(node));
    const active = () =>
      !stopped &&
      element.isConnected &&
      !element.closest('[inert], [hidden], [aria-hidden="true"]') &&
      settled.current &&
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      focused(document.activeElement) &&
      element.getClientRects().length > 0;
    function cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      handle?.dispose();
      handle = undefined;
    }
    function stop() {
      cancel();
      for (const observed of observing) observed.dispose();
      observing.clear();
    }
    function visibleIds() {
      const viewport = element.getBoundingClientRect();
      return [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
        .flatMap((row) => {
          const bounds = row.getBoundingClientRect();
          return row.dataset.membershipRow === undefined &&
            row.dataset.messageId &&
            bounds.height > 0 &&
            bounds.width > 0 &&
            bounds.top >= Math.max(viewport.top, 0) &&
            bounds.bottom <= Math.min(viewport.bottom, window.innerHeight) &&
            bounds.left >= Math.max(viewport.left, 0) &&
            bounds.right <= Math.min(viewport.right, window.innerWidth)
            ? [row.dataset.messageId]
            : [];
        })
        .slice(0, 128);
    }
    function bottomId() {
      if (
        !latestMessageId ||
        element.scrollHeight - element.clientHeight - element.scrollTop > 1
      )
        return;
      const viewport = element.getBoundingClientRect();
      const row = [
        ...element.querySelectorAll<HTMLElement>("[data-message-id]"),
      ].find((row) => row.dataset.messageId === latestMessageId);
      const bounds = row?.getBoundingClientRect();
      return bounds &&
        bounds.height > 0 &&
        bounds.width > 0 &&
        bounds.bottom > Math.max(viewport.top, 0) &&
        bounds.bottom <= Math.min(viewport.bottom, window.innerHeight) &&
        bounds.left >= Math.max(viewport.left, 0) &&
        bounds.right <= Math.min(viewport.right, window.innerWidth)
        ? latestMessageId
        : undefined;
    }
    function schedule() {
      cancel();
      if (!active()) return;
      const ids = visibleIds();
      const bottom = bottomId();
      if (!ids.length && !bottom) return;
      try {
        // Capture the lease BEFORE dwell: a newer manual action invalidates it.
        handle = session.unread.reading(channelId);
        handle.view(ids, active);
      } catch {
        return; // Membership may disappear between commit and observation.
      }
      timer = setTimeout(() => {
        timer = undefined;
        if (!active()) {
          cancel();
          return;
        }
        const visible = new Set(visibleIds());
        // A row appearing only at the end of the interval has not had a dwell.
        const remained = ids.filter((id) => visible.has(id));
        const caughtUp = bottom && bottom === bottomId();
        if (
          (remained.length || caughtUp) &&
          session.unread.sync().capability === "frontier-sync" &&
          handle
        ) {
          // Dwell is already earned. Detach this lease so active-surface reflow
          // can schedule the next interval without revoking queued durability.
          const observed = handle;
          handle = undefined;
          observing.add(observed);
          // Viewing belongs only to the current handle: the write lease keeps
          // its read intent but stops reporting rows that may scroll away.
          // A view-only lease keeps that evidence until the next cancellation.
          observed.view([], () => false);
          try {
            handle = session.unread.reading(channelId);
            handle.view([...visible], active);
          } catch {
            handle = undefined;
          }
          void (async () => {
            if (caughtUp) await observed.catchUp(bottom, rootId);
            await observed.observe(remained);
          })()
            .catch(() => {})
            .finally(() => {
              if (observing.delete(observed)) observed.dispose();
            });
        }
      }, 300);
    }
    for (const event of [
      "scroll",
      "pointerdown",
      "keydown",
      "reading-positioned",
    ])
      element.addEventListener(event, schedule);
    const focus = (event: FocusEvent) =>
      focused(event.type === "focusin" ? event.target : event.relatedTarget)
        ? schedule()
        : stop();
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", focus);
    window.addEventListener("blur", stop);
    window.addEventListener("focus", schedule);
    const visibility = () =>
      document.visibilityState === "visible" ? schedule() : stop();
    document.addEventListener("visibilitychange", visibility);
    const mutation = new MutationObserver(schedule);
    mutation.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    schedule();
    return () => {
      stopped = true;
      stop();
      mutation.disconnect();
      resize.disconnect();
      for (const event of [
        "scroll",
        "pointerdown",
        "keydown",
        "reading-positioned",
      ])
        element.removeEventListener(event, schedule);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", focus);
      window.removeEventListener("blur", stop);
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [
    session,
    channelId,
    latestMessageId,
    rootId,
    scroller,
    settled,
    composer,
  ]);
}
