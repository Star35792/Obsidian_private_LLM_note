import { describe, expect, it } from 'vitest';
import {
	AgentLoop,
	type AgentMessage,
	type AgentModelPort,
	type AgentToolDescription,
} from '../src/agent/agent-loop';

describe('AgentLoop', () => {
	it('feeds read-only tool results into the next model turn', async () => {
		const calls: AgentMessage[][] = [];
		const model = scriptedModel([
			{ content: '我先读取笔记。', toolCalls: [{ id: 'read-1', name: 'readNote', arguments: { path: '想法.md' } }] },
			{ content: '笔记已读取，可以继续整理。', toolCalls: [] },
		], calls);
		const loop = new AgentLoop(model, [{
			kind: 'read-only',
			name: 'readNote',
			description: '读取一篇笔记',
			inputSchema: { type: 'object' },
			execute: async () => ({ path: '想法.md', content: '保留用户原意' }),
		}]);

		const result = await loop.run('整理这篇笔记');

		expect(result.finalContent).toBe('笔记已读取，可以继续整理。');
		expect(calls).toHaveLength(2);
		expect(calls[1]).toContainEqual({
			role: 'tool',
			toolCallId: 'read-1',
			content: JSON.stringify({ path: '想法.md', content: '保留用户原意' }),
		});
	});

	it('turns mutation calls into a pending plan without applying changes', async () => {
		let planned = false;
		const loop = new AgentLoop(scriptedModel([{
			content: '建议把结果追加到当前笔记。',
			toolCalls: [{ id: 'update-1', name: 'updateNote', arguments: { path: '想法.md' } }],
		}]), [{
			kind: 'mutation',
			name: 'updateNote',
			description: '更新笔记',
			inputSchema: { type: 'object' },
			plan: async () => {
				planned = true;
				return {
					summary: '追加整理结果',
					changes: [{ id: 'append-result', summary: '在想法.md 末尾追加整理结果' }],
				};
			},
		}]);

		const result = await loop.run('把整理结果写回');

		expect(planned).toBe(true);
		expect(result.finalContent).toBeUndefined();
		expect(result.pendingChangePlan).toEqual({
			id: 'agent-plan-1',
			summary: '追加整理结果',
			changes: [{ id: 'append-result', summary: '在想法.md 末尾追加整理结果' }],
		});
	});

	it('reports an unknown tool to the model instead of executing it', async () => {
		const calls: AgentMessage[][] = [];
		const loop = new AgentLoop(scriptedModel([
			{ content: '', toolCalls: [{ id: 'bad-1', name: 'deleteEverything', arguments: {} }] },
			{ content: '这个工具不可用，我不会执行它。', toolCalls: [] },
		], calls), []);

		const result = await loop.run('处理笔记');

		expect(result.finalContent).toContain('不可用');
		expect(calls[1]).toContainEqual({
			role: 'tool',
			toolCallId: 'bad-1',
			content: JSON.stringify({ error: '未知工具：deleteEverything' }),
		});
	});

	it('returns read tool failures to the model as structured errors', async () => {
		const calls: AgentMessage[][] = [];
		const loop = new AgentLoop(scriptedModel([
			{ content: '', toolCalls: [{ id: 'read-1', name: 'readNote', arguments: { path: 'missing.md' } }] },
			{ content: '读取失败，我会保留当前笔记不变。', toolCalls: [] },
		], calls), [{
			kind: 'read-only', name: 'readNote', description: '读取笔记', inputSchema: { type: 'object' },
			execute: async () => { throw new Error('找不到 Markdown 笔记'); },
		}]);

		const result = await loop.run('读取 missing.md');

		expect(result.finalContent).toContain('保留当前笔记');
		expect(calls[1]).toContainEqual({
			role: 'tool', toolCallId: 'read-1', content: JSON.stringify({ error: '找不到 Markdown 笔记' }),
		});
	});
});

function scriptedModel(turns: Array<{ content: string; toolCalls: Array<{ id: string; name: string; arguments: unknown }> }>, calls: AgentMessage[][] = []): AgentModelPort {
	let index = 0;
	return {
		completeAgent: async (messages: AgentMessage[], _tools: AgentToolDescription[]) => {
			calls.push([...messages]);
			const turn = turns[index];
			index += 1;
			if (!turn) throw new Error('模型脚本已耗尽');
			return turn;
		},
	};
}
