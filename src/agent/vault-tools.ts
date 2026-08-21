import type { ReadOnlyAgentTool } from './agent-loop';

export interface VaultNoteRef {
	path: string;
	title: string;
	aliases: string[];
}

export interface VaultNoteSnapshot {
	path: string;
	content: string;
}

export interface VaultSearchMatch {
	line: number;
	excerpt: string;
}

export interface VaultSearchResult extends VaultNoteRef {
	matches: VaultSearchMatch[];
}

export function findSearchMatches(content: string, query: string): VaultSearchMatch[] {
	const normalizedQuery = query.trim().toLocaleLowerCase();
	if (!normalizedQuery) return [];
	const matches: VaultSearchMatch[] = [];
	for (const [index, line] of content.split(/\r?\n/).entries()) {
		if (!line.toLocaleLowerCase().includes(normalizedQuery)) continue;
		matches.push({ line: index + 1, excerpt: truncateExcerpt(line.trim()) });
		if (matches.length === 3) break;
	}
	return matches;
}

export interface VaultReadPort {
	listNotes(scope?: string): Promise<VaultNoteRef[]>;
	searchNotes(query: string, scope?: string): Promise<VaultSearchResult[]>;
	readNote(path: string): Promise<VaultNoteSnapshot>;
	getLinkContext(path: string, depth: number): Promise<unknown>;
}

export interface NoteWindowOptions {
	offset?: number;
	limit?: number;
	maxChars?: number;
}

export interface NoteWindow {
	content: string;
	startLine: number;
	endLine: number;
	totalLines: number;
	hasMore: boolean;
	nextOffset?: number;
	lineTruncated?: boolean;
}

export const DEFAULT_NOTE_WINDOW_LINES = 400;
export const MAX_NOTE_WINDOW_LINES = 2000;
export const DEFAULT_NOTE_WINDOW_CHARS = 12_000;
const MAX_LIST_NOTES = 100;

/**
 * Returns a bounded line window as a verbatim substring of the source. Slicing
 * by offset instead of splitting and rejoining keeps the original line endings,
 * so text taken from a window still matches exactly in `editNote`.
 */
export function readNoteWindow(content: string, options: NoteWindowOptions = {}): NoteWindow {
	const limit = options.limit ?? DEFAULT_NOTE_WINDOW_LINES;
	const maxChars = options.maxChars ?? DEFAULT_NOTE_WINDOW_CHARS;
	const offset = options.offset ?? 1;
	if (!Number.isInteger(offset) || offset < 1) throw new Error('工具参数 offset 必须是从 1 开始的整数');
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_NOTE_WINDOW_LINES) {
		throw new Error(`工具参数 limit 必须是 1 到 ${MAX_NOTE_WINDOW_LINES} 之间的整数`);
	}
	if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('窗口字符上限必须是正整数');

	const lines = measureLines(content);
	const totalLines = lines.length;
	if (offset > totalLines) {
		return { content: '', startLine: offset, endLine: offset - 1, totalLines, hasMore: false };
	}

	const start = lines[offset - 1]!.start;
	const lastAllowed = Math.min(offset + limit - 1, totalLines);
	let endLine = offset - 1;
	for (let line = offset; line <= lastAllowed; line += 1) {
		if (lines[line - 1]!.end - start > maxChars) break;
		endLine = line;
	}

	if (endLine < offset) {
		return {
			content: content.slice(start, start + maxChars),
			startLine: offset,
			endLine: offset,
			totalLines,
			hasMore: true,
			nextOffset: offset + 1,
			lineTruncated: true,
		};
	}

	const hasMore = endLine < totalLines;
	return {
		content: content.slice(start, lines[endLine - 1]!.end),
		startLine: offset,
		endLine,
		totalLines,
		hasMore,
		...(hasMore ? { nextOffset: endLine + 1 } : {}),
	};
}

function measureLines(content: string): Array<{ start: number; end: number }> {
	const lines: Array<{ start: number; end: number }> = [];
	let start = 0;
	for (let index = 0; index < content.length; index += 1) {
		if (content[index] !== '\n') continue;
		const end = index > start && content[index - 1] === '\r' ? index - 1 : index;
		lines.push({ start, end });
		start = index + 1;
	}
	lines.push({ start, end: content.length });
	return lines;
}

