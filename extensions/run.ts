import { spawn } from "node:child_process";
import process from "node:process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function startDetached(command: string, cwd: string): void {
	const shell = process.env.SHELL ?? "/bin/sh";
	const child = spawn(shell, ["-lc", command], {
		cwd,
		detached: true,
		stdio: "ignore",
	});

	child.unref();
}

export default function runExtension(pi: ExtensionAPI) {
	pi.registerCommand("run", {
		description: "Run a shell command in the background without showing output",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command) {
				ctx.ui.notify("Usage: /run <command>", "warning");
				return;
			}

			try {
				startDetached(command, ctx.cwd);
				ctx.ui.notify(`Started: ${command}`, "info");
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Failed to start command";
				ctx.ui.notify(message, "error");
			}
		},
	});
}
