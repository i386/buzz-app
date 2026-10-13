# Test-pruning campaign

Campaign mode prunes one subsystem's whole test surface in one PR: a
`src/features/*` area such as `relay`, a bundled plugin, a host, or a crate.
The value bar, retention bar, candidate evidence, and validation in
[SKILL.md](SKILL.md) apply to every lane. This file adds the order of work and
the lessons of a full campaign. Each step ends on its completion criterion; do
not start the next step early.

## Numeric goals

Read a goal such as "remove 20% of the least useful tests while keeping
coverage within 2%" this way:

- **Evidence still decides each deletion.** The percentage is a ceiling, not a
  quota. When high-confidence candidates run out, stop and report the achieved
  number and the unproven remainder. Never lower the bar to reach the number.
- **Coverage is an alarm, not a justification.** `docs/contributing.md` says
  regression coverage is "about behavior, not test counts or a coverage
  percentage". A drop demands an explanation; holding steady proves nothing.
- **The goal is a series of campaigns,** one subsystem per PR.

Before the baseline, confirm with the human what the goal leaves open:

- which runners are in scope;
- whether the coverage budget is percentage points or relative;
- whether it applies to lines, branches, or both.

**Counting:**

- Count collected cases per runner (`it.each` rows count) with
  `bin/pnpm exec vitest list --json=<file>`, `bin/pnpm test:browser --list`,
  and `bin/cargo test --workspace -- --list` (local platform only).
- A consolidated test counts as removed only when its keeper already made the
  same assertion.
- Merging distinct tests, collapsing rows into a weaker assertion, deleting
  failure or security paths, skipping tests, or moving them out of CI do not
  count as removals.

**Coverage measures only Vitest.** No coverage tool is installed. Measure in a
throwaway worktree (bootstrapped with `scripts/bootstrap-worktree.sh`) checked
out at the commit being measured, and never commit the dependency:

```sh
bin/pnpm add -D @vitest/coverage-v8@<installed vitest version>
bin/pnpm exec vitest run --coverage.enabled --coverage.provider=v8 \
  --coverage.reportOnFailure \
  --coverage.include='src/**' --coverage.include='browser-host/**' \
  --coverage.exclude='**/*testing.ts' --coverage.exclude='**/test-*.ts' \
  --coverage.exclude='**/*fixture*' --coverage.exclude='**/*.journey.mjs' \
  --coverage.reporter=json --coverage.reporter=json-summary \
  --coverage.reporter=text-summary \
  --coverage.reportsDirectory=<scratch dir>
```

- Without `reportOnFailure`, any baseline failure suppresses the report.
  Instrumented runs are slower and can flake. Compare runs with the same set
  of failures.
- The excludes keep test-support builders out of the total. Use the same
  include and exclude list for every run.
- Measure each PR at its merge base and its head, and charge that delta
  against one budget for the whole goal. `main` moves between PRs, so a fixed
  baseline mixes in other changes.
- Use `coverage-summary.json` only for the aggregate budget; per-file totals
  hide losses that gains elsewhere in the same file offset. Find newly
  uncovered code in `coverage-final.json`: each statement and branch with a
  nonzero hit count at the merge base and zero at the head. Match locations
  directly in source files the PR leaves unchanged, and through the PR's diff
  in files it edits. Newly uncovered code means no remaining Vitest test
  executes it. Each such statement or branch needs one of three explanations:
  - it carries no contract;
  - it is dead code, deleted in the same PR;
  - a named browser or Rust test covers it.

  List deleted production files separately; they leave the report rather than
  showing a drop.
- Playwright, `node --test`, and Rust deletions never move the number. Vitest
  tests under `scripts/` and `tests/fixtures/design-system/` move it only
  partly. Their deletions rest on the ledger and preservation review alone.

An explicit form of the goal:

> Using the test-audit skill, remove up to 20% of Vitest cases that fail its
> value bar, one subsystem campaign per PR. Line and branch coverage may drop
> by at most 2 points in total across the PRs, and every newly uncovered line
> needs an explanation. Stop and report if high-confidence candidates run out.

## 1. Baseline

Record the following at a pinned `main` SHA:

- the subsystem's test and support line counts;
- every test file's pass/fail state;
- the collected case count for each runner;
- coverage, for a numeric goal.

Keep baseline failures in their own list: in one earlier campaign, all of them
were real product bugs, not stale tests.

Done when every in-scope test file has a recorded baseline result.

## 2. Lanes and inventory

Split the surface into **lanes** along production owner boundaries, not file
prefixes. For `src/features/relay` these might be:

- session and transport;
- queries and live state;
- read state and unread;
- outbox;
- persistence;
- signed admission;
- the `browser-host` broker;
- the `src-tauri` native relay;
- browser journeys.

Include the subsystem's cases at shared core boundaries, and its
`tests/browser/` and `tests/integration/` cases.

Done when every test file and browser journey the subsystem owns belongs to
exactly one lane.

## 3. Read-only ledger per lane

