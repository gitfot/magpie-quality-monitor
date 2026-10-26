# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `gitfot/magpie-quality-monitor`.
Use the `gh` CLI from this repository.

## Conventions

- Create: `gh issue create --title "..." --body "..."`
- Read: `gh issue view <number> --json number,title,body,labels,comments`
- List: `gh issue list --state open --json number,title,body,labels,comments`
- Comment: `gh issue comment <number> --body "..."`
- Add labels: `gh issue edit <number> --add-label "..."`
- Remove labels: `gh issue edit <number> --remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

Use appropriate label and state filters when listing issues.
On Windows, use PowerShell and `--body-file` for multiline bodies.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill operations

When a skill says "publish to the issue tracker", create a GitHub issue.
When a skill says "fetch the relevant ticket", read the GitHub issue.

## Wayfinding operations

- Map: one issue labelled `wayfinder:map`, with Notes,
  Decisions-so-far, and Fog sections.
- Child: link each ticket as a GitHub sub-issue. With gh 2.94+,
  use `gh issue edit <parent> --add-sub-issue <child>`.
  If unavailable, add it to a task list in the map and put
  `Part of #<parent>` at the top of the child body.
- Types: `wayfinder:research`, `wayfinder:prototype`,
  `wayfinder:grilling`, or `wayfinder:task`.
- Blocking: prefer native GitHub issue dependencies. Add an edge with
  `gh api --method POST repos/gitfot/magpie-quality-monitor/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`.
  Obtain the database ID with
  `gh api repos/gitfot/magpie-quality-monitor/issues/<number> --jq .id`.
  If unavailable, record `Blocked by: #<number>` in the child body.
- Frontier: choose the first open child in map order without an
  assignee or open blockers.
- Claim: `gh issue edit <number> --add-assignee "@me"`.
  This is the session's first write.
- Resolve: comment with the result, close the child, and append a
  summary and link to the map's Decisions-so-far.
