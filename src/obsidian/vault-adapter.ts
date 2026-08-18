import { App, TFile } from 'obsidian';
import {
	commitChangePreview,
	contentRevision,
	type ChangePreview,
	type NoteSnapshot,
} from '../changes/change-plan';

export class ObsidianVaultAdapter {
	private readonly app: App;

	constructor(app: App) {
		this.app = app;
	}

	async read(path: string): Promise<NoteSnapshot> {
		const file = this.getMarkdownFile(path);
		return { path: file.path, content: await this.app.vault.read(file) };
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
}
