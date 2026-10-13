# Design guide

## Start here when building a screen

This guide applies to all Buzz UI, including feature pages and bundled plugins.
Start with the screen's structure, then choose components, then their tokens.
Matching colors alone does not make a screen consistent. Existing app code can
contain adoption gaps; it is not automatically an approved design example.

1. Identify the surface and what its host already supplies. For plugins, start
   with [contribution boundaries](#plugin-contribution-boundaries).
2. Choose the shared composition below. Inspect its implementation and a current
   caller; keep navigation, data, and persistence with their existing owners.
3. Read the linked rules for the affected controls and states. Reuse their recipes
   instead of overriding appearance in feature CSS.
4. Check the rendered screen, including loading, empty, error, and populated states.
   Report any checks you did not perform. Follow the root contribution workflow
   for iteration; a token-check pass is not a visual review.

| What you are building | Use | Keep out of this role |
| --- | --- | --- |
| A workspace pane or full-page destination | `PanelHeader` with the [panel header recipe](#panel-headers) | A large page heading in place of pane chrome |
| Static pane identity | `PanelHeaderLabel` in the header's `title` slot | A bare title string or a custom icon/title flex row in new compositions |
| Existing tabbed pane navigation | `Tabs variant="navigation"` in that slot | New tab semantics for a static title or route destination |
| Actions at the trailing edge of pane chrome | Small, ghost `IconButton`s; shared Menu for overflow | Text buttons, forms, filters, or a primary call-to-action banner |
| Content introduction within a pane, such as a Settings page | `Header` | A second copy of the pane title with no additional purpose |
| A named content group | `InlineHeader`; Settings groups use `SettingsGroup` | Another panel header or an arbitrary large heading |
| A modal | `Dialog` / `AlertDialog` and their title, body, and action slots | Panel chrome or generic headings replacing dialog labelling |
| Empty collection or setup state | `EmptyState` with a useful next action | Hiding the pane header, or calling a loading/error state empty |
| A list, directory, or master/detail workspace | [Collection layout](#collections-and-workspaces) | A new card style for each feature or a filter inside pane chrome |
| An object opened beside the current task | [Detail panel](#detail-panels) within the existing panel host | A second dock, duplicate close button, or nested outer frame |
| Preferences, account configuration, or plugin setup | [Settings composition](#settings-pages-and-contributions) | A dashboard layout or a custom row/control recipe |
| A form, confirmation, catalog, or inspector that blocks the task | [Dialog composition](#modal-composition) | A hand-built modal shell or an unrelated pane-header rule |
| Actions, a short anchored form, or a field choice | [Anchored surfaces](#menus-popovers-and-pickers) | Interchanging Menu, Popover, and Select just because they look similar |

Component sources live in [`ui/`](ui/). Use the
[adoption map](../../../docs/design-system-adoption.md) for feature ownership and
[appearance and settings guidance](../../../docs/design-system.md) for host integration.
For details, consult [Controls](#controls), [Form composition](#form-composition),
[Surface and depth](#surface-and-depth), [row alignment](#align-row-content-not-state-backgrounds),
[Writing](#writing), and [Responsiveness](#responsiveness).

Adopted rules describe the target, even where callers have not migrated yet.
Sections explicitly marked **proposed** are not permission for a broad rollout.
Keep documented exceptions local to their stated use. If the requested design
needs a new exception or shared variant, explain the gap before expanding scope;
do not infer approval from an existing inconsistent screen.

## Compose the whole surface

Use these recipes before the detailed visual reference below. They describe
structure and ownership, not new plugin APIs. Examples demonstrate the named
pattern only; the [adoption review](../../../docs/design-system-adoption.md#composition-review)
records known gaps so callers are not mistaken for complete design approval.

### Collections and workspaces

Arrange a full view in this order: pane identity and global icon actions; optional
search/filter controls; scoped status or recovery; the collection or working area.
Put filters beside the collection they affect, with one clear reading order. A
filter does not belong in the pane's icon-action slot. Resetting a filter must be
possible when the results are empty.

Use rows for objects people scan and compare. Use cards when an item's preview or
grouped content earns the extra area; a grid is not the default for every directory.
Reuse the shared row/control appropriate to the interaction, with a consistent
leading icon/avatar slot, primary label, supporting text, and trailing metadata
or actions. Keep an independent row action outside the row's primary click target.
Do not make decorative metadata look like another control.

Use `FullPageSurface` for one page surface, or the existing workspace owner for
multiple regions. FullPageSurface supplies the surface, not padding or scrolling.
Give each independently scrolling region one intentional scrollport; fix toolbars
and composers outside it when they must remain available. Let flex/grid children
shrink before adding overflow. Do not nest an additional scrollport around an
already bounded list, timeline, editor, or terminal.

Master/detail layouts preserve list selection, scroll, and drafts while inspecting
an item. Follow the existing host's narrow overlay/navigation behavior rather than
squeezing two unusable columns into a small viewport. Selection, hover, and focus
remain distinct. Shared tabs connect related views of one object; route destinations
retain navigation semantics except for the wide shell topbar described in
[Chrome route navigation](#chrome-route-navigation). When replacing a focused page heading with shared
chrome, preserve a meaningful destination focus target, such as a named content
region. Do not add a duplicate title or discard the focus handoff just because the
shared heading has no ref or tabIndex prop. [Inbox](../../bundled/inbox/InboxPage.tsx) demonstrates
body filters and list/detail ownership; [Sessions](../../bundled/sessions/SessionsPage.tsx)
demonstrates a working area with a persistent composer. Neither is a blanket visual
template: check the adoption review before copying their surrounding chrome.

### Detail panels

First inspect the mounting host. `PanelCard` and `PanelWorkspace` can already supply
the surface, identity, close action, and tabs. A contributed body supplies object
content, local controls, and its states; it must not repeat those outer elements.
Keep object summary before detailed sections. Use panel-style tabs for related
content on the opaque surface; do not use backdrop/chrome tabs inside it.

Use the existing panel navigation/subview mechanism for related details. Preserve
the original panel's scroll and draft state, the host's close/back behavior, and
focus restoration. Do not create another overlay, navigation history, or global
panel selection to show a local detail. Profile content in
[`ProfilePanel`](../../bundled/profiles/ProfilePanel.tsx) and the
[`PanelSubview`](../../features/panels/PanelSubview.tsx) host show this boundary.
Media, diffs, browser content, and terminals retain their renderer-owned geometry
and input semantics; shared framing does not turn them into padded forms.

### Settings pages and contributions

Settings is a reading/form column inside host-owned navigation. Reuse its centered
48rem maximum column, shared insets, and responsive behavior; do not add a second
page surface, sidebar, fixed viewport width, or nested settings scroll container.
A Settings destination starts with `Header`, then named groups with `InlineHeader`.
Align headings with their groups' content, not just their outer borders.

Choose the group by how it behaves:

| Behavior | Composition | Actions and feedback |
| --- | --- | --- |
| Immediate preference | `SettingsGroup` with `PreferenceRow` / `SwitchPreferenceRow` | Control at the trailing edge; pending/error beside that setting; no unrelated Save button |
| Draft that needs explicit save | `SettingsGroup layout="form"` with shared labelled fields | Secondary action then primary Save in a wrapping action row; preserve draft, validation, and save gates |
| Manage connected objects or integrations | `InlineHeader` plus rows/list and contextual actions | Keep connection, permission, recovery, and destructive actions attached to the object they affect |
| Active connection or stepped setup | `Header`, `SettingsGroup layout="form"`, shared labelled fields, and the existing step owner | Preserve immediate setup actions and recovery; do not invent a Save step or replace the active flow with EmptyState |
| Setup or settled empty collection | `EmptyState` | Explain what belongs here and provide the available next step; do not wrap it in another SettingsGroup |

Keep group headings outside SettingsGroup, and use the documented field/section
gaps rather than each plugin inventing its own rhythm. Dependent preferences retain
the row's alignment. A row is not an extra click target around its input. Preserve
visible labels and connect help/error text; placeholders cannot replace labels.
Use `Accordion` for optional details, retaining mounted draft input where needed.
See [settings fills and spacing](../../../docs/design-system.md#content-headers-and-settings-fills).
[`NotificationSettings`](../../app/NotificationSettings.tsx) illustrates immediate
preferences; [`ProfileSettings`](../../app/ProfileSettings.tsx) illustrates an
explicit-save form. Their save behavior is not interchangeable.

### Modal composition

A modal interrupts the current task to complete a bounded task. Use the shared
`Dialog` for forms, editors, catalogs, and inspectors; use `AlertDialog` for a
standalone consequential confirmation. “Modal” is the interaction mode, not another
component to build. Preserve established stepped confirmations and their dismissal
policy rather than silently changing semantics during visual adoption.

Compose title and optional useful description, task body, then actions. Put the
completion action in the `actions` footer, with Cancel/Close before it. Keep other
task controls in the body; reserve `headerActions` for contextual utilities beside
the shared Close control. The pane-header icon-only rule does not prohibit text
buttons in dialog footers, forms, or menus. Do not recreate the backdrop, title,
close button, body padding, or footer with feature-specific markup.

| Task | Shared starting point | Scrolling |
| --- | --- | --- |
| Short form or confirmation | Content-sized Dialog, or AlertDialog for confirmation | Shared bounded body; keep actions reachable |
| Searchable list or changing catalog | `height="stable"`; `bodyLayout="flex"` when filters stay fixed | Fixed controls above one flexing results scrollport |
| Two-column catalog | `size="wide"` | Bound both content and viewport; preserve a usable narrow arrangement |
| Large diff or reading surface | `size="expanded"` | Content scrolls while title and Close stay available |
| Side inspector that must be modal | `placement="right"` | Same modal labelling, focus, and dismissal contracts |

These are starting choices, not permission to combine every option. Default to
content height; reserve stable height when changing results would otherwise make
the task jump. Do not hardcode a screen-sized modal or add header/body gaps on top
of the shared padding. [`ChannelMembersDialog`](../../bundled/channels/ChannelMembersDialog.tsx)
shows bounded search/results; [`RemindDialog`](../../bundled/reminders/RemindDialog.tsx)
shows a short form; [`DiffMessage`](../../bundled/diffs/DiffMessage.tsx) shows expanded
reading. See [dialog behavior and geometry](#dialogs-and-supporting-compositions).

Preserve initial focus, return focus, Escape, outside-click, dirty-draft, and pending
behavior explicitly. An asynchronous operation must not gain a dismissal path that
loses work. Keep failure and recovery in the modal with entered values intact.
If a nested step consumes Escape, it must not also dismiss the parent.
For an imperatively mounted dialog, verify return focus after its nested picker
closes. If automatic restoration loses the trigger, pass the surviving trigger
through the shared `finalFocus` contract; preserve the shared guard against
stealing focus after the person moves elsewhere.

The geometry options above belong to `Dialog`; `AlertDialog` does not expose the
same props or structured body yet. Its visual parity is an
[open shared-owner gap](../../../docs/design-system-adoption.md#gaps-to-address-when-migrating-owners).
Do not compensate with a private modal shell or silently switch confirmation semantics.

### Menus, popovers, and pickers

Choose by interaction before choosing size. They share a material, not semantics:

| Need | Owner | Content structure |
| --- | --- | --- |
| Invoke an action or choose a lightweight mode | `Menu` / `ContextMenu` parts | Shared items, related groups, optional separators, and trailing selection marks |
| Edit a short value or show interactive supporting content | `Popover` parts | Named content, optional short description, fields/content, and local actions |
| Choose a form value | `Select` or `Combobox` | Labelled trigger/control and options; searchable values use Combobox |
| Brief help on a control | `Tooltip` | Short hint; the control still owns its accessible name |
| Rich preview of an object | `PreviewCard` | Supplemental content; no essential workflow available only on hover |
| Editor completion or embedded media picker | Existing feature adapter and shared popup recipe | Preserve editor focus, selection, and keyboard semantics |

Do not put a form in an action-menu item or simulate selectable values with a set
of unrelated buttons. Use `MenuNote` for non-action explanatory text and `tone="danger"`
for a destructive menu action. Select an existing compact/default/wide recipe for
the content; never make every popup compact just because the screen is narrow.
Shared owners handle collision, viewport bounds, layers, insets, corners, and motion.
Use their supported `padding`/alignment props; do not add another padded card inside
the popup or cancel its styles. Keep long lists scrollable and all actions reachable.

Opening a dialog from a menu needs a deliberate focus handoff: dismiss the menu
without stealing focus from the new dialog. On completion, return focus to the
appropriate surviving trigger unless the person has moved elsewhere. See
[`ChannelHeaderMenu`](../../bundled/channels/ChannelHeaderMenu.tsx) and the shared
[menus and choice-row rules](#menus-popovers-and-choice-rows).

### States, feedback, and motion

Design the states as part of the layout, not as unrelated replacement screens.
Keep useful existing content while refreshing. Show initial loading in the area
being loaded; put an error and retry beside the operation that failed. Distinguish
no results, nothing created yet, missing permission, unavailable host capability,
and failed loading. An empty result explains how to broaden the search; a setup
state offers a next step only if that action is available.
When discovery is partial, scope empty copy to the inspected collection. Missing
or failed reads do not prove absence. Keep a focused create or retry control
mounted when the body changes from loading to empty or populated.

Use `EmptyState` for a substantial settled empty/setup region. Use concise inline
status for a small subsection or loading state. A huge icon-only creation tile is
not a general empty-state recipe. Avoid stacking multiple borders, surfaces, or
success messages around a routine task. Keep important scope, privacy, destructive
consequences, and recovery copy; move it next to the relevant decision rather than
deleting it to make a layout quieter.

Use inline feedback for lasting problems and shared Toast for transient results.
Do not build another notification stack. Preserve labels, focus, and control size
while pending, and prevent repeated activation in behavior. Shared surfaces own
their motion: keyboard/high-frequency interactions stay immediate, exits do not
delay access to the underlying task, and reduced-motion behavior stays intact.
Do not add a page-wide entrance, result stagger, press scale, blur, or new timing
curve merely because a generic design recipe recommends one. Buzz's existing
[motion decisions](#motion) and named component exceptions take precedence.

Inspect the states that actually contain the affected controls. An unavailable
preview with no action cannot establish that the available action fits. Confirm
the control is present before checking bounds, and check changing labels such as
Sign in, Cancel, and Sign out at narrow widths with enlarged text.

### Plugin contribution boundaries

| Contribution | Host already owns | Contributor supplies |
| --- | --- | --- |
| Page | Shell navigation, outer workspace, activation/error boundary | Its interior composition, header where needed, padding/scrolling, data states, and local actions |
| `companion: true` page | Ready-to-render companion card | Placement in every state; reuse PanelFrame when suitable, without a second host dock |
| Panel mounted in PanelCard/PanelWorkspace | Outer surface, close behavior, and header or tabs | Object body and local interactions; inspect the actual host before adding chrome |
| Settings card/destination | Settings navigation, content column, contribution lifetime/error boundary | Content Header/grouping and controls; registration title is navigation metadata, not rendered content hierarchy |
| Channel launcher or menu contribution | Placement, surrounding header/menu, target selection | The supported launcher/item only; preserve host action sizing and lifecycle |
| Message/link/attachment renderer | Surrounding message and navigation contracts | Content inside that boundary; no duplicate author/actions or nested interactive target where the contract forbids it |

Source plugins can import the shared components directly. External plugins must
use the actual supported author contract and exposed CSS roles; source paths are
not a published component SDK. These are composition requirements for Buzz UI,
not a claim that arbitrary external code is automatically constrained. Do not
introduce a private reset, theme provider, palette, body-level stylesheet, global
control override, or parallel dialog/toast system to make one contribution fit.
Keep plugin styles scoped to owned layout/content. Renderer exceptions do not
exempt surrounding controls from shared appearance.

For a genuinely new surface, describe its task and the nearest recipe first.
State the missing capability and smallest extension in its existing owner. Keep
specialized behavior local until another real use justifies sharing it; do not
force every plugin into one universal page component. Read the
[plugin contracts](../../../docs/plugin-architecture.md) before changing host boundaries.

## Direction

Buzz adopts Block UI's visual language and semantic color grammar. Base UI
remains the behavior layer; Buzz owns styles, composition and product semantics.
Use Inter and JetBrains Mono, public dependencies and generic examples. Do not
copy private packages, proprietary fonts, internal product data or private source.

## Semantic colors

Use `color / purpose / emphasis / state`: surface, text, border and affordance.
An affordance is a control or action color. CSS spells these `--surface-panel`,
`--text-standard`, `--border-prominent` and `--affordance-subtle-hover`.
Tailwind utilities include `bg-surface-panel`, `text-standard`,
`border-prominent` and `bg-affordance-subtle-hover`. Text and border registrations
stay in separate namespaces so they cannot accidentally share a value.

Primary reading text and icons inheriting its color use `text-standard`: #0F0F0F
in light mode and #FFFFFF in dark mode. Secondary and disabled roles keep their
existing colors; prominent control fills and focus boundaries remain unchanged.

Components choose roles, not palette steps. The palette is an implementation
detail, even when a role uses the same step in both themes. Add a role only for
an actual use, document it in the registry and measure its intended pairings.
Legacy utilities and host aliases remain while their callers migrate. Do not
add new uses. Whole materials such as glass still travel as one shared recipe.

Panel navigation uses `affordance-panel-hover` for its quiet hover and the shared
`affordance-selected` for persistent selection. In dark mode, the unfilled panel
row needs a quieter hover than a filled subtle control; these are distinct roles.

Anchored popup selection uses `affordance-popover-selected` (neutral 2 light /
neutral 6 dark). It stays visible on `surface-popover` independently of the quiet
neutral button and tab hover fill; mention and emoji suggestions use this
role for their active completion highlight.

## Foundations

The interface uses shared color, type, spacing and shape roles. Primary actions
are neutral. Text uses Inter for reading and labels, and JetBrains Mono for code
and identifiers. Regular (400) supports reading; Medium (500) marks labels and
structure. The Typography page documents each role’s complete setting.

Panel padding is 24px, control inset 16px, group gap 32px and page-section gap
64px at the default scale. Values are rem-based. Full-window gradient backdrops
and glass navigation support both color modes; content panels use opaque neutral
surfaces. Dark text roles are selected for contrast on their intended surfaces.
Host compatibility names resolve to the shared tokens.

Features own layout, data and behavior. The foundation guard covers `src/`,
including the Emoji Mart adapter. Layout dimensions, emoji artwork geometry and
terminal ANSI/artwork remain renderer-owned; terminal controls use shared colors
and mono type.

This guide describes how to use the system: surface relationships, hierarchy,
identity, interaction and composition. The token registry documents the available
values and their purpose.

Run `pnpm design:dev` and open `/tests/fixtures/design-system.html` to see the system
rendered from the tokens themselves.

## Identity shapes

Human avatars are circular. Agent avatars are squircles. Use the shared
Avatar `shape="circle"` or `shape="squircle"`; the shape carries identity meaning,
not density or emphasis. The caller supplies identity type from domain data,
never a name or picture heuristic. `size="fill"` fills the owning layout’s
available space. Shape clips the artwork, never the interactive focus target.
Avatar-only controls use `IconButton variant="avatar"` so the surrounding backdrop
shows through their cutouts at rest, hover, press, and while a menu is open. The focus
target stays unmasked. Its keyboard-ring recipe follows the focus appearance
policy below.
Circular and squircle avatars can add `statusBadge="online" | "away" | "offline"`. The dot
uses a semantic green, yellow, or grey role with light and dark values. Its inset
cutout and dot scale with the existing avatar size; the dot is separate from the
clipped artwork, and avatars without a badge retain their full shape. The agent
cutout and badge follow the squircle contour; agent badges use live presence and leave
unknown status unbadged. All three statuses use solid fills: green for Online,
yellow for Away, and grey for Offline, with semantic light and dark values.
Online retains its step-10 center inside a 1px inset, same-hue step-11
outline, which supplies the 3:1 non-text boundary on supported opaque surfaces.
Away uses an unoutlined Amber 10 fill at the designer's explicit request.
**Known accessibility tradeoff:** the light Away badge falls below the WCAG
1.4.11 3:1 non-text contrast target on supported neutral surfaces. The contrast
guard reports exact accepted light-mode role/color/surface pairs; other pairs
remain enforced. This exception is not an accessibility pass. Dark Away meets
3:1 on these opaque surfaces. Offline stays unoutlined. Keep badge footprints, Bézier
artwork cutouts, presence behavior, and accessible names with the shared Avatar owner.

For a separate trailing action attached to a row, use `IconButton shape="row-end"`
in a stretched flex slot. It keeps the size-selected width, fills the row height,
and rounds only the right corners with `radius-row`. Decorative inverse corners
on the left extend the state fill around the preceding row's rounded edge without
expanding the hit target. They inherit the fill, including hover/pressed/menu-open
states, rather than painting over the adjacent surface. Hover uses the same
contextual row highlight as NavigationItem, not the brighter floating-button
step. Shared pressed and keyboard behavior remains unchanged.

## Public identity text

Public-key recognition labels use the shared pure formatter in
`src/shared/identity/public-key.ts`: `npub…` followed by the last three canonical
npub characters by default. This is text, not a component or a new identifier.
Use `formatPublicKey` for one label; use `publicKeyLabels` for an ambiguous group
so distinct keys receive a common suffix length that makes them distinguishable.
Inputs are public identity keys in hex, never credentials. Invalid inputs produce
no label; do not echo an invalid value as a fallback. Raw hex cannot establish
whether a caller supplied a secret: callers must use public-identity fields only.

Keep the full key for routing, persistence, identity comparisons, and explicit key
copy actions. Short labels are recognition aids, not proof of identity. Full-key
inspection/export surfaces remain explicit exceptions. Reuse this formatter for new
abbreviated public-key displays; migrate existing surfaces deliberately.

Identity display names use the active naming policy, not a separate composer rule.
The default policy compares trimmed resolved names case-sensitively (`Honey` and
`honey` are different). It ranks the viewer human, other humans, viewer-owned agents,
then other agents. Unique names stay plain; ties do not choose an arbitrary winner.
Readable owner/agent labels come before last-four npub endings, extended only when
needed. These policy qualifiers are distinct from standalone abbreviated-key labels.

Views supply the comparison set: channel members for reading (plus the referenced
historical identity), DM participants for DM labels, and complete eligible choices
before search filtering for pickers and composer chips (plus existing recipients).
Removing a selected chip does not remove an otherwise eligible namesake from that
set. Repeating one identity is not ambiguous. Live profile and membership changes
update display labels, never authored message source, recipient spans, copyable
text, or notification targets. Accessible names spell out a public-key ending
when the policy uses one. With no active policy, use profile/caller fallbacks.

When an existing composer chip gains a qualifier, reveal only the qualifier with
shared settle motion; newly inserted chips appear at rest. Ordinary typing must
not replay the reveal. The suffix stays visible while a long name ellipsizes.
Removal is immediate and reduced motion disables the reveal animation.

## Posture

Buzz is a place for people and their agents to build together. Keep everyday
surfaces quiet and functional so the conversation stays central. Use character
in identity, guidance, transitions, and ceremony. Use color to convey meaning.

## Surface and depth

Use the surface that matches the content and its position in the interface.

- **Panels:** the shell uses one `Panel joined` around navigation and content on the gradient backdrop. Nested Panels keep their opaque fill and clipping but lose independent borders, corners, and shadows. The layout owner separates adjacent regions with `border-standard` hairlines. Standalone Panels keep their own outer treatment.
- **Recessed regions:** use `bg-inset` for a region pushed into its surrounding surface. Use quiet fills where they communicate separation; reserve outlines for boundaries that need to be identified.
- **Reading surfaces:** documentation and dense prose sit on `bg-panel`. Keep page-wide gradients behind product chrome and panels, where their changing contrast will not interfere with reading.
- **Borders:** use `border-standard` for quiet separators, `border-prominent` for controls, and `border-focus` for keyboard-focus recipes. Errors and warnings have their own boundary roles. Measure the actual pairing in both themes.
- **Shadows:** use the two shared elevation values and keep them subtle. Light mode relies on shadow; dark mode also raises the fill’s lightness. Do not strengthen a shadow to separate a dark floating surface.

### Floating surfaces

Menus, Select, Popover, and PreviewCard share `floating-surface`: a 90% opaque
mode-aware fill, 8px backdrop blur, standard border, 16px `radius-container` corners,
and shared lift. `popover-surface` composes this same recipe for feature-owned
anchored content. Reduced transparency, forced colors, and browsers without blur
support use the opaque fill.

Default menus, selects, and list popovers share a 4px list inset. Content popovers
use 12px padding. Menu items and select options share 8px vertical / 12px
horizontal padding and corners derived from the outer radius and inset. Their hover treatment also comes from the same rule. Use Menu for
actions and nested submenus, Select for a value, and Popover for interactive
content; Base UI retains each control's keyboard and focus semantics.

Short action menus and compact account popovers retain 8px `radius-row`
corners, a 2px list inset, and concentric inner rows. Choose compact for the content,
never automatically because the viewport is narrow. Dialogs and alert dialogs
use the same `elevated-material` fill, blur, and accessibility fallback while
retaining their 20px `radius-panel` corners and modal backdrop. Stepped dialogs
apply the material to each step; their shared wrapper stays transparent.

### Corner scale and nesting

Standalone containers use the 4 / 8 / 12 / 16 / 20px scale: `radius-chip` for
tight details, `radius-row` for independent rows, `radius-control` for fields,
`radius-container` for medium containers and standard floating surfaces, and
`radius-panel` for large surfaces. These are rem-based values at the default
scale. Circles, capsules and pills are separate shape roles; full-window sheets
can be square.

When a nested fill or container follows its parent's contour, use
`max(0px, outer radius - inset)`, measured between the painted edges. Include
padding and the parent's border in that inset. Do not round a derived radius
back to a scale step: a 16px menu with 4px padding and a 1px border has 11px
row corners; an 8px compact menu with the same inset has 3px row corners.

`floating-surface` owns `--floating-radius`, `--floating-inset` (the padding),
and `--floating-inner-radius` (subtracting its 1px border). Menu, Select,
list-popover and completion fills consume that derived radius. A feature that
changes the surface padding must update `--floating-inset` on the same owner.
An additional nested container measures from its immediate painted parent.
Hover, selected, pressed and focus fills retain the same geometry. Edge-to-edge
fills inherit the container radius and clip at its boundary. Independent controls
and identity artwork retain their own shapes rather than becoming concentric
with an unrelated container.

Floating rows use `affordance-floating-hover` (neutral 2 light / neutral 5 dark).
Supporting text becomes standard text on highlight. Keep persistent selection
independent of hover. Compact menus use `affordance-subtle-hover` with immediate
feedback and retain their separate selected fill.

### Glass

Use glass where a gradient, image, or content is visible behind it. Apply the
complete material so fill, blur, rim, and optional shadow stay together.

- More opaque glass reads as a higher layer. A brighter fill alone does not communicate the same depth.
- Keep the rim’s light direction consistent across surfaces. Use a border role when you need a visible boundary rather than a material edge.
- Avoid adding a glass fill when the region already covers an identical glass parent. Two `glass-2` layers composite to 0.77 alpha and become more opaque than either intended layer.
- Panels and chrome normally sit directly on the gradient. Text placed there needs inspection because its contrast changes with position; small decorative labels may be deliberate exceptions.

**Unresolved contrast:** opaque token checks cannot validate glass over a variable
backdrop. A rendered dark-mode sample of primary glass over Night garden ranged
from `#162e28` to `#1e4a3c`. In the brighter area, `text-secondary` measured Lc 58
and `text-tertiary` Lc 43, below their 60 and 45 targets. Review real product
content before choosing a fix: dim the backdrop, increase glass opacity, or keep
metadata off that glass surface. These measurements do not establish a general
contrast guarantee.

### Match controls to their surface

Use `Tabs variant="chrome"` for a glass pill on the backdrop and `variant="panel"`
for an underline on a plain surface. IconButton also provides a `chrome` variant.
A chrome selection can blend into a white panel; choose the appropriate variant
instead of retinting `--bg-chrome-selected` for one caller. Keep shared behavior
in one component and show both surface variants in its examples.

A selection and a hover describe the same object, so they occupy the same box.
The chrome pill fills its tab rather than sitting inset within it; insetting the
selection alone draws it shorter than the hover beside it, and the two states
stop agreeing on where a tab is. The container's own padding is the frame.

Panel tabs keep labels at intrinsic width and scroll within the Base UI tablist
when space is limited. Keyboard navigation reveals the focused tab. The surrounding
panel grid must have a shrinkable column so tabs do not widen other content.

## Focus appearance

Keyboard focus is visible, and the component recipes in this guide own the ring.
Every recipe is gated on the app-root modality fact `html[data-keyboard-navigation]`,
so a pointer press leaves nothing behind. Keep focusability, Tab order, input
modality, selection, and focus restoration intact, and do not add a local
replacement ring where a component recipe already exists.

Shared text fields are the one deliberate exception, and they replace the ring
rather than removing it. `styles/forms.css` drops the outline for editable
`.buzz-input`, `.buzz-textarea` and rich textboxes; read-only controls keep their
keyboard rings. Those fields use
a border flush with the field perimeter: surface-inset fill and a 1px
border-prominent stroke fading over 150ms ease for pointer interaction. The
field-scoped --border variable selects transparent, active, or error color for
the reserved 1px border, so state changes do not shift the layout. Keyboard
focus and reduced motion change immediately. Composite fields own one stroke
around the input and actions; error strokes retain priority. Placeholders use
text-metadata, one step quieter than supporting text, in both themes. This supersedes
the older keyboard-only
and no-container-ring recipes for these fields.

The composer is the second deliberate exception, and it is a container treatment
rather than a control ring. `styles/composer.css` clears the textarea's own
outline and lets `.buzz-composer:focus-within` carry focus on the shell: the 1px
perimeter border switches to `--border-focus` and a matching 1px ring doubles
it, so the composite reads as one focused surface instead of a ring around the
text area inside a bordered box. Measured in the viewer, the stroke moves from
`rgb(232, 232, 232)` to `rgb(0, 0, 0)` in light and `rgb(35, 35, 35)` to
`rgb(255, 255, 255)` in dark — 21:1 and 17.4:1 against the panel surface, and
17.1:1 and 15.7:1 against the resting border, so the change itself is legible.
Unlike the text-field exception this is not modality-gated, because the shell
also marks where typing will land. Do not copy the container pattern to a
control that has a component ring recipe.

`SearchField` is an unresolved gap, not a policy: `styles/search-field.css`
cancels the ring on both the field and its clear button to match a global
override that no longer exists, and its 1px perimeter border does not react to
focus, so the control has no visible focus state. Do not copy it.

## Surface-aware interactions (proposed)

Opaque surface owners provide a CSS interaction recipe: `interaction-panel`
(default and Panel) or `interaction-floating` (Dialog, floating-surface and
popover-surface). The recipe follows the painted DOM root, including portals;
there is no React provider or runtime color detection. Native modal adapters
using the floating fill opt into the same utility. Transparent groups inherit;
a nested opaque Panel resets. Feature-only surfaces must opt into the recipe
matching their paint; an arbitrary background utility alone is not a context.

Inherited custom-property aliases resolve on the owner, not again on each child.
The ordinary recipe binds at every theme owner (`:root` and scoped `.dark`),
including always-dark media inside a light app. This default belongs in the base
layer: explicit floating, nested Panel and semantic recipes must win on the same
node. Adding a scoped theme requires rebinding its dependent aliases too.
Do not override upstream `--affordance-*` values on a wrapper to retint controls.
The existing semantic exceptions have named shared recipes: `interaction-availability`
on the status owner uses `data-status="online" | "away" | "offline"` (unknown stays
neutral) for the documented status capsule fills, while `interaction-navigation`
on the sidebar keeps channel rows and session selection equally quiet. Apply these
only to their semantic owners, not as general styling escape hatches. Button and
NavigationItem still do not accept caller-supplied `className`; popup portals keep
their own floating recipe. Availability's existing contrast exceptions remain
recorded in `docs/presence.md`.

Top-bar ghost icon actions remain unfilled at rest. Their backdrop hover and
pressed roles use translucent fills (black 6% / 10% in light mode, white 10% / 16%
in dark mode), so the gradient remains visible. The shell owns this context;
content-panel actions retain their opaque surface recipes. Only the fill is
translucent: icons stay at full opacity, without adding blur or a rim.

Actions consume contextual fill/hover/pressed/selected/boundary roles rather than
redefining global semantic tokens that also color avatars or chips. Floating
rows remain transparent at rest, then use the existing floating highlight with
standard supporting text. Persistent selection is separate from hover. Compact
menus retain their quieter highlight and use a distinct selected fill.

Fields retain surface-inset and their existing invalid/disabled/focus behavior;
only active boundaries adapt to the surrounding surface. Actions inside an
InputGroup reset to the ordinary recipe because their backdrop is the inset
field. Unchecked checkbox/radio and outline boundaries use the contextual
boundary too. Prominent/destructive actions and switch geometry/state colors
are unchanged. No extra hover affordance is added to static content.

The floating control mappings are proposed, not an accessibility certification.
Dark floating action fills are neutral-6/7/8 at rest/hover/press, on the
neutral-raised (#282828) floating surface; those fill edges are below 3:1. The contextual control
stroke uses neutral-9 and clears 3:1 against that outer surface. This proof does
not change the shared [focus appearance policy](#focus-appearance), which applies
in both the app and viewer. Glass/inverse/media surfaces retain their existing
explicit treatments, outside this opaque-surface proof.

The Floating surfaces viewer shows actions, rows, fields and choices in actual
shared Panel/Dialog/Popover components, including a nested Panel reset. Verify
both themes, portals, supported states and actual product flows before adoption
is called complete; token math alone cannot validate the CSS cascade.

## Controls

Button and IconButton share prominent, subtle, ghost, inverted, destructive,
outline and link emphasis. Inverted is for an inverse surface; link keeps its
background clear and underlines on interaction. Their 32 / 40 / 52px sizes are sm / md /
lg at the default scale, with minimum
heights that accommodate larger text. Text buttons use `--radius-capsule`
(1.625rem / 26px): capsule-shaped through the default 52px large size,
clamped naturally on shorter controls, and bounded on taller ones. Reuse this
role for similarly sized actions; `--radius-pill` remains the fully round role
for circles and pills of any height. Fields retain `--radius-control`.

Settings scopes the text-button radius to 12px `--radius-control` so actions
use rounded rectangles. Icon actions retain their independent 10px radius.

Floating unread cues and Jump to latest use Button's `shape="control"` with
12px `--radius-control` corners in every state. Any backing surface uses the
same radius so its painted edges align with the button.

The message hover toolbar uses the 12px rounded-container radius
with a 2px inset. Its independent icon actions retain their shared 10px corners.

Button labels stay on one line and do not shrink in flex layouts (`whitespace-nowrap
shrink-0`). Parents must reflow whole controls or provide
scrolling when space is limited. Composite reply summaries may reflow whole
avatar/count groups without wrapping individual labels. Thread reply summaries
use the same 10px corners as icon actions, including hover and pressed fills.
Small buttons use 16px
side padding and 16px icons; medium and large use 24px side padding and 24px icons.
Standard Button labels use the complete `text-label-sm` role with an 8px icon gap; the
extra-small capsule uses `text-caption`. For a caption-sized inline choice such as
the composer's model name, `size="inline"` keeps a 24px minimum target with 4px
horizontal padding and icon gap, and 12px icons. Pair it with `variant="ghost"`
for an unframed label; shared hover, disabled, and keyboard focus still apply.

Button defaults to `md` (40px minimum height); IconButton defaults to `sm`
(32px square with 16px artwork) and a 10px rounded rectangle
(`--radius-icon-button`). Choose `md` or `lg` explicitly when an icon action needs
a larger control; community rail identities and the avatar edit badge retain their
existing larger treatment. These defaults do not depend on pointer type or viewport
width. Both controls use the same sm/md/lg scale. Existing names
remain compatibility aliases: primary/solid → prominent, quiet → subtle,
compact/toolbar → sm, default → md, large → lg. Do not add new alias call sites.
Buzz's tint and chrome icon variants remain for composer and backdrop actions.

Disabled controls retain their filled, outline, or unfilled treatment and cannot
activate. Loading retains the label's geometry, accessible name, focus and variant
colors while blocking activation; never swap in a differently sized loading label.
Pointer hover uses shared state timing; expanded triggers retain pressed emphasis.
Keep keyboard-only focus and reduced-motion behavior owned by the system.

IconButton's `bare` variant is for toggles whose glyph supplies the state:
no resting, hover, pressed or selected background. The small control keeps its
32px hit area with 20px artwork. The caller supplies outline/filled artwork,
aria-pressed and the accessible name; focus behavior remains unchanged.

IconButton also offers `xs` (20px with 12px icons) for dense formatting actions. Mode
toggles remain `sm`.

Utility icon actions share the rounded rectangle in resting, hover, pressed, and
selected states. Avatar controls default to round; use `shape="round"` for deliberate
circular controls such as media playback, the avatar edit badge, and Add reaction.
Top-bar, sidenav and content-toolbar icon actions share square 32px containers, 16px artwork,
and the same 10px radius on all four corners, including actions beside the outer
panel edge. The top bar retains its translucent backdrop interaction fills.
These independent control shapes stay separate from the container scale and
derived nested-fill corners.
Disabled ghost icons remain unfilled; their muted foreground communicates unavailability without
adding a container to an otherwise empty toolbar.

Composer picker surfaces use the 16px `--radius-container` role and the shared
popup motion below. Filtering does not stagger results. Search fields follow
the shared form treatment below.

Field groups label, input, help and error using Base UI. Input and Textarea
carry the shared field appearance. RadioGroup is for one choice, Checkbox for an
independent choice and Switch for an immediate on/off setting. Use the native
form semantics exposed by those Base UI primitives rather than duplicating them.

For finite choices, use Select: its inline layout fits compact toolbars and
`variant="field"` fits labelled forms. The proposed `variant="compact"` fits
trailing row choices: a small outlined trigger with a quiet `border-standard`
boundary and a visually hidden accessible
label, bounded single-line value, and full choice text in the popup and value hint.
Its popup has an 11.25rem minimum (bounded by the viewport) and reserves the
selection-mark slot in every option so selecting the widest label cannot resize it.
The caller owns its column width. `align="end"` anchors a trailing choice popup
to the trigger’s right edge; the default remains `start`. Pass `disabled` explicitly
when the choice is unavailable. An option may include one concise supporting
description; Select shows it as a byline in the popup while the closed trigger
retains only the option label. For searchable choices, use the shared Combobox parts; keep
filtering, custom-value commits, and async requests with the feature. Its Control
owns the label, input and integrated browse caret; Popup and Item own the shared
menu presentation. Use its loading state while discovering options, and keep
retry/cancel actions with the feature. Do not style a native select as an Input
or attach a separate round button to mimic a combobox.

### Form composition

Select and Combobox chevrons rotate 180 degrees to reflect the trigger's
aria-expanded state. Use duration-state (150ms) with easing-settle for a
reversible transform transition. Keyboard navigation and reduced motion switch
the orientation immediately. Loading indicators keep their separate behavior.

Fields share a 40px minimum size at the default scale, the control radius,
text-body (14px / 20px), and the 16px control inset. Derive vertical padding from the control
size, text line height, and boundary; do not force a fixed height that clips
larger text or wrapped Select values. Textarea uses the control inset on all four
sides (16px at the default scale), with manual vertical resizing and a code variant.
In Chromium and WebKit, the native resize grip uses text-metadata and sits 4px
(space-1) inside the corner. Keep it visible at rest. Preserve the native resize hit target and
leave the browser grip unchanged where custom resizer styling is unsupported.

Use Field once per input/textarea, with an 8px internal gap. Select's field
variant, SearchField, and Combobox.Control already own their label and supporting
text; do not add a second Field around them. Use description/error for connected
help and validation. An error replaces the secondary description until it clears;
keep the accessible description synchronized with the visible message. Validation
strokes belong to the outer field, never its auxiliary buttons. Keep feature-owned
asynchronous status connected through
aria-describedby. Forms own 16px between adjacent fields and the 32px section
gap between named groups.

InputGroup shares the inline frame for SearchField and Combobox. Icons use an
8px gap, and trailing actions retain a stable slot. SearchField uses the same
12px control radius as other fields, with no separate navigator shape. Focus belongs to
the input or action,
while the frame owns the active perimeter stroke. Read-only values can be
read and copied; disabled actions cannot change a value. Search clear restores
input focus. Features still own filtering, custom values, and async recovery.

SearchField, Combobox.Control, and code Textarea default to no autocorrection,
capitalization, or spellcheck. Callers can override these defaults explicitly.
Ordinary Input and prose Textarea retain platform defaults. Check the defaults in
`ui/SearchField.tsx`, `ui/Combobox.tsx`, and `ui/Textarea.tsx` when adding an exact-text
field.

The Forms page in Just Design documents states, usage, and a form-in-dialog
example. Review it with both themes, narrow widths, and enlarged text before
introducing another form treatment.

Select and Combobox popups use a 150ms entrance and 120ms exit from the shared
state/fast duration tokens. Fade opacity with easing-state and move 4px from the
trigger with easing-settle, reversing the direction above the trigger. The
designer-requested blur from 4px to zero is a narrow exception to the general
no-blur-animation rule. Base UI owns transition presence and dismissal; keyboard
navigation and reduced motion remove the transition, movement, and blur.

### Menus, popovers, and choice rows

Use Menu for actions and lightweight choices, Popover for supporting content or
short forms, and Select/Combobox for form values. Both anchored surfaces reuse
`floating-surface`, viewport collision handling, and the shared popover layer.
Features own their data, callbacks and save/cancel behavior; Base UI owns focus,
keyboard navigation, positioning and dismissal.

Menu group labels belong inside MenuGroup. `emphasis="quiet"` uses metadata
color for lower-emphasis group labels. Radio items may use `selection="highlight"`
for a single-choice view: the checked item has a persistent selection fill and no
check icon. Default radio and checkbox items retain their trailing checks.
Trailing selection checks and persistent selection fills remain independent
of the pointer/keyboard highlight.
Keep the parent row highlighted while its submenu is open. Use `tone="danger"`
for destructive actions and MenuNote for explanatory or status copy outside the
keyboard item list. Long lists scroll inside the popup.

ChoiceRow arranges a label, wrapping description, optional artwork and trailing
metadata. It adds no second click target or tab stop. Keep its slots non-interactive
and let the containing item own state and padding. Use the small shared avatar
for identity choices, retaining human/agent shapes.

PopoverPopup uses 16px content padding, or `padding="list"` when its rows own their
spacing. Use `size="compact"` with list padding for short account/action surfaces: 14rem
width and 8px corners. `MenuPopup size="compact"` uses the same corner, inset, row and
hover treatment for short action lists. Content and wide popovers retain 16px corners.
Name it with PopoverTitle or aria-label; PopoverDescription connects
supporting copy. Hover opening is optional and remains configured by its feature.
Use `padding="none"` for an embedded picker that owns its internal spacing, such as
emoji/GIF content.
Menus and popovers use a quicker version of the form dropdown motion: 75ms entry
and 60ms exit (half the state/fast duration tokens), a 2px offset and blur-to-sharp
opacity fade. Movement uses
easing-settle; opacity and filter use easing-state. The offset follows the actual
placement side toward the trigger, including collision flips and nested menus.
This extends the designer-requested blur exception to these anchored surfaces.
Keyboard navigation and reduced motion remove transitions, movement, and blur. The Just
Design Menu, Popover and ChoiceRow pages
show these contracts and their compositions.

## Compositions

### Panel headers

Every workspace pane and full-page destination has one shared `PanelHeader` at
its top, outside the scrolling body. If the containing workspace already supplies
that header, reuse it rather than adding a second one. Keep the frame present
during loading, empty, error, and populated states. Content cards and Settings
groups are not workspace panes and do not each need chrome.

The approved visual reference is the main channel header in
[`ChannelsPage.tsx`](../../bundled/channels/ChannelsPage.tsx): compact identity at
the leading edge and **icon-only actions at the trailing edge**. Reuse the shared
components, not a screenshot's measured offsets.

- **Leading identity:** static destinations use `PanelHeaderLabel`, including its
  icon slot and title typography. Omit the icon when there is no meaningful one.
  Existing channel/workspace tabs retain `Tabs variant="navigation"`; the channel's
  single non-closable tab uses `showSelection={false}`. Do not invent tab semantics
  for a static page just to reproduce its appearance.
- **Trailing actions:** use `IconButton size="sm" variant="ghost"` with 1rem
  artwork, an action-specific `aria-label`, and a matching `title` hint. Use the
  shared Menu with an icon-only trigger for overflow. Keep permission, pending,
  disabled, expanded, and focus behavior with the action's current owner.
- **Text actions:** a labelled action such as “Add agent” belongs in the content
  or empty state. If it is available in panel chrome, render it as an icon action
  with that accessible name. Never shrink, clip, or locally restyle a text button
  to make it fit the header. Destructive confirmations retain explicit text actions.
- **Navigation:** use the `navigation` slot for local back/close controls. Keep
  title, navigation, and actions in their designated slots; do not build a parallel
  header layout inside the body or add wrapper gaps around actions.
- **Limited space:** preserve control hit areas and the shared title truncation.
  Group secondary actions in the existing overflow menu when needed. Shared
  wrapping is a fallback, not a reason to add oversized controls. Verify long
  titles and enlarged text; no action may become unreachable.

Static-pane composition (imports come from the shared UI and icon gateways;
`openAddAgent`, `canAddAgent`, and pending state remain feature-owned):

```tsx
<PanelHeader
  title={<PanelHeaderLabel title="Agents" />}
  actions={
    <IconButton
      size="sm"
      variant="ghost"
      icon={<PlusIcon size="1rem" aria-hidden="true" />}
      aria-label="Add agent"
      title="Add agent"
      aria-haspopup="dialog"
      disabled={!canAddAgent || pending}
      onClick={openAddAgent}
    />
  }
/>
```

`PanelHeader` currently accepts arbitrary React nodes and bare strings. That API
flexibility does not enforce this composition. In particular, the existing Agents
text action and Projects' standalone large title are adoption gaps, not templates
for new screens. Review action producers too, including actions portalled into a
header from another component.

### Header geometry

PanelHeader owns one consistent header frame: leading `navigation`, title/icon,
and trailing `actions`. `PanelHeaderLabel` supplies the smaller tab-aligned
label role; omit its optional icon for image and video detail titles. Use a small IconButton with ArrowLeft for a local back
action and X for closing the panel. The default 2.5rem (40px at the default root size) minimum height aligns conversation,
thread, profile, tabbed workspace, and Todos headers. The compact variant shares
this height. Headers use 0.25rem inline padding (matching the centered 2rem controls’
block inset), 1rem identity icons, and
0.25rem gaps between action buttons without reducing their hit areas. Navigation
tabs use 1rem icons or fill avatars and 0.5rem leading padding.
Header spacing, icons, and controls scale with rem; separators remain
1px hairlines. Titles and actions may wrap when their content needs more room.
Static identities use PanelHeaderLabel to share navigation tabs’ icon slot,
regular title weight, and leading inset without adding a tab stop. Terminal context
can follow the label; Inbox and Bestie use the same composition.
Navigation state, focus restoration, and content transitions belong to the host.

### Content hierarchy and layout

Pane chrome identifies where you are. The body holds the work: descriptions,
filters, lists, forms, and their labelled actions. Use `Header` only when the body
needs its own introduction, and `InlineHeader` for named sections. Do not repeat
“Projects” as a large body heading immediately below a Projects pane header.
Preserve Settings' documented content headings inside its shared workspace.

Use the owning layout's shared panel inset and spacing tokens. Align headings,
list content, and form labels to consistent leading edges. Keep related controls
closer than separate groups; use the existing field and section gaps rather than
adding separators between every group. Keep section actions with that section,
not in unrelated pane chrome. Apply the [row alignment rule](#align-row-content-not-state-backgrounds)
when state backgrounds extend beyond the content edge.

Let the body shrink and scroll within its pane (`min-height: 0` / `min-width: 0`
where the layout requires them); do not make the whole workspace scroll to reach
local content. Keep controls reachable at narrow widths and enlarged text, and
use logical inline/block properties for content alignment. Preserve the existing
host's scrolling and focus ownership rather than adding another scroll container.

### Dialogs and supporting compositions

Composer pickers reuse PopoverPopup and anchor above the whole composer with a
4px gap, preserving the shared popup behavior and material.

Dialog composes a Base UI modal with a shared title, optional description, body,
close button and actions. Pending operations set preventClose so Escape and the
close button agree. It retains the app's explicit dismissal behavior: outside
clicks do not discard a form by default. Channel-management modals explicitly
opt into `dismissOnOutsideClick` and reuse their Cancel/Close path, including
nested confirmations that dismiss only their own layer. `preventClose` blocks
pointer dismissal as well as Escape and Close. Provide initialFocus for search dialogs and
finalFocus when a flow has an external trigger or opens a second dialog.
An explicit finalFocus applies only while focus is still in the closing popup
or on the page body. If the user already moved focus elsewhere, closing leaves
it there, as the default `true` does (`ui/finalFocus.ts`, shared by Menu,
Popover and Dialog).
Editors can supply `headerActions` beside Close and `leadingActions` before the
trailing footer actions. Footer actions wrap as whole controls, never shrinking
single-line labels. When one action exceeds the available width, the footer
scrolls horizontally from a safe start edge so both ends remain reachable.
`onEscape` may return true to consume Escape for an
inline layer (such as an inspector) before dismissing the dialog. Nested modal
layers still use Dialog so Base UI owns their focus trap and dismissal order;
`placement="right"` and explicit `dismissOnOutsideClick` suit inspector sheets.
Use `size="wide"` for two-column catalogs such as Add harness. It caps the width
at 56rem and preserves viewport gutters; `height="stable"` can reserve the body
while changing catalog selection.
Use `size="expanded"` for viewport-filling reading surfaces such as code diffs;
the body scrolls while the shared title and close action remain available. This
changes only size, not modal ownership or dismissal behavior.
Use `text-label` (16px, 500 weight at the default scale) for the shared Dialog
title. Group the title and optional description with `--space-2` (8px), beside
the close button so its hit area does not enlarge the text gap. The body owns
vertical padding matching the dialog's horizontal padding: `--space-6` (24px),
or `--space-4` (16px) at the compact breakpoint. Do not add an outer flex gap
on top of that body padding. Create/Edit channel forms opt into
`headerGap="compact"` for a 12px heading-to-body gap at every breakpoint;
other dialog compositions retain their default spacing. Their privacy confirmation
steps also opt into `footerGap="compact"` for 8px between the final checkbox row
and the actions; returning to the form restores the normal body-bottom padding.
For a bounded dialog with fixed controls above a list, use `height="stable"`
with `bodyLayout="flex"`. The body becomes a non-scrolling flex column; the
feature supplies a `flex: 1; min-height: 0` composition with fixed controls and
one flexing scrollport. Keep results and their recovery feedback reachable; Members
administration errors sit outside that scrollport, below its fixed search controls.
Without footer actions, the flex body omits its bottom padding so
only the popup supplies the outer bottom gutter. With actions, it retains the
body-to-footer spacing. The default flow layout and other dialogs remain unchanged.
The shared Dialog uses state opacity and settling transform tokens for a centered
0.98-scale entrance, with fast timing on exit. Base UI owns transition presence;
keep the controlled component mounted while setting `open={false}` for an exit.
Reduced motion, keyboard navigation, and Escape dismissal are immediate. Pass
`motion="none"` for frequently used surfaces such as the search palette.
Channel Create/Edit privacy and Members confirmations opt into a keyed `step`
inside that same modal. The complete surface crossfades over 200ms with 4px blur: the form grows to
1.05 while confirmation grows from 0.95 to 1; returning reverses those positions.
This explicitly requested, bounded dialog transition is an exception to the
no-blur rule below, not a new default for dialogs. One stable Base UI title and
description label the modal; outgoing content is inert and hidden from assistive
technology. Reduced motion, keyboard navigation and `motion="none"` swap steps
immediately. The caller still owns draft state and focus between steps; no second
modal, backdrop or write owner is introduced. Each centered step retains its own
height and body layout while exiting, so a stable-height Members list can switch
to a content-sized confirmation without collapsing its scrollport. Expanded and
side-sheet compositions are unchanged.


Use Accordion for collapsible sections. Form sections pass `keepMounted` so
collapsing them preserves local input state; leave the default for static content.
Use `variant="form"` when the surrounding form owns spacing. It removes outer
margins while keeping the shared row and panel padding. Adjacent disclosure rows
form one stack; avoid inserting form-section gaps between individual rows.

Use Tooltip for short hints on labelled controls; use PreviewCard for richer
content. Tooltip owns its description link and inherits placement, focus and
Escape behavior from Base UI. For asynchronous action feedback (such as copying a
channel ID), control `open` / `onOpenChange` and set `closeOnClick={false}` so the
initiating click does not dismiss its result. Defaults retain ordinary hint behavior.
Overlay layers keep menus and hints above dialogs.
Adding a hint must preserve the host's keyboard contract. A focus-opened tooltip
can consume Escape before a panel's Back handler; the existing PanelSubview
controls expose this conflict. Preserve their accessible names and current Back
behavior while the shared policy is unresolved; see the
[adoption gap](../../../docs/design-system-adoption.md#gaps-to-address-when-migrating-owners)
before adding hints to these controls. This is not a general exemption from hints.
Hints use text-caption (12px / 16px), with space-1 vertical and space-2 horizontal
padding. Pointer entry uses the shared state duration (150ms), fading from a
0.97 scale, 2px downward offset and 2px blur; exit reverses it with the fast
duration (120ms). This designer-requested blur is a tooltip-specific exception.
Base UI instant states and keyboard navigation skip transitions; reduced motion
keeps only the fade.

ToastProvider mounts one headless [Sonner](https://sonner.emilkowal.ski) Toaster
in the host, portaled outside the app layout to the bottom right. Features and
plugins use the shared Toast API, never their own Toaster or direct Sonner calls.
Toast cards reuse `floating-surface`, including its `--shadow-sm` elevation; the
scrollable viewport leaves room for the shadow and keyboard focus.
Buzz owns the floating surface, semantic colors, type roles, Button and IconButton;
headless content inherits the host theme and text size without an OS-theme override.
Group title and description with `space-1` (4px), then separate actions with
`space-3` (12px). Use `space-3` padding on every card edge. The dismiss slot is
independent of the text group so its 32px hit target cannot open a gap between
title and description. It extends 8px toward the trailing edge and 4px vertically
into the padding; title-only confirmations stay centered beside it. Descriptions
use secondary text, and actions align with the message's leading edge.
The pinned Sonner patch preserves intentional focus destinations when leaving a
toast; fallback restoration still applies when focus is otherwise lost. Expiry
pauses while the stack is hovered, focused or being dragged, independently of
visual expansion, and resumes on exit. Escape dismisses the focused dismissible
notice; persistent recovery remains. Cards allow vertical touch scrolling through
the bounded stack and reserve swipe dismissal for horizontal gestures.

Sonner is the toast behavior owner; other matching controls use Base UI. ToastNotice belongs to the source that
owns its state and recovery: unmounting the source removes its notification,
without reporting user dismissal. Gate notices from hidden Settings sections
explicitly; portals do not inherit a hidden ancestor. Keep form errors and
blocked-page recovery inline. Channel LiveStatus is lasting, feature-owned recovery:
keep it in the conversation flow immediately above the composer, with bounded
overflow, so Send and companion-panel controls remain usable. Its retry policy
and diagnostics belong to Channels; it does not enter the floating toast stack.

Use `useToastNotification` for completed-action feedback that must outlive its
source row (such as copying profile metadata); the host stack owns its finite
expiry. Keep source-owned recovery on ToastNotice.

Use a finite timeout for transient feedback. Recovery defaults to no expiry and
no dismissal unless the source supplies onDismiss; preserve all recovery actions.
The expanded, bounded, scrollable stack keeps every recovery action available.
It sits at the bottom right with safe-area insets, including narrow windows; do
not add feature-specific top offsets. F6 enters notifications, Tab reaches actions. Modals
remain above the stack. Content updates do not restart expiry; timeout changes do.

Tabs with content use renderPanel, which lets Base UI connect each tab and panel.
Route navigation uses NavigationItem with aria-current instead, except for the
wide shell topbar described below. Tabs can also
compose NavigationItem through the `navigation` variant: these retain tab
semantics, hug their contents up to a 12rem maximum with ellipsis, use 10px corners matching adjacent icon
actions, and a subtle selected fill, accept avatars/icons, and place a sibling close
button over reserved trailing space. Tab close icons use 1rem artwork to match
container header actions while retaining their compact hit areas. Close buttons stay visible on the active tab; inactive tabs reveal them on hover or keyboard focus. Touch devices keep close buttons visible. Navigation tab strips scroll only horizontally. Their rounded thumb uses the sidebar’s quiet scrollbar role, with a 3px visible thumb in the header’s 4px bottom inset. The tab row keeps its vertical position as overflow starts or stops. It appears only while the strip is hovered; touch devices retain the thumb without requiring hover. The main
channel header uses the same control with a single non-closable tab with `showSelection={false}` (no selection or hover fill); channel
actions remain in the header action slot. The settings launcher uses
`data-highlight-expanded="false"` to preserve disclosure semantics without a
sticky pressed treatment; the selected tab owns the open-state indicator.

NavigationItem
offers an `option` variant for picker rows with even 8px padding and immediate
hover feedback. It forwards normal button events, refs and data attributes so unread observation,
preloading and product shortcuts remain with the caller.

PreviewCard may expose one supplemental action through `actionRef`, such as copying
an identity's full npub. Action previews open without a delay so immediate Tab
navigation reaches the action. They remain non-modal and never take focus on hover. Tab
from the trigger reaches the action; Shift+Tab returns to the trigger; forward Tab
continues after the trigger. Escape dismisses the preview before restoring focus,
but never pulls focus back if the user moved it during exit. Closing previews
are no longer Tab destinations or pointer targets.
Scrolling anything that contains the trigger dismisses a hover-opened preview: a
still pointer cannot report that its trigger moved away. A keyboard-focused
trigger keeps its preview, hidden while the trigger is scrolled out of view
unless focus is inside it.
The positioned portal owns its layer above dialogs. An optional content anchor
keeps previews near compact identity content inside wider actionable rows. Identity
previews prefer above that content (with Base UI collision handling), leaving
the hovered row’s trailing action unobstructed.

## Menu row corners

Menu rows use `--floating-inner-radius` in every position, including grouped
choices and submenu triggers. Default and wide menus derive 11px inner corners
from their 16px surface; compact menus derive 3px from their 8px surface.
Both include the 4px padding and 1px border in the inset.

Use these shared recipes. Do not add positional or feature-local radius overrides,
derive another inset formula, or change the global row radius for one menu.

## Align row content, not state backgrounds

When composing NavigationItem lists inside dialogs or padded panels, align the
leading content column with the heading. With icons, this means the icon slot;
labels form a second consistent column. Give mixed icons and identity fallbacks
the same slot (24px in the page search palette), retaining each
icon's intended size within it.

The hover and selected backgrounds may extend beyond that content edge. Offset
the list wrapper by the existing `--space-control-inset` rather than removing
NavigationItem padding, moving the heading, or overriding the row's paint. The
surrounding composition owns this offset; it is not a global navigation change.

Preserve at least `--space-2` of outer gutter. At the dialog's compact breakpoint
(480px), its padding is 16px, so reduce the outward offset from 16px to 8px. That
small content inset is intentional: the row background and keyboard focus must
stay clear of the dialog edge. Scrollable lists also need space inside their
scroll container for the focus outline; account for that space in the offset.
Align empty-state text with the same leading content column.

Check the composition with no highlighted row, hover, selection and keyboard
focus, in both themes and at narrow widths and enlarged text. Content alignment
should remain legible without a state background to explain it.

## State

Define default, hover, pressed, focus, selected, disabled, and loading states where
they apply. Keep the same control recognizable across those states.

- Pressed changes the fill without moving the control.
- Loading preserves the label’s space and blocks repeated activation in behavior, not just CSS.
- Hover adds contrast appropriate to the surface: a light row darkens, while a dark chip may lighten.
- Selection remains visible after the pointer leaves. A selected toggle-group item does nothing when selected again and has no hover treatment.
- Disabled means unavailable. Do not use it as a quieter text-emphasis level.
- Keep a way to recover visible even when a state assumption or visibility rule is wrong.

## Emphasis

Use three text levels: primary content, supporting text, and metadata. Primary
and supporting text should carry most of the interface. If you need more hierarchy,
first adjust size, weight, position, or grouping rather than adding a fourth color.

Name borders for their purpose: quiet separation, control boundaries, or focus.

## Type

Use complete type roles when building a screen. The raw ramps (`--type-size-*`,
`--type-leading-*`, `--type-tracking-*`, `--type-weight-*`) supply values; roles combine
them into Tailwind utilities such as `text-body`. Both live in `styles/typography.css`.

Color and type roles use separate namespaces. Color registers as `--color-*`; type
registers as `--text-*`. For example, `text-standard text-body` combines a color with a
complete type setting.

The active sizes are 12, 14, 16, 18, 20, 24, 28, 32, 36, 44, 56, 72 and 96px
at 100% interface size. Sans roles use Inter and mono roles use JetBrains Mono.
Values scale with the host interface-size preference.

- Components use named roles, never private primitive sizes. The viewer shows
  each utility’s semantic role and complete setting alongside the size ladder.
- A role carries size, leading, tracking and weight together. Display, title,
  and heading roles use unitless 1.1 leading so wrapped headings have breathing room.
- Regular (400) is for reading; Medium (500) is for labels and structure.
  Existing `font-semibold` consumers resolve to Medium.
- Mono uses `detail/body-xsmall` at 12/16 with 0.03em tracking.
  `--type-xsmall-size` points to the existing 12px step, keeping the semantic
  independent from caption even though their sizes currently match. `text-mono-lg` and
  `text-mono-sm` are compatibility aliases for this same setting, not extra sizes.
- Caption uses 12/16 and 0.0133em tracking. Buzz’s `text-body` uses 14/20; `text-label` uses 16/24 and `text-body-lg` uses 20/28.
- Message prose uses `text-message`: 14px with 1.625 leading (22.75px at
  default), matching Berd’s relaxed reply rhythm for both sent and received
  messages. The message renderer uses `space-4` between prose blocks; labels,
  controls, code, tables and headings retain their existing type roles.
- Preserve text preferences and browser zoom. Author values in scaled rem and
  keep layout geometry independent of text scaling.

Typography provenance: the ramp and role settings derive from the pinned
[Block UI typography
specification](https://github.com/squareup/design-blockinterface/blob/eff766161ba8aaee3258ca107f0d904dd542c708/blockUI/docs/type.resolution.draft.json).
The values documented above define this system, including the 12px xsmall role.

## Both modes

Design and inspect light and dark mode together. Elevation, glass, and accent text
need their own values in each mode.

- Accent text is darker than its fill on light surfaces and lighter on dark surfaces.
- Tints are pale in light mode and deep in dark mode; their names describe their purpose.
- Check text with its actual fill and backdrop, including interactive states.
- The original design exploration was light-only. Buzz’s dark values are authored choices and should be revised when rendered evidence shows a problem.

## Density and rhythm

Choose the content structure first: a list, reading column, gallery, settings
group, or workspace. Use generous space by default, with tighter relationships
inside a group than between groups.

- Dense data uses edge-to-edge rows and dividers where a line helps track the row.
- Distinct swatches, type samples, and avatars often need only space between them. Avoid adding a card or divider when the content already separates itself.
- Show samples on the surface where they will be used. Glass needs a backdrop; a white swatch on white needs a quiet boundary.
- Cards group widgets, gallery items, or settings. They sit on `bg-panel` with spacing or a hairline and have no default fill. Use `bg-hover` only for an interactive card’s hover state. There is no `bg-card` role; `bg-inset` is for recessed content such as inputs or code blocks.
- Use native thin scrollbars: `scrollbar-width: thin` and `scrollbar-color: var(--scrollbar-thumb-quiet) transparent`. Use the sidebar’s subtle gray thumb in both modes. Load the shared recipe into vendor shadow roots and let the browser control scrolling and visibility.

## Motion

Use motion to explain a change in state, position, or structure. Remove animation
that adds no useful information.

### Activity dots

`TypingDots` owns the shared decorative activity motion. `state="waiting"`
breathes all three dots together over 2.4 seconds for a received request waiting
to start. `state="working"` (the default) preserves the 1.4-second staggered fade.
Switching state keeps the same footprint. These named component rhythms are
continuous status motion, not the short state-transition durations.

The feature must supply reliable receipt/work evidence; rendering the waiting
variant does not establish that an agent received a message. Keep visible or
accessible state text with the owning surface. The dots are hidden from assistive
technology and stay static under reduced motion, so motion alone must never be
the only way to distinguish lifecycle states. The component viewer includes both
states and an interactive transition. Agents2 waiting/working presentations reuse
these states in messages, thread summaries and navigation.

Direct manipulation follows the pointer without easing. Apply settling motion
after release, and prevent a drag from selecting text it passes over.

Keep blur fixed during general surface transitions; animate opacity instead.
The form dropdown, menu, popover, and tooltip sections document narrow,
designer-requested blur exceptions. Respect each component’s keyboard and
reduced-motion treatment.

## Colour structure

The palette supplies values. Semantic roles name their purpose. Components and
screens consume those roles so one shared edit can change every caller.

| Layer | Example | Used by |
|---|---|---|
| **Palette** | `--purple-9`, `--neutral-4` | Shared token definitions; each hue has authored light and dark steps. |
| **Roles** | `--surface-panel`, `--text-danger`, `--affordance-subtle-hover` | Component recipes and product screens. |
| **Components** | Button, Input, Dialog | Product features that need the same appearance and behavior. |

Choose a role by its job, even when it uses the same palette step in both modes.
Add roles for real uses and their required states; document the intended surfaces
and paired text. Do not generate unused role families from every palette hue.
Existing palette utilities and older role names are compatibility APIs while
callers migrate, not the default for new UI. Tailwind's stock palette is removed.

`ShimmerText` gives a short live-work label (an agent's current step) a slow
sheen between the subtle and standard text roles. Use it only while that work is
live, never on finished, failed or waiting text. Reduced motion shows plain text.

Activity indicators that appear while work is live (the message activity pill,
thread-summary dots, sidebar working badge) use the `buzz-arrive` recipe.
Inline indicators beside text get a quiet fade at `--duration-state`.
Standalone pills add `data-arrive="grow"`: they open their space while fading
in, with `--duration-settle` and `--easing-settle`, so content below moves
instead of jumping. When work ends, the owner may set `data-leaving` and keep
the pill mounted until its animation finishes; it fades and closes its space.
Growing and closing resize the row for a few frames, so reserve them for
indicators that start and end with work, never for revoked access. Reduced
motion disables all of it.

### Changing a color

Change a semantic mapping when one job needs a different value. Change a palette
step when its value is wrong for all roles that share it. Measure the actual
pairings in both themes; a numbered step alone does not guarantee contrast.
For example, warning boundaries use amber-11 in light mode and amber-9 in dark,
because the lighter amber steps cannot identify a control against a light panel.

Palette values are based on Radix Colors (MIT), with authored neutral ramps and
documented adjustments in `tokens.css`. These are values, not a component or
behavior dependency. Base UI remains the component behavior layer, with Sonner owning Toast.

### Naming and usage

Use purpose, emphasis and state: `surface-panel`, `text-subtle`, `border-danger`,
`affordance-prominent-pressed`. Text and border roles register in their own
Tailwind namespaces so a border cannot accidentally inherit a text color.

- Use `text-danger` for error text and pair it with the documented surface.
- Add a categorical role when a feature needs to distinguish identities by hue.
- Keep transparency in shared material recipes. Do not dim tokens locally.
- Author both light and dark values; do not derive one by dimming the other.
- When two roles share a decision, reference the same token rather than copying a literal.

## Contrast

Buzz checks opaque text pairs against both **WCAG AA (4.5:1)** and its existing
**APCA** targets: Lc 60 for body/UI text and Lc 45 for metadata. Small metadata
still needs the normal-text WCAG ratio. Control and state boundaries use the
separate WCAG 3:1 non-text ratio; decorative separators and hover fills do not.

- **Use both measurements.** The ratio establishes the AA floor; APCA adds a
  polarity-aware readability check. A perceptual pass alone does not establish
  WCAG conformance, and a numeric pass does not replace rendered inspection.
- **Adjust the fill to support readable text.** If neither black nor white is legible on a solid fill, change its lightness while preserving the hue.
- **Derive paired text from its fill.** Generate `text-on-*` with the fill instead of setting it independently.
- **Share the pairing logic.** Desktop, mobile, and web use one implementation.
- **Size a text step against the worst surface it can land on**, including
  hover, pressed and selected fills. A step that only clears a panel at rest
  can fail when a menu row highlights.
- **Dark mode is not light mode inverted.** APCA is polarity-asymmetric:
  light-on-dark needs more separation than the same WCAG ratio suggests. The
  dark ramp's text steps are therefore lighter than a mirrored ramp would put
  them — steps 9 and 10 sit above where linear spacing would.
- **`text-disabled` is deliberately below target.** Low contrast is the signal
  that a control is unavailable. Never put information a person needs there.
- **`pnpm design:check` enforces this.** Every text role is measured against
  every surface it can sit on, in both modes, parsed from `tokens.css` so the
  check cannot drift from the tokens. Keep exceptions in the owning guard with a stated reason.
- **Check identity text on tint hover.** Measure its `text-*` role against the highlighted tint as well as its resting surface.
- **Decorative dividers have no contrast target.** WCAG’s 3:1 non-text requirement applies to boundaries needed to identify a control or state. Keep quiet grouping lines distinct from required control boundaries.
  Error and warning boundary roles must reach 3:1 against surface-base,
  surface-panel, surface-inset and surface-popover in both themes. The contrast
  guard checks these role mappings and status dots separately from text and
  decorative dividers.

### Link contrast

Inline links and mentions use Blue 11 with Blue 3 hover in both modes.
Blue 11 is tuned for the supported surface stack: #0b5fa8 in light mode and
#83c4ff in dark. These pairs have no link-specific contrast exemptions.
The contrast guard checks APCA and WCAG AA (4.5:1) on opaque text pairs, including
hover and pressed fills. Metadata uses neutral 9 (#5f5f5f) in light mode so small
labels remain readable even on the pressed neutral 4 surface.

### Quiet surface stack

In dark mode the panel is #1a1a1a, inset #101010, subtle control #232323,
popover #282828, ordinary control hover #2e2e2e, and floating row hover/ordinary
selection #333333. Floating controls and selection use #404040, with control
hover #595959 and press #737373. The popup separates from the panel without
consuming the ordinary control hover range.
In light mode panels and popovers remain white, inset/control fills #f5f5f6,
control hover #f1f1f2, floating row hover #f5f5f6, ordinary selection #e8e8e8,
and floating selection #dadada.
Borders stay decorative unless needed to identify a control or state.

### Relative sizing

Use rem for authored UI dimensions and spacing, semantic roles for text, and
unitless line-height. Dimensions are based on a 16px root at the default interface size.
The host interface-size preference scales the root, so text, numeric icons and
rem layout spacing grow together. Keep physical hairlines, optical offsets, and runtime
geometry returned by the browser or media APIs in pixels. Sidebar resize limits
and its 650px navigation breakpoint remain paired with their JavaScript owner;
the timeline measures its rem-sized leading region for Virtua's pixel start margin.

## Writing

Use direct, familiar language and remove words that do not help someone decide or act.

- Labels describe the action or destination in the reader’s terms.
- Empty states explain what belongs there and provide a useful next step.
- Errors explain what happened and how to recover, beside the affected control.
- Keep names and capitalization consistent across the flow.

Pane titles name the destination (“Agents”, “Projects”); they do not carry setup
instructions or implementation details. Subtitles must add useful orientation,
not repeat the title. Put collection limits and recovery guidance next to the
affected content. For example, “Showing up to 100 projects and repositories” is
appropriate only if the limit counts displayed objects. Projects currently limits
announcements before grouping/deduplication, so use “Showing a partial list from
up to 100 announcements.” Preserve what the limit actually counts. Explain technical
distinctions only when they change what someone can find or do.

Use concise, verb-first action names in buttons, menus, and icon hints. Switching
from a labelled button to an icon must preserve the action's accessible name.
Keep the same term across the trigger, dialog, and result. Empty-state actions
may use text buttons even though pane-header actions are icon-only.

## Accessibility

Give every interactive element an accessible name, with one owner for each label.
Use paired text roles on colored surfaces and verify the rendered contrast.

Keep keyboard, pointer, and shortcut paths consistent. When adding an input handler,
identify and check every supported way to reach the action.

The intended focus recipe requires both `html[data-keyboard-navigation]` and
`:focus-visible`. The app-root modality owner supplies the attribute; pointer
focus stays quiet, including programmatic focus during a drag. Shared text
fields replace the ring with a perimeter stroke; see
[Focus appearance](#focus-appearance) rather than adding a
local replacement.

Pair color with text, shape, or position. Solid avatar status badges are an explicit
product exception, including the light Away badge’s accepted contrast shortfall.
Preserve their fills and expose known status through the owning accessible label
or description. See [Identity shapes](#identity-shapes).

## Responsiveness

Check narrow, intermediate, and wide layouts, including enlarged text and browser
zoom. Use relative units for readable content so the interface respects the
person’s size preference. Allow content to reflow before it clips.

## Growing the system

1. Use an existing component before assembling its appearance yourself.
2. Choose a semantic role by purpose. Add a state sibling when the actual control needs it.
3. Keep each new role paired in both modes, document it in the token registry, and check contrast.
4. Fix shared decisions in their owner. Do not cancel shared styles from a feature stylesheet.
5. Keep layout, media geometry, editor semantics and data behavior with their product owner.

## Components

Reuse and compose existing components before adding another.

- **Behavior:** inspect Base UI before building an interactive shared component. Use its matching primitive for focus, keyboard behavior, positioning, portals, and dismissal. Buzz owns appearance and product semantics. Toast uses Sonner as documented above. Use native elements where Base UI has no matching primitive or the component is static.
- **Variants:** add a missing visual variant for a real use and mark it proposed. Do not cancel several existing states to force an unsuitable variant to fit.
- **Props:** use named variants for visual differences, never a new boolean appearance prop. Keep data and behavior props distinct from appearance choices.
- **Ownership:** keep a component with its first feature. A second real use can justify proposing it as shared.
- **Focus recipes:** require `html[data-keyboard-navigation]` and `:focus-visible` on the control. Do not rely on a base-layer reset to override component-layer styles, and do not add a `:focus-within` ring around a container that already has a control recipe. Where a scrolling list would clip an offset ring, inset it with `outline-offset: -2px` instead of shrinking it. Shared fields and the composer follow the exceptions documented above.

## Using the system

Choose a component and a role by their purpose:

| Need | Shared role or owner |
| --- | --- |
| Page background | `surface-base` |
| Panel or card surface | `surface-panel` |
| Popup | `surface-popover` |
| Recessed region | `surface-inset` |
| Control states | Affordance roles |
| Labels and reading text | Text roles |
| Edges | Border roles |

When a shared role fails in context, measure its supported surfaces and repair the
shared decision. Do not substitute a palette step in one feature. For example,
`border-primary` uses neutral-4 in light mode and neutral-6 in dark so its quiet
boundary remains visible on both page surfaces.

A role names a purpose even when it uses the same palette step in both modes.
Repeated visual treatments belong in the system. If a real design exposes an
unsuitable rule, explain the conflict and improve the rule rather than working
around it locally.

## Icons

Tabler is the only general icon family. Import named icons from `icons/index.ts`,
which re-exports individual upstream modules. Add exports as needed; no approval list.
SVG-only widgets use individual assets through `icons/svg.ts`. Do not import the
upstream packages elsewhere or reintroduce other icon libraries. Outline icons use
Tabler’s default stroke width of 2; explicit `strokeWidth` and filled exports remain
designer choices, with no size-to-stroke or selection-to-fill rules. Existing bold
uses have `strokeWidth={2.5}`; video play/pause controls use explicit filled icons.
Keep the public gateway names stable. For chat and conversation metaphors, use
`ChatCircleIcon` / `ChatsCircleIcon` (Tabler’s MessageCircle / Messages), choosing
the variant that matches the meaning. Keep accessible names on controls and
decorative artwork hidden from assistive technology.

`RobotIcon` is the designer-approved **Soft & wide** custom agent mark, using the
**Fuller canvas** refinement: a larger rounded head, short antenna, narrow ear
strokes moved inward to meet the head, and filled dot eyes, with no mouth. The
artwork fills more of the same icon box without widening the ears or adding fill
between them and the head. It uses Tabler's 24-unit canvas, round caps and default
stroke width of 2. Use the
existing gateway export for agent mentions, navigation and placeholders; retain
its inherited color, relative sizing and decorative-by-default semantics. This
is a specific product-mark exception, not another general icon family.

OneDrive is a designer-approved custom brand mark: its complete outline is recreated on
Phosphor’s square canvas, uses the same current-color and sizing behavior, and stays in
the shared icon gateway. It does not permit another general icon library.

Agent-type provider marks follow the same single-owner path. Keep approved artwork
in `icons/HarnessLogos.tsx` (with colocated raster assets when needed), record its
provenance in `NOTICE.md`, and export it through `icons/index.ts` with custom-icon
metadata. The registering agent type references that export once through
`AgentType.icon`; host-owned selectors render the registered mark and never rebuild
a provider-to-icon map from type IDs.

### Picker search and choices

Mention and media pickers opt into `SearchField variant="capsule"`. Its shared
`search-field.css` recipe also styles Emoji Mart inside its shadow root: body-sm
typography, pill radius, standard panel fill, Tabler icons, and a 32px clear
action. Other SearchField callers retain the default field treatment. Scrolling
picker results use the opt-in `buzz-thin-scrollbar` native scrollbar recipe.

Mention choices use `NavigationItem variant="option"` with 8px padding and
immediate hover/focus feedback. The picker owns arrow-key navigation and exact
identity selection; rows retain ordinary button semantics.

### Chrome route navigation

For full-page destinations, compose native-button `NavigationItem variant="pill"`
inside `nav.chrome-navigation`. It shares the chrome tab material and selected fill
but keeps normal Tab/Enter and `aria-current="page"` semantics. Do not give route
buttons a tablist/tabpanel relationship when selection moves focus to main content.
The wide shell topbar is the deliberate exception: Me and Messages use
`Tabs variant="chrome"` linked to the retained, labelled page panel. Arrow keys
move focus without selecting; Enter, Space or pointer selection changes the page
while focus stays on its tab. The host passes per-opening focus intent so page
autofocus does not override that handoff. Explicit content openings, including
New conversation, retain their destination focus. This is not a general route-tab
recipe: toolbar destinations and More pages overflow retain button semantics.
Messages represents the containing area for registered sidebar/default-placement
pages, while their sidebar selection and route remain exact. Its tab stays linked
to the active child panel. The shell opts into Tabs' `onReselect` to return from a
child to Messages without changing ordinary active-tab behavior elsewhere. More
pages marks that containing area with `aria-current="true"`, reserving `page` for
an exact destination. Settings and independent header pages stay separate.

The shell owns responsive overflow. Full-page `IconButton variant="chrome"` uses
`aria-current="page"` for selection; companion toggles continue to use `aria-expanded`.

### Artwork actions (proposed)

`SurfaceButton` uses Base UI activation and the shared keyboard-only focus ring.
Use it for artwork tiles whose content owns their geometry, such as new-agent
and avatar choices. It adds no label wrapper, padding, or background; callers
must supply an accessible name and keep state colors semantic. The Button
viewer includes enabled and disabled examples.

### Chip and title fields (proposed)

`Combobox.Control appearance="chip"` drops the field's surface and browse
button until the control is hovered or open, so a choice reads as a label, such
as the model beside the type in the New agent card. Keyboard focus keeps a ring.
`Input appearance="title"` sets its value at title size with no field around it,
for a name that is also the heading, such as the new agent's name.
