import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { promisify } from "node:util";
import type {
	ExecResult,
	ExtensionAPI,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { afterEach, test, vi } from "vitest";
import webExtension, { registerWebTools } from "../extensions/web.ts";

const success: ExecResult = { stdout: "", stderr: "", code: 0, killed: false };
const model = {
	id: "gpt-6.1-sol",
	name: "GPT-6.1 Sol",
	type: "chat",
	provider: "openai",
	api: "openai-responses",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 1048576,
	maxTokens: 128000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as const;

function setup(
	options: {
		exec?: ExtensionAPI["exec"];
		oauth?: boolean;
		source?: string;
		token?: string;
		modelId?: string;
	} = {},
) {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		exec:
			options.exec ??
			(async () => {
				throw new Error("Unexpected process execution");
			}),
		registerFlag() {},
		getFlag() {
			return options.modelId;
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: false,
		model: {
			...model,
			provider: "openai-codex",
			api: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api",
		},
		modelRegistry: {
			find(provider: string, id: string) {
				return provider === "openai" && id === model.id ? model : undefined;
			},
			isUsingOAuth() {
				return options.oauth ?? true;
			},
			async getProviderAuth(provider: string) {
				assert.equal(provider, "openai");
				return {
					source: options.source ?? "OAuth",
					auth: {
						apiKey: options.token ?? "test-subscription-token",
						baseUrl: "https://untrusted.example/",
					},
				};
			},
		},
	} as unknown as ExtensionToolContext;
	webExtension(pi);
	return {
		pi,
		ctx,
		async call(name: string, input: unknown, signal?: AbortSignal) {
			const tool = tools.get(name);
			assert.ok(tool, `must register ${name}`);
			Value.Assert(tool.parameters, input);
			return tool.execute("web-1", input, signal, undefined, ctx);
		},
	};
}

function stream(events: unknown[], separator = "\n\n") {
	const bytes = new TextEncoder().encode(
		events
			.map((event) => `data: ${JSON.stringify(event)}${separator}`)
			.join(""),
	);
	// Split inside JSON and UTF-8 characters to exercise actual stream framing.
	return new Response(
		new ReadableStream({
			start(controller) {
				for (let i = 0; i < bytes.length; i += 7)
					controller.enqueue(bytes.slice(i, i + 7));
				controller.close();
			},
		}),
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}

function completed(text = "Search résumé", searched = true) {
	return {
		type: "response.completed",
		response: {
			status: "completed",
			output: [
				...(searched
					? [
							{
								type: "web_search_call",
								id: "ws_1",
								status: "completed",
								action: {
									type: "search",
									queries: ["news"],
									sources: [
										{
											type: "url",
											title: "Example",
											url: "https://example.com/article",
										},
									],
								},
							},
						]
					: []),
				{
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [
						{
							type: "output_text",
							text,
							annotations: [
								{
									type: "url_citation",
									title: "Example",
									url: "https://example.com/article",
									start_index: 0,
									end_index: 6,
								},
							],
						},
					],
				},
			],
		},
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

test("web_search uses only subscription OAuth at the public endpoint and preserves sources", async () => {
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		assert.equal(url, "https://api.openai.com/v1/responses");
		assert.equal(init.method, "POST");
		assert.equal(init.redirect, "error");
		const headers = new Headers(init.headers);
		assert.equal(
			headers.get("Authorization"),
			"Bearer test-subscription-token",
		);
		const body = JSON.parse(String(init.body));
		assert.equal(body.model, "gpt-6.1-sol");
		assert.equal(body.store, false);
		assert.equal(body.stream, true);
		assert.deepEqual(body.tools, [{ type: "web_search" }]);
		assert.equal(body.tool_choice, "required");
		assert.deepEqual(body.input, [
			{ role: "user", content: [{ type: "input_text", text: "news" }] },
		]);
		assert.ok(init.signal);
		return stream(
			[
				{ type: "response.output_text.delta", delta: "Search résumé" },
				completed(),
			],
			"\r\n\r\n",
		);
	});
	const result = await setup().call("web_search", { query: "news" });
	const text = result.content[0];
	assert.equal(text.type, "text");
	if (text.type !== "text") return;
	assert.match(text.text, /Search résumé/);
	assert.ok(text.text.includes("https://example.com/article"));
	assert.equal(text.text.match(/https:\/\/example.com\/article/g)?.length, 1);
});

test.each([{ oauth: false }, { source: "OPENAI_API_KEY" }, { token: "" }])(
	"web_search refuses missing or non-subscription authentication: %j",
	async (options) => {
		let requested = false;
		vi.stubGlobal("fetch", async () => {
			requested = true;
			throw new Error("Must not send request");
		});
		await assert.rejects(
			setup(options).call("web_search", { query: "news" }),
			/ChatGPT|OAuth|subscription/i,
		);
		assert.equal(requested, false);
	},
);

test("web_search reports subscription token usage without API costs", async () => {
	const event = {
		...completed(),
		response: {
			...completed().response,
			usage: {
				input_tokens: 100,
				output_tokens: 40,
				total_tokens: 140,
				input_tokens_details: { cached_tokens: 20 },
				output_tokens_details: { reasoning_tokens: 10 },
			},
		},
	};
	vi.stubGlobal("fetch", async () => stream([event]));
	const result = await setup().call("web_search", { query: "news" });
	assert.deepEqual(result.usage, {
		input: 80,
		output: 40,
		cacheRead: 20,
		cacheWrite: 0,
		totalTokens: 140,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
});

test("web_search accepts an explicitly configured search model independently of the conversation model", async () => {
	const extension = setup({ modelId: model.id });
	extension.ctx.model = undefined;
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		assert.equal(JSON.parse(String(init.body)).model, model.id);
		return stream([completed()]);
	});
	assert.ok(
		(await extension.call("web_search", { query: "news" })).content.length,
	);
});

test("web_search fails clearly when no matching OpenAI search model exists", async () => {
	await assert.rejects(
		setup({ modelId: "unknown-model" }).call("web_search", { query: "news" }),
		/web-search-model/i,
	);
});

test.each([
	{
		name: "error event",
		events: [{ type: "error", message: "server failed" }],
		error: /failed or returned an incomplete/,
	},
	{
		name: "failed response",
		events: [
			{
				type: "response.failed",
				response: { status: "failed", error: { message: "server failed" } },
			},
		],
		error: /failed or returned an incomplete/,
	},
	{
		name: "incomplete response",
		events: [
			{
				type: "response.incomplete",
				response: { status: "incomplete", output: [] },
			},
		],
		error: /failed or returned an incomplete/,
	},
	{
		name: "disconnected stream",
		events: [{ type: "response.output_text.delta", delta: "partial answer" }],
		error: /ended without a completed response/,
	},
	{
		name: "empty answer",
		events: [completed("", true)],
		error: /returned an empty answer/,
	},
	{
		name: "unsearched answer",
		events: [completed("Unsearched answer", false)],
		error: /did not perform a web search/,
	},
	{
		name: "malformed event",
		events: [{ type: 42 }],
		error: /Invalid web search stream event/,
	},
	{
		name: "malformed completed response",
		events: [
			{
				type: "response.completed",
				response: { status: "completed", output: "invalid" },
			},
		],
		error: /did not return a completed response/,
	},
])("web_search rejects $name", async ({ events, error }) => {
	vi.stubGlobal("fetch", async () => stream(events));
	await assert.rejects(setup().call("web_search", { query: "news" }), error);
});

test("web_search does not expose server response bodies on HTTP errors or fall back to another backend", async () => {
	let requests = 0;
	vi.stubGlobal("fetch", async () => {
		requests++;
		return new Response("sensitive diagnostic", { status: 401 });
	});
	await assert.rejects(
		setup().call("web_search", { query: "news" }),
		(error: Error) => {
			assert.match(error.message, /401/);
			assert.doesNotMatch(error.message, /sensitive diagnostic/);
			return true;
		},
	);
	assert.equal(requests, 1);
});

test("web_search propagates in-flight cancellation to its HTTP request", async () => {
	const controller = new AbortController();
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		controller.abort();
		assert.equal(init.signal?.aborted, true);
		throw init.signal?.reason;
	});
	await assert.rejects(
		setup().call("web_search", { query: "news" }, controller.signal),
		/abort/i,
	);
});

test("web_fetch follows redirects and returns an unmodified body using real curl", async () => {
	const server = createServer((request, response) => {
		if (request.url === "/redirect") {
			response.writeHead(302, { Location: "/body" });
			response.end();
		} else {
			response.end("<html>résumé &amp; raw</html>\n");
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const extension = setup({
			exec: async (command, args, options) => {
				const result = await promisify(execFile)(command, args, {
					signal: options?.signal,
				});
				return { ...success, ...result };
			},
		});
		assert.deepEqual(
			(
				await extension.call("web_fetch", {
					url: `http://127.0.0.1:${address.port}/redirect`,
				})
			).content,
			[{ type: "text", text: "<html>résumé &amp; raw</html>\n" }],
		);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});

test("web_fetch returns raw text and prevents curl config, option, protocol, and glob injection", async () => {
	const url = "https://example.com/search?q=[one]&value=$(echo%20two)";
	const signal = new AbortController().signal;
	const extension = setup({
		exec: async (command, args, options) => {
			assert.equal(command, "curl");
			assert.equal(args[0], "--disable");
			for (const flag of [
				"--location",
				"--fail",
				"--silent",
				"--show-error",
				"--globoff",
			])
				assert.ok(args.includes(flag));
			assert.equal(args[args.indexOf("--proto") + 1], "=http,https");
			assert.equal(args[args.indexOf("--proto-redir") + 1], "=http,https");
			assert.ok(args.includes("--max-time"));
			assert.deepEqual(args.slice(-2), ["--", url]);
			assert.equal(options?.signal, signal);
			return { ...success, stdout: "<html>Raw response</html>" };
		},
	});
	assert.deepEqual(
		(await extension.call("web_fetch", { url }, signal)).content,
		[{ type: "text", text: "<html>Raw response</html>" }],
	);
});

test("backends can be replaced without changing tool inputs or results", async () => {
	const extension = setup();
	registerWebTools(extension.pi, {
		async search(query) {
			return { text: `Alternate search: ${query}` };
		},
		async fetch(url) {
			return `Alternate fetch: ${url}`;
		},
	});
	assert.deepEqual(
		(await extension.call("web_search", { query: "news" })).content,
		[{ type: "text", text: "Alternate search: news" }],
	);
	assert.deepEqual(
		(await extension.call("web_fetch", { url: "https://example.com/" }))
			.content,
		[{ type: "text", text: "Alternate fetch: https://example.com/" }],
	);
});

test.each([
	"file:///etc/passwd",
	"ftp://example.com/file",
	"--output=local",
	"not a URL",
])("web_fetch rejects unsafe or invalid URLs: %s", async (url) => {
	await assert.rejects(setup().call("web_fetch", { url }), /HTTP\(S\)/i);
});

test("web_search rejects blank queries before invoking a backend", async () => {
	await assert.rejects(setup().call("web_search", { query: "   " }), /query/i);
});

test("web_fetch reports process errors instead of returning partial output", async () => {
	const extension = setup({
		exec: async () => ({
			stdout: "partial",
			stderr: "backend unavailable",
			code: 1,
			killed: false,
		}),
	});
	await assert.rejects(
		extension.call("web_fetch", { url: "https://example.com/" }),
		/backend unavailable/,
	);
});

test("web_fetch reports killed processes as failures even with exit code zero", async () => {
	const extension = setup({
		exec: async () => ({ ...success, stdout: "partial", killed: true }),
	});
	await assert.rejects(
		extension.call("web_fetch", { url: "https://example.com/" }),
		/cancel|timed out/i,
	);
});

test("large responses are truncated with complete output saved privately", async () => {
	const body = "A response line\n".repeat(5000);
	const extension = setup({ exec: async () => ({ ...success, stdout: body }) });
	const result = await extension.call("web_fetch", {
		url: "https://example.com/",
	});
	const details = result.details as { fullOutputPath?: string };
	assert.ok(details.fullOutputPath);
	try {
		assert.equal(await readFile(details.fullOutputPath, "utf8"), body);
		assert.equal((await stat(details.fullOutputPath)).mode & 0o777, 0o600);
		const text = result.content[0];
		assert.equal(text.type, "text");
		if (text.type !== "text") return;
		assert.ok(text.text.length < body.length);
		assert.match(text.text, /truncated/i);
		assert.ok(text.text.includes(details.fullOutputPath));
	} finally {
		await rm(details.fullOutputPath);
	}
});

test.each(["web_search", "web_fetch"])(
	"%s does not start work when already cancelled",
	async (name) => {
		const controller = new AbortController();
		controller.abort();
		let invoked = false;
		vi.stubGlobal("fetch", async () => {
			invoked = true;
			return stream([completed()]);
		});
		const extension = setup({
			exec: async () => {
				invoked = true;
				return success;
			},
		});
		await assert.rejects(
			extension.call(
				name,
				name === "web_search"
					? { query: "news" }
					: { url: "https://example.com/" },
				controller.signal,
			),
			/abort/i,
		);
		assert.equal(invoked, false);
	},
);
