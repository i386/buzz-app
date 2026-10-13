import { createPortal } from "react-dom";

/** Panel Swap's title-only drag treatment. Geometry belongs to the host. */
export function TabDragFeedback({
  label,
  ghost,
  insertion,
  edge,
}: {
  edge?: { x: number; y: number } | undefined;
  label: string;
  ghost: { x: number; y: number; width: number; height: number };
  insertion?: { x: number; y: number; height: number } | undefined;
}) {
  return createPortal(
    <>
      <div
        className="buzz-tab-drag-title text-body"
        aria-hidden="true"
        style={{
          transform: `translate3d(${ghost.x}px, ${ghost.y}px, 0)`,
          width: ghost.width,
          height: ghost.height,
        }}
      >
        {label}
      </div>
      {edge && (
        <div
          className="buzz-tab-drag-edge"
          aria-hidden="true"
          style={{ left: edge.x, top: edge.y }}
        />
      )}
      {insertion && (
        <div
          className="buzz-tab-drag-insertion"
          aria-hidden="true"
          style={{
            left: insertion.x,
            top: `calc(${insertion.y}px + var(--space-2))`,
            height: `max(0px, calc(${insertion.height}px - 2 * var(--space-2)))`,
          }}
        />
      )}
    </>,
    document.body,
  );
}
