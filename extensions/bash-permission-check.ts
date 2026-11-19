import { Worker } from "node:worker_threads";

export type BashPermissionRequest = {
	command: string;
	cwd: string;
	allowRules: string[];
	denyRules: string[];
	sessionRules: string[];
};

export type BashPermissionResult = {
	deniedRule?: string;
	commands: Array<{
		command: string;
		allowed: boolean;
		parsedCommand?: string;
		sessionApprovable: boolean;
		defaultRule: string;
	}>;
};

const CHECK_TIMEOUT_MS = 1_000;
let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<
	number,
	{
		resolve: (result: BashPermissionResult) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}
>();

function stopWorker(activeWorker: Worker, error: Error): void {
	if (worker !== activeWorker) return;
	worker = undefined;
	// Termination can interrupt synchronous regex execution, unlike a Promise race.
	void activeWorker.terminate();
	for (const request of pending.values()) {
		clearTimeout(request.timer);
		request.reject(error);
	}
	pending.clear();
}

function getWorker(): Worker {
	if (worker) return worker;
	const activeWorker = new Worker(
		`
			const { parentPort } = require("node:worker_threads");
			import(${JSON.stringify(new URL("./permissions.ts", import.meta.url).href)}).then(({ evaluateBashPermissions }) => {
				parentPort.on("message", ({ id, request }) => {
					try {
						parentPort.postMessage({ id, result: evaluateBashPermissions(request) });
					} catch (error) {
						parentPort.postMessage({ id, error: error instanceof Error ? error.message : "Bash permission check failed" });
					}
				});
			});
		`,
		{ eval: true, execArgv: ["--experimental-strip-types"] },
	);
	worker = activeWorker;
	activeWorker.on("message", ({ id, result, error }) => {
		const request = pending.get(id);
		if (!request) return;
		pending.delete(id);
		clearTimeout(request.timer);
		if (error) request.reject(new Error(error));
		else request.resolve(result);
		if (pending.size === 0) activeWorker.unref();
	});
	activeWorker.on("error", (error) =>
		stopWorker(
			activeWorker,
			error instanceof Error
				? error
				: new Error("Bash permission check worker failed"),
		),
	);
	activeWorker.on("exit", () =>
		stopWorker(activeWorker, new Error("Bash permission check worker exited")),
	);
	activeWorker.unref();
	return activeWorker;
}

export function checkBashPermissions(
	request: BashPermissionRequest,
): Promise<BashPermissionResult> {
	return new Promise((resolve, reject) => {
		const activeWorker = getWorker();
		const id = nextId++;
		const timer = setTimeout(() => {
			stopWorker(
				activeWorker,
				new Error(
					`Bash permission check timed out after ${CHECK_TIMEOUT_MS} ms`,
				),
			);
		}, CHECK_TIMEOUT_MS);
		pending.set(id, { resolve, reject, timer });
		activeWorker.ref();
		activeWorker.postMessage({ id, request });
	});
}
