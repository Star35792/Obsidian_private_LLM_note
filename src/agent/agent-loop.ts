import { budgetToolResultText, DEFAULT_TOOL_RESULT_BUDGET, type ToolResultBudget } from './tool-result-budget';

export type AgentMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AgentMessage {
	role: AgentMessageRole;
	content: string;
	persist?: boolean;
	toolCallId?: string;
	toolCalls?: AgentToolCall[];
}

export interface AgentToolCall {
	id: string;
	name: string;
	arguments: unknown;
}

export interface AgentTurn {
	content: string;
	toolCalls: AgentToolCall[];
}

export interface AgentToolDescription {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface AgentModelPort {
	completeAgent(messages: AgentMessage[], tools: AgentToolDescription[]): Promise<AgentTurn>;
}

export interface ReadOnlyAgentTool extends AgentToolDescription {
	kind: 'read-only';
	execute(arguments_: unknown): Promise<unknown>;
}

export interface MutationPlan {
	summary: string;
	changes: PlannedChange[];
	apply?: () => Promise<void>;
}

export interface PlannedChange {
	id: string;
	summary: string;
	preview?: import('../changes/change-plan').ChangePreview;
}

export interface MutationAgentTool extends AgentToolDescription {
	kind: 'mutation';
	plan(arguments_: unknown): Promise<MutationPlan>;
}

export type AgentTool = ReadOnlyAgentTool | MutationAgentTool;

export interface PendingChangePlan extends MutationPlan {
	id: string;
}

export interface AgentLoopOptions {
	maxTurns?: number;
	historyLimit?: number;
	historySummary?: string;
	systemPrompt?: string;
	toolResultBudget?: ToolResultBudget;
	onToolCall?: (call: AgentToolCall) => void;
}

export interface AgentHistoryCompactionOptions {
	maxMessages: number;
	summary?: string;
}

export function compactAgentHistory(
	messages: AgentMessage[],
	options: AgentHistoryCompactionOptions,
): AgentMessage[] {
	if (!Number.isInteger(options.maxMessages) || options.maxMessages < 2) {
		throw new Error('历史消息上限必须至少为 2');
	}
	if (messages.length <= options.maxMessages) return [...messages];
	const omitted = messages.slice(0, -(options.maxMessages - 1));
	const retained = messages.slice(-(options.maxMessages - 1));
	const summary = options.summary?.trim() || summarizeOmittedHistory(omitted);
	return [{ role: 'system', content: `上下文已压缩：${summary}`, persist: true }, ...retained];
}

export interface AgentLoopResult {
	messages: AgentMessage[];
	finalContent?: string;
	pendingChangePlan?: PendingChangePlan;
}

/**
 * Runs an agent conversation while keeping Vault mutations behind a confirmation
 * boundary. Read-only calls are executed and fed back to the model; mutation
 * calls are converted into a preview plan and never applied here.
 */
export class AgentLoop {
	private readonly model: AgentModelPort;
	private readonly tools: AgentTool[];
	private readonly maxTurns: number;
	private readonly historyLimit?: number;
	private readonly historySummary: string;
	private readonly systemPrompt: string;
	private readonly toolResultBudget: ToolResultBudget;
	private readonly onToolCall?: (call: AgentToolCall) => void;

	constructor(model: AgentModelPort, tools: AgentTool[], options: AgentLoopOptions = {}) {
		this.model = model;
		this.tools = tools;
		this.maxTurns = options.maxTurns ?? 12;
		this.historyLimit = options.historyLimit;
		this.historySummary = options.historySummary ?? '';
		this.systemPrompt = options.systemPrompt?.trim() ?? '';
		this.toolResultBudget = options.toolResultBudget ?? DEFAULT_TOOL_RESULT_BUDGET;
		this.onToolCall = options.onToolCall;
	}

