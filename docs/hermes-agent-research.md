# Hermes Agent integration research

> **Status: superseded by Agents.** The v1 create/edit form, Settings harness rows,
> model picker and device-defaults card this research targeted were removed with the
> v1 Agents system. A harness now reaches the app as an agent type that a
> plugin registers, as the bundled Claude and Codex plugins do. The sections
> below record the research and the slice built against the removed UI; table rows
> whose owners no longer exist are dropped.

Hermes Agent should be a Tier 2 preset: an externally installed ACP harness with
manual setup and Hermes-owned provider configuration. Old Buzz already implements
that classification. The new app can reuse its existing external-executable
launch path, but needs changes in discovery, Settings and the shared agent form.
Matching old Buzz's model picker also needs a native ACP model-discovery path.

Research snapshot: October 5, 2026. New app: fetched `origin/main` at
`a244e3cb3c3eaebac9d8daacdc9028b3eb35bab8`. Old Buzz source checkout:
`15772c54f36d1ed68c9c77ffb63235acb5ee8a64`. Buzz Agent remains the default and
Goose remains a bundled, always-available harness.

## Hermes in old Buzz

### Runtime catalog and Settings

[`discovery/presets.rs`](https://github.com/block/buzz/blob/15772c54f36d1ed68c9c77ffb63235acb5ee8a64/desktop/src-tauri/src/managed_agents/discovery/presets.rs)
defines `id: hermes`, label **Hermes Agent**, command `hermes-acp`, and no default
arguments. The generated entry has `source: preset`, `can_auto_install: false`,
`auth_status: NotApplicable`, no separate underlying CLI requirement and no
provider/model/effort environment mapping. Discovery resolves the executable;
presence produces Available, absence produces NotInstalled. This is executable
availability, not an authentication or inference check.

[`HarnessesSettingsPanel.tsx`](https://github.com/block/buzz/blob/15772c54f36d1ed68c9c77ffb63235acb5ee8a64/desktop/src/features/settings/ui/HarnessesSettingsPanel.tsx)
and `harnessCatalogLogic.ts` place an unavailable Hermes under **Add runtimes**.
The catalog contains every non-custom runtime, including installed presets.
Hermes's detail pane shows setup text and opens its setup guide; it offers no
automatic installer. Once available, Hermes also earns a **Your runtimes** row.
**Check again** forces rediscovery. Presets cannot be edited/deleted as custom
harness definitions. Its logo is a bundled asset with attribution in
`desktop/public/harness-logos/CREDITS.md`.

### Create and edit

`AgentDefinitionDialog.tsx` and `AgentInstanceEditDialog.tsx` consume the shared
runtime catalog. Hermes appears as a named choice. Create normally disables
unavailable choices when an available default exists; when none exists, selecting
an unavailable choice exposes guidance while submission stays blocked. Edit
preserves current selections, including unavailable or unrecognized values.

Hermes has no separate Provider field: `runtimeSupportsLlmProviderSelection`
allows Buzz Agent and Goose. `agentConfigCore.ts` treats a model without a native
environment key as an ACP-native selection. The model-discovery backend runs
`buzz-acp models --json`, and `normalize_agent_models` accepts both stable model
`configOptions` and unstable `availableModels`. Saved models remain exact ACP IDs;
there is no Hermes-specific provider table or invented model environment variable.
The effective harness descriptor owns command, arguments and environment for both
discovery and launch.

## Upstream Hermes contract

The [official ACP guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp/)
documents `hermes-acp` with no arguments and the equivalent `hermes acp`.
The ACP dependency extra must be installed. Recent installations put launchers in
`~/.local/bin`; updating Hermes adds the ACP launcher to older installations.
Setup should direct users to install Hermes, enable ACP, configure credentials
with `hermes model`, and run `hermes acp --check`.

ACP uses Hermes's existing home configuration and credentials. Its model inventory
contains exact IDs such as `provider:model` and `custom:name:model`; the app should
preserve these whole. A session model choice does not change Hermes's global
default. Session-supplied MCP servers and workspace selection are supported.
These protocol claims come from upstream documentation; compatibility with the
new app's pinned bridge still requires execution against an installed version.

## Verified pinned bridge support

The new app pins Buzz revision `4f51b9e1010e086a16c099cd8d8218ca974a5e18` in
[historical agent-runtime.json](https://github.com/block/buzz-app/blob/a2b7db9ae/runtime/agent-runtime.json). Its
[`run_models`](https://github.com/block/buzz/blob/4f51b9e1010e086a16c099cd8d8218ca974a5e18/crates/buzz-acp/src/lib.rs#L6073)
already implements `buzz-acp models --json`: initialize and session creation have
a ten-second timeout, and success, protocol error and timeout explicitly shut down
the adapter. JSON includes stable `configOptions` and unstable `availableModels`.
This command requires no Buzz identity or relay connection. No bridge update is
needed to expose its catalog in the new app.

The pinned
[`default_agent_env`](https://github.com/block/buzz/blob/4f51b9e1010e086a16c099cd8d8218ca974a5e18/crates/buzz-acp/src/config.rs#L773)
recognizes Hermes command basenames, including absolute paths and Windows suffixes,
and supplies `HERMES_ACP_SKIP_CONFIGURED_MCP=1` unless explicitly overridden.
Both launch and model probing use this spawn path. This skips Hermes's globally
configured MCP startup; Buzz supplies session MCP servers separately.

Model discovery is not model enforcement. The pinned
[`pool.rs`](https://github.com/block/buzz/blob/4f51b9e1010e086a16c099cd8d8218ca974a5e18/crates/buzz-acp/src/pool.rs#L1755)
continues with the agent default when a requested model is absent. It emits an
`unsupported_model` observer result, so describing this as only a log warning is
incomplete; the new create/edit flow does not consume that result as model
failure feedback. Browse reduces typos but cannot prevent stale or rejected picks.

## New app gaps and proposed changes

| Owner | Current behavior | Hermes change |
| --- | --- | --- |
| [Old Buzz import](../crates/agent-controller/src/import.rs) | A normal `runtime: hermes` preset reference is rejected unless an override/custom definition supplies a command. | Separate follow-up: choose an import-time absolute-path mapping or launch-time resolution. Preserve missing-install recovery and source data; do not auto-start imported agents. |

The [historical controller launch path](https://github.com/block/buzz-app/blob/a2b7db9ae/crates/agent-controller/src/runtime.rs) already
accepts an executable absolute path, passes literal arguments through `buzz-acp`,
and applies a nonempty model as `BUZZ_ACP_MODEL`. A nonempty Provider on an
unmapped external harness is rejected. Therefore Hermes does not require bundling
a Python runtime, a new installer, a new ACP adapter, or a new supervisor.
`installed` already checks `~/.local/bin`, PATH and common Homebrew directories.
The existing sanitized environment retains HOME and explicit local overrides;
shell-exported provider credentials are not automatically inherited.

Follow the existing Pi pattern for the native option and frontend setup constants.
No new preset metadata/capabilities contract or Goose/Pi refactor is needed for
this addition. Agent selection still consumes `session.agentChoices`; that is
separate from configuring harness options in the native snapshot.

Use the existing Tabler `TerminalWindowIcon` as a proposed Hermes placeholder
through the icon gateway; a Hermes brand asset needs a designer's choice and
attribution. The Settings icons already added for Buzz Agent, Goose and Pi remain
part of the separate requested UI change.

## Scope and implementation order

Recommended first slice: discovery, Settings manual setup, stable Hermes identity
and shared create/edit, using Hermes's own default model. This deliberately drops
the original manual-ID proposal because invalid IDs can select a different model
without form feedback. Existing nonempty Hermes model/provider values must stay
visible for recovery and require an explicit reset to defaults before use; async
discovery must not erase them. Check effective selectors and environment overrides
before claiming the default-only contract. This slice does not provide old Buzz's
model-picker parity.

Reuse the existing native snapshot, Settings rows and form owners. Expected files
were `agents.rs` and the since-removed v1 owners (`AgentSettings.tsx` harness rows,
`agent-edit.ts`, `AgentHarnessEditor.tsx` and `AgentModelPicker.tsx`), with the existing native validation owner if required to
enforce default-only selectors. Aim for roughly 150–250 production lines,
excluding tests/docs and the separate icon work. Review the first working slice
before expanding. No generic native metadata contract is planned.

Device defaults and old-agent import each cross an additional owner boundary;
include them as explicit follow-up slices rather than silently expanding the
first patch. Full old-Buzz model-picker parity reuses the verified `buzz-acp
models --json` command. It still needs native effective draft/saved context
resolution, sanitized environment and workspace handling without Buzz identity
credentials, bounded output parsing, and stable/unstable menu normalization.
Reuse the existing model ticket and cancellation owner. Cancellation must retire
the adapter and its descendants as well as the outer probe: killing `buzz-acp`
abruptly does not prove its adapter shutdown code ran. Prove cleanup on cancel,
form close, timeout and failure. Do not reuse Goose's private provider RPC or Pi's
slash-splitting semantics for Hermes IDs.

Preserve saved/custom IDs on empty/error results and allow explicit retry after
configuration changes. Before offering overrides, specify how unsupported and
rejected models become visible to the user; catalog selection alone cannot promise
the requested model ran. This crosses the controller/model owner boundary and
needs its own scope checkpoint. Hermes connection testing, terminal authentication
UI, auto-install, remote runtimes and other preset adapters are outside the first
slice. No runtime pin change is currently justified.

Old Buzz needs no Tier 1 catalog addition: its Hermes preset is already Tier 2.
The new app has no tier framework today; Tier 2 describes setup and ownership,
not a need to build a generic three-tier platform. Goose and Pi retain their
existing richer integrations.

## Acceptance and remaining gaps

Focused native and mounted-form coverage should establish missing/found
discovery, setup refresh, stale selector clearing, saved-value preservation,
provider omission, default-only model behavior and no Databricks lookup. Exercise
an installed Hermes end to end: create, save, start, receive one owner-authorized
Buzz message and reply, stop, edit, restart and confirm persistence. Retain the
existing owner/relay/credential protections and process cleanup boundaries.
On macOS, verify the launcher and a representative tool subprocess with the
current fixed PATH; detecting `hermes-acp` does not establish that Hermes can find
Homebrew or user-installed tools. Windows launcher compatibility also needs a
real platform check. If defaults/import or Browse are included, cover persistence,
exact model IDs, rejection feedback and cancellation contracts too. No full scan
is needed for this research note.

The first slice was implemented against the v1 UI: native discovery, Settings Add harness chooser and
manual setup (installed Hermes appears in the main list), saved
path identity, shared create/edit with default-model recovery and a native launch
guard. Focused mounted-form coverage and the controller's synthetic runtime test
pass; the saved-path and invalid-model regressions also fail on pre-change code.
The exact pinned bridge was inspected. Real Hermes launch, live ACP exchange,
credentials, packaged discovery and cross-platform behavior remain unverified.
Windows suffix-based discovery is a known limitation: `installed("hermes-acp")`
does not try `.exe`/`.cmd`/`.bat`; recognizing saved paths does not fix detection.
Browse, device defaults and old-agent import remain follow-ups. Settings icons
have separate checks and a browser preview; those do not validate Hermes
compatibility.
The Settings and form parts have since been removed with the v1 UI; the native
discovery and the controller's `harness-presets.json` remain in the Rust host, with no
frontend consumer.

The Tier 2 implementation now uses one controller-owned preset definition file,
shared with TypeScript for metadata and saved-command recognition. Native
`harnessOptions` still own installation and selectable choices. Hermes is its
first and only entry; Amp, Cursor and shared ACP Browse remain separate work.
