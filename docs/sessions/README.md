# Me and sessions

Me is personal organization over ordinary channels, not a separate message store
or relay-enforced privacy mode. Signed channel membership remains access authority.
The earlier [channel-space proposal](spaces.md) is superseded design history.

## Current behavior

- Me placement and groups live in the existing encrypted, account/community-scoped
  `groups:me` preference record. Messages groups remain independent. Placement is
  explicit, not inferred from participant count or local agent availability.
- **Upgrade behavior:** Me starts empty. Existing sessions, including historical
  parent-linked sessions, remain standalone Messages rows. There is no automatic
  migration, membership revocation, nested creation or transcript copy.
- New conversations use ordinary private channels. The first send freezes the
  draft, channel ID, Canvas and group defaults in the existing pending-start
  receipt. Setup and Me placement must succeed before sending; retries reuse that
  ID. Draft settings remain local until first send and use Me's defaults namespace.
- **Share** is the single Me-to-Messages flow, available in the heading and sidebar
  menus. It defaults to the current name, visibility and duration (new conversations
  are Private/Ongoing), with optional additional people. It preserves the channel
  ID, history, Canvas and existing agents/members. No conversation is copied.
- Share confirms selected-person access, then applies channel settings, then removes
  Me placement and the obsolete Me group assignment. It does not import Me groups
  into Messages. Removing the legacy session marker makes this an ordinary Messages
  channel, even when other settings are unchanged. Public sharing explicitly
  confirms exposure of the full history; Temporary duration automatically archives
  the conversation without deleting its history. Settings changes require verified
  owner/admin authority and a details writer; there is no separate placement-only
  Move fallback.
- Destination-link sharing in Messages remains a separate flow; see
  [sharing](sharing.md). Neither flow shares owner-private detailed agent activity
  or starts an agent merely by granting membership.
- Me conversations and drafts use the full conversation pane. Right-click,
  Shift+F10 and overflow share one sidebar action list: Share, Rename, Move to a Me
  group, Copy and Session settings. Opening a row menu does not select the row.
- Me uses the ordinary composer with selectable owner-scoped agent mentions. A
  send without a mention does not infer an agent. Existing Messages sessions keep
  their ordinary recipient rules. Saved placement must load before the Me reader
  enables sending; an unavailable preference read is not evidence of Messages.
- Me reuses Messages' sidebar working-agent signal, animated indicator and activity
  popover, including owned-agent typing in threads and unread-thread actions.
  Agent activity details open in Me's existing per-conversation panel workspace;
  exact-message/thread actions use the canonical channel reader, as other Me links do.
  Me grouping and row menus remain independent of Messages organization.
- Me reuses Messages' secondary conversation/tool/panel tabs and pane geometry,
  with separate per-conversation Me persistence. Its main timeline remains flat.
  A single working agent's Activity indicator opens its Activity panel locally;
  multiple agents or an unavailable panel retain the chooser. Hover previews are
  retained; Down Arrow on a single-agent indicator opens the chooser for keyboard
  access to its conversation actions. Secondary conversations placed in Me keep
  owner-scoped explicit recipients and wait for placement readiness before sending.
- Canonical channel links still use the ordinary channel reader, and Me routes can
  refer to an accessible ordinary channel UUID. Routes and plugin views do not
  grant access. Disabling the Me view does not delete its channels or memberships.

## Organization, settings and recovery

Me groups, assignments and section defaults never fall back to Messages defaults.
Workspace folders, optional worktree/base branch and Canvas are instructions saved
in ordinary Canvas Markdown; saving settings does not create a worktree or change
an agent process. Templates are copied, not live-linked. Saved conversation
settings retain the existing Canvas revision checks and explicit conflict recovery.

Me uses one bounded 16 KiB recipe record, not unlimited history storage. Admission
checks its exact serialized size before remote channel creation and again before
saving placement. A full record keeps the draft and suggests moving an existing
conversation to Messages, which reclaims its placement and assignment bytes.
Admission is not a reservation: another device can fill the record between those
steps. Deleted/archived placements can still consume capacity. No cross-device
atomicity, automatic compaction or new multi-record storage protocol is claimed.

Share attempts retain in-process intent plus durable per-operation Outbox receipts,
not a persisted composite transaction. Start over forgets settled choices, not
submitted operations, created channels, confirmed access or Messages placement.
An interrupted link can be retried by its exact ID in Outbox; confirmed delivery
can be removed there before sharing to the same destination again. Unknown
receipts remain protected. Whole-share intent does not survive an app restart.

## Owners and validation limits

`src/bundled/sessions` owns Me navigation and its reused conversation/group UI;
`src/bundled/channels` owns Messages and Outbox recovery. Shared composition,
settings and share intent live in `src/features/sessions`; Me preferences use
`src/features/relay/me-preferences.ts` and the existing recipe capability. Existing
channel, membership, signing and Outbox owners retain their authority.

Colocated tests cover admission, frozen defaults, navigation lifetime and recovery;
browser fixtures exercise actual app wiring in Chromium and WebKit with synthetic
identities. They do not prove native signing, live persistence/restart,
cross-device/plugin fallback, real-agent effects or opening performance.
Those checks and renewed human acceptance remain delivery gates where applicable.
The polish browser journey covers menu/focus behavior, full-width saved/draft
composers, and in-place Share through the real browser broker with synthetic relay
responses. Native/live relay promotion and human acceptance remain unverified.
