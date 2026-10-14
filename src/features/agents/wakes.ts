// Watch and timer wakes, the same for every harness, as in Janet: each runs as
// a one-off turn in its Interest's lane, joins no conversation, and saves
// nothing. A harness supplies only how to run one such turn; this owns the
// lane, the checks that it is still wanted, and its prompt.
import {
  ATTENTION_REVIEW,
  timerPrompt,
  watchPrompt,
} from "../../buzz-mcp/attention-prompt";
import type { Lanes } from "./lanes";
import type { AgentHandle, Delivery } from "./service";

/** How long a wake's turn may run before its harness stops it; Janet's turn
 * deadline. */
export const WAKE_DEADLINE_MS = 5 * 60_000;

export type WakeTrigger = Exclude<Delivery["trigger"], { type: "mention" }>;
/** How a wake's turn ended. */
export type WakeResult = Readonly<{ ok: boolean; error?: string }>;
/** Runs one one-off turn, `key` naming it (`watch/ID` or `timer/ID`). The
 * harness calls `prompt` once it is ready to start the turn, and starts none
 * when it gives undefined: the wake is no longer wanted. */
export type RunOnce = (
  key: string,
  prompt: () => Promise<string | undefined>,
) => Promise<WakeResult>;

/** Queues `trigger` on its Interest's lane in `lanes` and runs it with
 * `runOnce`. Settles when its turn ends, or at once when it is dropped. The
 * host says whether it is still `current`, asked when its lane starts it and
 * again while its prompt is built: a wake whose watch or timer was disabled
 * or removed, whose watch changed or no longer matches, or whose agent's
 * attention went off, while it waited does not run. `harness` names the
 * agent type in logs. */
export function wake(
  lanes: Lanes,
  agent: AgentHandle,
  trigger: WakeTrigger,
  current: () => boolean,
  runOnce: RunOnce,
  harness: string,
): Promise<WakeResult> {
  const id = trigger.slug.replace(/^watch\//, "");
  const lane = (trigger.type === "watch" ? trigger.watch : trigger.timer)
    .interest_id;
  let settle!: (result: WakeResult) => void;
  const settled = new Promise<WakeResult>((resolve) => {
    settle = resolve;
  });
  const dropped = (why: string) => {
    console.warn(`${harness} dropped a ${trigger.type} turn: ${why}`);
    settle({ ok: true });
  };
  const queued = lanes.add(
    lane,
    async () => {
      try {
        if (!current()) return settle({ ok: true });
        const result = await runOnce(`${trigger.type}/${id}`, () =>
          wakePrompt(agent, trigger, id, current),
        );
        if (!result.ok)
          console.warn(
            `${harness} ${trigger.type} turn failed: ${id}`,
            result.error,
          );
        settle(result);
      } finally {
        // Settled already, unless something above threw.
        settle({ ok: false, error: "The turn failed" });
      }
    },
    () => dropped("attention was turned off or the agent stopped"),
  );
  if (queued !== "queued")
    dropped(
      queued === "full"
        ? `too many are waiting (Interest ${lane})`
        : "the agent stopped",
    );
  return settled;
}

/** The prompt for a wake as its watch or timer now is, with the end-of-turn
 * review, or undefined when it should no longer run. */
async function wakePrompt(
  agent: AgentHandle,
  trigger: WakeTrigger,
  id: string,
  stillCurrent: () => boolean,
) {
  const { attention } = agent;
  if (!stillCurrent()) return undefined;
  const current = (await attention.show(trigger.slug)).object;
  const type = trigger.type === "watch" ? "event" : "timer";
  if (!current || current.type !== type) return undefined;
  const interest = (await attention.show(`interest/${current.interest_id}`))
    .object;
  const instructions =
    interest?.type === "interest"
      ? { instructions: interest.instructions }
      : {};
  const text =
    trigger.type === "watch"
      ? watchPrompt({
          id,
          interest: current.interest_id,
          ...instructions,
          event: trigger.event,
          ...(trigger.classifier ? { classifier: trigger.classifier } : {}),
        })
      : timerPrompt({
          id,
          interest: current.interest_id,
          prompt: current.type === "timer" ? current.prompt : "",
          ...instructions,
          spent: trigger.spent,
        });
  // Asked again: the attention can change while it is read.
  return stillCurrent() ? `${text}\n\n${ATTENTION_REVIEW}` : undefined;
}
