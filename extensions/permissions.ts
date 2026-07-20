import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

function readBashAllowRules(filePath: string): string[] {
	try {
		if (!fs.existsSync(filePath)) return [];
		const settings = readJsonObject(filePath);
		const permissions = ensureObject(
			settings.permissions,
			`${filePath}.permissions`,
		);
		const rules = ensureArray(
			permissions.allow,
			`${filePath}.permissions.allow`,
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

function findProjectSettings(cwd: string): string | undefined {
	let current = path.resolve(cwd);

	while (true) {
		const candidate = path.join(current, ".claude", "settings.local.json");
		if (fs.existsSync(candidate)) return candidate;

		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function localSettingsPath(cwd: string): string {
	return (
		findProjectSettings(cwd) ?? path.join(cwd, ".claude", "settings.local.json")
	);
}

function bashAllowRules(cwd: string): string[] {
	const projectSettings = findProjectSettings(cwd);

	return [
		...readBashAllowRules(
			path.join(os.homedir(), ".claude", "settings.local.json"),
		),
		...(projectSettings ? readBashAllowRules(projectSettings) : []),
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

		if (character === "<" || character === ">") return true;
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

function isBlockedCommand(command: string): boolean {
	const words = shellWords(command).map((word) =>
		word.replace(/^("|')|("|')$/g, ""),
	);
	if (words[0] !== "git") return false;

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
		return word === "commit" || word === "push";
	}

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
	const settingsPath = localSettingsPath(cwd);
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
		"Esc to cancel · Select option 2 to amend before saving",
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
					"Bash command is not allowed by .claude/settings.local.json and no UI is available.",
			};
		}

		const approval = approvalQueue.then(async () => {
			const commandsToApprove = (
				commands && commands.length > 1 ? commands : [command]
			).filter(
				(commandToApprove) => !isAllowedSimpleCommand(commandToApprove, rules),
			);
			for (const commandToApprove of commandsToApprove) {
				const defaultRule = suggestedRule(commandToApprove);
				const saveChoice = `Yes, and don’t ask again for: ${defaultRule}`;
				const choice = await ctx.ui.select(
					approvalMessage(
						commandToApprove,
						typeof input.description === "string"
							? input.description
							: undefined,
					),
					["Yes", saveChoice, "No"],
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
