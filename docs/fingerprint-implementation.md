# Fingerprint consistency V1

Authority: https://github.com/gitfot/magpie-quality-monitor/issues/1

## Confirmed design

The maintainer selected variant A (native compact cards) on 2026-10-27.
The three-variant throwaway prototype is preserved on local branch
`codex/prototype-fingerprint`, commit `2c533e6`. It is not part of this
implementation branch and has not been pushed. The authoritative specification
is Issue #1; `docs/specs/fingerprint-consistency-v1.md` mirrors the confirmed
requirements, including the subsequent UI revisions.

After reviewing the implementation, the maintainer confirmed these UI revisions:

- Both card types use shared timeline rendering, resize observation, solid empty
  cells, configuration markers, count/time footers, action bars and run buttons.
  Only data adapters, state colors and type-specific execution behavior differ.
- Fingerprint overview cards omit the budget/duration/filter bar. They show the
  latest N retained batches without time/configuration filtering. Those filters
  move to History, while budget and duration remain in editing/details.
- Paused card headers share the status label Paused and the action labels Enable
  and History. This is display wording only, not a change to execution semantics.
- Overview rows omit the fixed-reference name/version explanation; editing and
  batch details retain the binding. The maintainer's final palette uses red at
  75%/50%/25% for the first three bands and the existing correct-cell green at
  70%/100% for the last two, mixed with the card background. Numeric boundaries
  and scoring rules are unchanged. Timeline cells and legend share the palette.
- Existing global statistics filters remain unchanged. Legacy Pause monitoring
  still finishes the current call and cancels remaining tests; fingerprint Turn
  off scheduling still lets the round finish. Stop round remains separate.

The implementation retains the real overview, theme tokens, modal focus and
language handling. Each fingerprint row has its own batch timeline; chart and
sample output are loaded only in read-only details. No average or identity rank
is introduced. The prototype itself is not promoted to production.

## Boundaries

- Existing objects and records retain their representation and behavior.
- Fingerprint objects, batches, samples and references have independent IDs.
  References are content-addressed and immutable except for archival status.
- One existing Engine worker runs all CLI work. Fingerprint rounds queue a
  continuation after every sample and retain frozen rows/settings throughout.
- Batch and sample writes are transactional. Deletion checks prevent late
  results from recreating removed objects. Unfinished batches become interrupted
  on startup. Completed batches and samples expire together, never references.
- `state` includes compact batch summaries, not distributions or raw outputs.
  Detail, sample-page, import and archive routes use the existing capability,
  Host and Origin checks. No new credentials or execution backend are added.
- Bundled data are the seven unmodified files at upstream revision
  `7bddead107da09ddec459522df4b74eb0c7f8ac6`, with the LGPL text and source retained.
  The generated collection adds provenance metadata, not vendor certification.
- A score compares observed distributions using base-2 JS distance. Minimum
  sample rules and color intervals are product conventions, not confidence levels.

## Verification boundary

Use `npm.cmd run test:fingerprint` for service/API and embedded browser tests.
All executions in that suite are simulated. No real model, daily account config
or paid provider is used. Real CLI usability, repeated-batch fluctuation,
reference comparability and cost remain a separately authorized manual gate.

### Automated result (2026-10-27)

- Full Windows-native regression: 138 passed, 2 skipped, 0 failed across 22 test
  files (140 tests, 4,378 assertions). Both skipped cases are explicit real
  Codex/Magpie gates; no real model sampling was authorized or performed.
- `npm.cmd run typecheck`, `npm.cmd run lint`, `git diff --check`, privacy scanner
  self-tests and the working-tree privacy scan pass (zero configured findings).
- `npm.cmd pack --dry-run --json` includes all seven original reference files,
  their LGPL license, the generated reference collection and the production UI;
  no prototype files are included. This is a local dry run, not publication.
- Browser coverage includes scripts-only iframe saving, catalog cold start and
  draft preservation, 390px layout, host theme/language changes, immutable
  configuration filtering, unscored details, 355-bin chart display and escaped
  malicious import text. Tests and previews use the actual monitor service with
  temporary SQLite storage and a simulated CLI.

### Shared UI revision verification (2026-10-27)

- All 45 embedded UI cases pass in the full regression, including the new
  cross-type component case. It checks equal 18px cells, solid placeholders,
  responsive capacity at 360/390/940/1280px, configuration markers without
  overflow, history pagination and filters that leave the overview unchanged.
- The fingerprint API/UI suite passes all 17 cases. Typecheck, Prettier, diff
  whitespace checks and privacy checks pass. The package dry run includes
  `ui/components.js`; nothing was published.
- The full default-timeout command reports 138 passed, 2 manual gates skipped
  and 1 timeout. The existing 21-execution gallery case exceeds Bun's default
  5-second limit on this Windows run. Rerunning it with
  `npm.cmd test -- tests/behavior.test.ts --test-name-pattern gallery --timeout 30000`
  passes in 9.3 seconds without changing that test or production behavior.
- Desktop and narrow-screen screenshots use the real overview with local mock
  data. At this verification checkpoint no real model calls, commits, pushes or
  issue updates had been performed.

### Final commit verification (2026-10-27)

- `npm.cmd test -- --timeout 30000`: 139 passed, 2 skipped, 0 failed across
  22 files (141 tests, 4,570 assertions). The two skipped cases remain the
  separately authorized real Codex/Magpie gates; no paid calls were made.
- The final palette is the maintainer's red 75%/50%/25% and correct-cell
  70%/100% selection. Browser assertions independently check the mixed RGB
  values in light/dark themes and equality between timeline and legend.
- Typecheck, full Prettier lint, whitespace checks, privacy scanner self-tests
  and the staged privacy scan pass. The package dry run contains 43 files,
  including the shared components, seven original references and their license;
  no prototype files are packaged and no package is published.
- Issue #1's body has been updated and verified against the versioned spec
  snapshot. Previously untracked research notes are excluded from this commit.
