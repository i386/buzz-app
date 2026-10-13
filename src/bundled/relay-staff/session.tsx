import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type DependencyList,
} from "react";
import type {
  AttachmentRef,
  ProbeDto,
  SaveResult,
  StaffContext,
  StaffFailure,
  StaffOutcome,
  StaffRequest,
  StaffResults,
} from "../../features/relay-staff/contract";
import type { Staff } from "./staff";
import type { Held, Writes } from "./writes";

export type Session = {
  staff: Staff;
  context: StaffContext;
  probe: ProbeDto;
  /** False when the relay runs with admin auth disabled: the console is read-only. */
  canMutate: boolean;
  isOperator: boolean;
  /** Writes for this context; see `Staff.writes`. */
  writes: Writes;
  request<R extends StaffRequest>(
    request: R,
  ): Promise<StaffOutcome<StaffResults[R["route"]]>>;
  attachment(ref: AttachmentRef): Promise<StaffOutcome<Uint8Array>>;
  saveAttachment(ref: AttachmentRef): Promise<SaveResult>;
};

const SessionContext = createContext<Session | null>(null);
export const SessionProvider = SessionContext.Provider;

export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error("Relay staff session is missing");
  return session;
}

/**
 * Every signed operation goes through here, so a 401 or 403 from any of them
 * re-checks the role in the background while Settings is open (see
 * `Staff.reprobe`). An unchanged role keeps the session, so it cannot loop.
 */
export function createSession(
  staff: Staff,
  context: StaffContext,
  probe: ProbeDto,
): Session {
  const checked = (failure: StaffFailure | null) => {
    if (failure?.authLost) staff.reprobe(context);
  };
  return {
    staff,
    context,
    probe,
    writes: staff.writes(context),
    canMutate: probe.authMode === "nip98",
    isOperator: probe.role === "operator",
    async request(request) {
      const outcome = await staff.backend.request(context, request);
      checked(outcome.ok ? null : outcome.failure);
      return outcome;
    },
    async attachment(ref) {
      const outcome = await staff.backend.attachment(context, ref);
      checked(outcome.ok ? null : outcome.failure);
      return outcome;
    },
    async saveAttachment(ref) {
      const result = await staff.backend.saveAttachment(context, ref);
      checked(result.state === "failed" ? result.failure : null);
      return result;
    },
  };
}

export type Read<T> =
  | { state: "loading" }
  | { state: "ok"; value: T }
  | { state: "failed"; failure: StaffFailure };

/**
 * One read, tied to the session and `deps`. A response that arrives after the
 * session, community or query changed (or after unmount) is dropped.
 */
export function useRead<R extends StaffRequest>(
  request: R | null,
  deps: DependencyList,
) {
  const { request: send } = useSession();
  const [read, setRead] = useState<Read<StaffResults[R["route"]]>>({
    state: "loading",
  });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` describe `request`
  useEffect(() => {
    if (!request) return;
    let current = true;
    setRead({ state: "loading" });
    void send(request).then((outcome) => {
      if (!current) return;
      setRead(
        outcome.ok
          ? { state: "ok", value: outcome.value }
          : { state: "failed", failure: outcome.failure },
      );
    });
    return () => {
      current = false;
    };
  }, [send, attempt, ...deps]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return [read, reload] as const;
}

/** Plain-language text for a failed request. */
export function describe(failure: StaffFailure) {
  switch (failure.category) {
    case "unauthorized":
      return "The relay did not accept your signature.";
    case "forbidden":
      return failure.message || "You do not have permission to do that.";
    case "intercepted":
      return "A network gateway (such as VPN or SSO) intercepted the request.";
    case "ambiguous":
      return `The relay did not confirm the result. ${failure.message}`.trim();
    default:
      return failure.message;
  }
}

/**
 * The write held under `key` for this session's context (see `Writes`). Its
 * request, `sending` state and last outcome live in the store, so a view
 * opened while the write is in flight, or after it settled, shows the truth.
 * `onDone` runs in whichever view is open when an attempt finishes (or the
 * next one to open), exactly once per attempt.
 */
export function useWrite<R extends StaffRequest, M = unknown>(
  key: string,
  onDone?: (outcome: StaffOutcome<StaffResults[R["route"]]>, sent: R) => void,
) {
  const { request: send, writes } = useSession();
  const held = useSyncExternalStore(writes.subscribe, () =>
    writes.get(key),
  ) as Held<R, M> | null;
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!held?.unseen || !done.current) return;
    const seen = writes.see(key) as Held<R, M> | null;
    if (seen?.outcome && seen.sent)
      done.current(
        seen.outcome as StaffOutcome<StaffResults[R["route"]]>,
        seen.sent,
      );
  }, [held, key, writes]);
  return {
    held,
    frozen: held?.request ?? null,
    busy: held?.sending ?? false,
    /** Resends the held request; `fresh` only starts a new one. */
    run: (fresh?: R) => void writes.run(key, send, fresh),
    freeze: (request: R, meta: M) => writes.freeze(key, request, meta),
    discard: () => writes.discard(key),
  };
}

type Paged = Extract<
  StaffRequest,
  { route: "listCommunities" } | { route: "listRestrictions" }
>;
type Pages<R extends Paged> = {
  items: StaffResults[R["route"]]["items"];
  next: string | null;
  loading: boolean;
  failure: StaffFailure | null;
};

/**
 * Cursor pages for `page(cursor)`, restarted whenever `deps` change. A page
 * that arrives after a restart (or unmount) is dropped.
 */
export function usePages<R extends Paged>(
  page: ((cursor?: string) => R) | null,
  deps: DependencyList,
) {
  const { request: send } = useSession();
  const empty = { items: [], next: null, failure: null };
  const [pages, setPages] = useState<Pages<R>>({ ...empty, loading: true });
  const generation = useRef(0);
  const pageRef = useRef(page);
  pageRef.current = page;
  const load = async (cursor: string | undefined, at: number) => {
    const make = pageRef.current;
    if (!make) return;
    setPages((current) => ({ ...current, loading: true, failure: null }));
    const outcome = await send(make(cursor));
    if (at !== generation.current) return;
    setPages((current) =>
      outcome.ok
        ? {
            items: [
              ...(cursor ? current.items : []),
              ...outcome.value.items,
            ] as Pages<R>["items"],
            next: outcome.value.nextCursor,
            loading: false,
            failure: null,
          }
        : { ...current, loading: false, failure: outcome.failure },
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` describe `page`
  useEffect(() => {
    const at = ++generation.current;
    setPages({ ...empty, loading: !!pageRef.current });
    void load(undefined, at);
    return () => {
      generation.current++;
    };
  }, [send, ...deps]);
  const more = () => {
    if (pages.next && !pages.loading) void load(pages.next, generation.current);
  };
  const restart = () => {
    const at = ++generation.current;
    void load(undefined, at);
  };
  return { ...pages, more, restart };
}
