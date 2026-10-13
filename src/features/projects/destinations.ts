import type { EventData, ReadFilter } from "../relay/events";
import { newer } from "../relay/events";
import { ReadError, readErrorKind } from "../relay/errors";
import type { OpenFailure } from "../navigation/controller";
import { entityHex, gitHash, type EntityRoute } from "./routes";
import { ByteLru } from "../relay/budget";

export class EntityFailure extends Error {
  constructor(readonly reason: OpenFailure) {
    super(reason);
  }
}
export function entityFailure(error: unknown): OpenFailure {
  return error instanceof EntityFailure
    ? error.reason
    : error instanceof ReadError && error.status === 404
      ? "not-found"
      : readErrorKind(error) === "denied"
        ? "denied"
        : "unavailable";
}
export const values = (event: EventData, name: string) =>
  event.tags
    .filter((t) => t[0] === name)
    .map((t) => t[1])
    .filter((v): v is string => !!v);
export const value = (event: EventData, name: string) => values(event, name)[0];
export type Entity = {
  type: "repo" | "project";
  owner: string;
  dtag: string;
  address: string;
  name: string;
  description: string;
  event: EventData;
};
export type EntityDetail = {
  entity: Entity;
  repositories: Entity[];
  unavailableRepositories: string[];
  channels: string[];
  item?: EventData;
  status?: string;
  commit?: string;
  activity: EventData[];
  items: EventData[];
  /** The issue/PR list read reached its limit; items may be missing. */
  truncated?: boolean;
};
type Read = (
  filters: readonly ReadFilter[],
  signal: AbortSignal,
) => Promise<readonly EventData[]>;
export type ProjectHome =
  | { status: "none" | "ambiguous" }
  | { status: "home"; project: Entity };

export function entityFromEvent(event: EventData): Entity | undefined {
  const ds = values(event, "d");
  if (
    ![30617, 30621].includes(event.kind) ||
    ds.length !== 1 ||
    !metadataDtag(ds[0] ?? "") ||
    !entityHex.test(event.pubkey)
  )
    return;
  const dtag = ds[0];
  if (!dtag) return;
  if (event.kind === 30621) {
    const members = event.tags.filter((t) => t[0] === "a");
    if (
      members.length > 64 ||
      new Set(members.map((t) => t[1])).size !== members.length ||
      members.some(
        (t) =>
          t.length < 2 || t.length > 3 || !repositoryCoordinate(t[1] ?? ""),
      ) ||
      ["name", "description", "buzz-channel", "buzz-visibility"].some(
        (name) => values(event, name).length > 1,
      )
    )
      return;
  }
  return {
    type: event.kind === 30617 ? "repo" : "project",
    owner: event.pubkey,
    dtag,
    address: `${event.kind}:${event.pubkey}:${dtag}`,
    name: value(event, "name") ?? dtag,
    description:
      value(event, "description") ??
      (event.kind === 30621 ? "" : event.content),
    event,
  };
}
function metadataDtag(dtag: string) {
  return dtag.length > 0 && new TextEncoder().encode(dtag).length <= 1024;
}
function repositoryCoordinate(address: string) {
  const [kind, owner = "", ...parts] = address.split(":");
  const dtag = parts.join(":");
  return kind === "30617" && /^[a-f0-9]{64}$/.test(owner) && metadataDtag(dtag)
    ? { type: "repo" as const, owner, dtag }
    : undefined;
}
const singleValue = (event: EventData, name: string) => {
  const tags = event.tags.filter((t) => t[0] === name);
  return tags.length === 1 ? tags[0]?.[1] : undefined;
};
const related = (event: EventData, id: string) =>
  event.tags.some((t) => ["e", "E"].includes(t[0] ?? "") && t[1] === id);

