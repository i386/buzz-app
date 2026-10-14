import { createRoot } from "react-dom/client";
import { RemindersPage } from "../../src/bundled/reminders/RemindersPage";
import type { Reminders } from "../../src/features/relay/reminders";
import type { RelayData } from "../../src/features/relay/service";
import type { Navigation } from "../../src/features/navigation/controller";
import "../../src/shared/styles/globals.css";

// The real Reminders page in a content region of `?width=` pixels, with one
// ordinary reminder and one whose note is a single unbroken word.
const width = Number(new URLSearchParams(location.search).get("width"));
const viewer = "a".repeat(64);
const now = Math.floor(Date.now() / 1000);
const target = (id: string) => ({
  eventId: id.repeat(64),
  channelId: "c",
  preview: "Follow up on the release checklist before the review",
  authorPubkey: viewer,
});
const state = Object.freeze({
  status: "ready" as const,
  hydrated: true,
  reminders: [
    {
      id: "ordinary",
      eventId: "e1",
      createdAt: now,
      notBefore: now - 60,
      status: "pending" as const,
      target: target("b"),
    },
    {
      id: "unbroken",
      eventId: "e2",
      createdAt: now,
      notBefore: now + 3600,
      status: "pending" as const,
      target: target("c"),
      note: "x".repeat(2000),
    },
  ],
});
const channelList = Object.freeze({
  status: "ready",
  channels: [{ id: "c", name: "release-planning", channelType: "stream" }],
});
const profiles = new Map([[viewer, { name: "Ada Lovelace" }]]);
const reminders = {
  snapshot: () => state,
  subscribe: () => () => {},
} as unknown as Reminders;
const connection = {
  status: "ready",
  scope: `https://community.example:${viewer}`,
  viewer,
  session: {
    reminders,
    channels: {
      ensureList: () => () => {},
      subscribeList: () => () => {},
      list: () => channelList,
    },
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: () => Promise.resolve(),
    },
    media: (url: string) => url,
  },
};
const relay = {
  snapshot: () => connection,
  subscribe: () => () => {},
} as unknown as RelayData;

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <div style={{ width, height: "100vh" }}>
    <RemindersPage
      relay={relay}
      navigator={{} as Navigation}
      clock={{ subscribe: () => () => {}, read: () => now }}
    />
  </div>,
);
