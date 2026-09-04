import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Built-in read-only commands that are always safe to run automatically,
// even without a project allow rule. Keep this list free of any command that
// can mutate the working tree, delete data, or publish information.
const DEFAULT_ALLOW_RULES: string[] = [
	// File and directory inspection
	"cat:*",
	"head:*",
	"tail:*",
	"nl:*",
	"wc:*",
	"ls:*",
	"pwd",
	"find:*",
	"stat:*",
	"file:*",
	"tree:*",
	"realpath:*",
	"basename:*",
	"dirname:*",
	// Search and text processing
	"rg:*",
	"grep:*",
	"sed:*",
	"awk:*",
	"sort:*",
	"uniq:*",
	"comm:*",
	"cut:*",
	"tr:*",
	"diff:*",
	"jq:*",
	"yq:*",
	"xargs:*",
	// Miscellaneous read-only utilities
	"date:*",
	"echo:*",
	"true",
	"test:*",
	"command -v:*",
	"which:*",
	"uname:*",
	"base64:*",
	// Read-only git inspection
	"git status:*",
	"git log:*",
	"git diff:*",
	"git show:*",
	"git blame:*",
	"git grep:*",
	"git describe:*",
	"git rev-parse:*",
	"git rev-list:*",
	"git merge-base:*",
	"git ls-files:*",
	"git ls-tree:*",
	"git ls-remote:*",
	"git show-ref:*",
	"git reflog:*",
	"git fetch:*",
	"git branch --list:*",
	"git branch --show-current:*",
	"git branch -vv:*",
	"git tag --list:*",
	"git remote -v:*",
	"git remote show:*",
	"git stash list:*",
	"git stash show:*",
	"git worktree list:*",
	"git config --get:*",
	"git config --list:*",
	// Read-only GitHub CLI inspection
	"gh pr view:*",
	"gh pr list:*",
	"gh pr diff:*",
	"gh pr checks:*",
	"gh pr status:*",
	"gh repo view:*",
	"gh issue view:*",
	"gh issue list:*",
	"gh issue status:*",
	"gh run view:*",
	"gh run list:*",
	"gh release view:*",
	"gh release list:*",
	"gh search:*",
	"gh label list:*",
	"gh auth status:*",
];

// Commands that must never be auto-allowed, even when a broad allow rule such
// as `git *` or `gh *` matches. These either publish information or destroy
// data. Blocked commands still prompt for explicit approval.
const BLOCKED_FIRST_WORDS = new Set(["rm", "rmdir", "shred"]);
const BLOCKED_GIT_SUBCOMMANDS = new Set([
	"commit",
	"push",
	"reset",
	"clean",
	"rm",
]);
const BLOCKED_GH_ACTIONS = new Set([
	"create",
	"merge",
	"close",
	"reopen",
	"delete",
	"edit",
	"comment",
	"review",
	"ready",
]);

function readJsonFile(filePath: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
		}
		throw error;
	}
}

function ensureObject(
	value: unknown,
	description: string,
): Record<string, unknown> {
	if (value === undefined) return {};
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	throw new Error(`Expected ${description} to be a JSON object`);
}

function ensureArray(value: unknown, description: string): unknown[] {
	if (value === undefined) return [];
	if (Array.isArray(value)) return value;
	throw new Error(`Expected ${description} to be an array`);
}

function readJsonObject(filePath: string): Record<string, unknown> {
	return ensureObject(readJsonFile(filePath), filePath);
}

function readBashRules(filePath: string, kind: "allow" | "deny"): string[] {
	try {
		if (!fs.existsSync(filePath)) return [];
		const settings = readJsonObject(filePath);
		const permissions = ensureObject(
			settings.permissions,
			`${filePath}.permissions`,
		);
		const rules = ensureArray(
			permissions[kind],
			`${filePath}.permissions.${kind}`,
		);
		const bashRules: string[] = [];

		for (const rule of rules) {
			if (typeof rule !== "string") continue;
			const match = /^Bash\((.*)\)$/.exec(rule);
			if (match) bashRules.push(match[1]);
		}

		return bashRules;
	} catch (error) {
		console.warn(
			error instanceof Error ? error.message : `Failed to read ${filePath}`,
		);
		return [];
	}
}

