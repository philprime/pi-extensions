import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, test } from "vitest";
import runExtension from "../extensions/run.ts";

const instances: { shutdown(reason: string): Promise<void> }[] = [];
function extension(hasUI = true, confirm = async () => true) {
	const commands = new Map<
		string,
		(args: string, ctx: ExtensionCommandContext) => Promise<void>
	>();
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<
		string,
		(event: { reason: string }, ctx: ExtensionContext) => Promise<void>
	>();
	const notifications: string[] = [];
	const ctx = {
		cwd: process.cwd(),
		hasUI,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
			confirm,
		},
	} as unknown as ExtensionCommandContext;
	runExtension({
		registerCommand(name, command) {
			commands.set(name, command.handler);
		},
		registerTool(tool) {
			tools.set(tool.name, tool as unknown as ToolDefinition);
		},
		on(name, handler) {
			handlers.set(name, handler as never);
		},
	} as ExtensionAPI);
	const instance = {
		notifications,
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
		async tool(action: string, args: Record<string, unknown> = {}) {
			const tool = tools.get("background");
			assert.ok(tool);
			const result = await tool.execute(
				"test",
				{ action, ...args },
				new AbortController().signal,
				() => {},
				ctx as never,
			);
			const content = result.content[0];
			assert.ok(content?.type === "text");
			return { ...result, content: [content] };
		},
		async shutdown(reason: string) {
			await handlers.get("session_shutdown")?.({ reason }, ctx);
		},
	};
	instances.push(instance);
	return instance;
}

afterEach(async () => {
	for (const instance of instances.splice(0)) await instance.shutdown("quit");
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
	const denied = extension(true, async () => false);
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

test("pending agent approval cannot start a job after Pi quits", async () => {
	let approve: ((value: boolean) => void) | undefined;
	const pi = extension(
		true,
		() =>
			new Promise<boolean>((resolve) => {
				approve = resolve;
			}),
	);
	const pending = pi.tool("start", { name: "late", command: idle });
	await until(async () => approve !== undefined);
	await pi.shutdown("quit");
	approve?.(true);
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
