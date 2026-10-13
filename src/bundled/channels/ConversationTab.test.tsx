// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { RelayEvent } from "../../features/relay/events";
import { createOutbox, type OutgoingEvent } from "../../features/relay/outbox";
import { keypair, signed } from "../../features/relay/testing";
import { ConversationTab } from "./ConversationTab";

// Exercise the real tab recovery owner and durable outbox without mounting the
// independent timelines/composers. Recovery must work with no editor mounted.
vi.mock("../../features/messages/ThreadPanel", () => ({
  ThreadPanel: ({
    active,
    replyRequest,
  }: {
    active: boolean;
    replyRequest?: number;
  }) => (
    <aside data-active={active} data-reply-request={replyRequest}>
      Thread content
    </aside>
  ),
}));
vi.mock("./ChannelBody", () => ({
  ChannelBody: () => <div>Conversation content</div>,
}));
vi.mock("../../features/messages/MessageComposer", () => ({
  MessageComposer: () => <div>Composer content</div>,
}));
const owners: ReturnType<typeof createOutbox>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
});

it.each(["thread", "conversation"] as const)(
  "%s tabs recover failed edits outside the editor and only for their channel",
  async (kind) => {
    const viewer = keypair();
    const edit = (channel: string, content: string) =>
      signed(viewer, {
        kind: 40003,
        created_at: 1700000001,
        content,
        tags: [
          ["h", channel],
          ["e", "a".repeat(64)],
        ],
      });
    const retry = edit("beta", "Retry this correction");
    const discard = edit("beta", "Discard this correction");
    const unrelated = edit("alpha", "Other channel correction");
    let stored: readonly OutgoingEvent[] = [retry, discard, unrelated].map(
      (event) => ({
        event,
        signed: event,
        delivery: "failed",
        error: "Edit refused",
      }),
    );
    const publish = vi.fn(async (_event: RelayEvent) => {});
    const owner = createOutbox(
      viewer.pubkey,
      { kinds: [40003], sign: async (event) => signed(viewer, event), publish },
      {
        load: async () => stored,
        save: (next) => {
          stored = next;
        },
      },
    );
    owners.push(owner);
    await owner.outbox.ready();
    const channels = {
      status: "ready",
      channels: [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
      ],
    };
    // Only management consumes this session; the independent child views above
    // are stubbed, so the fixture supplies just its list and outbox boundary.
    const session = {
      outbox: owner.outbox,
      channels: { list: () => channels, subscribeList: () => () => {} },
    } as unknown as RelaySession;
    render(
      <ConversationTab
        active
        tab={{
          id: "beta-tab",
          kind,
          channelId: "beta",
          messageId: "a".repeat(64),
        }}
        channel={{ id: "beta", name: "Beta" }}
        session={session}
        scope="recovery-test"
        openLink={() => false}
        canOpenLink={() => false}
        openThread={() => {}}
        close={() => {}}
      />,
    );
    const notices = screen.getAllByRole("status");
    expect(notices).toHaveLength(2);
    expect(screen.queryByText(unrelated.content)).not.toBeInTheDocument();
    const retryNotice = notices.find((notice) =>
      notice.textContent?.includes(retry.content),
    );
    assert.exists(retryNotice);
    fireEvent.click(
      within(retryNotice).getByRole("button", { name: "Retry message update" }),
    );
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0]?.[0]).toEqual(retry);
    await waitFor(() =>
      expect(screen.queryByText(retry.content)).not.toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Discard failed update" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("status")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(stored.map((item) => [item.event.id, item.delivery])).toEqual([
        [retry.id, "accepted"],
        [unrelated.id, "failed"],
      ]),
    );
    expect(publish).toHaveBeenCalledTimes(1);
  },
);

it.each(["thread", "conversation"] as const)(
  "%s tabs hold an unread visit only while active and retain their content",
  (kind) => {
    const channel = { id: "beta", name: "Beta", members: ["viewer"] };
    const snapshot = { status: "ready", channels: [channel] };
    const enterChannel = vi.fn(async () => {});
    const leaveChannel = vi.fn();
    const session = {
      viewer: "viewer",
      channels: { list: () => snapshot, subscribeList: () => () => {} },
      unread: { enterChannel, leaveChannel },
    } as unknown as RelaySession;
    const props = {
      tab: {
        id: "beta-tab",
        kind,
        channelId: "beta",
        messageId: "a".repeat(64),
      },
      channel,
      session,
      scope: "visit-test",
      openLink: () => false,
      canOpenLink: () => false,
      openThread: () => {},
      close: () => {},
    };
    const mounted = render(<ConversationTab {...props} active={false} />);
    const content = screen.getByLabelText("Conversation in Beta");
    expect(enterChannel).not.toHaveBeenCalled();
    if (kind === "thread")
      expect(screen.getByText("Thread content")).toHaveAttribute(
        "data-active",
        "false",
      );
    mounted.rerender(<ConversationTab {...props} active />);
    expect(enterChannel).toHaveBeenCalledExactlyOnceWith("beta");
    if (kind === "thread")
      expect(screen.getByText("Thread content")).toHaveAttribute(
        "data-active",
        "true",
      );
    mounted.rerender(<ConversationTab {...props} active={false} />);
    expect(leaveChannel).toHaveBeenCalledExactlyOnceWith("beta");
    expect(screen.getByLabelText("Conversation in Beta")).toBe(content);
    mounted.rerender(<ConversationTab {...props} active />);
    expect(enterChannel).toHaveBeenCalledTimes(2);
    mounted.unmount();
    expect(leaveChannel).toHaveBeenCalledTimes(2);
  },
);

it.each([false, true])(
  "restored Reply intent is not replayed but fresh requests are delivered (focusOnMount=%s)",
  (focusOnMount) => {
    const channel = { id: "beta", name: "Beta" };
    const snapshot = { status: "ready", channels: [channel] };
    const session = {
      channels: { list: () => snapshot, subscribeList: () => () => {} },
    } as unknown as RelaySession;
    const tab = {
      id: "thread",
      kind: "thread" as const,
      channelId: "beta",
      messageId: "a".repeat(64),
      replyRequest: 1,
    };
    const props = {
      tab,
      channel,
      session,
      scope: "focus-test",
      active: true,
      focusOnMount,
      openLink: () => false,
      canOpenLink: () => false,
      openThread: () => {},
      close: () => {},
    };
    const mounted = render(<ConversationTab {...props} />);
    const thread = screen.getByText("Thread content");
    if (focusOnMount) expect(thread).toHaveAttribute("data-reply-request", "1");
    else expect(thread).not.toHaveAttribute("data-reply-request");
    mounted.rerender(<ConversationTab {...props} focusOnMount />);
    if (!focusOnMount) expect(thread).not.toHaveAttribute("data-reply-request");
    mounted.rerender(
      <ConversationTab {...props} tab={{ ...tab, replyRequest: undefined }} />,
    );
    expect(thread).not.toHaveAttribute("data-reply-request");
    // A non-Reply opening resets the sequence; a later Reply may reuse number 1.
    mounted.rerender(<ConversationTab {...props} tab={{ ...tab }} />);
    expect(thread).toHaveAttribute("data-reply-request", "1");
  },
);
