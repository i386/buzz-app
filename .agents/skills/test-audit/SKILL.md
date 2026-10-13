---
name: test-audit
description: "Invoke whenever writing, changing, reviewing, or sweeping tests in buzz-app. Authoring gate for new tests plus audit workflow for low-value, implementation-coupled, or duplicative tests and the test-only production seams they demand."
---

# Test Audit

Three modes, one value bar. Authoring mode gates every new or changed test at
write time. Audit mode runs focused sweeps of tests that re-assert source,
duplicate stronger proof, couple behavior to implementation, or keep test-only
production seams alive. Continue broad audits as separate coherent follow-up
PRs; optimize for confidence, not deletion count. Campaign mode prunes one
whole subsystem's test surface (every test file one `src/features/*` area,
bundled plugin, host, or crate owns); before starting one, or before taking on
a numeric target such as "remove N% of tests", read [CAMPAIGN.md](CAMPAIGN.md).

## Authoring gate

Before adding any test, answer four questions; a missing answer means do not
add it yet:

1. What observable behavior, invariant, or independent contract does it protect?
2. What credible regression makes it fail?
3. Why does existing coverage not already catch that failure? Each contract has
   one primary test owner at the strongest boundary; another layer needs its
   own distinct risk, such as a transport or lifecycle failure the owner cannot
   reach. Pick the layer from
   [Choosing a test layer](../../../docs/contributing.md#choosing-a-test-layer).
   Prefer extending a table-driven case or shared fixture over a
   near-duplicate test; consolidate duplicated setup in the same change.
4. Does it need a production seam (export, flag, wrapper, injection hook) that no
   production caller needs? If yes, move the test to the real boundary instead.

Then check the test against every [junk pattern](#junk-patterns); a match fails
the gate unless the [retention bar](#retention-bar) names the contract it
independently guards. A test that would break under behavior-preserving
refactoring is asserting implementation, not behavior; rewrite it at the
owning boundary before landing it. The root `AGENTS.md` sections "Choose tests
by behavior" and "Deterministic tests" are part of this gate.

Bug regression tests must fail on the pre-fix code for the intended reason and
pass after the owner-boundary repair. A regression test that never demonstrably
failed proves the mock, not the fix. One regression at the owner boundary
covers the bug; do not replay the same scenario at every layer it crosses.

## Junk patterns

The shared checklist for both modes: the authoring gate rejects a new test that
matches one, and audits hunt for existing tests that do.

- assertion-free coverage probes;
- self-comparisons and identity copiers;
- copied fixtures, inventories, manifests, or export lists;
- exact source, import, or string greps, such as a JS test that regexes Rust
  source for behavior a Rust test could run;
- private predicate or call-shape tests duplicated at real boundaries;
- duplicate invocations of the same contract;
- bundled-plugin or host-local replays of shared `src/features/*` helpers;
- tests whose only purpose is preserving test-only exports, globals, or wrappers;
- dead production code whose only callers are tests;
- expected values produced by the helper or renderer under test;
- mocks that implement the asserted behavior, or one identical mock standing in
  for different APIs;
- mocked React or hook modules, or components called as plain functions,
  instead of React Testing Library over real mounting;
- fixtures that supply the signed admission, relay acknowledgement, or callback
  ordering the owner should produce, or persistence asserted against a store
  the path never writes;
- capability tests that restate declared flags instead of exercising the
  delivery or enforcement the flag promises (least-privilege checks over
  `src-tauri/capabilities/` are a retained contract, not this);
- negative controls that pass for an unrelated reason, such as a denial from a
  different guard or a rejection the production path never reaches;
- names or fixtures that promise more than the input exercises, such as a
  "retires the window" test asserting the window was not cleared;
- browser journeys that replay a state matrix a lower layer owns, or freeze
  cosmetic recipes (exact pixels, colors, durations) instead of paint, hit
  testing, focus, or layout behavior.

## Value bar

Tests justify their maintenance cost by protecting behavior, a credible
regression, or an independently meaningful contract. In an audit, an existing
test that must change for behavior-preserving source reorganization is suspect,
not automatically deletable; the authoring gate still rejects new ones.

Before judging a candidate, read the complete test and production owner, its
entry point, callers, callees, sibling implementations, overlapping tests, CI
routing, and relevant history. Read root and scoped `AGENTS.md` files first,
then `docs/contributing.md` (Test organization, Choosing a test layer, Shared
logic and host boundaries), `docs/browser-testing.md` for browser cases, and
the owning design doc under `docs/`. When the test claims dependency-backed
behavior, inspect the dependency source or types directly.

Files headed `FOUNDATION:` (`git grep -l "FOUNDATION:" -- . ':!docs'`) need
explicit human guidance before editing. Treat tests whose owner is one the same
way: list them as candidates and escalate rather than editing them.

## Discovery

Keep discovery read-only and report evidence before editing. For broad scope,
run parallel discovery lanes when available:

- shared capabilities (`src/features/`, `src/shared/`);
- bundled plugins, plugin runtime, and app shell (`src/bundled/`,
  `src/plugins/`, `src/app/`);
- hosts and crates (`browser-host/`, `src-tauri/`, `crates/`);
- browser journeys, integration, and tooling (`tests/`, `scripts/`);
- a cross-cutting pattern sweep.

Outside campaign mode, prefer a few high-confidence candidates over a large
speculative inventory. Hunt for the [junk patterns](#junk-patterns).

## Retention bar

Keep a test when it independently enforces a public API, plugin API, protocol
(Nostr events, NIP-AB pairing, NIP-PS signing, relay queries), config,
migration, storage, security (signing, Tauri capabilities and command ACLs),
platform, default, generated or cross-language, package, release, or
architecture contract. Also keep:

- call ordering when order is observable behavior;
- regressions with a credible failure mode;
- source inspection when it is the cheapest independent guard: it fails when
  the contract changes (the user-facing key, byte, or path) and survives an
  identifier-only refactor, such as the Tabler-only icon boundary and design
  token registries;
- shared contract cases both hosts consume, and host-side enforcement in
  `src-tauri/` and `browser-host/`: necessary host validation is not
  duplication of frontend checks;
- regression sources a design doc names, such as the shared agent selection
  tests in `docs/agents.md`;
- CI selection contracts: `tests/integration/browser-ci.test.mjs`, the
  measurement and `@local-webkit` cases `docs/browser-testing.md` lists, and
  the only case behind a project tag;
- protocol vectors ported from block/buzz (such as `crates/pairing`); changing
  one diverges from upstream, so escalate it;
- a retained test that fails on the baseline: treat it as a possible product
  bug, reproduce it, and with human agreement repair the owner rather than
  deleting it.

Static or slow is not a deletion reason. A test that resembles implementation
may still be the independent contract; prove otherwise before removing it.

## Candidate evidence

Record every field below before editing. A missing field means the candidate is
not ready for deletion:

- exact test name and location;
- what failure it can actually detect;
- non-test callers of the covered production or support seam;
- stronger remaining owner-boundary proof, or why no proof is needed;
- relevant history and the reason the test or seam exists;
- docs that cite it as coverage (`git grep` `docs/` for the file name and the
  case title);
- production or test-support deletion unlocked;
- risk and the focused validation command.

## Edit shape

Choose one coherent owner-boundary batch. Delete obsolete test-only exports,
globals, wrappers, and dead production paths instead of preserving aliases.
Move retained regressions to their canonical owners. Consolidate repeated
package or dependency assertions into one generic contract. Move browser
permutations, not whole journeys, down a layer. Update docs that cite deleted
tests in the same change.

Prefer net-negative production LOC. Do not add replacement tests that restate
the same implementation, and do not convert uncertain candidates into cleanup
to increase deletion counts.

## Validation

Never edit source or tests while a test runner or hook is running in the
checkout. Use the pinned `bin/` tools and the commands in
`docs/contributing.md` and `docs/browser-testing.md`. Run `just scan` only when
explicitly requested or needed to reproduce a broad integration failure;
hosted CI owns broad validation.

1. Run the smallest owner and sibling tests in every runner and project they
   use: `bin/pnpm exec vitest run <path>`; Playwright with `--no-deps` in both
   engines, and in the tag's own project for tagged cases; `bin/node --test
   <file>`; `bin/cargo test -p <package>` (bare `cargo test` runs only
   `buzzodz-plugins`).
2. For a moved assertion, make one deliberate mutation of the production owner
   and confirm the replacement fails (in both engines for browser cases), then
   restore the source byte for byte.
3. For removed source greps or plan assertions, run the executable script or
   test that owns the real contract.
4. Run `bin/pnpm exec biome check --write --error-on-warnings <paths>` (and
   `bin/cargo fmt` for Rust), then `git diff --check`.
5. Run the changed gate: the lefthook pre-push hook (`scripts/check-push.mjs`).
   Deleting any file under `src/` or `browser-host/`, test files included, makes
   it run the full Vitest suite; report failures that also fail on the baseline
   to the human, and never bypass the hook. After any browser-routing change,
   including moving or deleting a spec or tagged case, also run
   `bin/node --test tests/integration/browser-ci.test.mjs`.
6. Inspect `git diff --numstat`; report production/tooling separately from
   tests and test support.
7. After final audit edits, run an independent agent review under the root
   `AGENTS.md` Reviewing rules, for example with the `code-review` skill.

## Landing and continuation

Commit, push, open a PR, or land only when authorized. Follow the root
`AGENTS.md` worktree, DCO, PR-readiness, and pushing rules. The PR description
maps each removed item to its retained or replacement proof, as PR #410 does.
Land one coherent PR at a time; after landing, refresh from current `main` and
rerun read-only discovery for the next high-confidence batch.

## Handoff

Report:

- root cause and removed low-value categories;
- production owner simplifications;
- retained false positives and why they remain valuable;
- focused and full proof actually run;
- collected test counts per runner, before and after;
- production versus test LOC;
- PR and merge state;
- named follow-ups, including escalated FOUNDATION or upstream-vector tests.
