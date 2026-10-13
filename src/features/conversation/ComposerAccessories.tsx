import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerAccessory,
  ComposerAccessoryProps,
  ContributionReader,
} from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";

export function ComposerAccessories({
  registry,
  ...props
}: ComposerAccessoryProps & {
  registry: ContributionReader<ComposerAccessory>;
}) {
  const entries = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const order = (entry: ComposerAccessory) =>
    Number.isFinite(entry.order) ? (entry.order ?? 0) : 0;
  return entries
    .filter((entry) => (entry.placement === "message") === !!props.message)
    .sort(
      (a, b) =>
        order(a) - order(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    )
    .map((entry) => (
      <ContributionBoundary
        key={`${contributionKey(entry)}:${props.scope}:${props.channelId}:${props.message?.id ?? props.threadRootId ?? ""}`}
        fallback={<p role="status">{entry.title} unavailable</p>}
      >
        <OwnedAccessory entry={entry} registry={registry} {...props} />
      </ContributionBoundary>
    ));
}
function OwnedAccessory({
  entry,
  registry,
  ...props
}: ComposerAccessoryProps & {
  entry: Contribution<ComposerAccessory>;
  registry: ContributionReader<ComposerAccessory>;
}) {
  const current = useRef(props);
  useLayoutEffect(() => {
    current.current = props;
  });
  const canOpenThread = !!props.openThread;
  const [commands, setCommands] =
    useState<
      Pick<
        ComposerAccessoryProps,
        "canOpen" | "open" | "openThread" | "onFocusedRemoval"
      >
    >();
  useLayoutEffect(() => {
    let live = true;
    const session = props.session;
    const active = () =>
      live &&
      registry.snapshot().includes(entry) &&
      current.current.session === session;
    setCommands({
      canOpen: (target) => active() && current.current.canOpen(target),
      open: (target) => active() && current.current.open(target),
      onFocusedRemoval: () => {
        if (active()) current.current.onFocusedRemoval?.();
      },
      openThread: canOpenThread
        ? () => active() && (current.current.openThread?.() ?? false)
        : undefined,
    });
    return () => {
      live = false;
    };
  }, [entry, registry, props.session, canOpenThread]);
  const Accessory = entry.component;
  return commands ? <Accessory {...props} {...commands} /> : null;
}
