import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	type ContextEvent,
	discoverAndLoadExtensions,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionEvent,
	SessionManager,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import { test } from "vitest";
import tasksExtension from "../extensions/tasks.ts";

type Handler = (
	event: ExtensionEvent,
	ctx: ExtensionContext,
) => unknown | Promise<unknown>;
type Widget = (tui: unknown, theme: Theme) => Component;

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

function createExtension(session = SessionManager.inMemory()) {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, ToolDefinition>();
	const widgets = new Map<string, Widget | string[] | undefined>();
	const statuses = new Map<string, string | undefined>();
	const ctx = {
		mode: "tui",
		hasUI: true,
		sessionManager: session,
		ui: {
			setWidget(key: string, widget: Widget | string[] | undefined) {
				widgets.set(key, widget);
			},
			setStatus(key: string, status: string | undefined) {
				statuses.set(key, status);
			},
		},
	} as unknown as ExtensionContext;
	const api = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		appendEntry(type: string, data: unknown) {
			session.appendCustomEntry(type, data);
		},
	};
	tasksExtension(api as ExtensionAPI);

	function tool() {
		const registered = tools.get("tasks");
		assert.ok(registered, "must register the agent's tasks tool");
		return registered;
	}

	return {
		api,
		ctx,
		session,
		statuses,
		widgets,
		tool,
		async emit(event: ExtensionEvent) {
			const handler = handlers.get(event.type);
			assert.ok(handler, `must handle ${event.type}`);
			return handler(event, ctx);
		},
		async context(messages: ContextEvent["messages"] = []) {
			const handler = handlers.get("context");
			assert.ok(handler, "must supply the current task summary to model calls");
			return (await handler({ type: "context", messages }, ctx)) as {
				messages: ContextEvent["messages"];
			};
		},
		async call(input: unknown) {
			const registered = tool();
			Value.Assert(registered.parameters, input);
			return registered.execute("call-1", input, undefined, undefined, ctx);
		},
		renderWidget(width = 100) {
			const widget = widgets.get("tasks");
			return typeof widget === "function"
				? widget({}, theme).render(width)
				: (widget ?? []);
		},
	};
}

const initialList = {
	action: "set",
	title: "Repair authentication",
	tasks: [
		{
			label: "Investigate token expiry",
			description:
				"Goal: reproduce premature logout. Inspect src/auth.ts. Keep the public API unchanged. Done when a regression test reproduces the expiry bug.",
		},
		{
			label: "Fix and verify expiry",
			description:
				"Correct token expiry in src/auth.ts. Preserve refresh behavior. Run tests/auth.test.ts and the complete check suite.",
		},
	],
};