export function createVaultReadTools(vault: VaultReadPort): ReadOnlyAgentTool[] {
	return [
		{
			kind: 'read-only',
			name: 'listNotes',
			description: `列出 Vault 范围内的 Markdown 笔记，最多返回 ${MAX_LIST_NOTES} 篇。笔记较多时用 scope 收窄目录，或改用 searchNotes 定位。`,
			inputSchema: {
				type: 'object',
				properties: {
					scope: { type: 'string' },
					limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_NOTES },
				},
			},
			execute: async (arguments_) => {
				const limit = readLimit(arguments_, MAX_LIST_NOTES);
				const notes = await vault.listNotes(readOptionalScope(arguments_));
				return {
					total: notes.length,
					returned: Math.min(notes.length, limit),
					hasMore: notes.length > limit,
					notes: notes.slice(0, limit),
				};
			},
		},
		{
			kind: 'read-only',
			name: 'searchNotes',
			description: '按标题、别名或正文搜索相关笔记，返回少量命中行片段。仅需定位信息时优先使用，不必读取全文。',
			inputSchema: {
				type: 'object',
				required: ['query'],
				properties: { query: { type: 'string' }, scope: { type: 'string' } },
			},
			execute: async (arguments_) => vault.searchNotes(
				readRequiredString(arguments_, 'query'),
				readOptionalScope(arguments_),
			),
		},
		{
			kind: 'read-only',
			name: 'readNote',
			description: `按行窗口读取一篇 Vault 内 Markdown 笔记，默认从第 1 行起最多 ${DEFAULT_NOTE_WINDOW_LINES} 行。仅在任务确实需要理解全文或准备编辑时调用；返回 hasMore 为 true 时用 nextOffset 继续读取。窗口内容与原文逐字一致，可直接用作 editNote 的 old_string。`,
			inputSchema: {
				type: 'object',
				required: ['path'],
				properties: {
					path: { type: 'string' },
					offset: { type: 'integer', minimum: 1 },
					limit: { type: 'integer', minimum: 1, maximum: MAX_NOTE_WINDOW_LINES },
				},
			},
			execute: async (arguments_) => {
				const offset = readOptionalInteger(arguments_, 'offset');
				const limit = readOptionalInteger(arguments_, 'limit');
				const note = await vault.readNote(readVaultPath(arguments_));
				const window = readNoteWindow(note.content, {
					...(offset === undefined ? {} : { offset }),
					...(limit === undefined ? {} : { limit }),
				});
				return { path: note.path, ...window };
			},
		},
		{
			kind: 'read-only',
			name: 'getLinkContext',
			description: '读取一篇笔记的出链、反向链接和本地关联候选。候选来自本地元数据（未加链接的原文提及、反向链接、共享标签，depth 为 2 时还包括共同邻居），每条带 signals 与建议链接文本；源笔记已经链接过的目标不会出现，同名候选会标注 ambiguous 并给出全部路径。',
			inputSchema: {
				type: 'object',
				required: ['path'],
				properties: { path: { type: 'string' }, depth: { type: 'integer', minimum: 1, maximum: 2 } },
			},
			execute: async (arguments_) => vault.getLinkContext(
				readVaultPath(arguments_),
				readDepth(arguments_),
			),
		},
	];
}

function readRequiredString(arguments_: unknown, key: string): string {
	const value = readOptionalString(arguments_, key);
	if (!value) throw new Error(`工具参数 ${key} 必须是非空字符串`);
	return value;
}

function readVaultPath(arguments_: unknown): string {
	const path = readRequiredString(arguments_, 'path');
	if (path.startsWith('/') || path.includes('\\') || path.split('/').some((segment) => segment === '..')) {
		throw new Error('笔记路径必须是 Vault 内的相对路径');
	}
	return path;
}

function readOptionalScope(arguments_: unknown): string | undefined {
	const scope = readOptionalString(arguments_, 'scope');
	if (scope === undefined) return undefined;
	if (scope.startsWith('/') || scope.includes('\\') || scope.split('/').some((segment) => segment === '..')) {
		throw new Error('Vault 范围必须是相对路径');
	}
	return scope.replace(/\/$/, '');
}

function readOptionalString(arguments_: unknown, key: string): string | undefined {
	if (!isRecord(arguments_)) throw new Error('工具参数必须是 JSON 对象');
	const value = arguments_[key];
	if (value === undefined) return undefined;
	if (typeof value !== 'string') throw new Error(`工具参数 ${key} 必须是字符串`);
	return value.trim() || undefined;
}

function readDepth(arguments_: unknown): number {
	if (!isRecord(arguments_)) throw new Error('工具参数必须是 JSON 对象');
	const value = arguments_.depth;
	if (value === undefined) return 1;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2) {
		throw new Error('工具参数 depth 必须是 1 或 2');
	}
	return value;
}

function readOptionalInteger(arguments_: unknown, key: string): number | undefined {
	if (!isRecord(arguments_)) throw new Error('工具参数必须是 JSON 对象');
	const value = arguments_[key];
	if (value === undefined) return undefined;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
		throw new Error(`工具参数 ${key} 必须是从 1 开始的整数`);
	}
	return value;
}

function readLimit(arguments_: unknown, maximum: number): number {
	const limit = readOptionalInteger(arguments_, 'limit');
	if (limit === undefined) return maximum;
	if (limit > maximum) throw new Error(`工具参数 limit 不能超过 ${maximum}`);
	return limit;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncateExcerpt(value: string): string {
	return value.length > 240 ? `${value.slice(0, 239)}…` : value;
}
