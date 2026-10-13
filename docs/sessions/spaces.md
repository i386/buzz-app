# Me and Messages: channel spaces

**Status: superseded proposal, retained for design history.** The approved baseline
uses client-side Me organization over ordinary channels, not a relay-enforced
space classification. The [current implementation](README.md) uses encrypted,
account/community-scoped `groups:me` preferences and independent Me defaults.
It does not infer placement from the roster or promise the admission policy below.
The protocol, relay enforcement and rollout sequence in this historical proposal
are not requirements implemented by the baseline, nor authorized follow-up work.

## Product contract

- One ordinary channel system, transcript, composer, membership and delivery path.
  Me and Messages are two experiences over it, not separate message stores.
- A channel has one durable space. Me is personal: the human owner and that owner's
  agents. Messages is collaborative and may be private or public. Private visibility
  alone does not mean Me, and a one-person Messages channel stays in Messages.
- Groups and channel assignments are personal organization, separately scoped by
  account, community and space. Me starts with no custom groups. Never import,
  rename or delete Messages groups as a side effect of editing Me groups.
- Owner-authorized promotion moves the same channel into Messages, preserving its
  ID, transcript, Canvas and valid memberships. Private is the default. Explicit
  sharing discloses existing history to the new audience; public conversion needs
  an explicit full-history warning. Promotion is not a copy or a destination link.
- Local agent availability never determines a saved channel's space or read access.
  Agent selection and new admission still require appropriate current evidence.

## Nostr representation and compatibility

Use the existing NIP-29 flow: creation through kind 9007, authorized metadata
commands through kind 9002, relay-signed current metadata in kind 39000, and
ordinary channel messages carrying their existing `h` identifier. Channel identity
includes its community/authoritative relay, not only the channel ID.

The space field is a **documented Buzz extension**, not a standard NIP-29 field.
Use a single enumerated value; `personal` and `collaborative` are proposed wire
values, mapped to Me and Messages in the UI. The exact tag name, extension version
and capability advertisement must be fixed in the reviewed protocol contract.
UI labels and plugin IDs must not become an extensible authorization vocabulary.

| Input | Required behavior |
| --- | --- |
| Complete authoritative metadata without space | Collaborative / Messages |
| Explicit personal | Me, subject to the personal channel policy |
| Explicit collaborative | Messages, regardless of participant count |
| Unknown, duplicate or contradictory space | Unsupported/invalid; do not silently normalize to Messages |
| Metadata not loaded or unverifiable | Loading/unavailable, not evidence of a missing space |
| Edit command omitting space | Preserve existing space |
| Explicit personal-to-collaborative transition | Owner-authorized promotion |

Existing ordinary channels need no bulk backfill. Legacy session description
markers are not evidence of the new personal policy: absent space means Messages,
including historical shared/parent-linked sessions. Do not silently relabel or
revoke access to make an old session qualify. Any later adoption of an existing
session into Me needs a separately reviewed eligibility/ownership transition;
that reverse transition is outside this slice.

A client must establish that the relay supports and enforces this extension before
offering personal creation. A successful acknowledgment of an unknown tag is not
sufficient. Verify the resulting relay-signed metadata and membership before
presenting creation or promotion as confirmed. Older clients may display a channel
in their ordinary lists; server policy must still reject incompatible membership,
visibility and ownership changes. Ordinary legacy edits must not erase the mode.

## Authority and transitions

The relay remains the access-control authority. Space constrains membership and
lifecycle changes; it does not replace signed membership or provide end-to-end
encryption. Personal channels must stay private with an explicit human owner and
only that owner's agents. Relay-side ownership evidence, not local runtime
inventory, display names, bot roles or client-provided assertions, decides which
agents qualify. Define treatment of legacy agents with missing ownership evidence
before allowing them into a personal channel; never guess.

Apply the invariant at the authoritative database/write boundary so CLI, agents,
old clients, invite/join paths and administrative writes cannot bypass it.
Concurrent invitations, visibility edits, ownership changes and promotion must
serialize against that state. Reject unsupported personal ownership transfer or
reverse promotion until a separate policy exists. The protocol review must also
specify what happens if an admitted agent's ownership changes.

Promotion changes classification before external membership grants. Public
promotion must atomically establish a valid collaborative/public state or fail;
never expose a public channel still marked personal. An old or replayed command
must not undo a newer transition. Reuse existing durable command delivery and
exact receipt/readback mechanisms rather than introducing a second outbox.

A failed later invitation does not roll back a confirmed promotion. Report the
actual state and allow recovery without duplicate creation or grants. If a
Messages group assignment fails, the promoted channel remains visible unfiled in
Messages. Ignore obsolete Me assignments for routing; personal group cleanup is
not an access-control transaction. Do not copy a Me group into Messages.

## Organization and plugin views

Store Me groups, assignments and section defaults under distinct account/community/
space preference coordinates, reusing existing private preference delivery and
revision checks. Preserve existing Messages coordinates. Selecting the first
arbitrary groups record is no longer valid once multiple spaces exist. Me section
defaults must not fall back to Messages defaults.

One channel belongs to one canonical space but can be shown by multiple authorized
plugin views. A plugin reference never grants access, changes the space or implies
membership inheritance. No per-message space tags, plugin registry, generalized
placement array or group promotion is needed for this feature.

## Performance

Read classification with existing channel metadata and normalize it once in the
channel projection. Sidebar placement must require no per-channel extra query,
agent inventory refresh or participant-by-participant ownership lookup. Admission
validation belongs on the write path. Omitting the default value avoids a backfill;
it is not by itself a meaningful performance guarantee. Measure affected request
counts and sidebar behavior during validation rather than claiming an unmeasured
speedup.

## Implementation sequence and acceptance

1. **Review the contract:** tag/cardinality and capability semantics, authoritative
   agent ownership, atomic transition/replay behavior and legacy compatibility.
   Keep the extension documented alongside the relay implementation.
2. **Relay and host support:** enforce and emit the canonical state, then update
   native signing/decoding and supported existing host adapters. A coordinated
   relay change is required; this cannot ship as an app-only privacy promise.
3. **App adoption:** replace roster inference, isolate groups/defaults, route
   channel links consistently, and add same-ID promotion using existing owners.
   Preserve frozen first-send setup, receipt-only recovery and ordinary channel UX.

The app branch owns app/native changes; relay work belongs in a linked change in
`block/buzz`. Keep delivery draft until the dependencies and acceptance checks are
clear. Do not equate the existing destination-sharing implementation with promotion.

Required evidence covers: absent/unknown/duplicate metadata; old-client edits and
unsupported relays; direct admission bypass attempts; agent ownership and concurrent
transition races; promotion failures/retries/restart; stable reads while agents are
unavailable; isolated group creation/deletion/defaults and cross-device readback;
ordinary private/public Messages behavior; and explicit full-history confirmation.
Frontend checks do not prove native signing or relay enforcement. Live writes and
native process restarts require coordination; no live migration is authorized here.

## References

- [NIP-29: relay-based groups](https://github.com/nostr-protocol/nips/blob/master/29.md)
- [Buzz vision: access](https://github.com/block/buzz/blob/main/VISION.md#access)
- Current app owners: `src/features/sessions/personal.ts`,
  `src/features/relay/discovery.ts`, `src/features/relay/work-sessions.ts`,
  `src/features/relay/me-preferences.ts`,
  `src/features/channel-templates/model.ts`, `src-tauri/src/relay/kit.rs`.