/** Port of ACP `pick_authoritative_project_home` (buzz-acp `prompt_project.rs`).
 * A project's own `buzz-channel` is presentation only. It is authoritative when an
 * `a` member is a listed repository whose first `buzz-channel` is this channel and
 * whose owner or a maintainer signed the project. Callers fail closed on >1 match. */
export function authoritativeProjects(
  projects: readonly EventData[],
  repositories: readonly EventData[],
  channelId: string,
) {
  const listed = (event: EventData) =>
    !values(event, "buzz-visibility").includes("unlisted") &&
    entityHex.test(event.pubkey) &&
    !!value(event, "d")?.trim();
  const repos = new Map(
    repositories
      .filter(
        (event) =>
          event.kind === 30617 &&
          listed(event) &&
          value(event, "buzz-channel") === channelId,
      )
      .map((event) => [
        `${event.pubkey.toLowerCase()}:${value(event, "d")?.trim()}`,
        event.tags
          .filter((t) => t[0] === "maintainers")
          .flatMap((t) => t.slice(1).map((key) => key.toLowerCase())),
      ]),
  );
  return projects.filter((event) => {
    if (
      event.kind !== 30621 ||
      !listed(event) ||
      !values(event, "buzz-channel").includes(channelId)
    )
      return false;
    const signer = event.pubkey.toLowerCase();
    return values(event, "a").some((address) => {
      const [kind, owner = "", ...rest] = address.split(":");
      const key = `${owner.trim().toLowerCase()}:${rest.join(":").trim()}`;
      const maintainers = kind === "30617" && repos.get(key);
      return (
        !!maintainers &&
        (owner.trim().toLowerCase() === signer || maintainers.includes(signer))
      );
    });
  });
}

