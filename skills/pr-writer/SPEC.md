# PR Writer Specification

## Intent

`pr-writer` creates and updates pull requests with concise, reviewer-focused titles and bodies that match the current branch diff.

It turns committed branch changes into a PR title and description that explain what changed, why it matters, and any review context that is not obvious from the diff.

## Scope

In scope:

- Creating draft pull requests from committed feature branches.
- Updating existing PRs by re-evaluating title and body against the current diff.
- Writing conventional PR titles.
- Writing compact PR bodies with optional emphasis sections.
- Removing stale body text, template scaffolding, and agent/tool attribution.
- Including issue references only when backed by known context.

Out of scope:

- Creating commits or deciding commit history policy.
- Running CI or iterating on failing checks.
- Performing code review.
- Producing release notes or customer-facing announcements.
- Writing test-plan checklists.

## Users And Trigger Context

- Primary users: engineers and agents preparing branch changes for review.
- Common user requests: open a PR, create a draft PR, update a PR, refresh a PR description, prepare changes for review, or update the title/body after follow-up commits.
- Should not trigger for: commit-only requests, code review requests, CI-fix loops, or generic documentation writing.

## Runtime Contract

- Required first actions:
  - Verify current branch, default branch, committed state, and diff scope.
  - Inspect existing PR title/body when a PR already exists.
  - Decide whether the current title/body should be kept or rewritten.
- Required outputs:
  - Conventional PR title.
  - Concise PR body suitable for `gh pr create` or GitHub API update.
  - Keep-or-rewrite decision when updating an existing PR.
- Non-negotiable constraints:
  - Match the current diff, not stale branch history.
  - Never include private data, secrets, placeholder issue IDs, or agent/tool/AI attribution.
  - Omit test-plan checklists and generic template headings.
  - Prefer draft PRs for newly opened PRs unless the user asks otherwise.
  - Refresh open PRs after material follow-up commits that change reviewer expectations.
- Expected bundled files loaded at runtime:
  - none; the skill uses inline guidance only.

## Source And Evidence Model

Authoritative sources:

- Current branch diff and commit range.
- Existing PR title and body when updating.
- Repository-level agent instructions.
- User-provided issue IDs, URLs, or review context.

Useful improvement sources:

- positive examples: concise PR bodies reviewers can scan quickly
- positive examples: titles that stay accurate after follow-up commits
- negative examples: diff narration, stale titles, template scaffolding, and attribution markers
- issue or PR feedback: reviewer comments about missing context or excessive detail
- validation results: prompt-based checks for title accuracy, brevity, privacy, and update behavior

Data that must not be stored:

- secrets or credentials
- private data or personal data
- support ticket contents not needed for a public PR
- raw private review threads beyond the exact context needed

## Reference Architecture

- `SKILL.md` contains the full runtime workflow, body rules, command patterns, and examples.
- `SPEC.md` contains this maintenance contract.
- `references/` is unused until repeated failures justify focused examples.
- `scripts/` and `assets/` are unused.

## Validation

- Lightweight validation:
  - Confirm title rules reject bracketed agent/tool labels.
  - Confirm body rules reject test-plan sections, placeholders, and private data.
  - Confirm update flow inspects the existing PR before rewriting.
  - Confirm examples are generic and concise.
- Deeper validation:
  - Add a small prompt set only if regressions recur.
- Acceptance gates:
  - Title matches the dominant change.
  - Body starts with changed behavior and why it matters.
  - Issue refs are omitted when unverified.
  - Material follow-up commits trigger a PR refresh.

## Known Limitations

- The skill cannot prove issue references are correct unless context provides them.
- Large PRs may need more review context than the default body shape encourages.
- Title/body freshness relies on judging whether follow-up commits changed reviewer expectations.

## Maintenance Notes

- Update `SKILL.md` when PR workflow, title rules, body rules, examples, or safety constraints change.
- Update `SPEC.md` when intent, scope, validation, evidence policy, or limitations change.
