import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  ChannelPanelContext,
  Panels,
  RegisteredPanel,
} from "../../features/panels/service";
import { Panel } from "../../shared/design-system/ui/Panel";
import { PanelDock } from "../../features/panels/PanelDock";
import { PanelView } from "../../features/panels/PanelView";
import styles from "./Channels.module.css";

type Opening = {
  panel: RegisteredPanel;
  context: ChannelPanelContext;
  target: string;
  trigger: HTMLElement | null;
};
/** Page-local presentation; optional plugins retain their own work outside this mount. */
export function useChannelPanels(
  panels: Panels,
  context?: ChannelPanelContext,
  onOpen?: () => void,
) {
  const available = useSyncExternalStore(
    panels.subscribe,
    panels.snapshot,
    panels.snapshot,
  );
  const [opened, setOpened] = useState<Opening>();
  const mounted = useRef<ChannelPanelContext>(undefined);
  useLayoutEffect(() => {
    mounted.current = context;
    return () => {
      mounted.current = undefined;
    };
  }, [context]);
  const selected =
    opened &&
    context &&
    opened.context.scope === context.scope &&
    opened.context.channelId === context.channelId &&
    available.includes(opened.panel)
      ? opened
      : undefined;
  useLayoutEffect(() => {
    if (opened && !selected) setOpened(undefined);
  }, [opened, selected]);
  const activeOpening = useRef<Opening>(undefined);
  useLayoutEffect(() => {
    activeOpening.current = selected;
    return () => {
      activeOpening.current = undefined;
    };
  }, [selected]);
  const hide = (opening: Opening) => {
    if (activeOpening.current !== opening) return;
    setOpened((current) => (current === opening ? undefined : current));
    if (opening.trigger?.isConnected) opening.trigger.focus();
  };
  return {
    close: () => setOpened(undefined),
    launchers: context && (
      <div className={styles.channelLaunchers}>
        {available
          .filter((panel) => panel.channelLauncher)
          .map((panel) => {
            const Launcher = panel.channelLauncher;
            if (!Launcher) return null;
            return (
              <Launcher
                key={`${panel.key}:${panel.revision}`}
                context={context}
                pressed={selected?.panel === panel}
                available={() =>
                  mounted.current === context &&
                  panels.snapshot().includes(panel)
                }
                toggle={(target) => {
                  if (
                    mounted.current !== context ||
                    !panels.snapshot().includes(panel)
                  )
                    return;
                  if (selected?.panel === panel) hide(selected);
                  else {
                    onOpen?.();
                    setOpened({
                      panel,
                      context,
                      target,
                      trigger:
                        document.activeElement instanceof HTMLElement
                          ? document.activeElement
                          : null,
                    });
                  }
                }}
              />
            );
          })}
      </div>
    ),
    side: selected?.panel.channelPlacement === "side" && (
      <Panel
        aria-label={`${selected.panel.title} panel`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            hide(selected);
          }
        }}
      >
        <PanelView
          panel={selected.panel}
          target={selected.target}
          channelContext={context}
          close={() => hide(selected)}
        />
      </Panel>
    ),
    content: (
      <PanelDock
        open={!!selected && selected.panel.channelPlacement !== "side"}
        className={styles.channelDrawer}
      >
        {selected && selected.panel.channelPlacement !== "side" && (
          <section aria-label={`${selected.panel.title} drawer`}>
            <PanelView
              panel={selected.panel}
              target={selected.target}
              channelContext={context}
              close={() => hide(selected)}
            />
          </section>
        )}
      </PanelDock>
    ),
  };
}
