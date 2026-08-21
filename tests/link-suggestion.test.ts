import { describe, expect, it } from 'vitest';
import {
	INVALID_LINK_SUGGESTIONS,
	buildLinkSuggestionPreview,
	parseLinkSuggestions,
	reduceWikiLinks,
	type LinkSuggestionTarget,
} from '../src/links/link-suggestion';
import { contentRevision } from '../src/changes/change-plan';

const SOURCE = [
	'# 当前想法',
	'',
	'我在想注意力预算怎么分配。',
	'',
	'这条推理还没验证。',
	'',
	'另一段提到索引这件事。',
	'',
].join('\n');

const TARGETS: LinkSuggestionTarget[] = [
	{ path: '项目甲/注意力预算.md', title: '注意力预算', linkTarget: '注意力预算' },
	{ path: '项目甲/索引.md', title: '索引', linkTarget: '项目甲/索引' },
];

function raw(...suggestions: Record<string, unknown>[]): string {
	return JSON.stringify({ suggestions });
}

function wrapSuggestion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		targetPath: '项目甲/注意力预算.md',
		relation: 'extends',
		confidence: 'high',
		reason: '这句话正在分配注意力，目标笔记给出了分配方法。',
		evidence: '目标笔记：每天只能深度处理三件事。',
		anchor: '我在想注意力预算怎么分配。',
		anchorWithLink: '我在想[[注意力预算]]怎么分配。',
		...overrides,
	};
}

