import { ItemView, MarkdownView, WorkspaceLeaf } from 'obsidian';
import type AiNoteAssistantPlugin from '../main';

export const VIEW_TYPE_ASSISTANT = 'ai-note-assistant-view';

export type AssistantMode = 'capture' | 'organize' | 'clarify' | 'challenge' | 'actionize' | 'related';

const MODE_LABELS: Record<AssistantMode, string> = {
	capture: '捕捉',
	organize: '整理',
	clarify: '澄清',
	challenge: '挑战',
	actionize: '行动化',
	related: '寻找关联',
};

export class AssistantView extends ItemView {
	private readonly plugin: AiNoteAssistantPlugin;
	mode: AssistantMode = 'organize';
	private contextEl?: HTMLElement;

	constructor(leaf: WorkspaceLeaf, plugin: AiNoteAssistantPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_ASSISTANT;
	}

	getDisplayText(): string {
		return '思维整理';
	}

	getIcon(): string {
		return 'brain';
	}

	onOpen(): Promise<void> {
		this.render();
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		this.contentEl.empty();
		return Promise.resolve();
	}

	setMode(mode: AssistantMode): void {
		this.mode = mode;
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('ai-note-assistant-view');

		const header = contentEl.createDiv({ cls: 'ai-note-assistant-header' });
		header.createEl('h2', { text: '思维整理' });
		header.createEl('p', { text: '保留原意，逐步把想法变成可回看的笔记。', cls: 'ai-note-assistant-subtitle' });

		const contextSection = contentEl.createDiv({ cls: 'ai-note-assistant-section' });
		contextSection.createEl('h3', { text: '当前上下文' });
		this.contextEl = contextSection.createDiv({ cls: 'ai-note-assistant-context' });
		this.renderContext();

		const actionsSection = contentEl.createDiv({ cls: 'ai-note-assistant-section' });
		actionsSection.createEl('h3', { text: '选择动作' });
		const actions = actionsSection.createDiv({ cls: 'ai-note-assistant-actions' });
		(Object.keys(MODE_LABELS) as AssistantMode[]).forEach((mode) => {
			const button = actions.createEl('button', {
				text: MODE_LABELS[mode],
				cls: mode === this.mode ? 'mod-cta' : undefined,
			});
			button.type = 'button';
			button.addEventListener('click', () => this.setMode(mode));
		});

		const status = contentEl.createDiv({ cls: 'ai-note-assistant-status' });
		status.setText(`${MODE_LABELS[this.mode]}动作将在后续切片中启用。当前仅完成插件骨架。`);
	}

	private renderContext(): void {
		if (!this.contextEl) return;
		const markdownView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		const fileName = markdownView?.file?.path ?? '尚未打开 Markdown 笔记';
		const selection = markdownView?.editor.getSelection().trim();
		this.contextEl.createDiv({ text: `笔记：${fileName}` });
		this.contextEl.createDiv({
			text: selection ? `选区：${selection.slice(0, 120)}${selection.length > 120 ? '…' : ''}` : '选区：未选择文本，将使用当前笔记。',
		});
	}
}
