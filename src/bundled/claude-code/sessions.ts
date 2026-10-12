// One agent's Claude sessions: one per conversation (a thread, or a whole DM),
// each continuing across messages and app restarts. A conversation in use keeps
// its process; a quiet one is stopped and resumed from its saved session when it
// is next addressed, or sooner when the agent is at its process limit and
// another conversation starts. One spare process, shared by every agent, waits
// for the next new conversation, so that starts without a spawn. A one-off turn
// (a watch or timer wake) gets a new session of its own, which is never saved,
// resumed or shared.
import {
  ClaudeProcess,
  type ClaudeLaunch,
  type ClaudeModel,
  type ActivityReceipt,
  type Settled,
  type Spawn,
  type ToolServer,
  type TurnPick,
} from "./claude";

/** Processes an agent keeps for its conversations. The host allows 64 across
 * every plugin, and frees a slot only after a stopped process has exited; the
 * shared spare is not counted, as it is not any agent's. */
export const MAX_LIVE = 6;
/** A conversation's process stops after this long without a message. */
export const IDLE_MS = 15 * 60_000;
/** How long a one-off turn can run before it is given up; Janet's turn
 * deadline. */
export const ONCE_DEADLINE_MS = 5 * 60_000;
/** Saved sessions per agent; the least recently used are forgotten. */
const SAVED_LIMIT = 200;

/** What is saved for one conversation. */
export type SavedSession = Readonly<{
  id: string;
  /** created_at of the newest event this session has been shown. */
  seen: number;
  at: number;
}>;
export type SessionStore = {
  get(key: string): SavedSession | undefined;
  set(key: string, session: SavedSession): void;
  delete(key: string): void;
};

export type SessionsOptions = Readonly<{
  spawn: Spawn;
  /** Where a new conversation looks for a process already started. */
  spare?: Spare;
  store: SessionStore;
  /** How to start a process with the agent's current settings. */
  launch(): Promise<Omit<ClaudeLaunch, "resume" | "sessionId">>;
  /** Changes when a setting that a running process fixed has changed. */
  fingerprint(): string;
  now?(): number;
  newId?(): string;
  /** Called when a conversation's process starts or stops. */
  onChange?(): void;
}>;

type Live = {
  process: ClaudeProcess;
  fingerprint: string;
  used: number;
  timer?: ReturnType<typeof setTimeout>;
};

