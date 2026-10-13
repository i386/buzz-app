// One `claude` process driven over its stream-json protocol: the protocol the
// Claude Agent SDK speaks to the same binary, so no Node runtime is needed. The
// process stays alive between turns; messages sent while it works are folded
// into the running turn at its next tool call. Buzz tools are served over the
// same pipe, as the SDK serves an in-process MCP server, so the process holds
// no Buzz key.
import type {
  HostProcess,
  HostProcessOptions,
} from "../../features/host/service";

export type ActivityReceipt = Readonly<{
  /** Presentation destination; channel-shared sessions may handle several threads. */
  activityScope?: string;
  step?: (tool: string, target?: string) => void;
  acknowledged?: () => void;
  superseded?: () => void;
}>;

export type Spawn = (
  id: string,
  options?: HostProcessOptions,
) => Promise<HostProcess>;

export type ClaudeLaunch = Readonly<{
  cwd: string;
  /** Appended to Claude's own system prompt. */
  systemPrompt: string;
  model?: string;
  /** A saved session to continue. */
  resume?: string;
  /** The id a new session takes, so it is known before its first turn. */
  sessionId?: string;
  /** The in-process MCP server's tools. */
  tools?: ToolServer;
}>;

/** Answers the in-process server's JSON-RPC for the conversation a process
 * serves. A call of `send` with `final: true` ends the turn when it succeeds. */
export type ToolServer = (
  conversation: string | undefined,
  message: unknown,
) => Promise<unknown>;
/** Its tools are `mcp__buzz__<name>`. */
export const TOOL_SERVER = "buzz";
const FINAL_TOOL = `mcp__${TOOL_SERVER}__send`;

type Message = Record<string, unknown> & { type?: string; subtype?: string };

/** A model Claude lists as one a session can switch to. */
export type ClaudeModel = Readonly<{
  /** What `set_model` takes: an alias such as `opus`, or a model id. */
  value: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: readonly string[];
}>;
/** What the next turn is asked to run with; absent is the session's own. */
export type TurnPick = Readonly<{ model?: string; effort?: string }>;

/** How a burst of work ended: every message sent so far has been answered,
 * or the process is gone. */
export type Settled = Readonly<{
  ok: boolean;
  /** Why it failed, for the person waiting. */
  error?: string;
}>;

const STDERR_LIMIT = 4_000;
/** What `claude` is started with: as the SDK starts it, reporting when it is
 * idle, signed in as `claude auth login` left it, and never as part of a
 * Claude session that started the app. */
export const ENV: Readonly<Record<string, string | null>> = {
  CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
  CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
  // Buzz keeps its own copy current; Claude must not install itself elsewhere.
  DISABLE_AUTOUPDATER: "1",
  // A key in the shell that launched the app would outrank the sign-in; the
  // interactive CLI asks before using one, but stream-json mode uses it silently.
  ANTHROPIC_API_KEY: null,
  CLAUDECODE: null,
  CLAUDE_CODE_SESSION_ID: null,
  CLAUDE_CODE_CHILD_SESSION: null,
  CLAUDE_CODE_MESSAGING_SOCKET: null,
  CLAUDE_CODE_MESSAGING_TOKEN: null,
  CLAUDE_CODE_SESSION_ATTENDED: null,
  CLAUDE_AGENT_SDK_VERSION: null,
  CLAUDE_PID: null,
};

export class ClaudeProcess {
  /** Its session, known once the first turn starts (or at once when resuming). */
  sessionId: string | undefined;
  /** The conversation it serves, set when a spare is put to use. */
  conversation: string | undefined;
  /** Messages sent and not yet answered. */
  private pending = 0;
  /** It has begun a turn, so its session loaded. */
  private began = false;
  /** The model the session reported when it began. */
  private reported: string | undefined;
  private waiters: ((settled: Settled) => void)[] = [];
  private buffer = "";
  private stderr = "";
  private lastError: string | undefined;
  private alive = true;
  /** It reports idle; an older `claude` that does not is settled per result. */
  private reportsState = false;
  private requests = 0;
  /** Control requests awaiting Claude's answer, by request id. */
  private calls = new Map<string, (response: Message) => void>();
  /** The models Claude lists, from its answer to `initialize`. */
  private listed: Promise<readonly ClaudeModel[]> = Promise.resolve([]);
  /** The model the next turn runs on; undefined is the session's own. */
  private pickedModel: string | undefined;
  /** The effort the next turn runs at; undefined is the session's own. */
  private effort: string | undefined;
  /** The session's own effort, read before the first change to restore it. */
  private ownEffort: string | undefined;
  private readingEffort: Promise<void> | undefined;
  readonly exited: Promise<number | null>;

