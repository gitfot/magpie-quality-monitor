# Magpie Quality Monitor

[English](README.md) | [简体中文](README.zh-CN.md)

**Repeatable questions. Inspectable answers. Local history.**

A local [Magpie](https://usemagpie.ai/) plugin that runs fixed logic questions
and HTML/SVG drawing prompts through the native Codex CLI. Compare individual
executions, review the original answers, and keep the configuration that produced
each result. No Magpie core modifications or separate provider sign-in are needed.

> A small set of fixed questions is an observation tool, not proof of model
> degradation, provider substitution, or overall model quality. Drawing outputs
> are presented for human comparison, not assigned an automatic quality score.

## What You Get

- **Logic checks:** local expected/equivalent answers, explicit final-answer
  extraction, separate call-success and answer-correctness statistics.
- **Drawing history:** safe HTML/CSS/inline-SVG previews, static thumbnails,
  per-question galleries, elapsed time, and reported token usage.
- **Scheduled or manual runs:** multiple monitors, one serial execution queue,
  pause/resume, whole rounds, and explicit single runs of disabled questions.
- **An execution heatmap:** one right-aligned row of adaptive square cells,
  oldest to newest; gray leading cells mean spare display capacity, not failures.
- **Auditable history:** immutable configuration snapshots, cross-configuration
  statistics, optional current-configuration filtering, and read-only details.
- **Native integration:** Magpie navigation/theme and five UI languages; first
  page load checks Codex access automatically, with visible refresh progress.

## Requirements

| Component | Requirement |
| --- | --- |
| Host | Windows-native Magpie with local-folder plugin support |
| Agent | Windows-native Codex CLI connected through Magpie's **Agents** page |
| Runtime | Bun, supplied by the Magpie plugin host; Node.js is not the runtime |
| Dependencies | Node.js/npm to install the locked JavaScript dependencies |
| Thumbnails | Installed Chrome or Edge, or an explicit browser executable path |

The finite CLI adapter was previously exercised with Magpie **0.1.1549** and
Codex CLI **0.162.0**. This is not a promise that every version or connection mode
works. Linux, macOS, WSL Codex, and arbitrary Codex configuration overrides are
not supported compatibility claims. See [verification](VERIFICATION.md).

## Quick Start

### 1. Prepare a stable installation folder

After this repository is published, use **Code → Download ZIP** on
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
source. A separate installation copy prevents accidentally staging it.

### 2. Connect and enable the plugin

1. In Magpie, open **Plugins → Add plugin**, enter the installation folder's
   absolute path, and enable it.
2. On Magpie's **Agents** page, connect the native **Codex** agent. A WSL
   connection or the retired monitor-specific agent is not a substitute.
3. Open **Codex Quality Monitor**. The page displays saved history immediately
   and checks native access/model visibility in the background. While checking,
   the refresh button shows a spinner and cannot be clicked repeatedly.
4. Create a monitor and select a model or route from the Codex-visible catalog.
   New monitors start **paused**. Check the estimated request count before
   enabling a schedule, or run a single question manually.

If discovery fails, set the absolute Magpie/Codex executable paths in the plugin's
settings. Enter an executable path, not a command line. A failed catalog refresh
shows the reason and permits manual retry; it does not erase history.

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
- Editing affects future executions, not saved prompts, answers, or verdicts.
  An in-flight request keeps its original snapshot. Pause stops subsequent
  questions; explicit single runs do not enable a paused monitor.
- The plugin does not retry failed requests. Codex/provider retries and Magpie
  route fallback may still increase actual upstream calls and costs.
- Drawing galleries contain complete extractable works, 20 per page. A newer
  failure does not replace the last successful work. Tokens are reported input
  plus output, without double-counting cached/reasoning subtotals; unknown usage
  stays unknown.

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
