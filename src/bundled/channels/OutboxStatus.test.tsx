// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, assert, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createOutbox,
  type Outbox,
  type OutgoingEvent,
} from "../../features/relay/outbox";
import { keypair, signed } from "../../features/relay/testing";
import type { RelayWriter } from "../../features/relay/transport";
import { createRelayProfiler } from "../../features/relay/profiling";
import { sessionLinkMessage } from "../../features/sessions/share";
import { OutboxStatus } from "./OutboxStatus";

afterEach(cleanup);
const invitation = {
  event: {
    id: "invite",
    kind: 9000,
    content: "",
    tags: [["p", "a".repeat(64)]],
  },
  delivery: "failed",
} as OutgoingEvent;
function show(item: OutgoingEvent) {
  const retry = vi.fn();
  const items = [item];
  const outbox = {
    snapshot: () => items,
    subscribe: () => () => {},
    retry,
    dismiss: vi.fn(),
  } as unknown as Outbox;
  render(<OutboxStatus outbox={outbox} profiling={createRelayProfiler()} />);
  fireEvent.click(screen.getByText("Outbox · 1 items"));
  return retry;
}

it("does not offer generic retry for guarded invitations from either profile or composer", () => {
  const retry = show({ ...invitation, guarded: true });
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText(/Retry from the channel or agent profile/),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Remove from outbox" }),
  ).toBeVisible();
  expect(retry).not.toHaveBeenCalled();
});

it("does not show private feedback body or generic retry in the channel outbox", () => {
  const retry = vi.fn();
  const items = [
    {
      ...invitation,
      event: { ...invitation.event, kind: 42000, content: "private report" },
    },
  ];
  const outbox = {
    snapshot: () => items,
    subscribe: () => () => {},
    retry,
    dismiss: vi.fn(),
  } as unknown as Outbox;
  render(<OutboxStatus outbox={outbox} profiling={createRelayProfiler()} />);
  fireEvent.click(screen.getByText("Outbox · 0 items"));
  expect(screen.queryByText(/private report/)).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
  expect(retry).not.toHaveBeenCalled();
});

it("preserves generic retry for legacy unguarded invitations", () => {
  const retry = show(invitation);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledWith("invite");
});

// The recovery page deliberately has no source inventory or encoder: deleted
// agents and teams must not be needed to finish an already journaled delivery.
it.each(["agent", "team", "session"] as const)(
  "retries and acknowledges a restored %s share without its deleted source",
  async (kind) => {
    const viewer = keypair();
    let records: readonly OutgoingEvent[] = [];
    let failAcknowledgement = false;
    const storage = {
      load: () => structuredClone(records),
      save: (next: readonly OutgoingEvent[]) => {
        if (failAcknowledgement && next.some((item) => !item.recovery))
          throw new Error("Storage unavailable");
        records = structuredClone(next);
      },
    };
    const sign = vi.fn<RelayWriter["sign"]>(async (event) =>
      signed(viewer, event),
    );
    const interruptedPublish = vi.fn<RelayWriter["publish"]>(async () => {
      throw new Error("Receipt lost");
    });
    const first = createOutbox(
      viewer.pubkey,
      { sign, publish: interruptedPublish },
      storage,
    );
    let restored: ReturnType<typeof createOutbox> | undefined;
    try {
      await first.outbox.ready();
      const id = first.outbox.send(
        {
          kind: 9,
          content:
            kind === "session"
              ? sessionLinkMessage("deleted-source")
              : "Snapshot attachment",
          tags: [["h", "dm"]],
        },
        {
          key:
            kind === "session"
              ? "session-share-link:deleted-source:dm"
              : // Shares queued by the removed snapshot dialog.
                `snapshot-share:${kind}:deleted-source`,
          value:
            kind === "session"
              ? "1"
              : JSON.stringify({
                  people: [{ pubkey: "b".repeat(64), name: "Recipient" }],
                  level: "none",
                }),
        },
      );
      await waitFor(() => expect(records[0]?.delivery).toBe("unknown"));
      const original = interruptedPublish.mock.calls[0]?.[0];
      first.dispose(); // Interrupted dialog/session; source is no longer available.
      const publish = vi.fn<RelayWriter["publish"]>(async () => {});
      const restoredSign = vi.fn<RelayWriter["sign"]>(async (event) =>
        signed(viewer, event),
      );
      restored = createOutbox(
        viewer.pubkey,
        { sign: restoredSign, publish },
        storage,
      );
      await restored.outbox.ready();
      const outbox = restored.outbox;
      render(
        <OutboxStatus outbox={outbox} profiling={createRelayProfiler()} />,
      );
      fireEvent.click(screen.getByText("Outbox · 1 items"));
      fireEvent.click(
        screen.getByRole("button", { name: "Remove from outbox" }),
      );
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Confirm this message",
        ),
      );
      expect(outbox.snapshot()[0]?.event.id).toBe(id);
      expect(records[0]?.recovery).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(records[0]?.delivery).toBe("accepted"));
      expect(publish.mock.calls[0]?.[0]).toEqual(original);
      expect(restoredSign).not.toHaveBeenCalled();
      if (kind !== "agent") {
        const operation = outbox.snapshot()[0];
        assert.exists(operation);
        restored.observe([signed(viewer, operation.event)]);
      }
      failAcknowledgement = true;
      fireEvent.click(
        screen.getByRole("button", { name: "Remove from outbox" }),
      );
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Storage unavailable",
        ),
      );
      expect(outbox.snapshot()[0]?.recovery).toBeDefined();
      expect(records[0]?.recovery).toBeDefined();
      failAcknowledgement = false;
      fireEvent.click(
        screen.getByRole("button", { name: "Remove from outbox" }),
      );
      await waitFor(() =>
        expect(screen.getByText("Outbox · 0 items")).toBeInTheDocument(),
      );
      expect(records.every((item) => !item.recovery)).toBe(true);
      restored.dispose();
      restored = createOutbox(
        viewer.pubkey,
        { sign: restoredSign, publish },
        storage,
      );
      await restored.outbox.ready();
      expect(restored.outbox.snapshot()).toEqual([]);
      expect(publish).toHaveBeenCalledOnce();
    } finally {
      first.dispose();
      restored?.dispose();
    }
  },
);
