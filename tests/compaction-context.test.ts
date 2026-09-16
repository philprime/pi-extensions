import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, test } from "vitest";
import compactionContextExtension from "../extensions/compaction-context.ts";

type Handler = (
	event: SessionCompactEvent,
	ctx: ExtensionContext,
) => Promise<void>;

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function createExtension() {
	const cwd = await mkdtemp(join(tmpdir(), "pi-compaction-context-"));
	directories.push(cwd);
	const handlers = new Map<string, Handler>();
	const messages: Parameters<ExtensionAPI["sendMessage"]>[0][] = [];
	const options: Parameters<ExtensionAPI["sendMessage"]>[1][] = [];
	compactionContextExtension({
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		sendMessage(message, deliveryOptions) {
			messages.push(message);
			options.push(deliveryOptions);
		},
	} as ExtensionAPI);

	return {
		cwd,
		messages,
		options,
		async compact(reason: SessionCompactEvent["reason"] = "manual") {
			const handler = handlers.get("session_compact");
			assert.ok(handler, "must handle successful compaction");
			await handler(
				{
					type: "session_compact",
					reason,
					willRetry: reason === "overflow",
					fromExtension: false,
					compactionEntry: {
						type: "compaction",
						id: "compact-1",
						parentId: null,
						timestamp: new Date().toISOString(),
						summary: "Earlier work",
						firstKeptEntryId: "message-1",
						tokensBefore: 100_000,
					},
				},
				{ cwd, hasUI: false } as ExtensionContext,
			);
		},
	};
}

for (const reason of ["manual", "threshold", "overflow"] as const) {
	test(`injects both complete files after ${reason} compaction without starting a turn`, async () => {
		const extension = await createExtension();
		const readme = `${"README content\n".repeat(5_000)}README end`;
		const agents = `${"Project instructions\n".repeat(5_000)}AGENTS end`;
		await writeFile(join(extension.cwd, "README.md"), readme);
		await writeFile(join(extension.cwd, "AGENTS.md"), agents);
		assert.equal(extension.messages.length, 0);

		await extension.compact(reason);

		assert.equal(extension.messages.length, 1);
		const message = extension.messages[0];
		assert.equal(typeof message.content, "string");
		const content = message.content as string;
		assert.ok(content.includes(readme), "README must not be truncated");
		assert.ok(content.includes(agents), "AGENTS must not be truncated");
		assert.ok(content.includes(join(extension.cwd, "README.md")));
		assert.ok(content.includes(join(extension.cwd, "AGENTS.md")));
		assert.notEqual(extension.options[0]?.triggerTurn, true);
		assert.ok(
			extension.options[0]?.deliverAs === undefined ||
				extension.options[0]?.deliverAs === "steer",
			"must be available to the next model call, including overflow retries",
		);
	});
}

for (const filename of ["README.md", "AGENTS.md"]) {
	test(`reads ${filename} when the other file is absent`, async () => {
		const extension = await createExtension();
		await writeFile(join(extension.cwd, filename), "Available project context");

		await extension.compact();

		assert.equal(extension.messages.length, 1);
		assert.ok(
			(extension.messages[0].content as string).includes(
				"Available project context",
			),
		);
	});
}

test("does not inject a message when both files are absent", async () => {
	const extension = await createExtension();
	await extension.compact();
	assert.deepEqual(extension.messages, []);
});

test("re-reads changed files on each compaction", async () => {
	const extension = await createExtension();
	const path = join(extension.cwd, "AGENTS.md");
	await writeFile(path, "Original instructions");
	await extension.compact();
	await writeFile(path, "Updated instructions");
	await extension.compact();

	assert.equal(extension.messages.length, 2);
	assert.ok(
		(extension.messages[1].content as string).includes("Updated instructions"),
	);
	assert.ok(
		!(extension.messages[1].content as string).includes(
			"Original instructions",
		),
	);
});

test("does not reuse previous contents when files are removed", async () => {
	const extension = await createExtension();
	const path = join(extension.cwd, "README.md");
	await writeFile(path, "Previous README");
	await extension.compact();
	await rm(path);
	await extension.compact();
	assert.equal(extension.messages.length, 1);
});

test("surfaces read errors other than missing files", async () => {
	const extension = await createExtension();
	await mkdir(join(extension.cwd, "README.md"));
	await assert.rejects(extension.compact(), { code: "EISDIR" });
	assert.deepEqual(extension.messages, []);
});
