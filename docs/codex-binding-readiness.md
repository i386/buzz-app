# Codex binding readiness

> **Status: superseded by Agents.** This describes the v1 native Codex binding
> (Settings rows, Create/Edit form, native model discovery and harness install),
> which was removed with the v1 Agents system. Codex now reaches the app as an
> The agent type registered by the bundled Codex plugin.

Codex is a native integration. New selection requires installed tools; Create
and Save require no inference check. Settings shows tool presence and, once
both tools are found, reads the existing CLI login with `codex login status`,
as it does for Claude. Like Claude, Start launches the saved binding
without a separate probe; adapter and login failures appear in the agent log.

## Binding contract

The native controller resolves one `CodexContext` for each discovery or launch. It contains
canonical paths for the selected `codex-acp` adapter, `codex` CLI, any script
interpreters, the workspace, and the effective process environment. Adapter
commands receive the selected CLI through `CODEX_PATH`; there is no fallback to
an engine bundled with the adapter. Script interpreters are resolved explicitly,
and both adapter and CLI interpreter directories are included in the isolated
`PATH`. This binding currently runs on Unix platforms. Other
platforms report unsupported and keep Codex creation disabled.

The process environment starts empty. Buzz passes only the operating-system and
Codex home/configuration roots needed by the selected tools, then adds
`CODEX_PATH`, `INITIAL_AGENT_MODE=agent-full-access`, and the shared machine tool
path behind the exact bound interpreter and runtime paths. Provider credentials are not projected by this layer. Any ambient or
explicit `CODEX_CONFIG` value, including an empty value, is rejected until
Buzz can apply and validate those session overrides against the same
configuration used by the adapter.

## Adapter lookup and Install

Settings status and new harness selection share the installer lookup, as
Claude does. A user-installed
`codex-acp` wins; Buzz searches `~/.local/bin`, the discovered login-shell
PATH, the app's inherited PATH,
`/opt/homebrew/bin`, then `/usr/local/bin`. Otherwise Buzz uses the app-owned
adapter at `<app data>/codex-tools/bin/codex-acp`, but only when its pinned
managed Node is also installed. An app-owned adapter always runs on that Node;
the CLI keeps its own interpreter. Buzz never installs the Codex CLI. The CLI is
resolved from the same user directories.

When Settings reports **Adapter needed**, it offers **Install** on macOS
and Linux. It reuses the checksum-verified managed Node and installs
`@agentclientprotocol/codex-acp@2.1.1` into a new `codex-tools/releases`
directory. As with Claude, npm also installs the adapter's bundled platform
binaries, including about 330 MB for its own Codex CLI. Buzz never runs that CLI
because it always sets `CODEX_PATH`. The launcher must pass `--version` before
activation. A failed
install keeps the previous release and shows the private install log. Success
re-detects the tools, so no `PATH` change or symlink is needed. Install shares the
native install/quit owner with Pi and Claude. If a user-installed adapter
exists, Install refuses and the user updates it in their terminal. Settings
does not probe adapter versions; an incompatible user adapter appears in the
agent log at Start. Adding
or removing a user adapter changes new selections. Existing agents keep their
saved command for model discovery and Start, including its managed Node binding.
A missing saved adapter is a Start error; it never triggers silent fallback.

`HarnessIntegration::Codex` is the policy authority. An editable command basename
does not grant Codex policy or full-access behavior. Default delegates model and effort to the CLI. Advanced stores the selected
model and model-specific effort intent.

Context equality fences values used within one operation. It does not prove that
configuration files or authentication remained unchanged. Model discovery and execution resolve the saved context for each operation.

## Start

Start resolves the saved adapter, the installed CLI, interpreters, workspace,
and isolated environment, then launches the adapter through the bundled Buzz
ACP runtime. A missing or non-executable saved adapter, a missing CLI, or a
rejected `CODEX_CONFIG` is recorded as the agent's Start error. Version,
login, and protocol failures come from the adapter itself and appear in the
agent log, as they do for Claude. Ordinary agent snapshots and lifecycle
polling never launch Codex tools.

## Verification

Focused automated coverage binds canonical resolution, exact CLI launch through
the adapter, the isolated environment, Default and Advanced model/effort
projection, no fallback from a missing saved adapter, and the Settings install
and sign-in states. Tests for logout or malformed configuration must use an
isolated `CODEX_HOME`; do not modify the user's ordinary Codex profile.
