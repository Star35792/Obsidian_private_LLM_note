import { describe, expect, it } from 'vitest';
import { buildTextDiff, formatDiffStats } from '../src/changes/text-diff';

function renderDiff(original: string, proposed: string, options?: Parameters<typeof buildTextDiff>[2]): string[] {
	return buildTextDiff(original, proposed, options).hunks.flatMap((hunk) => [
		hunk.header,
		...hunk.lines.map((line) => `${line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}${line.text}`),
	]);
}

describe('text diff', () => {
	it('reports no change when both sides are identical', () => {
		const diff = buildTextDiff('# 标题\n正文\n', '# 标题\n正文\n');

		expect(diff.identical).toBe(true);
		expect(diff.hunks).toEqual([]);
		expect(formatDiffStats(diff)).toBe('内容没有变化');
	});

	it('shows only the edited line with surrounding context', () => {
		const original = ['一', '二', '三', '旧行', '五', '六', '七'].join('\n');
		const proposed = ['一', '二', '三', '新行', '五', '六', '七'].join('\n');

		expect(renderDiff(original, proposed)).toEqual([
			'@@ -1,7 +1,7 @@',
			' 一',
			' 二',
			' 三',
			'-旧行',
			'+新行',
			' 五',
			' 六',
			' 七',
		]);
		expect(formatDiffStats(buildTextDiff(original, proposed))).toBe('新增 1 行，删除 1 行');
	});

	it('shows an append as added lines after the tail context', () => {
		const diff = buildTextDiff('# 原始想法\n', '# 原始想法\n\n## 整理草稿\n');

		expect(diff.added).toBe(2);
		expect(diff.removed).toBe(0);
		expect(diff.hunks).toHaveLength(1);
		expect(diff.hunks[0]?.originalCount).toBe(2);
		expect(diff.hunks[0]?.proposedCount).toBe(4);
		expect(diff.hunks[0]?.lines.filter((line) => line.kind === 'added').map((line) => line.text))
			.toEqual(['## 整理草稿', '']);
	});

	it('splits distant changes into separate hunks', () => {
		const original = Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 行`);
		const proposed = [...original];
		proposed[1] = '开头改写';
		proposed[27] = '结尾改写';
		const diff = buildTextDiff(original.join('\n'), proposed.join('\n'));

		expect(diff.hunks).toHaveLength(2);
		expect(diff.hunks[0]?.header).toBe('@@ -1,5 +1,5 @@');
		expect(diff.hunks[1]?.header).toBe('@@ -25,6 +25,6 @@');
		expect(diff.added).toBe(2);
		expect(diff.removed).toBe(2);
	});

	it('keeps removed lines before added lines inside one change block', () => {
		expect(renderDiff('甲\n乙\n', '丙\n丁\n')).toEqual([
			'@@ -1,3 +1,3 @@',
			'-甲',
			'-乙',
			'+丙',
			'+丁',
			' ',
		]);
	});

	it('marks the diff as truncated instead of rendering every line', () => {
		const original = Array.from({ length: 200 }, (_, index) => `旧 ${index}`).join('\n');
		const proposed = Array.from({ length: 200 }, (_, index) => `新 ${index}`).join('\n');
		const diff = buildTextDiff(original, proposed, { maxDiffLines: 10 });

		expect(diff.truncated).toBe(true);
		expect(diff.hunks.flatMap((hunk) => hunk.lines)).toHaveLength(10);
		expect(diff.added).toBe(200);
		expect(diff.removed).toBe(200);
	});

	it('falls back to a block replacement when the change is too large to align', () => {
		const original = Array.from({ length: 1200 }, (_, index) => `旧 ${index}`).join('\n');
		const proposed = Array.from({ length: 1200 }, (_, index) => `新 ${index}`).join('\n');
		const started = Date.now();
		const diff = buildTextDiff(original, proposed, { maxDiffCells: 1000, maxDiffLines: 5000 });

		expect(diff.removed).toBe(1200);
		expect(diff.added).toBe(1200);
		expect(diff.hunks[0]?.lines[0]?.kind).toBe('removed');
		expect(Date.now() - started).toBeLessThan(2000);
	});
});
