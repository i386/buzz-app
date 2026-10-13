import {
  useEffect,
  useEffectEvent,
  useState,
  type RefObject,
  type DragEvent as ReactDragEvent,
} from "react";

/** A pane must reject unclaimed files even while its composer is absent. */
export function rejectUnhandledFileDrop(event: ReactDragEvent<HTMLElement>) {
  if (!event.dataTransfer.types.includes("Files")) return;
  if (!event.defaultPrevented) event.dataTransfer.dropEffect = "none";
  event.preventDefault();
  event.stopPropagation();
}

/** Route a file drop to this pane's composer, never another open conversation. */
export function useFileDrop(
  composer: RefObject<HTMLFormElement | null>,
  enabled: boolean,
  attach: (files: readonly File[]) => void,
) {
  const [dragging, setDragging] = useState(false);
  const accept = useEffectEvent((files: readonly File[]) => {
    if (enabled) attach(files);
  });
  useEffect(() => {
    setDragging(false);
    const form = composer.current;
    const zone =
      form?.closest<HTMLElement>("[data-attachment-drop-zone]") ?? form;
    if (!zone) return;
    let depth = 0;
    const files = (event: DragEvent) =>
      event.dataTransfer?.types.includes("Files");
    const owns = (event: DragEvent) =>
      event.target instanceof Element &&
      (event.target.closest("[data-attachment-drop-zone]") ?? form) === zone;
    const reset = () => {
      depth = 0;
      setDragging(false);
    };
    const enter = (event: DragEvent) => {
      if (!files(event) || !owns(event)) return;
      event.preventDefault();
      depth++;
      setDragging(enabled);
    };
    const leave = (event: DragEvent) => {
      if (!files(event) || !owns(event)) return;
      if (--depth <= 0) reset();
    };
    const over = (event: DragEvent) => {
      if (!files(event) || !owns(event)) return;
      setDragging(enabled);
      event.preventDefault();
      if (event.dataTransfer)
        event.dataTransfer.dropEffect = enabled ? "copy" : "none";
    };
    const drop = (event: DragEvent) => {
      if (!files(event) || !owns(event)) return;
      event.preventDefault();
      event.stopPropagation();
      reset();
      accept(Array.from(event.dataTransfer?.files ?? []));
    };
    zone.addEventListener("dragenter", enter);
    zone.addEventListener("dragleave", leave);
    zone.addEventListener("dragover", over);
    zone.addEventListener("drop", drop);
    window.addEventListener("drop", reset);
    window.addEventListener("dragend", reset);
    return () => {
      zone.removeEventListener("dragenter", enter);
      zone.removeEventListener("dragleave", leave);
      zone.removeEventListener("dragover", over);
      zone.removeEventListener("drop", drop);
      window.removeEventListener("drop", reset);
      window.removeEventListener("dragend", reset);
    };
  }, [composer, enabled]);
  return enabled && dragging;
}
