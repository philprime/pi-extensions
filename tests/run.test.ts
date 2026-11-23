import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, test } from "vitest";
import permissionsExtension from "../extensions/permissions.ts";
import runExtension from "../extensions/run.ts";

const temporaryDirectories: string[] = [];
function project(allow: string[] = [], deny: string[] = []) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "background-permissions-"));
	temporaryDirectories.push(cwd);
	fs.mkdirSync(path.join(cwd, ".pi"));
	fs.writeFileSync(
		path.join(cwd, ".pi", "permissions.json"),
		JSON.stringify({
			permissions: { allow, deny },
		}),
	);
	return cwd;
}

const instances: { shutdown(reason: string): Promise<void> }[] = [];
function extension(hasUI = true, select = async () => "Yes", cwd = project()) {
	const commands = new Map<
		string,
		(args: string, ctx: ExtensionCommandContext) => Promise<void>
	>();
	const tools = new Map<string, ToolDefinition>();
	type Handler = (
		event: {
			reason?: string;
			toolName?: string;
			input?: unknown;
			parentToolCallId?: string;
		},
		ctx: ExtensionContext,
	) => Promise<{ block?: boolean; reason?: string } | undefined>;
	const handlers = new Map<string, Handler[]>();
	const notifications: string[] = [];
	const prompts: Array<{ message: string; options: string[] }> = [];
	const ctx = {
		cwd,
		hasUI,
		ui: {
			confirm: async () => (await select()) !== "No",
			notify(message: string) {
				notifications.push(message);
			},
			async select(message: string, options: string[]) {
				prompts.push({ message, options });
				return select();
			},
			async editor(_title: string, initialValue: string) {
				return initialValue;
			},
		},
	} as unknown as ExtensionCommandContext;
	const api = {
		registerCommand(name, command) {
			commands.set(name, command.handler);
		},
		registerTool(tool) {
			tools.set(tool.name, tool as unknown as ToolDefinition);
		},
		on(name, handler) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler as never);
			handlers.set(name, registered);
		},
	} as ExtensionAPI;
	permissionsExtension(api);
	runExtension(api);
	const instance = {
		notifications,
		prompts,
		ctx,
		guidance() {
			const tool = tools.get("background");
			assert.ok(tool);
			return {
				snippet: tool.promptSnippet,
				guidelines: tool.promptGuidelines ?? [],
			};
		},
		async command(args: string) {
			const handler = commands.get("bg");
			assert.ok(handler);
			await handler(args, ctx);
		},
		async tool(
			action: string,
			args: Record<string, unknown> = {},
			parentToolCallId?: string,
			signal = new AbortController().signal,
		) {
			const tool = tools.get("background");
			assert.ok(tool);
			for (const handler of handlers.get("tool_call") ?? []) {
				const approval = await handler(
					{
						toolName: "background",
						input: { action, ...args },
						parentToolCallId,
					},
					ctx,
				);
				if (approval?.block)
					return {
						content: [
							{ type: "text" as const, text: approval.reason ?? "Blocked" },
						],
						details: {},
						isError: true,
					};
			}
			const result = await tool.execute(
				"test",
				{ action, ...args },
				signal,
				() => {},
				ctx as never,
			);
			const content = result.content[0];
			assert.ok(content?.type === "text");
			return { ...result, content: [content] };
		},
		async shutdown(reason: string) {
			for (const handler of handlers.get("session_shutdown") ?? [])
				await handler({ reason }, ctx);
		},
	};
	instances.push(instance);
	return instance;
}

afterEach(async () => {
	for (const instance of instances.splice(0)) await instance.shutdown("quit");
	for (const directory of temporaryDirectories.splice(0))
		fs.rmSync(directory, { recursive: true, force: true });
});

async function until(check: () => Promise<boolean>, timeout = 3000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await check()) return;
		await delay(25);
	}
	assert.fail("Timed out waiting for background output");
}

