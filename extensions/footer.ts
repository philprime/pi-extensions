import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";

const SUBSCRIPTION_PROVIDER = "openai-codex";

function formatTokens(count: number): string {
	if (count < 1_000) return count.toString();
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME ?? process.env.USERPROFILE;
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const relativeToHome = relative(resolve(home), resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." &&
			!relativeToHome.startsWith(`..${sep}`) &&
			!isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function truncate(text: string, width: number): string {
	if (text.length <= width) return text;
	if (width <= 3) return ".".repeat(Math.max(0, width));
	return `${text.slice(0, width - 3)}...`;
}

function sanitizeStatus(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function createFooter(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	tui: { requestRender(): void },
	theme: { fg(color: "dim", text: string): string },
	footerData: ReadonlyFooterDataProvider,
) {
	const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

	return {
		dispose: unsubscribe,
		invalidate() {},
		render(width: number): string[] {
			let pwd = formatCwd(ctx.sessionManager.getCwd());
			const branch = footerData.getGitBranch();
			if (branch) pwd = `${pwd} (${branch})`;
			const sessionName = ctx.sessionManager.getSessionName();
			if (sessionName) pwd = `${pwd} • ${sessionName}`;

			const usage = ctx.getContextUsage();
			const contextWindow =
				usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
			const context =
				usage?.percent === null
					? `?/${formatTokens(contextWindow)} (auto)`
					: `${(usage?.percent ?? 0).toFixed(1)}%/${formatTokens(contextWindow)} (auto)`;

			const modelName = ctx.model?.id ?? "no-model";
			const right = ctx.model?.reasoning
				? `${modelName} • ${pi.getThinkingLevel()}`
				: modelName;
			const padding = " ".repeat(
				Math.max(2, width - context.length - right.length),
			);
			const lines = [
				theme.fg("dim", truncate(pwd, width)),
				theme.fg("dim", truncate(`${context}${padding}${right}`, width)),
			];

			const statuses = [...footerData.getExtensionStatuses().entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatus(text));
			if (statuses.length > 0) {
				lines.push(truncate(statuses.join(" "), width));
			}
			return lines;
		},
	};
}

export default function footerExtension(pi: ExtensionAPI): void {
	const updateFooter = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		if (ctx.model?.provider !== SUBSCRIPTION_PROVIDER) {
			ctx.ui.setFooter(undefined);
			return;
		}

		ctx.ui.setFooter((tui, theme, footerData) =>
			createFooter(pi, ctx, tui, theme, footerData),
		);
	};

	pi.on("session_start", (_event, ctx) => updateFooter(ctx));
	pi.on("model_select", (_event, ctx) => updateFooter(ctx));
}
