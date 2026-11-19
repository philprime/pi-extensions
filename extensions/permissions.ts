import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type BashPermissionRequest,
	type BashPermissionResult,
	checkBashPermissions,
} from "./bash-permission-check.ts";
import { backgroundJobCommand } from "./run.ts";

const RESEARCH_CLI_ALLOW_RULES = [
	"apple-docs --help",
	"apple-docs -h",
	"apple-docs --version",
	"apple-docs help:*",
	"apple-docs technologies list:*",
	"apple-docs types list:*",
	"apple-docs types search:*",
	"apple-docs types view:*",
	"apple-docs agent skills list:*",
	"apple-docs agent skills get:*",
	"gh kit --help",
	"gh kit help:*",
	"gh kit pr --help",
	"gh kit workflows --help",
	"gh kit agent --help",
	"gh kit agent skills --help",
	"gh kit pr comments:*",
	"gh kit workflows logs:*",
	"gh kit agent skills list:*",
	"gh kit agent skills get:*",
];

// Built-in low-risk commands that are always safe to run automatically,
// even without a project allow rule. Keep this list free of any command that
// can mutate the working tree, delete data, or publish information.
const DEFAULT_ALLOW_RULES: string[] = [
	...RESEARCH_CLI_ALLOW_RULES,
	// Read-only linting and stdout formatting, constrained by isBlockedCommand.
	"actionlint:*",
	"clang-format:*",
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
	"strings:*",
	"nm:*",
	"tree:*",
	"realpath:*",
	"basename:*",
	"dirname:*",
	"readlink:*",
	"du:*",
	"df:*",
	"size:*",
	// Search and text processing
	"rg:*",
	"grep:*",
	"sed:*",
	"sort:*",
	"uniq:*",
	"comm:*",
	"cmp:*",
	"cut:*",
	"tr:*",
	"diff:*",
	"jq:*",
	"yq:*",
	"col:*",
	"colrm:*",
	"column:*",
	"expand:*",
	"unexpand:*",
	"fold:*",
	"paste:*",
	"join:*",
	"rev:*",
	// Miscellaneous low-risk utilities
	"date:*",
	"echo:*",
	"sleep:*",
	"true",
	"test:*",
	"command -v:*",
	"which:*",
	"uname:*",
	"base64:*",
	"shasum:*",
	"cksum:*",
	"sum:*",
	"sw_vers:*",
	"getconf:*",
	"pagesize",
	"uptime:*",
	"vm_stat:*",
	"id:*",
	"groups:*",
	"whoami",
	"uuidgen:*",
	// With arguments, arch can execute another program.
	"arch",
	// Read-only Simulator inspection
	"xcrun simctl appinfo:*",
	"xcrun simctl get_app_container:*",
	"xcrun simctl getenv:*",
	"xcrun simctl help:*",
	"xcrun simctl list:*",
	"xcrun simctl listapps:*",
	"xcrun simctl pbpaste:*",
	// Read-only git inspection
	"git status:*",
	"git log:*",
	"git diff:*",
	"git range-diff:*",
	"git show:*",
	"git blame:*",
	"git grep:*",
	"git describe:*",
	"git rev-parse:*",
	"git rev-list:*",
	"git merge-base:*",
	"git check-ignore:*",
	"git ls-files:*",
	"git ls-tree:*",
	"git ls-remote:*",
	"git show-ref:*",
	"git reflog",
	"git reflog show:*",
	"git reflog list:*",
	"git stash list:*",
	"git stash show:*",
	"git worktree list:*",
	// Read-only GitHub CLI inspection
	"gh --help",
	"gh -h",
	"gh help:*",
	"gh api user --jq '.login'",
	"gh gist list:*",
	"gh gist view:*",
	"gh org list:*",
	"gh project field-list:*",
	"gh project item-list:*",
	"gh project list:*",
	"gh project view:*",
	"gh workflow list:*",
	"gh workflow view:*",
	"gh ruleset check:*",
	"gh ruleset list:*",
	"gh ruleset view:*",
	"gh cache list:*",
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
	"gh run watch:*",
	"gh release view:*",
	"gh release list:*",
	"gh search:*",
	"gh label list:*",
	"gh auth status:*",
	// Read-only Sentry inspection
	"sentry --help",
	"sentry -h",
	"sentry --version",
	"sentry -v",
	"sentry help:*",
	"sentry docs:*",
	"sentry auth status:*",
	"sentry auth whoami:*",
	"sentry agent-conversation list:*",
	"sentry agent-conversation view:*",
	"sentry alert issues list:*",
	"sentry alert issues view:*",
	"sentry alert metrics list:*",
	"sentry alert metrics view:*",
	"sentry debug-files check:*",
	"sentry debug-files find:*",
	"sentry debug-files print-sources:*",
	"sentry feedback list:*",
	"sentry feedback view:*",
	"sentry monitor list:*",
	"sentry platform list:*",
	"sentry sourcemap resolve:*",
	"sentry status:*",
	"sentry info:*",
	"sentry dsn list:*",
	"sentry dsn ls:*",
	"sentry proguard uuid:*",
	"sentry cli completion:*",
	"sentry cli defaults",
	"sentry cli fix --dry-run",
	"sentry cli import --dry-run",
	"sentry cli import -n",
	"sentry cli upgrade --check",
	"sentry dashboard list:*",
	"sentry dashboard view:*",
	"sentry dashboard revisions:*",
	"sentry org list:*",
	"sentry org view:*",
	"sentry project list:*",
	"sentry project view:*",
	"sentry replay list:*",
	"sentry replay view:*",
	"sentry release list:*",
	"sentry release view:*",
	"sentry release deploys:*",
	"sentry release propose-version:*",
	"sentry repo list:*",
	"sentry team list:*",
	"sentry issue list:*",
	"sentry issue events:*",
	"sentry issue view:*",
	"sentry event list:*",
	"sentry event view:*",
	"sentry explore:*",
	"sentry log list:*",
	"sentry log view:*",
	"sentry span list:*",
	"sentry span view:*",
	"sentry trace list:*",
	"sentry trace view:*",
	"sentry trace logs:*",
	"sentry trial list:*",
	"sentry schema:*",
	// Read-only dependency inspection
	"bundle info:*",
	"bundle show:*",
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

type PermissionTool = "Bash" | "MCP";
type PermissionKind = "allow" | "ask" | "deny";

const MCP_RESOURCE_TOOLS = new Set([
	"list_mcp_resources",
	"list_mcp_resource_templates",
	"read_mcp_resource",
]);

function readPermissionRules(
	filePath: string,
	kind: PermissionKind,
	tool: PermissionTool,
): string[] {
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
		const patterns: string[] = [];
		const expression = new RegExp(`^${tool}\\((.*)\\)$`);

		for (const rule of rules) {
			if (typeof rule !== "string") continue;
			const match = expression.exec(rule);
			if (match) patterns.push(match[1]);
		}

		return patterns;
	} catch (error) {
		if (tool === "MCP") throw error;
		console.warn(
			error instanceof Error ? error.message : `Failed to read ${filePath}`,
		);
		return [];
	}
}

