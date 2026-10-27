# Verification and Compatibility

This is a portable verification guide, not a transcript of a private installation.
Local test logs, screenshots, runtime capabilities, machine paths and deployment
records are intentionally excluded from the public repository.

## Scope

The initial standalone extraction preserved the plugin's production TypeScript/JavaScript,
CSS and HTML behavior. Later entry-point repairs are recorded separately below.
Documentation, package metadata and test data are adapted
for public distribution. Catalog identifiers are invented. The geometric SVG and
entry-animation fixtures are repository-authored substitutes for private examples;
the tests retain structural, pixel-comparison, animation and safety assertions.

The predecessor was exercised on Windows with Magpie 0.1.1549, Codex CLI 0.162.0,
Bun 1.4.3, Node.js 24 and npm 11.8.0. This describes previous finite compatibility
evidence, not a guarantee about all versions or a claim that standalone native
acceptance has already been repeated. Other operating systems/WSL and real-vendor
quality/cost checks are outside this verification scope.

## Reproduce the Checks

From a development checkout, not the daily installation:

```powershell
npm.cmd ci --ignore-scripts
# Optional if bun is already on PATH. Replace this example with your own path.
$env:MAGPIE_BUN = 'C:\Tools\bun\bun.exe'
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test -- --timeout 60000
npm.cmd run check:privacy:selftest
npm.cmd run check:privacy
```

UI tests use installed Chrome by default; set `MAGPIE_BROWSER_CHANNEL=msedge` to
use installed Edge. No browser download or daily browser profile is required.
Ordinary execution fixtures use temporary state and loopback mock services. Tests
must not read vendor credentials, operate the live gateway, or mutate daily
Codex/Magpie configuration. Artifacts under `.test-artifacts/` remain private.

## Optional Installed-Binary Integration

```powershell
$env:MAGPIE_BINARY = 'C:\Tools\Magpie\magpie.exe'
$env:MAGPIE_CODEX_BINARY = 'C:\Tools\Codex\codex.exe'
npm.cmd run test:integration
```

Both paths must name existing installed executables. The harness creates an
isolated HOME/configuration, local mock provider and separate ports; it must never
copy a daily user's credentials. Missing binary variables mean an explicit skip,
not native acceptance. The real CLI talks only to the test gateway/provider.

For observed desktop checks, set `MAGPIE_NATIVE=manual` and a bounded
`MAGPIE_NATIVE_TIMEOUT_SECONDS` (maximum 1200) before the integration command.
Inspect the actual isolated WebView2 window, execute the test card's whole round
once, and only then create `.test-artifacts/native-verified`. Never create the
marker merely to get a green result. The harness disconnects temporary Codex,
retires the host, closes its GUI and applies guarded temporary-directory cleanup.

## Publication Gate

Run `npm.cmd run check:privacy` against the working tree, then stage the intended
files and run `npm.cmd run check:privacy -- --staged`. Staged mode reads Git blobs,
not potentially different working copies. The scanner reports only rule names and
locations, and checks recognizable key formats, private-key headers, JWT-shaped
strings, embedded URL credentials, personal paths/emails, private IPs, credential
literals, sensitive filenames and generated runtime entry pages.

Review any finding rather than printing its value into a public log. Fixed mock
credentials in tests are not live credentials, but tests are not categorically
exempt from scanning. Also inspect Git authorship, included fixtures, dependency
URLs and archive/package contents. This heuristic gate does not prove the absence
of encoded, novel or otherwise unrecognized secrets and is not a security audit.

`page/index.html` must remain a harmless startup placeholder in source control.
An installed plugin replaces it with a private local capability. Ignore patterns
cannot protect a tracked file: use a separate installation directory and inspect
the actual staged entry before every public commit.

## Initial Standalone Check Record

Checked on Windows on 2026-10-26 with Bun 1.4.3, Node.js 24.13.1, npm 11.8.0
and installed headless Chrome:

