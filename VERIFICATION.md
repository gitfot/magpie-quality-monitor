# Verification and Compatibility

This is a portable verification guide, not a transcript of a private installation.
Local test logs, screenshots, runtime capabilities, machine paths and deployment
records are intentionally excluded from the public repository.

## Scope

The standalone extraction preserves the plugin's production TypeScript/JavaScript,
CSS and HTML behavior. Documentation, package metadata and test data are adapted
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

## Standalone Check Record

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
