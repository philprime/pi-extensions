import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import permissionsExtension from "../extensions/permissions.ts";

type ToolCallHandler = (
	event: {
		toolName?: string;
		input?: unknown;
		reason?: string;
		toolCallId?: string;
		parentToolCallId?: string;
	},
	ctx: unknown,
) => Promise<unknown>;

const temporaryDirectories: string[] = [];

function createEmptyProject(baseDirectory = os.tmpdir()): string {
	const projectDirectory = fs.mkdtempSync(
		path.join(baseDirectory, "permissions-test-"),
	);
	temporaryDirectories.push(projectDirectory);
	return projectDirectory;
}

function createProject(allow: string[]): string {
	const projectDirectory = createEmptyProject();
	writePiPermissions(projectDirectory, {
		allow: allow.map((rule) => `Bash(${rule})`),
	});
	return projectDirectory;
}

function writePiPermissions(
	projectDirectory: string,
	permissions: { allow?: string[]; ask?: string[]; deny?: string[] },
	fileName = "permissions.json",
): string {
	const settingsDirectory = path.join(projectDirectory, ".pi");
	fs.mkdirSync(settingsDirectory, { recursive: true });
	const settingsPath = path.join(settingsDirectory, fileName);
	fs.writeFileSync(settingsPath, JSON.stringify({ permissions }));
	return settingsPath;
}

function createHandlers(): Map<string, ToolCallHandler> {
	const handlers = new Map<string, ToolCallHandler>();
	permissionsExtension({
		on(eventName: string, callback: ToolCallHandler) {
			handlers.set(eventName, callback);
		},
	} as never);
	return handlers;
}

function createHandler(): ToolCallHandler {
	const handler = createHandlers().get("tool_call");
	assert.ok(
		handler,
		"permissions extension should register a tool_call handler",
	);
	return handler;
}

async function invoke(
	command: string,
	cwd: string,
	selectChoices: string[] = ["No"],
	editedRule?: string | null,
	handler = createHandler(),
) {
	return invokeTool(
		{ toolName: "bash", input: { command } },
		cwd,
		selectChoices,
		editedRule,
		handler,
	);
}

