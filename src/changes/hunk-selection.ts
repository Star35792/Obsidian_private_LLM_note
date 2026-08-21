import {
	buildChangePreview,
	createReplaceChange,
	type ChangePreview,
	type TextChange,
} from './change-plan';
import type { DiffHunk, TextDiff } from './text-diff';

interface LineSpan {
	/** 行首字符下标。 */
	start: number;
	/** 行尾字符下标，不含行尾符号。 */
	end: number;
}

/**
 * 把单个 diff hunk 换算成对原文的字符级替换。
 *
 * 换算前逐行核对 hunk 覆盖的原文，行内容不一致就拒绝，避免按过期 diff 写错位置。
 * 新行之间的行尾沿用原文风格（原文含 `\r\n` 时用 `\r\n`）。
 */
export function hunkToTextChange(original: string, hunk: DiffHunk): TextChange {
	const spans = lineSpans(original);
	const eol = detectEol(original);
	const originalLines = hunk.lines.filter((line) => line.kind !== 'added').map((line) => line.text);
	const proposedLines = hunk.lines.filter((line) => line.kind !== 'removed').map((line) => line.text);
	const first = hunk.originalStart;
	const last = first + originalLines.length - 1;

	if (originalLines.length === 0) {
		// 纯插入：originalStart 是插入点之前的原文行数。
		if (first < 0 || first > spans.length) throw new Error('变更位置超出笔记范围');
		if (proposedLines.length === 0) throw new Error('变更内容为空');
		if (first === 0) return createReplaceChange(original, 0, 0, `${proposedLines.join(eol)}${eol}`);
		const insertAt = spans[first - 1]!.end;
		return createReplaceChange(original, insertAt, insertAt, `${eol}${proposedLines.join(eol)}`);
	}

	if (first < 1 || last > spans.length) throw new Error('变更位置超出笔记范围');
	for (const [index, text] of originalLines.entries()) {
		const span = spans[first - 1 + index]!;
		if (original.slice(span.start, span.end) !== text) {
			throw new Error('选中的变更与当前笔记内容不一致，请重新生成预览');
		}
	}

	if (proposedLines.length === 0) {
		// 整行删除必须连带一个行尾，否则会留下空行。
		return last < spans.length
			? createReplaceChange(original, spans[first - 1]!.start, spans[last]!.start, '')
			: createReplaceChange(original, first > 1 ? spans[first - 2]!.end : spans[0]!.start, spans[last - 1]!.end, '');
	}
	return createReplaceChange(original, spans[first - 1]!.start, spans[last - 1]!.end, proposedLines.join(eol));
}

/** 把选中的若干 hunk 换算成互不重叠、按位置排序的变更。 */
export function selectHunkChanges(original: string, hunks: DiffHunk[], selected: number[]): TextChange[] {
	return normalizeSelection(hunks.length, selected).map((index) => hunkToTextChange(original, hunks[index]!));
}

/**
 * 由完整预览和选中的 hunk 生成新的预览：路径与源版本不变，因此写回仍要通过
 * 内容哈希校验；未选中的变更不会出现在结果里。
 */
export function buildHunkSelectionPreview(
	preview: ChangePreview,
	diff: TextDiff,
	selected: number[],
): ChangePreview {
	if (diff.truncated) throw new Error('差异过长，只能整体确认写回，不能逐处选择');
	if (diff.hunks.length === 0) throw new Error('没有可写回的变更');
	const changes = selectHunkChanges(preview.originalContent, diff.hunks, selected);
	const reason = changes.length === diff.hunks.length
		? preview.reason
		: `${preview.reason} 只写回选中的 ${changes.length} 处变更（共 ${diff.hunks.length} 处），其余保持原文。`;
	return buildChangePreview({ path: preview.path, content: preview.originalContent }, changes, reason);
}

function normalizeSelection(total: number, selected: number[]): number[] {
	if (selected.length === 0) throw new Error('请至少选择一处变更');
	const unique = new Set<number>();
	for (const index of selected) {
		if (!Number.isInteger(index)) throw new Error('变更序号必须是整数');
		if (index < 0 || index >= total) throw new Error('变更序号超出范围');
		if (unique.has(index)) throw new Error('变更序号重复');
		unique.add(index);
	}
	return [...unique].sort((left, right) => left - right);
}

/** 行切分与 `split(/\r?\n/)` 一致，但保留每行在原文中的字符位置。 */
function lineSpans(content: string): LineSpan[] {
	const spans: LineSpan[] = [];
	let start = 0;
	for (let index = 0; index < content.length; index += 1) {
		if (content[index] !== '\n') continue;
		spans.push({ start, end: index > start && content[index - 1] === '\r' ? index - 1 : index });
		start = index + 1;
	}
	spans.push({ start, end: content.length });
	return spans;
}

function detectEol(content: string): string {
	return content.includes('\r\n') ? '\r\n' : '\n';
}
