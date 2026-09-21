# Commit Specification

## Intent

`commit` creates one focused, reviewable commit from the intended changes using the Conventional Commits format.

It inspects the working tree, stages only intended files, chooses an accurate type and scope, and writes a clear message without agent or tool attribution.

## Scope

In scope:

- Inspecting branch and working-tree state before staging.
- Creating a feature branch off the default branch when needed (delegated to the `create-branch` skill).
- Staging only intended files and committing when staged changes exist.
- Choosing a conventional type and optional scope from the staged diff.
- Writing the header, optional body, and optional footer.
- Adding issue-reference footers only when backed by known context.

Out of scope:

- Naming and creating branches beyond invoking the `create-branch` skill.
- Pushing commits or opening pull requests.
- Performing code review or running CI.
- Rewriting existing history unless the user asks.

## Users And Trigger Context

- Primary users: engineers and agents saving intended changes as a commit.
- Common user requests: "commit", "git commit", "save changes", "commit message", or "make a commit".
- Should not trigger for: PR creation, branch-only requests, or CI-fix loops.

## Runtime Contract

- Required first actions:
  - Check current branch and `git status --short`.
  - Inspect the diff before staging or committing.
- Required outputs:
  - A single focused commit with a conventional message, when staged changes exist.
  - A working repository state after the commit.
- Non-negotiable constraints:
  - Stage only intended files; never `git add .` unless the user wants every change.
  - Branch off `main`/`master` before committing unless the user asked to commit there.
  - Keep the subject imperative, capitalized, no trailing period, at most 70 characters; all lines at most 100.
  - Use real newlines, never literal `\n`.
  - Add issue refs only when the exact ID or URL is present; never invent them.
  - Never add agent, tool, or AI attribution.
- Expected bundled files loaded at runtime:
  - none; the skill uses inline guidance only.

## Source And Evidence Model

Authoritative sources:

- The staged diff and working-tree status.
- User-provided issue IDs, URLs, or context.
- Branch names and prior commits for verified issue references.

Useful improvement sources:

- positive examples: focused commits with accurate type, scope, and clear why
- negative examples: bundled unrelated changes, vague subjects, invented issue refs, or attribution tokens
- issue or PR feedback: review comments about commit granularity or message clarity

Data that must not be stored:

- secrets or credentials
- private data or personal data not needed in the message

## Reference Architecture

- `SKILL.md` contains the full runtime workflow, message format, type table, footer rules, and examples.
- `SPEC.md` contains this maintenance contract.
- `references/`, `scripts/`, and `assets/` are unused until a concrete need appears.

## Validation

- Lightweight validation:
  - Confirm the message format and length rules are enforced.
  - Confirm the type table matches the shared conventional-commit type set.
  - Confirm footer rules reject invented issue references.
  - Confirm attribution rules forbid `Co-Authored-By` and tool names.
- Acceptance gates:
  - One focused commit reflects the staged diff.
  - The message uses an accurate type, imperative subject, and verified-only issue refs.
  - No agent, tool, or AI attribution appears anywhere in the message.

## Known Limitations

- The skill cannot verify issue references that are absent from user input, branch names, commits, or tracker output.
- Judging the right commit granularity relies on inspecting the diff and user intent.

## Maintenance Notes

- Update `SKILL.md` when the message format, type table, footer rules, or examples change.
- Update `SPEC.md` when intent, scope, validation, or limitations change.
- Keep the type table aligned with the `create-branch` and `pr-writer` skills.
