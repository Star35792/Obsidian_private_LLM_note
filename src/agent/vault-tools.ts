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

export function createVaultReadTools(vault: VaultReadPort): ReadOnlyAgentTool[] {
	return [
		{
			kind: 'read-only',
			name: 'listNotes',
			description: '列出 Vault 范围内的 Markdown 笔记。',
			inputSchema: {
				type: 'object',
				properties: { scope: { type: 'string' } },
			},
			execute: async (arguments_) => vault.listNotes(readOptionalScope(arguments_)),
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
			description: '读取一篇 Vault 内 Markdown 笔记的完整正文。仅在任务确实需要理解全文或准备编辑时调用。',
			inputSchema: {
				type: 'object',
				required: ['path'],
				properties: { path: { type: 'string' } },
			},
			execute: async (arguments_) => vault.readNote(readVaultPath(arguments_)),
		},
		{
			kind: 'read-only',
			name: 'getLinkContext',
			description: '读取一篇笔记的出链、反向链接和本地关联上下文。',
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncateExcerpt(value: string): string {
	return value.length > 240 ? `${value.slice(0, 239)}…` : value;
}
