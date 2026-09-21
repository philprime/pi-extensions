# Create Branch Specification

## Intent

`create-branch` creates one focused git branch for the current task using a conventional `<github-username>/<type>/<short-description>` name.

It keeps branch creation non-interactive by default: it infers the type and description from user input or the working tree, prefixes the author's GitHub login, and avoids name collisions before switching.

## Scope

In scope:

- Inspecting current branch and working-tree state.
- Resolving a work description from user input or uncommitted changes.
- Choosing a conventional branch type.
- Resolving the author's GitHub login as the branch namespace.
- Generating a kebab-case branch name and avoiding local/remote collisions.
- Creating and switching to the new branch from the correct base.

Out of scope:

- Staging, committing, or writing commit messages (handled by the `commit` skill).
- Opening or updating pull requests.
- Pushing branches or setting upstreams unless the user asks.
- Switching away from the current branch before creating the new one unless asked.

## Users And Trigger Context

- Primary users: engineers and agents starting a unit of work from the default branch.
- Common user requests: "create a branch", "new branch", "start a branch", "switch to a new branch", or "begin work from main".
- Should not trigger for: commit-only requests, PR creation, or CI-fix loops.

## Runtime Contract

- Required first actions:
  - Inspect the current branch and `git status --short`.
  - Resolve the work description from user input or uncommitted changes.
- Required outputs:
  - A conventional `<github-username>/<type>/<short-description>` branch.
  - The final branch name reported back to the user.
- Non-negotiable constraints:
  - Use the full GitHub login from `gh api user --jq .login`; never shorten it or derive it from git config or email.
  - Ask for the username when `gh` is unavailable or unauthenticated.
  - Keep names kebab-case and ASCII with no agent, tool, or AI names.
  - Avoid collisions by checking local and remote branches and suffixing `-2`, `-3`, and so on.
  - Create from the current branch or commit; do not switch branches first unless asked.
- Expected bundled files loaded at runtime:
  - none; the skill uses inline guidance only.

## Source And Evidence Model

Authoritative sources:

- Current branch, working-tree status, and uncommitted diff.
- The author's GitHub login from `gh api user`.
- User-provided work description.

Useful improvement sources:

- positive examples: short, accurately typed branch names with the correct username prefix
- negative examples: shortened usernames, missing type, non-kebab names, or attribution tokens
- issue or PR feedback: branch-name conventions that diverge from team practice

Data that must not be stored:

- secrets or credentials
- private data unrelated to the branch name

## Reference Architecture

- `SKILL.md` contains the full runtime workflow, type table, naming rules, and examples.
- `SPEC.md` contains this maintenance contract.
- `references/`, `scripts/`, and `assets/` are unused until a concrete need appears.

## Validation

- Lightweight validation:
  - Confirm the name format includes the GitHub login prefix.
  - Confirm the type table matches the shared conventional-commit type set.
  - Confirm collision handling checks local and remote branches.
- Acceptance gates:
  - Branch name is `<github-username>/<type>/<short-description>`, kebab-case, ASCII.
  - Username is the full `gh` login, not a shortened or derived name.
  - The new branch is created from the correct base and reported back.

## Known Limitations

- The skill depends on an authenticated `gh` to resolve the username and falls back to asking the user.
- Inferred descriptions from uncommitted changes may be less precise than a user-provided description.

## Maintenance Notes

- Update `SKILL.md` when the naming convention, type table, or workflow changes.
- Update `SPEC.md` when intent, scope, validation, or limitations change.
- Keep the type table aligned with the `commit` and `pr-writer` skills.