	async run(userMessage: string, history: AgentMessage[] = [], runtimeContext = ''): Promise<AgentLoopResult> {
		if (userMessage.trim() === '') throw new Error('用户消息不能为空');
		const compactedHistory = this.historyLimit === undefined
			? history.filter((message) => message.role !== 'system')
			: compactAgentHistory(
			history.filter((message) => message.role !== 'system' || message.persist === true),
				{ maxMessages: this.historyLimit, summary: this.historySummary || undefined },
			);
		const messages = compactedHistory;
		if (this.systemPrompt) messages.unshift({ role: 'system', content: this.systemPrompt });
		// Appended at the tail instead of after the system prompt: the runtime
		// context changes every turn, so putting it in the prefix invalidates the
		// provider's prompt cache for the whole conversation.
		const ephemeral: AgentMessage[] = [];
		if (runtimeContext.trim()) {
			const contextMessage: AgentMessage = { role: 'system', content: runtimeContext.trim() };
			messages.push(contextMessage);
			ephemeral.push(contextMessage);
		}
		messages.push({ role: 'user' as const, content: userMessage });
		const toolsByName = new Map(this.tools.map((tool) => [tool.name, tool]));
		const descriptions = this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
		const repeats = new RepeatTracker();
		let forceFinalStep = false;

		for (let turnIndex = 0; turnIndex < this.maxTurns; turnIndex += 1) {
			const finalStep = forceFinalStep || turnIndex === this.maxTurns - 1;
			if (finalStep) {
				const reminder: AgentMessage = { role: 'system', content: FINAL_STEP_REMINDER };
				messages.push(reminder);
				ephemeral.push(reminder);
			}
			const turn = await this.model.completeAgent(messages, descriptions);
			messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls });
			if (turn.toolCalls.length === 0) {
				return { messages: withoutEphemeral(messages, ephemeral), finalContent: turn.content };
			}
			if (finalStep) {
				// Leaving tool calls unanswered would make the stored history invalid
				// for the next request, so every pending call gets a closing result.
				for (const call of turn.toolCalls) {
					messages.push({ role: 'tool', toolCallId: call.id, content: serializeToolResult({ error: FINAL_STEP_TOOL_REJECTION }) });
				}
				return {
					messages: withoutEphemeral(messages, ephemeral),
					finalContent: turn.content.trim() || FINAL_STEP_FALLBACK,
				};
			}

			const plannedChanges: PlannedChange[] = [];
			const summaries: string[] = [];
			const applyActions: Array<() => Promise<void>> = [];
			const stepResults = new Map<string, string>();
			for (const call of turn.toolCalls) {
				this.onToolCall?.(call);
				const key = toolCallKey(call);
				const reused = stepResults.get(key);
				if (reused !== undefined) {
					messages.push({ role: 'tool', toolCallId: call.id, content: reused });
					continue;
				}
				const tool = toolsByName.get(call.name);
				if (!tool) {
					messages.push({ role: 'tool', toolCallId: call.id, content: serializeToolResult({ error: `未知工具：${call.name}` }) });
					continue;
				}

				let content: string;
				if (tool.kind === 'read-only') {
					try {
						content = this.budget(call.name, serializeToolResult(await tool.execute(call.arguments)));
					} catch (error) {
						content = serializeToolError(error);
					}
				} else {
					try {
						const plan = await tool.plan(call.arguments);
						summaries.push(plan.summary);
						plannedChanges.push(...plan.changes);
						if (plan.apply) applyActions.push(plan.apply);
						content = serializeToolResult({
							planned: true,
							summary: plan.summary,
							changes: plan.changes.map(({ id, summary }) => ({ id, summary })),
						});
					} catch (error) {
						content = serializeToolError(error);
					}
				}

				const streak = repeats.record(key);
				if (streak >= REPEAT_FORCE_FINAL_STREAK) forceFinalStep = true;
				const reminder = repeatReminder(streak);
				if (reminder) content += reminder;
				stepResults.set(key, content);
				messages.push({ role: 'tool', toolCallId: call.id, content });
			}

