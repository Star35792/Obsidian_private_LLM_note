import { describe, expect, it } from 'vitest';
import { buildOrganizeWriteChoices } from '../src/changes/organize-write';
import { contentRevision } from '../src/changes/change-plan';
import { locateSelection } from '../src/changes/selection-target';

const NOTE = '# 想法\n\n注意力预算需要重新分配。\n\n先做索引。\n';
const MARKDOWN = '## 概括\n\n- 需要重新分配注意力预算\n';

describe('buildOrganizeWriteChoices', () => {
	it('offers only the append choice when there is no selection', () => {
		const choices = buildOrganizeWriteChoices({ path: '想法.md', content: NOTE }, MARKDOWN);

		expect(choices).toHaveLength(1);
		expect(choices[0]?.id).toBe('append');
		expect(choices[0]?.preview.proposedContent).toBe(`${NOTE}\n\n${MARKDOWN}`);
		expect(choices[0]?.preview.reason).toContain('追加');
		expect(choices[0]?.preview.originalContent).toBe(NOTE);
	});

	it('puts replacing the selection first when a selection exists', () => {
		const target = locateSelection(NOTE, '注意力预算需要重新分配。');

		const choices = buildOrganizeWriteChoices({ path: '想法.md', content: NOTE }, MARKDOWN, target);

		expect(choices.map((choice) => choice.id)).toEqual(['replace-selection', 'append']);
		expect(choices[0]?.label).toBe('替换选区');
		expect(choices[0]?.preview.reason).toContain('选区');
	});

	it('replaces exactly the selected characters and leaves the rest untouched', () => {
		const target = locateSelection(NOTE, '注意力预算需要重新分配。');

		const [replace] = buildOrganizeWriteChoices({ path: '想法.md', content: NOTE }, MARKDOWN, target);

		expect(replace?.preview.proposedContent).toBe(`# 想法\n\n${MARKDOWN}\n\n先做索引。\n`);
		expect(replace?.preview.changes).toEqual([{ from: target.from, to: target.to, text: MARKDOWN }]);
	});

	it('keeps a CRLF selection range intact outside the selection', () => {
		const content = '第一行\r\n第二行\r\n第三行\r\n';
		const target = locateSelection(content, '第二行\n');

		const [replace] = buildOrganizeWriteChoices({ path: '想法.md', content }, '新内容\r\n', target);

		expect(replace?.preview.proposedContent).toBe('第一行\r\n新内容\r\n第三行\r\n');
	});

	it('shares one expected revision so both choices go through the same version check', () => {
		const target = locateSelection(NOTE, '先做索引。');

		const choices = buildOrganizeWriteChoices({ path: '想法.md', content: NOTE }, MARKDOWN, target);

		for (const choice of choices) {
			expect(choice.preview.path).toBe('想法.md');
			expect(choice.preview.expectedRevision).toBe(contentRevision(NOTE));
		}
	});

	it('rejects an empty organize result', () => {
		expect(() => buildOrganizeWriteChoices({ path: '想法.md', content: NOTE }, '   '))
			.toThrow('整理结果为空');
	});

	it('rejects a selection range that no longer fits the note', () => {
		expect(() => buildOrganizeWriteChoices(
			{ path: '想法.md', content: NOTE },
			MARKDOWN,
			{ from: 0, to: NOTE.length + 5, text: NOTE },
		)).toThrow('变更范围无效');
	});

	it('rejects a selection whose text no longer matches the note', () => {
		expect(() => buildOrganizeWriteChoices(
			{ path: '想法.md', content: NOTE },
			MARKDOWN,
			{ from: 0, to: 3, text: '别的字' },
		)).toThrow('选区内容与已保存的笔记不一致');
	});
});
