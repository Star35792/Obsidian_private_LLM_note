export interface SelectionTarget {
	from: number;
	to: number;
	/** 已保存正文里的原样文本，可能与编辑器选区的行尾不同。 */
	text: string;
}

/**
 * 把编辑器选区映射回已保存正文的字符范围。
 *
 * 编辑器里可能有尚未保存的改动，而写回以 `vault.read` 的内容为基准，所以不能
 * 直接相信编辑器给的偏移：偏移处内容一致时按偏移定位，否则退回唯一文本匹配，
 * 文本重复或找不到时拒绝，避免按猜测写到错误位置。
 */
export function locateSelection(content: string, selectedText: string, offsetHint?: number): SelectionTarget {
	if (selectedText.trim() === '') throw new Error('请先选择要整理的内容');
	const hint = Number.isInteger(offsetHint) && (offsetHint as number) >= 0 ? (offsetHint as number) : undefined;
	let ambiguousCount = 0;
	for (const variant of eolVariants(selectedText)) {
		if (hint !== undefined && content.slice(hint, hint + variant.length) === variant) {
			return target(content, hint, variant.length);
		}
		const occurrences = findOccurrences(content, variant);
		if (occurrences.length === 1) return target(content, occurrences[0]!, variant.length);
		ambiguousCount = Math.max(ambiguousCount, occurrences.length);
	}
	if (ambiguousCount > 1) {
		throw new Error(`选区在笔记中出现 ${ambiguousCount} 处，无法确认位置，请先保存笔记或扩大选区后重试`);
	}
	throw new Error('选区内容与已保存的笔记不一致，请先保存笔记后重试');
}

/** 编辑器一般用 `\n`，磁盘上的笔记可能是 `\r\n`，两种行尾都试一遍。 */
function eolVariants(text: string): string[] {
	const lf = text.replace(/\r\n/g, '\n');
	return [...new Set([text, lf.replace(/\n/g, '\r\n'), lf])];
}

function findOccurrences(content: string, variant: string): number[] {
	const found: number[] = [];
	let from = content.indexOf(variant);
	while (from !== -1) {
		found.push(from);
		from = content.indexOf(variant, from + variant.length);
	}
	return found;
}

function target(content: string, from: number, length: number): SelectionTarget {
	return { from, to: from + length, text: content.slice(from, from + length) };
}
