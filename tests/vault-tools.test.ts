import { describe, expect, it } from 'vitest';
import { createVaultReadTools, findSearchMatches, type VaultReadPort } from '../src/agent/vault-tools';

describe('Vault read tools', () => {
	it('exposes only bounded read operations and forwards validated arguments', async () => {
		const calls: unknown[][] = [];
		const vault: VaultReadPort = {
			listNotes: async (...args) => { calls.push(args); return []; },
			searchNotes: async (...args) => { calls.push(args); return []; },
			readNote: async (...args) => { calls.push(args); return { path: args[0], content: '内容' }; },
			getLinkContext: async (...args) => { calls.push(args); return { path: args[0], depth: args[1] }; },
		};
		const tools = createVaultReadTools(vault);

		expect(tools.map((tool) => [tool.name, tool.kind])).toEqual([
			['listNotes', 'read-only'], ['searchNotes', 'read-only'], ['readNote', 'read-only'], ['getLinkContext', 'read-only'],
		]);
		await tools[0]!.execute({ scope: '项目' });
		await tools[1]!.execute({ query: 'agent', scope: '项目' });
		await tools[2]!.execute({ path: '项目/想法.md' });
		await tools[3]!.execute({ path: '项目/想法.md', depth: 2 });

		expect(calls).toEqual([
			['项目'], ['agent', '项目'], ['项目/想法.md'], ['项目/想法.md', 2],
		]);
	});

	it('rejects malformed boundary arguments', async () => {
		const vault: VaultReadPort = {
			listNotes: async () => [], searchNotes: async () => [], readNote: async () => ({ path: 'x.md', content: '' }), getLinkContext: async () => ({}),
		};
		const tools = createVaultReadTools(vault);

		await expect(tools[1]!.execute({ query: '' })).rejects.toThrow('query');
		await expect(tools[0]!.execute({ scope: '../secret' })).rejects.toThrow('相对路径');
		await expect(tools[2]!.execute({ path: '../secret.md' })).rejects.toThrow('Vault 内');
		await expect(tools[3]!.execute({ path: 'x.md', depth: 3 })).rejects.toThrow('depth');
	});

	it('returns at most three bounded search excerpts instead of whole notes', () => {
		const longLine = `关键词${'x'.repeat(300)}`;
		const matches = findSearchMatches([
			'无关内容',
			'第一处关键词',
			longLine,
			'第三处关键词',
			'第四处关键词不会返回',
		].join('\n'), '关键词');

		expect(matches).toHaveLength(3);
		expect(matches.map((match) => match.line)).toEqual([2, 3, 4]);
		expect(matches[1]!.excerpt).toHaveLength(240);
		expect(matches[1]!.excerpt.endsWith('…')).toBe(true);
	});
});
