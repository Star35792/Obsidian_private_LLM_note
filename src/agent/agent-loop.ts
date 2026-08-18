export type AgentMessageRole = 'user' | 'assistant' | 'tool';

export interface AgentMessage {
	role: AgentMessageRole;
	content: string;
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
}

export interface PlannedChange {
	id: string;
	summary: string;
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

	constructor(model: AgentModelPort, tools: AgentTool[], options: AgentLoopOptions = {}) {
		this.model = model;
		this.tools = tools;
		this.maxTurns = options.maxTurns ?? 12;
	}

	async run(userMessage: string, history: AgentMessage[] = []): Promise<AgentLoopResult> {
		if (userMessage.trim() === '') throw new Error('用户消息不能为空');
		const messages = [...history, { role: 'user' as const, content: userMessage }];
		const toolsByName = new Map(this.tools.map((tool) => [tool.name, tool]));
		const descriptions = this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

		for (let turnIndex = 0; turnIndex < this.maxTurns; turnIndex += 1) {
			const turn = await this.model.completeAgent(messages, descriptions);
			messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls });
			if (turn.toolCalls.length === 0) return { messages, finalContent: turn.content };

			const plannedChanges: PlannedChange[] = [];
			const summaries: string[] = [];
			for (const call of turn.toolCalls) {
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
				} catch (error) {
					messages.push({ role: 'tool', toolCallId: call.id, content: serializeToolError(error) });
				}
			}

			if (plannedChanges.length > 0) {
				return {
					messages,
					pendingChangePlan: {
						id: `agent-plan-${turnIndex + 1}`,
						summary: summaries.join('；'),
						changes: plannedChanges,
					},
				};
			}
		}

		throw new Error(`Agent Loop 超过最大轮数（${this.maxTurns}）`);
	}
}

function serializeToolResult(result: unknown): string {
	const serialized = JSON.stringify(result);
	return serialized === undefined ? 'null' : serialized;
}

function serializeToolError(error: unknown): string {
	return serializeToolResult({ error: error instanceof Error ? error.message : '工具执行失败' });
}