  private constructor(
    private readonly process: HostProcess,
    resume: string | undefined,
    private tools: ToolServer | undefined,
    /** The session's own model, as launched; undefined is Claude's default. */
    private readonly ownModel: string | undefined,
  ) {
    this.sessionId = resume;
    this.exited = process.exited.then((code) => {
      this.alive = false;
      for (const resolve of this.calls.values())
        resolve({ subtype: "error", error: "Claude exited" });
      this.calls.clear();
      const error =
        this.lastError ??
        (this.stderr.trim().split("\n").at(-1) ||
          `Claude exited (${code ?? "signal"})`);
      this.settle({ ok: false, error });
      return code;
    });
  }

  static async start(spawn: Spawn, launch: ClaudeLaunch) {
    const claude = await ClaudeProcess.spawn(spawn, launch);
    await claude.initialize(launch);
    return claude;
  }

  /** Starts `claude` without its prompt. This is most of what a start costs,
   * and fixes nothing about the agent it serves but its folder and model. */
  static async spawn(spawn: Spawn, launch: Omit<ClaudeLaunch, "systemPrompt">) {
    let claude: ClaudeProcess | undefined;
    const early: string[] = [];
    const earlyErrors: string[] = [];
    const process = await spawn("claude", {
      args: [
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--verbose",
        "--replay-user-messages",
        "--permission-mode",
        "bypassPermissions",
        ...(launch.model ? ["--model", launch.model] : []),
        ...(launch.resume ? ["--resume", launch.resume] : []),
        ...(!launch.resume && launch.sessionId
          ? ["--session-id", launch.sessionId]
          : []),
        ...(launch.tools
          ? [
              "--mcp-config",
              JSON.stringify({
                mcpServers: {
                  // Listed up front, so Claude need not search for them first.
                  [TOOL_SERVER]: {
                    type: "sdk",
                    name: TOOL_SERVER,
                    alwaysLoad: true,
                  },
                },
              }),
            ]
          : []),
      ],
      cwd: launch.cwd,
      env: ENV,
      onStdout: (data) => (claude ? claude.read(data) : early.push(data)),
      onStderr: (data) =>
        claude ? claude.readError(data) : earlyErrors.push(data),
    });
    claude = new ClaudeProcess(
      process,
      launch.resume ?? launch.sessionId,
      launch.tools,
      launch.model,
    );
    for (const data of earlyErrors) claude.readError(data);
    for (const data of early) claude.read(data);
    return claude;
  }

  /** Gives a started process its prompt, and its tools to whoever it now
   * works for. Loads settings and tools now rather than on the first message. */
  async initialize(launch: Pick<ClaudeLaunch, "systemPrompt" | "tools">) {
    if (launch.tools) this.tools = launch.tools;
    const { written, answer } = this.request({
      subtype: "initialize",
      appendSystemPrompt: launch.systemPrompt,
      ...(launch.tools
        ? {
            sdkMcpServers: [TOOL_SERVER],
            hooks: {
              PostToolUse: [
                { matcher: FINAL_TOOL, hookCallbackIds: ["final"] },
              ],
            },
          }
        : {}),
    });
    await written;
    this.listed = answer.then((response) => {
      const models = (response.response as Message | undefined)?.models;
      return Array.isArray(models)
        ? models.filter(
            (model): model is ClaudeModel => typeof model?.value === "string",
          )
        : [];
    });
  }

  get running() {
    return this.alive;
  }
  get busy() {
    return this.pending > 0;
  }
  get started() {
    return this.began;
  }
  get model() {
    return this.reported;
  }
  /** The models this session can switch to, without sending a turn. */
  models() {
    return this.listed;
  }
  /** The effort a turn without a pick runs at, when Claude reports it. */
  async readEffort() {
    await this.readOwnEffort();
    return this.ownEffort;
  }
  /** Settings resolve the default model without sending a paid user turn. */
  async readModel() {
    // Settings report a picked model, which is not the session's own.
    if (this.reported || this.pickedModel !== undefined) return this.reported;
    const answer = await this.call({ subtype: "get_settings" });
    const applied = (answer.response as Message | undefined)?.applied as
      | Message
      | undefined;
    if (typeof applied?.model === "string") this.reported = applied.model;
    return this.reported;
  }

