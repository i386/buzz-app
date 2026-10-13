// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationPresentation } from "../conversation/ConversationPresentation";
import {
  MessageReactionControls,
  MessageReactions,
  REACTION_PREVIEW_DELAY_MS,
} from "./MessageReactions";
import { createRelaySession } from "../relay/session";
import {
  flush,
  keypair,
  message,
  profile,
  roster,
  scriptedTransport,
  signed,
} from "../relay/testing";
import type { LiveCallbacks } from "../relay/live";
import type { RelayEvent } from "../relay/events";
import type {
  ComposerTool,
  ContributionReader,
  InlineRenderer,
  ReactionToolProps,
} from "../conversation/contracts";
import { PublishRejected } from "../relay/outbox";
import { useSyncExternalStore } from "react";

const viewer = keypair(),
  other = keypair(),
  relay = keypair();
const owners: { dispose(): void }[] = [];
beforeEach(() => {
  // jsdom hides [popover] but does not implement showPopover. Model opening
  // for content assertions; browser tests cover top-layer painting and clipping.
  HTMLElement.prototype.showPopover = function () {
    this.style.display = "block";
  };
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});
const registry = <T,>(
  entries: ReturnType<ContributionReader<T>["snapshot"]>,
): ContributionReader<T> => ({
  snapshot: () => entries,
  subscribe: () => () => {},
});
const inline = registry<InlineRenderer>([]);
const tools = registry<ComposerTool>([]);
const root = message(other, "c", "Message", 1);
const react = (key = viewer, time = 2) =>
  signed(key, {
    kind: 7,
    content: "👍",
    created_at: time,
    tags: [
      ["h", "c"],
      ["e", root.id],
    ],
  });
const customReaction = (key: typeof viewer, code: string, url: string) =>
  signed(key, {
    kind: 7,
    content: `:${code}:`,
    created_at: 2,
    tags: [
      ["h", "c"],
      ["e", root.id],
      ["emoji", code, url],
    ],
  });
