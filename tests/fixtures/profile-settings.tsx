import { finalizeEvent, getPublicKey } from "nostr-tools";
import { Context } from "@deepseek-ai/cordis";
import { createCommunities } from "../../src/features/communities/service";
import { ProfileButton } from "../../src/app/shell/ProfileButton";
import type { AccountActionsService } from "../../src/features/account-actions/service";
import { ProfileSettings } from "../../src/app/ProfileSettings";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import { communityDestination } from "../../src/features/communities/destination";
import { avatarMediaFixture } from "./avatar-media";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../../src/shared/design-system/ui/Button";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import "../../src/shared/styles/globals.css";

// Deliberately public test key, never an account credential.
const profileKey = new Uint8Array(32).fill(7);
const profileViewer = getPublicKey(profileKey);
const profiles = new Map<string, ReturnType<typeof finalizeEvent>>();
for (const id of ["https://relay.example.test", "https://other.example.test"]) {
  profiles.set(
    id,
    finalizeEvent(
      {
        kind: 0,
        tags: [],
        created_at: 1,
        content: JSON.stringify({
          name: "Fixture human",
          about: "This field must survive avatar editing.",
          picture: "",
        }),
      },
      profileKey,
    ),
  );
}
localStorage.setItem(
  `buzz-client.v1:${profileViewer}`,
  JSON.stringify({
    profile: { name: "Local default", picture: "" },
    memberships: [
      { id: "https://relay.example.test", name: "Fixture community" },
      { id: "https://other.example.test", name: "Other community" },
    ],
    selected: "https://relay.example.test",
  }),
);
const media = avatarMediaFixture();
const networkFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input);
  const upload = await media.request(url, init);
  if (upload) return upload;
  if (url.endsWith("/register"))
    return Response.json(
      communityDestination(JSON.parse(String(init?.body)).url),
    );
  const id = decodeURIComponent(url.split("/")[3] ?? "");
  if (url.endsWith("/identity"))
    return Response.json({ viewer: profileViewer });
  if (url.endsWith("/info")) return Response.json({ name: id, policy: null });
  if (url.endsWith("/session"))
    return Response.json({
      viewer: profileViewer,
      relayAuthor: "ef".repeat(32),
      relayUrl: id,
      attachmentUploads: true,
    });
  if (url.endsWith("/query")) {
    const filters = JSON.parse(String(init?.body)) as {
      kinds?: number[];
      authors?: string[];
    }[];
    // Profile reads for discovered inventory identities stay routable too.
    if (!filters.some((filter) => filter.authors?.includes(profileViewer)))
      return networkFetch(input, init);
    return Response.json(
      filters.some((filter) => filter.kinds?.includes(0)) && profiles.has(id)
        ? [profiles.get(id)]
        : [],
    );
  }
  if (url.endsWith("/profile")) {
    const { name, picture, about, existing } = JSON.parse(String(init?.body));
    const event = finalizeEvent(
      {
        kind: 0,
        tags: [],
        created_at: (profiles.get(id)?.created_at ?? 0) + 1,
        content: JSON.stringify({
          ...existing,
          name,
          display_name: name,
          picture,
          about,
        }),
      },
      profileKey,
    );
    profiles.set(id, event);
    return Response.json({ accepted: true, event_id: event.id });
  }
  // Inventory reads stay on the network so browser tests can route them.
  if (url.endsWith("/agent-inventory")) return networkFetch(input, init);
  throw new Error(`Unexpected fixture request: ${url}`);
};
// Only this fixture rewrites image display to local blobs; production stores raw URLs.
const imageObserver = new MutationObserver(() => {
  for (const image of document.querySelectorAll("img")) {
    const src = image.getAttribute("src") ?? "";
    if (!src.startsWith("/api/relay/")) continue;
    const file = media.display(
      new URL(src, location.origin).searchParams.get("url") ?? "",
    );
    if (file) image.src = URL.createObjectURL(file);
  }
});
imageObserver.observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ["src"],
});
const noActions: readonly [] = [];
const accountActions = {
  subscribe: () => () => {},
  snapshot: () => noActions,
} as unknown as AccountActionsService;
const communities = createCommunities(new Context(), true);
Object.assign(window, { avatarProfileFixture: { profiles, communities } });
function Fixture() {
  useKeyboardFocusVisibility();
  const [human, setHuman] = useState(false);
  return (
    <main
      data-buzz-ui=""
      className="mx-auto max-w-4xl space-y-4 p-4 text-body text-primary"
    >
      <header className="space-y-3 rounded-xl bg-panel p-4">
        <ProfileButton
          communities={communities}
          accountActions={accountActions}
          settingsSelected={human}
          onSettings={() => setHuman(true)}
        />
        <h1 className="text-heading">Profile settings · Isolated fixture</h1>
        <p className="text-secondary">
          A temporary, in-memory identity with simulated relay reads and
          uploads. Reload resets changes; use sample values only.
        </p>
        <Button onClick={() => setHuman(!human)}>
          {human ? "Close human profile" : "Edit human profile"}
        </Button>
      </header>
      {human && (
        <section className="rounded-xl bg-surface-panel p-6">
          <ProfileSettings
            key={communities.snapshot().selected ?? "local"}
            communities={communities}
            community={communities
              .snapshot()
              .memberships.find(
                (item) => item.id === communities.snapshot().selected,
              )}
          />
        </section>
      )}
    </main>
  );
}
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <ToastProvider>
      <Fixture />
    </ToastProvider>,
  );
