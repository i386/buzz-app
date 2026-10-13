import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal, flushSync } from "react-dom";
import {
  BrowserIcon,
  TerminalWindowIcon,
} from "../../shared/design-system/icons";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import styles from "./Panels.module.css";
import type { TabDragHost } from "./useTabDrag";

type Item = {
  id: string;
  label: string;
  icon?: ReactNode;
  content: ReactNode;
  /** Stable for one opening, including retained exit content. */
  instance?: object;
  /** Omit for a permanent tab such as a channel's own conversation. */
  close?: (() => void) | undefined;
  /** Keyboard placement: one position left or right, across panes at an edge. */
  move?: ((delta: -1 | 1) => void) | undefined;
};
type Identity = { label: string; icon?: ReactNode };
type Local = { id: string; label: string; owner: string; close(): void };
const TabHost = createContext<{
  owner: string;
  register(tab: Local): () => void;
  activate(owner: string, label: string): boolean;
  title(owner: string, identity: Identity | undefined): void;
  slots: ReadonlyMap<string, HTMLDivElement>;
} | null>(null);
export function usePanelTabHost() {
  return useContext(TabHost);
}

export function usePanelTabTitle(label: string, icon?: ReactNode) {
  const host = usePanelTabHost();
  const title = host?.title;
  const owner = host?.owner;
  useLayoutEffect(() => {
    if (!title || !owner) return;
    title(owner, { label, icon });
    return () => title(owner, undefined);
  }, [title, owner, label, icon]);
}

