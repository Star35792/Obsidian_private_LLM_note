import { App, MarkdownView, TFile } from 'obsidian';
import { findSearchMatches } from '../agent/vault-tools';
import type {
	VaultNoteRef,
	VaultReadPort,
	VaultSearchResult,
} from '../agent/vault-tools';
import {
	collectLinkContext,
	DEFAULT_LINK_CANDIDATE_LIMIT,
	type LinkContextResult,
	type LinkNote,
} from '../links/link-context';
import {
	commitChangePreview,
	contentRevision,
	type ChangePreview,
	type NoteSnapshot,
} from '../changes/change-plan';

export interface ActiveSelection {
	text: string;
	/** 编辑器给出的起始字符偏移，只作为定位提示。 */
	offsetHint: number;
}

export class ObsidianVaultAdapter implements VaultReadPort {
	private readonly app: App;
	private readonly candidateLimit: () => number;

	constructor(app: App, candidateLimit: () => number = () => DEFAULT_LINK_CANDIDATE_LIMIT) {
		this.app = app;
		this.candidateLimit = candidateLimit;
	}

	async read(path: string): Promise<NoteSnapshot> {
		const file = this.getMarkdownFile(path);
		return { path: file.path, content: await this.app.vault.read(file) };
	}

	async listNotes(scope?: string): Promise<VaultNoteRef[]> {
		const normalizedScope = this.validateScope(scope);
		return this.app.vault.getMarkdownFiles()
			.filter((file) => !normalizedScope || file.path === normalizedScope || file.path.startsWith(`${normalizedScope}/`))
			.map((file) => this.toNoteRef(file));
	}

	async searchNotes(query: string, scope?: string): Promise<VaultSearchResult[]> {
		const normalizedQuery = query.trim().toLocaleLowerCase();
		if (!normalizedQuery) throw new Error('搜索内容不能为空');
		const candidates = await Promise.all((await this.listNotes(scope)).map(async (ref) => {
			const file = this.getMarkdownFile(ref.path);
			const content = await this.app.vault.cachedRead(file);
			const metadataMatches = `${ref.title} ${ref.aliases.join(' ')}`.toLocaleLowerCase().includes(normalizedQuery);
			const matches = findSearchMatches(content, normalizedQuery);
			return metadataMatches || matches.length > 0 ? { ...ref, matches } : undefined;
		}));
		return candidates.filter((ref): ref is VaultSearchResult => ref !== undefined).slice(0, 10);
	}

	async readNote(path: string): Promise<NoteSnapshot> {
		return this.read(path);
	}

	async getLinkContext(path: string, depth: number): Promise<LinkContextResult> {
		const file = this.getMarkdownFile(path);
		const limit = this.candidateLimit();
		return collectLinkContext({
			source: this.toLinkNote(file),
			sourceContent: await this.app.vault.cachedRead(file),
			notes: this.app.vault.getMarkdownFiles().map((candidate) => this.toLinkNote(candidate)),
			links: this.resolvedLinks(),
			unresolvedFromSource: Object.keys(this.app.metadataCache.unresolvedLinks[file.path] ?? {}),
			keywordHits: [],
		}, {
			depth,
			limit: Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LINK_CANDIDATE_LIMIT,
		});
	}

	async update(preview: ChangePreview): Promise<NoteSnapshot> {
		const current = await this.read(preview.path);
		const next = commitChangePreview(current, preview);
		await this.app.vault.modify(this.getMarkdownFile(preview.path), next.content);
		return next;
	}

	async readActive(): Promise<NoteSnapshot> {
		const file = this.app.workspace.getActiveFile();
		if (!file) throw new Error('请先打开一篇 Markdown 笔记');
		return this.read(file.path);
	}

	getActiveNotePath(): string | undefined {
		const file = this.app.workspace.getActiveFile();
		return file instanceof TFile && file.extension === 'md' ? file.path : undefined;
	}

	/**
	 * 编辑器里的选区。偏移只是定位提示：编辑器可能有未保存改动，写回仍以
	 * `vault.read` 的内容为基准，由 `locateSelection` 在已保存正文里重新定位。
	 */
	getActiveSelection(): ActiveSelection | undefined {
		const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
		if (!editor) return undefined;
		const text = editor.getSelection();
		if (text.trim() === '') return undefined;
		return { text, offsetHint: editor.posToOffset(editor.getCursor('from')) };
	}

	getRevision(snapshot: NoteSnapshot): string {
		return contentRevision(snapshot.content);
	}

	private getMarkdownFile(path: string): TFile {
		if (!path || path.startsWith('/') || path.includes('..') || path.includes('\\')) {
			throw new Error('笔记路径必须是 Vault 内的相对路径');
		}
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile) || file.extension !== 'md') throw new Error(`找不到 Markdown 笔记：${path}`);
		return file;
	}

	private validateScope(scope?: string): string | undefined {
		if (scope === undefined || scope.trim() === '') return undefined;
		const normalized = scope.trim();
		if (normalized.startsWith('/') || normalized.includes('\\') || normalized.split('/').some((part) => part === '..')) {
			throw new Error('Vault 范围必须是相对路径');
		}
		return normalized.replace(/\/$/, '');
	}

	private toNoteRef(file: TFile): VaultNoteRef {
		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;
		const rawAliases: unknown = frontmatter?.aliases ?? frontmatter?.alias ?? [];
		const aliases = Array.isArray(rawAliases) ? rawAliases.filter((value): value is string => typeof value === 'string') : typeof rawAliases === 'string' ? [rawAliases] : [];
		return { path: file.path, title: file.basename, aliases };
	}

	private toLinkNote(file: TFile): LinkNote {
		return { ...this.toNoteRef(file), tags: this.collectTags(file) };
	}

	/** Merges inline `#tag` occurrences with frontmatter tags into one `#tag` list. */
	private collectTags(file: TFile): string[] {
		const cache = this.app.metadataCache.getFileCache(file);
		const inline = (cache?.tags ?? []).map((entry) => entry.tag);
		const rawFrontmatter: unknown = cache?.frontmatter?.tags ?? cache?.frontmatter?.tag ?? [];
		const frontmatter = (Array.isArray(rawFrontmatter) ? rawFrontmatter : [rawFrontmatter])
			.filter((value): value is string => typeof value === 'string');
		const tags = [...inline, ...frontmatter]
			.map((tag) => tag.trim())
			.filter(Boolean)
			.map((tag) => (tag.startsWith('#') ? tag : `#${tag}`));
		return [...new Set(tags)];
	}

	private resolvedLinks(): Record<string, string[]> {
		return Object.fromEntries(Object.entries(this.app.metadataCache.resolvedLinks)
			.map(([from, targets]) => [from, Object.keys(targets)]));
	}
}
