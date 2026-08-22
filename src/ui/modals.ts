import { App, Modal } from 'obsidian';
import { renderTextDiff } from './diff-view';
import type { OrganizeWriteChoice } from '../changes/organize-write';
import type { LinkBrief } from '../links/link-brief';

export function confirmRemoteSend(app: App, path: string, content: string, scope = '当前笔记全文'): Promise<boolean> {
	return new Promise((resolve) => new RemoteSendModal(app, path, content, scope, resolve).open());
}

export function confirmLinkSend(app: App, path: string, sourceChars: number, briefs: LinkBrief[]): Promise<boolean> {
	return new Promise((resolve) => new LinkSendModal(app, path, sourceChars, briefs, resolve).open());
}

export function confirmAgentStart(app: App, path: string | undefined, request: string): Promise<boolean> {
	return new Promise((resolve) => new AgentStartModal(app, path, request, resolve).open());
}

export function showChangePreview(
	app: App,
	choices: OrganizeWriteChoice[],
	copyText: string,
	onApply: (choice: OrganizeWriteChoice) => Promise<void>,
): void {
	new ChangePreviewModal(app, choices, copyText, onApply).open();
}

class RemoteSendModal extends Modal {
	private readonly path: string;
	private readonly content: string;
	private readonly scopeLabel: string;
	private readonly resolveChoice: (confirmed: boolean) => void;
	private resolved = false;

	constructor(app: App, path: string, content: string, scopeLabel: string, resolveChoice: (confirmed: boolean) => void) {
		super(app);
		this.path = path;
		this.content = content;
		this.scopeLabel = scopeLabel;
		this.resolveChoice = resolveChoice;
	}

	onOpen(): void {
		this.contentEl.createEl('h2', { text: '确认发送笔记内容' });
		this.contentEl.createEl('p', { text: `将发送给远程模型：${this.path}` });
		this.contentEl.createEl('p', { text: `本次发送 ${this.content.length} 个字符，范围是${this.scopeLabel}。` });
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

class LinkSendModal extends Modal {
	private readonly path: string;
	private readonly sourceChars: number;
	private readonly briefs: LinkBrief[];
	private readonly resolveChoice: (confirmed: boolean) => void;
	private resolved = false;

	constructor(
		app: App,
		path: string,
		sourceChars: number,
		briefs: LinkBrief[],
		resolveChoice: (confirmed: boolean) => void,
	) {
		super(app);
		this.path = path;
		this.sourceChars = sourceChars;
		this.briefs = briefs;
		this.resolveChoice = resolveChoice;
	}

	onOpen(): void {
		const excerptChars = this.briefs.reduce((total, brief) => total + brief.excerpt.length, 0);
		this.contentEl.createEl('h2', { text: '确认发送关联判断范围' });
		this.contentEl.createEl('p', { text: `当前笔记：${this.path}（${this.sourceChars} 个字符，全文）` });
		this.contentEl.createEl('p', { text: `候选笔记片段：${this.briefs.length} 篇，共 ${excerptChars} 个字符` });
		const list = this.contentEl.createEl('ul');
		for (const brief of this.briefs) {
			list.createEl('li', { text: `${brief.path}（${brief.excerpt.length} 个字符${brief.truncated ? '，仅开头片段' : ''}）` });
		}
		this.contentEl.createEl('p', { text: '候选由本地元数据筛选，列表以外的笔记不会发送。' });
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

class AgentStartModal extends Modal {
	private readonly path?: string;
	private readonly request: string;
	private readonly resolveChoice: (confirmed: boolean) => void;
	private resolved = false;

	constructor(app: App, path: string | undefined, request: string, resolveChoice: (confirmed: boolean) => void) {
		super(app);
		this.path = path;
		this.request = request;
		this.resolveChoice = resolveChoice;
	}

	onOpen(): void {
		this.contentEl.createEl('h2', { text: '确认开始远程对话' });
		this.contentEl.createEl('p', { text: `首轮仅发送用户请求（${this.request.length} 个字符）和活动笔记路径。` });
		this.contentEl.createEl('p', { text: `活动笔记：${this.path ?? '未打开 Markdown 笔记'}` });
		this.contentEl.createEl('p', { text: '笔记正文不会自动发送；模型按需调用搜索或读取工具，调用过程会显示在侧栏。' });
		const actions = this.contentEl.createDiv({ cls: 'ai-note-assistant-modal-actions' });
		this.addButton(actions, '取消', false);
		this.addButton(actions, '确认开始', true);
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
	private readonly choices: OrganizeWriteChoice[];
	private readonly copyText: string;
	private readonly applyChoice: (choice: OrganizeWriteChoice) => Promise<void>;
	private activeIndex = 0;
	private detail!: HTMLElement;

	constructor(
		app: App,
		choices: OrganizeWriteChoice[],
		copyText: string,
		applyChoice: (choice: OrganizeWriteChoice) => Promise<void>,
	) {
		super(app);
		if (choices.length === 0) throw new Error('没有可写回的方式');
		this.choices = choices;
		this.copyText = copyText;
		this.applyChoice = applyChoice;
	}

	onOpen(): void {
		this.contentEl.createEl('h2', { text: '整理结果预览' });
		if (this.choices.length > 1) this.renderChoicePicker();
		this.detail = this.contentEl.createDiv({ cls: 'ai-note-assistant-preview-detail' });
		this.renderDetail();

		const actions = this.contentEl.createDiv({ cls: 'ai-note-assistant-modal-actions' });
		this.addButton(actions, '取消', () => this.close());
		this.addButton(actions, '复制整理结果', async () => {
			await navigator.clipboard.writeText(this.copyText);
			this.close();
		});
		this.addButton(actions, '确认写回', async () => {
			await this.applyChoice(this.active());
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/** 切换写回方式时重画差异，避免用户看到的是另一种方式的差异。 */
	private renderChoicePicker(): void {
		const picker = this.contentEl.createDiv({ cls: 'ai-note-assistant-preview-choices' });
		picker.createSpan({ text: '写回方式：' });
		this.choices.forEach((choice, index) => {
			const label = picker.createEl('label', { cls: 'ai-note-assistant-preview-choice' });
			const input = label.createEl('input');
			input.type = 'radio';
			input.name = 'ai-note-assistant-write-choice';
			input.checked = index === this.activeIndex;
			input.addEventListener('change', () => {
				if (!input.checked) return;
				this.activeIndex = index;
				this.renderDetail();
			});
			label.createSpan({ text: choice.label });
		});
	}

	private renderDetail(): void {
		const preview = this.active().preview;
		this.detail.empty();
		this.detail.createEl('p', { text: preview.reason });
		renderTextDiff(this.detail, preview.originalContent, preview.proposedContent);
		const fullResult = this.detail.createEl('details', { cls: 'ai-note-assistant-preview-full' });
		fullResult.createEl('summary', { text: '查看写回后的完整内容' });
		fullResult.createEl('pre', { text: preview.proposedContent });
	}

	private active(): OrganizeWriteChoice {
		return this.choices[this.activeIndex]!;
	}

	private addButton(container: HTMLElement, label: string, action: () => void | Promise<void>): void {
		const button = container.createEl('button', { text: label });
		button.type = 'button';
		button.addEventListener('click', () => void action());
	}
}