export class AgentSessions {
  private readonly live = new Map<string, Live>();
  /** One-off turns running or starting, by label. */
  private readonly once = new Map<string, Live | undefined>();
  private onceCount = 0;
  private readonly opening = new Map<string, Promise<Live | undefined>>();
  private discovery:
    | {
        fingerprint: string;
        result: Promise<{
          models: readonly ClaudeModel[];
          model: string | undefined;
          effort: string | undefined;
        }>;
        process?: ClaudeProcess | undefined;
      }
    | undefined;
  private disposed = false;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly options: SessionsOptions) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** What `seen` says this conversation's session has been shown. */
  seen(key: string) {
    return this.options.store.get(key)?.seen ?? 0;
  }
  /** Conversations with a running process, and whether each is working. */
  snapshot() {
    return [
      ...[...this.live].map(([key, live]) => ({
        key,
        busy: live.process.busy,
      })),
      ...[...this.once.keys()].map((key) => ({ key, busy: true })),
    ];
  }

  /** Read defaults without assigning the shared spare to this agent. */
  async metadata() {
    const fingerprint = this.options.fingerprint();
    const read = async (process: ClaudeProcess) => {
      const [models, model, effort] = await Promise.all([
        process.models(),
        process.readModel(),
        process.readEffort(),
      ]);
      return { models, model, effort };
    };
    for (const live of this.live.values())
      if (live.fingerprint === fingerprint && live.process.running) {
        const metadata = await read(live.process);
        const discovered =
          this.discovery?.fingerprint === fingerprint
            ? await this.discovery.result
            : undefined;
        return { ...metadata, model: metadata.model ?? discovered?.model };
      }
    if (this.disposed)
      return { models: [], model: undefined, effort: undefined };
    if (this.discovery?.fingerprint === fingerprint)
      return this.discovery.result;
    this.clearDiscovery();
    const discovery: NonNullable<AgentSessions["discovery"]> = {
      fingerprint,
      result: Promise.resolve().then(async () => {
        const launch = await this.options.launch();
        if (this.disposed || this.discovery !== discovery)
          throw new Error("Claude was stopped");
        const process = await ClaudeProcess.start(this.options.spawn, {
          cwd: launch.cwd,
          ...(launch.model ? { model: launch.model } : {}),
          systemPrompt: "",
        });
        discovery.process = process;
        try {
          if (this.disposed || this.discovery !== discovery)
            throw new Error("Claude was stopped");
          return await read(process);
        } finally {
          await process.kill();
          discovery.process = undefined;
        }
      }),
    };
    this.discovery = discovery;
    void discovery.result.catch(() => {
      if (this.discovery === discovery) this.discovery = undefined;
    });
    return discovery.result;
  }
  private clearDiscovery() {
    void this.discovery?.process?.kill();
    this.discovery = undefined;
  }

  /** Sends `text` into the conversation `key`, and resolves when the session
   * has answered it. `steer` replaces `text` when the session is mid-turn;
   * `fresh` builds it again for a new session when the saved one is lost;
   * `pick` is the model and effort the turn was asked to run with. */
  async deliver(
    key: string,
    text: string,
    seen: number,
    {
      steer = text,
      fresh,
      pick = {},
      step,
      acknowledged,
      superseded,
      activityScope,
    }: Readonly<{
      steer?: string;
      fresh?: () => Promise<string>;
      pick?: TurnPick;
    }> &
      ActivityReceipt = {},
  ): Promise<Settled> {
    if (this.disposed) return { ok: false, error: "Claude was stopped" };
    // A message that arrives while its conversation's process starts uses it.
    // Checked without awaiting first, so the first message opens it at once.
    const opening = this.opening.get(key);
    if (opening) await opening;
    let live = this.live.get(key);
    if (
      live &&
      (!live.process.running ||
        (live.fingerprint !== this.options.fingerprint() && !live.process.busy))
    ) {
      this.drop(key, live);
      live = undefined;
    }
    if (live) {
      this.touch(key, live, seen);
      return this.answer(key, live, live.process.busy ? steer : text, {
        ...pick,
        ...(activityScope ? { activityScope } : {}),
        ...(step ? { step } : {}),
        ...(acknowledged ? { acknowledged } : {}),
        ...(superseded ? { superseded } : {}),
      });
    }
    const saved = this.options.store.get(key);
    // Any start needs room, reserved here, before anything is awaited.
    if (!this.room())
      return {
        ok: false,
        error: `Claude is already working in ${MAX_LIVE} conversations; try again when one finishes`,
      };
    const starting = this.start(saved?.id).catch((error) => {
      console.warn("Claude could not start", error);
      return undefined;
    });
    this.opening.set(key, starting);
    live = await starting;
    if (this.opening.get(key) === starting) this.opening.delete(key);
    if (live && !this.disposed) this.adopt(key, live, seen);
    if (!live) return { ok: false, error: "Claude could not start" };
    if (this.disposed) {
      void live.process.kill();
      return { ok: false, error: "Claude was stopped" };
    }
    const activity = {
      ...pick,
      ...(activityScope ? { activityScope } : {}),
      ...(step ? { step } : {}),
      ...(acknowledged ? { acknowledged } : {}),
      ...(superseded ? { superseded } : {}),
    };
    const delivered = await this.answer(key, live, text, activity);
    // A saved session that no longer loads starts over rather than failing
    // every message in the conversation, shown the conversation so far.
    if (!delivered.ok && saved && !live.process.started) {
      this.options.store.delete(key);
      this.drop(key, live);
      return this.deliver(key, fresh ? await fresh() : text, seen, {
        pick,
        ...activity,
      });
    }
    return delivered;
  }

  /** Runs one turn in a new session, then stops its process. The session is
   * not saved, so it never displaces a conversation's saved session and is
   * never resumed. `label` names it in the snapshot. It gives up, and stops
   * the turn, after `deadline` ms of running. `prompt` is asked for the turn's
   * text once a process is ready, so a turn that should no longer run by then
   * returns undefined and sends nothing. It settles only when its process has
   * exited, so it shows as working while it may still be working. */
  async runOnce(
    label: string,
    prompt: () => string | undefined | Promise<string | undefined>,
    deadline = ONCE_DEADLINE_MS,
  ): Promise<Settled> {
    if (this.disposed) return { ok: false, error: "Claude was stopped" };
    const key = `${label} #${++this.onceCount}`;
    this.once.set(key, undefined);
    this.options.onChange?.();
    let live: Live | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      live = await this.start(undefined);
      if (this.disposed) return { ok: false, error: "Claude was stopped" };
      // A key no conversation uses: its tools have no default destination.
      live.process.conversation = key;
      this.once.set(key, live);
      const text = await prompt();
      if (text === undefined || this.disposed) return { ok: true };
      return await Promise.race([
        live.process.send(text),
        new Promise<Settled>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                ok: false,
                error: `The turn ran past its ${Math.round(deadline / 1000)}s deadline and was stopped`,
              }),
            deadline,
          );
        }),
      ]);
    } catch (error) {
      console.warn("Claude could not start a one-off session", error);
      return { ok: false, error: "Claude could not start" };
    } finally {
      clearTimeout(timer);
      if (live) {
        // Killing only asks it to stop; the host may let it run a few seconds.
        void live.process.kill();
        await live.process.exited.catch(() => undefined);
      }
      this.once.delete(key);
      this.options.onChange?.();
    }
  }

  /** Stops idle processes started with old settings; busy ones stop when they
   * next fall idle. */
  reconfigure() {
    this.clearDiscovery();
    const fingerprint = this.options.fingerprint();
    for (const [key, live] of this.live)
      if (live.fingerprint !== fingerprint && !live.process.busy)
        this.drop(key, live);
  }

  dispose() {
    this.disposed = true;
    this.clearDiscovery();
    for (const [key, live] of this.live) this.drop(key, live);
    for (const live of this.once.values()) void live?.process.kill();
  }

  private async start(resume: string | undefined): Promise<Live> {
    // Read before `launch` reads the settings, so it never describes newer ones.
    const fingerprint = this.options.fingerprint();
    const launch = await this.options.launch();
    const process = resume
      ? await ClaudeProcess.start(this.options.spawn, { ...launch, resume })
      : await this.fresh(launch);
    if (fingerprint === this.options.fingerprint() || this.disposed)
      return { process, fingerprint, used: this.now() };
    // Settings saved while it started: it would work with the old ones.
    void process.kill();
    return this.start(resume);
  }
  /** A process for a new session: the spare when it fits, else a new one. */
  private async fresh(launch: Omit<ClaudeLaunch, "resume" | "sessionId">) {
    const spare = await this.options.spare?.take(launch);
    if (spare)
      try {
        await spare.initialize(launch);
        return spare;
      } catch {
        void spare.kill();
      }
    return ClaudeProcess.start(this.options.spawn, {
      ...launch,
      sessionId: this.newId(),
    });
  }
  private adopt(key: string, live: Live, seen: number) {
    live.process.conversation = key;
    this.live.set(key, live);
    this.touch(key, live, seen);
    this.options.onChange?.();
    void live.process.exited.then(() => {
      if (this.live.get(key) === live) this.drop(key, live);
    });
  }
  private async answer(
    key: string,
    live: Live,
    text: string,
    activity: TurnPick & ActivityReceipt,
  ) {
    const settled = await live.process.send(text, activity);
    if (this.live.get(key) === live) {
      this.touch(key, live);
      if (live.fingerprint !== this.options.fingerprint() && !live.process.busy)
        this.drop(key, live);
    }
    return settled;
  }
  /** Saves the session and restarts its idle countdown. */
  private touch(key: string, live: Live, seen?: number) {
    live.used = this.now();
    clearTimeout(live.timer);
    live.timer = setTimeout(() => {
      if (live.process.busy) this.touch(key, live);
      else if (this.live.get(key) === live) this.drop(key, live);
    }, IDLE_MS);
    const id = live.process.sessionId;
    if (!id) return;
    const prior = this.options.store.get(key);
    this.options.store.set(key, {
      id,
      seen: Math.max(seen ?? 0, prior?.id === id ? prior.seen : 0),
      at: live.used,
    });
  }
  /** Processes running or starting. */
  private count() {
    return this.live.size + this.opening.size;
  }
  /** Makes room for one more process by stopping the longest-idle
   * conversation; it resumes from its saved session when next addressed.
   * False when every process is working. */
  private room() {
    while (this.count() >= MAX_LIVE) {
      const idle = [...this.live]
        .filter(([, live]) => !live.process.busy)
        .sort(([, a], [, b]) => a.used - b.used)[0];
      if (!idle) return false;
      this.drop(...idle);
    }
    return true;
  }
  private drop(key: string, live: Live) {
    clearTimeout(live.timer);
    if (this.live.get(key) === live) {
      this.live.delete(key);
      this.options.onChange?.();
    }
    void live.process.kill();
  }
}

