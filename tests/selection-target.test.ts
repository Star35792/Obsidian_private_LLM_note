import { describe, expect, it } from 'vitest';
import { locateSelection } from '../src/changes/selection-target';

const NOTE = '# 想法\n\n注意力预算需要重新分配。\n\n先做索引，再谈注意力预算需要重新分配。\n';

describe('locateSelection', () => {
	it('uses the editor offset when the saved content matches there', () => {
		const from = NOTE.indexOf('注意力预算需要重新分配。');
		const target = locateSelection(NOTE, '注意力预算需要重新分配。', from);

		expect(target).toEqual({ from, to: from + '注意力预算需要重新分配。'.length, text: '注意力预算需要重新分配。' });
	});

	it('falls back to the only occurrence when the offset is stale', () => {
		const content = '第一行\n第二行\n第三行\n';

		const target = locateSelection(content, '第二行', 0);

		expect(target.from).toBe(content.indexOf('第二行'));
		expect(content.slice(target.from, target.to)).toBe('第二行');
	});

	it('falls back to the only occurrence when the offset is out of range', () => {
		const content = '第一行\n第二行\n';

		const target = locateSelection(content, '第二行', 999);

		expect(target.from).toBe(content.indexOf('第二行'));
	});

	it('keeps the second occurrence when the offset points at it', () => {
		const second = NOTE.lastIndexOf('注意力预算需要重新分配。');

		const target = locateSelection(NOTE, '注意力预算需要重新分配。', second);

		expect(target.from).toBe(second);
	});

	it('locates an LF selection inside CRLF content and returns the saved range', () => {
		const content = '第一行\r\n第二行\r\n第三行\r\n';

		const target = locateSelection(content, '第二行\n第三行', 0);

		expect(content.slice(target.from, target.to)).toBe('第二行\r\n第三行');
		expect(target.text).toBe('第二行\r\n第三行');
	});

	it('rejects a repeated selection when the offset does not match', () => {
		expect(() => locateSelection(NOTE, '注意力预算需要重新分配。', 0))
			.toThrow('选区在笔记中出现 2 处');
	});

	it('rejects a selection that is not in the saved content', () => {
		expect(() => locateSelection(NOTE, '还没有保存的新句子。', 0))
			.toThrow('选区内容与已保存的笔记不一致');
	});

	it('rejects an empty or whitespace-only selection', () => {
		expect(() => locateSelection(NOTE, '   \n', 0)).toThrow('请先选择要整理的内容');
		expect(() => locateSelection(NOTE, '', 0)).toThrow('请先选择要整理的内容');
	});

	it('works without an offset hint', () => {
		const content = '第一行\n第二行\n';

		expect(locateSelection(content, '第二行').from).toBe(content.indexOf('第二行'));
	});
});
