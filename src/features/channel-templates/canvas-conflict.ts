import type { OutgoingEvent } from "../relay/outbox";

/** A refused retry cannot prove an earlier uncertain publication never landed. */
export function isDefinitiveCanvasConflict(
  operation: OutgoingEvent | undefined,
): boolean {
  return (
    operation?.event.kind === 40100 &&
    operation.delivery === "failed" &&
    operation.error?.startsWith("conflict:") === true
  );
}

/** A confirmed revision mismatch; refreshing is required before another save. */
export class CanvasConflictError extends Error {
  constructor() {
    super(
      "Canvas changed since you opened it. Your draft is kept; load the current document before replacing it.",
    );
    this.name = "CanvasConflictError";
  }
}
