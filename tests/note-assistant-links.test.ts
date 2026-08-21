import { describe, expect, it } from 'vitest';
import { NoteAssistant } from '../src/core/note-assistant';
import { INVALID_LINK_SUGGESTIONS } from '../src/links/link-suggestion';
import type { LinkBrief } from '../src/links/link-brief';
import type { ModelPort, ModelRequest, ModelResponse } from '../src/model/model-port';

const SOURCE = '# 当前想法\n\n我在想注意力预算怎么分配。\n\n另一段提到索引这件事。\n';

const BRIEFS: LinkBrief[] = [
	{
		path: '项目甲/注意力预算.md',
		title: '注意力预算',
		linkTarget: '注意力预算',
		ambiguous: false,
		signals: ['unlinked-mention'],
		excerpt: '每天只能深度处理三件事。',
		truncated: false,
		mention: '注意力预算',
	},
	{
		path: '项目甲/索引.md',
		title: '索引',
		linkTarget: '项目甲/索引',
		ambiguous: true,
		signals: ['backlink', 'shared-tag'],
		excerpt: '这里汇总项目甲的入口。',
		truncated: true,
		sharedTags: ['#方法'],
	},
];

class StubModel implements ModelPort {
	readonly requests: ModelRequest[] = [];
	private readonly content: string;

	constructor(content: string) {
		this.content = content;
	}

	complete(request: ModelRequest): Promise<ModelResponse> {
		this.requests.push(request);
		return Promise.resolve({ content: this.content, streamed: true });
	}
}

function suggestion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		targetPath: '项目甲/注意力预算.md',
		relation: 'extends',
		confidence: 'high',
		reason: '这句话正在分配注意力。',
		anchor: '我在想注意力预算怎么分配。',
		anchorWithLink: '我在想[[注意力预算]]怎么分配。',
		...overrides,
	};
}

describe('NoteAssistant.suggestLinks', () => {
	it('sends the source note plus the given candidate briefs and returns validated suggestions', async () => {
		const model = new StubModel(JSON.stringify({ suggestions: [suggestion()] }));

		const result = await new NoteAssistant(model).suggestLinks({ sourceContent: SOURCE, briefs: BRIEFS });

		const request = model.requests[0]!;
		expect(request.system).toContain('JSON');
		expect(request.system).toContain('锚点');
		expect(request.user).toContain('我在想注意力预算怎么分配。');
		expect(request.user).toContain('每天只能深度处理三件事。');
		expect(request.user).toContain('项目甲/索引');
		expect(request.user).not.toContain('从未出现的笔记');
		expect(result.streamed).toBe(true);
		expect(result.suggestions).toHaveLength(1);
		expect(result.suggestions[0]?.mode).toBe('wrap');
	});

	it('applies the display limit and reports rejected suggestions', async () => {
		const model = new StubModel(JSON.stringify({
			suggestions: [
				suggestion(),
				suggestion({
					targetPath: '项目甲/索引.md',
					anchor: '另一段提到索引这件事。',
					anchorWithLink: '另一段提到[[项目甲/索引|索引]]这件事。',
				}),
				suggestion({ targetPath: '不存在的笔记.md' }),
			],
		}));

		const result = await new NoteAssistant(model).suggestLinks({
			sourceContent: SOURCE,
			briefs: BRIEFS,
			limit: 1,
		});

		expect(result.suggestions).toHaveLength(1);
		expect(result.total).toBe(2);
		expect(result.hasMore).toBe(true);
		expect(result.rejected[0]?.reason).toContain('不在候选列表中');
	});

	it('rejects output that is not the agreed JSON contract', async () => {
		const model = new StubModel('这两篇看起来有点关系。');

		await expect(new NoteAssistant(model).suggestLinks({ sourceContent: SOURCE, briefs: BRIEFS }))
			.rejects.toThrow(INVALID_LINK_SUGGESTIONS);
	});
});
