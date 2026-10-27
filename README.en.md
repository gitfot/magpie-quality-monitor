# Magpie Quality Monitor

[简体中文](README.md) | [English](README.en.md)

**Is your upstream model getting less capable? Keep checking with logic questions.**

Magpie Quality Monitor is a model-capability monitoring plugin embedded in
[Magpie](https://usemagpie.ai/). It uses the native Codex CLI to send fixed logic
questions to your selected upstream model or route on a schedule, checks the
answers automatically, and records correctness rates and original responses.
Spot signs of declining performance without repeatedly writing prompts,
checking answers, and searching through chat history yourself.

It monitors the upstream model or route you use through Codex and Magpie, not
just whether the Codex CLI can launch or an API request succeeds. No Magpie core
modifications or separate provider sign-in are needed.

## Why Use It?

- **Catch changes in familiar questions:** check whether a model that previously
  answered correctly starts making repeated mistakes or becomes inconsistent.
- **Keep watching without manual checks:** schedule questions instead of testing
  only when a model's responses happen to feel worse.
- **Investigate with evidence:** open the original response and configuration
  from a suspicious execution rather than relying on a score or an impression.

## How It Helps You Spot Changes

1. **Repeat logic checks under known conditions.** Select a model or Magpie route,
   set its reasoning effort, and configure logic questions with local expected
   or equivalent answers. The plugin calls Codex CLI for each test; expected
   answers stay local and are not sent to the model. New monitors start paused;
   run a manual check first or enable the default 30-minute schedule.
2. **Distinguish wrong answers from failed requests.** Correctness rates and
   per-question execution heatmaps show changes in results over time. Call
   success is tracked separately: timeouts, rate limits, and truncated responses
   are not counted as wrong answers.
3. **Inspect a suspicious result.** Each execution retains its prompt, original
   response, grading basis, target, and configuration snapshot. Later edits do
   not rewrite history; use the current-configuration filter to avoid mixing
   different test conditions. History is stored locally and can be exported as JSON.
4. **Review different targets or settings.** Create separate monitors for
   different models, routes, or reasoning-effort settings, then review their
   results in the same overview. All monitors share one serial request queue.

### Drawing as a Supplementary Check

You can also ask a text model to generate HTML/CSS/inline SVG and visually compare
its output over time. Safe previews, thumbnails, per-question galleries, elapsed
time, and reported token usage make those comparisons easier. This is not an
image-generation API, and the plugin assigns no aesthetic score or drawing pass rate.

### What the Results Do Not Prove

The plugin helps surface **signs of declining performance**, not certify a
model's intelligence. A small set of fixed questions cannot prove overall
degradation, provider substitution, or service fraud; a single wrong answer is
not enough to draw those conclusions. Caching and optimization for fixed questions
can also affect results. A selected route is not proof of which model answered;
unavailable actual-model information remains unknown.

Changes are visible inside the plugin; there are no desktop, email, or Webhook
alerts. Use repeated results and original responses to decide what to investigate.

## Requirements

| Component | Requirement |
| --- | --- |
| Host | Windows-native Magpie with local-folder plugin support |
| Agent | Windows-native Codex CLI connected through Magpie's **Agents** page |
| Runtime | Bun, supplied by the Magpie plugin host; Node.js is not the runtime |
| Dependencies | Magpie manages GitHub-install dependencies; Node.js/npm is needed for manual source installation and development |
| Thumbnails | Installed Chrome or Edge, or an explicit browser executable path |

The finite CLI adapter was previously exercised with Magpie **0.1.1549** and
Codex CLI **0.162.0**. This is not a promise that every version or connection mode
works. Linux, macOS, WSL Codex, and arbitrary Codex configuration overrides are
not supported compatibility claims. See [verification](VERIFICATION.md).

## Quick Start

### 1. Install from GitHub

In Magpie, open **Plugins → Add plugin** and enter:

```text
github:gitfot/magpie-quality-monitor
```

Magpie downloads the repository and installs its runtime dependencies with Bun;
you do not need to clone the repository or run npm for this installation method.
Enable the plugin after installation. Use Magpie's **Update** action for later
published commits, then reopen the plugin page. A local development change is
not available to GitHub installations until it has been pushed to the repository.

**Keep only one installation of this plugin enabled.** Local-folder and GitHub
copies share the same private history directory and single-owner service. When
switching methods, disable the previous copy before enabling the new one; do not
delete the private history directory. Both copies may remain installed, but they
are not independent monitors or separate data stores.

### 2. Connect Codex and open the monitor

1. On Magpie's **Agents** page, connect the native **Codex** agent. A WSL
   connection or the retired monitor-specific agent is not a substitute.
2. Open **Codex Quality Monitor**. The page displays saved history immediately
   and checks native access/model visibility in the background. While checking,
   the refresh button shows a spinner and cannot be clicked repeatedly.
3. Create a monitor and select a model or route from the Codex-visible catalog.
   Set its reasoning effort and configure logic questions with expected answers.
   New monitors start **paused**. Run a single question manually to check your
   setup, then check the estimated request count before enabling a schedule.

If discovery fails, set the absolute Magpie/Codex executable paths in the plugin's
settings. Enter an executable path, not a command line. A failed catalog refresh
shows the reason and permits manual retry; it does not erase history.

### Alternative: install from a local source folder

Use **Code → Download ZIP** on
[GitHub](https://github.com/gitfot/magpie-quality-monitor), then extract it to a
stable, writable folder outside your development checkout. For example:

```powershell
Set-Location 'C:\Tools\magpie-quality-monitor'
npm.cmd ci --omit=dev --ignore-scripts
```

The source ZIP contains `package-lock.json`. These instructions do not depend on
a published npm package or a prebuilt GitHub release.

**Do not register a development checkout as the long-term installation.** The
host generates `page/index.html` with a local endpoint and a temporary access
capability. That generated file is private runtime material, not publishable
source. A separate installation copy prevents accidentally staging it. Add that
folder's absolute path in Magpie's **Plugins → Add plugin**, then follow step 2
above. Disable any other installation of the same plugin first.

## Fingerprint Consistency (Experimental)

Choose **Fingerprint consistency** when creating a monitor. One compact card
contains multiple model/route rows, each with its own requested reasoning effort,
pinned reference, latest result and batch timeline. There is no card-level score.

- The shared reference library includes seven fixed upstream API datasets and
  accepts hlwy-ai-checker JSON exports (objects or arrays). Source, collection
  time and sample size are visible, not vendor attestations. Imports never
  silently replace bindings; archiving preserves existing references.
- Each model defaults to **50 independent CLI attempts per batch**. Failures,
  tool events and invalid formats consume the budget without retries. A valid
  sample is a successful tool-free CLI turn containing only an integer in 1–355.
- Scoring requires the full attempt budget, at least 40 valid samples and at
  least 80% validity. The score is `100 * (1 - sqrt(JSD_base2))`, over the full
  distribution. Call success, sample validity and distribution match are distinct.
- Each real timeline cell represents one batch. Open it for paired frequency
  bars, statistics, individual outputs and frozen configuration. Unscored,
  interrupted and absent history are not painted as zero scores. Fingerprint and
  logic cards share the same responsive timeline and action components. The
  overview shows the latest N retained batches; time/configuration filters live
  in History and do not change the overview's latest result.
- New cards have scheduling off; enabling defaults to 24 hours after the previous
  round ends, without catch-up or overlap. Disabling scheduling does not stop the
  current round. Stopping affects only this card and cannot guarantee the provider
  stops work or billing. Each sample yields to the shared serial CLI queue.
- Fingerprint batches and their samples are retained together for **30 days** by
  default, independently of existing records. References are retained separately.
  Today's CLI executions count individual sampling attempts, not batches or probes.

This is an **experimental distribution comparison**, not proof of model identity,
mixture ratio or capability. API reference/CLI comparability, natural variation
and real costs have not been empirically validated. Real paid sampling requires
separate authorization of targets, batches and budget. Automated tests use a
simulated CLI and temporary data only. See `NOTICE` and
`src/fingerprint-presets/LICENSE` for the bundled reference data's LGPL notice.

## Behavior and Statistics

| Setting | Default |
| --- | --- |
| Scheduled round | Every 30 minutes; new monitors are paused |
| Request timeout | 300 seconds |
| History retention | 5 days, configurable from 1 to 365 |
| Logic/drawing output request | 8,192 / 16,384 tokens; prompt requests, not hard CLI caps |
| Overview time range | 24 hours, switchable to 7 days within retained history |

- Logic prompts request exactly one `FINAL_ANSWER:` line. The default grader
  normalizes Unicode width, ignores whitespace and trailing periods, and compares
  against locally configured equivalent answers. An opt-in full-text mode is
  less strict and can produce false positives from intermediate reasoning.
- **Call success** uses all actual executions as its denominator. **Answer
  correctness** uses graded correct/incorrect answers. Timeouts, missing answer
  markers, truncation, and call errors remain separate outcomes.
- Each real heatmap cell opens that execution's detail. Resizing changes only
  the visible count; statistics cover the complete selected scope. Downtime does
  not insert cells between executions, and missed rounds are not backfilled.
  Cells run oldest to newest in one adaptive, right-aligned row; gray leading
  cells are spare display capacity, not executions or failures.
- Editing affects future executions, not saved prompts, answers, or verdicts.
  An in-flight request keeps its original snapshot. Pause stops subsequent
  questions; explicit single runs do not enable a paused monitor.
  Manual runs support a whole round or a single question, even a disabled one.
- The plugin does not retry failed requests. Codex/provider retries and Magpie
  route fallback may still increase actual upstream calls and costs.
- Drawing galleries contain complete extractable works, 20 per page. A newer
  failure does not replace the last successful work. Tokens are reported input
  plus output, without double-counting cached/reasoning subtotals; unknown usage
  stays unknown.
- The embedded UI follows Magpie navigation/theme and supports five languages.
  First page load checks Codex access automatically with visible refresh progress.

## Privacy, Safety, and Costs

- Private data lives in `~/.magpie-quality-monitor/`, including questions, full
  responses, configuration snapshots, SQLite files, and ownership metadata.
  **Do not publish this directory, runtime entry pages, or raw exported history.**
- The backend listens only on loopback and checks host/origin and authorization.
  The embedded sandbox's opaque origin is not an authentication bypass.
- Artwork is sanitized and previewed in an empty-permission iframe with a
  restrictive CSP. Thumbnails use a separate headless browser profile with page
  scripts, service workers, and external requests blocked; no browser is downloaded.
- Codex is run ephemerally in an empty directory with a read-only sandbox and
  noninteractive approvals. **This is not a universal no-tools/no-network
  guarantee:** inherited agent/MCP configuration can still affect behavior.
- Prompts are sent to the configured provider through Codex and Magpie. Existing
  enabled monitors can resume normal scheduling after access is restored. Using
  this plugin can consume paid model quota.
- Privacy scans are a publication safeguard, not a complete security audit.
  Review staged changes yourself before making a repository or archive public.

## Architecture

![Architecture: Magpie embeds the monitor UI; a local Bun service checks native access, schedules Codex CLI requests through the Magpie gateway, and stores results in SQLite. A separate safe-preview pipeline produces thumbnails.](docs/architecture.svg)

The model-request path is always:

```text
Magpie plugin host → local Bun service → serial queue → Codex CLI
                     → Magpie gateway → selected provider/model or route
```

The access adapter reads the permitted native Codex configuration and public
`magpie models codex` output. It never changes the user's Codex configuration.
Expected logic answers stay in the local grader, not in model prompts. Drawing
extraction and a separate bounded screenshot queue do not occupy the model queue.
SQLite stores monitor configuration, immutable executions, events, and derived
thumbnail caches. The UI talks to a capability-authenticated loopback API.

The entry point resolves each enabled installation spec to its actual directory
before starting the service. For Git sources, it uses the host's
`plugins/package.json` dependency mapping rather than treating `github:` as a
filesystem path. Disabling/removing a copy or changing its options invalidates
that copy's activity check; an unrelated enabled copy cannot substitute for it.

## Development

Keep this checkout separate from the folder registered in Magpie:

```powershell
git clone https://github.com/gitfot/magpie-quality-monitor.git
Set-Location magpie-quality-monitor
npm.cmd ci --ignore-scripts

# Only needed if Bun is not on PATH; use your own installed executable.
$env:MAGPIE_BUN = 'C:\Tools\bun\bun.exe'
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test -- --timeout 60000
npm.cmd run check:privacy:selftest
npm.cmd run check:privacy
```

`npm.cmd run test:fingerprint` runs the fingerprint API and embedded UI suite.
The mock preview includes the compact fingerprint card and first prepares 50
simulated CLI attempts to populate genuine service records, without paid calls.

Use `npm.cmd run preview` for a clearly marked local mock preview. It does not
connect to the daily installation or paid providers. The preview URL includes
a temporary capability: do not share it or commit `.test-artifacts`.

Ordinary tests use temporary configuration directories and local mock services.
UI tests need an installed Chrome (`MAGPIE_BROWSER_CHANNEL=msedge` selects Edge).
`npm.cmd run test:ui` runs the UI group. The code-authored SVG fixtures are
synthetic; they do not contain a user's original artwork or provider catalog.

Optional native checks require both `MAGPIE_BINARY` and `MAGPIE_CODEX_BINARY` as
absolute executable paths; see [verification](VERIFICATION.md). Never aim a test
at live credentials or use a daily configuration directory as a fixture.

### Before committing or publishing

```powershell
git add -- .
npm.cmd run check:privacy -- --staged
git diff --cached --check
git diff --cached
```

The scanner reads actual staged blobs in staged mode, reports locations/rule
names without matched values, and rejects generated capability-bearing entry
pages. A Git ignore rule does not protect an already tracked file. If a genuine
secret was exposed, removing it from the latest file is insufficient: revoke or
rotate it and address any public Git history separately. Use a public author
identity such as a GitHub noreply email for open-source commits.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Access/catalog not available | Connect native Codex on Magpie's Agents page; check executable paths and the displayed reason; retry the catalog |
| GitHub copy stays on the startup page | Update to a revision with GitHub-install activation support, reopen it, and check that another installation is not enabled |
| Page authorization expired | Reopen the plugin from Magpie rather than reusing an old local URL |
| Blank or missing thumbnail | Install Chrome/Edge or set its executable path; open the isolated original preview or explicitly retry the screenshot |
| A long animation is still faint | Thumbnail capture waits a bounded interval, not for arbitrary animation completion |
| History differs after editing | Check the configuration filter and immutable execution snapshot; old answers are not regraded |
| Nothing runs while paused | Enable scheduling or choose an explicit single/whole-round run; never bypass an access warning |

Report reproducible issues through [GitHub Issues](https://github.com/gitfot/magpie-quality-monitor/issues).
Remove tokens, prompts/responses you cannot share, local paths, and private
configuration from reports. Include versions and a minimal synthetic example.

## License and Attribution

[MIT](LICENSE). This standalone plugin was extracted from the MIT-licensed
Magpie development tree; the upstream copyright notice is retained. See
[NOTICE](NOTICE) for provenance and the synthetic-fixture policy. This is an
independent plugin, not a claim of official support from Magpie or OpenAI.
