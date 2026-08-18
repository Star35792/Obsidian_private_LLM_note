import { App, Modal } from 'obsidian';
import type { ChangePreview } from '../changes/change-plan';

export function confirmRemoteSend(app: App, path: string, content: string): Promise<boolean> {
	return new Promise((resolve) => new RemoteSendModal(app, path, content, resolve).open());
}

export function showChangePreview(
	app: App,
	preview: ChangePreview,
	onApply: () => Promise<void>,
): void {
	new ChangePreviewModal(app, preview, onApply).open();
}

class RemoteSendModal extends Modal {
	private readonly path: string;
	private readonly content: string;
	private readonly resolveChoice: (confirmed: boolean) => void;
	private resolved = false;

	constructor(app: App, path: string, content: string, resolveChoice: (confirmed: boolean) => void) {
		super(app);
		this.path = path;
		this.content = content;
		this.resolveChoice = resolveChoice;
	}

	onOpen(): void {
		this.contentEl.createEl('h2', { text: '确认发送笔记内容' });
		this.contentEl.createEl('p', { text: `将发送给远程模型：${this.path}` });
		this.contentEl.createEl('p', { text: `本次发送 ${this.content.length} 个字符，仅包含当前笔记内容。` });
		const actions = this.contentEl.createDiv({ cls: 'ai-note-assistant-modal-actions' });
		this.addButton(actions, '取消', false);
		this.addButton(actions, '确认发送', true);
	}

	onClose(): void {
		this.finish(false);
		this.contentEl.empty();
	}

	private addButton(container: HTMLElement, label: string, confirmed: boolean): void {
		const button = container.createEl('button', { text: label, cls: confirmed ? 'mod-cta' : undefined });
		button.type = 'button';
		button.addEventListener('click', () => {
			this.finish(confirmed);
			this.close();
		});
	}

	private finish(confirmed: boolean): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolveChoice(confirmed);
	}
}

class ChangePreviewModal extends Modal {
	private readonly preview: ChangePreview;
	private readonly applyChanges: () => Promise<void>;

	constructor(app: App, preview: ChangePreview, applyChanges: () => Promise<void>) {
		super(app);
		this.preview = preview;
		this.applyChanges = applyChanges;
	}

	onOpen(): void {
		this.contentEl.createEl('h2', { text: '整理结果预览' });
		this.contentEl.createEl('p', { text: this.preview.reason });
		const comparison = this.contentEl.createDiv({ cls: 'ai-note-assistant-preview-grid' });
		const original = comparison.createDiv();
		original.createEl('h3', { text: '原文' });
		original.createEl('pre', { text: this.preview.originalContent });
		const proposed = comparison.createDiv();
		proposed.createEl('h3', { text: '建议结果' });
		proposed.createEl('pre', { text: this.preview.proposedContent });

		const actions = this.contentEl.createDiv({ cls: 'ai-note-assistant-modal-actions' });
		this.addButton(actions, '取消', () => this.close());
		this.addButton(actions, '复制结果', async () => {
			await navigator.clipboard.writeText(this.preview.proposedContent);
			this.close();
		});
		this.addButton(actions, '追加到笔记', async () => {
			await this.applyChanges();
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private addButton(container: HTMLElement, label: string, action: () => void | Promise<void>): void {
		const button = container.createEl('button', { text: label });
		button.type = 'button';
		button.addEventListener('click', () => void action());
	}
}
