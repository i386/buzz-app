import { threadPlacementPreference } from "../../features/messages/thread-preferences";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import type {
  ChannelPanelContext,
  RegisteredPanel,
} from "../../features/panels/service";

export type PanelOpening = {
  channelId: string;
  /** Thread root of the message the opening link was in. */
  rootId?: string;
  panel: RegisteredPanel;
  target: string;
  channelContext?: ChannelPanelContext;
};
export type ConversationTab =
  | { id: string; kind: "conversation"; channelId: string }
  | {
      id: string;
      kind: "thread";
      channelId: string;
      messageId: string;
      replyRequest?: number | undefined;
      /** Threads live in the side pane unless moved or opened into main. */
      pane?: TabPane | undefined;
      /** The reader's verified root, which may differ from a link's hint. */
      rootId?: string | undefined;
    };
export type TabPane = "main" | "side";
export const tabPane = (tab: ConversationTab): TabPane =>
  tab.kind === "thread" && tab.pane === "main" ? "main" : "side";
type VisitSelection = {
  selected: string;
  mainSelected?: string | undefined;
  paneOpen: boolean;
};
type State = {
  entries: PanelOpening[];
  tabs: ConversationTab[];
  selected: string;
  /** Selected main-pane tab; undefined is the channel conversation. */
  mainSelected?: string | undefined;
  /** The last history visit applied, so remounting never reapplies it. */
  visit?: string | undefined;
  /** Selection each recent visit had when it was left. */
  visits?: Record<string, VisitSelection> | undefined;
  /** The current visit's selection was already captured as it was left. */
  left?: boolean;
  paneOpen: boolean;
  thread: { channelId: string; messageId: string } | undefined;
  settings: { id: string; channelId: string | undefined } | undefined;
};
// Apply one history visit once. Leaving a visit remembers its selection, so
// Back/Forward restore which tabs were selected and never close any.
const snapshotOf = (state: State): VisitSelection => ({
  selected: state.selected,
  mainSelected: state.mainSelected,
  // An empty pane is not visible, even if its preferred open flag is true.
  // Restoring it after a new thread arrived must not reveal that later thread.
  paneOpen:
    state.paneOpen &&
    !!(
      state.tabs.some((tab) => tabPane(tab) === "side") ||
      state.entries.length ||
      state.settings ||
      state.thread
    ),
});
const remember = (state: State) => {
  if (!state.visit) return state.visits;
  const visits = { ...state.visits, [state.visit]: snapshotOf(state) };
  const keys = Object.keys(visits);
  for (const key of keys.slice(0, Math.max(0, keys.length - 50)))
    delete visits[key];
  return visits;
};

const empty: State = {
  entries: [],
  tabs: [],
  selected: "thread",
  paneOpen: true,
  thread: undefined,
  settings: undefined,
};
export const panelTabId = (entry: PanelOpening) =>
  `${entry.panel.key}:${entry.target}`;

/** Opening a thread selects its existing tab or adds one in `pane`. */
function withThread(
  state: State,
  channelId: string,
  messageId: string,
  rootId: string,
  intent: "reply" | "select" | undefined,
  pane: TabPane,
): State {
  const existing = state.tabs.find(
    (tab) =>
      tab.kind === "thread" &&
      tab.channelId === channelId &&
      (tab.rootId
        ? tab.rootId === rootId
        : tab.id === `thread:${channelId}:${rootId}`),
  );
  const baseId = `thread:${channelId}:${rootId}`;
  const id =
    existing?.id ??
    (state.tabs.some((tab) => tab.id === baseId)
      ? `${baseId}:${crypto.randomUUID()}`
      : baseId);
  const prior = existing?.kind === "thread" ? existing : undefined;
  const next: ConversationTab = {
    id,
    kind: "thread",
    channelId,
    messageId,
    replyRequest:
      intent === "reply"
        ? (prior?.replyRequest ?? 0) + 1
        : intent === "select"
          ? prior?.replyRequest
          : undefined,
    // An already-open thread stays wherever it was placed.
    pane: prior ? tabPane(prior) : pane,
    rootId: prior?.rootId,
  };
  const tabs = existing
    ? state.tabs.map((tab) => (tab.id === id ? next : tab))
    : [...state.tabs, next];
  return tabPane(next) === "main"
    ? { ...state, tabs, mainSelected: id }
    : { ...state, tabs, selected: id, paneOpen: true };
}

