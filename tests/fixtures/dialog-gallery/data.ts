import type {
  Communities,
  ClientSnapshot,
} from "../../../src/features/communities/service";
import { createRelaySession } from "../../../src/features/relay/session";
import {
  keypair,
  signed,
  profile,
  metadata,
  roster,
  message,
} from "../../../src/features/relay/testing";

const viewer = keypair();
const relay = keypair();
const imageUrl = "https://fixture.example.test/attachment.png";
export const attachment = {
  url: imageUrl,
  kind: "image" as const,
  dimensions: { width: 564, height: 1002 },
};
export const sampleImage = "/shell-gradient.png";

/** Every community request is answered in this frame, including writes. */
export function installCommunityFixture() {
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      location.href,
    );
    if (url.origin !== location.origin)
      throw new Error("This gallery uses local fixture data only.");
    if (!url.pathname.startsWith("/api/")) return original(input, init);
    const route = url.pathname.split("/").at(-1);
    if (route === "register") return Response.json({});
    if (route === "info")
      return Response.json({
        name: "Design studio",
        policy: {
          version: "preview",
          terms_markdown: "Preview terms",
          privacy_markdown: "Preview privacy",
          age_attestation_required: true,
        },
      });
    if (route === "session")
      return Response.json({
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        relayUrl: "wss://relay.example.test",
        live: false,
      });
    if (route === "query") return Response.json([]);
    if (route === "accept-policy")
      return Response.json({ receipt: "local-preview" });
    if (route === "claim") return Response.json({ status: "joined" });
    if (route === "profile")
      return Response.json({ accepted: true, event_id: "preview-profile" });
    throw new Error(`Unconfigured gallery request: ${url.pathname}`);
  };
}

export function communityFixture(): Communities {
  let state: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    viewer: viewer.pubkey,
    profile: { name: "Alex Morgan", picture: "" },
    selected: "https://relay.example.test",
    memberships: [
      {
        id: "https://relay.example.test",
        name: "Design studio",
        icon: sampleImage,
      },
      { id: "https://team.example.test", name: "Product team" },
    ],
  };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<ClientSnapshot>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    select: (selected) => update({ selected }),
    saveProfile: (profile) => update({ profile }),
    joined: (membership) =>
      update({
        memberships: [...state.memberships, membership],
        selected: membership.id,
      }),
    relay: {
      snapshot: () => {
        throw new Error("The dialog gallery has no connected community relay.");
      },
      subscribe: () => () => {},
      retry() {},
      disconnect() {},
      clearCache: async () => {},
    },
  };
}

export function mediaFixture() {
  const root = signed(viewer, {
    kind: 9,
    content: "A direction for our next release.",
    tags: [
      ["h", "studio"],
      ["imeta", `url ${imageUrl}`, "m image/png"],
    ],
  });
  const reply = message(
    viewer,
    "studio",
    "I like the quieter background. Let's compare it in dark mode too.",
    root.created_at + 1,
    [["e", root.id, "", "reply"]],
  );
  const events = [
    root,
    reply,
    profile(viewer, { name: "Alex Morgan" }),
    roster(relay, "studio", [viewer.pubkey]),
    metadata(relay, "studio", "Design studio"),
  ];
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: (url) => (url === imageUrl ? sampleImage : undefined),
    async query(filters) {
      return events.filter((event) =>
        filters.some(
          (filter) =>
            (!filter.kinds || filter.kinds.includes(event.kind)) &&
            (!filter.ids || filter.ids.includes(event.id)) &&
            (!filter.authors || filter.authors.includes(event.pubkey)) &&
            (filter.thread_cursor === undefined ||
              event.created_at > filter.thread_cursor ||
              (event.created_at === filter.thread_cursor &&
                event.id > (filter.thread_cursor_id ?? ""))) &&
            (!filter["#e"] ||
              event.tags.some(
                ([key, value]) =>
                  key === "e" &&
                  value !== undefined &&
                  filter["#e"]?.includes(value),
              )),
        ),
      );
    },
  });
  return { owner, root };
}
