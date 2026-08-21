export type DiffLineKind = 'context' | 'added' | 'removed';

export interface DiffLine {
	kind: DiffLineKind;
	text: string;
	originalLine?: number;
	proposedLine?: number;
}

export interface DiffHunk {
	header: string;
	originalStart: number;
	originalCount: number;
	proposedStart: number;
	proposedCount: number;
	lines: DiffLine[];
}

export interface TextDiff {
	hunks: DiffHunk[];
	added: number;
	removed: number;
	identical: boolean;
	truncated: boolean;
}

export interface TextDiffOptions {
	/** 变更行前后保留的上下文行数。 */
	contextLines?: number;
	/** 渲染上限；超出的部分会被裁掉并标记 truncated。 */
	maxDiffLines?: number;
	/** 行对齐矩阵的规模上限；超出时退化为整块替换，避免界面卡死。 */
	maxDiffCells?: number;
}

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MAX_DIFF_LINES = 400;
const DEFAULT_MAX_DIFF_CELLS = 1_000_000;

interface DiffWindow {
	lines: DiffLine[];
	originalCursor: number;
	proposedCursor: number;
}

export function formatDiffStats(diff: TextDiff): string {
	if (diff.identical) return '内容没有变化';
	return `新增 ${diff.added} 行，删除 ${diff.removed} 行`;
}

export function buildTextDiff(original: string, proposed: string, options: TextDiffOptions = {}): TextDiff {
	const contextLines = Math.max(0, Math.trunc(options.contextLines ?? DEFAULT_CONTEXT_LINES));
	const maxDiffLines = Math.max(1, Math.trunc(options.maxDiffLines ?? DEFAULT_MAX_DIFF_LINES));
	const maxDiffCells = Math.max(1, Math.trunc(options.maxDiffCells ?? DEFAULT_MAX_DIFF_CELLS));
	const lines = diffLines(original, proposed, maxDiffCells);
	const added = lines.filter((line) => line.kind === 'added').length;
	const removed = lines.filter((line) => line.kind === 'removed').length;

	const hunks: DiffHunk[] = [];
	let truncated = false;
	let budget = maxDiffLines;
	for (const window of collectWindows(lines, contextLines)) {
		if (budget <= 0) {
			truncated = true;
			break;
		}
		if (window.lines.length > budget) {
			hunks.push(buildHunk({ ...window, lines: window.lines.slice(0, budget) }));
			truncated = true;
			break;
		}
		budget -= window.lines.length;
		hunks.push(buildHunk(window));
	}

	return { hunks, added, removed, identical: added === 0 && removed === 0, truncated };
}

export function diffLines(original: string, proposed: string, maxDiffCells = DEFAULT_MAX_DIFF_CELLS): DiffLine[] {
	const originalLines = original.split(/\r?\n/);
	const proposedLines = proposed.split(/\r?\n/);
	const lines: DiffLine[] = [];

	let prefix = 0;
	while (
		prefix < originalLines.length
		&& prefix < proposedLines.length
		&& originalLines[prefix] === proposedLines[prefix]
	) {
		lines.push({ kind: 'context', text: originalLines[prefix]!, originalLine: prefix + 1, proposedLine: prefix + 1 });
		prefix += 1;
	}

	let suffix = 0;
	while (
		suffix < originalLines.length - prefix
		&& suffix < proposedLines.length - prefix
		&& originalLines[originalLines.length - 1 - suffix] === proposedLines[proposedLines.length - 1 - suffix]
	) {
		suffix += 1;
	}

	const originalMiddle = originalLines.slice(prefix, originalLines.length - suffix);
	const proposedMiddle = proposedLines.slice(prefix, proposedLines.length - suffix);
	lines.push(...diffMiddle(originalMiddle, proposedMiddle, prefix, maxDiffCells));

	for (let index = 0; index < suffix; index += 1) {
		const originalIndex = originalLines.length - suffix + index;
		const proposedIndex = proposedLines.length - suffix + index;
		lines.push({
			kind: 'context',
			text: originalLines[originalIndex]!,
			originalLine: originalIndex + 1,
			proposedLine: proposedIndex + 1,
		});
	}

	return orderChangeRuns(lines);
}

