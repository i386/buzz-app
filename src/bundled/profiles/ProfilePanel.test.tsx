// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import userEvent from "@testing-library/user-event";
import { createAgentActivity } from "../../features/agents/activity";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import { bindNames } from "../../features/identity-names/service";
import {
  profileTarget,
  profileActivityViewTarget,
} from "../../features/profiles/target";
import { Context } from "@deepseek-ai/cordis";
import { PanelsService } from "../../features/panels/service";
import {
  activitySelection,
  activityTarget,
} from "../../features/agents/activity-target";
import { ActivityPanel } from "../agent-activity/ActivityPanel";
import { ProfilePanel } from "./ProfilePanel";

import { agentDirectory } from "../../features/identity-names/testing";
import type { LiveCallbacks } from "../../features/relay/live";
import { keypair, profile } from "../../features/relay/testing";

const key = "a".repeat(64);
afterEach(cleanup);
it("updates a mounted profile from the shared name view without replacing its identity", async () => {
  let name = "Local name";
  let notify = () => {};
  const owner = createRelaySession(null, {
    identityNames: {
      register() {},
      bind(source) {
        return bindNames(source, {
          snapshot: () => [
            {
              id: "test",
              activate() {
                return undefined;
              },
              scope: () => () => ({ name }),
            },
          ],
          subscribe(listener) {
            notify = listener;
            return () => {};
          },
        });
      },
    },
  });
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    session: owner.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  try {
    const presenceStatus = vi
      .spyOn(owner.session.presence, "status")
      .mockReturnValue("online");
    render(
      <ProfilePanel
        relay={relay}
        target={profileTarget(key) ?? ""}
        close={() => {}}
      />,
    );
    expect(await screen.findByRole("heading", { name })).toBeTruthy();
    expect(screen.queryByRole("img", { name: /^Presence:/ })).toBeNull();
    expect(screen.getByText("Active", { exact: true })).toBeVisible();
    expect(
      screen.getAllByRole("img", { name: `${name} avatar, online` }),
    ).toHaveLength(1);
    expect(document.querySelector(".buzz-avatar-status")).toHaveAttribute(
      "data-status",
      "online",
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Channels" }));
    expect(
      screen.getByRole("img", { name: `${name} avatar, online` }),
    ).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Presence: Active" })).toBeNull();
    expect(screen.getByText("Active", { exact: true })).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Info" }));
    expect(screen.queryByRole("img", { name: /^Presence:/ })).toBeNull();
    expect(screen.getByText("Active", { exact: true })).toBeVisible();
    expect(
      screen.getAllByRole("img", { name: `${name} avatar, online` }),
    ).toHaveLength(1);
    act(() => {
      name = "Edited name";
      notify();
    });
    expect(screen.getByRole("heading", { name })).toBeTruthy();
    for (const [status, label] of [
      ["away", "Away"],
      ["offline", "Offline"],
    ] as const) {
      presenceStatus.mockReturnValue(status);
      act(() => {
        name = `${label} name`;
        notify();
      });
      expect(screen.getByText(label, { exact: true })).toBeVisible();
      expect(
        screen.getByRole("img", { name: `${name} avatar, ${status}` }),
      ).toBeTruthy();
      expect(screen.queryByText("Active", { exact: true })).toBeNull();
    }
    presenceStatus.mockReturnValue("unknown");
    act(() => {
      name = "Unknown status name";
      notify();
    });
    expect(screen.getByRole("img", { name: `${name} avatar` })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Presence: Active" })).toBeNull();
    expect(document.querySelector(".buzz-avatar-status")).not.toHaveAttribute(
      "data-status",
    );
    expect(screen.queryByText(/^(Active|Away|Offline)$/)).toBeNull();
    expect(owner.session.profiles.snapshot().size).toBe(0);
  } finally {
    vi.useRealTimers();
    cleanup();
    owner.dispose();
  }
});

it("recovers provider-owned names in the same live session and releases demand when disabled", async () => {
  const person = keypair();
  const relayKey = keypair();
  const publicProfile = profile(person, { name: "Public Carl" });
  let live!: LiveCallbacks;
  let entries = [agentDirectory];
  let changed = () => {};
  const read = vi.fn(async () => ({
    definitions: [],
    identities: [{ pubkey: person.pubkey, name: "Configured Carl" }],
  }));
  const owner = createRelaySession(
    {
      viewer: person.pubkey,
      relayAuthor: relayKey.pubkey,
      scope: "wss://relay.example.test",
      query: async (filters) =>
        filters.some((filter) => filter.kinds?.includes(0))
          ? [publicProfile]
          : [],
      media: () => undefined,
      readAgentLibrary: read,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      identityNames: {
        register() {},
        bind(source) {
          return bindNames(source, {
            snapshot: () => entries,
            subscribe(listener) {
              changed = listener;
              return () => {};
            },
          });
        },
      },
    },
  );
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    session: owner.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const reconnect = () => {
    live.state({ status: "retrying", routes: [] });
    live.state({ status: "connected", routes: [] });
    live.established();
  };
  try {
    owner.session.channels.ensureList();
    await waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    render(
      <ProfilePanel
        relay={relay}
        target={profileTarget(person.pubkey) ?? ""}
        close={() => {}}
      />,
    );
    await screen.findByRole("heading", { name: "Configured Carl" });
    await waitFor(() =>
      expect(owner.session.profiles.snapshot().get(person.pubkey)?.name).toBe(
        "Public Carl",
      ),
    );
    act(() => live.state({ status: "connected", routes: [] }));
    act(() => live.state({ status: "retrying", routes: [] }));
    expect(screen.getByRole("heading", { name: "Public Carl" })).toBeTruthy();
    expect(owner.session.agentLibrary.snapshot().status).toBe("idle");
    expect(read).toHaveBeenCalledTimes(1);
    act(() => {
      live.state({ status: "connected", routes: [] });
      live.established();
    });
    await screen.findByRole("heading", { name: "Configured Carl" });
    expect(read).toHaveBeenCalledTimes(2);
    vi.useFakeTimers();
    act(() => {
      entries = [];
      changed();
      reconnect();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    vi.useRealTimers();
    expect(screen.getByRole("heading", { name: "Public Carl" })).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(2);
    act(() => {
      entries = [agentDirectory];
      changed();
    });
    await screen.findByRole("heading", { name: "Configured Carl" });
    expect(read).toHaveBeenCalledTimes(3);
    owner.dispose();
    act(reconnect);
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
    cleanup();
    owner.dispose();
  }
});

it("offers the activity preview to known agents only, never to people", async () => {
  const person = keypair();
  const agent = keypair();
  const localAgent = keypair();
  const activity = createAgentActivity(true, vi.fn(), () => true);
  const owner = createRelaySession({
    viewer: key,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => [
      profile(person, { name: "Plain person" }),
      profile(agent, { name: "Declared agent", is_agent: true }),
      profile(localAgent, { name: "Local agent" }),
    ],
    readAgentLibrary: async () => ({
      definitions: [],
      identities: [{ pubkey: localAgent.pubkey, name: "Local agent" }],
    }),
  });
  const release = activity.queries.activate();
  activity.state({
    status: "connected",
    routes: [{ id: "observer", status: "live", replay: "unknown" }],
  });
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope: `https://relay.example.test:${key}`,
    viewer: key,
    session: { ...owner.session, agentActivity: activity.queries },
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const context = {
    channelId: "channel-a",
    canOpen: () => true,
    open: () => true,
  };
  const view = (pubkey: string) => (
    <ProfilePanel
      relay={relay}
      target={profileTarget(pubkey) ?? ""}
      context={context}
      close={() => {}}
    />
  );
  try {
    const mounted = render(view(person.pubkey));
    // The settled metadata read is the barrier: no agent evidence can follow it.
    await screen.findByRole("heading", { name: "Plain person" });
    expect(
      screen.queryByRole("region", { name: "Activity preview" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "View activity" }),
    ).not.toBeInTheDocument();
    mounted.rerender(view(agent.pubkey));
    await screen.findByRole("heading", { name: "Declared agent" });
    expect(
      await screen.findByRole("region", { name: "Activity preview" }),
    ).toHaveTextContent("No activity yet");
    expect(screen.getByRole("button", { name: "View activity" })).toBeEnabled();
    mounted.rerender(view(localAgent.pubkey));
    await screen.findByRole("heading", { name: "Local agent" });
    await act(() => owner.session.agentChoices.refresh());
    expect(owner.session.agentChoices.snapshot().identities).toEqual([
      expect.objectContaining({ pubkey: localAgent.pubkey }),
    ]);
    expect(
      owner.session.profiles.snapshot().get(localAgent.pubkey)?.isAgent,
    ).not.toBe(true);
    expect(
      await screen.findByRole("region", { name: "Activity preview" }),
    ).toHaveTextContent("No activity yet");
    expect(screen.getByRole("button", { name: "View activity" })).toBeEnabled();
  } finally {
    cleanup();
    release();
    activity.dispose();
    owner.dispose();
  }
});

it("exposes thinking through the named profile avatar across tabs", async () => {
  const agent = keypair();
  const owner = createRelaySession({
    viewer: key,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => [
      profile(agent, { name: "Thinking agent", is_agent: true }),
    ],
  });
  await owner.session.profiles.ensure([agent.pubkey]);
  vi.spyOn(owner.session.presence, "status").mockReturnValue("online");
  let activity = owner.session.agentActivity.snapshot();
  const listeners = new Set<() => void>();
  const session = {
    ...owner.session,
    agentActivity: {
      ...owner.session.agentActivity,
      snapshot: () => activity,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
  const snapshot = { status: "ready" as const, generation: 1, session };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  try {
    render(
      <ProfilePanel
        relay={relay}
        target={profileTarget(agent.pubkey) ?? ""}
        close={() => {}}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Thinking agent" }),
    ).toBeTruthy();
    const details = screen.getByRole("region", { name: "Profile details" });
    expect(details).not.toHaveAccessibleDescription();
    expect(
      screen.getByRole("img", { name: "Thinking agent avatar, available" }),
    ).toBeVisible();
    act(() => {
      activity = {
        ...activity,
        turns: [
          {
            agent: agent.pubkey,
            channelId: "alpha",
            turnId: "one",
            timestamp: 0,
            state: "working",
          },
        ],
      };
      for (const listener of listeners) listener();
    });
    expect(details).not.toHaveAccessibleDescription();
    expect(
      screen.getByRole("img", { name: "Thinking agent avatar, thinking" }),
    ).toBeVisible();
    expect(screen.getByText("Active", { exact: true })).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole("tab", { name: "Channels" }));
    // The first channel list changes access, which clears cached profiles;
    // the rest of the app reads them again.
    await act(() => owner.session.profiles.ensure([agent.pubkey]));
    expect(
      screen.getByRole("img", { name: "Thinking agent avatar, thinking" }),
    ).toBeVisible();
    expect(screen.getByText("Active", { exact: true })).toBeVisible();
    act(() => {
      activity = { ...activity, turns: [] };
      for (const listener of listeners) listener();
    });
    expect(details).not.toHaveAccessibleDescription();
    expect(
      screen.getByRole("img", { name: "Thinking agent avatar, available" }),
    ).toBeVisible();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("opens profile Activity in its originating channel and retires a disabled contribution", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const panels = new PanelsService(root);
  const owner = createRelaySession(null);
  const activity = createAgentActivity(
    true,
    () => {},
    () => true,
  );
  const activate = vi.fn(activity.queries.activate);
  const session = {
    ...owner.session,
    agentActivity: { ...activity.queries, activate },
  };
  const snapshot = { status: "ready" as const, generation: 1, session };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const scope = root.extend({
    pluginOwner: { id: "activity", revision: "one" },
  });
  const fiber = scope.plugin((ctx) =>
    ctx.panels.register({
      id: "activity",
      title: "Activity",
      matches: (target) => !!activitySelection(target),
      component: (props) => <ActivityPanel {...props} relay={relay} />,
    }),
  );
  await fiber.await();
  const context = {
    channelId: "originating-channel",
    canOpen: (target: string) => !!panels.resolve(target),
    open: vi.fn(() => true),
  };
  try {
    const view = render(
      <ProfilePanel
        relay={relay}
        panels={panels}
        target={profileActivityViewTarget(key) ?? ""}
        context={context}
        close={() => {}}
      />,
    );
    expect(
      screen.getByRole("tab", { name: "Activity", selected: true }),
    ).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "Conversation" }),
    ).toHaveTextContent("originating-channel");
    expect(screen.getByText(key, { exact: true })).toBeVisible();
    expect(activate).not.toHaveBeenCalled();
    await act(() => fiber.dispose());
    expect(
      screen.queryByRole("tab", { name: "Activity" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Agent activity" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Info", selected: true }),
    ).toBeVisible();

    const replacement = root.extend({
      pluginOwner: { id: "activity", revision: "two" },
    });
    await act(async () => {
      await replacement
        .plugin((ctx) =>
          ctx.panels.register({
            id: "activity",
            title: "Activity",
            matches: (target) => !!activitySelection(target),
            component: ({ target }) => <p>Replacement: {target}</p>,
          }),
        )
        .await();
    });
    expect(
      screen.getByRole("tab", { name: "Info", selected: true }),
    ).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole("tab", { name: "Activity" }));
    expect(
      screen.getByText(
        `Replacement: ${activityTarget(key, context.channelId)}`,
      ),
    ).toBeVisible();
    view.rerender(
      <ProfilePanel
        relay={relay}
        panels={panels}
        target={profileActivityViewTarget(key) ?? ""}
        close={() => {}}
      />,
    );
    expect(
      screen.queryByRole("tab", { name: "Activity" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/^Replacement:/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Info", selected: true }),
    ).toBeVisible();
    expect(activate).not.toHaveBeenCalled();
  } finally {
    cleanup();
    owner.dispose();
    activity.dispose();
    await root.fiber.dispose();
  }
});
