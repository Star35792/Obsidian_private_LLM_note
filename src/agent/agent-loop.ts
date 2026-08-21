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
	private readonly onToolCall?: (call: AgentToolCall) => void;

	constructor(model: AgentModelPort, tools: AgentTool[], options: AgentLoopOptions = {}) {
		this.model = model;
		this.tools = tools;
		this.maxTurns = options.maxTurns ?? 12;
		this.historyLimit = options.historyLimit;
		this.historySummary = options.historySummary ?? '';
		this.systemPrompt = options.systemPrompt?.trim() ?? '';
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
		const contextMessage: AgentMessage | undefined = runtimeContext.trim()
			? { role: 'system', content: runtimeContext.trim() }
			: undefined;
		if (contextMessage) messages.splice(this.systemPrompt ? 1 : 0, 0, contextMessage);
		messages.push({ role: 'user' as const, content: userMessage });
		const toolsByName = new Map(this.tools.map((tool) => [tool.name, tool]));
		const descriptions = this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

		for (let turnIndex = 0; turnIndex < this.maxTurns; turnIndex += 1) {
			const turn = await this.model.completeAgent(messages, descriptions);
			messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls });
			if (turn.toolCalls.length === 0) {
				return { messages: withoutRuntimeContext(messages, contextMessage), finalContent: turn.content };
			}

			const plannedChanges: PlannedChange[] = [];
			const summaries: string[] = [];
			const applyActions: Array<() => Promise<void>> = [];
			for (const call of turn.toolCalls) {
				this.onToolCall?.(call);
				const tool = toolsByName.get(call.name);
				if (!tool) {
					messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify({ error: `未知工具：${call.name}` }) });
					continue;
				}
				if (tool.kind === 'read-only') {
					try {
						const result = await tool.execute(call.arguments);
						messages.push({ role: 'tool', toolCallId: call.id, content: serializeToolResult(result) });
					} catch (error) {
						messages.push({ role: 'tool', toolCallId: call.id, content: serializeToolError(error) });
					}
					continue;
				}

				try {
					const plan = await tool.plan(call.arguments);
					summaries.push(plan.summary);
					plannedChanges.push(...plan.changes);
					if (plan.apply) applyActions.push(plan.apply);
					messages.push({
						role: 'tool',
						toolCallId: call.id,
						content: serializeToolResult({ planned: true, summary: plan.summary, changes: plan.changes.map(({ id, summary }) => ({ id, summary })) }),
					});
				} catch (error) {
					messages.push({ role: 'tool', toolCallId: call.id, content: serializeToolError(error) });
				}
			}

			if (plannedChanges.length > 0) {
				return {
					messages: withoutRuntimeContext(messages, contextMessage),
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
}

function withoutRuntimeContext(messages: AgentMessage[], contextMessage?: AgentMessage): AgentMessage[] {
	return contextMessage ? messages.filter((message) => message !== contextMessage) : messages;
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
