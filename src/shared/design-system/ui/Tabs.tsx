import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import { NavigationItem } from "./NavigationItem";
import { IconButton } from "./IconButton";
import { XIcon } from "../icons";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type TabItem<Value extends string> = {
  value: Value;
  label: string;
  icon?: ReactNode;
  trailing?: ReactNode;
  /** Link a retained, externally owned tab panel. */
  panelId?: string;
  /** Increment to briefly identify an already-open navigation tab. */
  attentionRequest?: number | undefined;
  onClose?: (() => void) | undefined;
  /** Option/Alt+Shift+Arrow moves this tab one position; the caller places it. */
  draggable?: boolean | undefined;
  onMove?: ((delta: -1 | 1) => void) | undefined;
};

/**
 * Which background this control is drawn for.
 *
 * `chrome` is the glass pill that belongs on the app gradient. `panel` is an
 * underline for a plain light or dark surface.
 *
 * **A variant rather than a second component**, because behaviour, keyboard
 * model, accessibility, props, and the Base UI tabs underneath are identical —
 * only the appearance differs, which is what a variant is for. `IconButton`
 * spells the same idea the same way.
 *
 * `chrome` is the default because every existing call site is on the gradient.
 */
export type TabsVariant = "chrome" | "panel" | "workspace" | "navigation";

export function Tabs<Value extends string>({
  value,
  items,
  label,
  onValueChange,
  onReselect,
  trailingAction,
  variant = "chrome",
  showSelection = true,
  previewValue,
  arrivalValue,
  renderPanel,
}: {
  /** Omit only when composing an existing externally owned view. */
  renderPanel?: (value: Value) => ReactNode;
  value: Value | null;
  items: readonly TabItem<Value>[];
  label: string;
  onValueChange: (value: Value) => void;
  /** Opt in when activating the selected tab returns from a nested view. */
  onReselect?: (value: Value) => void;
  trailingAction?: ReactNode;
  variant?: TabsVariant;
  /** Hide the visual selection for a single-view header; tab semantics remain. */
  showSelection?: boolean;
  /** Incoming tab being previewed before a workspace drop is committed. */
  previewValue?: Value;
  /** Brief visual confirmation of a tab arriving after a completed move. */
  arrivalValue?: Value | undefined;
}) {
  const strip = (
    <>
      <BaseTabs.List className="buzz-tabs-list" aria-label={label}>
        {showSelection && variant !== "navigation" && (
          <BaseTabs.Indicator className="buzz-tabs-indicator" />
        )}
        {items.map((item) => (
          <span
            key={item.value}
            className="buzz-tabs-item"
            data-closable={!!item.onClose || undefined}
          >
            <BaseTabs.Tab
              value={item.value}
              title={item.label}
              render={
                variant === "navigation" ? (
                  <NavigationItem
                    label={item.label}
                    icon={
                      <>
                        <TabAttention request={item.attentionRequest} />
                        {item.icon && (
                          <span className="buzz-tabs-icon" aria-hidden="true">
                            {item.icon}
                          </span>
                        )}
                      </>
                    }
                    trailing={item.trailing}
                    selected={showSelection && item.value === value}
                    aria-current={false}
                  />
                ) : undefined
              }
              {...(item.panelId
                ? { id: `${item.panelId}-tab`, "aria-controls": item.panelId }
                : {})}
              onClick={() => {
                if (item.value === value) onReselect?.(item.value);
              }}
              onKeyDown={(event) => {
                if (item.onClose && event.key === "Delete") {
                  event.preventDefault();
                  item.onClose();
                }
                if (
                  item.onMove &&
                  event.altKey &&
                  event.shiftKey &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  (event.key === "ArrowLeft" || event.key === "ArrowRight")
                ) {
                  // Keep Base UI's arrow navigation from also moving focus.
                  event.preventDefault();
                  event.stopPropagation();
                  item.onMove(event.key === "ArrowLeft" ? -1 : 1);
                }
              }}
              className="buzz-tabs-tab"
              /* Base UI spells the selected tab `data-active`; every other
               selectable thing in this codebase is styled on `data-selected`.
               Restating it here keeps one spelling in the stylesheet rather than
               asking a reader to know which components happen to be Base
               UI-backed. Without it the selected label silently kept
               `--text-secondary` — no error, just a tab that never looked
               selected. */
              data-selected={
                (showSelection && item.value === value) || undefined
              }
              data-preview={item.value === previewValue || undefined}
              data-draggable={item.draggable || undefined}
              data-tab-value={item.value}
            >
              {variant === "workspace" && item.value === arrivalValue ? (
                <span className="buzz-tabs-arrival" aria-hidden="true" />
              ) : null}
              {variant !== "navigation" && (
                <>
                  {item.icon}
                  <span>{item.label}</span>
                  {item.trailing}
                </>
              )}
            </BaseTabs.Tab>
            {item.onClose && (
              <IconButton
                size="xs"
                aria-label={`Close ${item.label} tab`}
                onClick={item.onClose}
                icon={<XIcon size="1rem" aria-hidden="true" />}
              />
            )}
          </span>
        ))}
      </BaseTabs.List>
      {trailingAction}
    </>
  );
  return (
    <BaseTabs.Root
      data-buzz-ui=""
      className={renderPanel ? "buzz-tab-panels" : "buzz-tabs"}
      data-variant={variant}
      data-selection-hidden={!showSelection || undefined}
      value={value}
      onValueChange={(nextValue) => onValueChange(nextValue as Value)}
    >
      {renderPanel ? (
        <div
          className="buzz-tabs"
          data-variant={variant}
          data-selection-hidden={!showSelection || undefined}
        >
          {strip}
        </div>
      ) : (
        strip
      )}
      {renderPanel &&
        items.map((item) => (
          <BaseTabs.Panel
            key={item.value}
            value={item.value}
            className="buzz-tabs-panel"
          >
            {renderPanel(item.value)}
          </BaseTabs.Panel>
        ))}
    </BaseTabs.Root>
  );
}

/** Restart only the paint layer, never the focused tab or retained panel. */
function TabAttention({ request }: { request: number | undefined }) {
  const previous = useRef(request);
  const [active, setActive] = useState<number>();
  const overlay = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (previous.current === request) return;
    previous.current = request;
    setActive(request);
  }, [request]);
  useLayoutEffect(() => {
    if (active === undefined) return;
    const element = overlay.current;
    element?.parentElement?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
      behavior: "instant",
    });
    const finish = () => setActive(undefined);
    element?.addEventListener("animationend", finish);
    return () => element?.removeEventListener("animationend", finish);
  }, [active]);
  return active === undefined ? null : (
    <span
      key={active}
      ref={overlay}
      className="buzz-tabs-attention"
      aria-hidden="true"
    />
  );
}