/** The host supplies verified, principal-bound reads. No feature can pick an origin or signer. */
export function projectDestinations(read: Read) {
  const homes = new ByteLru<ProjectHome>(64, 1024 * 1024);
  // A cancelled newer caller must not block a surviving read from retaining its result.
  const attempts = new Map<
    string,
    { next: number; completed: number; pending: number }
  >();
  let homeEpoch = 0;
  async function surviving(entities: Entity[], signal: AbortSignal) {
    if (!entities.length) return [];
    const authors = [...new Set(entities.map((entity) => entity.owner))];
    const events = await read(
      [
        {
          kinds: [5],
          authors,
          "#a": entities.map((entity) => entity.address),
          limit: 500,
        },
        {
          kinds: [5],
          authors,
          "#e": entities.map((entity) => entity.event.id),
          limit: 500,
        },
      ],
      signal,
    );
    if (events.length >= 500) throw new EntityFailure("unavailable");
    return entities.filter(
      (entity) =>
        !events.some(
          (e) =>
            e.kind === 5 &&
            e.pubkey === entity.owner &&
            (values(e, "e").includes(entity.event.id) ||
              (values(e, "a").includes(entity.address) &&
                e.created_at >= entity.event.created_at)),
        ),
    );
  }
  async function coordinate(
    route: Pick<EntityRoute, "type" | "owner" | "dtag">,
    signal: AbortSignal,
  ) {
    const kind = route.type === "project" ? 30621 : 30617;
    const events = await read(
      [{ kinds: [kind], authors: [route.owner], "#d": [route.dtag], limit: 1 }],
      signal,
    );
    const event = events
      .filter(
        (e) =>
          e.kind === kind &&
          e.pubkey === route.owner &&
          values(e, "d").length === 1 &&
          value(e, "d") === route.dtag,
      )
      .reduce<EventData | undefined>((head, e) => newer(head, e), undefined);
    const entity = event && entityFromEvent(event);
    if (!entity || !(await surviving([entity], signal)).length)
      throw new EntityFailure("not-found");
    return entity;
  }
  return {
    peekHome: (channelId: string) => homes.peek(channelId),
    clearHomes() {
      homeEpoch++;
      attempts.clear();
      homes.clear();
    },
    /** Only a complete read is evidence of "none"; a capped read throws. */
    async home(channelId: string, signal: AbortSignal): Promise<ProjectHome> {
      signal.throwIfAborted();
      const attemptsForChannel = attempts.get(channelId) ?? {
        next: 0,
        completed: 0,
        pending: 0,
      };
      const attempt = ++attemptsForChannel.next;
      attemptsForChannel.pending++;
      const epoch = homeEpoch;
      attempts.set(channelId, attemptsForChannel);
      try {
        const events = await read(
          [30621, 30617].map((kind) => ({
            kinds: [kind],
            "#buzz-channel": [channelId],
            limit: 100,
          })),
          signal,
        );
        if (
          [30621, 30617].some(
            (kind) => events.filter((e) => e.kind === kind).length >= 100,
          )
        )
          throw new EntityFailure("unavailable");
        const heads = new Map<string, EventData>();
        for (const event of events) {
          const address = `${event.kind}:${event.pubkey}:${value(event, "d")}`;
          heads.set(address, newer(heads.get(address), event));
        }
        const matches = authoritativeProjects(
          [...heads.values()],
          [...heads.values()],
          channelId,
        ).map(entityFromEvent);
        // ACP would still name it; Projects cannot open it, so fail visibly.
        if (matches.some((project) => !project))
          throw new EntityFailure("unavailable");
        // Stricter than ACP: an owner-deleted project is not a home here.
        const [project, ...others] = await surviving(
          matches as Entity[],
          signal,
        );
        const result: ProjectHome = !project
          ? { status: "none" }
          : others.length
            ? { status: "ambiguous" }
            : { status: "home", project };
        signal.throwIfAborted();
        if (epoch !== homeEpoch)
          throw new DOMException("Project cache cleared", "AbortError");
        if (attempt > attemptsForChannel.completed) {
          attemptsForChannel.completed = attempt;
          homes.set(channelId, result);
        }
        return result;
      } catch (error) {
        if (
          !signal.aborted &&
          epoch === homeEpoch &&
          attempt > attemptsForChannel.completed
        ) {
          attemptsForChannel.completed = attempt;
          homes.delete(channelId);
        }
        throw error;
      } finally {
        if (
          --attemptsForChannel.pending === 0 &&
          attempts.get(channelId) === attemptsForChannel
        )
          attempts.delete(channelId);
      }
    },
    async list(signal: AbortSignal) {
      const events = await read(
        [{ kinds: [30617, 30621], limit: 100 }],
        signal,
      );
      const heads = new Map<string, Entity>();
      for (const event of events) {
        const entity = entityFromEvent(event);
        if (entity && newer(heads.get(entity.address)?.event, event) === event)
          heads.set(entity.address, entity);
      }
      // Discovery is deliberately finite; direct links resolve their coordinate independently.
      return surviving(
        [...heads.values()].filter(
          (entity) => value(entity.event, "buzz-visibility") !== "unlisted",
        ),
        signal,
      );
    },
    async load(route: EntityRoute, signal: AbortSignal): Promise<EntityDetail> {
      const entity = await coordinate(route, signal);
      const repositories: Entity[] = entity.type === "repo" ? [entity] : [];
      const unavailableRepositories: string[] = [];
      if (entity.type === "project") {
        for (const address of values(entity.event, "a").sort()) {
          const member = repositoryCoordinate(address);
          if (!member) throw new EntityFailure("unavailable");
          try {
            repositories.push(await coordinate(member, signal));
          } catch (error) {
            signal.throwIfAborted();
            if (
              entityFailure(error) !== "not-found" &&
              entityFailure(error) !== "denied"
            )
              throw error;
            unavailableRepositories.push(address);
          }
        }
      }
      const channels = [
        ...new Set(
          [entity, ...repositories].flatMap((e) => [
            ...values(e.event, "buzz-channel"),
            ...values(e.event, "buzz-related-channel"),
          ]),
        ),
      ];
      const result: EntityDetail = {
        entity,
        repositories,
        unavailableRepositories,
        channels,
        activity: [],
        items: [],
      };
      if ("id" in route) {
        const kind = route.type === "pr" ? 1618 : 1621;
        const events = await read(
          [{ ids: [route.id], kinds: [kind], limit: 1 }],
          signal,
        );
        const item = events.find(
          (e) =>
            e.id === route.id &&
            e.kind === kind &&
            values(e, "a").includes(entity.address),
        );
        if (!item) throw new EntityFailure("not-found");
        const activity = await read(
          [
            {
              kinds: [1, 1111, 1619, 1630, 1631, 1632, 1633, 5],
              "#e": [item.id],
              limit: 500,
            },
            {
              kinds: [1, 1111, 1619, 1630, 1631, 1632, 1633],
              "#E": [item.id],
              limit: 500,
            },
          ],
          signal,
        );
        if (activity.length >= 500) throw new EntityFailure("unavailable");
        if (
          activity.some(
            (e) =>
              e.kind === 5 &&
              e.pubkey === item.pubkey &&
              values(e, "e").includes(item.id),
          )
        )
          throw new EntityFailure("not-found");
        const statusAuthors = new Set([
          item.pubkey,
          entity.owner,
          ...entity.event.tags
            .filter((t) => t[0] === "maintainers")
            .flatMap((t) => t.slice(1))
            .filter((key) => entityHex.test(key)),
        ]);
        const update = activity
          .filter(
            (e) =>
              e.kind === 1619 &&
              singleValue(e, "E") === item.id &&
              singleValue(e, "P") === item.pubkey &&
              singleValue(e, "a") === entity.address &&
              gitHash.test(singleValue(e, "c") ?? "") &&
              e.tags.some(
                (t) => t[0] === "clone" && t.slice(1).some((url) => url.trim()),
              ) &&
              e.pubkey === item.pubkey,
          )
          .reduce<EventData | undefined>(
            (head, e) => newer(head, e),
            undefined,
          );
        const commit = singleValue(update ?? item, "c");
        if (route.type === "pr" && commit && gitHash.test(commit))
          result.commit = commit.toLowerCase();
        const status = activity
          .filter((e) => {
            const roots = e.tags.filter((t) => t[0] === "e" && t[3] === "root");
            return (
              e.kind >= 1630 &&
              e.kind <= 1633 &&
              roots.length === 1 &&
              roots[0]?.[1] === item.id &&
              e.tags
                .filter((t) => t[0] === "a")
                .every((t) => t[1] === entity.address) &&
              statusAuthors.has(e.pubkey)
            );
          })
          .reduce<EventData | undefined>(
            (head, e) => newer(head, e),
            undefined,
          );
        result.item = item;
        result.status = status
          ? ((
              {
                1630: "Open",
                1631: route.type === "pr" ? "Merged" : "Done",
                1632: "Closed",
                1633: "Draft",
              } as Record<number, string>
            )[status.kind] ?? "Open")
          : values(item, "t").some((label) => label.toLowerCase() === "draft")
            ? "Draft"
            : "Open";
        result.activity = [
          ...new Map(
            activity
              .filter((e) => [1, 1111].includes(e.kind) && related(e, item.id))
              .map((e) => [e.id, e]),
          ).values(),
        ].sort(
          (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
        );
      } else if (route.tab === "prs" || route.tab === "issues") {
        if (repositories.length) {
          const kind = route.tab === "prs" ? 1618 : 1621;
          const addresses = repositories.map((repo) => repo.address);
          const events = await read(
            [{ kinds: [kind], "#a": addresses, limit: 100 }],
            signal,
          );
          result.truncated = events.length >= 100;
          result.items = events.filter(
            (e) =>
              e.kind === kind &&
              values(e, "a").some((a) => addresses.includes(a)),
          );
        }
      }
      signal.throwIfAborted();
      return result;
    },
  };
}
