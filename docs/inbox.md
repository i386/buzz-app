# Inbox: in-progress port

Inbox is a bundled page (`buzz.inbox/inbox`) that opens recent conversations
for the selected community. The stacked evidence, conversation UI and Drafts
PRs are one user-approved Inbox launch batch; none should ship independently.

## Evidence slice (stacked with Inbox UI)

PR3 added no Inbox UI. This page uses `session.unread.inbox()` as its single
conversation projection and `session.inboxFeed` as bounded addressed history
demand. These changes are one launch batch, not a separately shippable
backend feature. Ordinary channel and thread readers, read-state storage and
outbox retain their existing ownership. No projects, approvals or reminders.

## Conversation UI (PR4; Drafts in PR5)

Inbox now renders chat-only DMs, mentions and participating threads through
`session.unread.inbox()`, with independent Activity type and Sender filters and
an Unread only toggle. Sender classification uses `session.agentChoices` and
cached/profile-backed identity evidence, never a new inventory or name heuristic.
Rows retain exact IDs and current names while `inboxFeed.incomplete` marks only
specific group members awaiting their stored edit/deletion closure. Those rows
say “Preview updating…” or “Preview unavailable. Retry inbox.”; other rows stay
usable and the detail does not reveal an incomplete body. A failed read exposes
Retry above both panes, including narrow detail. This is a visible completeness
warning, not a guarantee that the relay did not change after verification.
Retry stays focusable while pending. Successful recovery returns focus to the
visible detail Close control (or the Activity type filter with no detail) only
if Retry still owned focus when its alert was removed; moving focus away is
respected. Revalidation hides and disables an already-admitted reader and its
composer without unmounting them; incomplete bodies remain outside the visible
and accessibility trees, and hidden content cannot earn read dwell. Recovery
preserves the visit and outside focus rather than replaying exact reveal. A
conversation-scoped presentation flag dismisses its open media/link previews,
source actions, and composer subdialogs; body portals cannot outlive withholding
or reopen automatically afterward. The main editor/draft and uploads stay alive;
unapplied link fields and unsubmitted report notes are discarded with their
subdialogs. A submitted report retains its operation and outcome without reopening
the modal; failure offers Review report after recovery. Pending send consent is
cancelled without undoing already-dispatched work. First admission still waits for
complete evidence, and lost access retires the reader. If withholding hides the focused reader control, visible Close owns
the temporary focus; recovery restores the same valid control only while that
handoff still owns focus. Moving elsewhere or deliberately blurring cancels it.
Inline audio/video pauses while withheld and retains its position; recovery never
resumes playback or replays an old pending seek. Explicit Play is required.

Opening a row captures channel, message and optional thread root, then uses the
existing channel window or an exact shared thread reader to reveal even an older
target outside the newest bounded page. A late verified root can regroup a
conversation without changing the captured visit or canonical origin. Reading
is saved by the shared unread owner; failed actions retain their captured Retry
unless the visit/access/session or a newer intent retires it. A DM Retry reuses
the original channel cutoff and manual-clear keys, not the retry-time clock or
later arrivals. Re-clicking the selected row preserves that visit and its retry,
even if reading changed the row's representative. Closing a pending multi-step
read lets its admitted save settle, then quietly cancels the remaining steps.
Genuine storage/access failures remain visible, without reviving the cancelled
Retry intent. Context menus allow device-local
Mark unread. Focus returns to the invoking row, a surviving row, or the persistent
Activity type filter on Close/Escape. Escape belongs to the detail, including in-head
DMs and incomplete previews; a keyboard-opened incomplete preview focuses its
visible Close control once per visit, without refocusing on placeholder updates.
Portalled media and controls retain their own dismissal. DM timelines share the
canonical reading/edit scope with their composer: a focused composer reads fully
visible arrivals after the normal dwell, without widening the captured selection
cutoff. Selected panes collapse by available Inbox width, including the sidebar's
space. Row accessible descriptions reuse the visible safe preview or incomplete
placeholder; Show more follows the filtered result count.
`NavigationItem` owns selected styling and `aria-current`. No Inbox-owned session,
parallel fold, composer or outbox.

## Drafts (PR5)

Drafts is a quiet Inbox header action. It lists only meaningful saved composer
text in this viewer/community scope, up to 500 with explicit truncation; an
emptied selected editor stays open until send, close or confirmed delete. The
list preserves the Inbox row hierarchy and supports channel, DM and exact-root
thread coordinates. Only the selected draft loads history through the existing
channel window or ThreadPanel; thread composition waits for a verified matching
root, and a deleted/malformed root never rebinds its saved text. The shared
composer and session outbox retain recipient, admission, signing and delivery
rules. A selected channel/DM draft opens at the real returned tail without
reading or overwriting the canonical saved scroll position. The origin action
navigates separately and reports failure without dismissing the editor.

