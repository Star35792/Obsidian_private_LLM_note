import { describe, expect, it } from 'vitest';
import {
	buildOpenAiAgentBody,
	buildOpenAiBody,
	buildOpenAiRequest,
	readOpenAiAgentTurn,
	readOpenAiContent,
	readOpenAiStreamDelta,
} from '../src/model/openai-protocol';
import type { AgentMessage, AgentToolDescription } from '../src/agent/agent-loop';

const request = { system: '系统指令', user: '用户内容' };
const agentMessages: AgentMessage[] = [
	{ role: 'user', content: '读取当前笔记' },
	{ role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'readNote', arguments: { path: '当前.md' } }] },
	{ role: 'tool', toolCallId: 'call-1', content: '{"path":"当前.md"}' },
];
const agentTools: AgentToolDescription[] = [{
	name: 'readNote',
	description: '读取笔记',
	inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
}];

describe('OpenAI protocol', () => {
	it('uses the complete user-provided API URL without changing it', () => {
		const built = buildOpenAiRequest(
			'https://example.com/custom/v1/responses?channel=notes',
			'responses',
			'test-model',
			request,
		);

		expect(built.url).toBe('https://example.com/custom/v1/responses?channel=notes');
	});

	it('builds a Chat Completions request body', () => {
		expect(buildOpenAiBody('chat-completions', 'test-model', request)).toEqual({
			model: 'test-model',
			messages: [
				{ role: 'system', content: '系统指令' },
				{ role: 'user', content: '用户内容' },
			],
			temperature: 0.2,
		});
	});

	it('enables streaming without changing the selected protocol', () => {
		expect(buildOpenAiBody('chat-completions', 'test-model', request, true)).toMatchObject({
			model: 'test-model',
			stream: true,
		});
		expect(buildOpenAiBody('responses', 'test-model', request, true)).toMatchObject({
			model: 'test-model',
			stream: true,
		});
	});

	it('builds a Responses API request body', () => {
		expect(buildOpenAiBody('responses', 'test-model', request)).toEqual({
			model: 'test-model',
			instructions: '系统指令',
			input: '用户内容',
		});
	});

	it('reads Chat Completions content', () => {
		expect(readOpenAiContent('chat-completions', {
			choices: [{ message: { content: '{"summary":"ok"}' } }],
		})).toBe('{"summary":"ok"}');
	});

	it('reads both common Responses API content shapes', () => {
		expect(readOpenAiContent('responses', { output_text: '{"summary":"direct"}' }))
			.toBe('{"summary":"direct"}');
		expect(readOpenAiContent('responses', {
			output: [{ type: 'message', content: [{ type: 'output_text', text: '{"summary":"nested"}' }] }],
		})).toBe('{"summary":"nested"}');
	});

	it('reads streaming deltas from both protocols', () => {
		expect(readOpenAiStreamDelta('chat-completions', {
			choices: [{ delta: { content: '{"summary"' } }],
		})).toBe('{"summary"');
		expect(readOpenAiStreamDelta('responses', {
			type: 'response.output_text.delta',
			delta: '{"summary"',
		})).toBe('{"summary"');
	});

	it('builds tool calls and tool results for Chat Completions', () => {
		expect(buildOpenAiAgentBody('chat-completions', 'test-model', agentMessages, agentTools)).toEqual({
			model: 'test-model',
			messages: [
				{ role: 'user', content: '读取当前笔记' },
				{
					role: 'assistant',
					content: null,
					tool_calls: [{
						id: 'call-1',
						type: 'function',
						function: { name: 'readNote', arguments: '{"path":"当前.md"}' },
					}],
				},
				{ role: 'tool', tool_call_id: 'call-1', content: '{"path":"当前.md"}' },
			],
			tools: [{ type: 'function', function: { name: 'readNote', description: '读取笔记', parameters: agentTools[0]!.inputSchema } }],
			temperature: 0.2,
		});
	});

	it('parses tool calls from Chat Completions and Responses', () => {
		expect(readOpenAiAgentTurn('chat-completions', {
			choices: [{ message: { content: '', tool_calls: [{
				id: 'call-1', type: 'function', function: { name: 'readNote', arguments: '{"path":"当前.md"}' },
			}] } }],
		})).toEqual({ content: '', toolCalls: [{ id: 'call-1', name: 'readNote', arguments: { path: '当前.md' } }] });
		expect(readOpenAiAgentTurn('responses', {
			output: [{ type: 'function_call', call_id: 'call-2', name: 'readNote', arguments: '{"path":"当前.md"}' }],
		})).toEqual({ content: '', toolCalls: [{ id: 'call-2', name: 'readNote', arguments: { path: '当前.md' } }] });
	});
});
