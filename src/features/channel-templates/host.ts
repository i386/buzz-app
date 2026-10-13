import type { RelayEvent } from "../relay/events";
import type { PrivateRecord } from "./model";
export interface ChannelKitHost {
  prepare(record: PrivateRecord, signal: AbortSignal): Promise<string>;
  decode(
    events: readonly RelayEvent[],
    signal: AbortSignal,
  ): Promise<{ eventId: string; record: PrivateRecord }[]>;
}
