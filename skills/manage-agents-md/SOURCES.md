# Sources

This file tracks material synthesized into `manage-agents-md`.

## Selected profile

- Class: `workflow-process`
- Execution shape: `inline-guidance`

Why: the skill is a single conservative maintenance workflow. Every invocation needs the same inspection, scope, edit, confirmation, and verification rules.

## Current source inventory

| Source                             | Type                     | Trust tier | Retrieved  | Confidence | Contribution                                                                                                             |
| ---------------------------------- | ------------------------ | ---------- | ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `AGENTS.md`                        | repo policy              | canonical  | 2026-05-27 | high       | Setup commands, dotagents state rules, no inventories, no attribution, remove-bloat policy                               |
| `README.md`                        | repo policy              | canonical  | 2026-05-27 | high       | Personal repo framing, dotagents setup, canonical `skills/` tree                                                         |
| former `skills/agents-md/SKILL.md` | local reference          | reference  | 2026-05-27 | medium     | Prior compact AGENTS.md workflow and anti-patterns; deleted after replacement                                            |
| former `skills/agents-md/SPEC.md`  | local reference          | reference  | 2026-05-27 | medium     | Prior intent, scope, and validation model; deleted after replacement                                                     |
| User brainstorming decisions       | direct requirement       | canonical  | 2026-05-27 | high       | New canonical name, conservative extension behavior, nested-file threshold, `CLAUDE.md` symlink rule, no dotagents scope |
| `.agents/skills/skill-writer/*`    | local authoring workflow | canonical  | 2026-05-27 | high       | Skill class, execution shape, authoring, SPEC, and validation structure                                                  |

## Decisions

1. Create a new canonical skill named `manage-agents-md`.
   Status: adopted
   Why: user requested a new canonical skill instead of keeping `agents-md`.

2. Use conservative extension as the primary behavior.
   Status: adopted
   Why: user explicitly said the skill should extend existing files, not rewrite aggressively.

3. Require confirmation before removing stale blocks.
   Status: narrowed
   Why: ask before removing possible local policy, but remove obvious bloat when the user asks for cleanup or learned-rule updates.

4. Keep `CLAUDE.md` as a symlink to `AGENTS.md`.
   Status: adopted
   Why: one canonical instruction file avoids divergent provider-specific copies.

5. Exclude dotagents state from runtime scope.
   Status: adopted
   Why: root `agents.toml`, `agents.lock`, and `.agents/` are dependency setup state, not AGENTS.md instruction content to manage.

6. Keep the first version inline-only.
   Status: adopted
   Why: no branch currently needs separate runtime references or scripts.

7. Remove template and inventory guidance from runtime.
   Status: adopted
   Why: user prefers removing bloat; examples and inventories drift and do not change agent behavior.

## Coverage matrix

| Dimension                         | Coverage status | Evidence                                        |
| --------------------------------- | --------------- | ----------------------------------------------- |
| Repo inspection before writing    | complete        | prior skill, user workflow requirements         |
| Conservative update behavior      | complete        | user decision                                   |
| Stale/bloat handling              | complete        | user decision and AGENTS.md remove-bloat rule   |
| Nested `AGENTS.md` threshold      | complete        | user decision                                   |
| `CLAUDE.md` symlink compatibility | complete        | user decision, prior skill                      |
| Excluding dotagents state         | complete        | user decision, README and AGENTS.md setup rules |
| Avoiding skill inventories        | complete        | README inventory removed, AGENTS.md rule added  |

## Open gaps

1. Add durable before/after examples only if future revisions drift toward broad rewrites.
2. Add scripts only if command/path validation becomes repetitive and fragile.