/** The channel owns target tabs; private details retain their feature's lifetime. */
export function PanelWorkspace({
  items,
  value,
  select,
  actions,
  main = false,
  label = "Panel tabs",
  focusOnMount = true,
  adoptSelection,
  drag,
}: {
  drag?: TabDragHost | undefined;
  items: Item[];
  value: string;
  select(id: string): void;
  /** Header icon actions owned by the hosting page. */
  actions?: ReactNode;
  /**
   * The page's main pane: a lone permanent tab reads as a title, and native
   * Close acts here only while focus is inside (the side pane is the default).
   */
  main?: boolean;
  label?: string;
  /** Restoring a channel visit leaves focus with its main conversation. */
  focusOnMount?: boolean;
  /** A new value adopts the current selection without moving focus. */
  adoptSelection?: unknown;
}) {
  const prefix = useId();
  const panelId = (id: string) => `${prefix}-${id}`;
  const [titles, setTitles] = useState<Record<string, Identity | undefined>>(
    {},
  );
  const title = useCallback((owner: string, identity: Identity | undefined) => {
    setTitles((current) =>
      current[owner] === identity ? current : { ...current, [owner]: identity },
    );
  }, []);
  const [locals, setLocals] = useState<Local[]>([]);
  const [localSelection, setLocalSelection] = useState<string>();
  const [slots, setSlots] = useState(new Map<string, HTMLDivElement>());
  const root = useRef<HTMLDivElement>(null);
  const focusTab = useRef(false);
  const closingTab = useRef<string | undefined>(undefined);
  // Choosing a tab with the pointer resumes its content's typing target;
  // keyboard selection keeps focus in the tab list.
  const pointerTab = useRef(false);
  const focusContent = useRef(false);
  const register = useCallback((tab: Local) => {
    setLocals((current) => [
      ...current.filter((item) => item.id !== tab.id),
      tab,
    ]);
    setLocalSelection(tab.id);
    focusTab.current = true;
    return () => {
      setLocals((current) => current.filter((item) => item.id !== tab.id));
      setLocalSelection((current) =>
        current === tab.id ? undefined : current,
      );
    };
  }, []);
  const setSlot = useCallback((id: string, element: HTMLDivElement | null) => {
    setSlots((current) => {
      if (current.get(id) === element || (!element && !current.has(id)))
        return current;
      const next = new Map(current);
      if (element) next.set(id, element);
      else next.delete(id);
      return next;
    });
  }, []);
  const owned = locals.filter((tab) =>
    items.some((item) => item.id === tab.owner),
  );
  const activate = useCallback(
    (owner: string, label: string) => {
      const tab = locals.find(
        (tab) => tab.owner === owner && tab.label === label,
      );
      if (!tab) return false;
      setLocalSelection(tab.id);
      return true;
    },
    [locals],
  );
  const selectedLocal = owned.find(
    (tab) => tab.id === localSelection && tab.owner === value,
  );
  const selected = selectedLocal?.id ?? value;
  const tabs = items.flatMap((item) => [
    {
      ...item,
      ...titles[item.id],
      icon: titles[item.id]?.icon ?? item.icon ?? <BrowserIcon size="1rem" />,
    },
    ...owned
      .filter((tab) => tab.owner === item.id)
      .map((tab) => ({ ...tab, icon: <TerminalWindowIcon size="1rem" /> })),
  ]);
  const active = tabs.find((tab) => tab.id === selected);
  useLayoutEffect(() => {
    const close = (event: Event) => {
      const element = root.current;
      if (
        event.defaultPrevented ||
        !active?.close ||
        !element?.isConnected ||
        // With two tab hosts, the one containing focus owns Close.
        (document.activeElement?.closest(
          "[data-panel-workspace], [data-main-workspace]",
        ) ?? (main ? null : element)) !== element ||
        element.closest('[hidden], [inert], [aria-hidden="true"]') ||
        !element.getClientRects().length
      )
        return;
      event.preventDefault();
      // Match the X button, including local detail tabs and focus recovery.
      // Commit before another native menu request can reuse this selection.
      flushSync(() => {
        closingTab.current = active.id;
        active.close?.();
      });
    };
    window.addEventListener("buzz:close-active-tab", close);
    return () => window.removeEventListener("buzz:close-active-tab", close);
  });
  const previous = useRef<string>(focusOnMount ? undefined : selected);
  const instance = items.find((item) => item.id === selected)?.instance;
  const previousInstance = useRef<object>(focusOnMount ? undefined : instance);
  const adopted = useRef(adoptSelection);
  useLayoutEffect(() => {
    if (adopted.current !== adoptSelection) {
      adopted.current = adoptSelection;
      previous.current = selected;
      previousInstance.current = instance;
    }
    if (
      previous.current !== selected ||
      previousInstance.current !== instance ||
      focusTab.current ||
      (closingTab.current && !tabs.some((tab) => tab.id === closingTab.current))
    ) {
      const tab = root.current?.querySelector<HTMLElement>(
        '[role="tab"][aria-selected="true"]',
      );
      const content =
        focusContent.current && previous.current !== selected
          ? document
              .getElementById(panelId(selected))
              ?.querySelector<HTMLElement>(
                '[data-tab-focus]:not([aria-disabled="true"])',
              )
          : undefined;
      // A route may mount/select a retained tab behind an open dialog.
      // Its navigation must not take focus from the modal's own handoff.
      const modal = document.querySelector('dialog[open], [aria-modal="true"]');
      if (!modal || modal.contains(root.current)) {
        content?.focus({ preventScroll: true });
        if (!content || document.activeElement !== content)
          tab?.focus({ preventScroll: true });
      }
      tab?.parentElement?.scrollIntoView?.({
        block: "nearest",
        inline: "nearest",
      });
      previous.current = selected;
      previousInstance.current = instance;
      focusTab.current = false;
      focusContent.current = false;
      closingTab.current = undefined;
    }
  });
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape from descendant controls closes their active tab.
    <div
      {...(main
        ? { "data-main-workspace": "" }
        : { "data-panel-workspace": "" })}
      className={styles.workspace}
      ref={(element) => {
        root.current = element;
        drag?.attach(element);
      }}
      onClickCapture={drag?.click}
      onPointerDownCapture={(event) => {
        drag?.begin(event);
        pointerTab.current = !!(event.target as Element).closest?.(
          '[role="tab"]',
        );
      }}
      onKeyDownCapture={() => {
        pointerTab.current = false;
      }}
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !event.nativeEvent.isComposing &&
          event.nativeEvent.keyCode !== 229 &&
          !event.defaultPrevented &&
          active?.close &&
          event.currentTarget.contains(event.target as Node)
        ) {
          event.stopPropagation();
          active.close();
        }
      }}
    >
      <PanelHeader
        actions={actions}
        title={
          <Tabs
            label={label}
            variant="navigation"
            showSelection={!main || tabs.length > 1}
            value={selected}
            items={tabs.map((tab) => ({
              value: tab.id,
              label: tab.label,
              icon: tab.icon,
              panelId: panelId(tab.id),
              onMove: "move" in tab ? tab.move : undefined,
              draggable: !!drag && "move" in tab && !!tab.move,
              onClose: tab.close
                ? () => {
                    closingTab.current = tab.id;
                    tab.close?.();
                  }
                : undefined,
            }))}
            onValueChange={(id) => {
              focusContent.current = pointerTab.current;
              pointerTab.current = false;
              const local = owned.find((tab) => tab.id === id);
              setLocalSelection(local?.id);
              select(local?.owner ?? id);
            }}
          />
        }
      />
      <div className={styles.workspaceBody}>
        {items.map((item) => (
          <TabScope
            key={item.id}
            owner={item.id}
            activate={activate}
            title={title}
            register={register}
            slots={slots}
          >
            <div
              role="tabpanel"
              id={panelId(item.id)}
              aria-labelledby={`${panelId(item.id)}-tab`}
              className={styles.workspacePane}
              data-covered={selected !== item.id || undefined}
              inert={selected !== item.id}
              aria-hidden={selected !== item.id || undefined}
            >
              {item.content}
            </div>
          </TabScope>
        ))}
        {owned.map((tab) => (
          <LocalSlot
            key={tab.id}
            id={tab.id}
            panelId={panelId(tab.id)}
            selected={selected === tab.id}
            setSlot={setSlot}
          />
        ))}
      </div>
    </div>
  );
}
function TabScope({
  owner,
  activate,
  title,
  register,
  slots,
  children,
}: NonNullable<ReturnType<typeof usePanelTabHost>> & { children: ReactNode }) {
  const value = useMemo(
    () => ({ owner, activate, title, register, slots }),
    [owner, activate, title, register, slots],
  );
  return <TabHost.Provider value={value}>{children}</TabHost.Provider>;
}
function LocalSlot({
  id,
  panelId,
  selected,
  setSlot,
}: {
  id: string;
  panelId: string;
  selected: boolean;
  setSlot(id: string, element: HTMLDivElement | null): void;
}) {
  const ref = useCallback(
    (element: HTMLDivElement | null) => setSlot(id, element),
    [id, setSlot],
  );
  return (
    <div
      ref={ref}
      role="tabpanel"
      id={panelId}
      aria-labelledby={`${panelId}-tab`}
      className={styles.workspacePane}
      data-covered={!selected || undefined}
      inert={!selected}
      aria-hidden={!selected || undefined}
    />
  );
}
export function PanelLocalTab({
  title,
  close,
  children,
}: {
  title: string;
  close(): void;
  children: ReactNode;
}) {
  const host = usePanelTabHost();
  const id = useId();
  const onClose = useRef(close);
  onClose.current = close;
  const register = host?.register;
  const owner = host?.owner;
  useLayoutEffect(() => {
    if (!register || !owner) return;
    return register({
      id,
      label: title,
      owner,
      close: () => onClose.current(),
    });
  }, [register, owner, id, title]);
  const slot = host?.slots.get(id);
  return slot
    ? createPortal(
        <section className={styles.tabDetail} aria-label={title}>
          {children}
        </section>,
        slot,
      )
    : null;
}
