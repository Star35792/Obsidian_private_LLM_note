import { App, TFile } from 'obsidian';
import { findSearchMatches } from '../agent/vault-tools';
import type {
	VaultNoteRef,
	VaultReadPort,
	VaultSearchResult,
} from '../agent/vault-tools';
import {
	commitChangePreview,
	contentRevision,
	type ChangePreview,
	type NoteSnapshot,
} from '../changes/change-plan';

export class ObsidianVaultAdapter implements VaultReadPort {
	private readonly app: App;

	constructor(app: App) {
		this.app = app;
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

	async getLinkContext(path: string, depth: number): Promise<unknown> {
		const file = this.getMarkdownFile(path);
		const resolvedLinks = this.app.metadataCache.resolvedLinks;
		const outgoing = Object.keys(resolvedLinks[file.path] ?? {}).map((targetPath) => this.toNoteRefByPath(targetPath));
		const incoming = Object.entries(resolvedLinks)
			.filter(([, targets]) => Object.prototype.hasOwnProperty.call(targets, file.path))
			.map(([sourcePath]) => this.toNoteRefByPath(sourcePath));
		return {
			path: file.path,
			depth,
			outgoing: outgoing.filter((ref): ref is VaultNoteRef => ref !== null),
			incoming: incoming.filter((ref): ref is VaultNoteRef => ref !== null),
		};
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

	private toNoteRefByPath(path: string): VaultNoteRef | null {
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile && file.extension === 'md' ? this.toNoteRef(file) : null;
	}
}