describe('parseLinkSuggestions', () => {
	it('accepts a suggestion that only wraps an existing mention', () => {
		const result = parseLinkSuggestions(raw(wrapSuggestion()), { targets: TARGETS, sourceContent: SOURCE });

		expect(result.rejected).toEqual([]);
		expect(result.total).toBe(1);
		expect(result.hasMore).toBe(false);
		expect(result.suggestions).toEqual([{
			targetPath: '项目甲/注意力预算.md',
			targetTitle: '注意力预算',
			linkTarget: '注意力预算',
			relation: 'extends',
			confidence: 'high',
			reason: '这句话正在分配注意力，目标笔记给出了分配方法。',
			evidence: '目标笔记：每天只能深度处理三件事。',
			anchor: '我在想注意力预算怎么分配。',
			anchorWithLink: '我在想[[注意力预算]]怎么分配。',
			mode: 'wrap',
		}]);
	});

	it('accepts a sentence appended after the anchor', () => {
		const result = parseLinkSuggestions(raw(wrapSuggestion({
			anchor: '这条推理还没验证。',
			anchorWithLink: '这条推理还没验证。参见[[注意力预算|上下文预算]]。',
			relation: 'background',
			confidence: 'medium',
		})), { targets: TARGETS, sourceContent: SOURCE });

		expect(result.rejected).toEqual([]);
		expect(result.suggestions[0]?.mode).toBe('append');
		expect(result.suggestions[0]?.confidence).toBe('medium');
	});

	it('accepts a full-path link for a unique target', () => {
		const result = parseLinkSuggestions(raw(wrapSuggestion({
			anchorWithLink: '我在想[[项目甲/注意力预算|注意力预算]]怎么分配。',
		})), { targets: TARGETS, sourceContent: SOURCE });

		expect(result.rejected).toEqual([]);
		expect(result.suggestions).toHaveLength(1);
	});

	it('rejects a target that was never offered as a candidate', () => {
		const result = parseLinkSuggestions(raw(wrapSuggestion({ targetPath: '凭空想象.md' })), {
			targets: TARGETS,
			sourceContent: SOURCE,
		});

		expect(result.suggestions).toEqual([]);
		expect(result.rejected).toEqual([{ targetPath: '凭空想象.md', reason: '目标笔记不在候选列表中：凭空想象.md' }]);
	});

	it('rejects low confidence and unknown relation types', () => {
		const result = parseLinkSuggestions(raw(
			wrapSuggestion({ confidence: 'low' }),
			wrapSuggestion({ targetPath: '项目甲/索引.md', relation: '很像', anchor: '另一段提到索引这件事。', anchorWithLink: '另一段提到[[项目甲/索引|索引]]这件事。' }),
		), { targets: TARGETS, sourceContent: SOURCE });

		expect(result.suggestions).toEqual([]);
		expect(result.rejected[0]?.reason).toContain('置信度过低');
		expect(result.rejected[1]?.reason).toContain('关系类型不在允许范围内');
	});

	it('rejects an anchor that is not in the source note', () => {
		const result = parseLinkSuggestions(raw(wrapSuggestion({
			anchor: '模型自己编的一句话。',
			anchorWithLink: '模型自己编的一句话，见[[注意力预算]]。',
		})), { targets: TARGETS, sourceContent: SOURCE });

		expect(result.rejected[0]?.reason).toContain('锚点句子不在原文中');
	});

	it('rejects an anchor that appears more than once', () => {
		const repeated = '我在想注意力预算怎么分配。\n\n我在想注意力预算怎么分配。\n';
		const result = parseLinkSuggestions(raw(wrapSuggestion()), { targets: TARGETS, sourceContent: repeated });

		expect(result.rejected[0]?.reason).toContain('出现多次');
	});

	it('rejects a rewrite that changes the original wording', () => {
		const result = parseLinkSuggestions(raw(wrapSuggestion({
			anchorWithLink: '我在想[[注意力预算]]究竟怎么分配。',
		})), { targets: TARGETS, sourceContent: SOURCE });

		expect(result.suggestions).toEqual([]);
		expect(result.rejected[0]?.reason).toContain('只允许加入链接');
	});

	it('rejects a rewrite without a link to the suggested note', () => {
		const result = parseLinkSuggestions(raw(wrapSuggestion({
			anchorWithLink: '我在想注意力预算怎么分配。参见[[别的笔记]]。',
		})), { targets: TARGETS, sourceContent: SOURCE });

		expect(result.rejected[0]?.reason).toContain('没有指向该笔记的链接');
	});

	it('requires the full path when the candidate title is ambiguous', () => {
		const result = parseLinkSuggestions(raw(wrapSuggestion({
			targetPath: '项目甲/索引.md',
			anchor: '另一段提到索引这件事。',
			anchorWithLink: '另一段提到[[索引]]这件事。',
		})), { targets: TARGETS, sourceContent: SOURCE });

		expect(result.rejected[0]?.reason).toContain('完整路径');
	});

	it('keeps only the first suggestion per target and per anchor', () => {
		const result = parseLinkSuggestions(raw(
			wrapSuggestion(),
			wrapSuggestion({ anchorWithLink: '我在想注意力预算怎么分配。这一点见[[注意力预算]]。' }),
			wrapSuggestion({
				targetPath: '项目甲/索引.md',
				anchor: '我在想注意力预算怎么分配。',
				anchorWithLink: '我在想注意力预算怎么分配。另见[[项目甲/索引]]。',
			}),
		), { targets: TARGETS, sourceContent: SOURCE });

		expect(result.suggestions).toHaveLength(1);
		expect(result.rejected[0]?.reason).toContain('同一目标笔记已有建议');
		expect(result.rejected[1]?.reason).toContain('锚点句子与前一条建议重叠');
	});

	it('limits how many suggestions are shown and reports the rest', () => {
		const result = parseLinkSuggestions(raw(
			wrapSuggestion(),
			wrapSuggestion({
				targetPath: '项目甲/索引.md',
				anchor: '另一段提到索引这件事。',
				anchorWithLink: '另一段提到[[项目甲/索引|索引]]这件事。',
			}),
		), { targets: TARGETS, sourceContent: SOURCE, limit: 1 });

		expect(result.suggestions).toHaveLength(1);
		expect(result.total).toBe(2);
		expect(result.hasMore).toBe(true);
	});

	it('reads a fenced JSON array and rejects unusable output', () => {
		const fenced = `\`\`\`json\n${JSON.stringify([wrapSuggestion()])}\n\`\`\``;
		expect(parseLinkSuggestions(fenced, { targets: TARGETS, sourceContent: SOURCE }).suggestions).toHaveLength(1);
		expect(() => parseLinkSuggestions('我觉得这两篇有点像', { targets: TARGETS, sourceContent: SOURCE }))
			.toThrow(INVALID_LINK_SUGGESTIONS);
		expect(() => parseLinkSuggestions(raw(), { targets: TARGETS, sourceContent: SOURCE, limit: 0 }))
			.toThrow('建议数量上限必须是正整数');
	});
});

describe('reduceWikiLinks', () => {
	it('replaces links with the text a reader actually sees', () => {
		expect(reduceWikiLinks('见[[甲]]和[[乙/丙|丙]]。')).toBe('见甲和丙。');
	});
});

describe('buildLinkSuggestionPreview', () => {
	it('replaces only the anchor sentence and pins the source revision', () => {
		const suggestion = parseLinkSuggestions(raw(wrapSuggestion()), {
			targets: TARGETS,
			sourceContent: SOURCE,
		}).suggestions[0]!;

		const preview = buildLinkSuggestionPreview({ path: '当前想法.md', content: SOURCE }, suggestion);

		expect(preview.changes).toHaveLength(1);
		expect(preview.expectedRevision).toBe(contentRevision(SOURCE));
		expect(preview.proposedContent).toContain('我在想[[注意力预算]]怎么分配。');
		expect(preview.proposedContent).toContain('这条推理还没验证。');
		expect(preview.reason).toContain('注意力预算');
	});

	it('fails instead of guessing when the anchor no longer exists', () => {
		const suggestion = parseLinkSuggestions(raw(wrapSuggestion()), {
			targets: TARGETS,
			sourceContent: SOURCE,
		}).suggestions[0]!;

		expect(() => buildLinkSuggestionPreview({ path: '当前想法.md', content: '笔记已经被改写了。' }, suggestion))
			.toThrow('未找到要替换的旧文本');
	});
});
