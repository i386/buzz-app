# Codex model and effort discovery

> **Status: superseded by Agents.** This describes the v1 native Codex binding
> (Settings rows, Create/Edit form, native model discovery and harness install),
> which was removed with the v1 Agents system. Codex now reaches the app as an
> The agent type registered by the bundled Codex plugin.

Create and Edit use headless model and effort discovery for the native Codex
binding described in [Codex binding readiness](codex-binding-readiness.md).
Discovery itself does not persist a selection, create an identity, send a prompt,
or establish successful inference.

## Request and context contract

The frontend model request carries the stable native integration ID. Only
`codex` selects this path; an editable command named `codex` or `codex-acp` is
not authority. Native code resolves the effective draft or revision-fenced saved
agent, including its workspace and permitted Codex environment, then runs the
selected Codex CLI from that `CodexContext`. Environment defaults owned by
Goose, Databricks, or another harness are excluded instead of entering the Codex
process. Each request resolves its context again.

Discovery runs through the existing model-request host ticket, as Pi and Goose
do. Existing Databricks, Goose, and Pi behavior is unchanged. This
implementation is enabled on Unix builds. Other platforms return the existing
unsupported result and keep Codex creation disabled.

## Catalog source

Discovery runs `codex debug models` with the selected CLI, the same CLI that
`CODEX_PATH` gives the adapter at Start. It opens no ACP session, so it sends no
prompt and does not start MCP servers configured for Codex.

- Only models with `visibility: "list"`, the models Codex shows in its own
  picker, are offered. Hidden models are excluded.
- Each model's `display_name` labels its `slug`. The slug is the same ID the
  adapter accepts as its `model` configuration option; the adapter rejects
  hidden slugs.
- A request with a selected model returns that model's
  `supported_reasoning_levels` as effort choices and its
  `default_reasoning_level` as the current effort. No levels means the model
  reports no effort control. A selected model that is hidden or absent is an
  error, so the editor refreshes the catalog without that selection.

The command runs in its own process group with a 15-second deadline and a 1 MiB
stdout limit; stderr is discarded. Cancellation or timeout kills the group. A
non-zero exit or unreadable JSON reports that Codex did not return a readable
catalog, and saved choices stay unchanged. `codex debug` is not a documented
stable interface, so a future CLI output change surfaces as that error rather
than as a launch failure.

## Evidence

On October 8, 2026, `/opt/homebrew/bin/codex` 0.151.0 reported six models, three
listed. A headless session with `@agentclientprotocol/codex-acp` 2.1.1 offered
exactly those three listed slugs as `model` values, accepted a listed slug, and
rejected a hidden one; the selected model's effort values matched the catalog.
The ignored live test runs discovery with the installed tools.

Controlled tests cover listed-only projection, per-model effort and defaults,
hidden or unknown selections, malformed, failed, and oversized output, and that
cancellation kills the CLI and its descendants. Windows, packaged-app discovery,
and a live GUI flow were not exercised.

Discovery is capability evidence only. Create and Save require no inference
validation; see the current [execution contract](codex-validation-execution.md).
