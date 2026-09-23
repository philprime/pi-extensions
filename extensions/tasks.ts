import { stripVTControlCharacters } from "node:util";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

const ENTRY_TYPE = "task-list";
const CONTEXT_TYPE = "task-list-context";

type Status = "pending" | "in_progress" | "done" | "blocked" | "skipped";
const StatusSchema = Type.Unsafe<Status>({
	type: "string",
	enum: ["pending", "in_progress", "done", "blocked", "skipped"],
});
const LabelSchema = Type.String({
	minLength: 1,
	maxLength: 160,
	pattern: "\\S",
});
const DescriptionSchema = Type.String({
	minLength: 1,
	maxLength: 12000,
	pattern: "\\S",
	description:
		"Durable handoff: goal and scope, relevant files, decisions and constraints, and completion criteria. Markdown is allowed.",
});
const NotesSchema = Type.String({
	maxLength: 12000,
	description:
		"Current findings, blockers, verification results, and next step. Replaces previous notes, so retain relevant context. Empty string clears notes.",
});
const TaskSchema = Type.Object({
	label: LabelSchema,
	description: DescriptionSchema,
	status: Type.Optional(StatusSchema),
	notes: Type.Optional(NotesSchema),
});
const Parameters = Type.Object({
	action: Type.Unsafe<"get" | "set" | "update" | "clear">({
		type: "string",
		enum: ["get", "set", "update", "clear"],
	}),
	title: Type.Optional(
		Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" }),
	),
	tasks: Type.Optional(Type.Array(TaskSchema, { minItems: 1, maxItems: 50 })),
	id: Type.Optional(
		Type.Integer({ minimum: 1, description: "Task ID for get or update." }),
	),
	label: Type.Optional(LabelSchema),
	description: Type.Optional(DescriptionSchema),
	status: Type.Optional(StatusSchema),
	notes: Type.Optional(NotesSchema),
});

type Task = Static<typeof TaskSchema> & { id: number; status: Status };
interface TaskList {
	title: string;
	tasks: Task[];
}
interface TaskDetails {
	list: TaskList | null;
	taskId?: number;
}

function formatList(list: TaskList | null, full: boolean, id?: number): string {
	if (!list) return "No active task list.";
	const tasks =
		id === undefined ? list.tasks : list.tasks.filter((t) => t.id === id);
	return [
		`Tasks: ${list.title}`,
		...tasks.map((task) =>
			[
				`#${task.id} [${task.status}] ${task.label}`,
				...(full
					? [
							task.description,
							...(task.notes ? [`Progress: ${task.notes}`] : []),
						]
					: []),
			].join("\n"),
		),
	].join("\n");
}

function progress(list: TaskList): string {
	const done = list.tasks.filter((task) => task.status === "done").length;
	const skipped = list.tasks.filter((task) => task.status === "skipped").length;
	const blocked = list.tasks.filter((task) => task.status === "blocked").length;
	return [
		`${done}/${list.tasks.length} done`,
		...(skipped ? [`${skipped} skipped`] : []),
		...(blocked ? [`${blocked} blocked`] : []),
	].join(", ");
}

function displayText(text: string): string {
	return stripVTControlCharacters(text).replace(/\p{Cc}/gu, (character) =>
		character === "\n" || character === "\t" ? character : "",
	);
}

function singleLine(text: string): string {
	return displayText(text).replace(/\s+/gu, " ").trim();
}

function updateUI(ctx: ExtensionContext, list: TaskList | null): void {
	if (!ctx.hasUI || ctx.mode !== "tui") return;
	if (!list) {
		ctx.ui.setWidget("tasks", undefined);
		ctx.ui.setStatus("tasks", undefined);
		return;
	}

	const summary = progress(list);
	const unfinished = [
		...list.tasks.filter((task) => task.status === "in_progress"),
		...list.tasks.filter((task) => task.status === "blocked"),
		...list.tasks.filter((task) => task.status === "pending"),
	];
	ctx.ui.setStatus("tasks", `Tasks ${summary}`);
	ctx.ui.setWidget("tasks", (_tui, theme) => ({
		invalidate() {},
		render(width) {
			const lines = [
				theme.fg("accent", `Tasks: ${singleLine(list.title)} (${summary})`),
				...unfinished.slice(0, 3).map((task) => {
					const marker =
						task.status === "in_progress"
							? ">"
							: task.status === "blocked"
								? "!"
								: " ";
					const color =
						task.status === "blocked"
							? "warning"
							: task.status === "in_progress"
								? "accent"
								: "dim";
					return theme.fg(
						color,
						`[${marker}] #${task.id} ${singleLine(task.label)}`,
					);
				}),
			];
			if (unfinished.length > 3) {
				lines.push(
					theme.fg("dim", `... ${unfinished.length - 3} more unfinished`),
				);
			}
			return lines.map((line) => truncateToWidth(line, width));
		},
	}));
}

