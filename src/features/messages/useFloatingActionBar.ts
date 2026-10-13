import {
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import {
  behindActiveModal,
  observeModals,
} from "../../shared/design-system/modalLayer";

const floatingQuery = "(hover: hover) and (pointer: fine)";
// One MediaQueryList for every row: `matchMedia` allocates and evaluates the
// query on each call, and these run in every row's first render and every
// external-store snapshot read. The list itself tracks modality changes. Keyed
// on the `matchMedia` function so a replaced implementation is re-queried.
let floatingSource: typeof window.matchMedia | undefined;
let floatingList: MediaQueryList | undefined;
const floating = () => {
  if (floatingSource !== window.matchMedia) {
    floatingSource = window.matchMedia;
    floatingList = floatingSource?.(floatingQuery);
  }
  return floatingList;
};
const subscribe = (notify: () => void) => {
  const query = floating();
  query?.addEventListener("change", notify);
  return () => query?.removeEventListener("change", notify);
};
const snapshot = () => floating()?.matches ?? false;

const awaitingKeyboard = new Set<() => void>();
const activateKeyboardActions = (event: KeyboardEvent) => {
  if (event.key !== "Tab" || event.metaKey || event.ctrlKey) return;
  // Native Tab must see the real controls before choosing its destination,
  // including continuation rows with no preceding avatar/button to focus.
  flushSync(() => {
    for (const activate of awaitingKeyboard) activate();
  });
};

/** Defer untouched desktop controls, then preserve their state for the row's life. */
export function useMessageActionBarReady(
  rowRef: RefObject<HTMLDivElement | null> | undefined,
) {
  const [ready, setReady] = useState(
    () =>
      !rowRef ||
      !snapshot() ||
      document.documentElement.hasAttribute("data-keyboard-navigation"),
  );
  useEffect(() => {
    const row = rowRef?.current;
    if (ready || !row) return;
    const activate = () => setReady(true);
    const query = floating();
    const modalityChanged = () => {
      if (!query?.matches) activate();
    };
    if (
      !query?.matches ||
      row.matches(":hover") ||
      row.contains(document.activeElement) ||
      document.documentElement.hasAttribute("data-keyboard-navigation")
    ) {
      activate();
      return;
    }
    row.addEventListener("pointerenter", activate);
    row.addEventListener("focusin", activate);
    query.addEventListener("change", modalityChanged);
    if (awaitingKeyboard.size === 0)
      window.addEventListener("keydown", activateKeyboardActions, true);
    awaitingKeyboard.add(activate);
    return () => {
      row.removeEventListener("pointerenter", activate);
      row.removeEventListener("focusin", activate);
      query.removeEventListener("change", modalityChanged);
      awaitingKeyboard.delete(activate);
      if (awaitingKeyboard.size === 0)
        window.removeEventListener("keydown", activateKeyboardActions, true);
    };
  }, [ready, rowRef]);
  return ready;
}

/** Keep the controls in DOM/tab order while painting outside list containment. */
export function useFloatingActionBar(
  rowRef: RefObject<HTMLDivElement | null> | undefined,
  barRef: RefObject<HTMLDivElement | null>,
  slotRef: RefObject<HTMLDivElement | null>,
  open: boolean,
) {
  const floating = useSyncExternalStore(subscribe, snapshot, () => false);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const row = rowRef?.current;
    const bar = barRef.current;
    if (!floating || !row || !bar) return;
    // Top-layer descendants don't contribute to :hover or :focus-within.
    let hovered = row.matches(":hover") || bar.matches(":hover");
    // Read modality with focus on every update: pointer focus must not pin the
    // bar when hover leaves, including after keyboard-to-pointer transitions.
    const keyboardFocus = () =>
      row.matches(":has(:focus-visible)") ||
      (document.documentElement.hasAttribute("data-keyboard-navigation") &&
        row.contains(document.activeElement));
    const update = (focused = keyboardFocus()) => {
      const next =
        hovered ||
        focused ||
        open ||
        !!bar.querySelector('[aria-haspopup][aria-expanded="true"]');
      row.toggleAttribute("data-actions-revealed", next);
      setRevealed(next);
    };
    const enter = () => {
      hovered = true;
      update();
    };
    const leave = () => {
      hovered = false;
      update();
    };
    const focusIn = () => update();
    const focusOut = (event: FocusEvent) => {
      update(
        event.relatedTarget instanceof Node &&
          row.contains(event.relatedTarget) &&
          keyboardFocus(),
      );
    };
    row.addEventListener("pointerenter", enter);
    row.addEventListener("pointerleave", leave);
    row.addEventListener("focusin", focusIn);
    row.addEventListener("focusout", focusOut);
    const observer = new MutationObserver(() => {
      // Recheck focus if a control is removed without dispatching focusout.
      update();
    });
    observer.observe(bar, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-expanded"],
    });
    update();
    return () => {
      row.removeEventListener("pointerenter", enter);
      row.removeEventListener("pointerleave", leave);
      row.removeEventListener("focusin", focusIn);
      row.removeEventListener("focusout", focusOut);
      observer.disconnect();
      row.removeAttribute("data-actions-revealed");
    };
  }, [floating, open, rowRef, barRef]);

  useLayoutEffect(() => {
    const row = rowRef?.current;
    const bar = barRef.current;
    const slot = slotRef.current;
    if (!floating || !revealed || !row || !bar || !slot) return;
    const scroller = row.closest<HTMLElement>("[data-message-scroller]");
    let frame = 0;
    const hide = () => {
      if (bar.hasAttribute("popover")) bar.hidePopover?.();
      // Closed popovers return to their slot's containing block. Viewport offsets
      // there would create invisible overflow and interfere with scrolling.
      bar.style.top = "";
      bar.style.left = "";
      bar.style.right = "";
    };
    const position = () => {
      const anchor = slot.getBoundingClientRect();
      // A top-layer toolbar can retain hover above a portalled modal's backdrop.
      // Keep actions in the active viewer usable, but suppress background rows.
      if (behindActiveModal(row)) {
        hide();
        return;
      }
      const viewport = scroller?.getBoundingClientRect();
      // The slot marks the toolbar bottom; CSS lifts it above the author line.
      if (
        viewport &&
        (anchor.top <= viewport.top ||
          anchor.top - bar.offsetHeight >= viewport.bottom)
      ) {
        hide();
        return;
      }
      const rtl = getComputedStyle(row).direction === "rtl";
      bar.style.top = `${anchor.top}px`;
      bar.style.left = rtl ? `${anchor.left}px` : "auto";
      bar.style.right = rtl
        ? "auto"
        : `${document.documentElement.clientWidth - anchor.right}px`;
      bar.showPopover?.();
    };
    // A transition or animation on the slot or an ancestor (such as a sliding
    // drawer) moves it without resizing, mutating or scrolling anything.
    const moving = () => {
      for (let node: Element | null = slot; node; node = node.parentElement)
        for (const animation of node.getAnimations?.() ?? [])
          if (
            animation.playState === "running" &&
            Number.isFinite(animation.effect?.getComputedTiming().endTime)
          )
            return true;
      return false;
    };
    let following = false;
    // Every move of the slot arrives through an event or observer below. Read
    // its rect once per frame from those, rather than polling it every frame and
    // forcing a layout whenever the timeline is mid-mutation. Only while finite
    // motion is in flight does it follow every frame, ending with a realignment
    // at the resting position.
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        position();
        if (following) following = moving();
        if (following) schedule();
      });
    };
    const follow = () => {
      following = true;
      schedule();
    };
    const motion = (event: Event) => {
      if (event.target instanceof Node && event.target.contains(slot)) follow();
    };
    const motionEvents = [
      "transitionrun",
      "transitionend",
      "transitioncancel",
      "animationstart",
      "animationend",
      "animationcancel",
    ];
    position();
    if (moving()) follow();
    for (const type of motionEvents)
      document.addEventListener(type, motion, true);
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(slot);
    observer.observe(row);
    // Sibling edits and media measurements move the slot without resizing any
    // observed node. The toolbar's own positioning writes must not retrigger it.
    const siblings = new MutationObserver((records) => {
      if (records.some((record) => !bar.contains(record.target))) schedule();
    });
    if (scroller) {
      observer.observe(scroller);
      siblings.observe(scroller, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    }
    // Observe modals only while reveal is requested, and share the existing
    // coalesced positioning update.
    const unobserveModals = observeModals(schedule);
    return () => {
      cancelAnimationFrame(frame);
      for (const type of motionEvents)
        document.removeEventListener(type, motion, true);
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
      siblings.disconnect();
      unobserveModals();
      hide();
    };
  }, [floating, revealed, rowRef, barRef, slotRef]);

  return floating;
}
