# Shell design

The shell is owned by `src/app/shell`, independently of relay operations and page
content. `App.tsx` composes startup/recovery, built-in Settings, and the
existing contributed-page lifecycle. Messages is the default destination at
startup; legacy Home targets resolve to Messages in the same visit. Old version-1
Channels Inbox/Bestie routes resolve to their standalone pages in that same visit,
preserving community scope and normal plugin availability checks. Channels is
required, including when older preferences saved it disabled. Navigation removes
disabled optional plugins
from page choices; a retained destination whose provider is unavailable displays
an explicit failure with retry instead of silently selecting another page.
Browser controls, host shortcuts and toolbar arrows traverse the same visit history.
Settings sections are destinations. Personal-space page visits use explicit null
scope, distinct from a plugin's unspecified community scope. Focus-only skip links
do not add visits. Plugin recovery remains available in Settings → Plugins without
blocking Profile or Appearance.

See [design system and appearance](design-system.md) for Light/Dark settings,
semantic tokens, UI authoring rules and the local component reference.

## Where to change the design

- `src/shared/styles/globals.css` owns the semantic palette exposed to Tailwind:
  `ink`, `muted`, `line`, `soft`, `shell`, and `shadow-surface`. Default element
  styles live in Tailwind's base layer, so utilities can override them normally.
  Existing feature CSS variables remain available for incremental adoption.
- `src/app/shell/presentation.ts` owns page labels, icons and navigation ordering.
  Me comes first, then Messages, Inbox, Reminders, Bestie and Projects; other contributed pages
  follow by displayed label with a full contribution-key tie-breaker. Sidebar
  navigation and page search share this ordering, independent of plugin
  activation/re-enable order. Primary pages choose `sidebar` (default), `topbar`
  (centered text) or `toolbar` (top-right icon) placement. Me and Messages start
  in the topbar; other primary bundled pages retain their sidebar rows. Me is an
  optional, default-enabled personal-conversation workspace in the current
  community. Its dedicated SidebarFrame reuses saved channel-sidebar width and
  shows New conversation plus personal history, replacing Messages navigation.
  Scoped Me page routes own sidebar/content selection. The initial implementation
  reuses the existing session transcript and composer; see [Sessions](sessions/README.md)
  for placement rules, remaining ingress differences and the relay privacy boundary.
  Messages opens by default, from any channel row, its topbar button and search.
  Page search lists every active page, including non-primary pages.
  Disabling an optional plugin removes its navigation entry.
  Channels is presented as Messages. Legacy tone props are retained for
  compatibility; all pages share the supplied gradient and repeating CSS dots.
  Presentation is keyed by full contribution identity, not plugin-local IDs.
- `AppShell.tsx` owns the 48px header, vertical page navigation, contributed panel
  launchers, Settings access, community rail, and page frames. Page navigation sits
  above the channel list outside Settings, using its saved sidebar width
  and resize behavior. Settings replaces that region with `SettingsSidebar.tsx`,
  preserving the same width (220px minimum) and returning to the previous view
  with Back. `App.tsx` composes `features/channel-navigation/ChannelSidebar`
  through an ordinary render prop; there is no portal or plugin contract expansion.
  Sidebar session state resets on scope/connection generation without remounting
  unrelated pages. Its own error boundary keeps page navigation and Settings usable.
  Page buttons use shared navigation rows and focus the main region on selection.
  At short heights page rows scroll with the channel list rather than in their own list.
  At widths up to 650px, every page collapses navigation behind the header’s
  Show navigation button to preserve readable content at 200% text size. The
  220px disclosure overlays content, supports Escape, and keeps sidebar state
  mounted. A navigation selection closes the phone drawer and hands focus to the
  main content; this includes conversation and Settings-section selections.
  Me, Messages, Agents, desktop Settings, and any selected primary page share an
  animated header toggle; hiding the sidebar preserves its mounted state and saved
  width. Pages without a Channel or Me-specific label use generic "Hide sidebar" /
  "Show sidebar" labels. Reduced motion disables the transition. Non-primary
  desktop destinations retain the visible sidebar.
  The same header keeps history and account/search actions, plus a centered
  navigation strip and full-page toolbar icons. Real control widths, native insets
  and text scale determine whether header pages fit without overlap. Otherwise
  those entries move into a labelled More pages popover (always at <=650px).
  Wide topbar pages use design-system chrome tabs with manual activation: arrow
  keys move focus, and Enter or Space selects the page while focus stays on its
  tab. Each opening carries focus intent: topbar activation suppresses destination
  autofocus, while explicit New conversation, sidebar and deep-link openings keep
  their content focus. This intent is not saved in addresses or history; retry
  preserves it for the same opening. A focused Retry navigation control hands
  focus to main once retry removes it, even if reconnect temporarily remounts
  the shell. A new opening or focus elsewhere cancels this
  handoff. The selected page is a separately focusable,
  labelled tabpanel. Toolbar
  and overflow destinations remain native buttons using `aria-current` and
  focus main content on selection. Header pages never become companion launchers.
  Independent header pages retain exact destination selection. Messages stays
  selected for registered sidebar/default-placement pages, including non-primary
  pages reached through search or links; their sidebar selection and route remain
  exact. Its tab labels the active child panel, and activating Messages from a
  child returns to the existing conversation view. More pages indicates this
  containing area with `aria-current="true"` (not `page`). Me and Settings remain
  separate; missing/unregistered destinations do not borrow Messages selection.
  The shell owns one joined Panel around navigation and page content, with a
  16px outer gutter (8px on narrow screens). Nested Panels keep their opaque
  fill and clipping but drop individual borders, radii, and shadows. Layout
  owners add one-pixel semantic dividers. Document pages scroll inside the
  remaining viewport.
