import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "vitest";
import permissionsExtension from "../extensions/permissions.ts";

type ToolCallHandler = (
	event: { toolName: string; input: unknown },
	ctx: unknown,
) => Promise<unknown>;

const temporaryDirectories: string[] = [];

function createProject(allow: string[]): string {
	const projectDirectory = fs.mkdtempSync(
		path.join(os.tmpdir(), "permissions-test-"),
	);
	temporaryDirectories.push(projectDirectory);
	const settingsDirectory = path.join(projectDirectory, ".claude");
	fs.mkdirSync(settingsDirectory);
	fs.writeFileSync(
		path.join(settingsDirectory, "settings.local.json"),
		JSON.stringify({
			permissions: { allow: allow.map((rule) => `Bash(${rule})`) },
		}),
	);
	return projectDirectory;
}

function createHandler(): ToolCallHandler {
	let handler: ToolCallHandler | undefined;
	permissionsExtension({
		on(eventName: string, callback: ToolCallHandler) {
			if (eventName === "tool_call") handler = callback;
		},
	} as never);
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
): Promise<{
	result: unknown;
	selectCalls: Array<{ message: string; options: string[] }>;
}> {
	const selectCalls: Array<{ message: string; options: string[] }> = [];
	const handler = createHandler();
	const result = await handler(
		{ toolName: "bash", input: { command } },
		{
			cwd,
			hasUI: true,
			ui: {
				select: async (message: string, options: string[]) => {
					selectCalls.push({ message, options });
					return selectChoices.shift();
				},
			},
		},
	);
	return { result, selectCalls };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
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

test("requires approval for a redirected command matching an allow rule", async () => {
	const projectDirectory = createProject(["grep *"]);
	const { result, selectCalls } = await invoke(
		"grep value file 2>errors.log",
		projectDirectory,
	);

	assert.deepEqual(result, { block: true, reason: "Blocked by user" });
	assert.equal(selectCalls.length, 1);
});

test("prompts without an amend option when a pipeline stage requires approval because of a redirection", async () => {
	const projectDirectory = createProject([]);
	const { result, selectCalls } = await invoke(
		"cat package.json | jq '.name' > output.txt",
		projectDirectory,
		["No"],
	);

	assert.deepEqual(result, { block: true, reason: "Blocked by user" });
	assert.equal(selectCalls.length, 1);
	assert.match(selectCalls[0].message, /jq '.name' > output.txt/);
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

test("auto-allows built-in read-only git without any project allow rule", async () => {
	const projectDirectory = createProject([]);
	const { result, selectCalls } = await invoke(
		"git status --short",
		projectDirectory,
	);

	assert.equal(result, undefined);
	assert.deepEqual(selectCalls, []);
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
