---
name: manage-agents-md
description: Create and maintain concise AGENTS.md instruction files and CLAUDE.md symlinks. Use for create AGENTS.md, update AGENTS.md, manage repository agent instructions, add nested AGENTS.md guidance, set up CLAUDE.md compatibility, or clean stale coding-agent instructions.
---

# Manage AGENTS.md

Maintain only instructions that change agent behavior. Remove bloat.

## Scope

Manage root `AGENTS.md`, valuable nested `AGENTS.md` files, and `CLAUDE.md` only as a symlink to `AGENTS.md`.

Do not manage `agents.toml`, `agents.lock`, `.agents/`, `.claude/settings.json`, installed skills, plugin metadata, README inventories, or general docs.

## Workflow

1. Inspect existing instruction files, commands, docs, generated state, and subtree-specific rules.
2. Decide placement:
   - root `AGENTS.md` for repo-wide instructions
   - nested `AGENTS.md` only for distinct commands, ownership, safety rules, generated files, or workflow constraints
   - no new file when a short root instruction is enough
3. Edit conservatively:
   - preserve useful structure
   - add missing high-value instructions
   - remove obvious bloat and stale blocks when the user asked for cleanup or updates with learnings
   - ask before removing content that might be local policy or historical context
4. Verify commands, paths, generated-state warnings, nested-file value, and `CLAUDE.md` symlink state.

## Writing Rules

- Target under 60 lines; avoid exceeding 100 lines.
- Use repo-relative paths and exact commands.
- Reference existing docs instead of copying them.
- Prefer file-scoped test/lint/typecheck commands when available.
- Do not restate formatter, linter, or typechecker config.
- Do not list installed skills, plugin inventories, layout maps, or README inventories.
- Do not add agent, tool, or AI attribution rules except to forbid attribution.
- Do not add generic quality slogans or welcome text.

## CLAUDE.md

- Prefer `CLAUDE.md -> AGENTS.md`.
- If `CLAUDE.md` is missing and compatibility is requested, create a symlink.
- If `CLAUDE.md` is a regular file, compare it with `AGENTS.md` and ask before replacing it.
- Do not maintain divergent `AGENTS.md` and `CLAUDE.md` copies.

## Nested AGENTS.md Test

Create a nested file only when it changes behavior for that subtree.

Good reasons: different commands, generated or vendored code, separate deploy/release/security/review process, unusual test setup.

Bad reasons: directory size, repeated root guidance, local inventories, or docs that root `AGENTS.md` can reference.
