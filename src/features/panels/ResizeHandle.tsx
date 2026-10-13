import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import styles from "./ResizeHandle.module.css";

export function ResizeHandle({
  width,
  setWidth,
  min,
  max,
  reset,
  label,
  className = "",
  direction = 1,
}: {
  width: number;
  setWidth(width: number): void;
  min: number;
  max: number;
  reset(): void;
  label: string;
  className?: string | undefined;
  direction?: 1 | -1;
}) {
  const handle = useRef<HTMLHRElement>(null);
  const [renderedWidth, setRenderedWidth] = useState(width);
  const drag = useRef<
    { pointerId: number; startX: number; width: number } | undefined
  >(undefined);
  const resize = useRef(setWidth);
  resize.current = setWidth;
  const move = useCallback(
    (event: PointerEvent) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      event.preventDefault();
      resize.current(
        drag.current.width + direction * (event.clientX - drag.current.startX),
      );
    },
    [direction],
  );
  const finish = useCallback(() => {
    if (!drag.current) return;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    drag.current = undefined;
    handle.current?.removeAttribute("data-resizing");
    delete document.documentElement.dataset.sidebarResizing;
    document.documentElement.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }, [move]);
  // Only aria-valuenow reads the rendered width, and it changes only when the
  // panel is laid out differently (drag, keyboard step, reset, CSS clamp,
  // container or window resize). Observe the panel rather than measuring on
  // every commit: the handle re-renders with each channel-list replacement and
  // a getBoundingClientRect there forces layout of the whole committed tree.
  useLayoutEffect(() => {
    const panel =
      direction === 1
        ? handle.current?.previousElementSibling
        : handle.current?.parentElement;
    if (!(panel instanceof HTMLElement)) return;
    const observer = new ResizeObserver(() => {
      const next = Math.round(panel.getBoundingClientRect().width);
      setRenderedWidth((current) => (current === next ? current : next));
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [direction]);
  useEffect(() => () => finish(), [finish]);

  return (
    <hr
      ref={handle}
      data-panel-resize={direction === -1 ? "" : undefined}
      className={`${styles.handle} ${className}`}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(renderedWidth)}
      tabIndex={0}
      data-tooltip="Drag to resize · Double-click to reset"
      onDoubleClick={reset}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 16;
        const panel =
          direction === 1
            ? event.currentTarget.previousElementSibling
            : event.currentTarget.parentElement;
        const currentWidth =
          panel instanceof HTMLElement
            ? panel.getBoundingClientRect().width
            : renderedWidth;
        if (event.key === "ArrowLeft")
          setWidth(currentWidth - direction * step);
        else if (event.key === "ArrowRight")
          setWidth(currentWidth + direction * step);
        else if (event.key === "Home") setWidth(min);
        else if (event.key === "End") setWidth(max);
        else return;
        event.preventDefault();
      }}
      onPointerDown={(event) => {
        if (
          event.button !== 0 ||
          document.documentElement.dataset.sidebarResizing
        )
          return;
        event.preventDefault();
        const panel =
          direction === 1
            ? event.currentTarget.previousElementSibling
            : event.currentTarget.parentElement;
        drag.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          width:
            panel instanceof HTMLElement
              ? panel.getBoundingClientRect().width
              : renderedWidth,
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", finish, { once: true });
        window.addEventListener("pointercancel", finish, { once: true });
        event.currentTarget.setAttribute("data-resizing", "");
        document.documentElement.dataset.sidebarResizing = "true";
        document.documentElement.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
    />
  );
}
