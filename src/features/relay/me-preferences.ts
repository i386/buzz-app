import { removedSectionMessage } from "../sessions/workspace";
import type { ChannelKit } from "../channel-templates/capability";
import {
  kitRecordFits,
  meCapacityMessage,
  type Groups,
  type KitEntry,
} from "../channel-templates/model";
import { createSidebarPreferencesStore } from "./sidebar-preferences-store";
import type {
  SidebarAssignmentIntent,
  SidebarGroups,
} from "./sidebar-preferences";

export function meGroups(entries: readonly KitEntry[]) {
  return entries.find(
    (entry) =>
      entry.record.value.type === "groups" && entry.record.value.id === "me",
  );
}
function project(groups: Groups): SidebarGroups {
  return {
    sections: groups.groups.map(({ id, name }, order) => ({ id, name, order })),
    assignments: groups.assignments,
  };
}
const empty = (): Groups => ({
  type: "groups",
  id: "me",
  groups: [],
  assignments: {},
  channels: [],
});

// Object key order changes through native JSON maps. Only group/channel order
// is presentation data; assignment insertion order is not.
function comparable(value: Groups) {
  return JSON.stringify([
    value.id,
    value.groups.map(({ id, name, defaultTemplateId }) => [
      id,
      name,
      defaultTemplateId,
    ]),
    Object.entries(value.assignments).sort(([a], [b]) => a.localeCompare(b)),
    value.channels ?? [],
  ]);
}

function placed(
  value: Groups,
  id: string,
  personal: boolean,
  sectionId?: string,
) {
  if (sectionId && !value.groups.some((group) => group.id === sectionId))
    throw new Error(removedSectionMessage);
  const ids = value.channels ?? [];
  const assignments = { ...value.assignments };
  if (!personal) delete assignments[id];
  else if (sectionId) assignments[id] = sectionId;
  return {
    ...value,
    assignments,
    channels: personal
      ? ids.includes(id)
        ? ids
        : [...ids, id]
      : ids.filter((key) => key !== id),
  };
}
function admit(value: Groups, entry: KitEntry | undefined) {
  // With no saved record, one placement always fits. Existing records retain
  // their exact community envelope, including its UTF-8 byte cost.
  if (entry && !kitRecordFits({ ...entry.record, deleted: false, value }))
    throw new Error(meCapacityMessage);
}

/** Reuse recipe revision checks/outbox and preference lifecycle; never read Messages groups. */
export function createMePreferences(kit: ChannelKit, lifetime: AbortSignal) {
  let mutations = Promise.resolve();
  let generation = new AbortController();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const admitted = generation.signal;
    const next = mutations.then(() => {
      admitted.throwIfAborted();
      lifetime.throwIfAborted();
      return operation();
    });
    mutations = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  async function current(signal = lifetime, fresh = true) {
    const active = AbortSignal.any([lifetime, generation.signal, signal]);
    active.throwIfAborted();
    if (fresh || kit.snapshot().status !== "ready") await kit.refresh();
    active.throwIfAborted();
    const state = kit.snapshot();
    if (state.status !== "ready")
      throw new Error(state.error ?? "Me groups are unavailable");
    const entry = meGroups(state.entries);
    return {
      entry,
      value:
        entry && !entry.record.deleted && entry.record.value.type === "groups"
          ? entry.record.value
          : empty(),
      active,
    };
  }
  async function save(
    value: Groups,
    entry: KitEntry | undefined,
    active: AbortSignal,
  ) {
    admit(value, entry);
    await kit.save(value, entry?.eventId, false, active);
    active.throwIfAborted();
    const confirmed = meGroups(kit.snapshot().entries);
    if (
      !confirmed ||
      confirmed.record.deleted ||
      confirmed.record.value.type !== "groups" ||
      comparable(confirmed.record.value) !== comparable(value)
    )
      throw new Error("Me group changes could not be confirmed");
    return project(value);
  }
  const store = createSidebarPreferencesStore(
    async (signal) => ({
      ...project((await current(signal, false)).value),
      starred: [],
      muted: [],
    }),
    kit.available,
    (intent: SidebarAssignmentIntent, signal) =>
      serialize(async () => {
        const { value, entry, active } = await current(signal);
        const target = intent.createSection?.id ?? intent.sectionId;
        let groups = value.groups;
        if (intent.createSection) {
          const name = intent.createSection.name.trim();
          const existing = groups.find((group) => group.id === target);
          if (existing && existing.name !== name)
            throw new Error(
              "The new Me group changed; refresh before retrying",
            );
          if (!existing)
            groups = [
              ...groups,
              { id: intent.createSection.id, name, defaultTemplateId: "" },
            ];
        }
        if (target && !groups.some((group) => group.id === target))
          throw new Error("The Me group is unavailable");
        const assignments = { ...value.assignments };
        if (target) assignments[intent.channelId] = target;
        else delete assignments[intent.channelId];
        if (
          groups === value.groups &&
          value.assignments[intent.channelId] === target
        )
          return project(value);
        return save({ ...value, groups, assignments }, entry, active);
      }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (id, signal) =>
      serialize(async () => {
        const { value, entry, active } = await current(signal);
        if (!value.groups.some((group) => group.id === id))
          return project(value);
        return save(
          {
            ...value,
            groups: value.groups.filter((group) => group.id !== id),
            assignments: Object.fromEntries(
              Object.entries(value.assignments).filter(
                ([, group]) => group !== id,
              ),
            ),
          },
          entry,
          active,
        );
      }),
    true,
  );
  return {
    ...store,
    clear() {
      generation.abort();
      generation = new AbortController();
      store.clear();
    },
    dispose() {
      generation.abort();
      store.dispose();
    },
    placement: Object.freeze({
      available: kit.available,
      subscribe: kit.subscribe,
      snapshot: kit.snapshot,
      ensure: kit.ensure,
      refresh: kit.refresh,
      has(id: string) {
        const state = kit.snapshot();
        if (state.status !== "ready") return false;
        const entry = meGroups(state.entries);
        return (
          !entry?.record.deleted &&
          entry?.record.value.type === "groups" &&
          !!entry.record.value.channels?.includes(id)
        );
      },
      admit(
        id: string,
        options: { signal?: AbortSignal; sectionId?: string | undefined } = {},
      ) {
        return serialize(async () => {
          const { value, entry } = await current(options.signal);
          admit(placed(value, id, true, options.sectionId), entry);
        });
      },
      set(
        id: string,
        personal: boolean,
        options: { signal?: AbortSignal; sectionId?: string | undefined } = {},
      ) {
        return serialize(async () => {
          const { value, entry, active } = await current(options.signal);
          const next = placed(
            value,
            id,
            personal,
            personal ? options.sectionId : undefined,
          );
          if (comparable(next) === comparable(value)) return;
          await save(next, entry, active);
        });
      },
    }),
  };
}