async function invokeTool(
	event: Parameters<ToolCallHandler>[0],
	cwd: string,
	selectChoices: string[] = ["No"],
	editedRule?: string | null,
	handler = createHandler(),
): Promise<{
	result: unknown;
	selectCalls: Array<{ message: string; options: string[] }>;
	editorCalls: Array<{ title: string; initialValue: string }>;
	notifications: Array<{ message: string; level: string }>;
}> {
	const selectCalls: Array<{ message: string; options: string[] }> = [];
	const editorCalls: Array<{ title: string; initialValue: string }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const result = await handler(event, {
		cwd,
		hasUI: true,
		ui: {
			select: async (message: string, options: string[]) => {
				selectCalls.push({ message, options });
				return selectChoices.shift();
			},
			editor: async (title: string, initialValue: string) => {
				editorCalls.push({ title, initialValue });
				return editedRule === null ? undefined : (editedRule ?? initialValue);
			},
			notify: (message: string, level: string) => {
				notifications.push({ message, level });
			},
		},
	});
	return { result, selectCalls, editorCalls, notifications };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("session approval can use an exact rule without persisting it", async () => {
	const cwd = createProject([]);
	const handler = createHandler();
	const settingsPath = path.join(cwd, ".pi", "permissions.json");
	const originalSettings = fs.readFileSync(settingsPath, "utf8");
	const command = "session-tool run first";
	const first = await invoke(
		command,
		cwd,
		["Allow for this session"],
		command,
		handler,
	);
	assert.equal(first.result, undefined);
	assert.ok(first.selectCalls[0].options.includes("Allow for this session"));

	const repeated = await invoke(command, cwd, [], undefined, handler);
	assert.equal(repeated.result, undefined);
	assert.deepEqual(repeated.selectCalls, []);
	assert.equal(
		fs.existsSync(path.join(cwd, ".pi", "permissions.local.json")),
		false,
	);
	assert.equal(fs.readFileSync(settingsPath, "utf8"), originalSettings);

	for (const [candidate, directory, activeHandler] of [
		['session-tool run "other"', cwd, handler],
		[command, createProject([]), handler],
		[command, cwd, createHandler()],
	] as const) {
		const denied = await invoke(
			candidate,
			directory,
			["No"],
			undefined,
			activeHandler,
		);
		assert.deepEqual(denied.result, { block: true, reason: "Blocked by user" });
		assert.equal(denied.selectCalls.length, 1);
	}
});

for (const rule of [
	"session-tool run *",
	"session-tool run:*",
	"  Bash(session-tool run *)  ",
]) {
	test(`session approval edits and matches rule ${rule}`, async () => {
		const cwd = createProject([]);
		const handler = createHandler();
		const command = "session-tool run first > output.log";
		const first = await invoke(
			command,
			cwd,
			["Allow for this session"],
			rule,
			handler,
		);
		assert.equal(first.result, undefined);
		assert.deepEqual(first.editorCalls, [
			{
				title: "Amend Bash permission rule",
				initialValue: "session-tool run first *",
			},
		]);
		const repeated = await invoke(
			"session-tool run second",
			cwd,
			[],
			undefined,
			handler,
		);
		assert.equal(repeated.result, undefined);
		assert.deepEqual(repeated.selectCalls, []);
		const denied = await invoke(
			"session-tool other second",
			cwd,
			["No"],
			undefined,
			handler,
		);
		assert.deepEqual(denied.result, { block: true, reason: "Blocked by user" });
		assert.equal(
			fs.existsSync(path.join(cwd, ".pi", "permissions.local.json")),
			false,
		);
	});
}

for (const editedRule of [null, "", "   "]) {
	test(`cancelling or emptying the session rule blocks approval (${JSON.stringify(editedRule)})`, async () => {
		const cwd = createProject([]);
		const handler = createHandler();
		const first = await invoke(
			"session-tool",
			cwd,
			["Allow for this session"],
			editedRule,
			handler,
		);
		assert.deepEqual(first.result, {
			block: true,
			reason: "Permission rule save cancelled",
		});
		const repeated = await invoke(
			"session-tool",
			cwd,
			["No"],
			undefined,
			handler,
		);
		assert.deepEqual(repeated.result, {
			block: true,
			reason: "Blocked by user",
		});
		assert.equal(
			fs.existsSync(path.join(cwd, ".pi", "permissions.local.json")),
			false,
		);
	});
}

test("broad session rules preserve deny rules, always-prompt commands, and syntax checks", async () => {
	const cwd = createProject([]);
	const handler = createHandler();
	assert.equal(
		(
			await invoke(
				"session-tool",
				cwd,
				["Allow for this session"],
				"*",
				handler,
			)
		).result,
		undefined,
	);
	assert.equal(
		(await invoke("other-tool", cwd, [], undefined, handler)).result,
		undefined,
	);
	writePiPermissions(cwd, { deny: ["Bash(denied-tool)"] });
	const denied = await invoke("denied-tool", cwd, [], undefined, handler);
	assert.deepEqual(denied.result, {
		block: true,
		reason: 'Bash command matches deny rule "Bash(denied-tool)"',
	});
	for (const command of [
		"git push",
		"rm file",
		"echo $(date)",
		"session-tool > .hidden",
	]) {
		const blocked = await invoke(command, cwd, ["No"], undefined, handler);
		assert.deepEqual(blocked.result, {
			block: true,
			reason: "Blocked by user",
		});
		assert.equal(blocked.selectCalls.length, 1);
	}
});

test("session changes during rule editing discard the approval", async () => {
	const cwd = createProject([]);
	const handlers = createHandlers();
	const handler = handlers.get("tool_call");
	assert.ok(handler);
	const result = await handler(
		{ toolName: "bash", input: { command: "session-tool" } },
		{
			cwd,
			hasUI: true,
			ui: {
				select: async () => "Allow for this session",
				editor: async () => {
					await handlers.get("session_shutdown")?.({ reason: "new" }, { cwd });
					return "session-tool *";
				},
			},
		},
	);
	assert.deepEqual(result, {
		block: true,
		reason: "Session changed during permission approval",
	});
	const repeated = await invoke(
		"session-tool",
		cwd,
		["No"],
		undefined,
		handler,
	);
	assert.deepEqual(repeated.result, { block: true, reason: "Blocked by user" });
});

for (const eventName of ["session_start", "session_shutdown"]) {
	for (const reason of ["startup", "reload", "new", "resume", "fork", "quit"]) {
		if (eventName === "session_start" && reason === "quit") continue;
		if (eventName === "session_shutdown" && reason === "startup") continue;
		test(`discards session approval on ${eventName}: ${reason}`, async () => {
			const cwd = createProject([]);
			const handlers = createHandlers();
			const handler = handlers.get("tool_call");
			assert.ok(handler);
			assert.equal(
				(
					await invoke(
						"session-tool",
						cwd,
						["Allow for this session"],
						undefined,
						handler,
					)
				).result,
				undefined,
			);
			const lifecycleHandler = handlers.get(eventName);
			assert.ok(lifecycleHandler);
			await lifecycleHandler({ reason }, { cwd });
			const repeated = await invoke(
				"session-tool",
				cwd,
				["No"],
				undefined,
				handler,
			);
			assert.deepEqual(repeated.result, {
				block: true,
				reason: "Blocked by user",
			});
		});
	}
}

test("session approvals survive turns and compaction", async () => {
	const cwd = createProject([]);
	const handlers = createHandlers();
	const handler = handlers.get("tool_call");
	assert.ok(handler);
	assert.equal(
		(
			await invoke(
				"session-tool",
				cwd,
				["Allow for this session"],
				undefined,
				handler,
			)
		).result,
		undefined,
	);
	for (const eventName of ["turn_end", "agent_end", "session_compact"]) {
		await handlers.get(eventName)?.({}, { cwd });
	}
	const repeated = await invoke("session-tool", cwd, [], undefined, handler);
	assert.equal(repeated.result, undefined);
	assert.deepEqual(repeated.selectCalls, []);
});

test("session approval never overrides a newly configured deny rule", async () => {
	const cwd = createProject([]);
	const handler = createHandler();
	assert.equal(
		(
			await invoke(
				"session-tool",
				cwd,
				["Allow for this session"],
				undefined,
				handler,
			)
		).result,
		undefined,
	);
	writePiPermissions(cwd, { deny: ["Bash(session-tool)"] });
	const denied = await invoke("session-tool", cwd, [], undefined, handler);
	assert.deepEqual(denied.result, {
		block: true,
		reason: 'Bash command matches deny rule "Bash(session-tool)"',
	});
	assert.deepEqual(denied.selectCalls, []);
});

test("does not offer session approval for always-prompt commands or unsafe syntax", async () => {
	const cwd = createProject([]);
	for (const command of [
		"rm file",
		"git push",
		"gh pr create --fill",
		"echo $(date)",
		"session-tool > .hidden",
	]) {
		const denied = await invoke(command, cwd, ["Allow for this session"]);
		assert.deepEqual(denied.result, { block: true, reason: "Blocked by user" });
		assert.equal(
			denied.selectCalls[0].options.includes("Allow for this session"),
			false,
		);
	}
});

test("session approval rechecks output safety and supports calls without a UI", async () => {
	const cwd = createProject([]);
	const handler = createHandler();
	const command = "session-tool > output.log";
	assert.equal(
		(await invoke(command, cwd, ["Allow for this session"], undefined, handler))
			.result,
		undefined,
	);
	assert.equal(
		await handler(
			{ toolName: "bash", input: { command } },
			{ cwd, hasUI: false },
		),
		undefined,
	);
	fs.writeFileSync(path.join(cwd, "output.log"), "existing content");
	const denied = await invoke(command, cwd, ["No"], undefined, handler);
	assert.deepEqual(denied.result, { block: true, reason: "Blocked by user" });
	assert.equal(
		denied.selectCalls[0].options.includes("Allow for this session"),
		false,
	);
});

test("session approvals apply immediately within compound commands without approving other stages", async () => {
	const cwd = createProject([]);
	const handler = createHandler();
	const approved = await invoke(
		"session-tool | session-tool",
		cwd,
		["Allow for this session"],
		undefined,
		handler,
	);
	assert.equal(approved.result, undefined);
	assert.equal(approved.selectCalls.length, 1);
	const denied = await invoke(
		"session-tool && other-tool",
		cwd,
		["No"],
		undefined,
		handler,
	);
	assert.deepEqual(denied.result, { block: true, reason: "Blocked by user" });
	assert.equal(denied.selectCalls.length, 1);
	assert.match(denied.selectCalls[0].message, /other-tool/);
});

test("queued calls reuse newly granted session approval", async () => {
	const cwd = createProject([]);
	const handler = createHandler();
	const results = await Promise.all([
		invoke("session-tool", cwd, ["Allow for this session"], undefined, handler),
		invoke("session-tool", cwd, ["No"], undefined, handler),
	]);
	assert.equal(results[0].result, undefined);
	assert.equal(results[1].result, undefined);
	assert.deepEqual(results[1].selectCalls, []);
});

test("session changes invalidate outstanding approvals and queued calls", async () => {
	const cwd = createProject([]);
	const handlers = createHandlers();
	const handler = handlers.get("tool_call");
	assert.ok(handler);
	const pending = handler(
		{ toolName: "bash", input: { command: "session-tool" } },
		{
			cwd,
			hasUI: true,
			ui: {
				select: async () => {
					await handlers.get("session_shutdown")?.({ reason: "new" }, { cwd });
					return "Allow for this session";
				},
			},
		},
	);
	const queued = invoke("other-tool", cwd, ["Yes"], undefined, handler);
	assert.deepEqual(await pending, {
		block: true,
		reason: "Session changed during permission approval",
	});
	assert.deepEqual((await queued).result, {
		block: true,
		reason: "Session changed during permission approval",
	});
	assert.deepEqual(
		(await invoke("session-tool", cwd, ["No"], undefined, handler)).result,
		{ block: true, reason: "Blocked by user" },
	);
});

test("allows a simple command matching a Bash allow rule", async () => {
	const projectDirectory = createProject(["git add *"]);
	const { result, selectCalls } = await invoke(
		"git add Sources/Sentry/SentryClient.m",
		projectDirectory,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectCalls, []);
});

describe("MCP permissions", () => {
	const toolName = "mcp__linear__get_issue";
	const event = { toolName, input: { id: "issue-123" } };
	const saveChoice = `Yes, and don’t ask again for: MCP(${toolName})`;

	beforeEach(() => {
		vi.stubEnv("HOME", createEmptyProject());
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	for (const parentToolCallId of [undefined, "codemode-call"]) {
		test(`prompts for an unmatched ${parentToolCallId ? "nested" : "direct"} MCP call`, async () => {
			const { result, selectCalls } = await invokeTool(
				{
					...event,
					toolCallId: parentToolCallId ? "codemode-call/1" : "call",
					parentToolCallId,
				},
				createProject([]),
			);
			assert.deepEqual(result, { block: true, reason: "Blocked by user" });
			assert.equal(selectCalls.length, 1);
			assert.match(selectCalls[0].message, /MCP tool/);
			assert.match(selectCalls[0].message, /mcp__linear__get_issue/);
			assert.match(selectCalls[0].message, /issue-123/);
			assert.deepEqual(selectCalls[0].options, [
				"Yes",
				saveChoice,
				"Allow for this session",
				"No",
			]);
		});
	}

	for (const call of [
		event,
		{ toolName: "list_mcp_resources", input: {} },
		{ toolName: "list_mcp_resource_templates", input: {} },
		{
			toolName: "read_mcp_resource",
			input: { server: "example", uri: "file:///readme.txt" },
		},
	]) {
		test(`fails closed without UI for ${call.toolName}`, async () => {
			const result = await createHandler()(call, {
				cwd: createProject([]),
				hasUI: false,
			});
			assert.deepEqual(result, {
				block: true,
				reason:
					"MCP tool is not allowed by configured permissions and no UI is available.",
			});
		});
	}

	for (const scope of ["project", "global"]) {
		for (const fileName of ["permissions.json", "permissions.local.json"]) {
			test(`reads MCP rules from ${scope} ${fileName}`, async () => {
				const cwd = createEmptyProject();
				const directory =
					scope === "project"
						? path.join(cwd, ".pi")
						: path.join(os.homedir(), ".pi", "agent");
				fs.mkdirSync(directory, { recursive: true });
				fs.writeFileSync(
					path.join(directory, fileName),
					JSON.stringify({
						permissions: { allow: [`MCP(${toolName})`] },
					}),
				);
				const result = await createHandler()(event, { cwd, hasUI: false });
				assert.equal(result, undefined);
			});
		}
	}

	for (const pattern of [toolName, "mcp__linear__*", "mcp__linear__get_*"]) {
		test(`matches MCP pattern ${pattern} without crossing tool or server boundaries`, async () => {
			const cwd = createEmptyProject();
			writePiPermissions(cwd, { allow: [`MCP(${pattern})`] });
			const allowed = await invokeTool(event, cwd);
			assert.equal(allowed.result, undefined);
			assert.deepEqual(allowed.selectCalls, []);
			const denied = await invokeTool(
				{ toolName: "mcp__other__get_issue", input: {} },
				cwd,
			);
			assert.deepEqual(denied.result, {
				block: true,
				reason: "Blocked by user",
			});
		});
	}

	test("exact MCP rules do not approve a different tool on the same server", async () => {
		const cwd = createEmptyProject();
		writePiPermissions(cwd, { allow: [`MCP(${toolName})`] });
		const { result } = await invokeTool(
			{ toolName: `${toolName}_details`, input: {} },
			cwd,
		);
		assert.deepEqual(result, { block: true, reason: "Blocked by user" });
	});

	test("MCP deny rules override ask, allow, and session approvals across files", async () => {
		const cwd = createEmptyProject();
		const handler = createHandler();
		await invokeTool(
			event,
			cwd,
			["Allow for this session"],
			undefined,
			handler,
		);
		writePiPermissions(cwd, { allow: ["MCP(*)"], ask: [`MCP(${toolName})`] });
		writePiPermissions(
			cwd,
			{ deny: ["MCP(mcp__linear__*)"] },
			"permissions.local.json",
		);
		const { result, selectCalls } = await invokeTool(
			event,
			cwd,
			["Yes"],
			undefined,
			handler,
		);
		assert.deepEqual(result, {
			block: true,
			reason: 'MCP tool matches deny rule "MCP(mcp__linear__*)"',
		});
		assert.deepEqual(selectCalls, []);
	});

	test("MCP ask rules override allow and session approvals", async () => {
		const cwd = createEmptyProject();
		const handler = createHandler();
		await invokeTool(
			event,
			cwd,
			["Allow for this session"],
			undefined,
			handler,
		);
		writePiPermissions(cwd, { allow: ["MCP(*)"], ask: [`MCP(${toolName})`] });
		const { result, selectCalls } = await invokeTool(
			event,
			cwd,
			["No"],
			undefined,
			handler,
		);
		assert.deepEqual(result, { block: true, reason: "Blocked by user" });
		assert.equal(selectCalls.length, 1);
		assert.deepEqual(selectCalls[0].options, ["Yes", "No"]);
		const headless = await handler(event, { cwd, hasUI: false });
		assert.deepEqual(headless, {
			block: true,
			reason: "MCP tool requires approval and no UI is available.",
		});
	});

	test("one-time approval does not approve later calls or save a rule", async () => {
		const cwd = createEmptyProject();
		const handler = createHandler();
		const approved = await invokeTool(event, cwd, ["Yes"], undefined, handler);
		assert.equal(approved.result, undefined);
		const repeated = await invokeTool(event, cwd, ["No"], undefined, handler);
		assert.deepEqual(repeated.result, {
			block: true,
			reason: "Blocked by user",
		});
		assert.equal(fs.existsSync(path.join(cwd, ".pi")), false);
	});

	test("saves exact MCP approvals locally without modifying other permission kinds", async () => {
		const cwd = createEmptyProject();
		const permissionsPath = writePiPermissions(
			cwd,
			{
				allow: ["Bash(custom-tool *)"],
				ask: ["MCP(mcp__linear__update_issue)"],
				deny: ["MCP(mcp__linear__delete_issue)"],
			},
			"permissions.local.json",
		);
		const { result, editorCalls, notifications } = await invokeTool(
			event,
			cwd,
			[saveChoice],
		);
		assert.equal(result, undefined);
		assert.deepEqual(editorCalls, [
			{ title: "Amend MCP permission rule", initialValue: toolName },
		]);
		assert.deepEqual(JSON.parse(fs.readFileSync(permissionsPath, "utf8")), {
			permissions: {
				allow: ["Bash(custom-tool *)", `MCP(${toolName})`],
				ask: ["MCP(mcp__linear__update_issue)"],
				deny: ["MCP(mcp__linear__delete_issue)"],
			},
		});
		assert.deepEqual(notifications, [
			{
				message: `Saved MCP(${toolName}) to ${permissionsPath}`,
				level: "info",
			},
		]);
		const repeated = await invokeTool(event, cwd);
		assert.equal(repeated.result, undefined);
		assert.deepEqual(repeated.selectCalls, []);
	});

	for (const choice of [saveChoice, "Allow for this session"]) {
		test(`supports edited wildcard MCP rules for ${choice}`, async () => {
			const cwd = createEmptyProject();
			const handler = createHandler();
			const approved = await invokeTool(
				event,
				cwd,
				[choice],
				" MCP(mcp__linear__get_*) ",
				handler,
			);
			assert.equal(approved.result, undefined);
			const repeated = await invokeTool(
				{ toolName: "mcp__linear__get_team", input: {} },
				cwd,
				[],
				undefined,
				handler,
			);
			assert.equal(repeated.result, undefined);
			assert.deepEqual(repeated.selectCalls, []);
			if (choice === "Allow for this session") {
				assert.equal(fs.existsSync(path.join(cwd, ".pi")), false);
				const otherSession = await invokeTool(event, cwd);
				assert.deepEqual(otherSession.result, {
					block: true,
					reason: "Blocked by user",
				});
			}
		});

		for (const rule of [null, "", "   "]) {
			test(`blocks cancelled ${choice} editing with ${JSON.stringify(rule)}`, async () => {
				const cwd = createEmptyProject();
				const { result } = await invokeTool(event, cwd, [choice], rule);
				assert.deepEqual(result, {
					block: true,
					reason: "Permission rule save cancelled",
				});
				assert.equal(fs.existsSync(path.join(cwd, ".pi")), false);
			});
		}
	}

	for (const eventName of ["session_start", "session_shutdown"]) {
		test(`discards MCP session approval on ${eventName}`, async () => {
			const cwd = createEmptyProject();
			const handlers = createHandlers();
			const handler = handlers.get("tool_call");
			assert.ok(handler);
			await invokeTool(
				event,
				cwd,
				["Allow for this session"],
				undefined,
				handler,
			);
			await handlers.get(eventName)?.({ reason: "new" }, { cwd });
			const { result } = await invokeTool(
				event,
				cwd,
				["No"],
				undefined,
				handler,
			);
			assert.deepEqual(result, { block: true, reason: "Blocked by user" });
		});
	}

	test("session changes invalidate pending and queued MCP approvals", async () => {
		const cwd = createEmptyProject();
		const handlers = createHandlers();
		const handler = handlers.get("tool_call");
		assert.ok(handler);
		const pending = handler(event, {
			cwd,
			hasUI: true,
			ui: {
				select: async () => {
					await handlers.get("session_shutdown")?.({ reason: "new" }, { cwd });
					return "Yes";
				},
			},
		});
		const queued = invokeTool(event, cwd, ["Yes"], undefined, handler);
		assert.deepEqual(await pending, {
			block: true,
			reason: "Session changed during permission approval",
		});
		assert.deepEqual((await queued).result, {
			block: true,
			reason: "Session changed during permission approval",
		});
	});

	test("queued MCP calls reuse session approval without another prompt", async () => {
		const cwd = createEmptyProject();
		const handler = createHandler();
		const [first, second] = await Promise.all([
			invokeTool(event, cwd, ["Allow for this session"], undefined, handler),
			invokeTool(event, cwd, ["No"], undefined, handler),
		]);
		assert.equal(first.result, undefined);
		assert.equal(first.selectCalls.length, 1);
		assert.equal(second.result, undefined);
		assert.deepEqual(second.selectCalls, []);
	});

	test("MCP session approvals do not apply to another working directory", async () => {
		const cwd = createEmptyProject();
		const handler = createHandler();
		const approved = await invokeTool(
			event,
			cwd,
			["Allow for this session"],
			undefined,
			handler,
		);
		assert.equal(approved.result, undefined);
		const other = await invokeTool(
			event,
			createEmptyProject(),
			["No"],
			undefined,
			handler,
		);
		assert.deepEqual(other.result, { block: true, reason: "Blocked by user" });
	});

	test("a failed MCP rule save blocks the call without overwriting the target", async () => {
		const cwd = createEmptyProject();
		const target = path.join(cwd, ".pi");
		fs.writeFileSync(target, "existing content");
		const { result, notifications } = await invokeTool(event, cwd, [
			saveChoice,
		]);
		assert.ok(result && typeof result === "object" && "block" in result);
		assert.equal(result.block, true);
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].level, "error");
		assert.equal(fs.readFileSync(target, "utf8"), "existing content");
	});

	test("Bash and MCP wildcard rules and session approvals remain separate", async () => {
		const cwd = createEmptyProject();
		writePiPermissions(cwd, { allow: ["Bash(*)"] });
		const handler = createHandler();
		const mcp = await invokeTool(event, cwd);
		assert.deepEqual(mcp.result, { block: true, reason: "Blocked by user" });
		writePiPermissions(cwd, { allow: ["MCP(*)"] });
		const bash = await invoke("custom-tool", cwd);
		assert.deepEqual(bash.result, { block: true, reason: "Blocked by user" });
		writePiPermissions(cwd, { allow: [] });
		await invoke("custom-tool", cwd, ["Allow for this session"], "*", handler);
		assert.deepEqual(
			(await invokeTool(event, cwd, ["No"], undefined, handler)).result,
			{ block: true, reason: "Blocked by user" },
		);
		const otherHandler = createHandler();
		await invokeTool(event, cwd, ["Allow for this session"], "*", otherHandler);
		assert.deepEqual(
			(await invoke("custom-tool", cwd, ["No"], undefined, otherHandler))
				.result,
			{ block: true, reason: "Blocked by user" },
		);
	});

	test("malformed MCP configuration cannot fall through to a broader allow", async () => {
		const cwd = createEmptyProject();
		writePiPermissions(cwd, { allow: ["MCP(*)"] });
		const localPath = path.join(cwd, ".pi", "permissions.local.json");
		for (const content of [
			"invalid JSON",
			JSON.stringify({ permissions: { deny: "MCP(*)" } }),
			JSON.stringify({ permissions: { ask: "MCP(*)" } }),
		]) {
			fs.writeFileSync(localPath, content);
			await assert.rejects(
				createHandler()(event, { cwd, hasUI: false }),
				/Invalid JSON|Expected .* to be an array/,
			);
		}
	});

	test("ignores non-MCP tools and codemode wrappers", async () => {
		const handler = createHandler();
		for (const name of ["read", "custom_tool", "codemode", "tool_search"]) {
			assert.equal(
				await handler(
					{ toolName: name, input: {} },
					{ cwd: createEmptyProject(), hasUI: false },
				),
				undefined,
			);
		}
	});
});

describe("ignores Claude settings", () => {
	beforeEach(() => {
		vi.stubEnv("HOME", createEmptyProject());
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	for (const scope of ["project", "global"]) {
		for (const fileName of ["settings.json", "settings.local.json"]) {
			test(`ignores ${scope} ${fileName} permission rules and malformed JSON`, async () => {
				const projectDirectory = createEmptyProject();
				const settingsDirectory = path.join(
					scope === "project" ? projectDirectory : os.homedir(),
					".claude",
				);
				fs.mkdirSync(settingsDirectory);
				const settingsPath = path.join(settingsDirectory, fileName);
				fs.writeFileSync(
					settingsPath,
					JSON.stringify({
						permissions: {
							allow: ["Bash(legacy-tool inspect *)"],
							deny: ["Bash(cat legacy.txt)"],
						},
					}),
				);

				const unapproved = await invoke(
					"legacy-tool inspect target",
					projectDirectory,
				);
				assert.deepEqual(unapproved.result, {
					block: true,
					reason: "Blocked by user",
				});
				assert.equal(unapproved.selectCalls.length, 1);

				const allowed = await invoke("cat legacy.txt", projectDirectory);
				assert.equal(allowed.result, undefined);
				assert.deepEqual(allowed.selectCalls, []);

				fs.writeFileSync(settingsPath, "invalid JSON");
				const warn = vi
					.spyOn(console, "warn")
					.mockImplementation(() => undefined);
				try {
					const result = await createHandler()(
						{
							toolName: "bash",
							input: { command: "legacy-tool inspect target" },
						},
						{ cwd: projectDirectory, hasUI: false },
					);
					assert.deepEqual(result, {
						block: true,
						reason:
							"Bash command is not allowed by configured permissions and no UI is available.",
					});
					assert.deepEqual(warn.mock.calls, []);
				} finally {
					warn.mockRestore();
				}
			});
		}
	}
});

test("allows a Bash command matching a project Pi permission", async () => {
	const projectDirectory = createEmptyProject();
	writePiPermissions(projectDirectory, {
		allow: ["Bash(project-tool deploy *)"],
	});

	const { result, selectCalls } = await invoke(
		"project-tool deploy staging",
		projectDirectory,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectCalls, []);
});

test("allows a Bash command matching a local project Pi permission", async () => {
	const projectDirectory = createEmptyProject();
	writePiPermissions(
		projectDirectory,
		{ allow: ["Bash(local-project-tool deploy *)"] },
		"permissions.local.json",
	);

	const { result, selectCalls } = await invoke(
		"local-project-tool deploy staging",
		projectDirectory,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectCalls, []);
});

test("allows a Bash command matching a global Pi permission", async () => {
	const projectDirectory = createEmptyProject();
	const temporaryHome = createEmptyProject();
	const previousHome = process.env.HOME;
	process.env.HOME = temporaryHome;
	const globalPermissionsDirectory = path.join(temporaryHome, ".pi", "agent");
	fs.mkdirSync(globalPermissionsDirectory, { recursive: true });
	fs.writeFileSync(
		path.join(globalPermissionsDirectory, "permissions.json"),
		JSON.stringify({
			permissions: { allow: ["Bash(global-tool inspect *)"] },
		}),
	);

	try {
		const { result, selectCalls } = await invoke(
			"global-tool inspect target",
			projectDirectory,
		);

		assert.equal(result, undefined);
		assert.deepEqual(selectCalls, []);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
	}
});

test("allows a Bash command matching a local global Pi permission", async () => {
	const projectDirectory = createEmptyProject();
	const temporaryHome = createEmptyProject();
	const previousHome = process.env.HOME;
	process.env.HOME = temporaryHome;
	const globalPermissionsDirectory = path.join(temporaryHome, ".pi", "agent");
	fs.mkdirSync(globalPermissionsDirectory, { recursive: true });
	fs.writeFileSync(
		path.join(globalPermissionsDirectory, "permissions.local.json"),
		JSON.stringify({
			permissions: { allow: ["Bash(global-local-tool inspect *)"] },
		}),
	);

	try {
		const { result, selectCalls } = await invoke(
			"global-local-tool inspect target",
			projectDirectory,
		);

		assert.equal(result, undefined);
		assert.deepEqual(selectCalls, []);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
	}
});

test("allows a quoted grep pattern when grep is allowlisted", async () => {
	const projectDirectory = createProject(["grep *"]);
	const { result, selectCalls } = await invoke(
		'grep -R "getOptions" -n Sources/Sentry/include Sources/Sentry/Public Sources/Sentry Sources/Swift',
		projectDirectory,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectCalls, []);
});

test("allows a quoted playwright run-code handler with arrow functions", async () => {
	const projectDirectory = createProject([
		"playwright-cli -s=lightbox run-code *",
	]);
	const { result, selectCalls } = await invoke(
		`playwright-cli -s=lightbox run-code "async page => { const box = await page.locator('.lightbox__image').boundingBox(); if (!box) throw new Error('image missing'); const x = box.x + box.width / 2; const y = box.y + box.height / 2; await page.touchscreen.tap(x, y); await page.waitForTimeout(100); await page.touchscreen.tap(x, y); return await page.locator('.lightbox__image').evaluate(el => el.style.transform); }"`,
		projectDirectory,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectCalls, []);
});

test("allows any playwright-cli command matching a wildcard allow rule", async () => {
	const projectDirectory = createProject(["playwright-cli *"]);
	const { result, selectCalls } = await invoke(
		`playwright-cli -s=lightbox run-code "async page => { const box = await page.locator('.lightbox__image').boundingBox(); if (!box) throw new Error('image missing'); const x = box.x + box.width / 2; const y = box.y + box.height / 2; await page.touchscreen.tap(x, y); await page.waitForTimeout(100); await page.touchscreen.tap(x, y); return await page.locator('.lightbox__image').evaluate(el => el.style.transform); }"`,
		projectDirectory,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectCalls, []);
});

test("blocks Bash commands denied by shared and local project Pi permission files", async () => {
	const projectDirectory = createEmptyProject();
	writePiPermissions(projectDirectory, {
		deny: ["Bash(cat shared-pi.txt)"],
	});
	writePiPermissions(
		projectDirectory,
		{ deny: ["Bash(cat local-pi.txt)"] },
		"permissions.local.json",
	);

	for (const fileName of ["shared-pi.txt", "local-pi.txt"]) {
		const command = `cat ${fileName}`;
		const { result, selectCalls } = await invoke(command, projectDirectory);

		assert.deepEqual(result, {
			block: true,
			reason: `Bash command matches deny rule "Bash(${command})"`,
		});
		assert.deepEqual(selectCalls, []);
	}
});

test("blocks Bash commands denied by shared and local global Pi permission files", async () => {
	const projectDirectory = createEmptyProject();
	const temporaryHome = createEmptyProject();
	const previousHome = process.env.HOME;
	process.env.HOME = temporaryHome;
	const piDirectory = path.join(temporaryHome, ".pi", "agent");
	fs.mkdirSync(piDirectory, { recursive: true });
	fs.writeFileSync(
		path.join(piDirectory, "permissions.json"),
		JSON.stringify({
			permissions: { deny: ["Bash(cat global-shared-pi.txt)"] },
		}),
	);
	fs.writeFileSync(
		path.join(piDirectory, "permissions.local.json"),
		JSON.stringify({
			permissions: { deny: ["Bash(cat global-local-pi.txt)"] },
		}),
	);

	try {
		for (const fileName of ["global-shared-pi.txt", "global-local-pi.txt"]) {
			const command = `cat ${fileName}`;
			const { result, selectCalls } = await invoke(command, projectDirectory);

			assert.deepEqual(result, {
				block: true,
				reason: `Bash command matches deny rule "Bash(${command})"`,
			});
			assert.deepEqual(selectCalls, []);
		}
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
	}
});

test("saves new Bash permissions only to local Pi permissions", async () => {
	const projectDirectory = createProject(["existing-tool *"]);
	const sharedPermissionsPath = path.join(
		projectDirectory,
		".pi",
		"permissions.json",
	);
	const originalPermissions = fs.readFileSync(sharedPermissionsPath, "utf8");

	const { result, notifications } = await invoke(
		"release-tool deploy staging",
		projectDirectory,
		["Yes, and don’t ask again for: release-tool deploy staging *"],
		"release-tool deploy *",
	);

	assert.equal(result, undefined);
	const piPermissionsPath = path.join(
		projectDirectory,
		".pi",
		"permissions.local.json",
	);
	assert.equal(fs.existsSync(piPermissionsPath), true);
	assert.deepEqual(JSON.parse(fs.readFileSync(piPermissionsPath, "utf8")), {
		permissions: { allow: ["Bash(release-tool deploy *)"] },
	});
	assert.equal(
		fs.readFileSync(sharedPermissionsPath, "utf8"),
		originalPermissions,
	);
	assert.deepEqual(notifications, [
		{
			message: `Saved Bash(release-tool deploy *) to ${path.join(projectDirectory, ".pi", "permissions.local.json")}`,
			level: "info",
		},
	]);
});

test("preserves existing local Pi permission content when saving", async () => {
	const projectDirectory = createEmptyProject();
	const permissionsPath = writePiPermissions(
		projectDirectory,
		{
			allow: ["Read(*)"],
			deny: ["Bash(git push *)"],
		},
		"permissions.local.json",
	);
	const existing = JSON.parse(fs.readFileSync(permissionsPath, "utf8"));
	existing.audit = true;
	fs.writeFileSync(permissionsPath, JSON.stringify(existing));

	const { result } = await invoke(
		"release-tool deploy staging",
		projectDirectory,
		["Yes, and don’t ask again for: release-tool deploy staging *"],
		"release-tool deploy *",
	);

	assert.equal(result, undefined);
	assert.deepEqual(JSON.parse(fs.readFileSync(permissionsPath, "utf8")), {
		permissions: {
			allow: ["Read(*)", "Bash(release-tool deploy *)"],
			deny: ["Bash(git push *)"],
		},
		audit: true,
	});
});

test("requires approval for a git commit despite a matching allow rule", async () => {
	const projectDirectory = createProject(["git *"]);
	const { result, selectCalls } = await invoke(
		'git commit -m "message"',
		projectDirectory,
	);

	assert.deepEqual(result, { block: true, reason: "Blocked by user" });
	assert.equal(selectCalls.length, 1);
	assert.match(selectCalls[0].message, /git commit -m "message"/);
});

test("requires approval for a git push after Git global options", async () => {
	const projectDirectory = createProject(["git *"]);
	const { result, selectCalls } = await invoke(
		"git -C repository -c user.name=bot push origin main",
		projectDirectory,
	);

	assert.deepEqual(result, { block: true, reason: "Blocked by user" });
	assert.equal(selectCalls.length, 1);
	assert.match(
		selectCalls[0].message,
		/git -C repository -c user.name=bot push origin main/,
	);
});

test("prompts for mutating forms of built-in inspection commands", async () => {
	const cwd = createEmptyProject();
	for (const command of [
		"find . -name '*.ts' -delete",
		"find . -exec rm {} +",
		"find . -execdir rm {} +",
		"find . -ok rm {} +",
		"find . -fprint output.txt",
		"sed -i 's/old/new/' file.txt",
		"sed --in-place 's/old/new/' file.txt",
		"sed 'w output.txt' file.txt",
		"sed 'e id' file.txt",
		"sed -n '1,20p' -i file.txt",
		"xargs rm",
		"awk '{ system(\"rm file\") }' file.txt",
		"sort -o output.txt file.txt",
		"sort --output=output.txt file.txt",
		"sort -uooutput.txt file.txt",
		"git diff --output=output.patch",
	]) {
		const { result, selectCalls } = await invoke(command, cwd);
		assert.deepEqual(
			result,
			{ block: true, reason: "Blocked by user" },
			command,
		);
		assert.equal(selectCalls.length, 1, command);
	}
});

test("mutating inspection flags still prompt under broad allow rules", async () => {
	const cwd = createProject(["find *", "sed *", "sort *", "git *"]);
	for (const command of [
		"find . -delete",
		"sed -i.bak 's/a/b/' file",
		"sort -o output file",
		"git diff --output output.patch",
	]) {
		const { result, selectCalls } = await invoke(command, cwd);
		assert.deepEqual(
			result,
			{ block: true, reason: "Blocked by user" },
			command,
		);
		assert.equal(selectCalls.length, 1, command);
	}
});

test("prompts for additional writes and executions exposed by inspection utilities", async () => {
	const cwd = createEmptyProject();
	for (const command of [
		"rg --pre=sh pattern .",
		"rg --hostname-bin=sh pattern .",
		"tree -fo output.txt",
		"tree -o output.txt",
		"uniq input.txt output.txt",
		"base64 -o output.txt",
		"yq -i '.value = 1' input.yml",
		"yq -Pi '.value = 1' input.yml",
		"yq --split-exp '.name' input.yml",
		"yq --security-enable-system-operator 'system(\"id\")' input.yml",
		"date 010100002025",
		"sort --compress-program=sh input.txt",
		"sort -T . input.txt",
		"git config --list --edit",
		"git fetch origin",
		"git reflog expire --all",
		"git branch --list -d topic",
		"git branch --list -vd topic",
		"git branch --list -u origin/main topic",
		"git tag --list -d v1",
		"git diff --ext-diff",
		"git grep --open-files-in-pager=sh pattern",
	]) {
		const { result, selectCalls } = await invoke(command, cwd);
		assert.deepEqual(
			result,
			{ block: true, reason: "Blocked by user" },
			command,
		);
		assert.equal(selectCalls.length, 1, command);
	}
});

test("does not auto-allow shell expansions hidden inside quoted arguments", async () => {
	const cwd = createEmptyProject();
	for (const command of [
		'find . -name "$(touch output.txt)"',
		'rg "`touch output.txt`" .',
		"find . $FLAGS",
		"find . \\-delete",
		"sort \\-o output.txt input.txt",
	]) {
		const { result, selectCalls } = await invoke(command, cwd);
		assert.deepEqual(
			result,
			{ block: true, reason: "Blocked by user" },
			command,
		);
		assert.equal(selectCalls.length, 1, command);
	}
});

test("keeps read-only find, sed, sort and git diff automatically allowed", async () => {
	const cwd = createEmptyProject();
	for (const command of [
		"find . -name '*.ts' -print",
		"sed -n '1,20p' file.txt",
		"sort file.txt",
		"git diff --stat",
	]) {
		const { result, selectCalls } = await invoke(command, cwd);
		assert.equal(result, undefined, command);
		assert.deepEqual(selectCalls, [], command);
	}
});

test("auto-allows single sed substitutions without project allow rules", async () => {
	const cwd = createEmptyProject();
	for (const command of [
		"sed -E 's/[[:alnum:]._%+-]+@[[:alnum:].-]+/[redacted-email]/g'",
		"cat contacts.txt | sed -E 's/[[:alnum:]._%+-]+@[[:alnum:].-]+/[redacted-email]/g'",
		"sed 's/old/new/' file.txt",
		"sed -n -E 's/old/new/g' file.txt",
		"sed 's/old//' file.txt",
		"sed 's/old/new;literal/g' file.txt",
		"sed 's/old/e w output.txt/g' file.txt",
		String.raw`sed 's/old\/path/new\/path/g' file.txt`,
		String.raw`sed 's/old/\\/g' file.txt`,
	]) {
		const { result, selectCalls } = await invoke(command, cwd);
		assert.equal(result, undefined, command);
		assert.deepEqual(selectCalls, [], command);
	}
});

test("keeps unsafe and unsupported sed substitutions behind approval", async () => {
	for (const cwd of [createEmptyProject(), createProject(["sed *"])]) {
		for (const command of [
			"sed -i 's/old/new/g' file.txt",
			"sed -E -i.bak 's/old/new/g' file.txt",
			"sed -E --in-place 's/old/new/g' file.txt",
			"sed -E 's/old/new/e' file.txt",
			"sed -E 's/old/new/ge' file.txt",
			"sed -E 's/old/new/w output.txt' file.txt",
			"sed -E 's/old/new/gw output.txt' file.txt",
			"sed -E 's/old/new/;e id' file.txt",
			"sed -E 's/old/new/;w output.txt' file.txt",
			"sed -E 's/old/new/\nw output.txt' file.txt",
			String.raw`sed -E 's/old/new\
w output.txt/' file.txt`,
			"sed -E 's/old/new/g' -e 'e id' file.txt",
			"sed -E 's/old/new/g' -f script.sed file.txt",
			"sed -E 's/old/new' file.txt",
			"sed -E 's/old/new/g' file.txt | custom-tool",
		]) {
			const { result, selectCalls } = await invoke(command, cwd);
			assert.deepEqual(
				result,
				{ block: true, reason: "Blocked by user" },
				command,
			);
			assert.equal(selectCalls.length, 1, command);
		}
	}
});

test("allows a non-blocked Git subcommand matching an allow rule", async () => {
	const projectDirectory = createProject(["git *"]);
	const { result, selectCalls } = await invoke(
		"git --no-pager log -1",
		projectDirectory,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectCalls, []);
});

test("allows an escaped line continuation within a matching command", async () => {
	const projectDirectory = createProject(["git add *"]);
	const { result, selectCalls } = await invoke(
		"git add first-file \\\nsecond-file",
		projectDirectory,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectCalls, []);
});

test("prompts for an unallowlisted command in a newline-separated script", async () => {
	const projectDirectory = createProject(["git add *"]);
	const { result, selectCalls } = await invoke(
		'git add first-file\ngit commit -m "unexpected commit"',
		projectDirectory,
		["No"],
	);

	assert.deepEqual(result, { block: true, reason: "Blocked by user" });
	assert.equal(selectCalls.length, 1);
	assert.match(selectCalls[0].message, /git commit -m "unexpected commit"/);
	assert.equal(selectCalls[0].options.length, 3);
});

test("allows a pipeline when every command matches an allow rule", async () => {
	const projectDirectory = createProject(["grep *", "head *"]);
	const { result, selectCalls } = await invoke(
		'grep -R "SentryDependencyContainerSwiftHelper" -n Sources/Swift Sources/Sentry | head -150',
		projectDirectory,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectCalls, []);
});

test("allows a pipeline with backslashes in a single-quoted search pattern", async () => {
	const projectDirectory = createProject([]);
	const { result, selectCalls } = await invoke(
		String.raw`git diff --cached -- fastlane/lanes | rg -n -C 4 '\bif\b|\bunless\b' | head -110`,
		projectDirectory,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectCalls, []);
});

test("allows a pipeline with regex syntax inside a single-quoted pattern", async () => {
	const projectDirectory = createProject([]);
	const { result, selectCalls } = await invoke(
		"rg -n '^#include|^static .*\\{|^void .*\\{|^return |^typedef ' Targets/HALPlugin/Sources --glob '*.{c,h}' | head -95",
		projectDirectory,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectCalls, []);
});

test("prompts for each unallowlisted command in a pipeline and offers an amend option", async () => {
	const projectDirectory = createProject([]);
	const { result, selectCalls } = await invoke(
		"unapproved-search Sources | unapproved-head -250",
		projectDirectory,
		["Yes", "No"],
	);

	assert.deepEqual(result, { block: true, reason: "Blocked by user" });
	assert.equal(selectCalls.length, 2);
	assert.match(selectCalls[0].message, /unapproved-search Sources/);
	assert.match(selectCalls[1].message, /unapproved-head -250/);
	assert.match(selectCalls[0].options[1], /unapproved-search Sources \*/);
	assert.match(selectCalls[1].options[1], /unapproved-head -250 \*/);
});

test("allows a pipeline with stderr redirected to stdout when every stage matches an allow rule", async () => {
	const projectDirectory = createProject(["sentry issue view *", "head *"]);
	const { result, selectCalls } = await invoke(
		"sentry issue view 7642532706 --json 2>&1 | head -100",
		projectDirectory,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectCalls, []);
});

test("requires approval when a word follows the file descriptor duplication", async () => {
	const projectDirectory = createProject(["sentry issue view *"]);
	const { result, selectCalls } = await invoke(
		"sentry issue view 7642532706 --json 2>&1extra",
		projectDirectory,
	);

	assert.deepEqual(result, { block: true, reason: "Blocked by user" });
	assert.equal(selectCalls.length, 1);
});

test("allows a command with stderr redirected to /dev/null when it matches an allow rule", async () => {
	const projectDirectory = createProject(["sentry trace logs *"]);
	const { result, selectCalls } = await invoke(
		"sentry trace logs demo/ios/a17e6b9dc5dd4a7b88f546fac733f61c --json 2>/dev/null",
		projectDirectory,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectCalls, []);
});

test("allows a pipeline with stderr redirected to /dev/null when every stage matches an allow rule", async () => {
	const projectDirectory = createProject(["sentry trace logs *", "head *"]);
	const { result, selectCalls } = await invoke(
		"sentry trace logs demo/ios/a17e6b9dc5dd4a7b88f546fac733f61c --json 2>/dev/null | head -100",
		projectDirectory,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectCalls, []);
});

test("prompts for commands on both sides of a pipeline containing a redirection", async () => {
	const projectDirectory = createProject([]);
	const { result, selectCalls } = await invoke(
		"unapproved-search DerivedData 2>/dev/null | unapproved-head -100",
		projectDirectory,
		["Yes", "No"],
	);

	assert.deepEqual(result, { block: true, reason: "Blocked by user" });
	assert.equal(selectCalls.length, 2);
	assert.match(
		selectCalls[0].message,
		/unapproved-search DerivedData 2>\/dev\/null/,
	);
	assert.match(selectCalls[1].message, /unapproved-head -100/);
});

test("allows an allowlisted command to redirect output to a new project file", async () => {
	const projectDirectory = createProject([
		"/Applications/Blender.app/Contents/MacOS/Blender *",
	]);
	const { result, selectCalls } = await invoke(
		"/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python asset_generators/models/coastal_rock_v1/build_asset.py > tmp/coastal_rock/build.log 2>&1",
		projectDirectory,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectCalls, []);
});

test("blocks a redirected command when its executable command matches a deny rule", async () => {
	const projectDirectory = createProject(["render-tool *"]);
	writePiPermissions(projectDirectory, {
		deny: ["Bash(render-tool run)"],
	});

	const { result, selectCalls } = await invoke(
		"render-tool run > build.log",
		projectDirectory,
	);

	assert.deepEqual(result, {
		block: true,
		reason: 'Bash command matches deny rule "Bash(render-tool run)"',
	});
	assert.deepEqual(selectCalls, []);
});

test("allows appending to an existing Git-ignored project file", async () => {
	const projectDirectory = createProject(["render-tool *"]);
	execFileSync("git", ["init", "--quiet"], { cwd: projectDirectory });
	fs.writeFileSync(path.join(projectDirectory, ".gitignore"), "tmp/\n");
	fs.mkdirSync(path.join(projectDirectory, "tmp"));
	fs.writeFileSync(path.join(projectDirectory, "tmp", "build log.txt"), "old");

	const { result, selectCalls } = await invoke(
		'render-tool run >> "tmp/build log.txt"',
		projectDirectory,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectCalls, []);
});

test("requires approval before redirecting over an existing unignored file", async () => {
	const projectDirectory = createProject(["grep *"]);
	fs.writeFileSync(path.join(projectDirectory, "errors.log"), "existing log");
	const { result, selectCalls } = await invoke(
		"grep value file 2>errors.log",
		projectDirectory,
	);

	assert.deepEqual(result, { block: true, reason: "Blocked by user" });
	assert.equal(selectCalls.length, 1);
});

test("requires approval for hidden output paths", async () => {
	const projectDirectory = createProject(["render-tool *"]);

	for (const command of [
		"render-tool run > .build.log",
		"render-tool run > output/.cache/build.log",
	]) {
		const { result, selectCalls } = await invoke(command, projectDirectory);
		assert.deepEqual(
			result,
			{ block: true, reason: "Blocked by user" },
			command,
		);
		assert.equal(selectCalls.length, 1, command);
	}
});

test("allows output redirection to new and existing files in /tmp", async () => {
	const projectDirectory = createProject([]);
	const outputDirectory = createEmptyProject("/tmp");
	fs.writeFileSync(path.join(outputDirectory, "existing.log"), "old");

	for (const command of [
		`echo value > ${outputDirectory}/new.log`,
		`echo value > ${fs.realpathSync(outputDirectory)}/canonical.log`,
		`echo value >> "${outputDirectory}/existing.log"`,
		`echo value > "${outputDirectory}/nested/new log.txt" 2>&1`,
		`echo value | head -1 > ${outputDirectory}/pipeline.log`,
		`echo value > ${path.relative(projectDirectory, outputDirectory)}/relative.log`,
	]) {
		const { result, selectCalls } = await invoke(command, projectDirectory);
		assert.equal(result, undefined, command);
		assert.deepEqual(selectCalls, [], command);
	}
});

test("allows an allowlisted make test with output redirected to /tmp", async () => {
	const projectDirectory = createProject(["make test"]);
	const { result, selectCalls } = await invoke(
		"make test > /tmp/test.log 2>&1",
		projectDirectory,
	);
	assert.equal(result, undefined);
	assert.deepEqual(selectCalls, []);
});

test("allows /tmp output redirection without a UI", async () => {
	const projectDirectory = createProject([]);
	const outputDirectory = createEmptyProject("/tmp");
	const result = await createHandler()(
		{
			toolName: "bash",
			input: { command: `echo value > ${outputDirectory}/new.log` },
		},
		{ cwd: projectDirectory, hasUI: false },
	);
	assert.equal(result, undefined);
});

test("requires approval for unsafe output targets within /tmp", async () => {
	const projectDirectory = createProject([]);
	const outputDirectory = createEmptyProject("/tmp");
	const sourcePath = path.join(projectDirectory, "source.txt");
	fs.writeFileSync(sourcePath, "source");
	fs.symlinkSync(sourcePath, path.join(outputDirectory, "symlink.log"));
	fs.symlinkSync(projectDirectory, path.join(outputDirectory, "linked"));
	fs.linkSync(sourcePath, path.join(outputDirectory, "hardlink.log"));

	for (const target of [
		`${outputDirectory}/symlink.log`,
		`${outputDirectory}/linked/new.log`,
		`${outputDirectory}/hardlink.log`,
		outputDirectory,
		`${outputDirectory}/.hidden.log`,
	]) {
		const { result, selectCalls } = await invoke(
			`echo value > ${target}`,
			projectDirectory,
		);
		assert.deepEqual(
			result,
			{ block: true, reason: "Blocked by user" },
			target,
		);
		assert.equal(selectCalls.length, 1, target);
	}
});

test("preserves command approval and deny rules for /tmp output", async () => {
	const projectDirectory = createProject([]);
	const outputDirectory = createEmptyProject("/tmp");
	writePiPermissions(projectDirectory, { deny: ["Bash(echo denied)"] });

	for (const command of [
		`unapproved-tool > ${outputDirectory}/new.log`,
		`echo value > ${outputDirectory}/new.log && unapproved-tool`,
		`rm file > ${outputDirectory}/new.log`,
	]) {
		const { result, selectCalls } = await invoke(command, projectDirectory);
		assert.deepEqual(
			result,
			{ block: true, reason: "Blocked by user" },
			command,
		);
		assert.equal(selectCalls.length, 1, command);
	}

	const { result, selectCalls } = await invoke(
		`echo denied > ${outputDirectory}/new.log`,
		projectDirectory,
	);
	assert.deepEqual(result, {
		block: true,
		reason: 'Bash command matches deny rule "Bash(echo denied)"',
	});
	assert.deepEqual(selectCalls, []);
});

test("requires approval for output paths outside the project and /tmp", async () => {
	const projectDirectory = createProject(["render-tool *"]);

	for (const target of [
		path.relative(projectDirectory, "/etc/outside.log"),
		"/etc/outside.log",
		"/tmp-other/outside.log",
		"/tmp/../outside.log",
	]) {
		const command = `render-tool run > ${target}`;
		const { result, selectCalls } = await invoke(command, projectDirectory);
		assert.deepEqual(
			result,
			{ block: true, reason: "Blocked by user" },
			command,
		);
		assert.equal(selectCalls.length, 1, command);
	}
});

test("requires approval when an output path traverses a symbolic link", async () => {
	const projectDirectory = createProject(["render-tool *"]);
	const outsideDirectory = createEmptyProject();
	fs.symlinkSync(outsideDirectory, path.join(projectDirectory, "output"));

	const { result, selectCalls } = await invoke(
		"render-tool run > output/build.log",
		projectDirectory,
	);

	assert.deepEqual(result, { block: true, reason: "Blocked by user" });
	assert.equal(selectCalls.length, 1);
});

test("requires approval when an ignored output is a hard link", async () => {
	const projectDirectory = createProject(["render-tool *"]);
	execFileSync("git", ["init", "--quiet"], { cwd: projectDirectory });
	fs.writeFileSync(path.join(projectDirectory, ".gitignore"), "tmp/\n");
	fs.writeFileSync(path.join(projectDirectory, "source.txt"), "source");
	fs.mkdirSync(path.join(projectDirectory, "tmp"));
	fs.linkSync(
		path.join(projectDirectory, "source.txt"),
		path.join(projectDirectory, "tmp", "build.log"),
	);

	const { result, selectCalls } = await invoke(
		"render-tool run > tmp/build.log",
		projectDirectory,
	);

	assert.deepEqual(result, { block: true, reason: "Blocked by user" });
	assert.equal(selectCalls.length, 1);
});

test("requires approval for a dynamic output path", async () => {
	const projectDirectory = createProject(["render-tool *"]);
	const { result, selectCalls } = await invoke(
		'render-tool run > "$LOG_PATH"',
		projectDirectory,
	);

	assert.deepEqual(result, { block: true, reason: "Blocked by user" });
	assert.equal(selectCalls.length, 1);
	assert.deepEqual(selectCalls[0].options, ["Yes", "No"]);
});

test("suggests a permission rule without a safe output redirection", async () => {
	const projectDirectory = createProject([]);
	const command = "render-tool run --fast > build.log";
	const saveChoice = "Yes, and don’t ask again for: render-tool run --fast *";

	const { result, selectCalls } = await invoke(
		command,
		projectDirectory,
		[saveChoice],
		"render-tool run *",
	);

	assert.equal(result, undefined);
	assert.equal(selectCalls.length, 1);
	assert.deepEqual(selectCalls[0].options, [
		"Yes",
		saveChoice,
		"Allow for this session",
		"No",
	]);
	assert.doesNotMatch(selectCalls[0].options[1], /> build\.log/);
});

test("prompts without an amend option when a pipeline stage requires approval because of a redirection", async () => {
	const projectDirectory = createProject([]);
	const { result, selectCalls } = await invoke(
		"cat package.json | jq '.name' > .output.txt",
		projectDirectory,
		["No"],
	);

	assert.deepEqual(result, { block: true, reason: "Blocked by user" });
	assert.equal(selectCalls.length, 1);
	assert.match(selectCalls[0].message, /jq '.name' > .output.txt/);
	assert.deepEqual(selectCalls[0].options, ["Yes", "No"]);
	assert.doesNotMatch(selectCalls[0].message, /amend/);
});

test("prompts without an amend option for unsupported shell syntax", async () => {
	const projectDirectory = createProject([]);
	const { result, selectCalls } = await invoke(
		"echo $(date)",
		projectDirectory,
		["No"],
	);

	assert.deepEqual(result, { block: true, reason: "Blocked by user" });
	assert.equal(selectCalls.length, 1);
	assert.deepEqual(selectCalls[0].options, ["Yes", "No"]);
});

test("serializes approval dialogs from concurrent Bash calls", async () => {
	const projectDirectory = createProject([]);
	const handler = createHandler();
	let resolveFirstChoice = (_choice: string): void => {
		throw new Error("First choice resolver is not initialized");
	};
	let resolveSecondChoice = (_choice: string): void => {
		throw new Error("Second choice resolver is not initialized");
	};
	let firstPrompted = (): void => {
		throw new Error("First prompt resolver is not initialized");
	};
	let secondPrompted = (): void => {
		throw new Error("Second prompt resolver is not initialized");
	};
	let secondPromptCount = 0;
	const firstChoice = new Promise<string>((resolve) => {
		resolveFirstChoice = resolve;
	});
	const secondChoice = new Promise<string>((resolve) => {
		resolveSecondChoice = resolve;
	});
	const firstPrompt = new Promise<void>((resolve) => {
		firstPrompted = resolve;
	});
	const secondPrompt = new Promise<void>((resolve) => {
		secondPrompted = resolve;
	});

	const first = handler(
		{ toolName: "bash", input: { command: "unapproved-first" } },
		{
			cwd: projectDirectory,
			hasUI: true,
			ui: {
				select: async () => {
					firstPrompted();
					return firstChoice;
				},
			},
		},
	);
	await firstPrompt;

	const second = handler(
		{ toolName: "bash", input: { command: "unapproved-second" } },
		{
			cwd: projectDirectory,
			hasUI: true,
			ui: {
				select: async () => {
					secondPromptCount++;
					secondPrompted();
					return secondChoice;
				},
			},
		},
	);
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(secondPromptCount, 0);

	resolveFirstChoice("Yes");
	assert.equal(await first, undefined);
	await secondPrompt;

	resolveSecondChoice("No");
	assert.deepEqual(await second, { block: true, reason: "Blocked by user" });
});

test("blocks gh pr create despite a matching allow rule", async () => {
	const projectDirectory = createProject(["gh *"]);
	const { result, selectCalls } = await invoke(
		'gh pr create --title "New feature" --body "Details"',
		projectDirectory,
	);

	assert.deepEqual(result, { block: true, reason: "Blocked by user" });
	assert.equal(selectCalls.length, 1);
	assert.match(selectCalls[0].message, /gh pr create/);
});

test("blocks gh pr create after global flags", async () => {
	const projectDirectory = createProject(["gh *"]);
	const { result, selectCalls } = await invoke(
		"gh pr create -R owner/repo --fill",
		projectDirectory,
	);

	assert.deepEqual(result, { block: true, reason: "Blocked by user" });
	assert.equal(selectCalls.length, 1);
});

test("allows gh pr view despite gh mutations being blocked", async () => {
	const projectDirectory = createProject(["gh *"]);
	const { result, selectCalls } = await invoke(
		"gh pr view 123 --json title",
		projectDirectory,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectCalls, []);
});

test("blocks rm despite a matching allow rule", async () => {
	const projectDirectory = createProject(["rm *"]);
	const { result, selectCalls } = await invoke(
		"rm -rf build",
		projectDirectory,
	);

	assert.deepEqual(result, { block: true, reason: "Blocked by user" });
	assert.equal(selectCalls.length, 1);
	assert.match(selectCalls[0].message, /rm -rf build/);
});

test("blocks git reset and git clean despite a matching allow rule", async () => {
	const projectDirectory = createProject(["git *"]);

	for (const command of ["git reset --hard HEAD~1", "git clean -fd"]) {
		const { result, selectCalls } = await invoke(command, projectDirectory, [
			"No",
		]);
		assert.deepEqual(
			result,
			{ block: true, reason: "Blocked by user" },
			command,
		);
		assert.equal(selectCalls.length, 1, command);
	}
});

test("auto-allows a built-in safe command without any project allow rule", async () => {
	const projectDirectory = createProject([]);
	const { result, selectCalls } = await invoke(
		"cat Sources/Sentry/SentryClient.m",
		projectDirectory,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectCalls, []);
});

describe("macOS default inspection permissions", () => {
	beforeEach(() => {
		vi.stubEnv("HOME", createEmptyProject());
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	for (const command of [
		"col -b",
		"colrm 1 4",
		"column -t report.txt",
		"expand -t 4 source.txt",
		"unexpand -a source.txt",
		"fold -w 100 source.txt",
		"paste first.txt second.txt",
		"join first.txt second.txt",
		"rev source.txt",
		"readlink -f link",
		"du -sh Sources",
		"df -h",
		"cksum archive.zip",
		"sum archive.zip",
		"sw_vers -productVersion",
		"getconf ARG_MAX",
		"pagesize",
		"uptime",
		"vm_stat",
		"id -u",
		"groups",
		"whoami",
		"uuidgen",
		"size AppBinary",
		"arch",
		"ps",
		"ps aux",
		"ps -ef",
		"ps -p 123,456 -o pid,ppid,comm",
		"lipo -info AppBinary",
		"lipo -archs 'App Binary'",
		"lipo -detailed_info AppBinary",
		"plutil -p Info.plist",
		"plutil -lint -- Info.plist Other.plist",
		"ps aux | col -b | column -t",
	]) {
		test(`auto-allows low-risk macOS inspection: ${command}`, async () => {
			const { result, selectCalls } = await invoke(command, createProject([]));
			assert.equal(result, undefined);
			assert.deepEqual(selectCalls, []);
		});
	}

	for (const command of [
		"arch -arm64 custom-tool",
		"arch custom-tool",
		"ps -E",
		"ps auxE",
		"ps e",
		"ps -o pid -E",
		"ps -p $PROCESS_OPTIONS",
		"lipo -create AppBinary -output CombinedBinary",
		"lipo -info AppBinary -create -output CombinedBinary",
		"lipo -archs $LIPO_OPTIONS",
		"lipo -info *",
		"lipo -info -'create' AppBinary",
		"plutil -convert json Info.plist",
		"plutil -p Info.plist -convert json",
		"plutil -lint Info.plist -remove key",
		"plutil -p $PLUTIL_OPTIONS",
		"plutil -p *",
		"plutil -p -'convert' json Info.plist",
		"man ps",
		"man -P custom-tool ps",
		"ps aux | custom-tool",
	]) {
		test(`keeps unsafe or uncontrolled inspection behind approval: ${command}`, async () => {
			const { result, selectCalls } = await invoke(command, createProject([]));
			assert.deepEqual(result, { block: true, reason: "Blocked by user" });
			assert.equal(selectCalls.length, 1);
		});
	}
});

describe("process and manual inspection patterns from agent history", () => {
	beforeEach(() => {
		vi.stubEnv("HOME", createEmptyProject());
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	for (const command of [
		"pgrep node",
		"pgrep -fl 'node|vitest'",
		"pgrep -af 'coding-agent'",
		"pgrep -f 'node .*server'",
		"pgrep -x node",
		"pgrep -l -u 501 node",
		"pgrep -P 123,456 node",
		"pgrep -- '-worker'",
		"ps -axo pid,ppid,command",
		"ps -axo pid,ppid,etime,state,command",
		"ps -axo pid,ppid,stat,command",
		"ps -Ao pid,pcpu,comm",
		"ps -axo pid,lstart,args",
		"ps -eo pid,ppid,etime,args",
		"ps -p 123 -o pid,ppid,command",
		"man -P cat ps",
		"man -P cat 3 openpty",
		"man -P cat pgrep ps",
		"man -w ps",
		"man -w 3 openpty",
		"pgrep -fl node | head -20",
		"ps -axo pid,ppid,command | grep node",
		"sed -n '35,60p' source.ts",
		"sed -n '900,950p' source.ts",
		"sed -n '165,194p'",
		"sed -n '165p'",
		"man -P cat ps | col -b | sed -n '1,180p'",
		"cat source.ts | sed -n '1,260p'",
	]) {
		test(`allows safe inspection: ${command}`, async () => {
			const { result, selectCalls } = await invoke(command, createProject([]));
			assert.equal(result, undefined);
			assert.deepEqual(selectCalls, []);
		});
	}

	for (const command of [
		"sed -n",
		"sed -n '165,194p' -i",
		"sed -n '165,194p;w output.txt'",
		"sed -n 'e id'",
		"cat source.ts | sed -n '1,260p' | custom-tool",
		"sed -n '/<LaunchAction/,/<\\/LaunchAction>/p' scheme.xml",
		"pgrep -F custom.pid",
		"pgrep --unknown node",
		"pgrep -u custom-user node",
		"pgrep -P $PID node",
		'pgrep -f "$PATTERN"',
		'pgrep -f "$(custom-tool)"',
		"pgrep -f node | custom-tool",
		"pkill -f node",
		"ps -axo pid,env",
		"ps -axo pid,command -E",
		"ps -axEo pid,command",
		"ps -axo $FIELDS",
		"ps -axo pid,command | custom-tool",
		"man ps",
		"man -P custom-tool ps",
		"man -P 'cat; custom-tool' ps",
		"man -P cat -P custom-tool ps",
		"man -P cat -M ./manuals ps",
		"man -P cat ./custom.1",
		"man -P cat -t ps",
		"man -P cat $TOPIC",
		"man -w ./custom.1",
		"man -P cat ps | custom-tool",
	]) {
		test(`requires approval for uncontrolled inspection: ${command}`, async () => {
			const { result, selectCalls } = await invoke(command, createProject([]));
			assert.deepEqual(result, { block: true, reason: "Blocked by user" });
			assert.equal(selectCalls.length, 1);
		});
	}

	for (const separator of ["\n", ";", "&&", "||", "|"]) {
		test(`does not hide command separators after a single-quoted backslash: ${JSON.stringify(separator)}`, async () => {
			const cwd = createProject([]);
			writePiPermissions(cwd, { deny: ["Bash(custom-tool:*)"] });
			const command = `pgrep -- 'x\\'${separator}custom-tool${separator}'a\\'`;
			const { result, selectCalls } = await invoke(command, cwd);
			assert.deepEqual(result, {
				block: true,
				reason: 'Bash command matches deny rule "Bash(custom-tool:*)"',
			});
			assert.deepEqual(selectCalls, []);
		});
	}

	test("does not hide unsafe redirections after a single-quoted backslash", async () => {
		const { result, selectCalls } = await invoke(
			"pgrep 'x\\' > .env 'a\\'",
			createProject(["pgrep:*"]),
		);
		assert.deepEqual(result, { block: true, reason: "Blocked by user" });
		assert.equal(selectCalls.length, 1);
		assert.equal(
			selectCalls[0].options.some((option) => option.startsWith("Yes, and")),
			false,
		);
	});

	test("requires approval for single-quoted inspection patterns containing backslashes", async () => {
		const { result, selectCalls } = await invoke(
			"pgrep -f 'node\\.js'",
			createProject([]),
		);
		assert.deepEqual(result, { block: true, reason: "Blocked by user" });
		assert.equal(selectCalls.length, 1);
	});

	for (const command of [
		"pgrep $'node'",
		"pgrep $'x\\' ; custom-tool ; \\'x'",
		"pgrep $'node' > .env",
	]) {
		test(`requires whole-command approval for unsupported ANSI-C quoting: ${command}`, async () => {
			const { result, selectCalls } = await invoke(
				command,
				createProject(["pgrep:*"]),
			);
			assert.deepEqual(result, { block: true, reason: "Blocked by user" });
			assert.equal(selectCalls.length, 1);
			assert.ok(selectCalls[0].message.includes(command));
			assert.deepEqual(selectCalls[0].options, ["Yes", "No"]);
		});
	}

	test("configured denies override built-in process and manual inspection", async () => {
		const cwd = createProject([]);
		writePiPermissions(cwd, {
			deny: ["Bash(pgrep:*)", "Bash(ps:*)", "Bash(man:*)"],
		});
		for (const command of [
			"pgrep -fl node",
			"ps -axo pid,command",
			"man -P cat ps",
		]) {
			const { result, selectCalls } = await invoke(command, cwd);
			assert.equal((result as { block: boolean }).block, true);
			assert.deepEqual(selectCalls, []);
		}
	});
});

describe("CLI inspection permissions", () => {
	beforeEach(() => {
		vi.stubEnv("HOME", createEmptyProject());
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test("auto-allows manual pages with a fixed noninteractive pager", async () => {
		const projectDirectory = createProject([]);
		for (const command of [
			"man -P cat ps",
			"man -P cat 2 stat",
			"man -P cat man | head -20",
		]) {
			const { result, selectCalls } = await invoke(command, projectDirectory);
			assert.equal(result, undefined, command);
			assert.deepEqual(selectCalls, [], command);
		}
	});

	test("keeps unsafe manual-page options behind approval even with a broad rule", async () => {
		const projectDirectory = createProject(["man *"]);
		for (const command of [
			"man ps",
			"man -P custom-tool ps",
			"man -P cat -M ./docs ps",
			"man -P cat ../../docs/ps.1",
			"man -P cat ps -P custom-tool",
		]) {
			const { result, selectCalls } = await invoke(command, projectDirectory);
			assert.deepEqual(
				result,
				{ block: true, reason: "Blocked by user" },
				command,
			);
			assert.equal(selectCalls.length, 1, command);
		}
	});

	test("auto-allows listing local and remote branches with a pattern", async () => {
		const projectDirectory = createProject([]);
		const { result, selectCalls } = await invoke(
			"git branch -a --list '*permission*'",
			projectDirectory,
		);

		assert.equal(result, undefined);
		assert.deepEqual(selectCalls, []);
	});

	test("auto-allows inspecting the GitHub login", async () => {
		const projectDirectory = createProject([]);
		const { result, selectCalls } = await invoke(
			"gh api user --jq '.login'",
			projectDirectory,
		);

		assert.equal(result, undefined);
		assert.deepEqual(selectCalls, []);
	});

	test("auto-allows GET-only GitHub and Sentry API inspection", async () => {
		const projectDirectory = createProject([]);
		for (const command of [
			"gh api repos/{owner}/{repo}/issues --jq '.[].title'",
			"gh api -X GET repos/{owner}/{repo}/pulls --paginate",
			"sentry api organizations/ --json",
			"sentry api issues/123/ --method GET --fields id,title",
		]) {
			const { result, selectCalls } = await invoke(command, projectDirectory);
			assert.equal(result, undefined, command);
			assert.deepEqual(selectCalls, [], command);
		}
	});

	test("keeps mutating or ambiguous API commands behind approval even with broad rules", async () => {
		const projectDirectory = createProject(["gh api *", "sentry api *"]);
		for (const command of [
			"gh api repos/{owner}/{repo}/issues -f title=test",
			"gh api repos/{owner}/{repo}/issues --method=POST",
			"gh api repos/{owner}/{repo}/issues -XPOST",
			"gh api repos/{owner}/{repo}/issues --input payload.json",
			"gh api graphql",
			"gh api /graphql",
			"gh api /graphql?query=query",
			"gh api user -X POST --help",
			"gh api user --hostname example.com",
			"sentry api issues/123/ --method PUT",
			'sentry api issues/123/ -d \'{"status":"resolved"}\'',
			"sentry api issues/123/ --field status=resolved",
			"sentry api issues/123/ --input payload.json",
			"sentry api https://example.com/api/0/issues/123/",
		]) {
			const { result, selectCalls } = await invoke(command, projectDirectory);
			assert.deepEqual(
				result,
				{ block: true, reason: "Blocked by user" },
				command,
			);
			assert.equal(selectCalls.length, 1, command);
		}
	});

	test("keeps modified branch and API inspection commands behind approval", async () => {
		const projectDirectory = createProject([]);
		for (const command of [
			"git branch -a --list '*permission*' -d topic",
			"gh api user --jq '.login' -X PATCH",
		]) {
			const { result, selectCalls } = await invoke(command, projectDirectory);
			assert.deepEqual(result, { block: true, reason: "Blocked by user" });
			assert.equal(selectCalls.length, 1);
		}
	});
});

test("auto-allows built-in read-only git without any project allow rule", async () => {
	const projectDirectory = createProject([]);
	const { result, selectCalls } = await invoke(
		"git status --short",
		projectDirectory,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectCalls, []);
});

for (const command of [
	"git -C repository diff",
	"git -C /tmp/repository diff --stat",
	"git -C repository log",
	"git -C 'repository with spaces' log --oneline -5",
	"git -C repository status",
	'git -C "repository with spaces" status --short',
]) {
	test(`auto-allows ${command} without a project rule`, async () => {
		const { result, selectCalls } = await invoke(command, createProject([]));
		assert.equal(result, undefined);
		assert.deepEqual(selectCalls, []);
	});
}

for (const command of [
	"git -C repository checkout diff",
	"git -C repository switch log",
	"git -C repository branch status",
	"git -C repository -c core.pager=custom log",
	"git -C repository push origin main",
	"git -C repository\\ diff checkout",
	"git -C repository diff && custom-tool run",
]) {
	test(`keeps ${command} behind approval`, async () => {
		const { result, selectCalls } = await invoke(command, createProject([]));
		assert.deepEqual(result, { block: true, reason: "Blocked by user" });
		assert.equal(selectCalls.length, 1);
	});
}

test("auto-allows git range-diff without a project rule", async () => {
	const projectDirectory = createProject([]);
	const { result, selectCalls } = await invoke(
		"git range-diff main~2..main main~1..HEAD",
		projectDirectory,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectCalls, []);
});

describe("GitHub stack permissions", () => {
	beforeEach(() => {
		vi.stubEnv("HOME", createEmptyProject());
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	for (const command of [
		"gh stack",
		"gh stack --help",
		"gh stack -h",
		"gh stack --version",
		"gh stack -v",
		"gh stack help",
		"gh stack help sync",
		"gh stack view",
		"gh stack view --short",
		"gh stack view -s",
		"gh stack view --json",
		"gh stack view --short --json",
		"g'h' st'a'ck v'ie'w --j's'on",
		'"g"h "st"a"ck" view --json',
		"gh ''stack'' view",
		"gh sta\\\nck view --json",
		'gh "sta\\\nck" view --json',
		...[
			"add",
			"checkout",
			"init",
			"modify",
			"unstack",
			"view",
			"link",
			"merge",
			"push",
			"rebase",
			"submit",
			"sync",
			"bottom",
			"down",
			"switch",
			"top",
			"trunk",
			"up",
			"alias",
			"feedback",
		].flatMap((subcommand) =>
			["--help", "-h"].map((flag) => `gh stack ${subcommand} ${flag}`),
		),
	]) {
		test(`automatically allows inspection: ${command}`, async () => {
			const { result, selectCalls } = await invoke(command, createProject([]));
			assert.equal(result, undefined);
			assert.deepEqual(selectCalls, []);
		});
	}

	for (const command of [
		"gh stack init topic",
		"gh stack add topic",
		"gh stack add -Am 'Commit all changes' topic",
		"gh stack checkout topic",
		"gh stack modify",
		"gh stack unstack",
		"gh stack unstack --local",
		"gh stack delete",
		"gh stack link 41 42",
		"gh stack merge --yes --squash",
		"gh stack push",
		"gh stack rebase",
		"gh stack rebase --abort",
		"gh stack submit --auto",
		"gh stack sync",
		"gh stack sync --prune",
		"gh stack bottom",
		"gh stack down",
		"gh stack switch",
		"gh stack top",
		"gh stack trunk",
		"gh stack up --print-path",
		"gh stack alias",
		"gh stack feedback",
		"gh stack unknown",
		"gh stack view --output=stack.json",
		"gh stack view unexpected-operand",
		"gh stack view --json --unknown",
		"gh stack --version sync",
		"gh stack sync --prune --help",
		"gh st'a'ck sync",
		'gh st"a"ck sync',
		"g'h' stack sync",
		'"g"h stack sync',
		'"gh" "st"a"ck" sync',
		"gh sta\\\nck sync",
		'gh "sta\\\nck" sync',
		"gh stack \"v'ie'w\"",
		"gh stack 'vi\"ew'",
		"gh stack view --j's'on --unknown",
	]) {
		for (const broadRules of [false, true]) {
			test(`requires approval${broadRules ? " despite broad rules" : ""}: ${command}`, async () => {
				const { result, selectCalls } = await invoke(
					command,
					createProject(broadRules ? ["gh *", "gh stack *"] : []),
				);
				assert.deepEqual(result, { block: true, reason: "Blocked by user" });
				assert.equal(selectCalls.length, 1);
				assert.equal(
					selectCalls[0].options.includes("Allow for this session"),
					false,
				);
			});
		}
	}

	test("only skips read-only stack stages in compound commands", async () => {
		const { result, selectCalls } = await invoke(
			"gh stack view --json | jq . && gh st'a'ck sync",
			createProject(["gh *"]),
		);
		assert.deepEqual(result, { block: true, reason: "Blocked by user" });
		assert.equal(selectCalls.length, 1);
		assert.match(selectCalls[0].message, /gh st'a'ck sync/);
	});

	test("allows a pipeline when every stage is read-only", async () => {
		const { result, selectCalls } = await invoke(
			"gh stack view --json | jq .",
			createProject([]),
		);
		assert.equal(result, undefined);
		assert.deepEqual(selectCalls, []);
	});

	test("does not allow command substitution in stack inspection", async () => {
		const { result, selectCalls } = await invoke(
			"gh stack view $(gh stack sync)",
			createProject(["gh *"]),
		);
		assert.deepEqual(result, { block: true, reason: "Blocked by user" });
		assert.equal(selectCalls.length, 1);
	});

	for (const rule of [
		"Bash(gh stack *)",
		"Bash(gh stack:*)",
		"Bash(gh stack view --json)",
	]) {
		test(`explicit deny ${rule} overrides equivalent stack inspection`, async () => {
			const cwd = createProject([]);
			writePiPermissions(cwd, { deny: [rule] });
			for (const command of [
				"gh stack view --json",
				"gh st'a'ck view --json",
				"g'h' stack view --json",
				'"gh" stack view --json',
				'gh stack "view" --json',
				"gh stack view --j's'on",
				"gh sta\\\nck view --json",
				'gh "sta\\\nck" view --json',
				"gh stack view --json | jq .",
				"gh st'a'ck view --json | jq .",
				"gh st'a'ck view --json > /tmp/stack.json",
			]) {
				const { result, selectCalls } = await invoke(command, cwd);
				assert.equal(
					(result as { block: boolean } | undefined)?.block,
					true,
					command,
				);
				assert.match(
					(result as { reason: string }).reason,
					/matches deny rule/,
					command,
				);
				assert.deepEqual(selectCalls, [], command);
			}
		});
	}

	for (const rule of [
		"Bash(gh 'stack view' --json)",
		"Bash(gh stack view --json '')",
		"Bash(gh stack 'vi\"ew' --json)",
		"Bash(gh stack 'vi\\\new' --json)",
	]) {
		test(`preserves argument values when checking deny ${rule}`, async () => {
			const cwd = createProject([]);
			writePiPermissions(cwd, { deny: [rule] });
			const { result, selectCalls } = await invoke("gh stack view --json", cwd);
			assert.equal(result, undefined);
			assert.deepEqual(selectCalls, []);
		});
	}
});

describe("safe signing, documentation, GitHub kit, and OpenSSL inspection", () => {
	beforeEach(() => {
		vi.stubEnv("HOME", createEmptyProject());
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	for (const command of [
		"codesign --help",
		"codesign -dv --verbose=4 'Example App.app'",
		"codesign -dvvv App.app",
		"codesign -vv --deep --strict App.app",
		"codesign --verify --verbose App.app",
		"codesign --display --entitlements :- App.app",
		"codesign -d --entitlements - --xml App.app",
		"codesign -d --entitlements=- App.app",
		"codesign -d -r- App.app",
		"codesign --display --requirements - --file-list - App.app",
		"codesign --hosting 123",
		"codesign --validate-constraint constraint.plist",
		"security help find-generic-password",
		"security find-identity -v -p codesigning",
		"security find-certificate -a -c 'Apple Development' -p",
		"security list-keychains",
		"security list-keychains -d user",
		"security default-keychain -d system",
		"security login-keychain",
		"security show-keychain-info login.keychain-db",
		"security dump-trust-settings -d",
		"security list-smartcards",
		"security error -25300",
		"apple-docs --help",
		"apple-docs --version",
		"apple-docs help cache clean",
		"apple-docs technologies list --agent",
		"apple-docs types list --technology Foundation --agent",
		"apple-docs types search URLSession --technology Foundation --agent",
		"apple-docs types view URLSession --technology Foundation --agent --json",
		"apple-docs agent skills list",
		"apple-docs agent skills get apple-docs",
		"gh kit --help",
		"gh kit help workflows rerun",
		"gh kit pr comments --pr 123 -R owner/repo",
		"gh kit workflows logs --job 123 -R owner/repo",
		"gh kit agent skills list",
		"gh kit agent skills get gh-kit",
		"openssl help",
		"openssl version -a",
		"openssl x509 -help",
		"openssl x509 -in cert.pem -noout -text",
		"openssl x509 -inform DER -in cert.der -noout -subject -issuer -dates",
		"openssl x509 -in cert.pem -noout -fingerprint -sha256",
		"openssl x509 -in cert.pem -checkend 86400 -noout",
		"openssl x509 -in cert.pem -pubkey -noout",
		"openssl dgst -sha256 archive.zip",
		"openssl dgst -sha512 -verify public.pem -signature signature.bin archive.zip",
		"openssl verify -CAfile ca.pem -untrusted intermediate.pem cert.pem",
		"openssl x509 -in cert.pem -noout -subject | openssl dgst -sha256",
	]) {
		test(`automatically allows inspection: ${command}`, async () => {
			const { result, selectCalls } = await invoke(command, createProject([]));
			assert.equal(result, undefined);
			assert.deepEqual(selectCalls, []);
		});
	}

	for (const command of [
		"codesign --sign - App.app",
		"codesign -dvs- App.app",
		"codesign -d --sign=- App.app",
		"codesign --remove-signature App.app",
		"codesign -d --entitlements output.plist App.app",
		"codesign -d --entitlements=- --entitlements=output.plist App.app",
		"codesign -d --requirements output.txt App.app",
		"codesign -d -routput.txt App.app",
		"codesign -d --extract-certificates App.app",
		"codesign -d --extract-certificates=cert App.app",
		"codesign -d --file-list output.txt App.app",
		"codesign -d --output-detached-certificates certs.bin App.app",
		"codesign -d --entitle=output.plist App.app",
		"codesign -d -'s' - App.app",
		"security list-keychains -s login.keychain-db",
		"security list-keychains -ds user login.keychain-db",
		"security default-keychain -s login.keychain-db",
		"security login-keychain -s login.keychain-db",
		"security find-generic-password -s service -w",
		"security find-internet-password -s example.com -g",
		"security dump-keychain -d",
		"security export -t privKeys",
		"security unlock-keychain login.keychain-db",
		"security delete-certificate -c name",
		"security authorizationdb write system.login.console allow",
		"security -i",
		"apple-docs cache clean",
		"apple-docs agent skills install --all",
		"apple-docs agent skills uninstall --all --yes",
		"gh kit workflows rerun --failed --pr 123",
		"gh kit workflows cancel-all --pr 123",
		"gh kit agent skills install --all",
		"gh kit agent skills uninstall --all --yes",
		"openssl genrsa -out private.pem 2048",
		"openssl rsa -in private.pem -text",
		"openssl pkey -in private.pem -text",
		"openssl pkcs12 -in bundle.p12 -nodes",
		"openssl dgst -sha256 -out digest.txt archive.zip",
		"openssl dgst -sha256 -sign private.pem archive.zip",
		"openssl dgst -sha256 -writerand random.bin archive.zip",
		"openssl dgst -sha256 -engine custom archive.zip",
		"openssl x509 -in cert.pem -out output.pem",
		"openssl x509 -in cert.pem -signkey private.pem",
		"openssl x509 -in cert.pem -CA ca.pem -CAcreateserial",
		"openssl x509 -in cert.pem -provider ./custom.dylib",
		"openssl verify -provider-path . cert.pem",
		"openssl req -new -newkey rsa:2048 -keyout private.pem",
		"openssl s_client -connect example.com:443",
	]) {
		for (const broadRules of [false, true]) {
			test(`requires approval${broadRules ? " despite broad rules" : ""}: ${command}`, async () => {
				const cwd = createProject(
					broadRules
						? [
								"codesign *",
								"security *",
								"apple-docs *",
								"gh kit *",
								"openssl *",
							]
						: [],
				);
				const { result, selectCalls } = await invoke(command, cwd);
				assert.deepEqual(result, { block: true, reason: "Blocked by user" });
				assert.equal(selectCalls.length, 1);
			});
		}
	}

	test("only skips approved inspection stages in compound commands", async () => {
		const { result, selectCalls } = await invoke(
			"gh kit pr comments --pr 123 && gh kit workflows rerun --failed --pr 123",
			createProject([]),
		);
		assert.deepEqual(result, { block: true, reason: "Blocked by user" });
		assert.equal(selectCalls.length, 1);
		assert.match(selectCalls[0].message, /gh kit workflows rerun/);
	});

	test("explicit denies override the new inspection variants", async () => {
		const cwd = createProject([]);
		writePiPermissions(cwd, {
			deny: [
				"Bash(codesign *)",
				"Bash(security *)",
				"Bash(apple-docs *)",
				"Bash(gh kit *)",
				"Bash(openssl *)",
			],
		});
		for (const command of [
			"codesign -dv App.app",
			"security find-identity -v",
			"apple-docs technologies list --agent",
			"gh kit pr comments --pr 123",
			"openssl x509 -in cert.pem -noout -text",
		]) {
			const { result, selectCalls } = await invoke(command, cwd);
			assert.equal((result as { block: boolean }).block, true);
			assert.deepEqual(selectCalls, []);
		}
	});
});

test("auto-allows Sentry docs without a project rule", async () => {
	const projectDirectory = createProject([]);

	for (const command of ["sentry docs search tracing", "sentry docs --help"]) {
		const { result, selectCalls } = await invoke(command, projectDirectory);
		assert.equal(result, undefined, command);
		assert.deepEqual(selectCalls, [], command);
	}
});

test("auto-allows simulator listing without a project rule", async () => {
	const projectDirectory = createProject([]);

	for (const command of [
		"xcrun simctl list devices",
		"xcrun simctl list --json",
	]) {
		const { result, selectCalls } = await invoke(command, projectDirectory);
		assert.equal(result, undefined, command);
		assert.deepEqual(selectCalls, [], command);
	}
});

test("auto-allows read-only simulator subcommands without a project rule", async () => {
	const projectDirectory = createProject([]);
	const commands = [
		"xcrun simctl appinfo booted com.example.app",
		"xcrun simctl get_app_container device-id com.example.app data",
		"xcrun simctl getenv booted HOME",
		"xcrun simctl help",
		"xcrun simctl help erase",
		"xcrun simctl listapps booted",
		"xcrun simctl pbpaste booted",
		"xcrun simctl pbpaste -v device-id",
		"xcrun simctl io device-id enumerate",
		"xcrun simctl io booted enumerate --poll",
		"xcrun simctl io booted poll",
		"xcrun simctl location device-id list",
		"xcrun simctl runtime list",
		"xcrun simctl runtime list -v --json",
		"xcrun simctl runtime match list -j",
		"xcrun simctl ui device-id appearance",
		"xcrun simctl ui booted increase_contrast",
		"xcrun simctl ui booted content_size",
	];

	for (const command of commands) {
		const { result, selectCalls } = await invoke(command, projectDirectory);
		assert.equal(result, undefined, command);
		assert.deepEqual(selectCalls, [], command);
	}
});

test("keeps mutating and file-writing simulator commands behind approval", async () => {
	const projectDirectory = createProject([]);
	const commands = [
		"xcrun simctl boot device-id",
		"xcrun simctl erase all",
		"xcrun simctl spawn booted rm -rf /tmp/data",
		"xcrun simctl diagnose --output /tmp/diagnostics",
		"xcrun simctl io booted screenshot enumerate",
		"xcrun simctl io booted recordVideo poll",
		"xcrun simctl io booted screenConfig power off",
		"xcrun simctl location booted set 0,0",
		"xcrun simctl runtime delete all",
		"xcrun simctl runtime match set sdk build",
		"xcrun simctl runtime list --json-output=/tmp/runtimes.json",
		"xcrun simctl runtime match list --json-output /tmp/runtimes.json",
		"xcrun simctl ui booted appearance dark",
		"xcrun simctl ui booted increase_contrast enabled",
		"xcrun simctl ui booted content_size increment",
		"xcrun simctl ui booted appearance dark appearance",
		"xcrun simctl listapps booted && xcrun simctl erase all",
	];

	for (const command of commands) {
		const { result, selectCalls } = await invoke(command, projectDirectory);
		assert.deepEqual(
			result,
			{ block: true, reason: "Blocked by user" },
			command,
		);
		assert.equal(selectCalls.length, 1, command);
	}
});

test("auto-allows additional built-in low-risk commands", async () => {
	const projectDirectory = createProject([]);
	const commands = [
		"cmp before.txt after.txt",
		"sleep 1",
		"shasum archive.zip",
		"strings AppBinary",
		"nm AppBinary",
		"sentry --help",
		"sentry --version",
		"sentry help issue view",
		"sentry dashboard --help",
		"sentry cli defaults --help",
		"sentry auth status --json",
		"sentry auth whoami --json",
		"sentry cli defaults",
		"sentry cli fix --dry-run",
		"sentry cli import --dry-run",
		"sentry cli upgrade --check",
		"sentry dashboard list org/",
		"sentry dashboard view org/project/dashboard",
		"sentry dashboard revisions org/dashboard",
		"sentry org list",
		"sentry org view org",
		"sentry project list org/",
		"sentry project view org/project",
		"sentry replay list org/project",
		"sentry replay view replay-id",
		"sentry release list org/project",
		"sentry release view org/version",
		"sentry release deploys org/version",
		"sentry release propose-version --json",
		"sentry repo list org",
		"sentry team list org",
		"sentry issue list org/project",
		"sentry issue events PROJECT-1",
		"sentry issue view PROJECT-1",
		"sentry event list PROJECT-1",
		"sentry event view event-id",
		"sentry explore --json",
		"sentry log list org/project",
		"sentry log view log-id",
		"sentry span list org/project",
		"sentry span view span-id",
		"sentry trace list org/project",
		"sentry trace view 0123456789abcdef0123456789abcdef",
		"sentry trace logs 0123456789abcdef0123456789abcdef",
		"sentry trial list org",
		"sentry schema issues list",
		"git check-ignore build/output.js",
		"bundle info rake",
		"bundle show rake",
	];

	for (const command of commands) {
		const { result, selectCalls } = await invoke(command, projectDirectory);
		assert.equal(result, undefined, command);
		assert.deepEqual(selectCalls, [], command);
	}
});

test("auto-allows help for built-in GitHub and Sentry commands", async () => {
	const projectDirectory = createProject([]);
	for (const command of [
		"gh --help",
		"gh help api",
		"gh api --help",
		"gh api repos/{owner}/{repo}/issues --help",
		"gh project item-list --help",
		"sentry --help",
		"sentry api --help",
		"sentry api issues/123/ --help",
		"sentry alert issues list --help",
	]) {
		const { result, selectCalls } = await invoke(command, projectDirectory);
		assert.equal(result, undefined, command);
		assert.deepEqual(selectCalls, [], command);
	}
});

test("auto-allows documented GitHub inspection commands", async () => {
	const projectDirectory = createProject([]);
	for (const command of [
		"gh gist list",
		"gh gist view gist-id",
		"gh org list",
		"gh project field-list 1 --owner org",
		"gh project item-list 1 --owner org",
		"gh project view 1 --owner org",
		"gh workflow list",
		"gh workflow view build.yml",
		"gh ruleset check main",
		"gh cache list",
	]) {
		const { result, selectCalls } = await invoke(command, projectDirectory);
		assert.equal(result, undefined, command);
		assert.deepEqual(selectCalls, [], command);
	}
});

describe("GitHub run watch permissions", () => {
	beforeEach(() => {
		vi.stubEnv("HOME", createEmptyProject());
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	for (const command of [
		"gh run watch",
		"gh run watch 123",
		"gh run watch 123 --exit-status --interval 5 --compact -R owner/repo",
	]) {
		test(`automatically allows without a project rule: ${command}`, async () => {
			const { result, selectCalls } = await invoke(command, createProject([]));
			assert.equal(result, undefined);
			assert.deepEqual(selectCalls, []);
		});
	}

	test("still prompts for a mutating stage after watching a run", async () => {
		const { result, selectCalls } = await invoke(
			"gh run watch 123 --exit-status && gh run rerun 123",
			createProject([]),
		);
		assert.deepEqual(result, { block: true, reason: "Blocked by user" });
		assert.equal(selectCalls.length, 1);
		assert.match(selectCalls[0].message, /gh run rerun 123/);
	});

	test("explicit deny rules override automatic run watch approval", async () => {
		const cwd = createProject([]);
		writePiPermissions(cwd, { deny: ["Bash(gh run watch:*)"] });
		const { result, selectCalls } = await invoke("gh run watch 123", cwd);
		assert.deepEqual(result, {
			block: true,
			reason: 'Bash command matches deny rule "Bash(gh run watch:*)"',
		});
		assert.deepEqual(selectCalls, []);
	});
});

test("auto-allows documented Sentry inspection commands", async () => {
	const projectDirectory = createProject([]);
	for (const command of [
		"sentry alert issues list org/project",
		"sentry alert metrics view org/project/123",
		"sentry agent-conversation view org/conversation-id",
		"sentry debug-files check App.dSYM",
		"sentry feedback list org/project",
		"sentry monitor list org/project",
		"sentry platform list",
		"sentry sourcemap resolve ./dist",
		"sentry status show",
	]) {
		const { result, selectCalls } = await invoke(command, projectDirectory);
		assert.equal(result, undefined, command);
		assert.deepEqual(selectCalls, [], command);
	}
});

test("keeps sensitive and mutating Sentry commands behind approval", async () => {
	const projectDirectory = createProject([]);
	const commands = [
		"sentry api projects/ -X DELETE",
		"sentry auth token",
		"sentry auth status --show-token",
		"sentry issue resolve PROJECT-1",
		"sentry issue explain PROJECT-1 --force",
		"sentry monitor run nightly -- echo ready",
		"sentry project delete org/project",
	];

	for (const command of commands) {
		const { result, selectCalls } = await invoke(command, projectDirectory);
		assert.deepEqual(
			result,
			{ block: true, reason: "Blocked by user" },
			command,
		);
		assert.equal(selectCalls.length, 1, command);
	}
});

test("auto-allows a pipeline of built-in safe commands without any project allow rule", async () => {
	const projectDirectory = createProject([]);
	const { result, selectCalls } = await invoke(
		"grep -R token Sources | head -20",
		projectDirectory,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectCalls, []);
});

test("still prompts for a command that is neither built-in nor allowlisted", async () => {
	const projectDirectory = createProject([]);
	const { result, selectCalls } = await invoke(
		"unfamiliar-tool --do-something",
		projectDirectory,
	);

	assert.deepEqual(result, { block: true, reason: "Blocked by user" });
	assert.equal(selectCalls.length, 1);
});

test("reads a global permission file only once per rule kind", async () => {
	const temporaryHome = createEmptyProject();
	const projectDirectory = path.join(temporaryHome, "project");
	fs.mkdirSync(projectDirectory);
	const previousHome = process.env.HOME;
	process.env.HOME = temporaryHome;
	const globalPermissionsDirectory = path.join(temporaryHome, ".pi", "agent");
	fs.mkdirSync(globalPermissionsDirectory, { recursive: true });
	fs.writeFileSync(
		path.join(globalPermissionsDirectory, "permissions.json"),
		"invalid JSON",
	);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

	try {
		await invoke("unfamiliar-tool --do-something", projectDirectory);
		assert.equal(warn.mock.calls.length, 2);
	} finally {
		warn.mockRestore();
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
	}
});

test("describes all configured permission sources when no UI is available", async () => {
	const projectDirectory = createProject([]);
	const handler = createHandler();

	const result = await handler(
		{ toolName: "bash", input: { command: "unfamiliar-tool --do-something" } },
		{ cwd: projectDirectory, hasUI: false },
	);

	assert.deepEqual(result, {
		block: true,
		reason:
			"Bash command is not allowed by configured permissions and no UI is available.",
	});
});

test("prompts for an unallowlisted command after shell control operators", async () => {
	const projectDirectory = createProject(["git add *"]);

	for (const command of [
		"git add first-file && git commit -m commit",
		"git add first-file; git commit -m commit",
		"git add first-file | git commit -m commit",
	]) {
		const { result, selectCalls } = await invoke(command, projectDirectory, [
			"No",
		]);
		assert.deepEqual(
			result,
			{ block: true, reason: "Blocked by user" },
			command,
		);
		assert.equal(selectCalls.length, 1, command);
		assert.match(selectCalls[0].message, /git commit -m commit/, command);
		assert.equal(selectCalls[0].options.length, 3, command);
	}
});