The selected editor's lifetime does not depend on list-summary eligibility. Rich
saved envelopes use an 8 MiB preview bound rather than the former 128 KiB text-sized
cutoff; larger records receive an explicit notice instead of a false empty list.
The shared composer reconciles an untouched editor with saved changes from another
window. Locally edited documents remain in place with **Load saved draft** and
**Keep my draft** choices; Send cannot silently use a conflicted document.
Foreground revision checks also prevent an observed replacement being overwritten
by stale send cleanup. These checks are not a cross-window storage transaction.

Outbox acceptance and saved-draft replacement are separate outcomes. Drafts closes
after replacement succeeds, not merely after acceptance. If no draft was ever saved
and a fresh read still confirms absence, persistent write failure does not lock the
composer after acceptance: no stale sent text needs cleanup. A nonempty unsaved
agent follow-up stays editable with a save warning. Existing or unreadable saved
revisions retain the accepted-message recovery state and offers **Retry draft cleanup**, never another
Send of that accepted body. Recovery survives composer remounts within the same
session; it is RAM evidence, not a new durable receipt or a guarantee across app
restart. Existing outbox delivery/retry ownership is unchanged.

Delete is consentful and device-local. Confirm moves keyboard focus to the
actual destructive button; Cancel restores its trigger. After **successful**
scoped saved-text cleanup, the existing attachment-draft owner clears only the
same session/destination files and aborts its pending uploads. A failed text
cleanup preserves files and text for retry; sibling channel/thread drafts and
other viewers are untouched. Successful Close, Delete and saved Send restore focus
to the invoking draft row, another remaining row, or Back to Inbox; callbacks from
an earlier visit cannot retire a later selection. Failed Delete keeps its retryable
confirmation focused. This is not a new persisted index or migration.


## Ownership and limits

`session.unread.inbox()` / `subscribeInbox()` own retained verified unread
evidence and read actions. `session.inboxFeed` owns finite, verified addressed
history demand and exact incomplete-target metadata, not a row cache. Finite
results and live arrivals, edits and deletions use the existing session admission
and shared unread fold, so own/deleted messages stay absent and unresolved roots
never become duplicate conversations. Current membership gates the feed's
completeness targets and unread's rows; joining alone does not materialize
pre-membership history without fresh shared admission. Inbox renders those shared
conversation rows directly; there is no second project/approval row merge or
feed-owned reconciliation buffer and deletion-count abort.

Channel-archived rooms are excluded from the shared Inbox projection in every
activity view. Signed archive/unarchive metadata invalidates that projection even
when membership and channel type stay unchanged. Archiving removes their rows and
closes a selected Inbox detail, without clearing retained evidence or read/local-unread
intent. Unarchiving makes retained conversations eligible again; it does not
reopen the detail. Ordinary Channels/search retain member history access and
archived posting restrictions. This is Inbox eligibility, not access revocation or
notification policy.

PR4 owns only presentation, filtering and selection. No parallel signing or persistence is
added. Optional profile enrichment belongs to PR4; access, cache clear and
session retirement fence these projections. Opening Inbox does not mark rows
read; selecting an unread row does. Canonical Messages keeps its own reading
behavior.

DM read clears the channel through its newest retained evidence. Thread read
advances the thread prefix, including earlier unshown replies, plus individually
represented top-level mentions and local message marks, but not unrelated
messages. Participation follows the shared unread owner's direct-parent policy,
including its existing bounded lookups for replies whose membership is undecided.
Fetched roots and participation witnesses remain structural, never extra Inbox rows.
A lookup-only root uses the existing exact-message manual-unread target until counted
root evidence arrives; its known root still supplies grouping and read-through.
Relevant replies remain thread activity even when the root cannot be fetched.
Multiple steps are not atomic: failures leave remaining evidence retryable. Manual unread is local to this device. Hosts without frontier-sync
disable read mutations. Saved frontiers are not proof of remote reconciliation.

