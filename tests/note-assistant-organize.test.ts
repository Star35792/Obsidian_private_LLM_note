import { describe, expect, it } from 'vitest';
import { NoteAssistant } from '../src/core/note-assistant';
import type { ModelPort, ModelRequest, ModelResponse } from '../src/model/model-port';

const PROPOSAL = JSON.stringify({
	summary: '一句概括。',
	confirmed: ['已确认的事实。'],
	questions: ['还需要澄清什么？'],
	assumptions: ['一个未验证假设。'],
	nextSteps: ['下一步。'],
	rationale: ['依据原文第一段。'],
});

class StubModel implements ModelPort {
	readonly requests: ModelRequest[] = [];

	complete(request: ModelRequest): Promise<ModelResponse> {
		this.requests.push(request);
		return Promise.resolve({ content: PROPOSAL, streamed: false });
	}
}

describe('NoteAssistant.organize', () => {
	it('sends the whole note by default', async () => {
		const model = new StubModel();

		const result = await new NoteAssistant(model).organize({ content: '# 想法\n\n注意力预算。\n' });

		expect(model.requests[0]?.user).toContain('笔记内容开始');
		expect(model.requests[0]?.user).not.toContain('选区');
		expect(result.markdown).toContain('一句概括。');
	});

	it('tells the model the content is only a selection', async () => {
		const model = new StubModel();

		await new NoteAssistant(model).organize({ content: '注意力预算。', selectionOnly: true });

		const user = model.requests[0]!.user;
		expect(user).toContain('选区内容开始');
		expect(user).toContain('不是全文');
		expect(user).not.toContain('笔记内容开始');
		expect(user).toContain('注意力预算。');
	});
});
