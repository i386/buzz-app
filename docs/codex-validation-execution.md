# Codex persistence and execution

> **Status: superseded by Agents.** This describes the v1 native Codex binding
> (Settings rows, Create/Edit form, native model discovery and harness install),
> which was removed with the v1 Agents system. Codex now reaches the app as an
> The agent type registered by the bundled Codex plugin.

The October 8, 2026 simplification replaces the earlier mandatory connection
validation contract. Create and Save follow the existing Claude lifecycle:
persist the requested configuration, then report execution errors through Start
or the existing restart controls. They send no inference prompt and require no
single-use validation proof. Native structural validation, owner authorization,
revision checks, and credential custody still apply.

## Configuration and execution

Default saves no model or effort override. The selected CLI reads its effective
configuration at each Start. Advanced retains an explicit model and either a
reported effort value or explicit absence of effort support. Model discovery
reads the selected CLI's `codex debug models` catalog and sends no prompt. Saved choices survive an
unavailable catalog. Runtime arguments carry the requested Advanced settings;
Buzz retains the runtime's existing fallback behavior.

Every existing agent keeps its saved adapter command. Start and model discovery
resolve that command, its interpreter, the installed CLI, workspace, and allowed
environment. Installing a different global adapter changes the choice for new
agents and Settings checks, not existing agents. A missing saved adapter fails
Start without switching adapters. Editing the harness is an explicit choice.
An app-managed adapter continues to use managed Node, and CODEX_PATH continues
to select the user's CLI rather than an adapter-bundled engine.

Save uses the shared compare-and-swap persistence path. Saving a running agent
uses the shared restart path; restart failure leaves the saved revision intact
and visible through existing error/retry controls. Edit may switch a saved
Codex agent to another harness; that Save clears the Codex marker with its
Default/Advanced configuration, and a configuration without the marker is
refused. Re-selecting Codex or editing its adapter path keeps the saved
configuration. Stopped agents stay stopped on Save.

Start resolves the saved binding and launches it, as for Claude; it does
not probe versions or sign-in and does not send a test prompt. The runtime's
normal conversation path owns inference. Adapter, login, and inference failures
remain visible in existing status/log controls.

## Create

Codex uses the same prepare, authorize, and commit Create flow as every other
harness, with no Codex-specific recovery journal. A configuration can be saved
while tools are unavailable. A `pendingCreate` journal left in the agent store
by an earlier unreleased build is preserved as unknown data and ignored.

## Deliberately removed

The inference validation service, single-use proof admission, validation UI and
cancellation states, and inference-only ACP helpers are removed. PR #670's
observed-settings feature is removed. Requested settings remain configuration;
they are not presented as runtime observations. PR #724's adapter installer,
Settings status, managed Node, release activation and install/quit ownership
remain in place.

## Acceptance boundaries

Controlled tests exercise native IPC persistence, authorization, credential I/O
outside the agent operation queue, revision conflicts and configuration intent. The
saved-adapter regression exercises real controller resolution after a global
adapter appears and after the saved adapter is removed. Browser fixtures exercise
Create/Edit wiring and keyboard model/effort selection. They do not establish
real Keychain access, a successful Codex conversation or signed relay delivery.
See [Create and Edit acceptance](codex-create-edit-ui.md) for the human workflow.
