---
name: create-branch
description: Create a focused git branch with a conventional type/name. Use when asked to create a branch, new branch, start a branch, make a branch, switch to a new branch, or begin work from the default branch.
---

# Create Branch

Create one branch for the current task. Keep the workflow non-interactive unless the user asks to choose the name.

## Workflow

1. Inspect the current state:

```bash
git branch --show-current
git status --short
```

2. Resolve the work description:
   - Use the user's description when provided.
   - Otherwise inspect `git diff`, `git diff --cached`, and `git status --short`.
   - If there is still no context, use `work-in-progress`.
3. Choose the type:

| Type      | Use for                          |
| --------- | -------------------------------- |
| `feat`    | user-facing feature              |
| `fix`     | bug fix                          |
| `ref`     | refactor without behavior change |
| `perf`    | performance improvement          |
| `docs`    | documentation                    |
| `test`    | tests                            |
| `build`   | build system or dependencies     |
| `ci`      | CI configuration                 |
| `chore`   | maintenance                      |
| `style`   | formatting only                  |
| `meta`    | repository metadata              |
| `license` | license changes                  |
| `revert`  | reverting a prior commit         |

When unsure, use `feat` for new behavior, `fix` for broken behavior, `ref` for restructuring, and `chore` for maintenance.

4. Resolve the GitHub username:
   - Run `gh api user --jq .login` to get the authoritative GitHub login (for example `philprime`).
   - Use the full login exactly; never shorten it or derive a name from git config or email.
   - If `gh` is unavailable or unauthenticated, ask the user for their GitHub username before continuing.
5. Generate `<github-username>/<type>/<short-description>`:
   - kebab-case for `<type>` and `<short-description>`
   - ASCII only
   - description ideally 3 to 6 words
   - no agent, tool, or AI names
6. Choose the base:
   - If on a normal branch, create from the current branch.
   - If on a detached HEAD, create from the current commit.
   - Do not switch branches before creating the new branch unless the user asks.
7. Avoid collisions:
   - Check local branches.
   - Check remote branches when a remote exists.
   - Append `-2`, `-3`, and so on until the name is unused.
8. Create and switch to the branch:

```bash
git switch -c <branch-name>
```

Report the final branch name.

## Examples

Branch names below assume the GitHub login `philprime`.

| Work description              | Branch name                                 |
| ----------------------------- | ------------------------------------------- |
| update commit skill           | `philprime/docs/update-commit-skill`        |
| fix null response in API      | `philprime/fix/handle-null-api-response`    |
| refactor auth middleware      | `philprime/ref/refactor-auth-middleware`    |
| add GitHub Actions formatting | `philprime/ci/add-formatting-github-action` |