  /** Sends one user message. Resolves when it, and anything sent after it, has
   * been answered and the session is idle again. A new turn runs with the
   * picked model and effort, or the session's own without them; a message
   * folded into a running turn changes only what it asks for. */
  send(
    text: string,
    { model, effort, ...activity }: TurnPick & ActivityReceipt = {},
  ): Promise<Settled> {
    if (!this.alive)
      return Promise.resolve({
        ok: false,
        error: "Claude is not running",
      });
    // The model first: effort applies to whichever model runs.
    this.setModel(model !== undefined || !this.busy ? model : this.pickedModel);
    this.setEffort(effort !== undefined || !this.busy ? effort : this.effort);
    const uuid = crypto.randomUUID();
    this.receipts.set(uuid, activity);
    this.pending++;
    const settled = new Promise<Settled>((resolve) =>
      this.waiters.push(resolve),
    );
    this.write({
      type: "user",
      uuid,
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
    }).catch((error) =>
      this.settle({
        ok: false,
        error: `Claude did not take the message: ${error}`,
      }),
    );
    return settled;
  }

  kill() {
    return this.process.kill();
  }

  private write(message: Message) {
    return this.process.write(`${JSON.stringify(message)}\n`);
  }
  /** Writes a control request: `written` settles with the write, `answer`
   * with Claude's response. */
  private request(request: Message) {
    const id = `buzz-${++this.requests}`;
    const answer = new Promise<Message>((resolve) =>
      this.calls.set(id, resolve),
    );
    const written = this.write({
      type: "control_request",
      request_id: id,
      request,
    });
    return { written, answer };
  }
  /** Sends a control request and resolves with Claude's response. */
  private call(request: Message): Promise<Message> {
    const { written, answer } = this.request(request);
    return written.then(() => answer);
  }
  /** Switches model without restarting, as the SDK's `setModel` does. Back to
   * the session's own is the model it was launched with, or the default. A
   * new model misses the prompt cache, which the owner accepts by picking. */
  private setModel(model: string | undefined) {
    if (model === this.pickedModel) return;
    this.pickedModel = model;
    const next = model ?? this.ownModel;
    void this.call({
      subtype: "set_model",
      ...(next ? { model: next } : {}),
    }).then((answer) => {
      if (answer.subtype !== "success")
        console.warn("Claude did not change its model", answer.error);
    });
  }
  /** Changes effort without restarting, which keeps the prompt cache: Claude
   * Code sends effort per message. Clearing the flag setting would not restore
   * the session's own level, so that is read before the first change and set
   * back explicitly. Written ahead of the message without waiting, as Claude
   * Code takes its input in order, so a turn never waits on it. */
  private setEffort(effort: string | undefined) {
    if (effort === this.effort) return;
    void this.readOwnEffort();
    const level = effort ?? this.ownEffort;
    if (!level) {
      console.warn("Claude's own effort is unknown; keeping the last one");
      return;
    }
    this.effort = effort;
    void this.call({
      subtype: "apply_flag_settings",
      settings: { effortLevel: level },
    }).then((answer) => {
      if (answer.subtype !== "success")
        console.warn("Claude did not change its effort", answer.error);
    });
  }
  /** Read once, ahead of the first change, so it is the session's own. */
  private readOwnEffort() {
    this.readingEffort ??= this.call({ subtype: "get_settings" }).then(
      (answer) => {
        const applied = (answer.response as Message | undefined)?.applied as
          | Message
          | undefined;
        if (typeof applied?.effort === "string")
          this.ownEffort = applied.effort;
      },
    );
    return this.readingEffort;
  }
  private settle(settled: Settled) {
    this.pending = 0;
    this.receipts.clear();
    this.activeReceipts.clear();
    this.lastError = undefined;
    for (const resolve of this.waiters.splice(0)) resolve(settled);
  }

