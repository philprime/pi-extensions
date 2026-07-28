---
name: develop-extension
description: Develop and test Pi coding-agent extensions in the @philprime/pi-extensions package, especially permission handling and extension tests.
---

# Develop Pi Extension

Develop extensions in `extensions/` and keep their regression tests in `tests/`.

## Official Documentation

Read Pi's canonical extension guide before using unfamiliar APIs or implementing a new extension:

<https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/docs/extensions.md>

Use its examples and the installed package types for API details. Do not copy the full guide into this skill.

## Inspect First

1. Read the extension and its matching test file.
2. Read `~/.pi/agent/settings.json` to understand global configuration.
3. Read `package.json` for the installed Pi version and available scripts.

## Workflow

1. Add a regression test before changing extension behavior.
2. Run the focused test and confirm it fails for the intended reason.
3. Make the smallest implementation change.
4. Rerun the focused test.
5. Run the complete package checks.

```bash
npm test -- tests/<extension>.test.ts
npm run check
```

Test extensions through their public registration behavior:

1. Import the extension's default function.
2. Supply a minimal fake `ExtensionAPI` that captures registered handlers.
3. Invoke handlers with realistic event and context data.
4. Use temporary directories for project configuration and remove them after each test.
5. Assert user-visible results, including blocks, prompts, options, notifications, and persisted configuration.

Use `ctx.hasUI` before dialogs and notifications. Extensions also run in print and JSON modes where UI methods cannot interact with the user.

## Permission Extension Rules

`extensions/permissions.ts` reads Bash allow rules from:

- `~/.claude/settings.local.json`
- The nearest ancestor `.claude/settings.local.json`

It does not read project `.claude/settings.json`. Verify intended configuration sources before changing this behavior.

Keep the permission boundary fail-closed:

- Automatically allow a simple command or recognized compound command only when every stage independently matches an allow rule.
- Keep escaped line continuations in one command.
- For top-level newline, `;`, `&&`, `||`, and `|`, skip allowlisted stages and prompt for every remaining command in order.
- Keep `Yes`, `Yes, and don’t ask again`, and `No` available for every prompted command.
- Stop and block the full input when the user declines any command.
- Treat unsupported syntax, including redirections, backticks, parentheses, command substitutions, and unbalanced quotes, as one command requiring approval.
- Never broaden an allow rule based on an entire multi-command script.

Avoid regex-only shell splitting. Quote and escape handling must prevent quoted separators and escaped newlines from creating false command boundaries. Add regression tests for every new syntax form before changing the scanner.

## Required Permission Regression Cases

| Case                                                 | Expected behavior                          |
| ---------------------------------------------------- | ------------------------------------------ |
| `git add file` matches `git add *`                   | Automatic allow                            |
| `git add file-one \\` followed by `file-two`         | Automatic allow                            |
| `git add file` followed by newline `git commit ...`  | Separate prompts                           |
| `grep ... \| head -250` with both stages allowlisted | Automatic allow                            |
| `grep ... \| head -250` with unallowlisted stages    | Separate prompts, each amendable           |
| `&&`, `\|\|`, and `;`                                | Separate prompts                           |
| Unsupported complex shell syntax                     | One approval prompt, never automatic allow |

Before reporting completion, run the focused test and `npm run check`. Report the exact commands and results.
