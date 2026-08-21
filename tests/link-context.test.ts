import { describe, expect, it } from 'vitest';
import { collectLinkContext, type LinkGraph, type LinkNote } from '../src/links/link-context';

describe('collectLinkContext', () => {
	it('ranks an unlinked mention above a backlink and a shared tag', () => {
		const result = collectLinkContext(graph({
			sourceContent: '# 当前想法\n\n这条推理依赖注意力预算，但还没有链接过去。',
			notes: [
				note('注意力预算.md', '注意力预算'),
				note('反向链接来源.md', '反向链接来源'),
				note('共享标签.md', '共享标签', { tags: ['#方法'] }),
			],
			links: { '反向链接来源.md': ['当前想法.md'] },
			sourceTags: ['#方法'],
		}));

		expect(result.candidates.map((candidate) => [candidate.target.path, candidate.signals])).toEqual([
			['注意力预算.md', ['unlinked-mention']],
			['反向链接来源.md', ['backlink']],
			['共享标签.md', ['shared-tag']],
		]);
		expect(result.candidates[0]!.mention).toBe('注意力预算');
		expect(result.candidates[2]!.sharedTags).toEqual(['#方法']);
		expect(result.candidates[0]!.score).toBeGreaterThan(result.candidates[1]!.score);
	});

	it('drops targets the source already links to, resolved or not', () => {
		const result = collectLinkContext(graph({
			sourceContent: '已经写过 [[注意力预算]] 和 [[缺失笔记]]，也提到未链接想法。',
			notes: [
				note('注意力预算.md', '注意力预算'),
				note('缺失笔记.md', '缺失笔记'),
				note('未链接想法.md', '未链接想法'),
			],
			links: { '当前想法.md': ['注意力预算.md'] },
			unresolvedFromSource: ['缺失笔记'],
		}));

		expect(result.candidates.map((candidate) => candidate.target.path)).toEqual(['未链接想法.md']);
		expect(result.skippedLinked).toBe(2);
		expect(result.outgoing.map((ref) => ref.path)).toEqual(['注意力预算.md']);
	});

	it('does not count a mention that is already inside a wiki link to another note', () => {
		const result = collectLinkContext(graph({
			sourceContent: '参见 [[项目甲/注意力预算|注意力预算]]。',
			notes: [note('注意力预算.md', '注意力预算'), note('项目甲/注意力预算.md', '注意力预算')],
			links: { '当前想法.md': ['项目甲/注意力预算.md'] },
		}));

		expect(result.candidates.map((candidate) => [candidate.target.path, candidate.signals])).toEqual([]);
	});

	it('marks same-title candidates as ambiguous and links them by full path', () => {
		const result = collectLinkContext(graph({
			sourceContent: '这条想法需要索引支持。',
			notes: [note('项目甲/索引.md', '索引'), note('项目乙/索引.md', '索引'), note('唯一笔记.md', '唯一笔记')],
			links: { '项目甲/索引.md': ['当前想法.md'], '唯一笔记.md': ['当前想法.md'] },
		}));

		const ambiguous = result.candidates.find((candidate) => candidate.target.path === '项目甲/索引.md');
		const unique = result.candidates.find((candidate) => candidate.target.path === '唯一笔记.md');
		expect(ambiguous).toMatchObject({
			ambiguous: true,
			linkTarget: '项目甲/索引',
			sameTitlePaths: ['项目甲/索引.md', '项目乙/索引.md'],
		});
		expect(unique).toMatchObject({ ambiguous: false, linkTarget: '唯一笔记' });
		expect(unique!.sameTitlePaths).toBeUndefined();
	});

	it('detects a mention through an alias and suggests the note title as link target', () => {
		const result = collectLinkContext(graph({
			sourceContent: '这里用到了 上下文预算 这个说法。',
			notes: [note('注意力预算.md', '注意力预算', { aliases: ['上下文预算'] })],
		}));

		expect(result.candidates[0]).toMatchObject({
			mention: '上下文预算',
			linkTarget: '注意力预算',
			signals: ['unlinked-mention'],
		});
	});

	it('uses two-hop shared neighbours only at depth 2', () => {
		const input = graph({
			sourceContent: '没有直接提及。',
			notes: [note('邻居.md', '邻居'), note('共同邻居.md', '共同邻居')],
			links: { '当前想法.md': ['邻居.md'], '共同邻居.md': ['邻居.md'] },
		});

		expect(collectLinkContext(input, { depth: 1 }).candidates).toEqual([]);
		expect(collectLinkContext(input, { depth: 2 }).candidates.map((candidate) => [
			candidate.target.path, candidate.signals,
		])).toEqual([['共同邻居.md', ['shared-neighbor']]]);
	});

	it('adds keyword hits supplied by the caller as a weak signal', () => {
		const result = collectLinkContext(graph({
			sourceContent: '没有直接提及。',
			notes: [note('搜索命中.md', '搜索命中')],
			keywordHits: ['搜索命中.md', '当前想法.md'],
		}));

		expect(result.candidates.map((candidate) => [candidate.target.path, candidate.signals])).toEqual([
			['搜索命中.md', ['keyword-hit']],
		]);
	});

	it('limits the candidate list and reports that more candidates exist', () => {
		const notes = Array.from({ length: 6 }, (_, index) => note(`候选${index}.md`, `候选${index}`, { tags: ['#方法'] }));
		const result = collectLinkContext(
			graph({ sourceContent: '没有直接提及。', notes, sourceTags: ['#方法'] }),
			{ limit: 2 },
		);

		expect(result.candidates.map((candidate) => candidate.target.path)).toEqual(['候选0.md', '候选1.md']);
		expect(result.totalCandidates).toBe(6);
		expect(result.hasMore).toBe(true);
	});

	it('never suggests the source note itself and rejects an invalid limit', () => {
		const source = note('当前想法.md', '当前想法');
		const result = collectLinkContext(graph({
			sourceContent: '当前想法 反复提到自己。',
			notes: [source, note('别的笔记.md', '别的笔记')],
		}));

		expect(result.candidates.map((candidate) => candidate.target.path)).toEqual([]);
		expect(result.source.path).toBe('当前想法.md');
		expect(() => collectLinkContext(graph({ sourceContent: '', notes: [] }), { limit: 0 }))
			.toThrow('候选上限必须是正整数');
	});
});

function note(path: string, title: string, extra: { aliases?: string[]; tags?: string[] } = {}): LinkNote {
	return { path, title, aliases: extra.aliases ?? [], tags: extra.tags ?? [] };
}

function graph(overrides: Partial<LinkGraph> & { sourceContent: string; notes: LinkNote[] } & {
	sourceTags?: string[];
}): LinkGraph {
	const { sourceTags, ...rest } = overrides;
	return {
		source: note('当前想法.md', '当前想法', { tags: sourceTags ?? [] }),
		links: {},
		unresolvedFromSource: [],
		keywordHits: [],
		...rest,
	};
}
