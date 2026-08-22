import { describe, expect, it } from 'vitest';
import {
	applyCompletion,
	detectCompletion,
	rankCompletionCandidates,
	type CompletionCandidate,
} from '../src/ui/composer-completion';

const CANDIDATES: CompletionCandidate[] = [
	{ value: '项目甲/', label: '项目甲/', isFolder: true },
	{ value: '项目甲/注意力预算.md', label: '注意力预算.md', description: '项目甲/注意力预算.md' },
	{ value: '项目乙/注意力.md', label: '注意力.md', description: '项目乙/注意力.md' },
	{ value: '已有链接.md', label: '已有链接.md', description: '已有链接.md' },
];

describe('detectCompletion', () => {
	it('treats a leading slash as a command trigger', () => {
		expect(detectCompletion('/整', 2)).toEqual({ kind: 'command', query: '整', start: 0, end: 2 });
	});

	it('allows leading whitespace before the command slash', () => {
		expect(detectCompletion('  /', 3)).toEqual({ kind: 'command', query: '', start: 2, end: 3 });
	});

	it('ignores a slash that is not the first token', () => {
		expect(detectCompletion('整理 /技能', 5)).toBeUndefined();
	});

	it('ignores a path-like second segment', () => {
		expect(detectCompletion('/整理/更多', 6)).toBeUndefined();
	});

	it('detects a mention at the start of a word', () => {
		expect(detectCompletion('读一下 @项目甲', 8)).toEqual({ kind: 'mention', query: '项目甲', start: 4, end: 8 });
	});

	it('does not detect a mention inside a word', () => {
		expect(detectCompletion('someone@example', 15)).toBeUndefined();
	});

	it('detects a quoted mention that still contains spaces', () => {
		const text = '看 @"项目 甲/笔';

		expect(detectCompletion(text, text.length)).toEqual({
			kind: 'mention',
			query: '项目 甲/笔',
			start: 2,
			end: text.length,
		});
	});

	it('stops treating a quoted mention as active after the closing quote', () => {
		const text = '看 @"项目 甲/笔.md" 然后';

		expect(detectCompletion(text, text.length)).toBeUndefined();
	});

	it('uses the text before the cursor only', () => {
		expect(detectCompletion('@项目 剩下的内容', 3)).toEqual({ kind: 'mention', query: '项目', start: 0, end: 3 });
	});

	it('returns nothing without a trigger', () => {
		expect(detectCompletion('帮我整理这段话', 7)).toBeUndefined();
	});
});

describe('rankCompletionCandidates', () => {
	it('puts folders first when nothing was typed yet', () => {
		const ranked = rankCompletionCandidates(CANDIDATES, '');

		expect(ranked[0]?.value).toBe('项目甲/');
	});

	it('ranks the shorter path first when the scores tie', () => {
		const ranked = rankCompletionCandidates(CANDIDATES, '注意力');

		expect(ranked.map((item) => item.value)).toEqual(['项目乙/注意力.md', '项目甲/注意力预算.md']);
	});

	it('ranks an exact base name above a partial one', () => {
		const ranked = rankCompletionCandidates(CANDIDATES, '注意力.md');

		expect(ranked[0]?.value).toBe('项目乙/注意力.md');
	});

	it('matches on the whole path as well', () => {
		const ranked = rankCompletionCandidates(CANDIDATES, '项目乙');

		expect(ranked.map((item) => item.value)).toEqual(['项目乙/注意力.md']);
	});

	it('ignores case', () => {
		const ranked = rankCompletionCandidates([{ value: 'Notes/Plan.md', label: 'Plan.md' }], 'plan');

		expect(ranked).toHaveLength(1);
	});

	it('drops candidates that do not match', () => {
		expect(rankCompletionCandidates(CANDIDATES, '没有这个')).toEqual([]);
	});

	it('respects the limit', () => {
		expect(rankCompletionCandidates(CANDIDATES, '', 2)).toHaveLength(2);
	});
});

describe('applyCompletion', () => {
	it('completes a command and leaves a trailing space', () => {
		const request = detectCompletion('/整', 2)!;

		expect(applyCompletion('/整', request, { value: '整理', label: '整理' })).toEqual({
			text: '/整理 ',
			cursor: 4,
		});
	});

	it('keeps the text after the cursor and reuses the space already there', () => {
		const request = detectCompletion('@项目 补充说明', 3)!;

		expect(applyCompletion('@项目 补充说明', request, { value: '项目甲/注意力预算.md', label: '注意力预算.md' })).toEqual({
			text: '@项目甲/注意力预算.md 补充说明',
			cursor: 14,
		});
	});

	it('quotes a mention whose path contains spaces', () => {
		const request = detectCompletion('@项目', 3)!;

		expect(applyCompletion('@项目', request, { value: '项目 甲/笔记.md', label: '笔记.md' })).toEqual({
			text: '@"项目 甲/笔记.md" ',
			cursor: 14,
		});
	});

	it('keeps the trailing slash of a folder candidate', () => {
		const request = detectCompletion('@项', 2)!;

		const applied = applyCompletion('@项', request, { value: '项目甲/', label: '项目甲/', isFolder: true });

		expect(applied.text).toBe('@项目甲/ ');
	});
});
