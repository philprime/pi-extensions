---
name: gh-stack
description: Manages dependent branches and stacked pull requests with GitHub's gh stack extension. Use when the user mentions gh stack, stacked PRs, adopting a stack, restacking layers, or syncing dependent branches. Not for ordinary single-PR tasks without a stack.
---

# GitHub Stack

Use `github/gh-stack`, the GitHub CLI extension. Requires authenticated `gh`. If unavailable, offer `gh extension install github/gh-stack` without installing automatically. Consult `gh stack SUBCOMMAND --help` for unfamiliar flags and installed-version behavior. Canonical documentation: <https://gh.io/stacks>.

A stack runs **bottom to top**, away from trunk:

```text
main <- auth <- api <- ui
```

Here `auth` is bottom and `ui` is top. Each PR targets its immediate parent. Inspect layer diffs against that parent, not always against `main`.

## 1. Inspect and Choose the Operation

```bash
git status --short
git branch --show-current
gh stack view --json
```

Use `--short` instead of `--json` for a compact display. Parse JSON with `jq`. If local tracking is missing, choose adoption or remote checkout from the user's intent. Do not initialize a replacement stack to bypass an error.

| User intent                              | Operation                                          | Important effect                                                                            |
| ---------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Inspect the stack                        | `gh stack view --json`                             | Read-only                                                                                   |
| Create or adopt layers                   | `gh stack init --base TRUNK BOTTOM NEXT`           | Adopts existing branches, creates missing ones                                              |
| Add a layer                              | `gh stack top`, then `gh stack add NEXT`           | Creates the next branch from the current HEAD                                               |
| Work on a remote stack                   | `gh stack checkout PR_URL`                         | Fetches branches and establishes local tracking                                             |
| Move between layers                      | `gh stack up`, `down`, `top`, `bottom`, or `trunk` | Changes the checkout                                                                        |
| Restack after a lower-layer change       | `gh stack rebase --no-trunk`                       | Rewrites local stack history without fetching trunk or pushing                              |
| Update from remote trunk locally         | `gh stack rebase`                                  | Fetches and cascade-rebases, without pushing                                                |
| Publish branches only                    | `gh stack push --remote REMOTE`                    | Pushes active layers, without creating PRs                                                  |
| Publish draft PRs                        | `gh stack submit --auto --remote REMOTE`           | Pushes active layers, creates drafts, updates existing PR bases and GitHub stack membership |
| Synchronize with GitHub                  | `gh stack sync --remote REMOTE`                    | Fetches, rebases, pushes, and syncs existing PR state, but opens no PRs                     |
| Link existing PRs without local tracking | `gh stack link BOTTOM_PR_URL NEXT_PR_URL`          | Creates or updates a stack on GitHub                                                        |

Uppercase arguments are placeholders. Substitute inspected branch names, remotes, and verified PR URLs. Prefer explicit targets over interactive pickers.

## 2. Check Scope Before Mutating

- Preserve uncommitted work. Do not stash, discard, or stage unrelated changes automatically. Before cross-worktree operations, inspect `git worktree list` and ensure affected owners are clean and idle.
- Inspection, help, and version commands are read-only. Navigation is not: even `--print-path` can check out an unoccupied branch. Branches held elsewhere remain in their owning worktrees.
- Create branches or stacks only for requested work. Use the `create-branch` skill's naming conventions. A request to inspect or describe a PR does not authorize stack creation.
- Use the `commit` skill only when commits are authorized. Stage specific files. Avoid `add -A`, `-u`, and `-m` shortcuts unless their staging and commit effects are intended.
- Confirm history rewrites, publishing, restructuring, merging, and unstacking unless already authorized. A PR request authorizes its necessary branch, intended commit, push, and draft creation, not unrelated layers or force pushes.
- `push`, `submit`, and `sync` operate across the active stack. Inspect every affected layer and `git remote -v` before publishing. Ask when the requested scope or destination is ambiguous. Rewriting published history needs explicit authorization. `push` uses per-branch force-with-lease checks, and `sync` force-pushes after rebasing. Never bypass a rejected lease.
- Keep atomic pushes enabled. Do not bypass failures with `--no-atomic` or `GH_STACK_NO_ATOMIC`. PR updates are not atomic. Use `--open`, `--prune`, and `--accept-base-change` only with authorization for their additional effects.

## 3. Follow the Selected Workflow

### Create or Grow a Stack

Resolve trunk only when needed:

```bash
gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'
```

Pass branches to `init` bottom to top. Inspect existing history before adoption. Initialization enables Git's `rerere` for remembered conflict resolutions. Make and commit each focused layer before adding the next. `add` must run from the top layer. Keep branch creation separate from committing so changes land on the intended layer.

### Publish Draft PRs

For every affected layer, inspect the actual parent relationship:

```bash
git log PARENT..BRANCH --oneline
git diff PARENT...BRANCH
```

Run required checks before the authorized publication. Prefer `submit --auto`: it skips the editor and creates drafts with generated titles. Interactive `submit` defaults new PRs to ready for review. `--open` marks both new and existing PRs ready, not merely the current layer.

Use the `pr-writer` skill for layer-specific titles and bodies. After submission, inspect generated metadata and correct it as authorized. Pass multiline Markdown through a body file.

For linking alone, prefer verified existing PR URLs. Branch arguments to `link` are pushed and can create PRs automatically.

### Address Feedback or Restack

Read the affected PR's description and review discussion. Check out that layer, implement and verify the requested fix, and commit when authorized. Then cascade-rebase descendants before publishing. Use `rebase --no-trunk` when only inter-layer updates are needed. `--upstack` limits rebasing from the current layer toward the top, and `--downstack` limits it from trunk through the current layer.

On a rebase conflict, resolve and stage only the intended files in the reported worktree, then run:

```bash
gh stack rebase --continue
```

If abandoning the operation is authorized, use `gh stack rebase --abort` to restore the original branches. Do not reset branches or delete recovery journals.

If **sync** conflicts during rebasing, it restores the original branch state. Run `gh stack rebase` to resolve conflicts rather than assuming a paused sync operation exists. Stop on local/remote divergence or an unexpected retargeted base instead of selecting a source of truth or accepting dropped old-base commits automatically. `sync --prune` deletes local branches for merged PRs.

### Restructure, Merge, or Unstack

- `gh stack modify` requires an interactive terminal and authorized restructuring. Recover with `modify --continue` or `modify --abort`. Inspect the result before an authorized `submit` updates GitHub.
- `gh stack merge` merges all layers through the selected PR atomically, or queues them if trunk uses a merge queue. Verify included PRs, checks, target, and merge method first. Non-interactive execution can merge the whole stack without prompting. Inspect mergeability with `gh pr view` and `gh pr checks`, never by invoking merge.
- Bare numbers passed to `checkout` or `merge` prefer stack IDs over PR numbers. Use a verified PR URL for checkout. Resolve merge targets explicitly before executing.
- `gh stack unstack` removes local tracking and unstacks on GitHub. `--local` removes only local tracking. GitHub can retain merged or queued members. Neither operation is routine cleanup.

## 4. Verify and Report

After mutations, inspect `git status --short` and `gh stack view --json`. After publishing, verify each affected PR:

```bash
gh pr view PR_URL --json url,baseRefName,headRefName,title,isDraft
```

Confirm that each PR targets its immediate parent and has the intended draft state. For checks, use `gh pr checks PR_URL`. Run the repository's required checks after code changes.

Report affected layers, local versus published changes, verification results, and remaining conflicts or gates. Do not report synchronization or passing checks without fresh evidence.
