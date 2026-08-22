import { describe, expect, it } from 'vitest';
import {
	buildMentionContext,
	buildSkillContext,
	matchesCommandToken,
	parsePromptInput,
	resolveMentions,
	type MentionTargets,
} from '../src/agent/prompt-input';

const TARGETS: MentionTargets = {
	notes: [
		{ path: '已有链接.md', title: '已有链接', aliases: [] },
		{ path: '项目甲/注意力预算.md', title: '注意力预算', aliases: ['预算笔记'] },
		{ path: '项目乙/注意力预算.md', title: '注意力预算', aliases: [] },
		{ path: '项目乙/回顾.md', title: '回顾', aliases: [] },
	],
	folders: ['项目甲', '项目乙', '项目乙/归档'],
};

describe('parsePromptInput', () => {
	it('reads the leading command and its arguments', () => {
		expect(parsePromptInput('/整理 只处理第二段')).toMatchObject({
			commandToken: '整理',
			commandArguments: '只处理第二段',
		});
	});

	it('reads a command without arguments', () => {
		expect(parsePromptInput('  /寻找关联  ')).toMatchObject({ commandToken: '寻找关联', commandArguments: '' });
	});

	it('does not treat a mid-message slash as a command', () => {
		expect(parsePromptInput('先看 /整理 的结果').commandToken).toBeUndefined();
	});

	it('collects mentions and marks folder hints', () => {
		const parsed = parsePromptInput('把 @项目甲/注意力预算.md 的要点补进 @项目乙/');

		expect(parsed.mentions).toEqual([
			{ raw: '@项目甲/注意力预算.md', query: '项目甲/注意力预算.md', folderHint: false },
			{ raw: '@项目乙/', query: '项目乙', folderHint: true },
		]);
	});

	it('reads a quoted mention with spaces and strips trailing punctuation', () => {
		const parsed = parsePromptInput('看 @"项目 甲/笔 记.md"，再看 @回顾。');

		expect(parsed.mentions.map((mention) => mention.query)).toEqual(['项目 甲/笔 记.md', '回顾']);
	});

	it('deduplicates repeated mentions', () => {
		expect(parsePromptInput('@回顾 和 @回顾').mentions).toHaveLength(1);
	});

	it('ignores an at sign that is not at the start of a word', () => {
		expect(parsePromptInput('someone@example.com').mentions).toEqual([]);
	});

	it('keeps the trimmed original text', () => {
		expect(parsePromptInput('  /整理 @回顾  ').text).toBe('/整理 @回顾');
	});
});

describe('resolveMentions', () => {
	const resolve = (text: string) => resolveMentions(parsePromptInput(text).mentions, TARGETS);

	it('resolves a full note path', () => {
		expect(resolve('@项目甲/注意力预算.md')).toEqual({ notes: ['项目甲/注意力预算.md'], folders: [], unresolved: [] });
	});

	it('resolves a path without the markdown extension', () => {
		expect(resolve('@项目乙/回顾').notes).toEqual(['项目乙/回顾.md']);
	});

	it('resolves a unique title', () => {
		expect(resolve('@回顾').notes).toEqual(['项目乙/回顾.md']);
	});

	it('resolves a unique alias', () => {
		expect(resolve('@预算笔记').notes).toEqual(['项目甲/注意力预算.md']);
	});

	it('refuses to guess between notes with the same title', () => {
		const resolution = resolve('@注意力预算');

		expect(resolution.notes).toEqual([]);
		expect(resolution.unresolved[0]?.raw).toBe('@注意力预算');
		expect(resolution.unresolved[0]?.reason).toContain('完整路径');
	});

	it('resolves a folder when the mention ends with a slash', () => {
		expect(resolve('@项目乙/')).toEqual({ notes: [], folders: ['项目乙'], unresolved: [] });
	});

	it('resolves a folder without a trailing slash when no note matches', () => {
		expect(resolve('@项目甲').folders).toEqual(['项目甲']);
	});

	it('reports a folder hint that matches nothing', () => {
		const resolution = resolve('@项目丙/');

		expect(resolution.folders).toEqual([]);
		expect(resolution.unresolved[0]?.reason).toContain('文件夹');
	});

	it('reports a mention that matches nothing', () => {
		expect(resolve('@不存在的笔记').unresolved).toHaveLength(1);
	});

	it('rejects a mention that escapes the vault', () => {
		expect(resolve('@../外部.md').unresolved[0]?.reason).toContain('相对路径');
	});

	it('deduplicates notes resolved through different mentions', () => {
		expect(resolve('@项目乙/回顾.md 和 @回顾').notes).toEqual(['项目乙/回顾.md']);
	});

	it('ignores case in paths and titles', () => {
		const resolution = resolveMentions(parsePromptInput('@notes/PLAN').mentions, {
			notes: [{ path: 'Notes/Plan.md', title: 'Plan', aliases: [] }],
			folders: ['Notes'],
		});

		expect(resolution.notes).toEqual(['Notes/Plan.md']);
	});
});

describe('buildMentionContext', () => {
	it('lists notes and folders without sending any content', () => {
		const context = buildMentionContext({
			notes: ['项目甲/注意力预算.md'],
			folders: ['项目乙'],
			unresolved: [],
		});

		expect(context).toContain('项目甲/注意力预算.md');
		expect(context).toContain('项目乙');
		expect(context).toContain('readNote');
		expect(context).toContain('scope');
	});

	it('returns nothing when no mention resolved', () => {
		expect(buildMentionContext({ notes: [], folders: [], unresolved: [{ raw: '@x', reason: '找不到' }] })).toBe('');
	});
});

describe('buildSkillContext', () => {
	it('carries the skill body and points at useSkill for later turns', () => {
		const context = buildSkillContext({
			name: '整理',
			path: 'skills/整理.md',
			instructions: '先复述主张，再给出结构。',
		});

		expect(context).toContain('整理');
		expect(context).toContain('skills/整理.md');
		expect(context).toContain('先复述主张，再给出结构。');
		expect(context).toContain('useSkill');
	});
});

describe('matchesCommandToken', () => {
	it('matches the name itself', () => {
		expect(matchesCommandToken('寻找关联', '寻找关联')).toBe(true);
	});

	it('matches a name with spaces through its slug', () => {
		expect(matchesCommandToken('code review', 'code-review')).toBe(true);
	});

	it('ignores case', () => {
		expect(matchesCommandToken('Review', 'review')).toBe(true);
	});

	it('rejects a different name', () => {
		expect(matchesCommandToken('整理', '整')).toBe(false);
	});
});
