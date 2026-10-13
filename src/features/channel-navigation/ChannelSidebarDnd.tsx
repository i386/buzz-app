import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  createContext,
  useContext,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { SidebarSection } from "../../bundled/channels/SidebarSection";

const Writable = createContext(false);

/**
 * Pointer moves between saved groups, Starred and Channels. A drop only reports its
 * destination, so the caller saves it exactly like the row menu's move; that
 * menu remains the keyboard path.
 */
export function ChannelSidebarDnd({
  writable,
  onMove,
  overlay,
  children,
}: {
  writable: boolean;
  onMove: (channelId: string, sectionKey: string) => void;
  overlay: (channelId: string) => ReactNode;
  children: ReactNode;
}) {
  const [dragging, setDragging] = useState<string>();
  const sensors = useSensors(
    // A click must still select the row; only a deliberate pull starts a move.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      // The sidebar's own status is its loading notice; drag announcements live outside it.
      accessibility={{ container: document.body }}
      onDragStart={({ active }) => setDragging(String(active.id))}
      onDragCancel={() => setDragging(undefined)}
      onDragEnd={({ active, over }) => {
        setDragging(undefined);
        if (over && over.id !== active.data.current?.sectionKey)
          onMove(String(active.id), String(over.id));
      }}
    >
      <Writable.Provider value={writable}>{children}</Writable.Provider>
      {createPortal(
        // The optimistic move relocates the row, so nothing remains to settle back onto.
        <DragOverlay dropAnimation={null}>
          {dragging ? overlay(dragging) : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

/**
 * Frames only a channel's select surface, so its sessions never start a move.
 * The frame stays mounted while placement is read-only: the row keeps its
 * focus and open menu when a save starts or settles.
 */
export function DraggableChannel({
  channelId,
  sectionKey,
  children,
}: {
  channelId: string;
  sectionKey: string;
  children: ReactNode;
}) {
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: channelId,
    data: { sectionKey },
    disabled: !useContext(Writable),
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      data-channel-dragging={isDragging || undefined}
    >
      {children}
    </div>
  );
}

export function DroppableSidebarSection({
  disabled,
  ...section
}: ComponentProps<typeof SidebarSection> & { disabled: boolean }) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: section.sectionKey,
    disabled,
  });
  return (
    <SidebarSection
      {...section}
      dropRef={setNodeRef}
      dropTarget={
        isOver && active?.data.current?.sectionKey !== section.sectionKey
      }
    />
  );
}
