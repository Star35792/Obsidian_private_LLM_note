import { describe, expect, it } from 'vitest';
import { buildLinkBrief, buildLinkBriefs, stripFrontmatter } from '../src/links/link-brief';
import type { LinkCandidate } from '../src/links/link-context';

function candidate(overrides: Partial<LinkCandidate> = {}): LinkCandidate {
	return {
		target: { path: '项目甲/注意力预算.md', title: '注意力预算', aliases: ['上下文预算'], tags: ['#方法'] },
		score: 5,
		signals: ['unlinked-mention'],
		linkTarget: '注意力预算',
		ambiguous: false,
		mention: '注意力预算',
		...overrides,
	};
}

describe('stripFrontmatter', () => {
	it('removes a leading frontmatter block', () => {
		expect(stripFrontmatter('---\ntags:\n  - 方法\n---\n\n正文第一句。\n')).toBe('正文第一句。\n');
	});

	it('keeps content that only contains a horizontal rule', () => {
		expect(stripFrontmatter('第一句。\n\n---\n\n第二句。')).toBe('第一句。\n\n---\n\n第二句。');
	});

	it('keeps content when the frontmatter block is never closed', () => {
		expect(stripFrontmatter('---\ntags: 方法\n第一句。')).toBe('---\ntags: 方法\n第一句。');
	});
});

describe('buildLinkBrief', () => {
	it('keeps the whole body and carries the candidate metadata', () => {
		const brief = buildLinkBrief(candidate(), '---\ntags:\n  - 方法\n---\n\n# 注意力预算\n\n每天只能深度处理三件事。\n');

		expect(brief).toEqual({
			path: '项目甲/注意力预算.md',
			title: '注意力预算',
			linkTarget: '注意力预算',
			ambiguous: false,
			signals: ['unlinked-mention'],
			mention: '注意力预算',
			excerpt: '# 注意力预算\n\n每天只能深度处理三件事。',
			truncated: false,
		});
	});

	it('collapses runs of blank lines so the excerpt budget goes to real content', () => {
		const brief = buildLinkBrief(candidate(), '第一段。\n\n\n\n第二段。');

		expect(brief.excerpt).toBe('第一段。\n\n第二段。');
	});

	it('reports shared tags and full-path link text for ambiguous candidates', () => {
		const brief = buildLinkBrief(
			candidate({
				linkTarget: '项目甲/索引',
				ambiguous: true,
				sameTitlePaths: ['项目甲/索引.md', '项目乙/索引.md'],
				sharedTags: ['#方法'],
				signals: ['backlink', 'shared-tag'],
			}),
			'索引正文。',
		);

		expect(brief.linkTarget).toBe('项目甲/索引');
		expect(brief.ambiguous).toBe(true);
		expect(brief.sharedTags).toEqual(['#方法']);
		expect(brief.signals).toEqual(['backlink', 'shared-tag']);
	});

	it('truncates at the last line break inside the budget', () => {
		const brief = buildLinkBrief(candidate(), '第一行内容。\n第二行内容会超出预算。', 12);

		expect(brief.excerpt).toBe('第一行内容。');
		expect(brief.truncated).toBe(true);
	});

	it('falls back to a sentence boundary when a single line is too long', () => {
		const brief = buildLinkBrief(candidate(), '第一句结束。第二句会超出字符预算。', 10);

		expect(brief.excerpt).toBe('第一句结束。');
		expect(brief.truncated).toBe(true);
	});

	it('cuts at the budget when there is no line or sentence boundary', () => {
		const brief = buildLinkBrief(candidate(), '一二三四五六七八九十', 4);

		expect(brief.excerpt).toBe('一二三四');
		expect(brief.truncated).toBe(true);
	});

	it('rejects an invalid character budget', () => {
		expect(() => buildLinkBrief(candidate(), '正文', 0)).toThrow('片段字符上限必须是正整数');
	});
});

describe('buildLinkBriefs', () => {
	it('keeps the ranking order and stops at the candidate limit', () => {
		const briefs = buildLinkBriefs([
			{ candidate: candidate(), content: '第一篇。' },
			{ candidate: candidate({ target: { path: '乙.md', title: '乙', aliases: [], tags: [] }, linkTarget: '乙' }), content: '第二篇。' },
			{ candidate: candidate({ target: { path: '丙.md', title: '丙', aliases: [], tags: [] }, linkTarget: '丙' }), content: '第三篇。' },
		], { limit: 2 });

		expect(briefs.map((brief) => brief.title)).toEqual(['注意力预算', '乙']);
	});

	it('rejects an invalid candidate limit', () => {
		expect(() => buildLinkBriefs([], { limit: -1 })).toThrow('候选片段数量上限必须是正整数');
	});
});