function findProjectPermissions(
	cwd: string,
	fileName = "permissions.json",
): string | undefined {
	let current = path.resolve(cwd);

	while (true) {
		const candidate = path.join(current, ".pi", fileName);
		if (fs.existsSync(candidate)) return candidate;

		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function localPermissionsPath(cwd: string): string {
	return (
		findProjectPermissions(cwd, "permissions.local.json") ??
		path.join(cwd, ".pi", "permissions.local.json")
	);
}

function permissionPaths(cwd: string): string[] {
	const home = os.homedir();
	const projectPaths = [
		findProjectPermissions(cwd),
		findProjectPermissions(cwd, "permissions.local.json"),
	].filter((filePath): filePath is string => filePath !== undefined);

	return [
		...new Set([
			path.join(home, ".pi", "agent", "permissions.json"),
			path.join(home, ".pi", "agent", "permissions.local.json"),
			...projectPaths,
		]),
	];
}

function permissionRules(
	cwd: string,
	kind: PermissionKind,
	tool: PermissionTool,
): string[] {
	return permissionPaths(cwd).flatMap((filePath) =>
		readPermissionRules(filePath, kind, tool),
	);
}

function bashAllowRules(cwd: string): string[] {
	return [...DEFAULT_ALLOW_RULES, ...permissionRules(cwd, "allow", "Bash")];
}

function bashDenyRules(cwd: string): string[] {
	return permissionRules(cwd, "deny", "Bash");
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

		if (quote === "'") {
			if (character === "'") quote = undefined;
			continue;
		}

		if (character === "\\") {
			if (command[index + 1] !== "\n") return undefined;
			index++;
			continue;
		}

		if (quote === '"') {
			if (character === "$" || character === "`") return undefined;
			if (character === '"') quote = undefined;
			continue;
		}

		if (character === "$" || character === "`") return undefined;
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}

		if (
			(character === "$" && command[index + 1] === "'") ||
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

interface ParsedShellCommand {
	command: string;
	outputPaths: string[];
}

function parseRedirectionTarget(
	command: string,
	start: number,
): { end: number; value: string } | undefined {
	let quote: "'" | '"' | undefined;
	let value = "";
	let index = start;

	for (; index < command.length; index++) {
		const character = command[index];
		if (quote === "'") {
			if (character === "'") quote = undefined;
			else value += character;
			continue;
		}
		if (quote === '"') {
			if (character === '"') quote = undefined;
			else if (character === "$" || character === "`") return undefined;
			else if (character === "\\") {
				if (++index >= command.length) return undefined;
				value += command[index];
			} else value += character;
			continue;
		}
		if (/\s/.test(character) || "|;&<>".includes(character)) break;
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (character === "\\") {
			if (++index >= command.length) return undefined;
			value += command[index];
			continue;
		}
		if ("$`*?[]{}~".includes(character)) return undefined;
		value += character;
	}

	if (quote !== undefined || value.length === 0) return undefined;
	return { end: index, value };
}

function parseOutputRedirections(
	command: string,
): ParsedShellCommand | undefined {
	let quote: "'" | '"' | undefined;
	let lastCopiedIndex = 0;
	let executableCommand = "";
	const outputPaths: string[] = [];

	for (let index = 0; index < command.length; index++) {
		const character = command[index];
		if (character === "\\" && quote !== "'") {
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
		if (character === "<" || (character === "$" && command[index + 1] === "'"))
			return undefined;
		if (character !== ">") continue;

		let redirectionStart = index;
		while (
			redirectionStart > 0 &&
			/[0-9]/.test(command[redirectionStart - 1])
		) {
			redirectionStart--;
		}
		if (
			redirectionStart > 0 &&
			!/[\s|;&]/.test(command[redirectionStart - 1])
		) {
			redirectionStart = index;
		}
		executableCommand += command.slice(lastCopiedIndex, redirectionStart);

		const benignLength = benignRedirectionLength(command, index);
		if (benignLength > 0 && command[index + 1] === "&") {
			index += benignLength - 1;
			lastCopiedIndex = index + 1;
			continue;
		}

		let targetStart = index + (command[index + 1] === ">" ? 2 : 1);
		while (/\s/.test(command[targetStart] ?? "")) targetStart++;
		const target = parseRedirectionTarget(command, targetStart);
		if (!target) return undefined;
		if (target.value !== "/dev/null") outputPaths.push(target.value);
		index = target.end - 1;
		lastCopiedIndex = target.end;
	}

	if (quote !== undefined) return undefined;
	executableCommand += command.slice(lastCopiedIndex);
	return { command: executableCommand.trim(), outputPaths };
}

function isPathInsideProject(filePath: string, cwd: string): boolean {
	const relativePath = path.relative(
		path.resolve(cwd),
		path.resolve(cwd, filePath),
	);
	return (
		relativePath.length > 0 &&
		!path.isAbsolute(relativePath) &&
		!relativePath.split(path.sep).some((part) => part.startsWith("."))
	);
}

function hasSymlinkComponent(filePath: string, cwd: string): boolean {
	const relativePath = path.relative(
		path.resolve(cwd),
		path.resolve(cwd, filePath),
	);
	let currentPath = path.resolve(cwd);
	for (const part of relativePath.split(path.sep)) {
		currentPath = path.join(currentPath, part);
		try {
			if (fs.lstatSync(currentPath).isSymbolicLink()) return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			return true;
		}
	}
	return false;
}

function isExistingIgnoredFile(filePath: string, cwd: string): boolean {
	const resolvedPath = path.resolve(cwd, filePath);
	if (!fs.existsSync(resolvedPath)) return true;
	try {
		const stats = fs.statSync(resolvedPath);
		if (!stats.isFile() || stats.nlink !== 1) return false;
	} catch {
		return false;
	}
	return (
		spawnSync(
			"git",
			["check-ignore", "--quiet", "--", path.relative(cwd, resolvedPath)],
			{ cwd, stdio: "ignore" },
		).status === 0
	);
}

function isSafeOutputPath(filePath: string, cwd: string): boolean {
	if (isPathInsideProject(filePath, cwd)) {
		return (
			!hasSymlinkComponent(filePath, cwd) &&
			isExistingIgnoredFile(filePath, cwd)
		);
	}

	const resolvedPath = path.resolve(cwd, filePath);
	try {
		// /tmp itself is a system symlink on macOS. Trust that root, but not
		// symlinks beneath it that could redirect writes elsewhere.
		const temporaryRoot = ["/tmp", fs.realpathSync("/tmp")].find((root) =>
			isPathInsideProject(resolvedPath, root),
		);
		if (!temporaryRoot || hasSymlinkComponent(resolvedPath, temporaryRoot)) {
			return false;
		}
	} catch {
		return false;
	}

	try {
		const stats = fs.lstatSync(resolvedPath);
		return stats.isFile() && stats.nlink === 1;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

function parsedSimpleShellCommand(
	command: string,
	cwd: string,
): ParsedShellCommand | undefined {
	const commands = splitShellCommands(command);
	if (commands?.length !== 1 || commands[0] !== command.trim())
		return undefined;
	const parsed = parseOutputRedirections(command);
	if (
		!parsed?.outputPaths.every((filePath) => isSafeOutputPath(filePath, cwd))
	) {
		return undefined;
	}
	return parsed;
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

function isReadOnlyManCommand(words: string[]): boolean {
	if (words[0] !== "man") return false;
	// Never inherit a configurable pager or permit custom manual files/options.
	let index: number;
	if (words[1] === "-P" && words[2] === "cat") index = 3;
	else if (words[1] === "-w") index = 2;
	else return false;
	if (/^[1-9][A-Za-z0-9]*$/.test(words[index] ?? "")) index++;
	return (
		index < words.length &&
		words
			.slice(index)
			.every((word) => /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(word))
	);
}

function isReadOnlyGhStackCommand(words: string[]): boolean {
	if (words[0] !== "gh" || words[1] !== "stack") return false;
	const args = words.slice(2);
	if (args.length === 0) return true;
	if (
		args.length === 1 &&
		["--help", "-h", "--version", "-v"].includes(args[0])
	)
		return true;
	if (args[0] === "help")
		return args.slice(1).every((word) => /^[a-z][a-z-]*$/.test(word));
	if (
		args.length === 2 &&
		/^[a-z][a-z-]*$/.test(args[0]) &&
		["--help", "-h"].includes(args[1])
	)
		return true;
	return (
		args[0] === "view" &&
		hasOnlyInspectionOptions(
			args.slice(1),
			["--json", "--short", "-s"],
			{},
			false,
		)
	);
}

function isReadOnlyResearchCliHelpCommand(words: string[]): boolean {
	if (!["-h", "--help"].includes(words.at(-1) ?? "")) return false;
	const commandWords = words.slice(0, -1);
	if (!commandWords.every((word) => /^[a-z][a-z-]*$/.test(word))) return false;
	const command = commandWords.join(" ");
	return RESEARCH_CLI_ALLOW_RULES.some((rule) => {
		const prefix = rule.replace(/(?::\*| --help| -h)$/, "");
		return prefix === command || prefix.startsWith(`${command} `);
	});
}

function isReadOnlyGhHelpCommand(words: string[]): boolean {
	if (
		words[0] === "gh" &&
		words.length === 2 &&
		["-h", "--help"].includes(words[1])
	)
		return true;
	return (
		words[0] === "gh" &&
		words.length >= 3 &&
		words.length <= 4 &&
		["--help", "-h"].includes(words[words.length - 1]) &&
		[
			"api",
			"auth",
			"cache",
			"gist",
			"issue",
			"label",
			"org",
			"pr",
			"project",
			"release",
			"repo",
			"ruleset",
			"run",
			"search",
			"status",
			"workflow",
		].includes(words[1]) &&
		words.slice(1, -1).every((word) => /^[a-z][a-z-]*$/.test(word))
	);
}

function isReadOnlyApiHelpCommand(words: string[]): boolean {
	return (
		(words[0] === "gh" || words[0] === "sentry") &&
		words[1] === "api" &&
		(words.length === 3 || (words.length === 4 && !words[2].startsWith("-"))) &&
		["--help", "-h"].includes(words[words.length - 1])
	);
}

function isReadOnlyApiCommand(words: string[]): boolean {
	const cli = words[0];
	if ((cli !== "gh" && cli !== "sentry") || words[1] !== "api") return false;

	let endpoint: string | undefined;
	for (let index = 2; index < words.length; index++) {
		const word = words[index];
		const equalsIndex = word.startsWith("-") ? word.indexOf("=") : -1;
		const attachedShortValue = cli === "gh" && /^-[Xq].+/.test(word);
		const option = attachedShortValue
			? word.slice(0, 2)
			: equalsIndex < 0
				? word
				: word.slice(0, equalsIndex);
		const inlineValue = attachedShortValue
			? word.slice(2).replace(/^=/, "")
			: equalsIndex < 0
				? undefined
				: word.slice(equalsIndex + 1);
		if (option === "--method" || option === "-X") {
			if ((inlineValue ?? words[++index])?.toUpperCase() !== "GET")
				return false;
			continue;
		}
		if (
			(cli === "gh" && (option === "--jq" || option === "-q")) ||
			(cli === "sentry" && option === "--fields")
		) {
			const value = inlineValue ?? words[++index];
			if (!value || value.startsWith("-")) return false;
			continue;
		}
		if (
			(cli === "gh" &&
				["--paginate", "--slurp", "--silent", "--include", "-i"].includes(
					option,
				)) ||
			(cli === "sentry" && ["--json", "--silent"].includes(option))
		) {
			if (
				inlineValue !== undefined &&
				(cli !== "gh" || !["true", "false"].includes(inlineValue))
			)
				return false;
			continue;
		}
		if (word.startsWith("-") || word.startsWith("@") || endpoint !== undefined)
			return false;
		endpoint = word;
	}

	return (
		endpoint !== undefined &&
		!/^\/?graphql(?:[?#]|$)/i.test(endpoint) &&
		!/^https?:\/\//i.test(endpoint)
	);
}

// Reject unknown options, including provider/engine loading and output paths.
// Values are consumed here so a filename cannot masquerade as another option.
function hasOnlyInspectionOptions(
	words: string[],
	flags: string[],
	valueOptions: Record<string, readonly string[] | RegExp | null>,
	allowOperands = true,
): boolean {
	for (let index = 0; index < words.length; index++) {
		const word = words[index];
		if (flags.includes(word)) continue;
		if (!word.startsWith("-")) {
			if (!allowOperands) return false;
			continue;
		}
		const equalsIndex = word.indexOf("=");
		const option = equalsIndex < 0 ? word : word.slice(0, equalsIndex);
		if (!Object.hasOwn(valueOptions, option)) return false;
		const value =
			equalsIndex < 0 ? words[++index] : word.slice(equalsIndex + 1);
		const allowedValues = valueOptions[option];
		if (
			!value ||
			(allowedValues instanceof RegExp
				? !allowedValues.test(value)
				: allowedValues
					? !allowedValues.includes(value)
					: value.startsWith("-"))
		)
			return false;
	}
	return true;
}

// Accept quoted option values such as --style='{...}', but no shell expansions.
function literalLintWords(command: string): string[] | undefined {
	if (
		!shellWords(command).every((word) =>
			/^(?:[A-Za-z0-9_./,:@%+=-]|'[^'\\]*'|"[^"$`\\]*")+$/.test(word),
		)
	)
		return undefined;
	return evaluatedShellWords(command);
}

function isReadOnlyActionlintCommand(command: string): boolean {
	const words = literalLintWords(command);
	if (!words) return false;
	const flags = [
		"-h",
		"-help",
		"-version",
		"-color",
		"-no-color",
		"-oneline",
		"-debug",
		"-verbose",
	];
	const valueOptions = [
		"-config-file",
		"-format",
		"-ignore",
		"-stdin-filename",
	];
	for (let index = 1; index < words.length; index++) {
		const word = words[index];
		if (word === "--") return true;
		if (word === "-" || !word.startsWith("-")) continue;
		const [option, ...parts] = word.replace(/^--/, "-").split("=");
		if (flags.includes(option)) {
			if (parts.length && !["true", "false"].includes(parts.join("=")))
				return false;
			continue;
		}
		if (
			!valueOptions.includes(option) &&
			option !== "-shellcheck" &&
			option !== "-pyflakes"
		)
			return false;
		const value = parts.length ? parts.join("=") : words[++index];
		if (value === undefined) return false;
		// External linters may only use their default command or be disabled.
		if (
			["-shellcheck", "-pyflakes"].includes(option) &&
			value !== "" &&
			value !== option.slice(1)
		)
			return false;
	}
	return true;
}

function isReadOnlyClangFormatCommand(command: string): boolean {
	const words = literalLintWords(command);
	// LLVM expands response files before parsing options, even quoted values.
	if (!words || words.some((word) => word.startsWith("@"))) return false;
	return hasOnlyInspectionOptions(
		words.slice(1).map((word) => word.replace(/^--/, "-")),
		[
			"-",
			"-h",
			"-help",
			"-help-hidden",
			"-help-list",
			"-help-list-hidden",
			"-version",
			"-Werror",
			"-dry-run",
			"-n",
			"-dump-config",
			"-fail-on-incomplete-format",
			"-output-replacements-xml",
			"-sort-includes",
			"-verbose",
		],
		{
			"-Wno-error": ["unknown"],
			"-assume-filename": null,
			"-cursor": null,
			"-fallback-style": null,
			"-ferror-limit": null,
			"-files": null,
			"-length": null,
			"-lines": null,
			"-offset": null,
			"-qualifier-alignment": null,
			"-sort-includes": ["true", "false"],
			"-style": null,
		},
	);
}

function isReadOnlyCodesignCommand(words: string[]): boolean {
	const args = words.slice(1).flatMap((word) => {
		if (/^-[dvh]+$/.test(word))
			return [...word.slice(1)].map((flag) => `-${flag}`);
		if (word === "-r-") return ["-r", "-"];
		return [word];
	});
	if (args.length === 1 && args[0] === "--help") return true;
	return (
		args.some((word) =>
			[
				"-d",
				"-v",
				"-h",
				"--display",
				"--verify",
				"--hosting",
				"--validate-constraint",
			].includes(word),
		) &&
		hasOnlyInspectionOptions(
			args,
			[
				"-d",
				"-v",
				"-h",
				"--display",
				"--verify",
				"--hosting",
				"--validate-constraint",
				"--verbose",
				"--deep",
				"--strict",
				"--all-architectures",
				"--continue",
				"--xml",
				"--der",
			],
			{
				"--verbose": ["0", "1", "2", "3", "4", "5", "6"],
				"--strict": null,
				"-a": null,
				"--architecture": null,
				"--bundle-version": null,
				"-R": null,
				"--test-requirement": null,
				"-r": ["-"],
				"--requirements": ["-"],
				"--entitlements": ["-", ":-"],
				"--file-list": ["-"],
			},
		)
	);
}

function isReadOnlySecurityCommand(words: string[]): boolean {
	const args = words.slice(2);
	switch (words[1]) {
		case "help":
			return args.every((word) => /^[a-z][a-z-]*$/.test(word));
		case "list-keychains":
		case "default-keychain":
		case "login-keychain":
			return hasOnlyInspectionOptions(
				args,
				["-h"],
				{ "-d": ["user", "system", "common", "dynamic"] },
				false,
			);
		case "find-identity":
			return hasOnlyInspectionOptions(args, ["-h", "-v"], {
				"-p": null,
				"-s": null,
			});
		case "find-certificate":
			return hasOnlyInspectionOptions(args, ["-h", "-a", "-m", "-p", "-Z"], {
				"-c": null,
				"-e": null,
			});
		case "show-keychain-info":
			return hasOnlyInspectionOptions(args, [], {});
		case "dump-trust-settings":
			return hasOnlyInspectionOptions(args, ["-s", "-d", "-h"], {}, false);
		case "list-smartcards":
			return args.length === 0;
		case "error":
			return args.length > 0 && args.every((word) => /^-?\d+$/.test(word));
		default:
			return false;
	}
}

function isReadOnlyOpenSSLCommand(words: string[]): boolean {
	const args = words.slice(2);
	const digests = [
		"-md5",
		"-sha1",
		"-sha224",
		"-sha256",
		"-sha384",
		"-sha512",
		"-sha3-256",
		"-sha3-512",
	];
	if (words[1] === "help") return args.length === 0;
	if (
		["version", "x509", "dgst", "verify"].includes(words[1]) &&
		args.length === 1 &&
		args[0] === "-help"
	)
		return true;
	switch (words[1]) {
		case "version":
			return hasOnlyInspectionOptions(
				args,
				["-a", "-v", "-b", "-o", "-f", "-p", "-d", "-e", "-m", "-r"],
				{},
				false,
			);
		case "x509":
			return hasOnlyInspectionOptions(
				args,
				[
					"-noout",
					"-text",
					"-fingerprint",
					"-serial",
					"-subject",
					"-issuer",
					"-dates",
					"-startdate",
					"-enddate",
					"-email",
					"-hash",
					"-subject_hash",
					"-issuer_hash",
					"-pubkey",
					"-modulus",
					"-purpose",
					"-ocsp_uri",
					...digests,
				],
				{
					"-in": null,
					"-inform": ["PEM", "DER"],
					"-nameopt": null,
					"-certopt": null,
					"-ext": null,
					"-checkend": null,
					"-checkhost": null,
					"-checkemail": null,
					"-checkip": null,
				},
				false,
			);
		case "dgst":
			return hasOnlyInspectionOptions(
				args,
				["-list", "-c", "-r", "-hex", "-binary", ...digests],
				{ "-verify": null, "-signature": null, "-keyform": ["PEM", "DER"] },
			);
		case "verify":
			return hasOnlyInspectionOptions(
				args,
				[
					"-verbose",
					"-show_chain",
					"-no-CAfile",
					"-no-CApath",
					"-no-CAstore",
					"-x509_strict",
					"-crl_check",
					"-crl_check_all",
					"-check_ss_sig",
					"-trusted_first",
					"-partial_chain",
				],
				{
					"-CAfile": null,
					"-CApath": null,
					"-trusted": null,
					"-untrusted": null,
					"-CRLfile": null,
					"-purpose": null,
					"-verify_hostname": null,
					"-verify_email": null,
					"-verify_ip": null,
					"-verify_depth": null,
					"-auth_level": null,
					"-attime": null,
				},
			);
		default:
			return false;
	}
}

function isReadOnlyDeveloperCommand(words: string[]): boolean {
	if (words.some((word) => /[$`\\\\"'*?[\]{}~]/.test(word))) return false;
	if (words[0] === "codesign") return isReadOnlyCodesignCommand(words);
	if (words[0] === "security") return isReadOnlySecurityCommand(words);
	if (words[0] === "openssl") return isReadOnlyOpenSSLCommand(words);
	return false;
}

function isReadOnlyCliCommand(command: string): boolean {
	const words = evaluatedShellWords(command);
	return (
		isReadOnlyManCommand(words) ||
		isReadOnlyResearchCliHelpCommand(words) ||
		isReadOnlyGhStackCommand(words) ||
		isReadOnlyGhHelpCommand(words) ||
		isReadOnlyApiHelpCommand(words) ||
		isReadOnlySentryHelpCommand(words) ||
		isReadOnlyApiCommand(words) ||
		isReadOnlyDeveloperCommand(words)
	);
}

function isBlockedGhCommand(words: string[]): boolean {
	if (
		isReadOnlyGhHelpCommand(words) ||
		isReadOnlyApiHelpCommand(words) ||
		isReadOnlyGhStackCommand(words)
	)
		return false;
	if (["-h", "--help"].includes(words.at(-1) ?? "")) return true;
	const resource = words[1];
	if (resource === undefined || resource.startsWith("-")) return false;

	if (resource === "api") return !isReadOnlyApiCommand(words);
	if (resource === "stack") return !isReadOnlyGhStackCommand(words);

	const action = words[2];
	if (action === undefined || action.startsWith("-")) return false;
	return BLOCKED_GH_ACTIONS.has(action);
}

function isReadOnlySentryInspectionCommand(command: string): boolean {
	const words = literalInspectionWords(command);
	if (!words) return false;
	const flags = ["--json", "--help", "-h"];
	const valueOptions = { "--fields": null };
	if (words[1] === "info") {
		return hasOnlyInspectionOptions(
			words.slice(2),
			[
				...flags,
				"--config-status-json",
				"--no-config-status-json",
				"--no-defaults",
				"--no-no-defaults",
			],
			valueOptions,
			false,
		);
	}
	if (words[1] === "status") {
		return hasOnlyInspectionOptions(
			words.slice(words[2] === "show" ? 3 : 2),
			flags,
			{ ...valueOptions, "--url": null },
			false,
		);
	}
	if (words[1] === "dsn") {
		return hasOnlyInspectionOptions(
			words.slice(3),
			[...flags, "--fresh", "-f"],
			{
				...valueOptions,
				"--limit": null,
				"-n": null,
				"--cursor": null,
				"-c": null,
			},
		);
	}
	if (words[1] === "proguard") {
		return hasOnlyInspectionOptions(words.slice(3), flags, valueOptions);
	}
	return hasOnlyInspectionOptions(
		words.slice(3),
		[...flags, "bash", "zsh", "fish"],
		valueOptions,
		false,
	);
}

function isReadOnlySentryHelpCommand(words: string[]): boolean {
	if (words[0] !== "sentry" || !["-h", "--help"].includes(words.at(-1) ?? ""))
		return false;
	if (isReadOnlyApiHelpCommand(words)) return true;
	const commandWords = words.slice(1, -1);
	if (!commandWords.every((word) => /^[a-z][a-z-]*$/.test(word))) return false;
	// Limit help to command paths, never operands or commands passed to local/monitor run.
	return (
		commandWords.length <= 2 ||
		(commandWords.length === 3 &&
			commandWords[0] === "alert" &&
			["issues", "metrics"].includes(commandWords[1]))
	);
}

function isBlockedSentryCommand(words: string[], command: string): boolean {
	if (["-h", "--help"].includes(words.at(-1) ?? ""))
		return !isReadOnlySentryHelpCommand(words);
	if (words[1] === "cli" && words[2] === "import") {
		return !(
			words.length === 4 &&
			["-h", "--help", "-n", "--dry-run"].includes(words[3])
		);
	}
	if (
		["info", "status"].includes(words[1]) ||
		(words[1] === "dsn" && ["list", "ls"].includes(words[2])) ||
		(words[1] === "proguard" && words[2] === "uuid") ||
		(words[1] === "cli" && words[2] === "completion")
	) {
		return !isReadOnlySentryInspectionCommand(command);
	}
	if (words[1] === "api") {
		return !(isReadOnlyApiHelpCommand(words) || isReadOnlyApiCommand(words));
	}
	if (words[1] !== "auth") return false;
	if (words[2] === "token") return true;
	return (
		words[2] === "status" &&
		words.slice(3).some((word) => word.startsWith("--show-token"))
	);
}

function isReadOnlyGitBranchCommand(args: string[]): boolean {
	if (args.some((word) => word.startsWith("@"))) return false;
	return hasOnlyInspectionOptions(
		args,
		[
			...args.filter((word) => /^-[arlvqi]+$/.test(word)),
			"--all",
			"--remotes",
			"--list",
			"--show-current",
			"--verbose",
			"--quiet",
			"--ignore-case",
			"--omit-empty",
			"--no-omit-empty",
			"--color",
			"--no-color",
			"--column",
			"--no-column",
			"--abbrev",
			"--no-abbrev",
		],
		{
			"--color": ["always", "auto", "never"],
			"--column": null,
			"--abbrev": /^\d+$/,
			"--contains": null,
			"--no-contains": null,
			"--merged": null,
			"--no-merged": null,
			"--points-at": null,
			"--sort": /^-?[^-].*$/,
			"--format": null,
		},
		args.some(
			(word) => word === "--list" || /^-[arlvqi]*l[arlvqi]*$/.test(word),
		),
	);
}

function isReadOnlyGitRemoteCommand(args: string[]): boolean {
	let index = 0;
	while (/^-v+$/.test(args[index] ?? "") || args[index] === "--verbose")
		index++;
	if (index === args.length) return true;
	return (
		args[index] === "show" &&
		!args.slice(index + 1).some((word) => word.startsWith("@")) &&
		hasOnlyInspectionOptions(args.slice(index + 1), ["-n"], {})
	);
}

function isReadOnlyGitTagCommand(args: string[]): boolean {
	if (args.some((word) => word.startsWith("@"))) return false;
	return hasOnlyInspectionOptions(
		args,
		[
			...args.filter((word) => /^-[li]+$/.test(word) || /^-n\d*$/.test(word)),
			"--list",
			"--ignore-case",
			"--omit-empty",
			"--no-omit-empty",
			"--column",
			"--no-column",
			"--color",
		],
		{
			"--color": ["always", "auto", "never"],
			"--column": null,
			"--contains": null,
			"--no-contains": null,
			"--merged": null,
			"--no-merged": null,
			"--points-at": null,
			"--sort": /^-?[^-].*$/,
			"--format": null,
		},
		args.some((word) => word === "--list" || /^-[li]*l[li]*$/.test(word)),
	);
}

function isReadOnlyGitConfigCommand(args: string[]): boolean {
	if (args.some((word) => word.startsWith("@"))) return false;
	return (
		args.some((word) => ["-l", "--list", "--get"].includes(word)) &&
		hasOnlyInspectionOptions(
			args,
			[
				"-l",
				"--list",
				"--get",
				"--global",
				"--system",
				"--local",
				"--worktree",
				"-z",
				"--null",
				"--name-only",
				"--show-origin",
				"--show-scope",
				"--includes",
				"--no-includes",
				"--fixed-value",
				"--bool",
				"--int",
				"--bool-or-int",
				"--bool-or-str",
				"--path",
				"--expiry-date",
			],
			{
				"-f": null,
				"--file": null,
				"--blob": null,
				"-t": [
					"bool",
					"int",
					"bool-or-int",
					"bool-or-str",
					"path",
					"expiry-date",
				],
				"--type": [
					"bool",
					"int",
					"bool-or-int",
					"bool-or-str",
					"path",
					"expiry-date",
				],
				"--default": null,
			},
			args.includes("--get"),
		)
	);
}

function isReadOnlyGitShortHelpCommand(words: string[]): boolean {
	// Unlike --help, -h prints usage without launching a configurable man viewer.
	return (
		words.length === 3 &&
		words[0] === "git" &&
		["branch", "remote", "tag", "config"].includes(words[1]) &&
		words[2] === "-h"
	);
}

function isReadOnlyGitInspectionCommand(command: string): boolean {
	const words = literalLintWords(command);
	if (words?.[0] !== "git") return false;
	if (isReadOnlyGitShortHelpCommand(words)) return true;
	const args = words.slice(2);
	if (words[1] === "remote") return isReadOnlyGitRemoteCommand(args);
	if (words[1] === "tag")
		return (
			isReadOnlyGitTagCommand(args) &&
			args.some((word) => word === "--list" || /^-[li]*l[li]*$/.test(word))
		);
	if (words[1] === "config") return isReadOnlyGitConfigCommand(args);
	if (words[1] !== "branch" || !isReadOnlyGitBranchCommand(args)) return false;
	return (
		args.some(
			(word) =>
				["--list", "--show-current"].includes(word) ||
				/^-[arlvqi]*l[arlvqi]*$/.test(word),
		) ||
		args.reduce(
			(count, word) =>
				count +
				(word === "--verbose"
					? 1
					: /^-[arlvqi]+$/.test(word)
						? [...word].filter((character) => character === "v").length
						: 0),
			0,
		) >= 2
	);
}

function hasShortOption(words: string[], options: string): boolean {
	return words.some(
		(word) =>
			/^-[^-]/.test(word) &&
			[...word.slice(1)].some((character) => options.includes(character)),
	);
}

function isBlockedCommand(command: string): boolean {
	const words = evaluatedShellWords(command);
	const name = words[0];
	if (name === undefined) return false;
	if (BLOCKED_FIRST_WORDS.has(name)) return true;
	if (name === "actionlint") return !isReadOnlyActionlintCommand(command);
	if (name === "clang-format") return !isReadOnlyClangFormatCommand(command);
	if (["codesign", "security", "openssl"].includes(name)) {
		return !isReadOnlyDeveloperCommand(words);
	}
	if (name === "apple-docs" || (name === "gh" && words[1] === "kit")) {
		return !(
			isReadOnlyResearchCliHelpCommand(words) ||
			RESEARCH_CLI_ALLOW_RULES.some((rule) => commandMatchesRule(command, rule))
		);
	}
	if (name === "man") return !isReadOnlyManCommand(words);
	if (name === "find") {
		return words
			.slice(1)
			.some((word) =>
				/^-delete$|^-exec(dir)?$|^-ok(dir)?$|^-fprint(0)?$|^-fprintf$|^-fls$/.test(
					word,
				),
			);
	}
	if (name === "sed") {
		const args = words.slice(1).filter((word) => word !== "-n");
		if (args[0] === "-E" || args[0] === "-r") args.shift();
		const script = args[0] ?? "";
		// Limit scripts to numeric prints or one slash-delimited substitution.
		// Only the optional global flag is allowed, never execution or writes.
		const isSafeScript =
			/^\d+(,\d+)?p$/.test(script) ||
			(!/[\r\n]/.test(script) &&
				/^s\/(?:[^/\\]|\\.)*\/(?:[^/\\]|\\.)*\/g?$/.test(script));
		return !isSafeScript || args.slice(1).some((word) => word.startsWith("-"));
	}
	const args = words.slice(1);
	if (name === "rg") {
		return args.some((word) => /^(--pre|--hostname-bin)(=|$)/.test(word));
	}
	if (name === "tree" || name === "base64") {
		return (
			hasShortOption(args, "o") ||
			args.some((word) => /^(--output)(=|$)/.test(word))
		);
	}
	if (name === "uniq") {
		return args.filter((word) => !word.startsWith("-")).length > 1;
	}
	if (name === "date") {
		return args.some(
			(word) =>
				!/^(-[jnuR]|-I(?:date|hours|minutes|seconds|ns)?|\+.*)$/.test(word),
		);
	}
	if (name === "yq") {
		return (
			hasShortOption(args, "is") ||
			args.some((word) =>
				/^(--inplace|--split-exp(?:-file)?|--security-enable-system-operator)(=|$)/.test(
					word,
				),
			)
		);
	}
	if (name === "sort") {
		return (
			hasShortOption(args, "oT") ||
			args.some((word) =>
				/^(--output|--compress-program|--temporary-directory)(=|$)/.test(word),
			)
		);
	}
	if (name === "git") {
		if (isReadOnlyGitShortHelpCommand(words)) return false;
		const subcommand = gitSubcommand(words);
		return (
			(subcommand !== undefined && BLOCKED_GIT_SUBCOMMANDS.has(subcommand)) ||
			subcommand === "fetch" ||
			(subcommand === "reflog" &&
				args.some((word) =>
					["expire", "delete", "drop", "write"].includes(word),
				)) ||
			(subcommand === "branch" &&
				!isReadOnlyGitBranchCommand(
					words.slice(words.indexOf(subcommand) + 1),
				)) ||
			(subcommand === "remote" &&
				!isReadOnlyGitRemoteCommand(
					words.slice(words.indexOf(subcommand) + 1),
				)) ||
			(subcommand === "config" &&
				!isReadOnlyGitConfigCommand(
					words.slice(words.indexOf(subcommand) + 1),
				)) ||
			(subcommand === "tag" &&
				!isReadOnlyGitTagCommand(words.slice(words.indexOf(subcommand) + 1))) ||
			args.some((word) =>
				/^(--output|--ext-diff|--textconv|--open-files-in-pager)(=|$)/.test(
					word,
				),
			) ||
			(subcommand === "grep" && args.includes("-O"))
		);
	}
	if (name === "gh") return isBlockedGhCommand(words);
	if (name === "sentry") return isBlockedSentryCommand(words, command);
	return false;
}

// Match device-dependent operations by word position. A glob for the device
// could also consume a mutating operation and mistake its argument for a query.
function isReadOnlySimctlCommand(command: string): boolean {
	const words = shellWords(command).map((word) =>
		word.replace(/^("|')|("|')$/g, ""),
	);
	if (words[0] !== "xcrun" || words[1] !== "simctl") return false;

	switch (words[2]) {
		case "io":
			return (
				(words.length === 5 && ["enumerate", "poll"].includes(words[4])) ||
				(words.length === 6 &&
					words[4] === "enumerate" &&
					words[5] === "--poll")
			);
		case "location":
			return words.length === 5 && words[4] === "list";
		case "ui":
			return (
				words.length === 5 &&
				["appearance", "increase_contrast", "content_size"].includes(words[4])
			);
		case "runtime": {
			const listIndex = words[3] === "match" ? 4 : 3;
			return (
				words[listIndex] === "list" &&
				words
					.slice(listIndex + 1)
					.every((word) => ["-v", "-j", "--json"].includes(word))
			);
		}
		default:
			return false;
	}
}

// Match the directory as one word so it cannot consume another subcommand.
function isReadOnlyGitDirectoryCommand(command: string): boolean {
	const words = shellWords(command);
	return (
		words[0] === "git" &&
		words[1] === "-C" &&
		["diff", "log", "status"].includes(words[3]) &&
		!words.slice(0, 4).some((word) => word.includes("\\"))
	);
}

// Accept literal arguments only, without interpreting expansions or concatenated
// quoting. Quoted pgrep patterns may contain regular-expression metacharacters.
function literalInspectionWords(command: string): string[] | undefined {
	const words = shellWords(command);
	if (
		!words.every((word) =>
			/^(?:[A-Za-z0-9_./,:@%+=-]+|'[^'\\]*'|"[^"$`\\]*")$/.test(word),
		)
	)
		return undefined;
	return words.map((word) =>
		word.startsWith("'") || word.startsWith('"') ? word.slice(1, -1) : word,
	);
}

function isReadOnlyProcessOrManualCommand(command: string): boolean {
	const words = literalInspectionWords(command);
	if (!words) return false;

	if (words[0] === "man") return isReadOnlyManCommand(words);

	if (words[0] !== "pgrep") return false;
	let index = 1;
	let endOfOptions = false;
	for (; index < words.length; index++) {
		const word = words[index];
		if (word === "--") {
			endOfOptions = true;
			index++;
			break;
		}
		if (!word.startsWith("-")) break;
		if (/^-[afilnoqvx]+$/.test(word)) continue;
		if (
			/^-[GPUgpu]$/.test(word) &&
			/^\d+(,\d+)*$/.test(words[index + 1] ?? "")
		) {
			index++;
			continue;
		}
		return false;
	}
	return (
		index < words.length &&
		words
			.slice(index)
			.every(
				(word) => word.length > 0 && (endOfOptions || !word.startsWith("-")),
			)
	);
}

// Mixed-purpose utilities need argument checks rather than prefix rules.
function isReadOnlyMacOSCommand(command: string): boolean {
	const words = shellWords(command).map((word) =>
		word.replace(/^("|')|("|')$/g, ""),
	);
	if (words.some((word) => /[$`\\\\"'*?[\]{}~]/.test(word))) return false;
	const [name, operation, ...arguments_] = words;

	if (name === "lipo" || name === "plutil") {
		const operations =
			name === "lipo" ? ["-info", "-archs", "-detailed_info"] : ["-p", "-lint"];
		if (!operations.includes(operation)) return false;
		if (name === "plutil" && arguments_[0] === "--") {
			return arguments_.length > 1;
		}
		return (
			arguments_.length > 0 &&
			arguments_.every((word) => word.length > 0 && !word.startsWith("-"))
		);
	}

	if (name !== "ps") return false;
	for (let index = 1; index < words.length; index++) {
		const word = words[index];
		if (word === "-p") {
			if (!/^\d+(,\d+)*$/.test(words[++index] ?? "")) return false;
		} else if (/^-[AaCcdefhjlMmrSTvwXx]*[oO]/.test(word)) {
			const attachedFields = word.replace(/^-[AaCcdefhjlMmrSTvwXx]*[oO]/, "");
			const fields = (attachedFields || words[++index] || "").split(",");
			if (
				!fields.every((field) =>
					[
						"pid",
						"ppid",
						"pgid",
						"uid",
						"user",
						"comm",
						"command",
						"args",
						"%cpu",
						"pcpu",
						"%mem",
						"stat",
						"state",
						"lstart",
						"etime",
						"time",
						"tty",
					].includes(field),
				)
			)
				return false;
		} else if (
			!/^-[AaCcdefhjlMmrSTvwXx]+$/.test(word) &&
			!/^[acflmrSuvwx]+$/.test(word)
		) {
			return false;
		}
	}
	return true;
}

function isAllowedSimpleCommand(
	command: string,
	rules: string[],
	cwd: string,
	sessionRules: ReadonlySet<string>,
): boolean {
	const parsed = parsedSimpleShellCommand(command, cwd);
	return (
		parsed !== undefined &&
		!isBlockedCommand(parsed.command) &&
		(isReadOnlyProcessOrManualCommand(parsed.command) ||
			isReadOnlyMacOSCommand(parsed.command) ||
			isReadOnlyCliCommand(parsed.command) ||
			isReadOnlySimctlCommand(parsed.command) ||
			isReadOnlyGitDirectoryCommand(parsed.command) ||
			isReadOnlyGitInspectionCommand(parsed.command) ||
			[...rules, ...sessionRules].some((rule) =>
				commandMatchesRule(parsed.command, rule),
			))
	);
}

function shellWords(command: string): string[] {
	return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
}

// Only use after syntax validation: evaluate quoting and line continuations,
// not expansions, so command classification matches the shell's argument values.
function evaluatedShellWords(command: string): string[] {
	const words: string[] = [];
	let quote: "'" | '"' | undefined;
	let word: string | undefined;
	for (let index = 0; index < command.length; index++) {
		const character = command[index];
		if (quote === "'") {
			if (character === "'") quote = undefined;
			else word += character;
		} else if (character === "\\" && command[index + 1] === "\n") {
			index++;
		} else if (quote === '"') {
			if (character === '"') quote = undefined;
			else word += character;
		} else if (character === "'" || character === '"') {
			quote = character;
			word ??= "";
		} else if (/\s/.test(character)) {
			if (word !== undefined) words.push(word);
			word = undefined;
		} else {
			word = (word ?? "") + character;
		}
	}
	if (word !== undefined) words.push(word);
	return words;
}

function commandMatchesEvaluatedRule(command: string, rule: string): boolean {
	const isPrefix = rule.endsWith(":*") || rule.endsWith(" *");
	const ruleCommand = isPrefix ? rule.slice(0, -2) : rule;
	if (splitShellCommands(ruleCommand)?.length !== 1) return false;

	// Serialize each argument so quoted spaces, empty arguments, and literal
	// quotes cannot be confused with different argument boundaries or values.
	const serializeWords = (value: string) =>
		evaluatedShellWords(value)
			.map((word) => JSON.stringify(word))
			.join(" ");
	return commandMatchesRule(
		serializeWords(command),
		serializeWords(ruleCommand) + (isPrefix ? ":*" : ""),
	);
}

function suggestedRule(command: string): string {
	const words = shellWords(command);
	if (words.length >= 3) return `${words.slice(0, 3).join(" ")} *`;
	if (words.length >= 2) return `${words.slice(0, 2).join(" ")} *`;
	return command;
}

function normalizeRule(input: string, tool: PermissionTool): string {
	const trimmed = input.trim();
	return trimmed.startsWith(`${tool}(`) && trimmed.endsWith(")")
		? trimmed
		: `${tool}(${trimmed})`;
}

function appendLocalRule(cwd: string, entry: string): string {
	const settingsPath = localPermissionsPath(cwd);
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

	const settings = fs.existsSync(settingsPath)
		? readJsonObject(settingsPath)
		: {};
	const permissions = ensureObject(
		settings.permissions,
		`${settingsPath}.permissions`,
	);
	const entries = [
		...ensureArray(permissions.allow, `${settingsPath}.permissions.allow`),
	];
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
			? "Esc to cancel · Permission rules can be amended before applying"
			: "Esc to cancel",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

// Run only in the interruptible worker. All shell parsing and rule matching
// stays behind this boundary, including the work used to prepare approval UI.
export function evaluateBashPermissions({
	command,
	cwd,
	allowRules,
	denyRules,
	sessionRules,
}: BashPermissionRequest): BashPermissionResult {
	const commands = splitShellCommands(command);
	const commandCandidates = commands?.length ? commands : [command];
	const deniedRule = denyRules.find((rule) =>
		commandCandidates.some((candidate) => {
			const executableCommand = parseOutputRedirections(candidate)?.command;
			return (
				commandMatchesRule(candidate, rule) ||
				(executableCommand !== undefined &&
					(commandMatchesRule(executableCommand, rule) ||
						(commands !== undefined &&
							commandMatchesEvaluatedRule(executableCommand, rule))))
			);
		}),
	);
	if (deniedRule) return { deniedRule, commands: [] };
	return {
		commands: commandCandidates.map((candidate) => {
			const allowed =
				commands !== undefined &&
				isAllowedSimpleCommand(
					candidate,
					allowRules,
					cwd,
					new Set(sessionRules),
				);
			if (allowed) {
				return {
					command: candidate,
					allowed,
					sessionApprovable: false,
					defaultRule: "",
				};
			}
			const parsed = parsedSimpleShellCommand(candidate, cwd);
			return {
				command: candidate,
				allowed,
				parsedCommand: parsed?.command,
				sessionApprovable:
					parsed !== undefined && !isBlockedCommand(parsed.command),
				defaultRule: suggestedRule(parsed?.command ?? candidate),
			};
		}),
	};
}

export default function permissionsExtension(pi: ExtensionAPI) {
	let approvalQueue = Promise.resolve();
	let sessionApprovals = new Map<string, Set<string>>();
	let mcpSessionApprovals = new Map<string, Set<string>>();

	const resetSessionApprovals = () => {
		// Replace the maps so pending approvals cannot carry into another session.
		sessionApprovals = new Map();
		mcpSessionApprovals = new Map();
	};
	pi.on("session_start", resetSessionApprovals);
	pi.on("session_shutdown", resetSessionApprovals);

	pi.on("tool_call", async (event, ctx) => {
		if (
			event.toolName.startsWith("mcp__") ||
			MCP_RESOURCE_TOOLS.has(event.toolName)
		) {
			const approvals = mcpSessionApprovals;
			let sessionRules = approvals.get(ctx.cwd);
			if (!sessionRules) {
				sessionRules = new Set();
				approvals.set(ctx.cwd, sessionRules);
			}
			const approval = approvalQueue.then(async () => {
				const sessionChanged = {
					block: true,
					reason: "Session changed during permission approval",
				};
				if (approvals !== mcpSessionApprovals) return sessionChanged;

				const deniedRule = permissionRules(ctx.cwd, "deny", "MCP").find(
					(rule) => globMatches(rule, event.toolName),
				);
				if (deniedRule !== undefined) {
					return {
						block: true,
						reason: `MCP tool matches deny rule "MCP(${deniedRule})"`,
					};
				}
				const requiresApproval = permissionRules(ctx.cwd, "ask", "MCP").some(
					(rule) => globMatches(rule, event.toolName),
				);
				if (
					!requiresApproval &&
					[...permissionRules(ctx.cwd, "allow", "MCP"), ...sessionRules].some(
						(rule) => globMatches(rule, event.toolName),
					)
				)
					return undefined;

				if (!ctx.hasUI) {
					return {
						block: true,
						reason: requiresApproval
							? "MCP tool requires approval and no UI is available."
							: "MCP tool is not allowed by configured permissions and no UI is available.",
					};
				}

				const saveChoice = `Yes, and don’t ask again for: MCP(${event.toolName})`;
				const sessionChoice = "Allow for this session";
				const choice = await ctx.ui.select(
					[
						"MCP tool",
						"",
						event.toolName,
						JSON.stringify(event.input, null, 2),
						"",
						"This tool requires approval",
						"",
						"Do you want to proceed?",
					].join("\n"),
					requiresApproval
						? ["Yes", "No"]
						: ["Yes", saveChoice, sessionChoice, "No"],
				);
				if (approvals !== mcpSessionApprovals) return sessionChanged;
				if (choice === "Yes") return undefined;

				if (
					!requiresApproval &&
					(choice === saveChoice || choice === sessionChoice)
				) {
					const editedRule = await ctx.ui.editor(
						"Amend MCP permission rule",
						event.toolName,
					);
					if (approvals !== mcpSessionApprovals) return sessionChanged;
					if (!editedRule?.trim()) {
						return { block: true, reason: "Permission rule save cancelled" };
					}
					const rule = normalizeRule(editedRule, "MCP");
					if (choice === sessionChoice) {
						sessionRules.add(rule.slice(4, -1));
						return undefined;
					}
					try {
						const settingsPath = appendLocalRule(ctx.cwd, rule);
						ctx.ui.notify(`Saved ${rule} to ${settingsPath}`, "info");
						return undefined;
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
			});
			approvalQueue = approval.then(
				() => undefined,
				() => undefined,
			);
			return approval;
		}

		if (event.toolName !== "bash" && event.toolName !== "background")
			return undefined;

		let cwd = ctx.cwd;
		let input = event.input as {
			action?: unknown;
			name?: unknown;
			command?: unknown;
			description?: unknown;
		};
		if (event.toolName === "background") {
			if (input.action === "restart") {
				const job = backgroundJobCommand(String(input.name ?? ""));
				cwd = job.cwd;
				input = { command: job.command };
			} else if (input.action !== "start") {
				return undefined;
			}
		}

		const approvals = sessionApprovals;
		let sessionRules = approvals.get(cwd);
		if (!sessionRules) {
			sessionRules = new Set();
			approvals.set(cwd, sessionRules);
		}
		const command = String(input.command ?? "");
		const rules = bashAllowRules(cwd);
		const denyRules = bashDenyRules(cwd);
		const check = (candidate: string) =>
			checkBashPermissions({
				command: candidate,
				cwd,
				allowRules: rules,
				denyRules,
				sessionRules: [...sessionRules],
			});
		const approveFailedCheck = async (error: unknown) => {
			const reason =
				error instanceof Error ? error.message : "Bash permission check failed";
			if (approvals !== sessionApprovals)
				return {
					block: true,
					reason: "Session changed during permission approval",
				};
			if (!ctx.hasUI)
				return { block: true, reason: `${reason}. No UI is available.` };
			ctx.ui.notify(reason, "error");
			const choice = await ctx.ui.select(
				approvalMessage(command, reason, false),
				["Yes", "No"],
			);
			if (approvals !== sessionApprovals)
				return {
					block: true,
					reason: "Session changed during permission approval",
				};
			if (choice === "Yes") return undefined;
			return { block: true, reason: "Blocked by user" };
		};
		let checked: BashPermissionResult;
		try {
			checked = await check(command);
		} catch (error) {
			const approval = approvalQueue.then(() => approveFailedCheck(error));
			approvalQueue = approval.then(
				() => undefined,
				() => undefined,
			);
			return approval;
		}
		if (approvals !== sessionApprovals)
			return {
				block: true,
				reason: "Session changed during permission approval",
			};
		const { deniedRule } = checked;
		if (deniedRule) {
			return {
				block: true,
				reason: `Bash command matches deny rule "${normalizeRule(deniedRule, "Bash")}"`,
			};
		}

		if (checked.commands.every((candidate) => candidate.allowed))
			return undefined;

		if (!ctx.hasUI) {
			return {
				block: true,
				reason:
					"Bash command is not allowed by configured permissions and no UI is available.",
			};
		}

		const approval = approvalQueue.then(async () => {
			const sessionChanged = {
				block: true,
				reason: "Session changed during permission approval",
			};
			if (approvals !== sessionApprovals) return sessionChanged;

			for (const candidate of checked.commands) {
				const commandToApprove = candidate.command;
				// Recheck in the worker so earlier approvals cover queued calls and
				// repeated stages without running unbounded parsing on the UI thread.
				let current: BashPermissionResult;
				try {
					current = await check(commandToApprove);
				} catch (error) {
					return approveFailedCheck(error);
				}
				if (approvals !== sessionApprovals) return sessionChanged;
				if (current.deniedRule) {
					return {
						block: true,
						reason: `Bash command matches deny rule "${normalizeRule(current.deniedRule, "Bash")}"`,
					};
				}
				const stage = current.commands[0];
				if (stage.allowed) continue;
				// Save only executable commands whose syntax and output paths passed validation.
				const amendable = stage.parsedCommand !== undefined;
				const { sessionApprovable, defaultRule } = stage;
				const sessionChoice = "Allow for this session";
				const saveChoice = `Yes, and don’t ask again for: ${defaultRule}`;
				const choice = await ctx.ui.select(
					approvalMessage(
						commandToApprove,
						typeof input.description === "string"
							? input.description
							: undefined,
						amendable,
					),
					[
						"Yes",
						...(amendable ? [saveChoice] : []),
						...(sessionApprovable ? [sessionChoice] : []),
						"No",
					],
				);
				if (approvals !== sessionApprovals) return sessionChanged;

				if (choice === "Yes") continue;

				const allowForSession = choice === sessionChoice && sessionApprovable;
				if (choice === saveChoice || allowForSession) {
					const editedRule = await ctx.ui.editor(
						"Amend Bash permission rule",
						defaultRule,
					);
					if (approvals !== sessionApprovals) return sessionChanged;
					if (!editedRule?.trim()) {
						return { block: true, reason: "Permission rule save cancelled" };
					}

					if (allowForSession) {
						sessionRules.add(normalizeRule(editedRule, "Bash").slice(5, -1));
						continue;
					}

					try {
						const rule = normalizeRule(editedRule, "Bash");
						const settingsPath = appendLocalRule(cwd, rule);
						ctx.ui.notify(`Saved ${rule} to ${settingsPath}`, "info");
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
