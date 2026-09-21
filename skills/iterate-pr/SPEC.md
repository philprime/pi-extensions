# Iterate PR Specification

## Intent

The `iterate-pr` skill drives a pull request through actionable review feedback first, then actionable CI failures, until the work is locally fixed, pushed, and rechecked.

Its purpose is feedback and CI iteration, not merge readiness. It fetches current feedback before examining CI, then starts feedback and check monitors in parallel after every push. When feedback arrives before CI finishes, the skill addresses it immediately instead of waiting for CI.

## Scope

In scope:

- Identifying the PR for the current branch.
- Fetching and categorizing PR review feedback.
- Fixing high and medium priority review feedback.
- Replying to addressed review threads after confirmation and resolving only threads the user explicitly asks to resolve.
- Asking the user which low priority suggestions to address.
- Fetching CI checks, failed logs, and failure snippets.
- Fixing CI failures with local verification before pushing.
- Monitoring checks until they pass, fail, or reach a non-actionable stop state.
- Monitoring feedback in parallel with checks after each push until feedback appears or registered actionable checks finish.
- Restarting both monitors after each feedback or CI fix is pushed.
- Reporting draft/no-checks and human review/approval gates without polling forever.

Out of scope:

- Waiting for or requesting human approval.
- Marking draft PRs ready for review unless the user explicitly asks.
- Merging PRs.
- Rebasing branches without user direction.
- Treating Codecov, Dependabot, or other informational comments as review feedback.

## Users And Trigger Context

- Primary users: engineers and coding agents iterating on existing pull requests.
- Common user requests: fix CI on this PR, iterate on this PR until checks pass, address PR feedback, keep pushing fixes until green.
- Should not trigger for: creating a PR, writing commits without a PR, reviewing unrelated code, or monitoring merge approval state only.

## Runtime Contract

- Required first actions: resolve the current PR, read `isDraft` and `reviewDecision`, fetch current review feedback, and fetch current CI state before editing.
- Required outputs: concise progress updates, commits and pushes when fixes are made, and a final state that distinguishes passing CI from non-actionable review/draft/approval gates.
- Non-negotiable constraints: handle available actionable feedback before CI failures, investigate failures before editing, verify locally before pushing, do not push known-broken fixes, run feedback and check monitors in parallel after each push, process new feedback without waiting for CI, restart both monitors after each pushed fix, stop the feedback monitor after a final clear fetch when registered actionable checks finish, do not wait for human approval, and do not treat draft PRs with no checks as pending forever.
- Permission boundary: use direct `gh pr` and `gh run` commands for their read-only operations. Put every required GraphQL operation behind a fixed-purpose wrapper so allow-listing a workflow never requires allow-listing generic `gh api` access.
- External writes: require explicit confirmation before invoking the review-thread wrapper. Reply and resolution permissions are separate; permission to reply never authorizes resolution. The wrapper must submit a review GitHub leaves pending, resolve only threads the user explicitly asks to resolve, and report the final state of each operation.
- Expected bundled files loaded at runtime: `SKILL.md` and, when needed, fixed-operation shell wrappers under `scripts/`.

## Source And Evidence Model

Authoritative sources:

- GitHub CLI PR and checks output.
- Priority markers in review comments, including high/medium/low prefixes.
- Repository-level agent instructions.
- Bundled shell-wrapper behavior documented in `SKILL.md`.

Useful improvement sources:

- positive examples: PRs where CI failures were fixed and checks passed after the loop.
- negative examples: PRs where the agent waited on draft status, required review, or approval gates.
- issue or PR feedback: reviewer comments about missing fixes, false positives, or feedback categorization.
- validation results: structural skill validation and script syntax checks.

Data that must not be stored:

- secrets
- customer data
- private URLs or identifiers not needed for reproduction
- full CI logs when small failure snippets are enough

## Reference Architecture

- `SKILL.md` contains the runtime workflow, script contracts, feedback handling rules, CI loop, and exit conditions.
- `SPEC.md` contains this maintenance contract.
- `references/` contains no files currently; add focused troubleshooting or evidence references only if runtime guidance becomes noisy.
- `references/evidence/` contains no files currently; use it for durable positive or negative PR-loop examples if regressions recur.
- `scripts/fetch-pr-feedback.sh` contains the fixed read-only GraphQL query and feedback categorization.
- `scripts/monitor-pr-feedback.sh` polls feedback while direct `gh pr checks --watch` monitors CI.
- `scripts/reply-to-feedback.sh` contains fixed review-thread reply and resolution mutations and submits the associated review when GitHub leaves it pending.
- `tests/iterate-pr.test.sh` validates wrapper contracts with a stubbed `gh` executable.
- `assets/` contains no files currently.

## Validation

- Validation: run `make validate SKILL=iterate-pr` for structural validation and `make test` for wrapper contract tests. Run `make lint` to apply the complete pre-commit suite, including ShellCheck for tracked shell scripts.
- Holdout examples: include a draft PR with no registered checks, a PR with `reviewDecision: REVIEW_REQUIRED` but passing checks, a PR with actionable pending CI, a PR with failed CI logs, and a PR where feedback arrives before checks finish.
- Acceptance gates: validator passes, shell syntax and contract tests pass, wrappers expose only their documented GraphQL operations, review-thread replies end in a non-pending review state, requested resolutions return `isResolved: true`, draft/no-check states terminate with a report, human review gates are not treated as actionable pending CI, feedback monitoring exits when high/medium feedback appears, feedback monitoring performs a final clear fetch and exits when registered actionable checks finish, and pushed fixes restart both monitors.

## Known Limitations

- PR-author comments are surfaced (tagged `self_authored: true`), not skipped. The script cannot reliably distinguish an author's change request from context written for reviewers, so it includes both and the invoking agent judges actionability per comment.
- Human-gate detection depends on check names, states, and descriptions exposed by GitHub or CI integrations.
- Some repositories may intentionally model deployment or approval workflows as status checks; this skill reports those as blocked/non-actionable unless the user asks to manage that gate.
- The feedback monitor stops after its final clear fetch once registered actionable checks finish; review comments posted later are outside the iteration window.
- The feedback query requests the first 100 reviews, review threads, comments per thread, and conversation comments. Larger PRs require pagination support.
- The shell wrappers use GitHub CLI and `jq` output and can drift if GitHub changes its GraphQL schema or `gh pr checks` changes its JSON schema.

## Maintenance Notes

- Update `SKILL.md` when the runtime loop, wrapper contracts, feedback policy, monitor behavior, or exit conditions change.
- Update `SPEC.md` when the skill's scope, permission boundary, validation expectations, or non-actionable gate policy changes.
- Keep GraphQL queries and mutations inside fixed-purpose wrappers. Do not add a generic API passthrough.
- Add focused reference files only when repeated troubleshooting guidance would make `SKILL.md` hard to scan.