This is **bounded recent evidence**, not a complete historical inbox. Unread
retains at most 4,096 events / 8 MiB, observing up to 500 recent events per
128-channel roster batch. A lazy addressed query returns up to 50 kind-9/40002
messages. For those exact IDs and unresolved failed targets, general `#e`
queries page signed kind-40003 edits and kind-5/9005 deletions, then deletions
of the edits; `include_aux` on an ordinary `#p` query is not a supported relay
contract. Both auxiliary stages must finish before the feed is ready. Retained
unread evidence can be provisionally admitted between queries, but exact target
IDs are marked incomplete **before** unread subscribers are notified. The
consumer must not show their body as current while incomplete; failures retain
that metadata and offer retry. This is a completeness signal, not atomic content
admission or a second message fold. A target outside the latest 50 addressed
rows is not discovered; if a failed target falls outside a later page its
bounded auxiliary check still runs before its incomplete flag is cleared.
Incomplete obligations survive disconnect and unrelated access revocation while
the corresponding readable unread evidence survives; full cache/session retirement
clears both. Tombstone checks include retained author edits even if a later relay
query omits their soft-deleted rows. If reference visibility withholds an auxiliary
event, the finite attempt stays failed/incomplete rather than treating the filtered
page as exhausted history. Explicit Retry can settle it once existing shared
readers have admitted the missing reference; Inbox adds no reference-resolution loop.
Auxiliary reads cap retained results at 2,000 events / 4 MiB per stage; the shared reader
keeps its existing per-request deadline and cancellation. Missing roots,
participation or older activity can omit rows; an empty Inbox does not prove
complete history. No polling, independent row source or channel window is
opened for the feed. Access/cache/disconnect/disposal fence pending reads; local
read intent remains with unread. Packaged/native acceptance and human visual
feedback remain separate.

Reminders and their NIP-ER lifecycle are **not included** in this change.
The unfinished reminder prototype is preserved separately for later work,
not shipped in the Inbox source or broker routes. Follow/mute Inbox policy,
full backlog discovery and nonchat activity are outside this slice. Project and
approval queries, grouping, routing and detail presentation are deliberately
excluded rather than presented as partial parity. Native/ACP packaged acceptance and human visual feedback
remain open. Do not treat this as the full OG Inbox port.

## Split assertion ledger

The #422 source's 2,073-line mounted file has 38 literal `it` blocks plus
four parameterized groups (2 + 2 + 3 + 2 = 9 executions), totaling
**47 executed cases**. Fourteen literal Drafts cases moved intact to PR5's
`DraftsView.test.tsx`; PR4 owns the remaining 24 literal cases and all four
parameterized core groups. The original 47 = 24 core literals +
14 Drafts literals + 9 grouped core executions. PR4's 41 expanded test runs
at its published head comprise those 33 original core cases plus eight new
regressions. PR5 adds two Drafts deletion tests. PR3 retains the existing
unread suite and feed integration cases with historical edit/first-admission
safety regressions. `view-state.test.ts` adds five scoped enumeration and
meaningful-cap tests; `attachment-draft.test.tsx` adds pending/ready cleanup
regressions.
The mixed filter case keeps its two selector assertions in PR4; its Drafts
header-button assertion belongs to PR5's mounted Drafts suite. Source
project/todo/sidebar navigation tests already on main are not copied here.

Browser mapping: original case 1's chat/filter/context/read/reflow assertions
remain in PR4; its Drafts switch/return fragment lives in PR5's Drafts view test.
Original case 2 is PR5's real rich-editor/scroll/geometry/send journey. Original
strict-window case keeps exact unread anchor/new arrival/canonical origin/deletion
in PR4 and moves saved-root newest-context to PR5. Original old-DM, session
recipient and narrow failed-save cases stay in PR4. That is the original seven
browser cases split across PR4/PR5, plus PR4's new in-head focus and Escape
focus cases and development-React StrictMode case. The joined stack runs eight
cases in PR4 and two in PR5, each in Chromium and WebKit (20 executions total).
The fixture uses per-test isolated synthetic identities/servers, preserving the
base `sessionWriteKinds`, `dmMembers`, companion and stale-stream guards.

The counts above are historical PR-head counts. A later test prune removed two
mounted cases whose assertions stronger cases already make: `InboxPage.test.tsx`
"Retry repeats a rejected mark-unread mutation, not just evidence refresh"
(kept by the failed mark-unread Retry cases) and `DraftsView.test.tsx` "a
selected draft edits through the shared scoped composer without navigating or
sending" (kept by the same-window editor, 128 KiB rich-editor and emptied-editor
cases). `InboxPage.test.tsx` now collects 61 cases and `DraftsView.test.tsx` 29.

## Verification status

