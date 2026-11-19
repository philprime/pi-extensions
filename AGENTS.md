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

## Safe Default Command Permissions

Treat “allow <command> in a safe way” as a request to update the default Bash permissions in `extensions/permissions.ts`:

- Inspect the installed command’s help, including relevant subcommands and options. Use official documentation when side effects are unclear.
- Automatically allow only read-only inspection, validation, or stdout-only output. Keep file mutation, publishing, arbitrary execution, secret exposure, and unknown options behind approval.
- Reuse existing argument parsing and option-validation helpers. Account for aliases, quoted arguments, `--option=value`, repeated options, response files, and shell expansions. Do not add a broad prefix rule without guards for unsafe forms.
- Add tests in `tests/permissions.test.ts` before implementation and confirm they fail for the intended reason. Cover safe defaults without project rules, unsafe forms even with broad allow rules, mixed compound commands, and explicit deny precedence.
- Run `npm test -- tests/permissions.test.ts` and `npm run check`. Report which forms are allowed and which still require approval.

## Generated and Local Files

- `agents.toml` is the source of truth for agent dependencies.
- Do not edit or commit `agents.lock` or `.agents/` generated content.
- Do not commit local files under `docs/superpowers/`.
- Do not add agent or tool attribution to commits or project files.
