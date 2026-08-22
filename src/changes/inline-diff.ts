import type { DiffLine } from './text-diff';

export interface InlineSegment {
	text: string;
	changed: boolean;
}

export interface InlinePair {
	removed: InlineSegment[];
	added: InlineSegment[];
}

export interface InlineDiffOptions {
	/** 字符对齐矩阵的规模上限；超出时中间整段算变更，不做 LCS，避免长行拖慢渲染。 */
	maxInlineCells?: number;
	/** 相似度下限：公共字符占较长一行的比例低于它就不做行内标注。 */
	minSimilarity?: number;
}

const DEFAULT_MAX_INLINE_CELLS = 40_000;
const DEFAULT_MIN_SIMILARITY = 0.3;

interface MiddleAlignment {
	removed: InlineSegment[];
	added: InlineSegment[];
	common: number;
}

/**
 * 一对删除行和新增行的字符级差异，只用于展示。
 *
 * 两行相似度太低时返回 undefined，让界面按整行新增/删除展示，
 * 因为把无关的两行强行对齐只会得到一堆碎片，反而看不清改了什么。
 */
export function buildInlineDiff(
	removedText: string,
	addedText: string,
	options: InlineDiffOptions = {},
): InlinePair | undefined {
	if (removedText === addedText) return undefined;
	const maxInlineCells = Math.max(1, Math.trunc(options.maxInlineCells ?? DEFAULT_MAX_INLINE_CELLS));
	const minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
	// 按码点切分，避免把代理对（emoji）切成半个字符。
	const removedChars = [...removedText];
	const addedChars = [...addedText];
	const longest = Math.max(removedChars.length, addedChars.length);
	if (longest === 0) return undefined;

	let prefix = 0;
	while (
		prefix < removedChars.length
		&& prefix < addedChars.length
		&& removedChars[prefix] === addedChars[prefix]
	) prefix += 1;

	let suffix = 0;
	while (
		suffix < removedChars.length - prefix
		&& suffix < addedChars.length - prefix
		&& removedChars[removedChars.length - 1 - suffix] === addedChars[addedChars.length - 1 - suffix]
	) suffix += 1;

	const middle = alignMiddle(
		removedChars.slice(prefix, removedChars.length - suffix),
		addedChars.slice(prefix, addedChars.length - suffix),
		maxInlineCells,
	);
	if ((prefix + suffix + middle.common) / longest < minSimilarity) return undefined;

	const head: InlineSegment = { text: removedChars.slice(0, prefix).join(''), changed: false };
	const tail: InlineSegment = {
		text: suffix === 0 ? '' : removedChars.slice(removedChars.length - suffix).join(''),
		changed: false,
	};
	return {
		removed: mergeSegments([head, ...middle.removed, tail]),
		added: mergeSegments([head, ...middle.added, tail]),
	};
}

/**
 * 一个 hunk 内每行的字符级标注，键是行在 `lines` 里的下标。
 *
 * 只在同一个变更块内配对：`buildTextDiff` 保证块内删除行在前、新增行在后，
 * 因此按出现顺序一对一配对；配不上的行和上下文行没有标注。
 */
export function buildInlineHunkDiff(
	lines: DiffLine[],
	options: InlineDiffOptions = {},
): Map<number, InlineSegment[]> {
	const inline = new Map<number, InlineSegment[]>();
	let index = 0;
	while (index < lines.length) {
		if (lines[index]!.kind === 'context') {
			index += 1;
			continue;
		}
		let end = index;
		while (end < lines.length && lines[end]!.kind !== 'context') end += 1;
		const removed: number[] = [];
		const added: number[] = [];
		for (let cursor = index; cursor < end; cursor += 1) {
			(lines[cursor]!.kind === 'removed' ? removed : added).push(cursor);
		}
		for (let pair = 0; pair < Math.min(removed.length, added.length); pair += 1) {
			const removedIndex = removed[pair]!;
			const addedIndex = added[pair]!;
			const result = buildInlineDiff(lines[removedIndex]!.text, lines[addedIndex]!.text, options);
			if (!result) continue;
			inline.set(removedIndex, result.removed);
			inline.set(addedIndex, result.added);
		}
		index = end;
	}
	return inline;
}

function alignMiddle(removedMiddle: string[], addedMiddle: string[], maxInlineCells: number): MiddleAlignment {
	if (
		removedMiddle.length === 0
		|| addedMiddle.length === 0
		|| removedMiddle.length * addedMiddle.length > maxInlineCells
	) {
		return {
			removed: [{ text: removedMiddle.join(''), changed: true }],
			added: [{ text: addedMiddle.join(''), changed: true }],
			common: 0,
		};
	}

	const columns = addedMiddle.length + 1;
	const table = new Uint32Array((removedMiddle.length + 1) * columns);
	for (let row = removedMiddle.length - 1; row >= 0; row -= 1) {
		for (let column = addedMiddle.length - 1; column >= 0; column -= 1) {
			table[row * columns + column] = removedMiddle[row] === addedMiddle[column]
				? table[(row + 1) * columns + column + 1]! + 1
				: Math.max(table[(row + 1) * columns + column]!, table[row * columns + column + 1]!);
		}
	}

	const removed: InlineSegment[] = [];
	const added: InlineSegment[] = [];
	let common = 0;
	let row = 0;
	let column = 0;
	while (row < removedMiddle.length && column < addedMiddle.length) {
		if (removedMiddle[row] === addedMiddle[column]) {
			removed.push({ text: removedMiddle[row]!, changed: false });
			added.push({ text: addedMiddle[column]!, changed: false });
			common += 1;
			row += 1;
			column += 1;
		} else if (table[(row + 1) * columns + column]! >= table[row * columns + column + 1]!) {
			removed.push({ text: removedMiddle[row]!, changed: true });
			row += 1;
		} else {
			added.push({ text: addedMiddle[column]!, changed: true });
			column += 1;
		}
	}
	for (; row < removedMiddle.length; row += 1) removed.push({ text: removedMiddle[row]!, changed: true });
	for (; column < addedMiddle.length; column += 1) added.push({ text: addedMiddle[column]!, changed: true });
	return { removed, added, common };
}

function mergeSegments(segments: InlineSegment[]): InlineSegment[] {
	const merged: InlineSegment[] = [];
	for (const segment of segments) {
		if (segment.text === '') continue;
		const last = merged[merged.length - 1];
		if (last && last.changed === segment.changed) last.text += segment.text;
		else merged.push({ ...segment });
	}
	return merged;
}
