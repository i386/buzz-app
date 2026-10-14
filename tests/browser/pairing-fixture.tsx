import { PairingSettings } from "../../src/bundled/pairing/PairingSettings";
import type { PairingSettingsProps } from "../../src/bundled/pairing/PairingSettings";
import type {
  PairingNative,
  PairingStatus,
} from "../../src/features/pairing/client";
const fixture = {
  calls: [] as { action: string; id?: string }[],
  status: { phase: "connecting" } as PairingStatus,
  delay: false,
  release: undefined as (() => void) | undefined,
};
Object.assign(window, { pairingFixture: fixture });
const native: PairingNative = {
  async account() {
    return "f".repeat(64);
  },
  async start(id) {
    fixture.calls.push({ action: "start", id });
    if (fixture.delay)
      await new Promise<void>((resolve) => {
        fixture.release = resolve;
      });
    fixture.status = {
      phase: "qr",
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="white"/><text x="20" y="128" fill="black">Fixture QR — not scannable</text></svg>',
      uri: "nostrpair://fixture",
    };
  },
  async status() {
    return fixture.status;
  },
  async confirm(id) {
    fixture.calls.push({ action: "confirm", id });
    fixture.status = { phase: "transferring" };
  },
  async deny(id) {
    fixture.calls.push({ action: "deny", id });
    fixture.status = { phase: "cancelled" };
  },
  async cancel(id) {
    fixture.calls.push({ action: "cancel", id });
    if (fixture.status.phase === "transferring")
      fixture.status = { phase: "uncertain" };
    else if (!["uncertain", "complete", "error"].includes(fixture.status.phase))
      fixture.status = { phase: "cancelled" };
    return fixture.status;
  },
};
export function PairingFixture(props: PairingSettingsProps) {
  return <PairingSettings {...props} native={native} available />;
}
