# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## Project board

A GitHub Projects v2 board, user-owned by `vitaly4uk`, linked to this repo
(`gh project list --owner vitaly4uk`). **Triage labels and assignment are the
source of truth; the board's Status column is derived from them, never the
other way round** — to move a card, edit the issue's labels/assignee, not the
board. `.github/workflows/project-sync.yml` mirrors every `issues` event onto
the board's Status field via the GraphQL API:

| Status column      | Derived from                                          |
| ------------------- | ------------------------------------------------------ |
| `Needs triage`      | default — none of the rows below match                 |
| `Needs info`        | label `needs-info`                                     |
| `Ready for agent`   | label `ready-for-agent`                                |
| `Ready for human`   | label `ready-for-human`                                |
| `In progress`       | open and has at least one assignee (outranks the `ready-*` labels) |
| `Done`              | closed (any reason other than not-planned)              |
| `Won't fix`         | label `wontfix`, or closed with reason not-planned      |

Two things only exist in the board's web UI, not in code — check them after
touching project settings, they don't show up in a diff:

- Built-in workflow **Auto-add to project** (`is:issue`) is **on** — a safety
  net so a card exists even if a workflow run fails.
- Built-in workflow **Item closed → Done** is **off** — it would race the
  Action's `Won't fix` rule; the Action alone owns Status.

The Action authenticates with the repo secret `PROJECT_TOKEN` — a **classic**
PAT, scope `project` only (`secrets.GITHUB_TOKEN` cannot write to a
user-owned project, and a **fine-grained** PAT can't substitute: GitHub only
exposes a Projects permission when the token's resource owner is an
organization, never a personal account — confirmed directly against GitHub's
own permissions docs, not assumed). Currently expires 2026-12-26 (90 days from
creation) — regenerate at
<https://github.com/settings/tokens> and re-run `gh secret set PROJECT_TOKEN`
before then, or the sync silently stops (a failed workflow run, not a failed
issue write, so it's easy to miss). Reads the project number from the repo
variable `PROJECT_NUMBER` (`gh variable set PROJECT_NUMBER --body <n>`).

PRs are not added to the board — see "PRs as a request surface: no" above.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
