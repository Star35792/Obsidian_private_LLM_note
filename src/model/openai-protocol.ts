import type { ModelRequest } from './model-port';
import type {
	AgentMessage,
	AgentToolCall,
	AgentToolDescription,
	AgentTurn,
} from '../agent/agent-loop';

export type ModelApiFormat = 'chat-completions' | 'responses';

export function buildOpenAiRequest(
	url: string,
	format: ModelApiFormat,
	model: string,
	request: ModelRequest,
	stream = false,
): { url: string; body: Record<string, unknown> } {
	return { url, body: buildOpenAiBody(format, model, request, stream) };
}

export function buildOpenAiBody(
	format: ModelApiFormat,
	model: string,
	request: ModelRequest,
	stream = false,
): Record<string, unknown> {
	if (format === 'responses') {
		return {
			model,
			instructions: request.system,
			input: request.user,
			...(stream ? { stream: true } : {}),
		};
	}
	return {
		model,
		messages: [
			{ role: 'system', content: request.system },
			{ role: 'user', content: request.user },
		],
		temperature: 0.2,
		...(stream ? { stream: true } : {}),
	};
}

export function readOpenAiContent(format: ModelApiFormat, value: unknown): string {
	if (!isRecord(value)) return '';
	if (format === 'chat-completions') {
		const choices = value.choices;
		if (!Array.isArray(choices) || !isRecord(choices[0]) || !isRecord(choices[0].message)) return '';
		return typeof choices[0].message.content === 'string' ? choices[0].message.content : '';
	}

	if (typeof value.output_text === 'string') return value.output_text;
	if (!Array.isArray(value.output)) return '';
	const texts: string[] = [];
	for (const output of value.output) {
		if (!isRecord(output) || !Array.isArray(output.content)) continue;
		for (const part of output.content) {
			if (isRecord(part) && part.type === 'output_text' && typeof part.text === 'string') {
				texts.push(part.text);
			}
		}
	}
	return texts.join('');
}

export function readOpenAiStreamDelta(format: ModelApiFormat, value: unknown): string {
	if (!isRecord(value)) return '';
	if (format === 'responses') {
		return value.type === 'response.output_text.delta' && typeof value.delta === 'string' ? value.delta : '';
	}
	const choices = value.choices;
	if (!Array.isArray(choices) || !isRecord(choices[0]) || !isRecord(choices[0].delta)) return '';
	return typeof choices[0].delta.content === 'string' ? choices[0].delta.content : '';
}

export function buildOpenAiAgentBody(
	format: ModelApiFormat,
	model: string,
	messages: AgentMessage[],
	tools: AgentToolDescription[],
): Record<string, unknown> {
	if (format === 'responses') {
		return {
			model,
			input: messages.flatMap((message) => toResponsesMessages(message)),
			tools: tools.map((tool) => ({
				type: 'function',
				name: tool.name,
				description: tool.description,
				parameters: tool.inputSchema,
			})),
		};
	}

	return {
		model,
		messages: [
			...messages.map((message) => toChatMessage(message)),
		],
		tools: tools.map((tool) => ({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.inputSchema,
			},
		})),
		temperature: 0.2,
	};
}

export function readOpenAiAgentTurn(format: ModelApiFormat, value: unknown): AgentTurn {
	if (!isRecord(value)) return { content: '', toolCalls: [] };
	if (format === 'chat-completions') return readChatAgentTurn(value);

	if (!Array.isArray(value.output)) return { content: '', toolCalls: [] };
	let content = '';
	const toolCalls: AgentToolCall[] = [];
	for (const item of value.output) {
		if (!isRecord(item)) continue;
		if (item.type === 'function_call' && typeof item.name === 'string' && typeof item.call_id === 'string') {
			toolCalls.push({ id: item.call_id, name: item.name, arguments: parseToolArguments(item.arguments) });
			continue;
		}
		if (!Array.isArray(item.content)) continue;
		for (const part of item.content) {
			if (isRecord(part) && part.type === 'output_text' && typeof part.text === 'string') content += part.text;
		}
	}
	return { content, toolCalls };
}

function toChatMessage(message: AgentMessage): Record<string, unknown> {
	if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
	if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
		return {
			role: 'assistant',
			content: message.content || null,
			tool_calls: message.toolCalls.map((call) => ({
				id: call.id,
				type: 'function',
				function: { name: call.name, arguments: JSON.stringify(call.arguments) },
			})),
		};
	}
	return { role: message.role, content: message.content };
}

function toResponsesMessages(message: AgentMessage): Record<string, unknown>[] {
	if (message.role === 'tool') {
		return [{ type: 'function_call_output', call_id: message.toolCallId, output: message.content }];
	}
	if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
		return message.toolCalls.map((call) => ({
			type: 'function_call',
			call_id: call.id,
			name: call.name,
			arguments: JSON.stringify(call.arguments),
		}));
	}
	return [{ role: message.role, content: message.content }];
}

function readChatAgentTurn(value: Record<string, unknown>): AgentTurn {
	const choices = value.choices;
	if (!Array.isArray(choices) || !isRecord(choices[0]) || !isRecord(choices[0].message)) {
		return { content: '', toolCalls: [] };
	}
	const message = choices[0].message;
	const toolCalls: AgentToolCall[] = [];
	if (Array.isArray(message.tool_calls)) {
		for (const call of message.tool_calls) {
			if (!isRecord(call) || typeof call.id !== 'string' || !isRecord(call.function)) continue;
			if (typeof call.function.name !== 'string') continue;
			toolCalls.push({
				id: call.id,
				name: call.function.name,
				arguments: parseToolArguments(call.function.arguments),
			});
		}
	}
	return { content: typeof message.content === 'string' ? message.content : '', toolCalls };
}

function parseToolArguments(value: unknown): unknown {
	if (typeof value !== 'string') return value ?? {};
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return { raw: value };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
