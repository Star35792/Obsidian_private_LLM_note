import { describe, expect, it } from 'vitest';
import {
	applyTextChanges,
	buildChangePreview,
	commitChangePreview,
	contentRevision,
	createAppendChange,
	createReplaceChange,
} from '../src/changes/change-plan';

describe('ChangePlan', () => {
	it('appends generated content and records the source revision', () => {
		const source = { path: '思维整理示例.md', content: '# 原始想法\n' };
		const change = createAppendChange(source.content, '\n## 整理草稿\n');
		const preview = buildChangePreview(source, [change], '追加整理草稿');

		expect(preview.expectedRevision).toBe(contentRevision(source.content));
		expect(preview.proposedContent).toBe('# 原始想法\n\n## 整理草稿\n');
	});

	it('replaces only the selected range', () => {
		const source = { path: 'note.md', content: '前文\n旧选区\n后文' };
		const change = createReplaceChange(source.content, 3, 6, '新选区');

		expect(applyTextChanges(source.content, [change])).toBe('前文\n新选区\n后文');
	});

	it('rejects a preview when the source changed after planning', () => {
		const source = { path: 'note.md', content: '原文' };
		const preview = buildChangePreview(source, [createAppendChange(source.content, '\n草稿')], '追加');

		expect(() => commitChangePreview({ ...source, content: '用户刚刚编辑过' }, preview)).toThrow(
			'源笔记已发生变化',
		);
	});

	it('rejects overlapping changes instead of corrupting text', () => {
		expect(() => applyTextChanges('abcdef', [
			createReplaceChange('abcdef', 1, 4, 'x'),
			createReplaceChange('abcdef', 3, 5, 'y'),
		])).toThrow('变更范围重叠');
	});
});