// Pages mount and unmount during navigation; their tab descriptors belong to
// the community session. Weak ownership retires them with that session.
const sessions = new WeakMap<RelaySession, ReturnType<typeof createTabStore>>();
function createTabStore() {
  let channels: Record<string, State> = {};
  const listeners = new Set<() => void>();
  return {
    snapshot: () => channels,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(change: (previous: Record<string, State>) => Record<string, State>) {
      const next = change(channels);
      if (next === channels) return;
      channels = next;
      for (const listener of listeners) listener();
    },
  };
}

/** No credentials, page callbacks, or DOM elements are retained. */
export function useChannelTabState(
  session: RelaySession,
  channelId: string | undefined,
  page = "messages",
) {
  let store = sessions.get(session);
  if (!store) {
    store = createTabStore();
    sessions.set(session, store);
  }
  const channels = useSyncExternalStore(store.subscribe, store.snapshot);
  const setChannels = store.update;
  const key = JSON.stringify([page, channelId ?? ""]);
  const state = channels[key] ?? empty;
  const update = useCallback(
    (change: (previous: State) => State) => {
      setChannels((all) => {
        const previous = all[key] ?? empty;
        const next = change(previous);
        return next === previous ? all : { ...all, [key]: next };
      });
    },
    [key, setChannels],
  );
  const setEntries = useCallback(
    (entries: PanelOpening[]) => update((s) => ({ ...s, entries })),
    [update],
  );
  const retireMenuEntries = useCallback(
    () =>
      update((s) => {
        const entries = s.entries.filter((entry) => !entry.panel.channelMenu);
        if (entries.length === s.entries.length) return s;
        return {
          ...s,
          entries,
          selected: s.entries.some(
            (entry) =>
              entry.panel.channelMenu && panelTabId(entry) === s.selected,
          )
            ? "thread"
            : s.selected,
        };
      }),
    [update],
  );
  const setTabs = useCallback(
    (change: (tabs: ConversationTab[]) => ConversationTab[]) =>
      update((s) => ({ ...s, tabs: change(s.tabs) })),
    [update],
  );
  // Opening and selection are one channel-store update. The caller owns
  // current access/visit checks; no navigation request is retained here.
  const openThreadTab = useCallback(
    (
      channelId: string,
      messageId: string,
      rootId: string,
      intent?: "reply" | "select",
      pane: TabPane = threadPlacementPreference(),
    ) =>
      update((state) =>
        withThread(state, channelId, messageId, rootId, intent, pane),
      ),
    [update],
  );
  // An action that starts a new visit (opening a thread) captures the current
  // one first, before it changes any selection.
  const leaveVisit = useCallback(
    () =>
      update((state) =>
        state.visit && !state.left
          ? { ...state, visits: remember(state), left: true }
          : state,
      ),
    [update],
  );
  // A hint addressed an existing tab, but its verified reader rejected that
  // ancestry. Preserve its editor and let a provisional tab resolve the link.
  const divertThread = useCallback(
    (id: string, requested: string, kept: string) =>
      update((state) => {
        const tab = state.tabs.find((item) => item.id === id);
        if (tab?.kind !== "thread" || tab.messageId !== requested) return state;
        const visible =
          tabPane(tab) === "main"
            ? state.mainSelected === id
            : state.selected === id && state.paneOpen;
        const restored = {
          ...state,
          tabs: state.tabs.map((item) =>
            item === tab ? { ...tab, messageId: kept } : item,
          ),
        };
        const next = withThread(
          restored,
          tab.channelId,
          requested,
          requested,
          "select",
          tabPane(tab),
        );
        return visible
          ? next
          : { ...next, ...snapshotOf(state), paneOpen: state.paneOpen };
      }),
    [update],
  );
  // Apply one history visit once. Thread visits select their thread; other
  // visits restore the tabs they last had. Nothing is ever closed.
  const enterVisit = useCallback(
    (
      visit: string,
      routed?: { channelId: string; messageId: string; rootId: string },
    ) =>
      update((state) => {
        if (state.visit === visit) return state;
        const visits = state.left ? state.visits : remember(state);
        const next: State = { ...state, visit, visits, left: false };
        if (routed)
          return withThread(
            next,
            routed.channelId,
            routed.messageId,
            routed.rootId,
            "select",
            threadPlacementPreference(),
          );
        const saved = visits?.[visit];
        return saved
          ? { ...next, ...saved }
          : { ...next, mainSelected: undefined };
      }),
    [update],
  );
  // Relocate one tab to a position within a pane's own order. The tab's
  // identity and mounted content are unchanged; only placement moves.
  const moveTab = useCallback(
    (id: string, pane: TabPane, index: number) =>
      update((state) => {
        const moving = state.tabs.find((tab) => tab.id === id);
        if (moving?.kind !== "thread") return state;
        const rest = state.tabs.filter((tab) => tab.id !== id);
        const inPane = rest.filter((tab) => tabPane(tab) === pane);
        const before = inPane[Math.max(0, index)];
        const placed = { ...moving, pane };
        const at = before ? rest.indexOf(before) : rest.length;
        const tabs = [...rest.slice(0, at), placed, ...rest.slice(at)];
        const left = tabPane(moving) !== pane;
        return {
          ...state,
          tabs,
          ...(pane === "main"
            ? {
                mainSelected: id,
                ...(left && state.selected === id ? { selected: "" } : {}),
              }
            : {
                selected: id,
                paneOpen: true,
                ...(left && state.mainSelected === id
                  ? { mainSelected: undefined }
                  : {}),
              }),
        };
      }),
    [update],
  );
  // Once a reader verifies its root, a tab opened from a wrong hint merges
  // into the tab already holding that thread instead of duplicating it.
  const resolveThreadRoot = useCallback(
    (id: string, rootId: string) =>
      update((state) => {
        const tab = state.tabs.find((item) => item.id === id);
        if (tab?.kind !== "thread" || tab.rootId === rootId) return state;
        const owner = state.tabs.find(
          (item) =>
            item.kind === "thread" &&
            item !== tab &&
            item.channelId === tab.channelId &&
            (item.rootId
              ? item.rootId === rootId
              : item.id === `thread:${tab.channelId}:${rootId}`),
        );
        if (owner?.kind !== "thread")
          return {
            ...state,
            tabs: state.tabs.map((item) =>
              item === tab ? { ...tab, rootId } : item,
            ),
          };
        const selected =
          tabPane(tab) === "main"
            ? state.mainSelected === tab.id
            : state.selected === tab.id;
        // Late identity evidence deduplicates, never overrides newer selection
        // or retargets another reader after the user has left this provisional tab.
        const foreground =
          selected && (tabPane(tab) === "main" || state.paneOpen);
        const merged = foreground
          ? { ...owner, messageId: tab.messageId, rootId }
          : owner;
        const tabs = state.tabs
          .filter((item) => item !== tab)
          .map((item) => (item === owner ? merged : item));
        if (!foreground)
          return {
            ...state,
            tabs,
            ...(selected
              ? { selected: tabPane(owner) === "side" ? owner.id : "" }
              : {}),
          };
        return tabPane(merged) === "main"
          ? {
              ...state,
              tabs,
              mainSelected: merged.id,
              ...(state.selected === tab.id ? { selected: "" } : {}),
            }
          : {
              ...state,
              tabs,
              selected: merged.id,
              paneOpen: true,
              ...(state.mainSelected === tab.id
                ? { mainSelected: undefined }
                : {}),
            };
      }),
    [update],
  );
  const selectMain = useCallback(
    (mainSelected: string | undefined) =>
      update((s) =>
        s.mainSelected === mainSelected ? s : { ...s, mainSelected },
      ),
    [update],
  );
  const select = useCallback(
    (selected: string) =>
      update((s) => ({
        ...s,
        selected,
        ...(selected ? { paneOpen: true } : {}),
      })),
    [update],
  );
  const setThread = useCallback(
    (thread: State["thread"]) =>
      update((s) =>
        s.thread?.channelId === thread?.channelId &&
        s.thread?.messageId === thread?.messageId
          ? s
          : { ...s, thread },
      ),
    [update],
  );
  const setSettings = useCallback(
    (settings: { channelId: string | undefined } | undefined) =>
      update((s) => ({
        ...s,
        settings: settings
          ? s.settings && s.settings.channelId === settings.channelId
            ? s.settings
            : { ...settings, id: crypto.randomUUID() }
          : undefined,
        ...(settings ? { selected: "settings", paneOpen: true } : {}),
      })),
    [update],
  );
  const setPaneOpen = useCallback(
    (paneOpen: boolean) => update((s) => ({ ...s, paneOpen })),
    [update],
  );
  // Workspace callbacks list this object as a dependency; a fresh object per
  // render would recreate them and re-render every memoized message row.
  return useMemo(
    () => ({
      ...state,
      setEntries,
      retireMenuEntries,
      setTabs,
      openThreadTab,
      moveTab,
      resolveThreadRoot,
      divertThread,
      enterVisit,
      leaveVisit,
      selectMain,
      select,
      setThread,
      setSettings,
      setPaneOpen,
    }),
    [
      state,
      setEntries,
      retireMenuEntries,
      setTabs,
      openThreadTab,
      moveTab,
      resolveThreadRoot,
      divertThread,
      enterVisit,
      leaveVisit,
      selectMain,
      select,
      setThread,
      setSettings,
      setPaneOpen,
    ],
  );
}