function diffMiddle(
	originalMiddle: string[],
	proposedMiddle: string[],
	offset: number,
	maxDiffCells: number,
): DiffLine[] {
	if (originalMiddle.length === 0 && proposedMiddle.length === 0) return [];
	if (
		originalMiddle.length === 0
		|| proposedMiddle.length === 0
		|| originalMiddle.length * proposedMiddle.length > maxDiffCells
	) {
		return [
			...originalMiddle.map((text, index): DiffLine => ({ kind: 'removed', text, originalLine: offset + index + 1 })),
			...proposedMiddle.map((text, index): DiffLine => ({ kind: 'added', text, proposedLine: offset + index + 1 })),
		];
	}

	const columns = proposedMiddle.length + 1;
	const table = new Uint32Array((originalMiddle.length + 1) * columns);
	for (let row = originalMiddle.length - 1; row >= 0; row -= 1) {
		for (let column = proposedMiddle.length - 1; column >= 0; column -= 1) {
			table[row * columns + column] = originalMiddle[row] === proposedMiddle[column]
				? table[(row + 1) * columns + column + 1]! + 1
				: Math.max(table[(row + 1) * columns + column]!, table[row * columns + column + 1]!);
		}
	}

	const lines: DiffLine[] = [];
	let row = 0;
	let column = 0;
	while (row < originalMiddle.length && column < proposedMiddle.length) {
		if (originalMiddle[row] === proposedMiddle[column]) {
			lines.push({
				kind: 'context',
				text: originalMiddle[row]!,
				originalLine: offset + row + 1,
				proposedLine: offset + column + 1,
			});
			row += 1;
			column += 1;
		} else if (table[(row + 1) * columns + column]! >= table[row * columns + column + 1]!) {
			lines.push({ kind: 'removed', text: originalMiddle[row]!, originalLine: offset + row + 1 });
			row += 1;
		} else {
			lines.push({ kind: 'added', text: proposedMiddle[column]!, proposedLine: offset + column + 1 });
			column += 1;
		}
	}
	for (; row < originalMiddle.length; row += 1) {
		lines.push({ kind: 'removed', text: originalMiddle[row]!, originalLine: offset + row + 1 });
	}
	for (; column < proposedMiddle.length; column += 1) {
		lines.push({ kind: 'added', text: proposedMiddle[column]!, proposedLine: offset + column + 1 });
	}
	return lines;
}

/** 同一个变更块内先展示删除行再展示新增行，便于逐行对照。 */
function orderChangeRuns(lines: DiffLine[]): DiffLine[] {
	const ordered: DiffLine[] = [];
	let index = 0;
	while (index < lines.length) {
		if (lines[index]!.kind === 'context') {
			ordered.push(lines[index]!);
			index += 1;
			continue;
		}
		let end = index;
		while (end < lines.length && lines[end]!.kind !== 'context') end += 1;
		const run = lines.slice(index, end);
		ordered.push(
			...run.filter((line) => line.kind === 'removed'),
			...run.filter((line) => line.kind === 'added'),
		);
		index = end;
	}
	return ordered;
}

function collectWindows(lines: DiffLine[], contextLines: number): DiffWindow[] {
	const windows: Array<{ start: number; end: number }> = [];
	for (const [index, line] of lines.entries()) {
		if (line.kind === 'context') continue;
		const start = Math.max(0, index - contextLines);
		const end = Math.min(lines.length - 1, index + contextLines);
		const last = windows[windows.length - 1];
		if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
		else windows.push({ start, end });
	}

	const originalBefore = countBefore(lines, (line) => line.kind !== 'added');
	const proposedBefore = countBefore(lines, (line) => line.kind !== 'removed');
	return windows.map((window) => ({
		lines: lines.slice(window.start, window.end + 1),
		originalCursor: originalBefore[window.start]!,
		proposedCursor: proposedBefore[window.start]!,
	}));
}

function countBefore(lines: DiffLine[], counts: (line: DiffLine) => boolean): number[] {
	const before: number[] = [];
	let total = 0;
	for (const line of lines) {
		before.push(total);
		if (counts(line)) total += 1;
	}
	return before;
}

function buildHunk(window: DiffWindow): DiffHunk {
	const originalCount = window.lines.filter((line) => line.kind !== 'added').length;
	const proposedCount = window.lines.filter((line) => line.kind !== 'removed').length;
	const originalStart = originalCount > 0 ? window.originalCursor + 1 : window.originalCursor;
	const proposedStart = proposedCount > 0 ? window.proposedCursor + 1 : window.proposedCursor;
	return {
		header: `@@ -${originalStart},${originalCount} +${proposedStart},${proposedCount} @@`,
		originalStart,
		originalCount,
		proposedStart,
		proposedCount,
		lines: [...window.lines],
	};
}