`inbox-feed.test.ts` exercises the real session reader/visibility/unread owners
with signed ephemeral events, including the first-admission subscriber ordering,
held edit and tombstone reads, failure/retry, reentrant access removal and cache
reset, root regrouping, and an edited addressed target older than 500 ordinary
messages. `unread.test.ts` retains the current main read/catch-up behavior and
adds Inbox projection/read-state cases. Neither file establishes browser paint,
real relay persistence or packaged/native acceptance. PR4's mounted real-session
`InboxPage.test.tsx` covers filters, read/retry and pending row/detail evidence.
`tests/browser/inbox.spec.mjs` uses the actual broker/browser in Chromium and
WebKit for exact focus, viewport/scroll, responsive failure recovery, canonical
origin and session-recipient publication. This is synthetic fixture evidence,
not human live or packaged acceptance. `DraftsView.test.tsx`,
`view-state.test.ts`, `attachment-draft.test.tsx` and
`tests/browser/inbox-drafts.spec.mjs` cover Drafts storage, exact-root admission,
scoped editing/deletion (including failed text and pending uploads), selected-only
history, native editing, scroll and responsive geometry in both engines.

### Review repairs, 2026-10-01

The uncommitted repair tree based on `9d3d43cf` passed 561 focused tests across
14 files, TypeScript, changed-file Biome, design checks and all 22 Inbox browser
executions in Chromium/WebKit. The browser total is now 11 cases per engine:
the prior ten plus one real two-page draft-storage journey. No cases were removed.
Existing native-focus cases now also cover selected-row re-click, empty-filter
focus fallback, and media Escape staying inside its portal before detail dismissal.
State/failure permutations remain in mounted React or the relay owners' tests.

The relay regressions failed before repair for both lifecycle paths, omitted
retained edits and withheld auxiliary pages. Separate advancing count/byte-limit
cases fail when their corresponding guard is removed. Mounted Drafts regressions
failed before repair for channel/thread post-send cleanup, external replacement
and a valid rich document crossing 128 KiB. The DM cutoff and cold Settings
fallback tests also fail when their repairs are reverted. An independent review
of the first dismissal fix caught a portal propagation defect; both browser engines
reproduced it before the DOM-containment guard and passed afterward.

Independent changed-path re-review found no remaining blockers in the repairs.
These are local fixture/service results, not checks on pushed PR heads or a future
merged tree. Human, live-relay and attended native/packaged acceptance remain open;
no full scan or shipping-readiness attestation is implied.


## Visual-only pass (#770)

Built on main's existing Inbox and Drafts: one filter menu, outline/filled unread
toggle, trailing unread dots, adjacent list/detail with one header, and the shared
centered draft-delete dialog. The list/detail divider reuses `usePanelSplit` and
`ResizeHandle`: drag, arrows (Shift for larger steps), Home/End and double-click
reset. The list defaults to 420px where space allows and can resize from 320px
up to a 50/50 split with the conversation, which keeps at least 316px.
Its chosen width is in memory across detail close/reopen and Inbox/Drafts switching,
not persisted across restarts. At ≤700px available width, detail replaces the list
and the divider is hidden.

All matching **already-loaded** Inbox rows render without Show more. Optional
profile enrichment remains bounded to the first 50 candidates; cached names still
apply, and uncached later names may keep key fallbacks. No new history demand,
profile loop, row cache, relay/session/unread/store or native changes.

Main retains loading, representative People/Agents filters, grouped Mentions,
selected-read visibility, read/retry, workflow attribution, thread follows, exact
readers and draft persistence. Deletion retains consent and text-before-attachment
cleanup. The former history/candidate/exact-mention work is excluded.

**Separate engineering handoff:** diagnose missing older/agent conversations by
tracing fetched events, participation evidence and filtering. Agree mixed/unknown
sender behavior, mention policy and filter persistence separately. Coordinate
John's archive/refresh/development work; progressive relay loading is not fixed here.

**Evidence:** integration with main `ce2f66ea` preserves John's #757 archive
retirement and #758 refresh status without shifting rows, plus main's #800 test
pruning. It passes 116 Inbox tests, 2 shared-hook tests, TypeScript/build and 74
Chromium/WebKit executions across Inbox, sidebar and existing panel journeys.
Independent merge-resolution review found no blockers. The prior `5b4d45d0` head
passed hosted CI and DCO; current-head hosted checks remain a separate gate.
Common splitter checks stay in Inbox; Drafts keeps cross-view width, header
alignment, narrow sizing, editing and modal/focus coverage. No browser cases were
removed. Human confirmation and required review remain open; local synthetic
checks do not attest native/live acceptance.
