// The session of the conversation an agent's profile was opened from, set
// apart above the agent's other conversations. Types list their own sessions.
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { usePanelTabHost } from "../panels/PanelWorkspace";
import type { AgentConversation } from "./service";

type Saved = Readonly<{
  channelId: string;
  name?: string;
  root?: string;
  at?: number;
}>;

type Place = Readonly<{ channelId: string; root?: string }>;

/** The session for `conversation`: its thread's, else its channel's, which is
 * the one session a channel-scoped agent or a DM keeps. This build's saved
 * session comes first; `find` looks in the type's own history for one another
 * build of the app started, since each build saves its own. */
export function useOpenedSession<T extends Saved>(
  saved: readonly T[],
  conversation: AgentConversation | undefined,
  find: (place: Place, signal: AbortSignal) => Promise<T | undefined>,
): { session?: T; searching?: boolean; error?: string } {
  const places: Place[] = conversation
    ? [
        ...(conversation.rootId
          ? [{ channelId: conversation.channelId, root: conversation.rootId }]
          : []),
        { channelId: conversation.channelId },
      ]
    : [];
  const bound = (place: Place) =>
    saved.find(
      (item) => item.channelId === place.channelId && item.root === place.root,
    );
  const exact = places[0] && bound(places[0]);
  const key = conversation
    ? `${conversation.channelId}/${conversation.rootId ?? ""}`
    : "";
  const [found, setFound] = useState<{
    key: string;
    session?: T;
    error?: string;
  }>();
  const latest = useRef({ bound, find });
  latest.current = { bound, find };
  // biome-ignore lint/correctness/useExhaustiveDependencies: places follow key; bound and find are read when it runs.
  useEffect(() => {
    if (!key || exact) return;
    const abort = new AbortController();
    void (async () => {
      for (const place of places) {
        let session: T | undefined;
        try {
          session =
            latest.current.bound(place) ??
            (await latest.current.find(place, abort.signal));
        } catch (reason) {
          if (abort.signal.aborted) return;
          return setFound({
            key,
            error: reason instanceof Error ? reason.message : String(reason),
          });
        }
        if (abort.signal.aborted) return;
        if (session) return setFound({ key, session });
      }
      setFound({ key });
    })();
    return () => abort.abort();
  }, [key, !!exact]);
  if (!conversation) return {};
  if (exact) return { session: exact };
  if (found?.key !== key) return { searching: true };
  const { key: _, ...result } = found;
  return result;
}

/** The transcript a type's tab shows over itself as a panel subview, titled
 * `title(row)`. It closes when the profile is retargeted to another
 * conversation, and viewing it again brings its tab back in a tabbed host. */
export function useOpenTranscript<T>(
  conversation: AgentConversation | undefined,
  title: (row: T) => string,
) {
  const place = conversation
    ? `${conversation.channelId}/${conversation.rootId ?? ""}`
    : "";
  const [shown, setShown] = useState<{ place: string; row: T }>();
  // Forgotten, not just hidden: returning to the first conversation must not
  // reopen it unasked.
  if (shown && shown.place !== place) setShown(undefined);
  const tabs = usePanelTabHost();
  return {
    open: shown?.place === place ? shown.row : undefined,
    show(row: T) {
      setShown({ place, row });
      tabs?.activate(tabs.owner, title(row));
    },
    back() {
      setShown(undefined);
    },
  };
}

export function OpenedConversation({
  conversation,
  harness,
  session,
  searching,
  error,
  status,
  onView,
}: {
  conversation: AgentConversation;
  /** The type's name for its sessions, e.g. Codex. */
  harness: string;
  session: Saved | undefined;
  /** Still looking for a session another build of the app started. */
  searching?: boolean | undefined;
  /** Why the search failed. */
  error?: string | undefined;
  /** The session's live state, when it is running. */
  status?: string | undefined;
  onView(): void;
}) {
  const id = useId();
  const place = (session ? session.root : conversation.rootId)
    ? "thread"
    : "channel";
  return (
    <section aria-labelledby={id}>
      <InlineHeader id={id} title={`This ${place}`} />
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-container bg-surface-inset p-4">
        {session ? (
          <>
            <span className="min-w-0">
              <span className="block truncate text-label">
                {session.name
                  ? `#${session.name}`
                  : session.channelId.slice(0, 8)}
              </span>
              <span className="block text-body-sm text-subtle">
                {[
                  status,
                  session.at &&
                    `Last active ${new Date(session.at).toLocaleString()}`,
                ]
                  .filter(Boolean)
                  .join(" · ") || `${harness} session`}
              </span>
            </span>
            <Button variant="prominent" onClick={onView}>
              View transcript
            </Button>
          </>
        ) : searching ? (
          <span role="status" className="text-body-sm text-subtle">
            Looking for a {harness} session…
          </span>
        ) : error ? (
          <span role="alert" className="text-body-sm">
            Could not look for a {harness} session: {error}
          </span>
        ) : (
          <span className="grid gap-1">
            <span className="text-label">No {harness} session here yet</span>
            <span className="text-body-sm text-subtle">
              One starts when you mention the agent in this {place}.
            </span>
          </span>
        )}
      </div>
    </section>
  );
}
