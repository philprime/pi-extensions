import assert from "node:assert/strict";
import { test } from "vitest";
import footerExtension from "../extensions/footer.ts";

type EventHandler = (event: unknown, ctx: unknown) => void;
type FooterFactory = (
	tui: { requestRender(): void },
	theme: {
		fg(color: string, text: string): string;
		bold(text: string): string;
	},
	footerData: {
		getGitBranch(): string | null;
		getExtensionStatuses(): ReadonlyMap<string, string>;
		getAvailableProviderCount(): number;
		onBranchChange(callback: () => void): () => void;
	},
) => { render(width: number): string[] };

function createExtension() {
	const handlers = new Map<string, EventHandler>();
	footerExtension({
		on(eventName: string, handler: EventHandler) {
			handlers.set(eventName, handler);
		},
		getThinkingLevel() {
			return "medium";
		},
	} as never);
	return handlers;
}

function createContext(provider: string) {
	let footerFactory: FooterFactory | undefined;
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/Volumes/Developer/philprime/PirateTrader",
		model: {
			provider,
			id: "gpt-6-astra",
			reasoning: true,
			contextWindow: 272_000,
		},
		getContextUsage() {
			return { tokens: 187_408, contextWindow: 272_000, percent: 68.9 };
		},
		sessionManager: {
			getCwd() {
				return "/Volumes/Developer/philprime/PirateTrader";
			},
			getSessionName() {
				return undefined;
			},
		},
		ui: {
			setFooter(factory: FooterFactory | undefined) {
				footerFactory = factory;
			},
		},
	};
	return { ctx, getFooterFactory: () => footerFactory };
}

function renderFooter(factory: FooterFactory): string[] {
	return factory(
		{ requestRender() {} },
		{
			fg(_color, text) {
				return text;
			},
			bold(text) {
				return text;
			},
		},
		{
			getGitBranch() {
				return "main";
			},
			getExtensionStatuses() {
				return new Map();
			},
			getAvailableProviderCount() {
				return 1;
			},
			onBranchChange() {
				return () => {};
			},
		},
	).render(160);
}

test("shows only context usage and model details for OpenAI Codex", () => {
	const handlers = createExtension();
	const { ctx, getFooterFactory } = createContext("openai-codex");

	handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		ctx,
	);

	const factory = getFooterFactory();
	assert.ok(factory, "OpenAI Codex should install the compact footer");
	const lines = renderFooter(factory);
	assert.equal(lines[0], "/Volumes/Developer/philprime/PirateTrader (main)");
	assert.match(lines[1] ?? "", /^68\.9%\/272k \(auto\) +gpt-6-astra • medium$/);
	assert.doesNotMatch(lines[1] ?? "", /[↑↓$]|\b(?:R|W|CH)\d/);
});

test("restores the built-in footer for providers other than OpenAI Codex", () => {
	const handlers = createExtension();
	const { ctx, getFooterFactory } = createContext("openai-codex");
	handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		ctx,
	);
	assert.ok(getFooterFactory());

	const anthropicContext = createContext("anthropic");
	handlers.get("model_select")?.(
		{
			type: "model_select",
			model: anthropicContext.ctx.model,
			previousModel: ctx.model,
			source: "set",
		},
		anthropicContext.ctx,
	);

	assert.equal(anthropicContext.getFooterFactory(), undefined);
});
