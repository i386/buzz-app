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
/** Turns showing each typing scope; only the last one to stop ends it. */
const showing = new Map<string, number>();

/** Shows `pubkey` typing where it answers `event` until the returned function
 * is called: in the channel itself for a chat in the viewer's Me, which reads
 * as one conversation. Before the placement is first read, it waits for that
 * read, which its turn joins, so both place it alike. `session` is read on
 * every pulse, as the community may reconnect. */
export function typeLocally(
  session: () => RelaySession | undefined,
  pubkey: string,
  event: RelayEvent,
  channelId: string,
): () => void {
  const placement = session()?.mePlacement;
  let stop: (() => void) | undefined;
  let stopped = false;
  const begin = () => {
    if (!stopped)
      stop = show(
        session,
        pubkey,
        event,
        channelId,
        !!placement?.has(channelId),
      );
  };
  const status = placement?.snapshot().status;
  if (!placement || status === "ready" || status === "unavailable") begin();
  else void placement.refresh().then(begin, begin);
  return () => {
    stopped = true;
    stop?.();
    stop = undefined;
  };
}

function show(
  session: () => RelaySession | undefined,
  pubkey: string,
  event: RelayEvent,
  channelId: string,
  flat: boolean,
) {
  const root = threadReference(event)?.rootId ?? event.id;
  const tags = [
    ["h", channelId],
    ...(flat
      ? []
      : [
          ...(root === event.id ? [] : [["e", root, "", "root"]]),
          ["e", event.id, "", "reply"],
        ]),
  ];
  const scope = `${channelId}:${flat ? "" : root}:${pubkey}`;
  showing.set(scope, (showing.get(scope) ?? 0) + 1);
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
    const left = (showing.get(scope) ?? 1) - 1;
    if (left) {
      showing.set(scope, left);
      return;
    }
    showing.delete(scope);
    // Ends it now rather than when the last pulse would expire.
    try {
      send(9);
    } catch (error) {
      console.warn("Agent typing was not ended", error);
    }
  };
}
