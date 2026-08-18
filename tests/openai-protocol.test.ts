import { describe, expect, it } from 'vitest';
import {
	buildOpenAiBody,
	buildOpenAiRequest,
	readOpenAiContent,
	readOpenAiStreamDelta,
} from '../src/model/openai-protocol';

const request = { system: '系统指令', user: '用户内容' };

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
});
