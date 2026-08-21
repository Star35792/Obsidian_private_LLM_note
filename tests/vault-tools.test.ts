import { describe, expect, it } from 'vitest';
import {
	createVaultReadTools,
	findSearchMatches,
	readNoteWindow,
	DEFAULT_NOTE_WINDOW_LINES,
	type VaultReadPort,
} from '../src/agent/vault-tools';

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

	it('caps listNotes and reports that more notes exist', async () => {
		const notes = Array.from({ length: 5 }, (_, index) => ({
			path: `笔记${index}.md`, title: `笔记${index}`, aliases: [],
		}));
		const vault: VaultReadPort = {
			listNotes: async () => notes,
			searchNotes: async () => [],
			readNote: async () => ({ path: 'x.md', content: '' }),
			getLinkContext: async () => ({}),
		};
		const tools = createVaultReadTools(vault);

		expect(await tools[0]!.execute({ limit: 2 })).toEqual({
			total: 5, returned: 2, hasMore: true, notes: notes.slice(0, 2),
		});
		await expect(tools[0]!.execute({ limit: 500 })).rejects.toThrow('limit');
	});

	it('reads a note as a line window and reports the next offset', async () => {
		const content = Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 行`).join('\n');
		const vault: VaultReadPort = {
			listNotes: async () => [],
			searchNotes: async () => [],
			readNote: async (path) => ({ path, content }),
			getLinkContext: async () => ({}),
		};
		const readNote = createVaultReadTools(vault)[2]!;

		expect(await readNote.execute({ path: '想法.md', limit: 5 })).toEqual({
			path: '想法.md',
			content: '第 1 行\n第 2 行\n第 3 行\n第 4 行\n第 5 行',
			startLine: 1,
			endLine: 5,
			totalLines: 12,
			hasMore: true,
			nextOffset: 6,
		});
		expect(await readNote.execute({ path: '想法.md', offset: 6, limit: 100 })).toMatchObject({
			startLine: 6, endLine: 12, hasMore: false,
		});
	});
});

describe('readNoteWindow', () => {
	it('returns the whole note when it fits the default window', () => {
		const window = readNoteWindow('第一行\n第二行');

		expect(window).toEqual({
			content: '第一行\n第二行', startLine: 1, endLine: 2, totalLines: 2, hasMore: false,
		});
		expect(DEFAULT_NOTE_WINDOW_LINES).toBeGreaterThan(2);
	});

	it('keeps CRLF line endings verbatim so the window still matches the source', () => {
		const content = '第一行\r\n第二行\r\n第三行';
		const window = readNoteWindow(content, { offset: 2, limit: 2 });

		expect(window.content).toBe('第二行\r\n第三行');
		expect(content.includes(window.content)).toBe(true);
	});

	it('returns an empty window past the end of the note', () => {
		expect(readNoteWindow('第一行\n第二行', { offset: 9 })).toEqual({
			content: '', startLine: 9, endLine: 8, totalLines: 2, hasMore: false,
		});
	});

	it('truncates a single line that exceeds the character budget', () => {
		const window = readNoteWindow(`${'长'.repeat(50)}\n第二行`, { maxChars: 10 });

		expect(window).toEqual({
			content: '长'.repeat(10),
			startLine: 1,
			endLine: 1,
			totalLines: 2,
			hasMore: true,
			nextOffset: 2,
			lineTruncated: true,
		});
	});

	it('stops a window at the character budget before the line budget', () => {
		const content = Array.from({ length: 10 }, () => '一二三四五').join('\n');
		const window = readNoteWindow(content, { limit: 10, maxChars: 12 });

		expect(window.endLine).toBe(2);
		expect(window.hasMore).toBe(true);
		expect(window.nextOffset).toBe(3);
	});

	it('rejects out-of-range window arguments', () => {
		expect(() => readNoteWindow('内容', { offset: 0 })).toThrow('offset');
		expect(() => readNoteWindow('内容', { limit: 0 })).toThrow('limit');
		expect(() => readNoteWindow('内容', { limit: 9999 })).toThrow('limit');
		expect(() => readNoteWindow('内容', { maxChars: 0 })).toThrow('字符上限');
	});
});