- `SettingsSidebar.tsx` presents community and app sections in the shell's
  replacement sidebar. `Settings.tsx` renders the selected detail pane and retains
  drafts across section changes. The detail pane scrolls independently and keeps
  an accessible level-one Settings heading. Standalone Settings fixtures retain
  their embedded navigation, which becomes a compact row at narrow widths.
  Native buttons use normal Tab/Enter navigation and expose the current section.
  `ProfileSettings.tsx` edits the local default inline with Save and Cancel,
  sharing fields and validation with community setup. Cancel restores the saved
  profile; switching sections retains an unsaved draft while Settings is open.
  Leaving Settings discards that draft. Saving does not publish to communities.
  Plugin rows retain accessible native-button switches and show only names and
  controls. A Folder/Git import area above the list previews plugin subfolders and
  requires explicit install/update; its draft survives section switching, but
  leaving Settings discards it. Import controls are desktop-only. Management errors remain visible.
  Switches use aria-disabled plus a busy guard so a management transition does
  not discard keyboard focus.

Use utilities for layout and component styling. Shared navigation states live in
small component classes; avoid adding unlayered global rules that override
utilities or reaching into a page's CSS module from the shell. Respect reduced
motion with Tailwind's `motion-reduce` variant.

## Desktop chrome

Tauri uses `titleBarStyle: Overlay` and `hiddenTitle` on macOS. Native traffic
lights have a reserved 104px left area before the community switcher only in the
macOS desktop runtime. Web gets no inset or imitation window controls. Linux
and Windows desktop use undecorated windows with app-owned minimize,
maximize/restore and close buttons in the header, including during identity
setup. While the parser-loaded launch overlay keeps app content inert, a
window-control header is portalled to the document body above the overlay; the
launch owner removes it when the normal identity or shell header becomes usable.
Drag regions are limited to the header background; controls remain clickable.
On macOS, double-clicking that
background follows the current system title-bar preference (Fill/Zoom, Minimize,
or no action); changing the preference does not require restarting Buzz. Other
platforms retain Tauri's native drag-region behavior. The main-window capability
grants titlebar dragging and the internal maximize action used by that
handler. A Linux and Windows main-webview capability also grants minimize,
maximize/restore and close for the integrated controls. These actions do not
change the app’s existing close lifecycle. A native document-start policy hides
Minimize in Hyprland sessions and also hides Maximize on Omarchy (identified by
a nonempty `OMARCHY_PATH` within a Hyprland session), whose default window rules
suppress application maximize requests. Close remains available throughout launch,
identity setup and the shell. Other desktops retain their controls; non-Omarchy
Hyprland retains Maximize because its user-owned rules may permit it (Hyprland's
example configuration suppresses it too). This is a session-default policy, not
live compositor capability detection: customized Omarchy rules that re-enable
maximize are not inspected.
`XDG_CURRENT_DESKTOP` identifies the session (colon-separated names supported),
with `XDG_SESSION_DESKTOP` as a fallback when absent/empty. Tauri's Linux
`isMinimizable`/`isMaximizable` methods do not report compositor support.
No compositor configuration or window-action semantics are changed.
On Windows, the custom maximize
button does not expose native maximize-hover Snap Layouts, and right-clicking
the custom header does not open the native system menu. Keyboard and edge-snap
behavior remain native and require per-platform acceptance testing.
The main capability includes scoped
HTTP(S) opening for
[external links](channels.md#run-the-integration). See
[Tauri window customization](https://v2.tauri.app/learn/window-customization/).

The main desktop window uses Tauri's window-state plugin to save its size,
position, maximized and fullscreen state on normal app exit and restore them on
launch on macOS, Windows and Linux. State is local to the app's OS configuration
directory (`.window-state.json`); missing or unreadable state falls back to the
configured 1200×800 window. Visibility and decorations are not restored, so a
macOS window hidden by Close reopens visibly after Quit/relaunch and platform
chrome stays configuration-owned. Close/reopen without quitting on macOS still
uses the existing window. Before requesting placement or restoring maximized/fullscreen
mode, Buzz reads the plugin's saved geometry and checks that both ends of the 48px
client header are inside connected monitor work areas,
allowing a header to span adjacent displays and ignoring invisible frame borders. An
unreachable header falls back to the top of the primary work area (or the first
available monitor), shrinking an oversized client to fit. This covers partial
overlap after removing a monitor and fully off-screen saves; both use the same
fallback instead of leaving placement to the OS. Saved zero-sized geometry is
ignored. Validation uses requested geometry, not immediate getter results: native
setters may apply asynchronously (Linux/macOS), so getters can still report the
startup frame. The plugin remains the only state-file writer and owns mode
restoration. Linux placement remains subject to the window manager/compositor
(notably Wayland).
The plugin stores physical pixels, so changing display scaling can change the
window's apparent size. On macOS, quitting in fullscreen can preserve the
fullscreen-sized frame instead of the earlier normal size; leaving fullscreen
after relaunch may therefore produce a screen-sized window.

The top-right group contains full-page toolbar icons, enabled companion plugin
launchers, a page finder, and the local
avatar. Search, sidebar and history controls use unfilled ghost icon buttons with
32px containers, 16px icons and 10px corners, matching content-toolbar actions.
Their hover fills remain translucent over the colored backdrop.
Pressed fills are slightly stronger; icons keep full opacity. Plugin launchers
use the shared glass style.
Bestie is available from its sidebar page, without a top-bar shortcut.
`ProfileButton.tsx` subscribes to the community
service's local default profile and opens an anchored account dropdown containing
local presence controls and Settings; there is no separate top-bar Settings button.
The avatar dot shows local intent (Online/Away/Offline). The shared account menu
provides Online, Away and Offline choices: arrow keys move focus, and
Enter/Space selects without closing the menu. See
[presence ownership and limitations](presence.md). Escape, outside click and Tab
leaving dismiss the menu; Escape returns focus to the avatar. Selecting Settings
focuses the main region after the menu finishes closing, unless focus has already
moved into the page. With a community selected, the avatar inside the menu is a
menu item that opens the viewer's own profile in the shell companion slot, using
the same `profile` panel as other profile links; the panel takes focus, and
closing it returns focus to the header avatar. Personal space has no community
profile, so its menu avatar stays presentational.
The avatar does not display the selected community's profile. It uses a configured
HTTPS picture directly, with the name's first letter on a missing/failed picture
or a person icon when unnamed. No sample person's photo is used as the user's
identity. See [community/profile ownership](communities.md).
`PageSearch.tsx` uses a native modal dialog for focus containment, Escape dismissal,
and searching available page destinations. Projects is a bundled, enabled-by-default
page scaffold with only a centered title; Apps waits for a functional destination.
`CommunityRail.tsx` shows Personal space, saved communities and Add persistently
beside page content; it only delegates selection to the existing membership owner.
The rail's Add control opens the existing join dialog and returns focus to its
trigger. The former header picker is not mounted; the rail is the sole selector.
The rail reads saved-community NIP-11 icons through the same-origin broker with at
most two concurrent optional reads, including inactive communities without
opening sessions; slow icon responses cannot occupy all foreground connections.
Unavailable or unsupported images fall back to a saved icon or name initial.
Each saved community has a context menu (right-click, the ContextMenu key or
Shift+F10, labelled “Actions for <name>”) built from the shared context-menu
primitives, in the original's order: Mark all as read, then Copy community URL,
Invite to community and Community settings, then a separator and the destructive
Leave community. Copy writes the canonical HTTPS
origin and reports through the host toast stack. Mark all as read acts only on
the selected community's ready session and only while its read state can sync;
elsewhere it stays visible but disabled with a note saying why. Invite to
community appears only on the selected community, only when the relay-signed
roster names the viewer an owner or admin (the same roles the Membership
settings card reads) in both development and native builds; it opens the
Membership settings card scoped to that community. The rail reads
that roster through the selected community's existing session and verifies it
against the relay authority that session already holds, so the read adds no
session request to the connection and opens no other session. That card applies
the same role gate in native builds, with its member list, Invite members
button, direct additions and per-member actions.
A Settings section, history entry or `buzz://open` locator naming it still opens
instead of reporting unavailable. Community settings is
on every community and opens Settings scoped to that community's origin, which
selects it on the way. Leave community is on every community and opens an alert
dialog owned by the rail (“Leave <name>?”) whose destructive confirm shows a
pending state while the request runs; the menu item itself is disabled and reads
“Leaving…” for that community until the relay answers. The rail publishes the
NIP-43 leave request to the community's relay by origin, then asks the
communities service to forget it. The relay's acceptance or its "not a member"
answer removes the community and purges its device state; its banned answer
removes the community and disposes the session but keeps the device state,
because the relay still holds the membership while the ban lasts, and the
informational notice says the viewer is currently banned and the community can
be added again by its URL if access is restored, without promising permanence.
Any other refusal or an unreachable relay keeps the membership and reports the
reason. A failure after the relay has answered is the device's own and reads
that way: the community was left but this device could not finish cleaning up,
with the storage error's own words in parentheses, and leaving it again
finishes. Only the service call can produce that message; the host's selection
callback and the success notice run outside it, so a host that throws while
navigating is logged as its own error and the leave still reports success.
Saved data the purge could not clear is logged by store and adds a line to the
success notice. When the left community was selected, the rail routes the
fallback to Personal space through the host's selection callback so navigation
and ingress recovery match a click on Personal space, rather than leaving a page
scoped to a gone community. Focus
returns to the community when it is still saved; once it is gone, focus follows
the selection, to the still-selected community or to Personal space where a
left selection now lands. Closing a menu opened from the keyboard returns focus to
that community. Closing one opened by pointer returns focus to the field the
right-click interrupted: browsers focus the rail button on the click itself,
before the menu opens, so the rail remembers what had focus ahead of that move
and restores it while it is still on the page, and a right-click while typing
does not leave the caret on the rail. With nothing interrupted, focus lands on
that community.
Opening a menu or running any item never acquires an inactive session, and the
rail still claims no unread total: the unread capability provides bounded
observed evidence, not exact community totals ([unread ownership](unread.md)).

Visible copy uses Buzz, never “workspace.” The legacy `workspace` layout identifier
and CSS variable are implementation details retained for plugin compatibility.

## Assets

`public/` contains browser icons copied from Buzz's desktop icon family. Tauri's
PNG, ICNS, and ICO files are in `src-tauri/icons` and explicitly configured in
`tauri.conf.json`. Replace both sets together when the source branding changes.
The source attribution is in `NOTICE.md`. `public/shell-gradient.png` is the
exact supplied 564×1002 image, stretched across the shell to retain the complete
blue/yellow/white composition. A 36px repeating CSS radial gradient supplies dots
behind, never over, opaque cards; it makes no relay request at runtime.

## Review

Run `just iterate` for UI changes and `just scan` for the broader review checks.
Check Messages and Settings; toggle an optional bundled plugin off/on and confirm its
navigation entry follows; inspect a narrow viewport. On macOS, verify titlebar
alignment, dragging, each macOS title-bar double-click preference, and Settings
access in a built app.

## Messages

The host owns the single rounded outer surface and sidebar divider. Messages
owns flush conversation and contributed-panel regions separated by one-pixel
dividers. A single right panel fills the conversation height;
the right-column grid splits available height evenly between a local link card
and the launched companion card. Below 1000px
the right column overlays the conversation; it also overlays when the content
pane is too narrow for two columns. Below 650px it fills the page area.
Each region contains its own overflow, keeping the composer and close control visible.
Ordinary thread opens show a loading status until bounded history and initial
bottom positioning finish; the first painted replies are already in place.
Exact-message links reveal their requested row independently. A reader’s scroll
gesture takes over immediately, and loading failures keep recovery visible.
Opening a linked detail from inside a thread adds a closable tab to the same
secondary pane. Profile activity, managed-instance, and owner-profile links use
`PanelContext.push` to select an existing target or add a tab; `open` retains its
replacement semantics. A shared 2.5rem header uses 12rem tabs composed from the sidebar's NavigationItem,
with 10px corners matching adjacent icon actions, profile avatars or detail icons,
and a trailing close button.
Switching retains mounted content, scroll position, and drafts. Each tab has a
close control; Delete on a tab and Escape in its content close that tab. Closing
the selected tab selects a neighbor, and closing the last tab dismisses the pane.
On desktop, Cmd+W on macOS or Ctrl+W on Windows/Linux closes the visible selected
tab, including a selected detail tab, even while typing in the main conversation.
The macOS native Close menu uses the same action, including when an embedded
browser owns focus (embedded browsing is currently macOS-only). A terminal tab
closes its presentation, not its shell; Ctrl+W while typing in a terminal remains
shell word deletion on Windows/Linux. With no visible tab pane, Close retains
the normal window-close behavior: hide until reopened on macOS, close the
application on Windows/Linux. Hidden tabs remain intact until that window close.
Closing the last tab leaves the window open until the next press. While a modal
is open, the shortcut does nothing rather than closing content behind it.
Windows/Linux consume held-key repeats without closing further tabs or the window.
Window buttons and Alt+F4 always retain their window-only behavior. The bottom
terminal drawer keeps its existing Cmd/Ctrl+J/Hide behavior. Browser-build
shortcuts are unchanged.
Feature-local details such as harness logs remain tied to their owning profile;
closing that profile or losing authorization also removes its log tab.
The main-header split control toggles existing pane content without closing its
tabs or resetting their contents. With no content it is disabled but remains
focusable, so closing the last tab has a stable focus-return target. There is no
blank-tab creation action or channel/DM/tool picker. Tabs open from content such
as threads, profiles, channel settings and linked sessions. Todos and native
desktop Terminal remain available through their existing channel launchers;
closing a terminal presentation does not stop its plugin-owned shell.
Conversation tabs reuse the timeline, composer, draft and message-management owners;
selecting an already-open conversation selects its existing tab. Each main channel
keeps its own tab descriptors, selected tab, and pane visibility in memory for the
community session, including while visiting other pages such as Settings.
Changing the main channel unmounts its contents; returning restores those tabs and
saved conversation drafts without moving focus away from the main conversation.
A restored thread does not replay a previous Reply focus request. Feature-local
details such as logs close on that switch.
Changing session or losing a contribution retires the affected tabs and callbacks.
Tab sets are not persisted across application restarts. Opening a
detail from the main timeline still replaces the thread and transient details,
not retained channel-tool tabs. Content switches
immediately; the shared navigation selection background identifies the active tab.
Joined header separators meet the vertical dividers. The sidebar resize grip stays
visible throughout a drag while its tooltip stays hidden. Desktop main/secondary
dividers share that grip and support dragging, arrow keys (Shift for larger
steps), Home/End, and double-click to reset. Each page retains its chosen split
while the panel closes and reopens; widths clamp to the available space. Narrow
overlay layouts hide this divider and keep their normal responsive sizing.

Pointer-opened secondary panels fade and slide in over 180ms with the shared
strong ease-out curve. Desktop panels travel 12px on entry and close immediately,
so the main view reclaims its width without waiting for an invisible exit. Overlays
travel their full width and exit over 120ms. Keyboard actions stay immediate;
reduced motion uses only a fade. Resizing remains immediate.
`features/panels/PanelDock` retains inert, accessibility-hidden closing content until
its CSS transitions finish, cancels stale cleanup on reopening, and leaves selection
and focus restoration with the existing owners. It adds no timer or resize observer.
Channels opts into the reusable companion prop and owns both cards, including a
companion-only view without a selected channel or relay. Settings and legacy
pages use the host fallback frame; opening from those pages does not navigate away.
The shell supplies the outer page gutter. Channel previews, roster labels, and routine refresh
and freshness indicators are omitted. Channel Settings → Diagnostics keeps
manual refresh, outbox inspection, and timing capture available on demand.
Background thread reads and sidebar enrichment/reconnection do not insert progress
rows into populated views. Initial empty loads still explain the wait; failures
and their retry controls remain visible.

The composer preserves the session's text sending and keyboard behavior. Its
rounded input and lavender send arrow follow the reference; unsupported upload,
mention, and rich-formatting actions are not presented as working controls.
Delivery renders like an ordinary message immediately. After ten seconds from the
message timestamp, unsuccessful/unconfirmed sends show a small notice. Confirmed
messages never show a success label. Retry remains available for failed/unknown
operations. `delivery.test.ts` covers the timing boundary and terminal states.

The shared conversation layer now supplies bounded thread reading/replies and
[session-owned unread indicators](unread.md). These are separate from this styling
pass: counts remain observed rather than exact, manual unread is local-only, and
reading intent belongs to reusable conversation UI rather than shell navigation.

Harness logs remain owned and authorized by the profile. `PanelSubview` presents
the log as a sibling tab in the channel pane, with standalone Back navigation
elsewhere. Closing the log or losing authorization unmounts it and stops its
polling; switching tabs retains it and the profile state.
Todos uses the standard 2.5rem header to align with other side panels.