function text(result: Awaited<ReturnType<ToolDefinition["execute"]>>) {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

test("creates a durable list with numbered pending tasks and readable descriptions", async () => {
	const extension = createExtension();
	await extension.call(initialList);

	const result = await extension.call({ action: "get" });
	assert.match(text(result), /Repair authentication/);
	assert.match(text(result), /#1.*pending.*Investigate token expiry/);
	assert.match(text(result), /#2.*pending.*Fix and verify expiry/);
	assert.ok(text(result).includes(initialList.tasks[0].description));
	assert.ok(text(result).includes(initialList.tasks[1].description));
	assert.equal(extension.session.getBranch().length, 1);
	assert.equal(extension.session.getLeafEntry()?.type, "custom");
});

test("updates progress without losing the task's description or other tasks", async () => {
	const extension = createExtension();
	await extension.call(initialList);
	await extension.call({
		action: "update",
		id: 1,
		status: "in_progress",
		notes:
			"Expiry is stored in seconds but compared to milliseconds. Next: add a regression test.",
	});

	const result = await extension.call({ action: "get", id: 1 });
	assert.match(text(result), /#1.*in_progress/);
	assert.ok(text(result).includes(initialList.tasks[0].description));
	assert.match(text(result), /compared to milliseconds/);
	assert.doesNotMatch(text(result), /#2/);
	assert.ok(
		text(await extension.call({ action: "get", id: 2 })).includes(
			initialList.tasks[1].description,
		),
	);
	assert.equal(extension.session.getBranch().length, 2);
});

test("adapts a task's label and description through the tool and can clear notes", async () => {
	const extension = createExtension();
	await extension.call(initialList);
	await extension.call({
		action: "update",
		id: 2,
		label: "Test the refresh flow",
		description: "Only cover refresh behavior in tests/refresh.test.ts.",
		status: "blocked",
		notes: "Waiting for test credentials.",
	});
	await extension.call({ action: "update", id: 2, notes: "" });

	const result = await extension.call({ action: "get", id: 2 });
	assert.match(text(result), /Test the refresh flow/);
	assert.match(text(result), /Only cover refresh behavior/);
	assert.match(text(result), /blocked/);
	assert.doesNotMatch(text(result), /Waiting for test credentials/);
	assert.doesNotMatch(text(result), /Correct token expiry/);
});

test("replaces the objective rather than appending stale tasks", async () => {
	const extension = createExtension();
	await extension.call(initialList);
	await extension.call({
		action: "set",
		title: "Update dependencies",
		tasks: [
			{
				label: "Review the lockfile",
				description: "Check changed versions and run npm run check.",
				status: "in_progress",
			},
		],
	});

	const result = await extension.call({ action: "get" });
	assert.match(text(result), /Update dependencies/);
	assert.match(text(result), /#1.*in_progress.*Review the lockfile/);
	assert.doesNotMatch(text(result), /authentication|#2/);
});

test("clears the list durably without resurrecting a previous snapshot", async () => {
	const extension = createExtension();
	await extension.call(initialList);
	await extension.call({ action: "clear" });
	assert.match(
		text(await extension.call({ action: "get" })),
		/No active task list/,
	);
	assert.equal(extension.statuses.get("tasks"), undefined);
	assert.deepEqual(extension.renderWidget(), []);

	const reloaded = createExtension(extension.session);
	await reloaded.emit({ type: "session_start", reason: "reload" });
	assert.match(
		text(await reloaded.call({ action: "get" })),
		/No active task list/,
	);
});

for (const input of [
	{ action: "set", tasks: initialList.tasks },
	{ action: "set", title: "Missing tasks" },
	{ action: "set", title: "Empty list", tasks: [] },
	{ action: "set", title: " ", tasks: initialList.tasks },
	{
		action: "set",
		title: "Invalid task",
		tasks: [{ label: " ", description: "Description" }],
	},
	{
		action: "set",
		title: "Missing handoff",
		tasks: [{ label: "Task without context" }],
	},
	{ action: "update", status: "done" },
	{ action: "update", id: 1 },
	{ action: "update", id: 99, status: "done" },
	{ action: "update", id: 1, status: "invalid" },
	{ action: "update", id: 1, description: " " },
	{ action: "get", id: 99 },
]) {
	test(`rejects invalid task operations without changing the list: ${JSON.stringify(input)}`, async () => {
		const extension = createExtension();
		await extension.call(initialList);
		const before = text(await extension.call({ action: "get" }));

		await assert.rejects(extension.call(input));

		assert.equal(text(await extension.call({ action: "get" })), before);
		assert.equal(extension.session.getBranch().length, 1);
	});
}

test("does not change in-memory state or UI when persistence fails", async () => {
	const extension = createExtension();
	await extension.call(initialList);
	const before = text(await extension.call({ action: "get" }));
	const widgetBefore = extension.renderWidget();
	extension.api.appendEntry = () => {
		throw new Error("Session write failed");
	};

	await assert.rejects(
		extension.call({ action: "update", id: 1, status: "done" }),
		/Session write failed/,
	);
	assert.equal(text(await extension.call({ action: "get" })), before);
	assert.deepEqual(extension.renderWidget(), widgetBefore);
});

for (const reason of ["startup", "reload", "resume", "fork"] as const) {
	test(`restores descriptions and progress on session ${reason}`, async () => {
		const original = createExtension();
		await original.call(initialList);
		await original.call({
			action: "update",
			id: 1,
			status: "blocked",
			notes: "Waiting for a reproduction from the user.",
		});
		const restored = createExtension(original.session);
		await restored.emit({ type: "session_start", reason });

		const result = await restored.call({ action: "get", id: 1 });
		assert.match(text(result), /blocked/);
		assert.match(text(result), /Waiting for a reproduction/);
		assert.ok(text(result).includes(initialList.tasks[0].description));
		assert.match(
			restored.renderWidget().join("\n"),
			/Investigate token expiry/,
		);
	});
}

test("restores only the active branch, without mutating older snapshots", async () => {
	const extension = createExtension();
	await extension.call(initialList);
	const initialLeaf = extension.session.getLeafId();
	assert.ok(initialLeaf);
	await extension.call({
		action: "update",
		id: 1,
		status: "done",
		notes: "Regression test now reproduces the issue.",
	});
	const completedLeaf = extension.session.getLeafId();
	assert.ok(completedLeaf);

	extension.session.branch(initialLeaf);
	await extension.emit({
		type: "session_tree",
		oldLeafId: completedLeaf,
		newLeafId: initialLeaf,
	});
	const earlier = text(await extension.call({ action: "get", id: 1 }));
	assert.match(earlier, /pending/);
	assert.doesNotMatch(earlier, /Regression test now/);

	await extension.call({
		action: "update",
		id: 1,
		status: "blocked",
		notes: "Alternative branch investigation.",
	});
	extension.session.branch(completedLeaf);
	await extension.emit({
		type: "session_tree",
		oldLeafId: null,
		newLeafId: completedLeaf,
	});
	const completed = text(await extension.call({ action: "get", id: 1 }));
	assert.match(completed, /done/);
	assert.match(completed, /Regression test now/);
	assert.doesNotMatch(completed, /Alternative branch/);
});

test("navigating before the list was created removes stale state and UI", async () => {
	const extension = createExtension();
	await extension.call(initialList);
	extension.session.resetLeaf();
	await extension.emit({
		type: "session_tree",
		oldLeafId: null,
		newLeafId: null,
	});

	assert.match(
		text(await extension.call({ action: "get" })),
		/No active task list/,
	);
	assert.deepEqual(extension.renderWidget(), []);
	assert.equal(extension.statuses.get("tasks"), undefined);
});

test("starting a new session does not reuse the previous session's list", async () => {
	const extension = createExtension();
	await extension.call(initialList);
	extension.ctx.sessionManager = SessionManager.inMemory();
	await extension.emit({ type: "session_start", reason: "new" });

	assert.match(
		text(await extension.call({ action: "get" })),
		/No active task list/,
	);
	assert.deepEqual(extension.renderWidget(), []);
	assert.deepEqual((await extension.context()).messages, []);
});

for (const reason of ["manual", "threshold", "overflow"] as const) {
	test(`keeps full handoff details readable after ${reason} compaction`, async () => {
		const extension = createExtension();
		await extension.call(initialList);
		await extension.call({
			action: "update",
			id: 1,
			status: "in_progress",
			notes:
				"Confirmed seconds/milliseconds mismatch. Next: add tests/auth.test.ts coverage.",
		});
		const keptId = extension.session.appendMessage({
			role: "user",
			content: "Continue the investigation.",
			timestamp: Date.now(),
		});
		extension.session.appendCompaction(
			"Earlier conversation summarized.",
			keptId,
			100_000,
		);
		const compactionEntry = extension.session.getLeafEntry();
		assert.ok(compactionEntry?.type === "compaction");
		await extension.emit({
			type: "session_compact",
			reason,
			willRetry: reason === "overflow",
			fromExtension: false,
			compactionEntry,
		});

		const compacted = extension.session.buildSessionContext().messages;
		assert.ok(
			!JSON.stringify(compacted).includes(initialList.tasks[0].description),
		);
		const context = await extension.context(compacted);
		const summary = context.messages.at(-1);
		assert.ok(summary?.role === "custom");
		assert.equal(summary.display, false);
		assert.match(
			String(summary.content),
			/#1.*in_progress.*Investigate token expiry/,
		);
		assert.match(String(summary.content), /tasks.*get/);
		assert.ok(
			!String(summary.content).includes(initialList.tasks[0].description),
		);
		assert.match(
			extension.renderWidget().join("\n"),
			/Investigate token expiry/,
		);

		const handoff = text(await extension.call({ action: "get", id: 1 }));
		assert.ok(handoff.includes(initialList.tasks[0].description));
		assert.match(handoff, /Confirmed seconds\/milliseconds mismatch/);
		assert.match(handoff, /Next: add tests\/auth.test.ts coverage/);

		const reloaded = createExtension(extension.session);
		await reloaded.emit({ type: "session_start", reason: "resume" });
		assert.equal(text(await reloaded.call({ action: "get", id: 1 })), handoff);
	});
}

test("supplies fresh summaries without duplicating or persisting injected context", async () => {
	const extension = createExtension();
	await extension.call(initialList);
	const messages: ContextEvent["messages"] = [
		{ role: "user", content: "Keep working", timestamp: 1 },
		{
			role: "custom",
			customType: "another-extension",
			content: "Keep me",
			display: false,
			timestamp: 2,
		},
	];
	const first = await extension.context(messages);
	assert.equal(messages.length, 2, "must not mutate incoming context");
	assert.equal(first.messages.length, 3);
	await extension.call({ action: "update", id: 1, status: "done" });
	const next = await extension.context(first.messages);
	assert.equal(next.messages.length, 3);
	assert.deepEqual(next.messages.slice(0, 2), messages);
	assert.match(
		String((next.messages.at(-1) as { content: string }).content),
		/#1.*done/,
	);
	assert.equal(
		extension.session.getBranch().length,
		2,
		"summaries must not add session entries",
	);

	await extension.call({ action: "clear" });
	assert.deepEqual((await extension.context(next.messages)).messages, messages);
});

test("shows compact progress with active and blocked tasks before pending work", async () => {
	const extension = createExtension();
	await extension.call({
		action: "set",
		title: "A longer objective",
		tasks: [
			{
				label: "Finished step",
				description: "Completed earlier",
				status: "done",
			},
			{ label: "Optional step", description: "Not needed", status: "skipped" },
			{ label: "First queued step", description: "Waiting" },
			{ label: "Second queued step", description: "Waiting" },
			{ label: "Third queued step", description: "Waiting" },
			{
				label: "Current investigation",
				description: "Working",
				status: "in_progress",
			},
			{
				label: "Blocked verification",
				description: "Waiting for credentials",
				status: "blocked",
			},
		],
	});

	const lines = extension.renderWidget();
	assert.ok(lines.length <= 5, "the widget should remain compact");
	assert.match(lines[0], /A longer objective/);
	assert.match(lines[1], /Current investigation/);
	assert.match(lines[2], /Blocked verification/);
	assert.match(lines.join("\n"), /2 more/);
	assert.doesNotMatch(lines.join("\n"), /Finished step|Optional step/);
	assert.match(extension.statuses.get("tasks") ?? "", /1\/7 done/);
	assert.match(extension.statuses.get("tasks") ?? "", /1 skipped/);
	assert.match(extension.statuses.get("tasks") ?? "", /1 blocked/);
});

test("keeps completed progress visible without treating skipped work as done", async () => {
	const extension = createExtension();
	await extension.call(initialList);
	await extension.call({ action: "update", id: 1, status: "done" });
	await extension.call({ action: "update", id: 2, status: "skipped" });

	assert.equal(extension.renderWidget().length, 1);
	assert.match(extension.statuses.get("tasks") ?? "", /1\/2 done.*1 skipped/);
});

for (const mode of ["print", "json", "rpc"] as const) {
	test(`works without terminal UI in ${mode} mode`, async () => {
		const extension = createExtension();
		extension.ctx.mode = mode;
		extension.ctx.hasUI = mode === "rpc";
		extension.ctx.ui = new Proxy({} as ExtensionContext["ui"], {
			get() {
				throw new Error("Terminal UI must not be accessed");
			},
		});
		await extension.emit({ type: "session_start", reason: "startup" });
		await extension.call(initialList);
		await extension.call({ action: "update", id: 1, status: "done" });
		assert.match(text(await extension.call({ action: "get" })), /#1.*done/);
		assert.equal((await extension.context()).messages.length, 1);
		await extension.call({ action: "clear" });
	});
}

test("guards UI calls with hasUI even in TUI mode", async () => {
	const extension = createExtension();
	extension.ctx.hasUI = false;
	extension.ctx.ui = new Proxy({} as ExtensionContext["ui"], {
		get() {
			throw new Error("UI is unavailable");
		},
	});
	await extension.emit({ type: "session_start", reason: "startup" });
	await extension.call(initialList);
	await extension.call({ action: "clear" });
});

test("renders concise tool results by default and full handoff details when expanded", async () => {
	const extension = createExtension();
	await extension.call(initialList);
	const result = await extension.call({ action: "get", id: 1 });
	const render = extension.tool().renderResult;
	assert.ok(render, "task details should not flood the normal tool display");
	const compact = render(
		result,
		{ expanded: false, isPartial: false },
		theme,
		{} as never,
	)
		.render(200)
		.join("\n");
	assert.match(compact, /Investigate token expiry/);
	assert.ok(!compact.includes(initialList.tasks[0].description));
	const expanded = render(
		result,
		{ expanded: true, isPartial: false },
		theme,
		{} as never,
	)
		.render(200)
		.join("\n");
	assert.ok(expanded.includes(initialList.tasks[0].description));
	assert.doesNotMatch(expanded, /Fix and verify expiry/);
});

test("fits narrow terminals and does not render task text as terminal controls", async () => {
	const extension = createExtension();
	await extension.call({
		action: "set",
		title: "\u001b[2J\u001b[31mAuthentication\u001b[0m\nprogress",
		tasks: [
			{
				label: "\u001b[2JInvestigate\n\t认证令牌认证令牌认证令牌\u0007",
				description: "A durable description.",
			},
		],
	});

	for (const width of [1, 2, 10, 40]) {
		const lines = extension.renderWidget(width);
		assert.ok(lines.length > 0);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `line exceeds ${width} columns`);
			// Pi's truncation helper adds SGR resets around its ellipsis.
			assert.doesNotMatch(line.replaceAll("\u001b[0m", ""), /\p{Cc}/u);
		}
	}
	assert.match(
		extension.renderWidget(160).join("\n"),
		/Authentication progress/,
	);
});

test("restores handoff details from a compacted session on disk", async ({
	onTestFinished,
}) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-tasks-session-"));
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const session = SessionManager.create(directory, directory);
	session.appendMessage({
		role: "user",
		content: "Repair authentication",
		timestamp: 1,
	});
	// Pi starts persisting a new session when its first assistant message arrives.
	session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "I will investigate the expiry issue." }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4.1",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	});
	const extension = createExtension(session);
	await extension.call(initialList);
	await extension.call({
		action: "update",
		id: 1,
		status: "in_progress",
		notes: "Next: reproduce with an expired token.",
	});
	const keptId = session.appendMessage({
		role: "user",
		content: "Continue",
		timestamp: 3,
	});
	session.appendCompaction(
		"Earlier investigation summarized.",
		keptId,
		100_000,
	);
	const file = session.getSessionFile();
	assert.ok(file);

	const restored = createExtension(SessionManager.open(file));
	await restored.emit({ type: "session_start", reason: "resume" });
	const result = text(await restored.call({ action: "get", id: 1 }));
	assert.ok(result.includes(initialList.tasks[0].description));
	assert.match(result, /in_progress/);
	assert.match(result, /Next: reproduce with an expired token/);
});

test("loads the registered task extension through Pi's package loader", async ({
	onTestFinished,
}) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-tasks-loader-"));
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const loaded = await discoverAndLoadExtensions(
		[resolve(".")],
		directory,
		directory,
	);

	assert.deepEqual(loaded.errors, []);
	assert.ok(
		loaded.extensions.some((extension) => extension.tools.has("tasks")),
		"the package must expose the tasks tool",
	);
});
