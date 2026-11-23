import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_LOG = 64 * 1024;
const MAX_WAIT_TIMEOUT = 2_147_483.647;
const KEY = Symbol.for("@philprime/pi-extensions/background-jobs");

type Status = "running" | "exited" | "stopped";
type Job = {
	name: string;
	command: string;
	cwd: string;
	status: Status;
	child: ChildProcess | null;
	output: string;
	exitCode?: number | null;
};
type Manager = { jobs: Map<string, Job> };

function manager(): Manager {
	const state = globalThis as typeof globalThis & { [KEY]?: Manager };
	if (!state[KEY]) state[KEY] = { jobs: new Map() };
	return state[KEY];
}

function registry(): Map<string, Job> {
	return manager().jobs;
}

function append(job: Job, chunk: Buffer): void {
	job.output = (job.output + chunk.toString("utf8")).slice(-MAX_LOG);
}

async function launch(job: Job): Promise<void> {
	const child = spawn(process.env.SHELL ?? "/bin/sh", ["-lc", job.command], {
		cwd: job.cwd,
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	job.child = child;
	child.stdout?.on("data", (chunk: Buffer) => append(job, chunk));
	child.stderr?.on("data", (chunk: Buffer) => append(job, chunk));
	child.on("close", (code) => {
		if (job.child === child) {
			job.child = null;
			if (job.status === "running") {
				// A shell may exit after launching children that no longer hold its pipes.
				signalTree(child, "SIGTERM");
				job.status = "exited";
				job.exitCode = code;
			}
		}
	});
	try {
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
	} catch (error) {
		job.child = null;
		job.status = "exited";
		throw error;
	}
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
	if (!child.pid) return;
	try {
		if (process.platform === "win32") child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

async function terminate(job: Job): Promise<void> {
	const child = job.child;
	if (!child) return;
	job.status = "stopped";
	const closed = new Promise<void>((resolve) =>
		child.once("close", () => resolve()),
	);
	signalTree(child, "SIGTERM");
	const timer = setTimeout(() => signalTree(child, "SIGKILL"), 2000);
	try {
		await closed;
	} finally {
		clearTimeout(timer);
	}
}

function get(name: string): Job {
	const job = registry().get(name);
	if (!job) throw new Error(`Unknown background job: ${name}`);
	return job;
}

export function backgroundJobCommand(
	name: string,
): Pick<Job, "command" | "cwd"> {
	const { command, cwd } = get(name);
	return { command, cwd };
}

function status(job: Job): string {
	return `${job.name}: ${job.status}${job.status === "exited" ? ` (${job.exitCode ?? "signal"})` : ""}`;
}

async function wait(
	job: Job,
	timeout: number,
	signal?: AbortSignal,
): Promise<string> {
	if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_WAIT_TIMEOUT)
		throw new Error(
			`Wait timeout must be greater than 0 and at most ${MAX_WAIT_TIMEOUT} seconds.`,
		);
	signal?.throwIfAborted();
	const child = job.child;
	if (!child) return status(job);
	const timedOut = await new Promise<boolean>((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			child.off("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};
		const onClose = () => {
			cleanup();
			resolve(false);
		};
		const onAbort = () => {
			cleanup();
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			cleanup();
			resolve(true);
		}, timeout * 1000);
		child.once("close", onClose);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
	return timedOut
		? `Timed out waiting for ${job.name} after ${timeout} seconds. ${status(job)}`
		: status(job);
}

async function perform(
	action: string,
	name?: string,
	command?: string,
	cwd?: string,
	timeout = 30,
	signal?: AbortSignal,
): Promise<string> {
	if (action === "list") {
		const jobs = [...registry().values()];
		return jobs.length ? jobs.map(status).join("\n") : "No background jobs.";
	}
	if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name))
		throw new Error("Provide a job name using letters, numbers, _ or -.");
	if (action === "start") {
		if (!command?.trim() || !cwd)
			throw new Error("Usage: /bg start <name> <command>");
		if (registry().has(name))
			throw new Error(`Background job already exists: ${name}`);
		const job: Job = {
			name,
			command,
			cwd,
			status: "running",
			child: null,
			output: "",
		};
		registry().set(name, job);
		try {
			await launch(job);
		} catch (error) {
			registry().delete(name);
			throw error;
		}
		return `Started ${name}`;
	}
	const job = get(name);
	if (action === "wait") return wait(job, timeout, signal);
	if (action === "logs")
		return stripVTControlCharacters(job.output) || `No output from ${name}.`;
	if (action === "stop") {
		await terminate(job);
		job.status = "stopped";
		return `Stopped ${name}`;
	}
	if (action === "restart") {
		await terminate(job);
		job.status = "running";
		job.exitCode = undefined;
		await launch(job);
		return `Restarted ${name}`;
	}
	throw new Error(`Unknown background action: ${action}`);
}

export default function runExtension(pi: ExtensionAPI): void {
	pi.on("session_shutdown", async (event) => {
		if (event.reason !== "quit") return;
		const jobs = [...registry().values()];
		await Promise.all(jobs.map(terminate));
		registry().clear();
	});

	pi.registerCommand("bg", {
		description:
			"Manage background jobs: start <name> <command>, list, logs <name>, wait <name> [timeout-seconds], restart <name>, stop <name>",
		handler: async (args, ctx) => {
			const [, action = "", name, command] =
				args.trim().match(/^(\S+)(?:\s+(\S+))?(?:\s+([\s\S]+))?$/) ?? [];
			try {
				const result = await perform(
					action,
					name,
					command,
					ctx.cwd,
					action === "wait" && command !== undefined
						? Number(command)
						: undefined,
				);
				if (ctx.hasUI) ctx.ui.notify(result, "info");
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify((error as Error).message, "error");
			}
		},
	});

	pi.registerTool({
		name: "background",
		label: "Background Jobs",
		description:
			"Start, list, inspect recent logs, wait for completion, restart or stop named background shell jobs. Wait accepts a timeout in seconds (default: 30) and does not stop the job on timeout. Jobs stop when Pi exits. Starting or restarting uses Bash permission rules.",
		promptSnippet:
			"Run long-running development commands as managed background jobs with inspectable logs.",
		promptGuidelines: [
			"Use background rather than bash for intentionally long-running commands such as development servers and watchers. Do not launch them with shell backgrounding, nohup, or detached processes. Use bash for ordinary commands that finish on their own.",
			"Give each job a descriptive name. Use background list and logs to check its state and recent output, restart to relaunch it, and stop when it is no longer needed. Use wait with a timeout in seconds to await completion without polling. A timeout or cancellation ends only the wait and leaves the job running. Starting or restarting through this tool uses the same permission rules and approval flow as bash.",
		],
		parameters: Type.Object({
			action: Type.Unsafe<
				"start" | "list" | "logs" | "wait" | "restart" | "stop"
			>({
				type: "string",
				enum: ["start", "list", "logs", "wait", "restart", "stop"],
			}),
			name: Type.Optional(
				Type.String({ description: "Job name for actions other than list." }),
			),
			command: Type.Optional(
				Type.String({ description: "Shell command for start." }),
			),
			timeout: Type.Optional(
				Type.Number({
					description:
						"Timeout in seconds for wait (default: 30). Does not stop the job.",
					exclusiveMinimum: 0,
					maximum: MAX_WAIT_TIMEOUT,
				}),
			),
		}),
		async execute(
			_id,
			{ action, name, command, timeout },
			signal,
			_onUpdate,
			ctx,
		) {
			try {
				signal?.throwIfAborted();
				return {
					content: [
						{
							type: "text",
							text: await perform(
								action,
								name,
								command,
								ctx.cwd,
								timeout,
								signal,
							),
						},
					],
					details: {},
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: (error as Error).message }],
					details: {},
					isError: true,
				};
			}
		},
	});
}
