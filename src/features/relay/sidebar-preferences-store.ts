import type { HeadPersistence } from "./persistence";
import { projectSidebarPreferences } from "./sidebar-preferences";
import type {
  SidebarAssignmentMutator,
  SidebarAssignmentIntent,
  SidebarSectionRemovalMutator,
  SidebarStarMutator,
  SidebarMuteMutator,
  SidebarPreferences,
  SidebarSortMode,
  SidebarSortMutator,
} from "./sidebar-preferences";

type MoveDestination =
  | { starred: true }
  | Omit<SidebarAssignmentIntent, "channelId">;
type MoveIntent = Readonly<{
  id: number;
  channelId: string;
  destination: MoveDestination;
}>;
type MoveFailure = MoveIntent & Readonly<{ error: string }>;
type SortFailure = Readonly<{
  group: string;
  mode: SidebarSortMode;
  error: string;
}>;
type Snapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error" | "unsupported";
  data?: SidebarPreferences;
  error?: string;
  cached?: true;
  sortErrors?: readonly SortFailure[];
  moves?: readonly (MoveIntent & { pending: boolean; error?: string })[];
}>;

/** One bounded account-preference projection per relay session, not per page. */
export function createSidebarPreferencesStore(
  read: (signal?: AbortSignal) => Promise<SidebarPreferences>,
  available: boolean,
  write?: SidebarAssignmentMutator,
  writeStar?: SidebarStarMutator,
  notify = (listener: () => void) => listener(),
  writeMute?: SidebarMuteMutator,
  writeSort?: SidebarSortMutator,
  persistence?: HeadPersistence,
  removeSection?: SidebarSectionRemovalMutator,
  /** Me groups have no Star coordinate; do not write Messages stars on moves. */
  groupsOnly = false,
) {
  const listeners = new Set<() => void>();
  const empty = (): Snapshot =>
    Object.freeze({ status: available ? "idle" : "unsupported" });
  let snapshot = empty();
  let closed = false;
  let active:
    | { controller: AbortController; promise: Promise<void> }
    | undefined;
  let writeQueue = Promise.resolve();
  let writeLifetime = new AbortController();
  let mutation = 0;
  let confirmed: SidebarPreferences | undefined;
  let readFailure: string | undefined;
  const writable = () =>
    !closed &&
    !!confirmed &&
    readFailure === undefined &&
    !!write &&
    (groupsOnly || !!writeStar);
  let nextMove = 0;
  const pendingMoves = new Map<number, MoveIntent>();
  const failedMoves = new Map<string, MoveFailure>();
  const latestMove = new Map<string, number>();
  const withPendingMoves = (data: SidebarPreferences): SidebarPreferences => {
    let sections = data.sections;
    const assignments = { ...data.assignments };
    const starred = new Set(data.starred);
    for (const { channelId, destination } of pendingMoves.values()) {
      if ("starred" in destination) starred.add(channelId);
      else {
        starred.delete(channelId);
        const created = destination.createSection;
        if (created && !sections.some(({ id }) => id === created.id))
          sections = [
            ...sections,
            {
              ...created,
              name: created.name.trim(),
              order: Math.max(-1, ...sections.map(({ order }) => order)) + 1,
            },
          ];
        const target = created?.id ?? destination.sectionId;
        if (target) assignments[channelId] = target;
        else delete assignments[channelId];
      }
    }
    return { ...data, sections, assignments, starred: [...starred] };
  };
  let generation = 0;
  let nextSortMutation = 0;
  const latestSort = new Map<string, number>();
  const failedSorts = new Map<string, SortFailure>();
  const pendingSorts = new Map<
    number,
    { group: string; mode: SidebarSortMode }
  >();
  const withSort = (
    sort: Readonly<Record<string, SidebarSortMode>>,
    group: string,
    mode: SidebarSortMode,
  ) => {
    const next = { ...sort };
    if (mode === "alpha") delete next[group];
    else next[group] = mode;
    return next;
  };
  const withPendingSorts = (
    sort: Readonly<Record<string, SidebarSortMode>>,
  ) => {
    let next = sort;
    for (const pending of pendingSorts.values())
      next = withSort(next, pending.group, pending.mode);
    return next;
  };

  const retained = (data: SidebarPreferences): SidebarPreferences =>
    Object.freeze({
      sections: Object.freeze(
        data.sections.map((section) => Object.freeze({ ...section })),
      ),
      assignments: Object.freeze({ ...data.assignments }),
      starred: Object.freeze([...data.starred]),
      muted: Object.freeze([...data.muted]),
      ...(data.sort ? { sort: Object.freeze({ ...data.sort }) } : {}),
    });
  const publish = (next: Snapshot) => {
    const { moves: _moves, sortErrors: _errors, ...state } = next;
    const moves = [
      ...Array.from(pendingMoves.values(), (intent) => ({
        ...intent,
        pending: true,
      })),
      ...Array.from(failedMoves.values(), (intent) => ({
        ...intent,
        pending: false,
      })),
    ];
    snapshot = Object.freeze({
      ...state,
      ...(failedSorts.size
        ? { sortErrors: Object.freeze([...failedSorts.values()]) }
        : {}),
      ...(moves.length ? { moves: Object.freeze(moves) } : {}),
    });
    for (const listener of listeners) notify(listener);
  };
  // Both optimistic families overlay one confirmed snapshot. A completion only
  // replaces its own fields; mute stays confirmed-only for notification policy.
  const project = () => {
    if (!confirmed) return;
    void persistence
      ?.writeStartup?.({
        preferences: { savedAt: Date.now(), data: confirmed },
      })
      .catch(() => {});
    publish({
      // A field-only confirmation cannot recover a failed full read. Any
      // concurrent read made stale by a write must leave recovery available.
      ...(readFailure === undefined
        ? { status: "ready" as const }
        : { status: "error" as const, error: readFailure }),
      data: retained(
        withPendingMoves(
          pendingSorts.size
            ? { ...confirmed, sort: withPendingSorts(confirmed.sort ?? {}) }
            : confirmed,
        ),
      ),
    });
  };
  function refresh(): Promise<void> {
    if (closed || !available) return Promise.resolve();
    if (pendingMoves.size) {
      const refreshGeneration = generation;
      return writeQueue.then(() => {
        if (!closed && generation === refreshGeneration) return refresh();
      });
    }
    if (active) return active.promise;
    const controller = new AbortController();
    const refreshMutation = mutation;
    const job = { controller, promise: Promise.resolve() };
    active = job;
    job.promise = Promise.resolve().then(async () => {
      if (closed || controller.signal.aborted) return;
      try {
        const data = await read(controller.signal);
        if (
          closed ||
          controller.signal.aborted ||
          active !== job ||
          mutation !== refreshMutation
        )
          return;
        readFailure = undefined;
        confirmed = data;
        project();
      } catch (error) {
        if (
          !closed &&
          !controller.signal.aborted &&
          active === job &&
          mutation === refreshMutation
        ) {
          readFailure = error instanceof Error ? error.message : String(error);
          publish({
            ...snapshot,
            status: "error",
            error: readFailure,
          });
        }
      } finally {
        if (active === job) active = undefined;
      }
    });
    publish({
      status: "loading",
      ...(snapshot.cached ? { cached: true as const } : {}),
      ...(snapshot.data ? { data: snapshot.data } : {}),
    });
    return job.promise;
  }
  function rejectMove(channelId: string, message: string): Promise<never> {
    const failed = failedMoves.get(channelId);
    if (failed) {
      failedMoves.set(channelId, { ...failed, error: message });
      publish(snapshot);
    }
    return Promise.reject(new Error(message));
  }
  // Optimistic placement is a projection over confirmed data. Persistence keeps
  // assignment/create before Star removal. A failed
  // older intent cannot undo a later move or replace its retry state.
  function move(
    channelId: string,
    destination: MoveDestination,
    signal?: AbortSignal,
  ): Promise<SidebarPreferences> {
    if (
      !writable() ||
      !snapshot.data ||
      !confirmed ||
      !write ||
      (!writeStar && !groupsOnly) ||
      (groupsOnly && "starred" in destination)
    )
      return rejectMove(
        channelId,
        "Sidebar group moves are unavailable; refresh saved sidebar preferences before retrying",
      );
    const writeGeneration = generation;
    const writeSignal = AbortSignal.any([
      writeLifetime.signal,
      ...(signal ? [signal] : []),
    ]);
    if (writeSignal.aborted) return Promise.reject(writeSignal.reason);
    const intent: MoveIntent = { id: ++nextMove, channelId, destination };
    pendingMoves.set(intent.id, intent);
    latestMove.set(channelId, intent.id);
    failedMoves.delete(channelId);
    mutation++;
    const check = () => {
      if (closed || generation !== writeGeneration)
        throw new Error("Sidebar group moves are unavailable");
      writeSignal.throwIfAborted();
    };
    const run = writeQueue
      .catch(() => {})
      .then(async () => {
        try {
          check();
          const starring = "starred" in destination;
          // Always check the fresh assignment head on removal, even if cached
          // placement has no assignment. Another device may have changed it.
          const groups = starring
            ? undefined
            : await write({ channelId, ...destination }, writeSignal);
          check();
          const stars =
            !groupsOnly && writeStar
              ? await writeStar({ channelId, starred: starring }, writeSignal)
              : [];
          check();
          if (!confirmed)
            throw new Error("Sidebar group moves are unavailable");
          confirmed = {
            ...confirmed,
            ...(groups
              ? { sections: groups.sections, assignments: groups.assignments }
              : {}),
            starred: stars,
          };
          return retained(confirmed);
        } catch (error) {
          if (
            !closed &&
            generation === writeGeneration &&
            !writeSignal.aborted &&
            latestMove.get(channelId) === intent.id
          )
            failedMoves.set(channelId, {
              ...intent,
              error: error instanceof Error ? error.message : String(error),
            });
          throw error;
        } finally {
          if (!closed && generation === writeGeneration) {
            mutation++;
            pendingMoves.delete(intent.id);
            project();
          }
        }
      });
    writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    project();
    return run;
  }
  async function removeSectionMutation(
    sectionId: string,
    signal?: AbortSignal,
  ) {
    if (
      closed ||
      !confirmed ||
      readFailure !== undefined ||
      snapshot.cached ||
      !removeSection ||
      !writeSort
    )
      throw new Error("Sidebar section removal is unavailable");
    const writeGeneration = generation;
    const writeSignal = AbortSignal.any([
      writeLifetime.signal,
      ...(signal ? [signal] : []),
    ]);
    writeSignal.throwIfAborted();
    mutation++;
    const run = writeQueue
      .catch(() => {})
      .then(async () => {
        if (closed || generation !== writeGeneration)
          throw new Error("Sidebar section removal is unavailable");
        writeSignal.throwIfAborted();
        if (!confirmed?.sections.some(({ id }) => id === sectionId))
          throw new Error("Sidebar section no longer exists");
        const group = `section:${sectionId}`;
        // Local Alpha can be stale while another device has saved an override.
        // Reset while the section is live, so a failed write leaves removal
        // retryable and cannot strand a live override beyond the decoder cap.
        const sort = await writeSort(
          group,
          "alpha",
          confirmed.sections.map(({ id }) => id),
          writeSignal,
        );
        if (closed || generation !== writeGeneration)
          throw new Error("Sidebar section removal is unavailable");
        writeSignal.throwIfAborted();
        if (!confirmed)
          throw new Error("Sidebar section removal is unavailable");
        confirmed = { ...confirmed, sort };
        mutation++;
        project();
        const next = await removeSection(sectionId, writeSignal);
        if (closed || generation !== writeGeneration || !confirmed)
          throw new Error("Sidebar section removal is unavailable");
        writeSignal.throwIfAborted();
        mutation++;
        confirmed = {
          ...confirmed,
          sections: next.sections,
          assignments: next.assignments,
        };
        project();
        return retained(confirmed);
      })
      .catch((error) => {
        if (!closed && generation === writeGeneration) {
          mutation++;
          project();
        }
        throw error;
      });
    writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  const restoreGeneration = generation;
  const ready = persistence
    ?.readStartup?.()
    .then((saved) => {
      if (
        closed ||
        generation !== restoreGeneration ||
        confirmed ||
        snapshot.status === "ready"
      )
        return;
      const value = saved?.preferences;
      if (
        !value ||
        !Number.isFinite(value.savedAt) ||
        value.savedAt > Date.now() ||
        Date.now() - value.savedAt > 86_400_000
      )
        return;
      const data = value.data;
      const rows = (ids: readonly string[], flag: string) => ({
        version: 1,
        channels: Object.fromEntries(
          ids.map((id) => [id, { [flag]: true, updatedAt: 0 }]),
        ),
      });
      const parsed = projectSidebarPreferences(
        { version: 1, sections: data.sections, assignments: data.assignments },
        rows(data.starred, "starred"),
        rows(data.muted, "muted"),
        { version: 1, groups: data.sort ?? {} },
      );
      // Display-only: do not initialize the confirmed mutation base from disk.
      publish({
        ...snapshot,
        cached: true,
        data: retained(parsed),
      });
    })
    .catch(() => {});
  return {
    ready,
    queries: Object.freeze({
      available,
      get sectionRemovalWritable() {
        return groupsOnly
          ? writable() && !snapshot.cached && !!removeSection
          : this.removeSectionWritable;
      },
      removeSection(sectionId: string, callerSignal?: AbortSignal) {
        if (!groupsOnly) return removeSectionMutation(sectionId, callerSignal);
        if (!writable() || snapshot.cached || !removeSection)
          return Promise.reject(new Error("Section deletion is unavailable"));
        const writeGeneration = generation;
        const signal = writeLifetime.signal;
        const run = writeQueue
          .catch(() => {})
          .then(async () => {
            signal.throwIfAborted();
            if (closed || generation !== writeGeneration)
              throw new Error("Section deletion is unavailable");
            const groups = await removeSection(sectionId, signal);
            signal.throwIfAborted();
            if (closed || generation !== writeGeneration || !confirmed)
              throw new Error("Section deletion is unavailable");
            mutation++;
            confirmed = { ...confirmed, ...groups };
            project();
          });
        writeQueue = run.catch(() => {});
        return run;
      },
      dismissSortError(group: string) {
        failedSorts.delete(group);
        publish(snapshot);
      },
      get sortWritable() {
        return !!writeSort && !snapshot.cached;
      },
      setSort(
        group: string,
        mode: SidebarSortMode,
        sectionIds: readonly string[],
        signal?: AbortSignal,
      ) {
        if (closed || !writeSort || !snapshot.data || snapshot.cached)
          return Promise.reject(
            new Error("Sidebar sorting is read-only in this host"),
          );
        const writeGeneration = generation;
        const writeSignal = AbortSignal.any([
          writeLifetime.signal,
          ...(signal ? [signal] : []),
        ]);
        if (writeSignal.aborted) return Promise.reject(writeSignal.reason);
        const id = ++nextSortMutation;
        pendingSorts.set(id, { group, mode });
        latestSort.set(group, id);
        failedSorts.delete(group);
        mutation++;
        project();
        const settle = (sort?: Readonly<Record<string, SidebarSortMode>>) => {
          if (closed || generation !== writeGeneration || !confirmed) return;
          confirmed = {
            ...confirmed,
            sort: { ...(sort ?? confirmed.sort ?? {}) },
          };
          pendingSorts.delete(id);
          project();
        };
        const run = writeQueue
          .catch(() => {})
          .then(async () => {
            if (closed || generation !== writeGeneration)
              throw new Error("Sidebar sorting is unavailable");
            try {
              writeSignal.throwIfAborted();
              const sort = await writeSort(
                group,
                mode,
                sectionIds,
                writeSignal,
              );
              if (closed || generation !== writeGeneration)
                throw new Error("Sidebar sorting is unavailable");
              writeSignal.throwIfAborted();
              mutation++;
              settle(sort);
              return sort;
            } catch (error) {
              if (!closed && generation === writeGeneration) {
                mutation++;
                if (!writeSignal.aborted && latestSort.get(group) === id)
                  failedSorts.set(group, {
                    group,
                    mode,
                    error:
                      error instanceof Error ? error.message : String(error),
                  });
              }
              settle();
              throw error;
            }
          });
        writeQueue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
      get muteWritable() {
        return !!writeMute && !snapshot.cached;
      },
      setMute(channelId: string, muted: boolean, signal?: AbortSignal) {
        if (closed || !writeMute || !snapshot.data || snapshot.cached)
          return Promise.reject(
            new Error("Sidebar mutes are unavailable in this host"),
          );
        const writeGeneration = generation;
        const writeSignal = AbortSignal.any([
          writeLifetime.signal,
          ...(signal ? [signal] : []),
        ]);
        const run = writeQueue
          .catch(() => {})
          .then(async () => {
            if (closed || generation !== writeGeneration)
              throw new Error("Sidebar mutes are unavailable");
            writeSignal.throwIfAborted();
            const mutes = await writeMute({ channelId, muted }, writeSignal);
            if (closed || generation !== writeGeneration)
              throw new Error("Sidebar mutes are unavailable");
            writeSignal.throwIfAborted();
            const current = confirmed;
            if (!current) throw new Error("Sidebar mutes are unavailable");
            mutation++;
            confirmed = { ...current, muted: [...mutes] };
            project();
            return mutes;
          });
        writeQueue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },

      retryMove(channelId: string) {
        const failed = failedMoves.get(channelId);
        return failed
          ? move(channelId, failed.destination)
          : Promise.reject(new Error("No failed move to retry"));
      },
      dismissMoveError(channelId: string) {
        failedMoves.delete(channelId);
        publish(snapshot);
      },
      get writable() {
        return writable();
      },
      assign(channelId: string, sectionId?: string, signal?: AbortSignal) {
        return move(channelId, sectionId ? { sectionId } : {}, signal);
      },
      createAndAssign(
        channelId: string,
        section: { id: string; name: string },
        signal?: AbortSignal,
      ) {
        return move(channelId, { createSection: section }, signal);
      },
      get removeSectionWritable() {
        return (
          !closed &&
          !!confirmed &&
          readFailure === undefined &&
          !snapshot.cached &&
          !!removeSection &&
          !!writeSort
        );
      },
      get starWritable() {
        return !groupsOnly && writable();
      },
      async setStar(channelId: string, starred: boolean, signal?: AbortSignal) {
        const data = await move(
          channelId,
          starred ? { starred: true } : {},
          signal,
        );
        return data.starred;
      },
      // Keep explicit one-shot reads compatible; views use the retained snapshot.
      read,
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        if (closed) return () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      ensure: () =>
        snapshot.status === "idle"
          ? refresh()
          : (active?.promise ?? Promise.resolve()),
      refresh,
    }),
    clear() {
      if (closed) return;
      generation++;
      confirmed = undefined;
      pendingSorts.clear();
      latestSort.clear();
      failedSorts.clear();
      readFailure = undefined;
      pendingMoves.clear();
      failedMoves.clear();
      latestMove.clear();
      mutation++;
      writeLifetime.abort();
      writeLifetime = new AbortController();
      active?.controller.abort();
      active = undefined;
      publish(empty());
    },
    dispose() {
      closed = true;
      writeLifetime.abort();
      generation++;
      confirmed = undefined;
      pendingSorts.clear();
      latestSort.clear();
      failedSorts.clear();
      readFailure = undefined;
      pendingMoves.clear();
      failedMoves.clear();
      latestMove.clear();
      mutation++;
      active?.controller.abort();
      active = undefined;
      snapshot = empty();
      listeners.clear();
    },
  };
}
