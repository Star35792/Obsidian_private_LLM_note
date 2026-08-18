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
	private statusEl?: HTMLElement;
	private processEl?: HTMLElement;
	private streamEl?: HTMLElement;
	private processSteps: string[] = [];
	private streamedText = '';

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

	setStatus(status: string): void {
		if (this.statusEl) this.statusEl.setText(status);
	}

	beginProcess(): void {
		this.processSteps = [];
		this.streamedText = '';
		this.renderProcess();
	}

	addProcessStep(step: string): void {
		this.processSteps.push(step);
		this.renderProcess();
	}

	appendStreamDelta(delta: string): void {
		this.streamedText += delta;
		if (this.streamEl) this.streamEl.setText(this.streamedText);
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

		const runButton = actionsSection.createEl('button', {
			text: this.mode === 'organize' ? '生成整理预览' : `运行${MODE_LABELS[this.mode]}`,
			cls: 'ai-note-assistant-run mod-cta',
		});
		runButton.type = 'button';
		runButton.addEventListener('click', () => void this.plugin.runMode(this.mode));

		this.statusEl = contentEl.createDiv({ cls: 'ai-note-assistant-status' });
		this.statusEl.setText(this.mode === 'organize'
			? '整理会读取当前笔记，并在发送前显示范围。'
			: `${MODE_LABELS[this.mode]}动作将在后续切片中启用。`);

		const processSection = contentEl.createDiv({ cls: 'ai-note-assistant-section' });
		processSection.createEl('h3', { text: '处理过程' });
		this.processEl = processSection.createDiv({ cls: 'ai-note-assistant-process' });
		processSection.createEl('h3', { text: '模型实时输出' });
		this.streamEl = processSection.createEl('pre', { cls: 'ai-note-assistant-stream' });
		this.renderProcess();
	}

	private renderContext(): void {
		if (!this.contextEl) return;
		const markdownView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		const fileName = this.plugin.app.workspace.getActiveFile()?.path ?? markdownView?.file?.path ?? '尚未打开 Markdown 笔记';
		const selection = markdownView?.editor.getSelection().trim();
		this.contextEl.createDiv({ text: `笔记：${fileName}` });
		this.contextEl.createDiv({
			text: selection ? `选区：${selection.slice(0, 120)}${selection.length > 120 ? '…' : ''}` : '选区：未选择文本，将使用当前笔记。',
		});
	}

	private renderProcess(): void {
		if (this.processEl) {
			this.processEl.empty();
			if (this.processSteps.length === 0) {
				this.processEl.createDiv({ text: '等待开始。' });
			} else {
				for (const step of this.processSteps) this.processEl.createDiv({ text: `• ${step}` });
			}
		}
		if (this.streamEl) this.streamEl.setText(this.streamedText || '模型开始生成后会显示在这里。');
	}
}
