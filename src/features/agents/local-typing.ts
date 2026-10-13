// STOPGAP(agent-local-typing): DELETE once agents' typing pulses reach the
// relay. Every piece is tagged STOPGAP(agent-local-typing): grep for it and
// delete this file and its test, its import and use in service.ts, and
// `typing.local` in relay/typing.ts with its test and the fake in
// agents/service.test.ts.
//
// While an agent this app runs works on a mention, it shows as typing there,
// on this device only.
import type { RelayEvent } from "../relay/events";
import type { RelaySession } from "../relay/session";
import { threadReference } from "../relay/thread-reference";

/** Clients show a pulse for 8 s, so one every 3 s keeps it steady. */
const PULSE_MS = 3_000;

/** Shows `pubkey` typing where it answers `event` until the returned function
 * is called. `session` is read on every pulse, as the community may reconnect. */
export function typeLocally(
  session: () => RelaySession | undefined,
  pubkey: string,
  event: RelayEvent,
  channelId: string,
): () => void {
  const root = threadReference(event)?.rootId ?? event.id;
  const tags = [
    ["h", channelId],
    ...(root === event.id ? [] : [["e", root, "", "root"]]),
    ["e", event.id, "", "reply"],
  ];
  const send = (kind: number) =>
    session()?.typing.local({
      id: "",
      pubkey,
      kind,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags,
    });
  const pulse = () => {
    try {
      send(20002);
    } catch (error) {
      // A stopgap must never break the run it decorates.
      clearInterval(timer);
      console.warn("Agent typing was not shown", error);
    }
  };
  const timer = setInterval(pulse, PULSE_MS);
  pulse();
  return () => {
    clearInterval(timer);
    // Ends it now rather than when the last pulse would expire.
    try {
      send(9);
    } catch (error) {
      console.warn("Agent typing was not ended", error);
    }
  };
}