/** Where a process runs and its model: all a spare is started with. */
type Where = Pick<ClaudeLaunch, "cwd" | "model">;
const place = ({ cwd, model }: Where) => JSON.stringify([cwd, model ?? ""]);

/** One process started ahead of need, for whichever agent next starts a
 * conversation where it runs and with its model. Starting is most of the wait
 * before a new conversation's first reply; giving the process its prompt is not.
 * It is kept only where the runtime's agents run, and follows the latest new
 * conversation among those places, the likeliest place for the next. */
export class Spare {
  private next:
    | { place: string; process: Promise<ClaudeProcess | undefined> }
    | undefined;
  /** Where a spare is wanted: set by the runtime alone. */
  private wanted: readonly Where[] = [];
  /** Not started again after it failed to start or died, until a conversation
   * asks for one, so a `claude` that cannot run is not started over and over. */
  private stopped = false;

  constructor(
    private readonly spawn: Spawn,
    /** Answers the tool server before any agent has it: it lists the tools. */
    private readonly tools: ToolServer,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** Wants a spare for one of `wheres`, or none when there are none. */
  warm(...wheres: Where[]) {
    this.wanted = wheres;
    if (!wheres.length) this.stopped = false;
    this.fill(wheres);
  }

  /** The spare, when it was started for `where`. Another is started for
   * `where` when a spare is wanted there, else where one is wanted. */
  async take(where: Where) {
    const next = this.next;
    this.next = undefined;
    this.stopped = false;
    const here = this.wanted.some((wanted) => place(wanted) === place(where));
    this.fill(here ? [where] : this.wanted);
    if (next?.place !== place(where)) {
      void next?.process.then((process) => process?.kill());
      return undefined;
    }
    const process = await next.process;
    if (process?.running) return process;
    void process?.kill();
    return undefined;
  }

  dispose() {
    this.warm();
  }

  /** Keeps the spare when it fits one of `wheres`, else starts one for the
   * first; with none, keeps none. */
  private fill(wheres: readonly Where[]) {
    const current = this.next;
    if (current && wheres.some((where) => place(where) === current.place))
      return;
    this.next = undefined;
    void current?.process.then((process) => process?.kill());
    const [first] = wheres;
    if (this.stopped || !first) return;
    const next = {
      place: place(first),
      process: ClaudeProcess.spawn(this.spawn, {
        ...first,
        sessionId: this.newId(),
        tools: this.tools,
      }).catch((error) => {
        console.warn("Claude could not start a spare session", error);
        return undefined;
      }),
    };
    this.next = next;
    void next.process.then(async (process) => {
      await process?.exited;
      if (this.next !== next) return;
      this.next = undefined;
      this.stopped = true;
    });
  }
}

/** Sessions saved in local storage, by agent and then conversation. */
export function localSessions(
  storage: Storage,
  agent: string,
  name = "buzz.claude-code.sessions.v1",
): SessionStore & {
  /** Saved sessions, most recently used first. */
  list(): [string, SavedSession][];
} {
  const readAll = (): Record<string, Record<string, SavedSession>> => {
    try {
      const value = JSON.parse(storage.getItem(name) ?? "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  };
  const update = (change: (sessions: Record<string, SavedSession>) => void) => {
    const all = readAll();
    const sessions = { ...(all[agent] ?? {}) };
    change(sessions);
    const kept = Object.entries(sessions)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, SAVED_LIMIT);
    all[agent] = Object.fromEntries(kept);
    try {
      storage.setItem(name, JSON.stringify(all));
    } catch (error) {
      console.warn("Claude sessions were not saved", error);
    }
  };
  return {
    list: () =>
      Object.entries(readAll()[agent] ?? {})
        .filter(([, saved]) => typeof saved?.id === "string")
        .sort(([, a], [, b]) => b.at - a.at),
    get: (key) => {
      const saved = readAll()[agent]?.[key];
      return saved && typeof saved.id === "string" ? saved : undefined;
    },
    set: (key, session) =>
      update((sessions) => {
        sessions[key] = session;
      }),
    delete: (key) =>
      update((sessions) => {
        delete sessions[key];
      }),
  };
}
