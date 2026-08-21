import { describe, expect, it } from 'vitest';
import { applyTextChanges, buildChangePreview, createReplaceChange } from '../src/changes/change-plan';
import { buildTextDiff } from '../src/changes/text-diff';
import {
	buildHunkSelectionPreview,
	hunkToTextChange,
	selectHunkChanges,
} from '../src/changes/hunk-selection';
import type { ChangePreview } from '../src/changes/change-plan';

const NUMBERED = Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 行`);

function twoChanges(lines: string[] = NUMBERED): string[] {
	return lines.map((line, index) => (index === 1 ? '开头改写' : index === 27 ? '结尾改写' : line));
}

function fullReplacePreview(path: string, original: string, proposed: string): ChangePreview {
	return buildChangePreview(
		{ path, content: original },
		[createReplaceChange(original, 0, original.length, proposed)],
		'按用户请求更新笔记内容。',
	);
}

describe('hunk selection', () => {
	it('reproduces the whole proposal when every hunk is selected', () => {
		const original = NUMBERED.join('\n');
		const proposed = twoChanges().join('\n');
		const diff = buildTextDiff(original, proposed);

		expect(diff.hunks).toHaveLength(2);
		expect(applyTextChanges(original, selectHunkChanges(original, diff.hunks, [0, 1]))).toBe(proposed);
	});

	it('applies only the selected hunk and leaves the other change unwritten', () => {
		const original = NUMBERED.join('\n');
		const diff = buildTextDiff(original, twoChanges().join('\n'));

		const result = applyTextChanges(original, selectHunkChanges(original, diff.hunks, [0])).split('\n');

		expect(result[1]).toBe('开头改写');
		expect(result[27]).toBe('第 28 行');
	});

	it('keeps CRLF line endings when writing back part of the change', () => {
		const original = NUMBERED.join('\r\n');
		const diff = buildTextDiff(original, twoChanges().join('\r\n'));

		const result = applyTextChanges(original, selectHunkChanges(original, diff.hunks, [0]));

		expect(result).toBe(NUMBERED.map((line, index) => (index === 1 ? '开头改写' : line)).join('\r\n'));
		expect(result.split('\r\n')).toHaveLength(30);
	});

	it('removes the whole line for a deletion hunk without leaving a blank line', () => {
		const original = '甲\n乙\n丙\n';
		const proposed = '甲\n丙\n';
		const diff = buildTextDiff(original, proposed, { contextLines: 0 });

		expect(diff.hunks).toHaveLength(1);
		expect(applyTextChanges(original, selectHunkChanges(original, diff.hunks, [0]))).toBe(proposed);
	});

	it('deletes trailing lines by dropping the preceding line break', () => {
		const original = '甲\n乙\n丙';
		const proposed = '甲';
		const diff = buildTextDiff(original, proposed, { contextLines: 0 });

		expect(applyTextChanges(original, selectHunkChanges(original, diff.hunks, [0]))).toBe(proposed);
	});

	it('writes back an appended block on its own', () => {
		const original = '# 原始想法\n';
		const proposed = '# 原始想法\n\n## 整理草稿\n- 一条\n';
		const diff = buildTextDiff(original, proposed);

		expect(applyTextChanges(original, selectHunkChanges(original, diff.hunks, [0]))).toBe(proposed);
	});

	it('rejects a hunk whose original lines no longer match the note', () => {
		const original = NUMBERED.join('\n');
		const diff = buildTextDiff(original, twoChanges().join('\n'));
		const edited = NUMBERED.map((line, index) => (index === 2 ? '用户刚刚改过这行' : line)).join('\n');

		expect(() => hunkToTextChange(edited, diff.hunks[0]!)).toThrow('与当前笔记内容不一致');
	});

	it('rejects a hunk that points past the end of the note', () => {
		const original = NUMBERED.join('\n');
		const diff = buildTextDiff(original, twoChanges().join('\n'));

		expect(() => hunkToTextChange('只有一行\n', diff.hunks[1]!)).toThrow('超出笔记范围');
	});

	it('rejects an empty, duplicated or out-of-range selection', () => {
		const original = NUMBERED.join('\n');
		const diff = buildTextDiff(original, NUMBERED.map((line, index) => (index === 1 ? '开头改写' : line)).join('\n'));

		expect(() => selectHunkChanges(original, diff.hunks, [])).toThrow('至少选择一处变更');
		expect(() => selectHunkChanges(original, diff.hunks, [0, 0])).toThrow('变更序号重复');
		expect(() => selectHunkChanges(original, diff.hunks, [1])).toThrow('变更序号超出范围');
		expect(() => selectHunkChanges(original, diff.hunks, [0.5])).toThrow('变更序号必须是整数');
	});

	it('builds a partial preview that keeps the path, revision and version check', () => {
		const original = NUMBERED.join('\n');
		const proposed = twoChanges().join('\n');
		const preview = fullReplacePreview('笔记.md', original, proposed);
		const diff = buildTextDiff(original, proposed);

		const partial = buildHunkSelectionPreview(preview, diff, [0]);

		expect(partial.path).toBe('笔记.md');
		expect(partial.expectedRevision).toBe(preview.expectedRevision);
		expect(partial.originalContent).toBe(original);
		expect(partial.proposedContent.split('\n')[1]).toBe('开头改写');
		expect(partial.proposedContent.split('\n')[27]).toBe('第 28 行');
		expect(partial.reason).toContain('只写回选中的 1 处变更（共 2 处）');
	});

	it('keeps the original proposal when every hunk stays selected', () => {
		const original = NUMBERED.join('\n');
		const proposed = twoChanges().join('\n');
		const preview = fullReplacePreview('笔记.md', original, proposed);
		const diff = buildTextDiff(original, proposed);

		const partial = buildHunkSelectionPreview(preview, diff, [0, 1]);

		expect(partial.proposedContent).toBe(preview.proposedContent);
		expect(partial.reason).toBe(preview.reason);
	});

	it('refuses to select hunks from a truncated diff', () => {
		const original = Array.from({ length: 200 }, (_, index) => `旧 ${index}`).join('\n');
		const proposed = Array.from({ length: 200 }, (_, index) => `新 ${index}`).join('\n');
		const preview = fullReplacePreview('笔记.md', original, proposed);
		const diff = buildTextDiff(original, proposed, { maxDiffLines: 10 });

		expect(diff.truncated).toBe(true);
		expect(() => buildHunkSelectionPreview(preview, diff, [0])).toThrow('差异过长');
	});
});
