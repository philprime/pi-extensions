import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type BashPermissionResult,
	checkBashPermissions,
} from "./bash-permission-check.ts";
import { DEFAULT_ALLOW_RULES, globMatches } from "./bash-permission-parser.ts";
import { backgroundJobCommand } from "./run.ts";

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
