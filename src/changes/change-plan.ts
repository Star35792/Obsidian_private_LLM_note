export interface NoteSnapshot {
	path: string;
	content: string;
}

export interface TextChange {
	from: number;
	to: number;
	text: string;
}

export interface ChangePreview {
	id: string;
	path: string;
	reason: string;
	originalContent: string;
	proposedContent: string;
	expectedRevision: string;
	changes: TextChange[];
}

export function contentRevision(content: string): string {
	let hash = 14695981039346656037n;
	for (let index = 0; index < content.length; index += 1) {
		hash ^= BigInt(content.charCodeAt(index));
		hash = BigInt.asUintN(64, hash * 1099511628211n);
	}
	return hash.toString(16).padStart(16, '0');
}

export function createAppendChange(content: string, text: string): TextChange {
	return { from: content.length, to: content.length, text };
}

export function createReplaceChange(content: string, from: number, to: number, text: string): TextChange {
	if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > content.length) {
		throw new Error('变更范围无效');
	}
	return { from, to, text };
}

export function applyTextChanges(content: string, changes: TextChange[]): string {
	const ordered = [...changes].sort((left, right) => left.from - right.from || left.to - right.to);
	let previousTo = 0;
	for (const change of ordered) {
		if (!Number.isInteger(change.from) || !Number.isInteger(change.to) || change.from < 0 || change.to < change.from || change.to > content.length) {
			throw new Error('变更范围无效');
		}
		if (change.from < previousTo) {
			throw new Error('变更范围重叠');
		}
		previousTo = change.to;
	}

	return [...ordered].reverse().reduce(
		(result, change) => result.slice(0, change.from) + change.text + result.slice(change.to),
		content,
	);
}

export function buildChangePreview(
	source: NoteSnapshot,
	changes: TextChange[],
	reason: string,
): ChangePreview {
	return {
		id: `${source.path}:${contentRevision(source.content)}`,
		path: source.path,
		reason,
		originalContent: source.content,
		proposedContent: applyTextChanges(source.content, changes),
		expectedRevision: contentRevision(source.content),
		changes: [...changes],
	};
}

export function commitChangePreview(current: NoteSnapshot, preview: ChangePreview): NoteSnapshot {
	if (contentRevision(current.content) !== preview.expectedRevision) {
		throw new Error('源笔记已发生变化，请重新生成预览');
	}
	return { path: current.path, content: preview.proposedContent };
}