| Check | Result |
| --- | --- |
| Fresh locked install, lifecycle scripts disabled | Passed |
| TypeScript typecheck and Prettier lint | Passed |
| Full isolated suite | 96 passed, 2 skipped, 0 failed; 3,935 assertions across 18 files |
| Privacy-scanner self-tests | 15 passed |
| Working-tree and staged-blob privacy scans | 60 files each, no configured-rule findings |
| Runtime-source comparison | All 19 production source/page/UI files match the extraction source |
| Dependency-lock comparison | All 47 package entries retain versions, integrity and dependency relationships; resolved tarball URLs use the official npm registry |
| Architecture and local documentation links | SVG rendered and visually inspected; no clipped labels or missing local targets |
| Package dry-run, without publication | 26 expected entries; no tests, private state, dependencies or test artifacts bundled |
| Public Git identity | Repository-local public username and GitHub noreply email; no predecessor history imported |

The synthetic-artwork replacement initially exposed a fixture-only mismatch:
its shadow used an SVG primitive outside the existing sanitizer allowlist.
The fixture now uses already-supported primitives. The original exact rendered
pixel-comparison assertion still passes; neither the sanitizer permissions nor
the production renderer were changed to accommodate the replacement artwork.

The two optional installed-binary tests were explicitly skipped because their
opt-in executable variables were not supplied. Native Magpie desktop acceptance,
real-provider calls, real model quality/cost comparisons and non-Windows support
were **not** reverified in this standalone extraction. No daily plugin or Codex
configuration was registered, replaced or restarted for these checks. Private
logs and screenshots are excluded from the public repository.

## GitHub Installation Activation Repair

The original entry point recognized a package name or local path but treated
`github:owner/repository` as a filesystem path. It returned without starting the
service, so the packaged startup placeholder was never replaced. This is a plugin
entry-point issue, not missing dependencies or evidence that two installed copies
are required to reproduce the failure.

`src/installation.ts` now resolves Git specs through Bun's dependency mapping in
the host's `plugins/package.json`, then compares the actual installed directory
with the executing copy. Local folders, file URLs and registry package specs use
the same identity check. Missing mappings, unreadable configuration, disabled or
removed entries and changed options do not activate an unrelated copy.

The regression command is:

```powershell
npm.cmd test -- tests/installation.test.ts --timeout 20000
```

Before the repair, its real-entry test failed because the generated startup
redirect was absent. After the repair, all 11 installation tests pass, including
an isolated HOME with a GitHub-style dependency binding, a disposable installed
plugin copy, the unmocked production entry and service, a generated page redirect,
and an authenticated API response. These checks neither download from GitHub nor
read a daily account/configuration. No model execution or paid provider is used.

Activation tests cover tagged GitHub specs, repository URLs, shorthand, other Git
URLs, package names/versions, local paths, file URLs and multiple installed copies'
separate enablement. This does not add simultaneous independent service support:
all installations still share one local history directory and one service owner.
Keep only one installation enabled when switching between local and GitHub copies.

The fix has not been deployed to a daily installation, and the published GitHub
download/update path and native desktop have not been re-exercised by these tests.

Repair verification on Windows on 2026-10-26:

| Check | Result |
| --- | --- |
| Real-entry reproduction before the production fix | Failed: the startup placeholder was not replaced |
| Installation regressions after the fix | 11 passed, 0 failed |
| TypeScript typecheck and Prettier lint | Passed |
| Final full isolated suite | 107 passed, 2 optional installed-binary skips, 0 failed; 3,968 assertions across 19 files |
| Privacy-scanner self-tests | 15 passed |
| Intended-source privacy scan | 63 files, no configured-rule findings; unrelated untracked IDE settings excluded |
| Local documentation links and diff whitespace | Passed |
| Package dry-run | 27 entries; installation helper included; no tests, test artifacts or IDE configuration bundled |

The first full repair run completed the screenshot-deletion assertions but failed
in fixture teardown with Windows `EBUSY` while removing an empty temporary
directory. The shared test fixture now uses at most five filesystem removal
retries after awaiting resource shutdown. No production renderer or test assertion
was relaxed. The focused screenshot-deletion test and the subsequent complete
suite both pass; persistent cleanup errors still fail the test.

## Execution Feedback and Catalog Separation

