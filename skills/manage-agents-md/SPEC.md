# Manage AGENTS.md Specification

## Intent

`manage-agents-md` creates and maintains concise repository instruction files for coding agents.

The skill keeps only instructions that change agent behavior. It extends useful guidance, preserves useful structure, and removes obvious bloat when cleanup is requested.

## Scope

In scope:

- Root `AGENTS.md` files.
- Nested `AGENTS.md` files when a subtree has distinct agent guidance.
- `CLAUDE.md` compatibility symlinks that point to `AGENTS.md`.
- Command tables, external reference tables, and short non-obvious conventions.
- Detection of stale, duplicated, or contradictory instruction blocks.
- Removal of low-value inventories, layout maps, slogans, and generic docs prose.

Out of scope:

- `agents.toml`, `agents.lock`, `.agents/`, and dotagents dependency state.
- `.claude/settings.json`, permission allowlists, and provider settings.
- Installed skills, plugin manifests, and marketplace metadata.
- README skill inventories.
- Rewriting referenced docs such as `README.md` or policy files.
- Maintaining divergent provider-specific copies of the same instructions.

## Users And Trigger Context

- Primary users: engineers and agents maintaining repository-level agent instructions.
- Common user requests: "create AGENTS.md", "update AGENTS.md", "manage agent instructions", "add nested AGENTS.md", "set up CLAUDE.md", or "clean stale agent docs".
- Should not trigger for: general documentation writing, skill creation, plugin setup, PR descriptions, code review, or dotagents dependency management.

## Runtime Contract

- Required first actions:
  - Inspect current instruction files before editing.
  - Inspect repo commands, docs, manifests, CI, and relevant code layout.
  - Decide whether the change belongs in root `AGENTS.md`, a nested `AGENTS.md`, or neither.
- Required outputs:
  - Summary of instruction changes.
  - Any stale or bloated blocks removed, left, or waiting on confirmation.
  - Verification notes for paths, commands, and symlink state.
- Non-negotiable constraints:
  - Extend by default; rewrite only when cleanup requires it.
  - Remove obvious bloat when the user asks for cleanup or learned-rule updates.
  - Ask before removing content that might be local policy or historical context.
  - Keep `CLAUDE.md` as a symlink to `AGENTS.md` when compatibility is needed.
  - Create nested `AGENTS.md` files only when they add local value.
  - Do not manage `agents.toml`, `agents.lock`, `.agents/`, or other dotagents state.
- Expected bundled files loaded at runtime:
  - none; the skill uses inline guidance only.

## Source And Evidence Model

Authoritative sources:

- Existing local `AGENTS.md`, `CLAUDE.md`, and nested `AGENTS.md` files.
- Repository docs, manifests, lockfiles, task runners, CI workflows, and policy files.
- User instructions in the current conversation.
- Official AGENTS.md format and agent discovery guidance when available.

Useful improvement sources:

- positive examples: compact instruction files with exact commands and references
- negative examples: stale commands, duplicated docs, broad rewrites, inventories, generic slogans, and divergent provider copies
- commit logs: repeated fixes or migrations that explain a rule
- issue or PR feedback: agent failures caused by missing commands or ambiguous instructions
- validation results: command existence checks, line counts, and symlink checks

Data that must not be stored:

- secrets or credentials
- customer data or private operational details not needed for agent work
- long copied policy text
- private URLs or identifiers unless needed as exact repo references

## Reference Architecture

- `SKILL.md` contains the full runtime workflow.
- `SPEC.md` contains this maintenance contract.
- `SOURCES.md` contains provenance, decisions, coverage notes, and gaps.
- `references/` is unused until repeated failures justify focused lookup material.
- `scripts/` is unused until validation becomes too fragile for plain instructions.
- `assets/` is unused.

## Validation

- Lightweight validation:
  - Confirm `SKILL.md` frontmatter is first line.
  - Confirm `name` matches `manage-agents-md`.
  - Confirm runtime guidance excludes dotagents state management.
  - Confirm `CLAUDE.md` guidance requires a symlink, not a copy.
  - Confirm nested `AGENTS.md` guidance requires local value.
  - Confirm README or skill inventories are not recommended.
- Deeper validation:
  - Test against simple, monorepo, and stale-instruction examples when such examples are added.
- Holdout examples:
  - Add only if future revisions regress into broad rewrites or over-triggering.
- Acceptance gates:
  - The skill is concise, behavior-changing, and reference-backed.
  - Trigger language catches AGENTS.md maintenance without catching dotagents or general docs work.

## Known Limitations

- The skill depends on local inspection and user confirmation for stale-content removal.
- It cannot know private operational rules that are absent from the repository and not supplied by the user.
- Provider-specific behavior can drift; keep compatibility guidance limited to the `CLAUDE.md` symlink contract unless a concrete repo need appears.

## Maintenance Notes

- Update `SKILL.md` when runtime workflow, scope, or stale-content handling changes.
- Update `SPEC.md` when intent, scope, validation, evidence policy, or limitations change.
- Update `SOURCES.md` when source inventory, decisions, or gaps change.
- Add references or scripts only after repeated real failures show inline guidance is insufficient.