Give each lane to its own read-only agent. The agent reads every assigned test
in full, including parameter tables. It also reads the production owners and
their entry points, callers, history, and CI routing. Each test declaration
goes into a written **ledger** with one mark. An `it.each` is one declaration
unless its rows need different marks; then mark each row.

- `R`: retain, naming the contract and the bug it catches; a retained test that
  only moves to a better-named file stays `R` with the move noted;
- `F`: retain the contract but repair the assertion, such as a vacuous negative
  that passes when only one of several items is missing;
- `C`: consolidate, naming the owner that absorbs the assertion first: a sibling
  table case, a stronger boundary suite, or the shared owner in another package;
- `D`: delete, naming the proof that remains, or why no contract exists;
- `E`: escalate a FOUNDATION-owned test or an upstream protocol vector to the
  human, unchanged.

Judge a test by its assertions, not its name. One test named for retiring a
progress window asserted the window was _not_ cleared.

Done when every declaration in the lane has a mark and an evidence line.

## 4. Layer plan per lane

Treat the per-test ledger as input, not as the edit list. A second read-only
pass, starting from the ledger, looks for the redundant **layer**. In buzz-app
that is often a browser journey replaying a state matrix Vitest already owns,
or hook-mocked component tests restating a service suite with real
collaborators. Name the **keeper** suite for each contract. Prefer the real
transport boundary over a mocked collaborator. In buzz-app that means a
scripted transport, the archive relay in `src/features/relay/testing.ts`, or a
real broker. Correct any ledger errors this pass finds.

Done when each lane plan names its retired files, its keeper per contract, the
assertions to carry into keepers, and the test-only production seams unlocked.

## 5. Cutover

Edit lane by lane. Serialize changes to shared harnesses and support files
(`tests/browser/fixture.mjs`, `src/features/relay/testing.ts`, feature
`*-testing.ts` builders) through one owner. With each lane, remove the
test-only production seams it unlocks: injection parameters, getters, reset
exports, and indirection layers.

Keep moved suites routed in each of these places:

- the `vitest.config.ts` includes;
- the explicit extras in `scripts/check-push.mjs`;
- `measurementFiles` in `tests/browser/playwright.config.mjs`;
- the tag filters in `tests/browser/playwright.ci.config.mjs`;
- the selections outside the engine shards: the `chromium-classic-scrollbars`
  project (`@classic-scrollbars`) and the macOS WebKit `media_recorder` job
  (`@media-recorder`) in `.github/workflows/ci.yml`;
- the CI shards, whose counts `docs/` repeats.

After any browser-routing change, including moving or deleting a spec or a
tagged case, run `bin/node --test tests/integration/browser-ci.test.mjs`.
Passing engine shards do not prove these separate selections still run.

Update every `docs/` page that cites deleted coverage; #783 left
`docs/channels.md` and `docs/browser-testing.md` describing tests that no
longer existed. Put durable test-ownership rules in the subsystem's scoped
`AGENTS.md`, drawn from mistakes this campaign actually found.

Done when every lane plan is applied and each lane's keepers pass.

## 6. Preservation review

Before claiming completion, have independent reviewers compare deleted
coverage against the keepers, one reviewer per boundary group. They look for
contracts that lost their only proof. They also look for new assertions that
cannot fail, such as a rejection row the production code never reaches. One
such review found nine real gaps and one unreachable assertion; in buzz-app,
#370 found two tests that passed with their named behavior broken.

For each restored contract, make one deliberate **mutation** of the production
owner and confirm the keeper goes red, in both engines for browser keepers.
Then restore the source byte for byte.

Done when every reported gap is restored or rejected with source evidence, and
every restored contract has a caught mutation.

## 7. Product defects

A baseline failure that survives into a keeper is a bug report. With human
agreement, fix it at its owner as a separate commit, and prove it through the
real user flow, with a **control** run that reverts the fix and shows the old
behavior. Otherwise record it as a follow-up. Record unrelated product
discrepancies you find as follow-ups instead of fixing them in the campaign.

Done when each repaired defect has a failing control and a passing candidate
on the same harness.

## 8. Reconcile and hand off

Campaigns outlive many `main` commits. Merge `main` rather than rebasing a
long, many-commit campaign, then re-audit every commit for `Signed-off-by`.

When `main` modified a file the campaign deleted, keep the deletion. Port the
new contract into the keeper instead, and confirm every new regression `main`
added still has a home.

On the merged head, rerun the whole subsystem suite and its browser keepers in
both engines. For a numeric goal, also remeasure the merge-base and head
deltas.

Expect review tooling to see a truncated file list on a diff this large.
Record maintainer decisions that override a gate or the root `AGENTS.md` in
the PR evidence, as #783 did, rather than editing the gate.

Hand off with the [SKILL.md](SKILL.md) report, plus:

- baseline and final test/support line counts, with production counted separately;
- for a numeric goal, per-PR and running case and coverage deltas;
- lanes, retired layers, and keepers;
- preservation gaps found and their mutations;
- product defects with control and candidate proof.
