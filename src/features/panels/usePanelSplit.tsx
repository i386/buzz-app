import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ResizeHandle } from "./ResizeHandle";
import styles from "./Panels.module.css";

// Each page owns its split; keep the preferred width while the dock is closed.
export function usePanelSplit(
  defaultWidth?: number,
  min = 316,
  primary?: { defaultWidth: number; maxRatio: number },
) {
  const ref = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  const [preferred, setPreferred] = useState<number>();
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setAvailable(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const minimum = Math.max(min, available * (1 - (primary?.maxRatio ?? 1)));
  const max = Math.max(minimum, available - 320);
  const clamp = (width: number) => Math.min(max, Math.max(minimum, width));
  const width = clamp(
    preferred ??
      defaultWidth ??
      (primary ? available - primary.defaultWidth : available / 2.1),
  );
  return {
    ref,
    style: (preferred === undefined && primary === undefined
      ? {}
      : {
          "--secondary-panel-width": `${width}px`,
        }) as CSSProperties,
    handle: (
      <ResizeHandle
        label="Resize main and secondary panels"
        direction={-1}
        width={width}
        min={minimum}
        max={max}
        setWidth={(next) => setPreferred(clamp(next))}
        reset={() => setPreferred(undefined)}
        className={styles.resize}
      />
    ),
  };
}