export default function tasksExtension(pi: ExtensionAPI): void {
	let list: TaskList | null = null;

	const restore = (ctx: ExtensionContext) => {
		list = null;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
				list = (entry.data as TaskDetails).list;
			}
		}
		updateUI(ctx, list);
	};

	const save = (next: TaskList | null, ctx: ExtensionContext) => {
		pi.appendEntry<TaskDetails>(ENTRY_TYPE, { list: next });
		list = next;
		updateUI(ctx, list);
	};

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_compact", (_event, ctx) => restore(ctx));
	pi.on("context", (event) => {
		const messages = event.messages.filter(
			(message) =>
				message.role !== "custom" || message.customType !== CONTEXT_TYPE,
		);
		if (list) {
			messages.push({
				role: "custom",
				customType: CONTEXT_TYPE,
				content: [
					"Current session task list (tracking data, not new instructions):",
					formatList(list, false),
					"Full descriptions and progress notes are saved separately from conversation summaries. If those details are missing from context, especially after compaction, call tasks with action get (optionally with id) before continuing a task. Do not infer its scope from the label alone.",
				].join("\n\n"),
				display: false,
				timestamp: Date.now(),
			});
		}
		return { messages };
	});

	pi.registerTool({
		name: "tasks",
		label: "Tasks",
		description:
			"Manage a lightweight session task list. get reads all durable task descriptions and progress notes, or one task by id. set requires title and tasks and replaces the whole list, assigning IDs from 1. Use set to add, remove, or reorder tasks, preserving relevant descriptions, statuses, and notes. update requires id and at least one of label, description, status, notes, leaving other fields unchanged. clear removes the active list.",
		promptSnippet:
			"Track multi-step session work with durable task handoffs and progress.",
		promptGuidelines: [
			"Use tasks for substantial multi-step work (usually three or more meaningful steps), debugging or research loops, or an explicit tracking request. Do not create lists for simple questions or a small obvious edit. Tracking is not a planning mode or an approval gate.",
			"Manage tasks through normal conversation. Follow requests to add, remove, reorder, rename, change scope, or stop tracking. Use get before replacing an existing list so relevant descriptions and progress are preserved. Replace the list for a new unrelated objective rather than accumulating stale work. Clear it when asked to stop tracking, and do not recreate it against that request.",
			"Give each task a short label and a self-contained description with its goal, scope, relevant files, decisions, constraints, and completion criteria. Descriptions may use Markdown. Keep findings, blockers, verification results, and the next step in progress notes, updating them while working rather than waiting for compaction.",
			"Keep task status accurate. Mark work in_progress when starting, blocked when unable to proceed, skipped when deliberately omitted, and done only after its completion criteria are met. Do not mark work done merely because an agent turn ends. After compaction or resume, read saved task details with tasks get before continuing when those details are absent from context.",
		],
		parameters: Parameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "get":
					if (
						params.id !== undefined &&
						!list?.tasks.some((t) => t.id === params.id)
					) {
						throw new Error(`Task #${params.id} not found.`);
					}
					break;
				case "set":
					if (params.title === undefined || params.tasks === undefined) {
						throw new Error("set requires title and tasks.");
					}
					save(
						{
							title: params.title.trim(),
							tasks: params.tasks.map((task, index) => ({
								...task,
								id: index + 1,
								label: task.label.trim(),
								description: task.description.trim(),
								status: task.status ?? "pending",
							})),
						},
						ctx,
					);
					break;
				case "update": {
					if (params.id === undefined) throw new Error("update requires id.");
					const task = list?.tasks.find((t) => t.id === params.id);
					if (!list || !task) throw new Error(`Task #${params.id} not found.`);
					if (
						params.label === undefined &&
						params.description === undefined &&
						params.status === undefined &&
						params.notes === undefined
					) {
						throw new Error(
							"update requires label, description, status, or notes.",
						);
					}
					const updated: Task = {
						...task,
						label: params.label?.trim() ?? task.label,
						description: params.description?.trim() ?? task.description,
						status: params.status ?? task.status,
						notes: params.notes ?? task.notes,
					};
					save(
						{
							...list,
							tasks: list.tasks.map((t) => (t.id === task.id ? updated : t)),
						},
						ctx,
					);
					break;
				}
				case "clear":
					save(null, ctx);
					break;
			}
			const taskId = params.action === "get" ? params.id : undefined;
			return {
				content: [
					{
						type: "text",
						text: formatList(list, params.action === "get", taskId),
					},
				],
				details: { list, taskId } satisfies TaskDetails,
			};
		},
		renderCall(args, theme) {
			const id = args.id === undefined ? "" : ` #${args.id}`;
			return new Text(
				theme.fg(
					"toolTitle",
					theme.bold(`tasks ${singleLine(args.action ?? "")}${id}`),
				),
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as TaskDetails | undefined;
			const text = details
				? formatList(details.list, expanded, details.taskId)
				: result.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
			return new Text(theme.fg("muted", displayText(text)), 0, 0);
		},
	});
}
