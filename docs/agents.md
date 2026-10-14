# Agents

## Scope

Agents (`src/bundled/agents`, `src/features/agents`) is the app's only agent
system: it creates, runs and deletes the viewer's agents. This document covers
what the rest of the app knows about agents: shared selection, mentions, archive
display, activity, names, inventory and usage. The v1 Agents page, Profiles plugin,
Channel templates plugin, agent snapshots, team bundles, community catalog and
agent-management request popups are gone, as are the native `agent_control_*`,
model-discovery and harness-install commands behind them.

Agents was called Agents2 while v1 still shipped. Startup now moves its identity
folder to `agents/identities.json` and its browser settings to `buzz.agents.v1`
and `buzz.agents.teams.v1`. Identity bytes and keychain entries are unchanged.
The Agents2 plugin switch moves to `buzz.agents`; the retired v1 switch is
removed. Plugin registry versions distinguish these preferences (native v2,
browser v3), so a later restart preserves changes to the new switch.

The temporary migrators are `src/features/agents/migrate-storage.ts`,
`src/plugins/migrate-agent-flag.ts`,
`crates/plugin-manager/src/migrate_agent_flag.rs`, and
`src-tauri/src/sign_out/migrate_agents.rs`. Remove them and their call sites after
2026-10-18 once development users have upgraded; remove the old registry-version
readers and the legacy sign-out keep/key-deletion entries at the same time.
This is a one-way development migration: close older Buzz copies before the
first upgraded launch and use the upgraded build afterward. Native migration
requires the existing exclusive instance lock; conflicts stop startup without
replacing either folder. A pending erase handles both folder names before the
migration runs. Browser moves write the destination before removing the source
and resume identical interrupted copies; differing destinations are left intact
and reported as migration errors.

## Agent types and providers

Harness plugins register agent types with the Agents service. An agent type owns
the defaults, migration policy, per-agent settings tabs, model discovery and run
behavior for its agents. The host appends the shared Attention tab.

Attention is shared by every harness. `src/buzz-mcp/session-tools.ts` lists a
session's tools (the Buzz tools, plus the attention tools when the owner has
attention on) and dispatches each call, refusing attention calls once attention
is off. `src/buzz-mcp/attention-prompt.ts` holds the attention guidance, the
end-of-turn review and the watch and timer prompts.
`src/features/agents/wakes.ts` runs a watch or timer wake: it queues the wake in
its Interest's lane, checks that it is still current before and while its
prompt is built, and adds the review. A harness supplies only two pieces: a
bridge that lists `sessionTools` in its tool format and passes calls to
`callSessionTool` (Claude: an in-process MCP server; Codex: app-server dynamic
tools), and a `RunOnce` that runs one turn with no saved conversation and stops
it after `WAKE_DEADLINE_MS` (Claude: a one-off process; Codex: an ephemeral
thread). A session lists its tools once, so a harness must not reuse a saved
session whose tool set differs from the one a turn needs.

A type marks its primary configuration tab with `role: "settings"`. In the
Agents build view and profile panel, the host keeps that tab at a stable
`Settings` destination and supplies the current type identity plus retype
control through `settingsHost`. The type keeps ownership of its config draft
and Save behavior. Types without a settings-role tab receive a host-owned,
type-only Settings tab in both surfaces.

A reviewed provider choice remains a host-owned draft until that Settings
form's Save action succeeds. While it is pending, the selected provider's
settings tab edits the destination config produced by its migration policy, and
Save is available without another edit. Save commits the provider and that
config together; a failed save leaves the choice and draft available to retry
or revert.

An agent type may also contribute `provider`: a subscribable readiness snapshot,
a read-only check, and a management-dialog body. **More → Providers** lists each
active type once using the registered title and icon. It is a quick health view:
rows show only ready, checking, attention, or a neutral unavailable state. The
Agents host owns the submenu, modal framing, focus restoration and contribution
error boundary. The plugin owns connection actions and optional defaults inside
the dialog; blocking install or sign-in work must expose cancellation before the
dialog can close. Disabled or unloaded types remain in Settings → Plugins.

Workspace, instructions and session scope are always per-agent. Claude and Codex
model/thinking choices may instead be blank, which means inherited rather than
rewritten. Their effective order is explicit agent override, saved device-wide
provider default, then the provider's native default. Missing or malformed
provider preferences preserve native behavior. A provider-default save notifies
the runtime like the corresponding per-agent save but does not mutate agent
records. Codex uses an inherited thinking choice only when the effective model
supports it, otherwise that model's default applies. Transient process/session
state may appear as collapsed diagnostics in Settings, but is not durable history.

Agent identity is evidence, never authority. Names, library rows, local agent rows,
archive state and presence do not prove ownership, membership or runtime state.

## Local agents

`LocalAgents` (`src/features/agents/local.ts`) is a read-only snapshot of the
viewer's live agents on this machine, in any community:
`{ status, agents: [{ pubkey, name, relayUrl, owner }] }`, with `status` one of
`unavailable`, `loading`, `ready` or `error`. `AgentsService.local()` produces it
from its saved identities (deleted ones omitted), so it carries Agents' own
loading and error state. Agents' `snapshot()` is different: it holds only the
selected community's agents, with their settings.

