import {
	buildChangePreview,
	createAppendChange,
	createReplaceChange,
	type ChangePreview,
	type NoteSnapshot,
} from './change-plan';
import type { SelectionTarget } from './selection-target';

export type OrganizeWriteChoiceId = 'replace-selection' | 'append';

export interface OrganizeWriteChoice {
	id: OrganizeWriteChoiceId;
	label: string;
	preview: ChangePreview;
}

export const APPEND_REASON = '整理结果默认追加到笔记末尾，原文保留。';

/**
 * 整理结果的可选写回方式。有选区时把「替换选区」放在最前面，但两种方式都只是
 * 预览：`ChangePreview` 记录同一个源版本，写回仍要通过内容哈希校验。
 */
export function buildOrganizeWriteChoices(
	source: NoteSnapshot,
	markdown: string,
	selection?: SelectionTarget,
): OrganizeWriteChoice[] {
	if (markdown.trim() === '') throw new Error('整理结果为空，没有可写回的内容');
	const choices: OrganizeWriteChoice[] = [];
	if (selection) {
		const change = createReplaceChange(source.content, selection.from, selection.to, markdown);
		if (source.content.slice(selection.from, selection.to) !== selection.text) {
			throw new Error('选区内容与已保存的笔记不一致，请重新选择后重试');
		}
		choices.push({
			id: 'replace-selection',
			label: '替换选区',
			preview: buildChangePreview(
				source,
				[change],
				`替换选区：只改写选中的 ${selection.text.length} 个字符，选区之外的内容不变。`,
			),
		});
	}
	choices.push({
		id: 'append',
		label: '追加到笔记末尾',
		preview: buildChangePreview(source, [createAppendChange(source.content, `\n\n${markdown}`)], APPEND_REASON),
	});
	return choices;
}