const script = (code: string) =>
	`${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
const idle = script(
	"process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
);

test("agent is guided to use background for long-lived commands", () => {
	const guidance = extension().guidance();
	assert.match(guidance.snippet ?? "", /long-running/);
	assert.match(guidance.guidelines.join(" "), /background.*rather than.*bash/i);
	assert.match(guidance.guidelines.join(" "), /logs.*restart.*stop/i);
});

test("command starts multiple jobs and reads their output independently", async () => {
	const pi = extension();
	await pi.command(`start web ${idle}`);
	await pi.command(
		`start worker ${script("process.stderr.write('worker error\\n')")}`,
	);
	await until(
		async () =>
			(await pi.tool("logs", { name: "web" })).content[0]?.text.includes(
				"ready",
			) ?? false,
	);
	await until(
		async () =>
			(await pi.tool("logs", { name: "worker" })).content[0]?.text.includes(
				"worker error",
			) ?? false,
	);
	await until(async () =>
		/worker.*exited/.test((await pi.tool("list")).content[0]?.text ?? ""),
	);
	const result = await pi.tool("list");
	assert.match(result.content[0]?.text ?? "", /web.*running/);
	await pi.command("stop web");
	assert.match((await pi.tool("list")).content[0]?.text ?? "", /web.*stopped/);
});

test("wait blocks until completion and reports the exit code without approval", async () => {
	const pi = extension();
	await pi.command(
		`start worker ${script("const fs = require('node:fs'); setInterval(() => { if (fs.existsSync('release')) { console.log('done'); process.exit(7); } }, 10)")}`,
	);
	const headless = extension(false, async () => "No", pi.ctx.cwd);
	let completed = false;
	const pending = headless.tool("wait", { name: "worker" }).then((result) => {
		completed = true;
		return result;
	});
	await delay(25);
	assert.equal(completed, false);
	fs.writeFileSync(path.join(pi.ctx.cwd, "release"), "");
	const result = await pending;
	assert.equal(result.isError, undefined);
	assert.match(result.content[0].text, /worker.*exited.*7/);
	assert.match(
		(await pi.tool("logs", { name: "worker" })).content[0].text,
		/done/,
	);
	assert.deepEqual(headless.prompts, []);
});

test("wait times out without stopping the job and can be retried", async () => {
	const pi = extension();
	await pi.command(`start web ${idle}`);
	const result = await pi.tool("wait", { name: "web", timeout: 0.02 });
	assert.equal(result.isError, undefined);
	assert.match(result.content[0].text, /timed out/i);
	assert.match((await pi.tool("list")).content[0].text, /web.*running/);
	const pending = pi.tool("wait", { name: "web", timeout: 3 });
	await pi.command("stop web");
	assert.match((await pending).content[0].text, /web.*stopped/);
});

test("wait returns immediately for exited and stopped jobs", async () => {
	const pi = extension();
	await pi.command("start done printf done");
	await until(async () =>
		/done.*exited/.test((await pi.tool("list")).content[0].text),
	);
	assert.match(
		(await pi.tool("wait", { name: "done" })).content[0].text,
		/done.*exited.*0/,
	);
	await pi.command(`start web ${idle}`);
	await pi.command("stop web");
	assert.match(
		(await pi.tool("wait", { name: "web" })).content[0].text,
		/web.*stopped/,
	);
});

test("cancelling a wait leaves the background job running", async () => {
	const pi = extension();
	await pi.command(`start web ${idle}`);
	const controller = new AbortController();
	const pending = pi.tool(
		"wait",
		{ name: "web" },
		undefined,
		controller.signal,
	);
	await delay(25);
	controller.abort(new Error("Wait cancelled"));
	const result = await pending;
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Wait cancelled/);
	assert.match((await pi.tool("list")).content[0].text, /web.*running/);
});

test("the bg command accepts a wait timeout in seconds", async () => {
	const pi = extension();
	await pi.command(`start web ${idle}`);
	await pi.command("wait web 0.02");
	assert.match(pi.notifications.at(-1) ?? "", /timed out/i);
	assert.match((await pi.tool("list")).content[0].text, /web.*running/);
	await pi.command("wait web invalid");
	assert.match(pi.notifications.at(-1) ?? "", /timeout/i);
});

test("wait rejects missing jobs and invalid timeouts", async () => {
	const pi = extension();
	const missing = await pi.tool("wait", { name: "missing" });
	assert.equal(missing.isError, true);
	assert.match(missing.content[0].text, /Unknown background job/);
	await pi.command(`start web ${idle}`);
	for (const timeout of [
		0,
		-1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		2147484,
	]) {
		const result = await pi.tool("wait", { name: "web", timeout });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /timeout/i);
	}
});

test("listing jobs does not repeat command arguments", async () => {
	const pi = extension();
	await pi.command(
		`start sensitive ${script("process.stdout.write('ok')")} secret-token`,
	);
	const list = (await pi.tool("list")).content[0]?.text ?? "";
	assert.match(list, /sensitive/);
	assert.doesNotMatch(list, /secret-token/);
});

test("restart replaces a running job and retains readable logs", async () => {
	const pi = extension();
	await pi.command(`start web ${idle}`);
	await until(
		async () =>
			(await pi.tool("logs", { name: "web" })).content[0]?.text.includes(
				"ready",
			) ?? false,
	);
	await pi.command("restart web");
	await until(
		async () =>
			((await pi.tool("logs", { name: "web" })).content[0]?.text.match(/ready/g)
				?.length ?? 0) === 2,
	);
	assert.match(pi.notifications.at(-1) ?? "", /Restarted web/);
});

test("jobs survive reload and session switches but quit stops them", async () => {
	const first = extension();
	await first.command(
		`start web ${script("console.log(process.pid); setInterval(() => {}, 1000)")}`,
	);
	await until(async () =>
		/\d+/.test(
			(await first.tool("logs", { name: "web" })).content[0]?.text ?? "",
		),
	);
	const pid = Number(
		(await first.tool("logs", { name: "web" })).content[0]?.text.trim(),
	);
	await first.shutdown("reload");
	const second = extension();
	assert.match(
		(await second.tool("list")).content[0]?.text ?? "",
		/web.*running/,
	);
	await second.shutdown("new");
	assert.match(
		(await second.tool("list")).content[0]?.text ?? "",
		/web.*running/,
	);
	await second.shutdown("quit");
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	assert.match(
		(await second.tool("list")).content[0]?.text ?? "",
		/No background jobs/,
	);
});

test("approved agent starts and restarts share jobs with the command", async () => {
	const pi = extension();
	assert.equal(
		(await pi.tool("start", { name: "agent", command: idle })).isError,
		undefined,
	);
	await until(
		async () =>
			(await pi.tool("logs", { name: "agent" })).content[0]?.text.includes(
				"ready",
			) ?? false,
	);
	assert.equal(
		(await pi.tool("restart", { name: "agent" })).isError,
		undefined,
	);
	await pi.command("stop agent");
	assert.match(
		(await pi.tool("list")).content[0]?.text ?? "",
		/agent.*stopped/,
	);
});

test("agent start requires approval and fails closed without UI", async () => {
	const denied = extension(true, async () => "No");
	const refusal = await denied.tool("start", { name: "web", command: idle });
	assert.equal(refusal.isError, true);
	assert.match(
		(await denied.tool("list")).content[0]?.text ?? "",
		/No background jobs/,
	);
	const headless = extension(false);
	const result = await headless.tool("start", { name: "web", command: idle });
	assert.equal(result.isError, true);
	assert.match(
		(await headless.tool("list")).content[0]?.text ?? "",
		/No background jobs/,
	);
});

test("allowlisted background commands start headlessly without prompting", async () => {
	const pi = extension(
		false,
		async () => "No",
		project(["Bash(printf background-ready)"]),
	);
	const result = await pi.tool("start", {
		name: "allowed",
		command: "printf background-ready > output.log",
	});
	assert.equal(result.isError, undefined);
	assert.deepEqual(pi.prompts, []);
	await until(
		async () =>
			fs.existsSync(path.join(pi.ctx.cwd, "output.log")) &&
			fs.readFileSync(path.join(pi.ctx.cwd, "output.log"), "utf8") ===
				"background-ready",
	);
});

test("deny rules block background commands even when normally allowlisted", async () => {
	const pi = extension(true, async () => "Yes", project([], ["Bash(echo *)"]));
	const result = await pi.tool("start", {
		name: "denied",
		command: "echo denied",
	});
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /deny rule/);
	assert.deepEqual(pi.prompts, []);
	assert.match((await pi.tool("list")).content[0].text, /No background jobs/);
});

test("background compound commands use the standard per-stage approval UI", async () => {
	const pi = extension(true, async () => "No");
	const result = await pi.tool("start", {
		name: "compound",
		command: "echo allowed && printf needs-approval",
	});
	assert.equal(result.isError, true);
	assert.equal(pi.prompts.length, 1);
	assert.match(pi.prompts[0].message, /printf needs-approval/);
	assert.doesNotMatch(pi.prompts[0].message, /echo allowed/);
	assert.ok(pi.prompts[0].options.includes("Allow for this session"));
	assert.ok(
		pi.prompts[0].options.some((option) =>
			option.startsWith("Yes, and don’t ask again"),
		),
	);
	assert.match((await pi.tool("list")).content[0].text, /No background jobs/);
});

test("background starts and restarts share session approvals", async () => {
	const pi = extension(true, async () => "Allow for this session");
	assert.equal(
		(
			await pi.tool("start", {
				name: "session",
				command: "printf session-ready",
			})
		).isError,
		undefined,
	);
	assert.equal(
		(await pi.tool("restart", { name: "session" })).isError,
		undefined,
	);
	assert.equal(pi.prompts.length, 1);
	assert.equal(
		fs.existsSync(path.join(pi.ctx.cwd, ".pi", "permissions.local.json")),
		false,
	);
});

test("background approvals can persist standard Bash rules", async () => {
	const pi = extension();
	const save = extension(
		true,
		async () => {
			const choice = save.prompts
				.at(-1)
				?.options.find((option) =>
					option.startsWith("Yes, and don’t ask again"),
				);
			assert.ok(choice);
			return choice;
		},
		pi.ctx.cwd,
	);
	assert.equal(
		(await save.tool("start", { name: "saved", command: "printf saved-ready" }))
			.isError,
		undefined,
	);
	const saved = JSON.parse(
		fs.readFileSync(
			path.join(pi.ctx.cwd, ".pi", "permissions.local.json"),
			"utf8",
		),
	);
	assert.deepEqual(saved.permissions.allow, ["Bash(printf saved-ready *)"]);
	assert.equal(
		(await pi.tool("restart", { name: "saved" })).isError,
		undefined,
	);
	assert.deepEqual(pi.prompts, []);
});

test("restart checks the stored command and original directory, not supplied replacements", async () => {
	const original = project([], ["Bash(printf *)"]);
	const pi = extension(true, async () => "Yes", original);
	await pi.command("start original printf original-ready");
	pi.ctx.cwd = project(["Bash(printf *)"]);
	const result = await pi.tool("restart", {
		name: "original",
		command: "echo harmless",
	});
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /deny rule/);
	assert.deepEqual(pi.prompts, []);
});

test("nested background tool calls use the same permission gate", async () => {
	const pi = extension(true, async () => "No", project([], ["Bash(echo *)"]));
	const result = await pi.tool(
		"start",
		{ name: "sandbox", command: "echo nested" },
		"codemode-call",
	);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /deny rule/);
	assert.match((await pi.tool("list")).content[0].text, /No background jobs/);
});

test("pending agent approval cannot start a job after Pi quits", async () => {
	let approve: ((value: string) => void) | undefined;
	const pi = extension(
		true,
		() =>
			new Promise<string>((resolve) => {
				approve = resolve;
			}),
	);
	const pending = pi.tool("start", { name: "late", command: idle });
	await until(async () => approve !== undefined);
	await pi.shutdown("quit");
	approve?.("Yes");
	assert.equal((await pending).isError, true);
	assert.match(
		(await pi.tool("list")).content[0]?.text ?? "",
		/No background jobs/,
	);
});

test("duplicate and invalid starts cannot replace a running job", async () => {
	const pi = extension();
	await pi.command(`start web ${idle}`);
	const duplicate = await pi.tool("start", { name: "web", command: idle });
	assert.equal(duplicate.isError, true);
	await pi.command("start missing");
	assert.match(pi.notifications.at(-1) ?? "", /Usage/);
	assert.match((await pi.tool("list")).content[0]?.text ?? "", /web.*running/);
});

function killIfPresent(pid: number) {
	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

test("stop terminates subprocesses as well as their shell", async () => {
	const pi = extension();
	const code =
		"const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000)";
	await pi.command(`start tree ${script(code)}`);
	await until(async () =>
		/\d+/.test(
			(await pi.tool("logs", { name: "tree" })).content[0]?.text ?? "",
		),
	);
	const pid = Number(
		(await pi.tool("logs", { name: "tree" })).content[0]?.text.trim(),
	);
	try {
		await pi.command("stop tree");
		await until(async () => {
			try {
				process.kill(pid, 0);
				return false;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
				throw error;
			}
		});
	} finally {
		killIfPresent(pid);
	}
});

test("descendants do not outlive a command whose parent exits", async () => {
	const pi = extension();
	const code =
		"const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); child.unref(); console.log(child.pid)";
	await pi.command(`start tree ${script(code)}`);
	await until(async () =>
		/exited/.test((await pi.tool("list")).content[0]?.text ?? ""),
	);
	const output =
		(await pi.tool("logs", { name: "tree" })).content[0]?.text ?? "";
	const pid = Number(output.trim());
	assert.ok(Number.isInteger(pid) && pid > 0);
	try {
		await until(async () => {
			try {
				process.kill(pid, 0);
				return false;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
				throw error;
			}
		});
	} finally {
		killIfPresent(pid);
	}
});