`app/services.ts` composes consumers before Agents exists, through
`createLocalAgents()`. Until `bind` connects `agents.local`, the snapshot is
`unavailable`; unbinding returns it there. Two consumers read it directly:

- the identity-name service, which lets a local agent's name win in its own
  community; and
- `session.agentChoices` (the communities service hands it to each session), which
  marks matching agents `managed`. New message and mention choices read that flag.

`sameCommunityAgents` keeps only rows whose `owner` is the viewer and whose
`relayUrl` maps to this session's community partition. Local agents carry no
process status, so a stopped agent is as selectable as a running one.

## Shared agent selection

`session.agentChoices` is the canonical read-only selection projection. Mention
pickers, New message, the session agent chooser, channel member invitations and
their admission checks use it, not `agentLibrary` directly. It combines two
sources, deduplicated by public key:

- `agentLibrary`, the display inventory (see [Community inventory](#community-inventory)):
  the host's saved Buzz library plus the owner's relay-published records; and
- the viewer's local agents for this exact community, flagged `managed` with a
  `managedName`.

A snapshot exposes `identities`, `selectable`, `archives`, `definitions`, `status`,
`pending`, `complete` and a separate `templates` projection. `status: ready` means
usable, not complete: automatic-recipient inference must honor `complete`, which
requires a ready, error-free library and a local source that is ready or
unavailable. A failed source contributes no stale candidates; another ready source
stays usable, with partial failures surfaced through Retry.

Do not build another agent inventory in a plugin. `useAgentChoices(session,
includeLegacy, archive)` retains the projection while mounted, which preserves
ready evidence across menu remounts, and ensures the lazy library and archive reads
on demand. Ordinary mentions subscribe without loading the library
(`includeLegacy` false); explicit Refresh retries source failures. The projection
adds no runner, polling, directory scan or signing authority, and session
retirement revokes its candidates.

`templates` serves saved channel-kit templates and section defaults (session setup
resolves lineups through it with `templateAgentChoices`). Its identities are the
local agents once Agents is bound, and the library only while the local source is
`unavailable`. It never falls back to the library after a local error.
`templateAgentChoices` returns nothing until archive evidence is ready, and
library-only choices additionally need visible community membership. Saved keys
are never rebound to a namesake.

Archive visibility has one owner. The projection reads `session.archives` and
exposes `identities` (every known agent, including archived ones, for facts about
existing content) and `selectable` (known-archived agents removed; unknown state
fails open; the viewer is never hidden). Every forward-looking agent chooser uses
`selectable`, including the session agent picker. Session admission in
`workSessions.addAgents` rejects every known-archived key, including parent-channel
members; unknown archive state keeps the library and parent-member rules. Selectors
demand the lazy archive read through `useAgentChoices(session, includeLegacy, true)`,
and the session picker shows an archive read failure with Retry. The same base rule,
`archiveHides` (`features/relay/identity-archives.ts`), filters mention recipients,
channel member invitations and member addition, session sharing and search. Do not
reimplement the rule per surface.

Agent artwork also has one owner: `createAgentLibrary` publishes snapshots where
an identity without its own avatar shows its linked definition's avatar
(`inheritDefinitionAvatars`). Surfaces read `identity.avatar` and do not repeat
the lookup.

Action policy stays explicit: ordinary member mentions use the channel roster and
hide known-archived identities without requiring verified non-archived evidence.
In streams and forums, nonmember mentions also offer people from the selected
community directory and, when the viewer can add members, the viewer's own agents
(`managed` or not) that are not in the channel. Send asks before adding them; selection grants
no access. A pasted mention of a known profile is offered the same way. A DM can
name outsiders but never notifies them. Session invitations keep their existing
rules, including library choices. Shared choice visibility is not permission to
grant access.

Regression source: `features/agents/choices.test.ts`, plus the chooser, composer
and session-admission tests. They exercise shared selection and session admission,
not native execution.

## Exact channel-member mentions

The shared channel summary now exposes exact members from its existing verified
relay-authored kind-39002 roster, without a second directory or subscription.
The bundled **Mentions** plugin offers **Mention a member** in both channel and
thread composers through the shared conversation tool contract. The host retains
recipient intent, inline editing and avatar removal even when the chooser plugin is disabled.
The picker shows keys alongside names (namesakes remain separate), reads optional
profiles only on demand, and keeps selected identity spans in scoped drafts.
Typing a name alone does not notify anyone. Plain Space after a unique exact name
selects its recipient; ambiguous names require Tab, Enter or click. Editing a
selected span removes its notification intent. Native beforeinput ranges preserve untouched spans; missing
range evidence, IME/history edits and collapsed deletions clear selections rather
than guess. Even a same-text replacement drops the edited identity. Selected mentions appear as inline identity chips in the composer. Namesakes
selected together receive visible key qualifiers; editing a selected span removes
its notification intent. Chips remain available without the Mentions chooser.

### Chooser rules

Two parts of the app decide who you can mention:

- **The Mentions plugin decides what the chooser shows.** This covers both the
  toolbar picker and the inline `@` list: who is listed, in what order, and when
  Space picks a name (`src/bundled/mentions/`).
- **The composer decides who a message can address.** It checks every mention
  before it goes into the draft, whatever added it (`mention-admission.ts`). The
  plugin lists only people that this check accepts.

The composer accepts these people:

| Where you write | Who you can mention |
| --- | --- |
| Channel or forum | Anyone. Before sending, the app asks what to do about people who are not in the channel. |
| DM | Anyone. People outside the DM are named but not notified. |
| Session | Session members, plus your agents when the session invites agents. |
| New DM, before it is created | Only the people you chose for the DM. |
| Archived or read-only channel | Nobody. |

Everywhere, the composer refuses invalid keys and people known to be archived.
You can always mention yourself. If archive state is unknown, the mention is
allowed.

A mention notifies a member. It does not promise that an agent will answer, and
choosing someone does not give them access or start an agent.

Search trims and lowercases the query. Members precede nonmembers, with humans and agents in each group. Within each
group, matches against the visible resolved label come first: whole-name exact,
name prefix, whole-word exact, then word prefix. Base names and known aliases are
fallback matches in that same order. Only resolved names and real profile/agent
names are searchable. Public keys (including unnamed identity fallbacks) are not
completion matches. Arbitrary name substrings do not match. A hidden base-name match never
promotes a weaker visible-label match. When visible-label match quality ties,
base-name/alias match quality breaks the tie before recipient preferences.
Among equal matches, agents with profile-reported ownership by the viewer come
first, before humans and other agents. Agents that share a base name then form one
block, placed at the first of their case-insensitive displayed labels (including
disambiguating suffixes). Inside a block, explicit-choice recency, managed status,
and already-known online/away status decide the order. Humans never join a block
and sort first on an equal label. Remaining ties use the displayed label, then the
full key. Each rule is a per-choice sort key, so the order is the same for any
input order. Ownership comes
from profile owner metadata, not a name or presence in the library or local agents.
Recency stays in memory per session/destination and is bounded to 100 destinations
and 100 recipients each. Neither ownership nor recency overrides membership or
match quality.

An open query installs at most 50 keys. Their order and membership stay fixed until
the query changes or the chooser reopens. Labels, insertion names and availability
remain live. A removed/archived row stays disabled in place; Enter/Tab cannot fall
through to sending. A member who becomes an outside invitation choice also stays
disabled until reopening. Retry refreshes evidence, not the installed order. New
arrivals need a changed query or reopening. Pending sources or missing profiles do
not freeze a premature empty result. Local sources (members and agent choices)
establish the list; the community directory never gates it. Directory people
append below the rows already shown, so a late page never moves a visible row.
While a new query waits or loads, still-matching people from the last settled
page of the same chooser stay visible (one picker, or one inline `@` token; inline
completion remounts per keystroke, so the page is kept per session outside it) and the chooser shows "Searching community…". Uncached queries
reach the network only after a 200 ms typing pause. Settled first pages are cached
per session and query (100 queries); errors are not cached, and Retry reads the
current query again. Chooser identity naming uses eligible candidates plus the
current draft recipients, not every cached profile. Composer chips name their
recipients among the destination's members plus the draft recipients.

Plain Space selects only a unique exact name/alias/label across the full uncapped
candidate set, and only if that identity is displayed and still eligible. A known
longer name beginning with that name plus a space prevents selection. Partial
names, ambiguous names, modified Space, IME composition, code and protected literal
ranges keep ordinary editing behavior. Selection rechecks available evidence and
stores only `{pubkey, name}`; qualifiers are presentation, not wire data.

The composer rejects already-known archived recipients (never the viewer) at
send entry. The next draft keeps only agents that the sent message notified. This is not an archive transaction: archive
changes during enrollment, dispatch or retry are intentionally not covered. The
existing relay membership/send/retry validator is unchanged.

After an accepted send, the next draft starts with the exact selected agent-name
mentions, deduplicated by key. Agent classification uses already-cached profile hints
or the shared agent-choice projection (library and local agents), not a new lookup or
permission grant. Human recipients and
plain typed names are not carried forward. The prefill is an ordinary scoped draft:
channel/thread/account isolation, edits, removal, undo and delivery checks still apply.
**Settings → Agents → Messages → Remember mentioned agents** defaults on and is saved on this
device. Turning it off stops future prefills without changing the current draft;
turning it back on does not restore old recipients. Session auto-recipient rules are
unchanged. An outbox rejection preserves the original draft; acceptance is not proof
of relay delivery or agent execution.

Team records in the channel kit (see [Channels](channels.md); groups, Canvas and
`buzz-channel-kit-v2` team manifests) appear in both mention choosers as shortcuts.
No bundled plugin writes team records now, so they appear only for records already
in the community. A team is a shortcut, not a group identity: explicit selection
inserts its saved agent keys as individual mentions in one undoable edit through
`insertMentions`. Names never resolve membership. Typing a team name or Space
alone does not select it. Team names also prevent Space from accidentally selecting
a person with the same name or a prefix. Each query shows at most 20 matching teams,
with up to four cached avatar thumbnails and a remainder count. Empty, oversized
(more than 32 agents), changed or partially unavailable teams stay disabled; there
is no partial expansion. Reopen or change the query to refresh changed team
choices. The resulting draft must fit the existing 32-mention and message-length
limits. Selection never adds members: ordinary channels retain invite-on-send
consent, DMs retain reference-only outsiders, and session admission remains
unchanged.

The picker supports Up/Down navigation, Enter selection and Escape dismissal.

`session.messages.send/reply` accepts up to 32 exact notification pubkeys and emits
deduplicated `p` tags. In ordinary channels, Send pauses for selected nonmembers:
**Invite** grants access only with permission and explicit consent, waits
for confirmed membership, then sends notifications. **Do nothing** (or **Send
anyway** without add permission) sends those identities as separate `mention`
reference tags, without adding or notifying them. Close or Escape keeps the draft. Existing member mentions still notify in a
mixed send. Reference keys are validated and bounded to 32. Selection itself never
invites or starts anyone; whether an agent answers a notification is up to its
own runtime. DM and session admission paths remain separate. Current notification-recipient membership is checked at
intent, before signing, and after signing before entering the transport publisher;
retry/restored signed intent uses the same publisher check. Before **each**
mention publication the session performs a bounded foreground finite read of this
channel's kind-39002 roster under the captured relay author. It never joins an
older in-flight read. Empty/failed/malformed evidence blocks dispatch; access,
connection and cache changes fence the read. A newer observed removal beats an
older response. Neither AUTH, route establishment nor the optional metadata-read
status substitutes for this preflight. Failed/capacity-limited live routes can use
the finite evidence while connected. One finite request per mention attempt is a
safety cost, not additional startup work or polling.

A first known local rejection is failed/unsent. Finite membership preparation runs
under the same outbox deadline but outside the dispatch phase: a timeout there is
unsent and starts no confirmation reads. The final synchronous scope/membership
check runs immediately before publisher entry, after all asynchronous preparation.
A blocked retry preserves prior
unknown/accepted delivery evidence and reports its retry error separately; the
first dispatched attempt may already have delivered. These checks are client UX safety,
not a substitute for relay authorization, a membership transaction, or the ACP
listener's own admission rules. Network changes after transport dispatch remain
possible. No ownership or running status is inferred from a member's name/profile.

Wire compatibility is kind 9 + `h` + exact `p` for notifications and `mention`
for reference-only identities; direct replies also carry
`["e", root, "", "reply"]`. Existing buzz-acp owns mention admission, replay,
channel membership, pool wake and harness execution. Mentions add no wake loop,
process launcher, configuration save or agent invitation operation. The library, local agents and archive display are not mention authorization.

Focused coverage: `mentions.test.ts`, `MessageComposer.test.tsx`,
`mention-draft.test.ts`, broker sign/publish integration and the real React journey
`tests/browser/mentions.spec.mjs` and `mention-edit.spec.mjs` (Chromium + WebKit,
fixture identities). `mentions-live.test.ts` exercises the actual subscription →
session → outbox path across reconnect, route failures, stale/failed preflight,
restore, optional name failure and unknown delivery. Live ACP
reply and packaged desktop acceptance are not established by these tests.

## Relay-scoped archive display

`session.archives` is a lazy NIP-IA snapshot capability, independent of
page/plugin lifetime. The dev broker passes `archiveAuthority` only when the
community's NIP-11 advertises a valid explicit `self`; the legacy contact `pubkey`
fallback continues to serve existing reads but cannot authenticate archive state.
The native transport passes the NIP-11 `self` it validated on connect; a transport
without an authority leaves this capability unavailable. No secret crosses the
browser boundary.

One fresh background read requests kind 13535 from that exact authority, limit 1.
The verified response must contain exactly one empty-content, protected snapshot
within 2 MiB. Missing/failed/malformed/oversized evidence is unknown, never an empty
active list. Invalid `p` keys are ignored and extra `p` elements have no semantics.
A successful snapshot replaces the entire list; newer timestamps / lower-id ties
win. A session-local ordering fence survives cache clear, without retaining old
archive contents; it is not persistent rollback protection across sessions/devices.
Access purge, disconnect, cache clear and disposal clear evidence and cancel work.
No startup request, periodic poll, event-union seeding or history filtering is added.

This is finite evidence, not a live archive directory.
As in base Buzz, mention autocomplete, the
mention picker and member-add omit archived identities: fail-open while the
snapshot is unknown, never hiding the viewer from themself, and never touching
history or channel membership. `not-archived` means absent from the read snapshot, not online,
owned, authorized or guaranteed current at a later write. Delta processing and
packaged/live acceptance remain separate.

`session.archives.request("archive" | "unarchive", pubkey)` sends exact 9035/9036
requests (`["-"]`, one `p`, optional `auth`) through the session's signer and
publisher (`identityArchive`), never the outbox writer. `consent` is the render and
pre-sign guard: it accepts only the target itself (NIP-IA self request, no `auth`),
a verified NIP-OA owner, or a relay owner/admin in the relay-signed 13534 roster;
the relay re-verifies consent. An owner request copies the target's single live
`auth` tag, verified against the target with `kind=` clauses ignored and
`created_at` bounds checked against the request time. Success requires a fresh
13535 re-read showing the new state; a publish with an unknown outcome is reconciled
by that re-read, and only a definitive relay rejection skips it. No profile pane
offers Archive or Unarchive now; the only caller is agent deletion.

**Delete agent** on Agents forgets the agent's key on this device, then
(`AgentsService.cleanup`, shared helpers in `features/agents/relay-removal.ts`)
runs whenever its community is open:

1. An exact one-member 9001 (`h`, `p`, `client-id`) goes through the outbox for every
   channel whose relay-signed 39002 roster lists the agent, plus the viewer's loaded
   channels. Each channel's own fresh roster must then omit the agent.
2. A fresh archive read runs; unless it already lists the identity, it is archived
   through the request path above when a consent path exists. An agent that never
   published an owner-attested profile has nothing to hide and is not archived.
3. The saved record is forgotten.

Any failure leaves the cleanup to be retried on the next refresh or connect.
`removeRelayAgent` applies the same steps to a relay-only agent: archive when
consent exists, delete the owner's kind 30177 record (NIP-09), then remove it from
its channels on a best-effort basis.
Protocol source: old Buzz `b9392d9` `docs/nips/NIP-IA.md`, especially relay identity,
snapshot format and snapshot/delta consistency. Tests use the actual session and
HTTP broker/verified transport, including corrupted signature rejection.


## Agent Activity plugin

**Agent Activity** owns live capture demand and the full Transcript/Raw panel;
host-owned saved history remains independent of plugin enablement. This branch
adds an avatar-and-dots bubble beneath the exact message that triggered current
work. Multiple turns group by agent; completing one turn does not hide another.
Hover, click, tap or keyboard opens a compact avatar-and-latest-tool popup. Its
row opens that exact agent's profile Activity tab, using the mainline transcript,
conversation filtering and saved-history controls. Escape or outside click closes
the popup. Human typing remains in the ordinary conversation indicator.

### Local plugin-agent lifecycle

The popup resets on conversation changes and when current work ends. Idle and
historical activity remain accessible from the activity panel rather
than lingering above the composer. Compact status labels omit raw arguments and
full paths; the transcript retains the detail.

Thread indicators consume the existing kind-20002 typing signal with the resolved
NIP-10 root, not inferred observer turn IDs. The existing per-channel live route
carries it; typing bypasses ordinary history, unread and persistent caches.
Only identities observed on the current live owner-visible feed are
recognized; restored history never establishes typing ownership. Typing before that first frame, or without telemetry publication,
is deliberately omitted; public typing alone does not establish ownership.

Typing expires eight seconds after its signed timestamp (future clock skew is
capped at receipt), swept by the existing one-second activity timer. Messages
clear only the matching agent/channel/thread scope and suppress delayed typing
for two seconds. Disconnect, channel-route failure, disable, access/cache clear
and disposal drop typing evidence. A fresh observer frame does not refresh it.

The sidebar's quiet working dot has two independent sources. The plugin source
is fresh channel observer turns or the channel-scoped typing above, and follows
the plugin's lifecycle. Observer records have no thread identity, so its details
remain explicitly channel-wide.

The display-only source is `session.typing`, not the plugin's typing evidence:
typing by one of the viewer's own agents (`session.agentChoices`: local agents and
the library) anywhere in the channel, threads included. Typing remains a working signal when observer telemetry is explicitly disabled. Other people's agents, known only from a
self-declared profile hint, are not shown. This store keeps working with the plugin off, rejects
future timestamps instead of capping them, schedules its own expiry eight
seconds after the signed timestamp and stays quiet for two seconds after the
typer's message. It is display-only evidence, not ownership; while the plugin is
off, the channel popover lists such an agent without a **View activity** action.
A timeline thread summary shows the same dots from this source while one of the
viewer's agents types in that thread; before the first reply it offers **View thread**.
The visual working label is reduced to dots; its accessible name retains the status.
No harness change, new subscription, directory or timer is added.
The development broker loads subscription filters at startup: restart the
existing dev server once to receive typing; frontend HMR alone is insufficient.

### Transcript

The panel opens on **Transcript**; **Raw** keeps the exact diagnostic records
below. `activityTranscript` (`src/features/agents/activity-transcript.ts`) is a
display projection over the same session-owned records, not a second store. It
reads allowlisted ACP fields into turns: the triggering prompt (author and content
from the `<buzz-event>` framing, other sections collapsed), the session's system
prompt, thoughts, assistant text as Markdown, tool calls, permission requests joined to
their tool call with the auto-approval outcome, plans, mode changes, the session's
selected config values (e.g. model), context usage, stop reason and errors. Tool
names and inputs differ by adapter (Pi, Goose, Codex, Claude), so tool rows show the
adapter's title and raw input as sent; only ACP's standard `kind` (icon), `status`,
`locations` and content (text, with a wholly fenced Markdown block shown as its body,
and `diff` as removed/added lines) are interpreted.
Adapter-specific `_meta` such as exit codes stays in **Raw**. The one adapter
special case: pi-acp repeats its `session/new` startup banner
(`_meta.piAcp.startupInfo`) as an agent message, which the transcript omits. JSON-RPC ids are matched per pool slot and
direction. Agent-elided strings and payloads are labeled, not hidden. Turns whose
`turn_started` frame is not loaded are marked as partial. Posted chat messages are
not joined here; the transcript shows the agent's ACP output.

Agents use a channel or a thread as their conversation context, so one
**Conversation** selector scopes the view: all conversations, a whole channel
(threads included), or one thread. Threads are listed from loaded turns and named
by their first prompt. A thread composer opens `buzz:agent-activity?…&thread=<root>`
(valid only with its channel) with that thread selected. A turn's thread root is
the payload's `threadRootEventId` (harness 2026-10-01 and later) or, for older
harnesses, the prompt `<context>` block's `Thread root:`. Turns whose thread cannot
be recovered appear only in the whole channel and are counted, never guessed. The
whole channel labels each turn as channel conversation, a thread or unknown. Each
turn starts with a **Turn** line (start time and the session's selected config as
`Name: choice`, e.g. `Effort: Medium`, or the adapter's label when it already names
the setting); its status line notes when the turn started a new ACP session.

The transcript covers only loaded records: the live window plus one saved page.

In **Raw**, a channel or thread selection filters entries and working-turn counts
to that channel; all conversations includes unscoped records. For a selected channel, batches are projected
as individual matching children, with the original envelope ID retained; displayed
child JSON is reserialized, not claimed byte-identical to the envelope. Unscoped
children are omitted rather than inheriting the enclosing batch's channel. The
all-channels diagnostic retains the exact raw envelope. Raw capture is unchanged.
Channels owns contextual panel placement and closes it on channel/session or
contribution changes; close returns focus to the originating control if retained.

The plugin's activation leases `session.agentActivity` for the live display;
closing the panel does not release that demand. Disabling the plugin clears its
live evidence, but **does not control archive capture**. The shared live connection
carries one dedicated owner (`#p=viewer`) route for demanded observer/metrics kinds,
with no `#h` or history limit. Live activity starts at actual dispatch/retry.
When a kind-demand change replaces a metrics capture route, stored 44200 replay
bridges the admission delay with a 60-second in-flight overlap, capped at four
minutes at dispatch to leave headroom inside the five-minute ingest window. This
replay floor clears at EOSE; later retries are live-only. Ephemeral 24200 cannot
be recovered this way. Settings changes and plugin demand replace that route only
when its combined kind demand changes. While capture is enabled, display-generation
changes keep the wire and capture floor but advance a separate display freshness
floor. Without capture, display resets still renew the live-only route. Neither
lifecycle replaces the socket or chat globals. An uncertain control failure can
reconnect the shared stream through its existing bounded recovery path.

The native identity host and development broker validate signatures, exact tags,
recipient/key, freshness and size before ingest and host-only NIP-44 decryption.
The renderer receives purpose-bound DTOs, not keys or a general decrypt API.
Historical decoding accepts only rows owned by the host archive, not arbitrary
renderer-supplied old envelopes. Native ingestion is **renderer-delivered,
host-validated**, not host-captured: the main renderer owns the relay socket and
supplies fresh envelopes through IPC. The native host does **not** independently
prove relay delivery or that the signer belongs to the viewer. Buggy or malicious
trusted renderer/plugin code can plant plausible history and evict genuine rows
by filling the quota. This deliberately retains the existing
[trusted main-WebView model](identity.md), not a hostile-plugin boundary; moving
the relay connection or isolating plugins is outside this change. The development
broker instead captures only from its own stream and rejects browser ingestion.
Relay admission, not a name, local library entry or successful decryption, is the
ownership authority on the normal delivery path. Saved rows are not ownership proof. These records
never enter ordinary message history, unread reconciliation or channel caches.

Live RAM is limited to 200 envelopes / 2 MiB plaintext and 512 turn states, with
visible trimming. Historical pages do not consume the live-record allowance.
Disable, cache/access reset and session replacement clear live evidence. A batch
with a recognized denied channel is hidden as a whole.

### Host-owned saved activity

SQLite stores original signed, owner-encrypted envelopes, partitioned by normalized
community endpoint and viewer public key. It stores no plaintext, decoded channel
metadata, turn state or private keys; signed metadata (agent/recipient keys and
event timestamps) remains visible on disk. The native database lives under the
app-data directory in `archive/events.sqlite3` (`archive-debug` for debug builds).
The development broker uses `~/.buzz-foundation/dev-archive/events.sqlite3` on the
**broker's machine**, not browser-local storage. Settings show the actual path.

The store implements exactly two owner-scoped policies, both enabled. Unused
`scope`/`value`/`kinds` columns are removed by a transactional v1→v2 migration that
preserves settings, revisions and ciphertext. General subscription matching and
management wait for a caller beyond these two policies; the schema does not claim
that capability:

- **Activity (24200):** 30-day maximum age by default, configurable from 1–90 days
  (Settings offers 1, 7, 30 and 90); 512 MiB of serialized envelopes per
  viewer/community, with a 128 MiB per-agent limit.
- **Turn metrics (44200):** independent capture, 90-day maximum age, 64 MiB per
  viewer/community and 16 MiB per agent. Metrics remain encrypted, unlike classic's
  plaintext metrics archive. No usage dashboard or arbitrary-subscription UI is added.

Quota totals choose the overflow; indexed oldest-first scans stop after enough
bytes are found, rather than rescanning retained history. Oldest records are evicted when byte limits are reached, so retention is a maximum
age, not a promise of a complete 30-day transcript. Budgets are separate for each
account/community and kind, not a physical device-wide disk cap. SQLite indexes,
WAL and other overhead use additional space. Expiry across inactive partitions is
operation-driven and throttled to once a minute, not an OS background purge;
reads also exclude expired rows. Pruning reclaims free pages incrementally and
explicit clear attempts full free-page reclamation after the delete commits.
Newer schema versions are rejected without downgrade.

Reopening/reloading reads 100-row keyset pages through the key-owning host.
Historical decode revalidates signatures, exact tags, recipient and retention age,
without weakening the live five-minute freshness gate. Bad rows are counted and
skipped without trapping pagination. Live records win event-ID deduplication.
Restored rows are display-only: they never create working turns or typing evidence.
Channel-scoped rows need positively known local channel access, including every
recognized batch child. Access changes immediately re-filter retained rows without
rewinding pagination. Unknown/capped/suspended membership hides history rather than
erasing it; positive access can reveal it again. Agent removal and sign-out do not
erase ciphertext; another account cannot open that partition.

**Settings → Agents → Saved agent activity** has independent capture switches,
activity retention and confirmed **Clear activity history** / **Clear turn metrics**
actions for this account/community. Shortening retention requires confirmation.
Turning capture off preserves saved rows. Clear advances a durable revision to
fence stale writes and pending hydration; new traffic can be captured afterward.
Another window's already-decoded display is not synchronously reconciled; reload
it after clearing elsewhere. Developer cache clear also deletes this community's
activity partition and reports deletion failure rather than claiming success.
Storage/decoding errors, including metrics-save failures, are visible and do not
stop live telemetry. An initial native settings-read failure retries at 1/2/4
seconds while settings remain unknown; disposal cancels retries and fences late
responses. After exhaustion, open Settings or reconnect to retry. SQLite waits,
maintenance and paging run off the async thread under only the archive mutex;
the identity lock covers envelope validation/decryption, never storage. Viewer
checks surround storage/decryption. The identity is immutable once ready today;
a future in-process account switch needs a generation fence for admitted writes.
Settings values and their CAS revision are read from one SQLite snapshot. No
old-app import, general relay backfill, export or transcript redesign is included.

Working is fresh per-turn evidence, not process status. Batch children fold
individually; `session_resolved` is activity, while `turn_completed`, `turn_error`
and `agent_panic` end the agent/turn pair even with a null session ID. Silence
beyond 30 seconds or disconnect makes work unknown, not stopped. Terminal state
retains a monotonic evidence timestamp through clock rollback and bounded eviction.
There is no agent-global sequence gate: producer sequences reset, skip and interleave.

### Try with an existing owner account

Use the [README's public-pin/Keychain setup](../README.md#relay-channels) and run
`bin/just web` (or `bin/just desktop`). Open the printed Local URL, choose
the agent's community and open a channel. Keep a runner active for that agent, with
telemetry publication enabled, then give it work. This activity plugin does not
start agents. No records may mean publishing is off, no new traffic, or an
interrupted feed, not that an agent is idle.

For a contextual view, click the identity's avatar/mention in the channel, then
**View activity**. It preselects that exact key and channel; **Conversation → All conversations**
broadens the view. Alternatively, select an active agent above the channel or thread composer.
Check the transcript, then open **Raw**, expand entries and close/reopen the panel. In **Settings → Agents → Saved agent
activity**, verify both capture switches and the host path. Disable the **Agent
Activity** plugin in **Settings → Plugins**, give the agent work, then re-enable:
archive capture should continue independently, and restored rows must not claim
the agent is working. Reload and reopen **View activity**; saved entries should
remain. Use **Load older activity** when another page is available.

Turn **Save agent activity** off, give the agent work and verify live display still
works without retaining that new activity across reload. Turn it back on. Cancel a
retention-shortening confirmation and verify the original value remains. Confirm
**Clear activity history** in Settings, reload, and verify old activity is gone
while metrics remain independently retained. For native acceptance, quit/relaunch
the desktop app as well as reloading its view.

The feed is best-effort telemetry: producers coalesce/batch and may elide oversized
content, and storage budgets can evict rows early. It is not a complete ACP
transcript. Both the development broker and packaged native identity host implement
the archive; no runtime controller, recording export or old transcript renderer is
included.

### Coverage

Archive coverage lives in `browser-host/archive.test.mjs`,
`src-tauri/src/archive/tests.rs`, `src/features/archive/client.test.ts`, the
activity/session/native transport tests, and `src/app/ArchiveSettings.test.tsx`.
`browser-host/agent-observer.test.mjs`, `browser-host/relay-broker-live.test.mjs`,
and the activity/live service tests cover signed/encrypted WS to host decode to SSE
to the actual session, route generations, terminal retention and stale controls.
`tests/browser/agent-activity.spec.mjs` covers the actual plugin, raw HTML
nonexecution, keyboard disclosures, agent selection and disable/re-enable in
Chromium and WebKit. These use ephemeral identities and synthetic telemetry.
Packaged GUI quit/relaunch, real-relay agent ownership admission and hosted
cross-platform checks are separate gates; consult the pull request for results
tied to its head.

## Shared identity names

Distinct agent keys with the same displayed name receive a short npub suffix,
regardless of their profile links. Names are compared after trimming outer
whitespace, with case preserved. Directory qualifiers use a middle-dot separator
(`Honey · 2abc`). Unique displayed names have no suffix. These display labels are
not serialized into mentions. The composer retains its existing inline-chip
qualifiers for selected namesakes, independently of live directory labels. Collision
checks include library identities and ready local agents in the current community.
Name edits update the suffixes; they never merge identities or profile groups.

The Identity Naming plugin (`buzz.identity-naming`) registers its policy with the
app-owned identity-name service (`features/identity-names`). Each relay session binds
its own view. A ready local agent takes precedence only in its matching community;
otherwise a signed public agent profile's name, then the library's saved name, then
the public profile. With no policy registered, public-profile names and caller
fallbacks apply. These labels never change identity keys, membership, credentials,
or runtime admission. Messages, mention choices, activity, conversation labels and
new notifications consume this view. Mention parsing still uses signed identity
evidence before resolving its visible label. The portable policy is specified in
`src/bundled/identity-naming/README.md`.

## Community inventory

`agentLibrary` is the display inventory behind `agentChoices`. Each session reads
the owner's kind-30175 profiles and kind-30177 identities from its accessible relay,
and also the host's saved Buzz library: the development broker's
`/api/relay/agent-library` reads `agent-controller/agents.json` under the
`dev.local.buzz.foundation` data directory, and the native host reads the Classic
post-fold `xyz.block.buzz.app/agents/managed-agents.json`. The host read is
read-only: it writes no configuration, migrates no identities, retrieves no
credentials and manages no processes, with 8 MiB / 2000-record caps. Only definition
ID/name, identity public key/name/definition link and optional avatar artwork leave
the host. Optional artwork accepts HTTPS without credentials or bounded raster data
URLs, never file URLs or SVG data.

The inventory joins exact public keys, not equal names; explicit profile references
use the publisher's slug mapping only when local definitions do not collide. Local
names and artwork win for matching keys. A failed source leaves the other source
visible with a warning. Reads are lazy (once per demand or Refresh), with no polling
or relay-directory startup scan.

Discovery is not global coverage, verified membership, credentials, or execution
status. No keys, config, memory, membership, or runtime state are changed by it.

## Channel session usage

The Usage tab reads saved kind-44200 metrics from the current account/community's
host archive. Its strip and detail are **channel-associated session**
usage, not thread attribution or context-window capacity. Each signed agent key
and reported harness session remains separate; missing session IDs are individual
unidentified records. The latest cumulative snapshot is selected by turn sequence;
turn deltas are shown only when reliable. Unknown counters are not zero and cache
counters are subsets of input. Cost is a publisher-supplied estimate, not a bill.

The Usage tab's agent dropdown shows each agent's latest total or session count;
selecting an agent reveals an aggregate of the latest trustworthy cumulative
snapshot from each of its sessions. Counters missing in any session remain unknown
rather than silently understating the total. The outlined Session dropdown then
selects one session for provenance and turn detail without filling the pane with
session buttons. The aggregate may cover other threads and is limited to loaded
archive history.

The channel's **Channel actions → View channel usage** item opens a dedicated
**Usage** tab in the channel's side pane. It is available only while this
account has positive access to the current channel and the default-on Channel Usage
plugin is enabled under Settings → Plugins. Closing the tab unmounts its
archive reader; disabling the plugin removes the tab and stops reads. It
does not change metric capture or retention. Opening the Usage tab reads archive
pages automatically until exhaustion or the 2,000-record limit; an early page
without channel matches does not prove the archive has none. **Refresh** starts
a new scan from the newest page; neither action fetches relay history. The client
retains at most 2,000 decoded records while this tab lives and fences late reads
on channel/access changes. Saved metrics remain
subject to the independent 90-day/byte eviction policy above, so loaded history
is never a completeness guarantee. Restored usage is display-only and cannot
establish working, typing, or online status.