			if (plannedChanges.length > 0) {
				return {
					messages: withoutEphemeral(messages, ephemeral),
					pendingChangePlan: {
						id: `agent-plan-${turnIndex + 1}`,
						summary: summaries.join('；'),
						changes: plannedChanges,
						...(applyActions.length > 0 ? {
						apply: async () => {
							for (const apply of applyActions) await apply();
						},
					} : {}),
					},
				};
			}
		}

		throw new Error(`Agent Loop 超过最大轮数（${this.maxTurns}）`);
	}

	private budget(toolName: string, content: string): string {
		return budgetToolResultText(toolName, content, this.toolResultBudget).content;
	}
}

const REPEAT_REMINDER_STREAK = 3;
const REPEAT_FORCE_FINAL_STREAK = 6;
const FINAL_STEP_REMINDER = '已达到本轮工具调用上限：不要再调用任何工具，直接用已有信息给出结论，并说明还缺哪些信息。';
const FINAL_STEP_TOOL_REJECTION = '未执行：已达到本轮工具调用上限。';
const FINAL_STEP_FALLBACK = '已达到本轮工具调用上限，没有得出结论。请补充信息或缩小请求范围后重试。';

/** Counts consecutive identical tool calls so a spinning loop can be broken. */
class RepeatTracker {
	private lastKey?: string;
	private streak = 0;

	record(key: string): number {
		this.streak = key === this.lastKey ? this.streak + 1 : 1;
		this.lastKey = key;
		return this.streak;
	}
}

function repeatReminder(streak: number): string | undefined {
	if (streak < REPEAT_REMINDER_STREAK) return undefined;
	if (streak < REPEAT_FORCE_FINAL_STREAK) {
		return `\n\n[提示] 同一个工具调用已连续重复 ${streak} 次。下一步先说明你期望得到什么新信息；如果这个结果里已经有了，就用现有证据继续，不要重复调用。`;
	}
	return `\n\n[提示] 同一个工具调用已连续重复 ${streak} 次，本轮不再执行更多工具调用。请直接给出结论，并说明还缺哪些信息。`;
}

function toolCallKey(call: AgentToolCall): string {
	return `${call.name} ${canonicalArguments(call.arguments)}`;
}

function canonicalArguments(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return `[${value.map((item) => canonicalArguments(item)).join(',')}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalArguments(item)}`).join(',')}}`;
}

function withoutEphemeral(messages: AgentMessage[], ephemeral: AgentMessage[]): AgentMessage[] {
	return ephemeral.length === 0 ? messages : messages.filter((message) => !ephemeral.includes(message));
}

function summarizeOmittedHistory(messages: AgentMessage[]): string {
	const carriedSummaries = messages
		.filter((message) => message.role === 'system' && message.persist === true)
		.map((message) => message.content.replace(/^上下文已压缩：/, '').trim())
		.filter(Boolean);
	const userMessages = messages
		.filter((message) => message.role === 'user' && message.content.trim())
		.map((message) => message.content.trim());
	const parts = carriedSummaries.length > 0
		? [`历史摘要：${truncateHistoryText(carriedSummaries.join('\n'), 800)}`]
		: [];
	if (userMessages.length === 0) {
		return parts.join('\n') || '早期对话已压缩，请以当前消息和工具结果为准。';
	}
	const first = truncateHistoryText(userMessages[0]!);
	const last = userMessages.length === 1 ? undefined : truncateHistoryText(userMessages[userMessages.length - 1]!);
	parts.push(last === undefined
		? `早期用户请求：${first}`
		: `早期用户请求：${first}\n最近已压缩用户请求：${last}`);
	return parts.join('\n');
}

function truncateHistoryText(text: string, maxLength = 400): string {
	return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function serializeToolResult(result: unknown): string {
	const serialized = JSON.stringify(result);
	return serialized === undefined ? 'null' : serialized;
}

function serializeToolError(error: unknown): string {
	return serializeToolResult({ error: error instanceof Error ? error.message : '工具执行失败' });
}