function findProjectFile(
	cwd: string,
	...relativePath: string[]
): string | undefined {
	let current = path.resolve(cwd);

	while (true) {
		const candidate = path.join(current, ...relativePath);
		if (fs.existsSync(candidate)) return candidate;

		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function findProjectSettings(cwd: string): string | undefined {
	return findProjectFile(cwd, ".claude", "settings.local.json");
}

function findProjectPermissions(cwd: string): string | undefined {
	return findProjectFile(cwd, ".pi", "permissions.json");
}

function localPermissionsPath(cwd: string): string {
	return (
		findProjectPermissions(cwd) ?? path.join(cwd, ".pi", "permissions.json")
	);
}

function bashAllowRules(cwd: string): string[] {
	const projectSettings = findProjectSettings(cwd);
	const projectPermissions = findProjectPermissions(cwd);

	return [
		...DEFAULT_ALLOW_RULES,
		...readBashRules(
			path.join(os.homedir(), ".claude", "settings.local.json"),
			"allow",
		),
		...readBashRules(
			path.join(os.homedir(), ".pi", "agent", "permissions.json"),
			"allow",
		),
		...(projectSettings ? readBashRules(projectSettings, "allow") : []),
		...(projectPermissions ? readBashRules(projectPermissions, "allow") : []),
	];
}

function bashDenyRules(cwd: string): string[] {
	const projectPermissions = findProjectPermissions(cwd);

	return [
		...readBashRules(
			path.join(os.homedir(), ".pi", "agent", "permissions.json"),
			"deny",
		),
		...(projectPermissions ? readBashRules(projectPermissions, "deny") : []),
	];
}

function escapeRegExp(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globMatches(pattern: string, command: string): boolean {
	const regex = new RegExp(
		`^${pattern.split("*").map(escapeRegExp).join(".*")}$`,
	);
	return regex.test(command);
}

function commandMatchesRule(command: string, rule: string): boolean {
	if (rule.endsWith(":*")) {
		const prefix = rule.slice(0, -2);
		return command === prefix || command.startsWith(`${prefix} `);
	}

	if (rule.endsWith(" *")) {
		const prefix = rule.slice(0, -2);
		return command === prefix || command.startsWith(`${prefix} `);
	}

	if (rule.includes("*")) {
		return globMatches(rule, command);
	}

	return command === rule;
}

function splitShellCommands(command: string): string[] | undefined {
	const commands: string[] = [];
	let quote: "'" | '"' | undefined;
	let start = 0;

	const addCommand = (end: number) => {
		const current = command.slice(start, end).trim();
		if (current) commands.push(current);
	};

	for (let index = 0; index < command.length; index++) {
		const character = command[index];

		if (character === "\\") {
			index++;
			continue;
		}

		if (quote === "'") {
			if (character === "'") quote = undefined;
			continue;
		}

		if (quote === '"') {
			if (character === '"') quote = undefined;
			continue;
		}

		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}

		if (
			(character === "<" && command[index + 1] === "<") ||
			character === "`" ||
			character === "(" ||
			character === ")" ||
			(character === "$" && command[index + 1] === "(")
		) {
			return undefined;
		}

		if (character === "<" || character === ">") {
			const length = benignRedirectionLength(command, index);
			if (length > 0) {
				index += length - 1;
				continue;
			}
		}

		if (
			character === "\n" ||
			character === ";" ||
			character === "|" ||
			character === "&"
		) {
			addCommand(index);
			if (
				(character === "|" || character === "&") &&
				command[index + 1] === character
			)
				index++;
			start = index + 1;
		}
	}

	if (quote !== undefined) return undefined;
	addCommand(command.length);
	return commands;
}

function benignRedirectionLength(command: string, index: number): number {
	const boundary = (end: number): number => {
		const next = command[end];
		return next === undefined || /[\s|;&<>()]/.test(next) ? end - index : 0;
	};

	if (command[index + 1] === "&") {
		let end = index + 2;
		if (command[end] === "-") {
			end++;
		} else {
			while (command[end] >= "0" && command[end] <= "9") end++;
			if (end === index + 2) return 0;
		}
		return boundary(end);
	}

	if (command.startsWith("/dev/null", index + 1)) {
		return boundary(index + 1 + "/dev/null".length);
	}

	return 0;
}

function hasUnquotedRedirection(command: string): boolean {
	let quote: "'" | '"' | undefined;

	for (let index = 0; index < command.length; index++) {
		const character = command[index];

		if (character === "\\") {
			index++;
			continue;
		}

		if (quote === "'") {
			if (character === "'") quote = undefined;
			continue;
		}

		if (quote === '"') {
			if (character === '"') quote = undefined;
			continue;
		}

		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}

		if (character === "<" || character === ">") {
			const length = benignRedirectionLength(command, index);
			if (length === 0) return true;
			index += length - 1;
		}
	}

	return false;
}

function isSimpleShellCommand(command: string): boolean {
	const commands = splitShellCommands(command);
	return (
		commands?.length === 1 &&
		commands[0] === command.trim() &&
		!hasUnquotedRedirection(command)
	);
}

function gitSubcommand(words: string[]): string | undefined {
	for (let index = 1; index < words.length; index++) {
		const word = words[index];
		if (
			word === "-C" ||
			word === "-c" ||
			word === "--git-dir" ||
			word === "--work-tree"
		) {
			index++;
			continue;
		}
		if (
			word.startsWith("--git-dir=") ||
			word.startsWith("--work-tree=") ||
			word.startsWith("-c")
		)
			continue;
		if (word.startsWith("-")) continue;
		return word;
	}

	return undefined;
}

function isBlockedGhCommand(words: string[]): boolean {
	const resource = words[1];
	if (resource === undefined || resource.startsWith("-")) return false;

	// `gh api` can mutate through a non-GET method or field flags.
	if (resource === "api") {
		for (let index = 2; index < words.length; index++) {
			const word = words[index];
			if (word === "-X" || word === "--method") {
				const method = (words[index + 1] ?? "").toUpperCase();
				if (method && method !== "GET") return true;
				index++;
				continue;
			}
			if (
				word === "-f" ||
				word === "-F" ||
				word === "--field" ||
				word === "--raw-field"
			)
				return true;
		}
		return false;
	}

	const action = words[2];
	if (action === undefined || action.startsWith("-")) return false;
	return BLOCKED_GH_ACTIONS.has(action);
}

function isBlockedCommand(command: string): boolean {
	const words = shellWords(command).map((word) =>
		word.replace(/^("|')|("|')$/g, ""),
	);
	const name = words[0];
	if (name === undefined) return false;
	if (BLOCKED_FIRST_WORDS.has(name)) return true;
	if (name === "git") {
		const subcommand = gitSubcommand(words);
		return subcommand !== undefined && BLOCKED_GIT_SUBCOMMANDS.has(subcommand);
	}
	if (name === "gh") return isBlockedGhCommand(words);
	return false;
}

function isAllowedSimpleCommand(command: string, rules: string[]): boolean {
	return (
		!isBlockedCommand(command) &&
		isSimpleShellCommand(command) &&
		rules.some((rule) => commandMatchesRule(command, rule))
	);
}

function shellWords(command: string): string[] {
	return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
}

function suggestedRule(command: string): string {
	const words = shellWords(command);
	if (words.length >= 3) return `${words.slice(0, 3).join(" ")} *`;
	if (words.length >= 2) return `${words.slice(0, 2).join(" ")} *`;
	return command;
}

function normalizeBashRule(input: string): string {
	const trimmed = input.trim();
	return trimmed.startsWith("Bash(") && trimmed.endsWith(")")
		? trimmed
		: `Bash(${trimmed})`;
}

function readWritableSettings(filePath: string): Record<string, unknown> {
	if (!fs.existsSync(filePath)) return {};
	return readJsonObject(filePath);
}

function appendLocalBashRule(cwd: string, rule: string): string {
	const settingsPath = localPermissionsPath(cwd);
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

	const settings = readWritableSettings(settingsPath);
	const permissions = ensureObject(
		settings.permissions,
		`${settingsPath}.permissions`,
	);
	const entries = [
		...ensureArray(permissions.allow, `${settingsPath}.permissions.allow`),
	];
	const entry = normalizeBashRule(rule);
	if (!entries.includes(entry)) entries.push(entry);

	permissions.allow = entries;
	settings.permissions = permissions;
	fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
	return settingsPath;
}

function approvalMessage(
	command: string,
	description: string | undefined,
	amendable: boolean,
): string {
	return [
		"Bash command",
		"",
		`   ${command}`,
		description ? `   ${description}` : undefined,
		"",
		"This command requires approval",
		"",
		"Do you want to proceed?",
		"",
		amendable
			? "Esc to cancel · Select option 2 to amend before saving"
			: "Esc to cancel",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

export default function permissionsExtension(pi: ExtensionAPI) {
	let approvalQueue = Promise.resolve();

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const input = event.input as { command?: unknown; description?: unknown };
		const command = String(input.command ?? "");
		const commands = splitShellCommands(command);
		const commandCandidates = commands?.length ? commands : [command];
		const deniedRule = bashDenyRules(ctx.cwd).find((rule) =>
			commandCandidates.some((candidate) =>
				commandMatchesRule(candidate, rule),
			),
		);
		if (deniedRule) {
			return {
				block: true,
				reason: `Bash command matches deny rule "${normalizeBashRule(deniedRule)}"`,
			};
		}

		const rules = bashAllowRules(ctx.cwd);
		if (
			commands?.length &&
			commands.every((commandToCheck) =>
				isAllowedSimpleCommand(commandToCheck, rules),
			)
		)
			return undefined;

		if (!ctx.hasUI) {
			return {
				block: true,
				reason:
					"Bash command is not allowed by configured permissions and no UI is available.",
			};
		}

		const approval = approvalQueue.then(async () => {
			const commandsToApprove = (
				commands && commands.length > 1 ? commands : [command]
			).filter(
				(commandToApprove) => !isAllowedSimpleCommand(commandToApprove, rules),
			);
			for (const commandToApprove of commandsToApprove) {
				// A saved rule can only auto-allow simple commands, so the amend
				// option is misleading for redirections and unsupported syntax.
				const amendable = isSimpleShellCommand(commandToApprove);
				const defaultRule = suggestedRule(commandToApprove);
				const saveChoice = `Yes, and don’t ask again for: ${defaultRule}`;
				const choice = await ctx.ui.select(
					approvalMessage(
						commandToApprove,
						typeof input.description === "string"
							? input.description
							: undefined,
						amendable,
					),
					amendable ? ["Yes", saveChoice, "No"] : ["Yes", "No"],
				);

				if (choice === "Yes") continue;

				if (choice === saveChoice) {
					const editedRule = await ctx.ui.editor(
						"Amend Bash permission rule",
						defaultRule,
					);
					if (!editedRule?.trim()) {
						return { block: true, reason: "Permission rule save cancelled" };
					}

					try {
						const settingsPath = appendLocalBashRule(ctx.cwd, editedRule);
						ctx.ui.notify(
							`Saved ${normalizeBashRule(editedRule)} to ${settingsPath}`,
							"info",
						);
						continue;
					} catch (error) {
						const reason =
							error instanceof Error
								? error.message
								: "Failed to save permission rule";
						ctx.ui.notify(reason, "error");
						return { block: true, reason };
					}
				}

				return { block: true, reason: "Blocked by user" };
			}

			return undefined;
		});
		approvalQueue = approval.then(
			() => undefined,
			() => undefined,
		);
		return approval;
	});
}
