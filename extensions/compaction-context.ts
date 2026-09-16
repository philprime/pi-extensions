import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function compactionContextExtension(pi: ExtensionAPI) {
	pi.on("session_compact", async (_event, ctx) => {
		const files: string[] = [];
		for (const filename of ["README.md", "AGENTS.md"]) {
			const path = join(ctx.cwd, filename);
			try {
				const content = await readFile(path, "utf8");
				files.push(`## ${path}\n\n${content}`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					throw error;
				}
			}
		}

		if (files.length === 0) return;

		// Keep the full snapshots in conversation context without filling the TUI.
		pi.sendMessage({
			customType: "compaction-context",
			content: `Project files re-read in full after compaction:\n\n${files.join("\n\n")}`,
			display: false,
		});
	});
}
