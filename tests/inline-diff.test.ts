import { describe, expect, it } from 'vitest';
import { buildInlineDiff, buildInlineHunkDiff, type InlineSegment } from '../src/changes/inline-diff';
import type { DiffLine } from '../src/changes/text-diff';

function join(segments: InlineSegment[]): string {
	return segments.map((segment) => segment.text).join('');
}

function changed(segments: InlineSegment[]): string[] {
	return segments.filter((segment) => segment.changed).map((segment) => segment.text);
}

function line(kind: DiffLine['kind'], text: string): DiffLine {
	return { kind, text };
}

describe('buildInlineDiff', () => {
	it('marks only the replaced part of the line', () => {
		const pair = buildInlineDiff('注意力预算需要重新分配。', '注意力预算需要立刻重新分配。');

		expect(pair).toBeDefined();
		expect(join(pair!.removed)).toBe('注意力预算需要重新分配。');
		expect(join(pair!.added)).toBe('注意力预算需要立刻重新分配。');
		expect(changed(pair!.removed)).toEqual([]);
		expect(changed(pair!.added)).toEqual(['立刻']);
	});

	it('marks both sides when a word is swapped', () => {
		const pair = buildInlineDiff('abc def ghi', 'abc xyz ghi');

		expect(pair!.removed).toEqual([
			{ text: 'abc ', changed: false },
			{ text: 'def', changed: true },
			{ text: ' ghi', changed: false },
		]);
		expect(pair!.added).toEqual([
			{ text: 'abc ', changed: false },
			{ text: 'xyz', changed: true },
			{ text: ' ghi', changed: false },
		]);
	});

	it('keeps the shared middle characters through LCS alignment', () => {
		const pair = buildInlineDiff('abXcd', 'abYcZd');

		expect(join(pair!.removed)).toBe('abXcd');
		expect(join(pair!.added)).toBe('abYcZd');
		expect(changed(pair!.removed)).toEqual(['X']);
		expect(changed(pair!.added)).toEqual(['Y', 'Z']);
	});

	it('returns nothing for identical lines', () => {
		expect(buildInlineDiff('一样的一行', '一样的一行')).toBeUndefined();
	});

	it('returns nothing when the two lines are not similar enough', () => {
		expect(buildInlineDiff('完全不同的一行内容', 'abcdefghij')).toBeUndefined();
	});

	it('can be forced to align dissimilar lines by lowering the threshold', () => {
		const pair = buildInlineDiff('完全不同的一行内容', 'abcdefghij', { minSimilarity: 0 });

		expect(join(pair!.removed)).toBe('完全不同的一行内容');
		expect(join(pair!.added)).toBe('abcdefghij');
	});

	it('falls back to one changed middle segment when the line is too long for LCS', () => {
		const removed = `前缀${'甲'.repeat(400)}后缀`;
		const added = `前缀${'乙'.repeat(400)}后缀`;

		const pair = buildInlineDiff(removed, added, { maxInlineCells: 100, minSimilarity: 0 });

		expect(join(pair!.removed)).toBe(removed);
		expect(join(pair!.added)).toBe(added);
		expect(changed(pair!.removed)).toEqual(['甲'.repeat(400)]);
		expect(changed(pair!.added)).toEqual(['乙'.repeat(400)]);
	});

	it('never splits a surrogate pair', () => {
		const pair = buildInlineDiff('👍 好', '👍 很好');

		expect(join(pair!.removed)).toBe('👍 好');
		expect(join(pair!.added)).toBe('👍 很好');
		for (const segment of [...pair!.removed, ...pair!.added]) {
			expect(segment.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
			expect(segment.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
		}
	});
});

describe('buildInlineHunkDiff', () => {
	it('pairs removed and added lines inside the same change run', () => {
		const lines = [
			line('context', '第一行'),
			line('removed', '第二行原来这样'),
			line('removed', '第三行原来那样'),
			line('added', '第二行现在这样'),
			line('added', '第三行现在那样'),
			line('context', '第四行'),
		];

		const inline = buildInlineHunkDiff(lines);

		expect([...inline.keys()].sort((left, right) => left - right)).toEqual([1, 2, 3, 4]);
		expect(changed(inline.get(1)!)).toEqual(['原来']);
		expect(changed(inline.get(4)!)).toEqual(['现在']);
	});

	it('leaves unpaired lines and context lines without segments', () => {
		const lines = [
			line('removed', '第二行原来这样'),
			line('removed', '多出来的一行'),
			line('added', '第二行现在这样'),
			line('context', '第四行'),
		];

		const inline = buildInlineHunkDiff(lines);

		expect([...inline.keys()].sort((left, right) => left - right)).toEqual([0, 2]);
	});

	it('does not pair across a context line', () => {
		const lines = [
			line('removed', '第二行原来这样'),
			line('context', '第三行'),
			line('added', '第二行现在这样'),
		];

		expect(buildInlineHunkDiff(lines).size).toBe(0);
	});

	it('skips pairs that are not similar enough', () => {
		const lines = [line('removed', '完全不同的一行内容'), line('added', 'abcdefghij')];

		expect(buildInlineHunkDiff(lines).size).toBe(0);
	});
});