function harness(
  events: RelayEvent[] = [],
  publish = vi.fn(async (_event: RelayEvent) => {}),
  pickerTools = tools,
  media?: (url: string, size?: "small") => string | undefined,
) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      ...(media ? { media } : {}),
      writer: { sign: async (template) => signed(viewer, template), publish },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.ensure("c");
  live.receive([roster(relay, "c", [viewer.pubkey], 1), root, ...events]);
  function Controls({ disabled = false }: { disabled?: boolean }) {
    const state = useSyncExternalStore(
      (fn) => owner.session.channels.subscribeWindow("c", fn),
      () => owner.session.channels.window("c"),
    );
    const row = state.rows[0];
    return (
      row && (
        <>
          <MessageReactionControls
            row={row}
            session={owner.session}
            scope="test"
            disabled={disabled}
            tools={pickerTools}
            inline={inline}
          />
          <MessageReactions
            row={row}
            session={owner.session}
            scope="test"
            disabled={disabled}
            tools={pickerTools}
            inline={inline}
          />
        </>
      )
    );
  }
  return { ...owner, live, wire, publish, Controls };
}
it("shows three shortcuts and groups distinct people while removing all own duplicates", async () => {
  const mine = react(),
    duplicate = react(viewer, 3),
    theirs = react(other);
  const h = harness([mine, duplicate, theirs]);
  render(<h.Controls />);
  expect(
    screen.getAllByRole("button", { name: /React with|Remove/ }),
  ).toHaveLength(3);
  const grouped = screen.getByRole("button", {
    name: "👍: 2 people, including you",
  });
  expect(grouped.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(grouped);
  const operation = h.session.outbox?.snapshot()[0];
  expect(operation?.event).toMatchObject({
    kind: 5,
    tags: expect.arrayContaining([
      ["e", mine.id],
      ["e", duplicate.id],
    ]),
  });
  expect(operation?.event.tags).not.toContainEqual(["e", theirs.id]);
  expect(
    screen
      .getByRole("button", { name: "👍: 1 person" })
      .getAttribute("aria-pressed"),
  ).toBe("false");
  await act(async () => {
    await flush();
    await flush();
  });
});
it("keeps failed first-reaction delivery visible and retries the same event", async () => {
  const publish = vi.fn(async (_event: RelayEvent) => {
    throw new PublishRejected("Nope");
  });
  const h = harness([], publish);
  render(<h.Controls />);
  fireEvent.click(screen.getByRole("button", { name: "React with ❤️" }));
  await act(async () => {
    await flush();
    await flush();
  });
  expect(screen.queryByRole("button", { name: /❤️: 1/ })).toBeNull();
  const original = publish.mock.calls[0]?.[0];
  publish.mockImplementation(async () => undefined as never);
  fireEvent.click(screen.getByRole("button", { name: "Retry reaction" }));
  await act(async () => {
    await flush();
    await flush();
  });
  expect(publish.mock.calls[1]?.[0]).toEqual(original);
});
it("prevents duplicate submissions and unavailable-message actions", async () => {
  const h = harness();
  const view = render(<h.Controls disabled />);
  fireEvent.click(screen.getByRole("button", { name: "React with 👍" }));
  expect(h.session.outbox?.snapshot()).toHaveLength(0);
  view.rerender(<h.Controls />);
  const button = screen.getByRole("button", { name: "React with 👍" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(h.session.outbox?.snapshot()).toHaveLength(1);
  await act(async () => {
    await flush();
    await flush();
  });
});

it("keeps pills visually active but rejects another click while delivery is pending or failed", async () => {
  let release!: () => void;
  const publish = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const h = harness([react(other)], publish);
  render(<h.Controls />);
  fireEvent.click(screen.getByRole("button", { name: "👍: 1 person" }));
  await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
  const pill = screen.getByRole("button", {
    name: "👍: 2 people, including you",
  });
  expect(pill.getAttribute("aria-disabled")).toBe("true");
  expect(pill.hasAttribute("disabled")).toBe(false);
  fireEvent.click(pill);
  expect(h.session.outbox?.snapshot()).toHaveLength(1);
  await act(async () => {
    release();
    await flush();
    await flush();
  });
  expect(pill.getAttribute("aria-disabled")).toBe("false");

  const failed = harness(
    [react(other)],
    vi.fn(async () => {
      throw new PublishRejected("Nope");
    }),
  );
  const failedView = render(<failed.Controls />);
  fireEvent.click(
    within(failedView.container).getByRole("button", { name: "👍: 1 person" }),
  );
  await act(async () => {
    await flush();
    await flush();
  });
  const failedPill = within(failedView.container).getByRole("button", {
    name: "👍: 1 person",
  });
  expect(failedPill.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(failedPill);
  expect(failed.session.outbox?.snapshot()).toHaveLength(1);
});

it("uses the picker catalog URL even when an old URL has my reaction", async () => {
  const oldUrl = "https://a.test/old.png";
  const newUrl = "https://a.test/new.png";
  const pickerTools = registry<ComposerTool>([
    {
      key: "picker",
      pluginId: "picker",
      revision: "one",
      id: "picker",
      title: "Picker",
      component: () => null,
      reactionComponent: ({ select }: ReactionToolProps) => (
        <button type="button" onClick={() => select(":party:")}>
          Choose party
        </button>
      ),
    },
  ]);
  const h = harness(
    [customReaction(viewer, "party", oldUrl)],
    undefined,
    pickerTools,
  );
  h.live.receive([
    signed(other, {
      kind: 30030,
      content: "",
      created_at: 3,
      tags: [
        ["d", "buzz:custom-emoji"],
        ["emoji", "party", newUrl],
      ],
    }),
  ]);
  render(<h.Controls />);
  fireEvent.click(
    within(screen.getByTestId("inline-add-reaction")).getByRole("button", {
      name: "Choose party",
    }),
  );
  const operation = h.session.outbox?.snapshot()[0];
  expect(operation?.event.kind).toBe(7);
  expect(operation?.event.tags).toContainEqual(["emoji", "party", newUrl]);
  const parties = screen.getAllByRole("button", {
    name: ":party:: 1 person, including you",
  });
  expect(parties).toHaveLength(2);
  expect(parties[0]?.querySelector("img")?.getAttribute("src")).toBe(oldUrl);
  expect(parties[1]?.querySelector("img")?.getAttribute("src")).toBe(newUrl);
  await act(async () => {
    await flush();
    await flush();
  });
});

it("uses the original animated emoji in reaction pills and previews", async () => {
  const url = "https://a.test/eyes-intensifies.gif";
  const media = vi.fn((source: string, size?: "small") =>
    size === "small" ? source.replace(/\.gif$/, ".thumb.jpg") : source,
  );
  const h = harness(
    [customReaction(other, "eyes-intensifies", url)],
    undefined,
    tools,
    media,
  );
  render(<h.Controls />);
  const pill = screen.getByRole("button", {
    name: ":eyes-intensifies:: 1 person",
  });
  expect(pill.querySelector("img")?.getAttribute("src")).toBe(url);
  fireEvent.mouseEnter(pill);
  const preview = await screen.findByRole("tooltip", {}, { timeout: 2500 });
  expect(preview.querySelector("img")?.getAttribute("src")).toBe(url);
  expect(media).not.toHaveBeenCalledWith(url, "small");
});

it("loads names for people who only reacted after a preview opens", async () => {
  const h = harness([react(other)]);
  render(<h.Controls />);
  const pill = screen.getByRole("button", { name: "👍: 1 person" });
  fireEvent.mouseEnter(pill);
  await screen.findByText(other.pubkey.slice(0, 10), {}, { timeout: 2500 });
  await waitFor(() =>
    expect(
      h.wire.pending.some((entry) => entry.filters[0]?.kinds?.includes(0)),
    ).toBe(true),
  );
  const pending = h.wire.pending.find((entry) =>
    entry.filters[0]?.kinds?.includes(0),
  );
  expect(pending?.filters).toEqual([
    { kinds: [0], authors: [other.pubkey], limit: 500 },
  ]);
  await act(async () => {
    pending?.respond([profile(other, { name: "Fresh Reactor" })]);
    await flush();
  });
  await waitFor(() => expect(screen.getByText("Fresh Reactor")).toBeTruthy(), {
    timeout: 2500,
  });
});

it("shows custom shortcodes in pills and previews when media is refused or fails", async () => {
  const h = harness(
    [
      customReaction(other, "denied", "https://a.test/denied.png"),
      customReaction(other, "broken", "https://a.test/broken.png"),
    ],
    undefined,
    tools,
    (url) => (url.includes("denied") ? undefined : url),
  );
  render(<h.Controls />);
  const denied = screen.getByRole("button", { name: ":denied:: 1 person" });
  const broken = screen.getByRole("button", { name: ":broken:: 1 person" });
  expect(denied.textContent).toContain(":denied:");
  const image = broken.querySelector("img");
  if (!image) throw new Error("Custom reaction image missing");
  fireEvent.error(image);
  expect(broken.textContent).toContain(":broken:");
  fireEvent.mouseEnter(denied);
  const preview = await screen.findByRole("tooltip", {}, { timeout: 2500 });
  expect(preview.textContent).toContain(":denied:");
  fireEvent.mouseLeave(denied);
  fireEvent.mouseEnter(broken);
  await waitFor(
    () =>
      expect(
        screen
          .queryAllByRole("tooltip")
          .some((item) => item.textContent?.includes(":broken:")),
      ).toBe(true),
    { timeout: 2500 },
  );
});

it("forwards the contributed picker into true toggles and releases confirmed writes without an echo", async () => {
  const pickerTools = registry<ComposerTool>([
    {
      key: "picker",
      pluginId: "picker",
      revision: "one",
      id: "picker",
      title: "Picker",
      component: () => null,
      reactionComponent: ({ select, disabled }: ReactionToolProps) => (
        <button type="button" disabled={disabled} onClick={() => select("👍")}>
          Choose from picker
        </button>
      ),
    },
  ]);
  const h = harness([react()], undefined, pickerTools);
  render(<h.Controls />);
  const picker = screen.getAllByRole("button", {
    name: "Choose from picker",
  })[0];
  if (!picker) throw new Error("Picker control missing");
  fireEvent.click(picker);
  expect(h.session.outbox?.snapshot()[0]?.event.kind).toBe(5);
  await act(async () => {
    await flush();
    await flush();
  });
  expect(h.session.outbox?.snapshot()[0]?.delivery).toBe("accepted");
  expect(screen.queryByRole("button", { name: /👍: 1/ })).toBeNull();
  fireEvent.click(picker);
  expect(h.session.outbox?.snapshot().map((item) => item.event.kind)).toEqual([
    5, 7,
  ]);
  await act(async () => {
    await flush();
    await flush();
  });
});

it("rolls back a failed last-reaction removal and retries it after remount", async () => {
  const publish = vi.fn(async (_event: RelayEvent) => {
    throw new PublishRejected("Nope");
  });
  const h = harness([react()], publish);
  const view = render(<h.Controls />);
  fireEvent.click(
    screen.getByRole("button", { name: "👍: 1 person, including you" }),
  );
  expect(screen.queryByRole("button", { name: /👍: 1/ })).toBeNull();
  await act(async () => {
    await flush();
    await flush();
  });
  expect(
    screen.getByRole("button", { name: "👍: 1 person, including you" }),
  ).toBeTruthy();
  view.unmount();
  render(<h.Controls />);
  expect(
    screen.getAllByRole("button", { name: "Retry reaction" }),
  ).toHaveLength(1);
  const original = publish.mock.calls[0]?.[0];
  publish.mockImplementation(async () => undefined as never);
  fireEvent.click(screen.getByRole("button", { name: "Retry reaction" }));
  await act(async () => {
    await flush();
    await flush();
  });
  expect(publish.mock.calls[1]?.[0]).toEqual(original);
  expect(screen.queryByRole("button", { name: /👍: 1/ })).toBeNull();
});

it("retires reaction previews while retaining the reaction delivery owner", async () => {
  const h = harness([react(other)]);
  vi.useFakeTimers();
  try {
    const tree = (active: boolean) => (
      <ConversationPresentation value={active}>
        <div hidden={!active} inert={!active}>
          <h.Controls />
        </div>
      </ConversationPresentation>
    );
    const view = render(tree(true));
    fireEvent.mouseEnter(screen.getByRole("button", { name: "👍: 1 person" }));
    await act(() => vi.advanceTimersByTimeAsync(REACTION_PREVIEW_DELAY_MS));
    expect(screen.getByRole("tooltip")).toBeTruthy();
    const reactions = screen.getByTestId("reaction-row");
    view.rerender(tree(false));
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    expect(screen.getByTestId("reaction-row")).toBe(reactions);
    view.rerender(tree(true));
    await act(() => vi.runOnlyPendingTimersAsync());
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    expect(h.publish).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("opens the reactor preview after a short hover, not a long dwell", async () => {
  const h = harness([react(other)]);
  vi.useFakeTimers();
  try {
    render(<h.Controls />);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "👍: 1 person" }));
    await act(() => vi.advanceTimersByTimeAsync(99));
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole("tooltip")).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});
