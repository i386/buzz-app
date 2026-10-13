# Identity naming conflict demo

This runs the real Buzz app and shared naming plugin against synthetic local data.
It does not rename real accounts, connect to a shared relay, or run agents.
Production naming code is unchanged by this demo.

## Run and capture

From the repository root, with dependencies installed:

```sh
source bin/activate-hermit
node tests/demos/identity-names/server.mjs
```

Open **http://127.0.0.1:1435/**. No login is needed. Use Messages for cases
01–18 and the surface tour. Use Sessions for the existing-session and new-session
menus. Agents shows production management UI with a read-only modeled host.
Open **http://127.0.0.1:1435/?library** for the browser-only agent library; click
**Refresh agents**, then expand **Honey template: 2 identities**.

In a second activated shell:

```sh
export DEMO_OUTPUT="$PWD/test-results/identity-names-demo"
node tests/demos/identity-names/capture.mjs
node tests/demos/identity-names/surfaces.mjs
node tests/demos/identity-names/gallery.mjs
open "$DEMO_OUTPUT/INDEX.html"
```

These scripts use the installed Playwright Chromium in fresh browser contexts.
They do not use an existing browser's account or remote debugging session.
`capture.mjs` asserts the rendered labels for all 17 focused cases, then captures
an all-conflicts scene. `surfaces.mjs` opens the actual application controls.
The JSON manifests record HEAD, worktree status, browser version, and captions.
The gallery links the original full-resolution PNGs. No screenshots are committed.

Restart the server and use a fresh browser profile/context to reset the demo.
Capture scripts send synthetic live events to this local server. Local messages
are memory-only; restart discards them. Settings/read state are local to port 1435.
Do not use this port for a real account. No real keys or credentials are used:
all signing keys are intentionally public test scalars. Owner tags are display
facts, not proof of enrollment or authority. Profile loading through the member
picker supplies readable owner names; cold library views can use key suffixes
when owner profile facts have not yet loaded.

## Decision table

| Case | Rule |
| --- | --- |
| 01 | Unique name unchanged |
| 02 | Viewer human stays plain; other human gets last-four npub |
| 03 | Equal-priority humans both get suffixes |
| 04 | Human, own agent, other owner's agent: plain / `(agent)` / possessive |
| 05 | Own agent stays plain before another owner's agent |
| 06–08 | Same-owner duplicates; readable qualifier retained before suffix |
| 09 | Equal owner display names require identity suffixes |
| 10 | Missing owner facts fall back to keys |
| 11 | Readable qualifiers are preferred to keys |
| 12–13 | Generated possessive/agent labels rechecked against literal names |
| 14 | Real npub last-four collision extends to five characters |
| 15 | Generated suffix rechecked against a literal suffix name |
| 16–17 | Case-sensitive matching; surrounding whitespace trimmed |
| 18 | Combined conflict stress scene (top and bottom captures) |

## UX surface map

All filenames below end in `.png` in the output directory.

| Surface | Capture |
| --- | --- |
| Channel message author, avatar/name action | `human-agents`, `surface-timeline` |
| Thread root/reply | `surface-thread` |
| Thread participant avatar | `surface-thread-participant` (title attribute checked; native tooltip pixels not captured) |
| Sent mention, join row and member avatar | `surface-sent-membership` |
| Typing indicator | `surface-typing` |
| Sidebar unread-thread author | `surface-sidebar-activity` |
| Channel agent activity | `surface-activity-accessory` |
| Profile heading | `surface-profile` |
| Message preview author | `surface-link-preview` |
| DM preview author and conversation label | `surface-dm-preview` |
| DM navigation/header | `surface-dm` |
| Search DM/message author | `surface-search-dm`, `surface-search-message` |
| Mention picker, inline completion, selected chip | `surface-picker`, `surface-completion`, `surface-draft` |
| New/existing session choice menus | `surface-new-session-selector`, `surface-existing-session-selector` |
| Exact older session target | `surface-session-target` |
| Media-comment author | `surface-media-review` |
| Observed-agent selector | `surface-activity-selector` |
| Managed-agent title/actions, editor | `surface-managed-agents`, `surface-agent-editor` |
| Library template identities and custom cards | `surface-agent-library`, `surface-library-custom` |
| Notification sender | `NOTIFICATION_PAYLOAD.json` — API payload only, not an OS screenshot |

The earlier surface inventory included recognized person references in
`ReferenceText`. Its sole production caller in `MessageMarkdown` passes
`mentions={[]}`; person/agent references take the bound mention path instead.
There is no separate reachable person-reference tooltip to capture in this build.
Plain unbound `@Wes` remains text. This is an inventory correction, not a product
change. Channel references are not identity naming surfaces.

## Boundaries

- Vite source app, not a packaged desktop binary. All layout and name rendering
  use production components. The server substitutes only transport/control data
  and exposes services to capture scripts; it does not replace the naming policy.
- The local agent list is modeled. Nothing runs or is saved on the machine, so
  its browser screenshots do not establish native process behavior.
- Browser notifications are recorded at the Notification API boundary. No fake
  OS banner is drawn. A real OS notification screenshot remains a manual check.
- Presence/read synchronization and some unrelated host operations are not
  implemented. “Unknown” presence and unsupported-host notes are expected.
- This is a manual screenshot/demo fixture, not a new CI browser matrix or a
  complete relay emulator. It models the query paths required by the tour,
  including ascending thread pagination and an older exact session target.
