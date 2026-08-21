import { describe, expect, it } from 'vitest';
import {
	AgentLoop,
	compactAgentHistory,
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

	it('keeps runtime note context out of the stored conversation', async () => {
		const calls: AgentMessage[][] = [];
		const loop = new AgentLoop(scriptedModel([
			{ content: '我会在需要时读取。', toolCalls: [] },
		], calls), [], { systemPrompt: '按需使用工具。' });

		const result = await loop.run('整理当前笔记', [], '当前活动笔记路径：项目/想法.md；正文尚未读取。');

		expect(calls[0]).toEqual([
			{ role: 'system', content: '按需使用工具。' },
			{ role: 'system', content: '当前活动笔记路径：项目/想法.md；正文尚未读取。' },
			{ role: 'user', content: '整理当前笔记' },
		]);
		expect(result.messages).toEqual([
			{ role: 'system', content: '按需使用工具。' },
			{ role: 'user', content: '整理当前笔记' },
			{ role: 'assistant', content: '我会在需要时读取。', toolCalls: [] },
		]);
	});

	it('refreshes runtime context before prior conversation messages on later runs', async () => {
		const calls: AgentMessage[][] = [];
		const history: AgentMessage[] = [
			{ role: 'system', content: '旧提示' },
			{ role: 'user', content: '上一轮请求' },
			{ role: 'assistant', content: '上一轮回答' },
		];
		const loop = new AgentLoop(scriptedModel([
			{ content: '已切换到新笔记。', toolCalls: [] },
		], calls), [], { systemPrompt: '当前提示' });

		await loop.run('继续', history, '当前活动笔记路径：新笔记.md；正文尚未读取。');

		expect(calls[0]!.slice(0, 2)).toEqual([
			{ role: 'system', content: '当前提示' },
			{ role: 'system', content: '当前活动笔记路径：新笔记.md；正文尚未读取。' },
		]);
		expect(calls[0]).not.toContainEqual({ role: 'system', content: '旧提示' });
	});

	it('reports tool calls as they execute', async () => {
		const toolCalls: string[] = [];
		const loop = new AgentLoop(scriptedModel([
			{ content: '', toolCalls: [{ id: 'search-1', name: 'searchNotes', arguments: { query: '上下文' } }] },
			{ content: '找到了相关片段。', toolCalls: [] },
		]), [{
			kind: 'read-only', name: 'searchNotes', description: '搜索笔记', inputSchema: { type: 'object' },
			execute: async () => [],
		}], { onToolCall: (call) => toolCalls.push(call.name) });

		await loop.run('查找上下文');

		expect(toolCalls).toEqual(['searchNotes']);
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

	it('compacts long history with a recoverable summary and recent messages', async () => {
		const history: AgentMessage[] = [
			{ role: 'user', content: '最初目标：整理项目笔记' },
			{ role: 'assistant', content: '已确认目标' },
			{ role: 'user', content: '关键决策：保留原意' },
			{ role: 'assistant', content: '开始搜索' },
			{ role: 'user', content: '待办：生成预览后确认' },
		];
		const compacted = compactAgentHistory(history, {
			maxMessages: 3,
			summary: '最初目标：整理项目笔记；关键决策：保留原意；待办：生成预览后确认。',
		});

		expect(compacted[0]).toEqual({
			role: 'system',
			content: '上下文已压缩：最初目标：整理项目笔记；关键决策：保留原意；待办：生成预览后确认。',
			persist: true,
		});
		expect(compacted.slice(1)).toEqual(history.slice(-2));
	});

	it('preserves the first and latest omitted user request when no summary is supplied', () => {
		const compacted = compactAgentHistory([
			{ role: 'user', content: '最初目标：整理项目笔记' },
			{ role: 'assistant', content: '已确认' },
			{ role: 'user', content: '补充：保留原意' },
			{ role: 'assistant', content: '开始处理' },
		], { maxMessages: 2 });

		expect(compacted[0]?.content).toBe('上下文已压缩：早期用户请求：最初目标：整理项目笔记\n最近已压缩用户请求：补充：保留原意');
	});

	it('carries an earlier persistent summary into later compaction', () => {
		const first = compactAgentHistory([
			{ role: 'user', content: '最初目标：整理项目笔记' },
			{ role: 'assistant', content: '已确认' },
			{ role: 'user', content: '第一轮待办' },
			{ role: 'assistant', content: '第一轮完成' },
		], { maxMessages: 3 });
		const second = compactAgentHistory([
			...first,
			{ role: 'user', content: '第二轮请求' },
			{ role: 'assistant', content: '第二轮完成' },
		], { maxMessages: 3 });

		expect(second[0]?.content).toContain('最初目标：整理项目笔记');
	});

	it('rejects an invalid history limit even for a short conversation', () => {
		expect(() => compactAgentHistory([{ role: 'user', content: '请求' }], { maxMessages: 1 }))
			.toThrow('历史消息上限必须至少为 2');
	});

	it('uses history compaction before sending a later turn', async () => {
		const calls: AgentMessage[][] = [];
		const loop = new AgentLoop(scriptedModel([
			{ content: '继续处理。', toolCalls: [] },
		], calls), [], {
			historyLimit: 3,
		});
		await loop.run('继续', [
			{ role: 'user', content: '旧请求' },
			{ role: 'assistant', content: '旧回答' },
			{ role: 'user', content: '旧待办' },
			{ role: 'assistant', content: '旧过程' },
		]);

		expect(calls[0]).toContainEqual({ role: 'system', content: '上下文已压缩：早期用户请求：旧请求', persist: true });
		expect(calls[0]).toContainEqual({ role: 'user', content: '旧待办' });
		expect(calls[0]).toContainEqual({ role: 'assistant', content: '旧过程' });
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