The model catalog is now selection metadata, not execution authorization.
Manual runs, enablement, scheduled rounds and queue draining never launch or wait
for the Magpie catalog CLI. Existing targets can continue running and be edited
after removal from the catalog; creating a monitor or changing its target still
requires selection from the loaded catalog, without a synchronous refresh.

Native access checks read local Codex configuration independently of catalog
loading. They retain supported-home, provider, protocol and configuration-override
checks, but trust the local Magpie provider declaration. They no longer compare
the configured gateway address with CLI catalog output or require model IDs to
appear in that output. This does not independently prove gateway identity.
Unsupported local access still blocks new executions; it is not recorded as a
model call failure. Actual Codex call failures remain ungraded failed samples;
they do not disable the monitor or add plugin-level retries.

Card actions display a pending state and prevent duplicate submissions before
the API responds. A successful mutation requests a fresh state read after any
older poll rather than dropping the refresh and waiting for the next interval.
Failure restores the controls and reports the error without claiming success.

Isolated regressions cover cold-start execution without a catalog, a stalled
catalog subprocess, removed targets, malformed catalogs, repeated scheduled
model failures, local disconnects, pending and failed card actions, and an older
poll racing a successful mutation. The browser race test pauses the polling
clock, so the UI must update without another five-second interval.
These tests use temporary configuration and mock CLIs only; they do not deploy
the changes, alter daily configuration or make real-provider calls.

Verification on Windows on 2026-10-27: typecheck and formatting passed; the full
isolated suite passed 115 tests with 2 optional installed-binary tests skipped,
0 failures and 4,049 assertions across 19 files. Privacy-scanner self-tests passed
all 15 checks, and the working-tree scan reported no configured-rule findings.

## Reconnection After Plugin Updates

The generated plugin entry now loads a packaged external launcher, which is
allowed by Magpie's existing page CSP. It preserves the stable plugin entry in
the runtime URL fragment, together with the per-start UI capability, and the
runtime immediately removes that fragment from its visible URL. No capability
is placed in query strings, browser storage or parent messages.
Reconnects use a credential-free cache-busting query so same-second entry rewrites
cannot be mistaken for an unchanged `Last-Modified` response.

The runtime accepts a return entry only after a hello response from its actual
parent. HTTP(S) entries must match that parent's origin and the plugin-entry
path; native Wails entries are restricted to `wails.localhost`. Other paths,
credentials, query strings and fragments are rejected. The host sandbox, CSP,
API authorization and per-start capability rotation remain unchanged.

Two consecutive transport, timeout, authorization or service-unavailable failures
can reopen the stable entry automatically. State requests have a five-second
timeout. Automatic navigation waits while a dialog or mutation is open, and is
limited to two entry reloads without a successful state read. A single transient
failure can recover in place. The reconnect button returns directly to the entry
instead of sending the host an error; direct preview/legacy launches without a
verified entry retry state in place.

Browser regressions exercise the generated entry and packaged launcher under a
scripts-only sandbox and a restrictive host CSP. They cover changed ports,
rotated capabilities on the same port, automatic recovery, preserved monitor
configuration and unsaved input, transient failures, direct-launch fallback,
untrusted return addresses and bounded retries. The real plugin-entry installation
test also checks that the launcher is referenced. Fixtures use temporary state
and mock CLIs only, with no paid-provider calls or changes to daily installations.

An already-open page from a version predating this fix still has the old reconnect
handler. Reopen it once through Magpie's Retry or reload the window to load the new
launcher and runtime. Subsequent updates can then use the stable return entry.

Verification on Windows on 2026-10-27: the new-port reconnect regression failed
before the production fix, then all seven reconnection regressions passed. The
final full isolated suite passed 122 tests with 2 optional installed-binary skips,
0 failures and 4,082 assertions across 20 files. Typecheck, formatting, all 15
privacy-scanner self-tests, the 70-file working-tree privacy scan and diff
whitespace checks passed. Package dry-run lists 28 files including the launcher,
with no tests or runtime state bundled. The first restricted suite run could not
complete native Windows process and screenshot checks; the final suite ran with
the required process permissions and passed those checks without weakening their
assertions. Native desktop acceptance and the published GitHub update path were
not re-run, and the fix was not deployed to the daily installation.
