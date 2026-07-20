# Agent Instructions

## Setup

```bash
npm install
npx @sentry/dotagents install
pre-commit install
```

## Checks

Run the complete suite after code changes:

```bash
npm run check
```

For focused iteration, use `npm test -- tests/<file>.test.ts`. Use `npm run lint:fix` for TypeScript formatting and `dprint fmt` for JSON, Markdown, TOML, and YAML.

## Extension Changes

- Add regression tests before changing extension behavior.
- Pi extensions run with the user's full permissions. Keep permission checks fail-closed.
- For compound Bash commands, automatically allow the input only when every stage independently matches an allow rule.
- Treat unsupported shell syntax as one command requiring approval rather than broadening automatic permission rules.
- Use `ctx.hasUI` before interactive UI calls.

## Generated and Local Files

- `agents.toml` is the source of truth for agent dependencies.
- Do not edit or commit `agents.lock` or `.agents/` generated content.
- Do not commit local files under `docs/superpowers/`.
- Do not add agent or tool attribution to commits or project files.
