# Codex Create and Edit acceptance

> **Status: superseded by Agents.** This describes the v1 native Codex binding
> (Settings rows, Create/Edit form, native model discovery and harness install),
> which was removed with the v1 Agents system. Codex now reaches the app as an
> The agent type registered by the bundled Codex plugin.

This is the current contract after the October 8, 2026 simplification. Historical
validation/proof test results in earlier stack revisions do not establish this
contract.

## Product behavior

Codex uses its native integration ID, not an executable basename. New selection
requires installed CLI and adapter presence, as Claude does. Settings owns
installation and the global setup check. Agent forms do not repeat that check
because an existing agent can use a different saved adapter.

Default stores no model or effort override. Advanced keeps the advertised model
and model-specific effort selectors, including explicit absence of effort support.
Unknown, empty, failed or changed catalogs preserve saved choices. A user model
change clears effort only when returned metadata proves it invalid. Late results
are fenced by their request context, and lookup remains cancellable.

Create proceeds directly to identity preparation, signed owner authorization and
native persistence. The existing flow then attempts Start and profile setup. A
Start failure retains the created identity and exposes the existing retry action.
Save persists through the normal native path and uses the existing restart rules.
Neither operation performs mandatory inference validation or displays a testing
phase. Ordinary malformed input and persistence errors still retain the draft.

Existing agents retain the saved adapter path even when global discovery changes.
Duplicate retains Codex integration, mode, model and effort while omitting identity
credentials and write-only environment values. Codex remains configured per agent;
device-wide defaults are unchanged.

Create uses the ordinary flow shared by every harness. See
[persistence and execution](codex-validation-execution.md).

## Automated coverage

- Control and component tests cover Default/Advanced Create and Save without a
  validation service, ordinary pending states, retained drafts and identity
  continuity.
- Native invoke tests cover Create with unavailable tools, one durable identity,
  credential I/O outside the agent operation queue, Advanced Save, stale
  revisions and integration-marker preservation.
- The browser agent-control journey uses keyboard selection for the native
  harness, model and effort, creates one fixture identity, then edits it. The
  removed validation cancellation step belongs to the removed validation service;
  lookup cancellation retains lower-layer tests.

These use synthetic credentials/host boundaries and controlled executables.
They do not prove a live account, OS credential storage, runtime restart or relay
reply. Current command results belong in the change report, not inherited from
an earlier implementation snapshot.

## Human acceptance still required

Use disposable identities and a disposable channel without changing global Codex
configuration.

1. In Settings, verify the CLI/adapter status and Install behavior from #724.
2. Create Default. Confirm there is no connection-test step. Verify one identity,
   a signed reply, Stop/Start, app reopen and identity continuity.
3. Create Advanced with a reported model/effort. Verify the same lifecycle; the
   displayed values are requested settings, not observed runtime evidence.
4. Save an execution change on a running agent. Verify the saved revision and
   restart result; a failed Start must leave the identity and retry controls.
5. With an existing managed adapter saved, install a different global adapter.
   Verify the existing agent continues to use its saved path; new selection uses
   global discovery. Removing the saved adapter should fail Start without fallback.
6. Duplicate a Codex agent. Verify the duplicate keeps its settings and gets a
   new identity.
