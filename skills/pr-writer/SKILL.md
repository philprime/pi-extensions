---
name: pr-writer
description: Create and update concise pull requests with accurate conventional titles and reviewer-focused bodies. Use when opening a PR, creating a draft PR, updating a PR, refreshing a stale PR description, or preparing committed branch changes for review.
---

# PR Writer

Create or refresh a pull request that matches the current branch diff.

Requires authenticated GitHub CLI (`gh`).

## Workflow

1. Verify branch state:

```bash
gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'
git branch --show-current
git status --short
```

Stop if on the default branch, no PR exists, and the user has not asked to open from that branch.
Commit intended changes before opening or refreshing the PR.

2. Inspect scope:

```bash
git log BASE..HEAD --oneline
git diff BASE...HEAD
```

Use the detected default branch as `BASE`. Understand the dominant change before writing.

3. Check for an existing PR:

```bash
gh pr view --json number,title,body,url,baseRefName,headRefName
```

When updating, compare the current title/body against the current diff. Rewrite stale titles and bodies; keep them only when they still set the right reviewer expectation.

4. Write the title:

```text
<type>(<scope>): <Subject>
<type>: <Subject>
```

Allowed types: `feat`, `fix`, `ref`, `perf`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `meta`, `license`, `revert`.

Rules:

- Describe the dominant change, not the latest commit.
- Use the narrowest accurate type and scope.
- Use imperative present tense.
- No trailing period.
- No `[codex]`, `[claude]`, `[ai]`, `[bot]`, `[wip]`, agent/tool attribution, or automation labels.
- No vague titles like `update`, `cleanup`, `misc`, `fix stuff`, or `address feedback`.

5. Write the body:
   - Start with 1 to 3 short sentences describing changed behavior and why it matters.
   - Add 0 to 3 bold sections only for distinct reviewer-relevant context.
   - Use before/after fenced blocks only for changed contracts, payloads, output, permissions, config, or CLI behavior.
   - Include issue refs only when exact IDs or URLs appear in user input, branch name, commits, or verified tracker output.
   - Omit unknown issue refs; never write placeholders like `TODO`, `XXXXX`, or `<issue>`.

Do not include:

- file-by-file narration
- copied commit logs
- generic headings like `Summary` or `Changes`
- test-plan checklists
- private data, personal data, support contents, secrets, or credentials
- agent, tool, or AI attribution

6. Create or update the PR:

```bash
gh pr create --draft --title "<title>" --body "<body>"
```

```bash
gh api -X PATCH repos/{owner}/{repo}/pulls/PR_NUMBER \
  -f title="<title>" \
  -f body="<body>"
```

Prefer draft PRs for new PRs unless the user asks otherwise.

## Update Rule

If the current branch already has an open PR, refresh it after material follow-up commits even when the user did not explicitly ask for a PR edit.

Refresh for scope changes, new review context, changed implementation approach, or title/body drift.
Skip refreshes for typo-only, formatting-only, or rename-only changes that do not affect reviewer expectations.

## Examples

Simple:

```markdown
fix(api): Handle null response

Return a typed error when the upstream API returns null so callers can surface
a recoverable failure instead of crashing.

Fixes #1234
```

Contract change:

````markdown
feat(api): Return chunk-level run records

Run logs now write one versioned record per chunk. This lets consumers stream
partial progress while preserving final reconstruction.

**Record Shape**

Before, each line represented a full run:

```json
{ "run": "...", "findings": [] }
```

After, each line represents one chunk:

```json
{ "run": "...", "chunk": { "index": 1, "total": 4 }, "findings": [] }
```
````