  private readError(data: string) {
    this.stderr = (this.stderr + data).slice(-STDERR_LIMIT);
  }
  private read(data: string) {
    this.buffer += data;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;
      let message: Message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.handle(message);
    }
  }
  // Replay acknowledgments are correlated by the UUID we supplied, never by
  // prompt text or tool-result user messages. Only the latest acknowledged
  // request gets steps; settling ends all requests, not just the latest one.
  private readonly receipts = new Map<string, ActivityReceipt>();
  private readonly activeReceipts = new Map<string, ActivityReceipt>();
  private handle(message: Message) {
    if (typeof message.session_id === "string" && message.session_id)
      this.sessionId = message.session_id;
    if (message.type === "system" && message.subtype === "init") {
      this.began = true;
      // A picked model is not the session's own.
      if (typeof message.model === "string" && this.pickedModel === undefined)
        this.reported = message.model;
    }
    if (message.type === "control_request") {
      void this.answer(message);
      return;
    }
    if (message.type === "control_response") {
      const response = (message.response ?? {}) as Message;
      const id = String(response.request_id);
      this.calls.get(id)?.(response);
      this.calls.delete(id);
      return;
    }
    if (
      message.type === "system" &&
      message.subtype === "session_state_changed"
    ) {
      this.reportsState = true;
      if (message.state === "idle" && this.pending) this.done();
      return;
    }
    if (
      message.type === "user" &&
      message.isReplay === true &&
      typeof message.uuid === "string"
    ) {
      const receipt = this.receipts.get(message.uuid);
      if (receipt) {
        this.receipts.delete(message.uuid);
        // Watches/timers have no message activity: they must not hide a mention.
        if (receipt.step) {
          const scope = receipt.activityScope ?? "conversation";
          this.activeReceipts.get(scope)?.superseded?.();
          this.activeReceipts.set(scope, receipt);
          receipt.acknowledged?.();
        }
      }
      return;
    }
    if (message.type === "assistant") {
      const step = stepLabel(message);
      if (step)
        for (const receipt of this.activeReceipts.values())
          receipt.step?.(step.tool, step.target);
      return;
    }
    if (message.type !== "result") return;
    // An interrupt is not a failure to report.
    if (message.is_error && message.terminal_reason !== "aborted_streaming")
      this.lastError =
        typeof message.result === "string" && message.result
          ? message.result
          : `Claude stopped (${String(message.subtype)})`;
    if (!this.reportsState && this.pending) this.done();
  }
  private done() {
    const error = this.lastError;
    this.settle(error ? { ok: false, error } : { ok: true });
  }
  /** Answers what Claude asks its host: calls to the Buzz tools, the
   * hook after `send`, and, since permissions are bypassed, anything else only
   * so an unexpected request does not stall the turn. */
  private async answer(message: Message) {
    const id = message.request_id;
    const request = (message.request ?? {}) as Message;
    const success = (response: unknown) => ({
      subtype: "success",
      request_id: id,
      response,
    });
    let response: Message;
    if (request.subtype === "mcp_message" && this.tools)
      response = success({
        mcp_response: await this.tools(
          this.conversation,
          request.message,
        ).catch((error) => ({
          jsonrpc: "2.0",
          id: (request.message as Message | undefined)?.id ?? 0,
          error: { code: -32603, message: String(error?.message ?? error) },
        })),
      });
    else if (request.subtype === "can_use_tool")
      response = success({
        behavior: "allow",
        updatedInput: request.input ?? {},
      });
    else if (request.subtype === "hook_callback")
      response = success(this.final(request.input) ? { continue: false } : {});
    else
      response = {
        subtype: "error",
        request_id: id,
        error: `Buzz does not handle ${String(request.subtype)}`,
      };
    return this.write({ type: "control_response", response }).catch(
      () => undefined,
    );
  }
  /** A `send` marked final succeeded (a failed call runs no PostToolUse
   * hook), so the turn can end without a closing model call. Not when another
   * message came in meanwhile: that one still needs an answer. */
  private final(input: unknown) {
    const { tool_name, tool_input } = (input ?? {}) as Message;
    return (
      tool_name === FINAL_TOOL &&
      (tool_input as Message | undefined)?.final === true &&
      this.pending === 1
    );
  }
}

/** The last content block of an assistant message as the tool it names and its target. */
export function stepLabel(
  message: Message,
): { tool: string; target?: string } | undefined {
  const content = (message.message as { content?: unknown } | undefined)
    ?.content;
  if (!Array.isArray(content)) return undefined;
  const block = content.at(-1) as {
    type?: unknown;
    name?: unknown;
    input?: Record<string, unknown>;
  } | null;
  if (block?.type === "tool_use" && typeof block.name === "string") {
    const tool = block.name.split("__").at(-1);
    if (!tool) return undefined;
    const input = block.input ?? {};
    const target = [
      "description",
      "file_path",
      "notebook_path",
      "pattern",
      "url",
      "query",
      "command",
    ]
      .map((key) => input[key])
      .find((value): value is string => typeof value === "string" && !!value);
    return target ? { tool, target: shortTarget(target) } : { tool };
  }
  if (block?.type === "thinking") return { tool: "Thinking" };
  if (block?.type === "text") return { tool: "Writing reply" };
  return undefined;
}

/** File paths show their name; everything else is passed through for trimming. */
function shortTarget(value: string) {
  return value.startsWith("/") ? (value.split("/").at(-1) ?? value) : value;
}
