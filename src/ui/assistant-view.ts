import { ItemView, MarkdownView, WorkspaceLeaf } from 'obsidian';
import { renderTextDiff } from './diff-view';
import type AiNoteAssistantPlugin from '../main';
import type { AgentMessage, PendingChangePlan } from '../agent/agent-loop';

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
	mode?: AssistantMode;
	private contextEl?: HTMLElement;
	private statusEl?: HTMLElement;
	private processEl?: HTMLElement;
	private streamEl?: HTMLElement;
	private conversationEl?: HTMLElement;
	private pendingEl?: HTMLElement;
	private inputEl?: HTMLTextAreaElement;
	private processSteps: string[] = [];
	private streamedText = '';
	private conversation: AgentMessage[] = [];
	private submitting = false;

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
		this.conversation = this.plugin.getSessionMessages();
		this.render();
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		this.contentEl.empty();
		return Promise.resolve();
	}

	setMode(mode?: AssistantMode): void {
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

	setConversation(messages: AgentMessage[]): void {
		this.conversation = [...messages];
		this.renderConversation();
	}

	showPendingChangePlan(plan: PendingChangePlan, onConfirm: () => Promise<void>): void {
		if (!this.pendingEl) return;
		this.pendingEl.empty();
		this.pendingEl.addClass('ai-note-assistant-change-card');
		this.pendingEl.createEl('strong', { text: plan.summary });
		for (const change of plan.changes) {
			const item = this.pendingEl.createDiv({ cls: 'ai-note-assistant-change-item' });
			item.createDiv({ text: change.summary });
			if (change.preview) {
				item.createDiv({ text: change.preview.reason, cls: 'ai-note-assistant-change-reason' });
				renderTextDiff(item, change.preview.originalContent, change.preview.proposedContent);
			}
		}
		const actions = this.pendingEl.createDiv({ cls: 'ai-note-assistant-modal-actions' });
		const cancel = actions.createEl('button', { text: '取消' });
		cancel.type = 'button';
		cancel.addEventListener('click', () => {
			this.pendingEl?.empty();
			this.setStatus('已取消写回，笔记未改变。');
		});
		const confirm = actions.createEl('button', { text: '确认写回', cls: 'mod-cta' });
		confirm.type = 'button';
		confirm.disabled = !plan.apply;
		confirm.addEventListener('click', () => {
			confirm.disabled = true;
			cancel.disabled = true;
			void onConfirm().then(() => this.pendingEl?.empty()).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : '未知错误';
				this.setStatus(`写回失败：${message}`);
				confirm.disabled = false;
				cancel.disabled = false;
			});
		});
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
		actionsSection.createEl('h3', { text: '选择动作（可选）' });
		const actions = actionsSection.createDiv({ cls: 'ai-note-assistant-actions' });
		const noModeButton = actions.createEl('button', {
			text: '不选择动作',
			cls: this.mode ? undefined : 'mod-cta',
		});
		noModeButton.type = 'button';
		noModeButton.addEventListener('click', () => this.setMode());
		(Object.keys(MODE_LABELS) as AssistantMode[]).forEach((mode) => {
			const button = actions.createEl('button', {
				text: MODE_LABELS[mode],
				cls: mode === this.mode ? 'mod-cta' : undefined,
			});
			button.type = 'button';
			button.addEventListener('click', () => this.setMode(mode));
		});

		if (this.mode) {
			const runButton = actionsSection.createEl('button', {
				text: this.mode === 'organize' ? '生成整理预览' : `运行${MODE_LABELS[this.mode]}`,
				cls: 'ai-note-assistant-run mod-cta',
			});
			runButton.type = 'button';
			runButton.addEventListener('click', () => void this.plugin.runMode(this.mode));
		}

		const conversationSection = contentEl.createDiv({ cls: 'ai-note-assistant-section' });
		conversationSection.createEl('h3', { text: '对话' });
		this.conversationEl = conversationSection.createDiv({ cls: 'ai-note-assistant-conversation' });
		this.renderConversation();
		const composer = conversationSection.createDiv({ cls: 'ai-note-assistant-composer' });
		this.inputEl = composer.createEl('textarea', { attr: { rows: '3', placeholder: '告诉助手你想处理什么' } });
		this.inputEl.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				void this.submitMessage();
			}
		});
		const sendButton = composer.createEl('button', { text: '发送', cls: 'mod-cta' });
		sendButton.type = 'button';
		sendButton.addEventListener('click', () => void this.submitMessage());

		const planSection = contentEl.createDiv({ cls: 'ai-note-assistant-section' });
		planSection.createEl('h3', { text: '待确认变更' });
		this.pendingEl = planSection.createDiv();

		this.statusEl = contentEl.createDiv({ cls: 'ai-note-assistant-status' });
		this.statusEl.setText(this.mode === 'organize'
			? '整理会读取当前笔记，并在发送前显示范围。'
			: this.mode
				? `${MODE_LABELS[this.mode]}动作将在后续切片中启用。`
				: '未选择动作。你可以直接在对话中描述任务，动作只是可选的快捷入口。');

		const processSection = contentEl.createDiv({ cls: 'ai-note-assistant-section' });
		processSection.createEl('h3', { text: '处理过程' });
		this.processEl = processSection.createDiv({ cls: 'ai-note-assistant-process' });
		processSection.createEl('h3', { text: '模型实时输出' });
		this.streamEl = processSection.createEl('pre', { cls: 'ai-note-assistant-stream' });
		this.renderProcess();
	}

	private async submitMessage(): Promise<void> {
		const message = this.inputEl?.value.trim() ?? '';
		if (!message || this.submitting) return;
		this.submitting = true;
		if (this.inputEl) this.inputEl.value = '';
		try {
			await this.plugin.runAgent(message);
		} finally {
			this.submitting = false;
		}
	}

	private renderConversation(): void {
		if (!this.conversationEl) return;
		this.conversationEl.empty();
		const visible = this.conversation.filter((message) => (
			(message.role === 'user' || message.role === 'assistant') && message.content.trim()
		));
		if (visible.length === 0) {
			this.conversationEl.createDiv({ text: '还没有对话。' });
			return;
		}
		for (const message of visible) {
			const item = this.conversationEl.createDiv({ cls: `ai-note-assistant-message ai-note-assistant-message-${message.role}` });
			item.createEl('strong', { text: message.role === 'user' ? '你' : '助手' });
			item.createDiv({ text: message.content });
		}
	}

	private renderContext(): void {
		if (!this.contextEl) return;
		const markdownView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		const fileName = this.plugin.app.workspace.getActiveFile()?.path ?? markdownView?.file?.path ?? '尚未打开 Markdown 笔记';
		const selection = markdownView?.editor.getSelection().trim();
		this.contextEl.createDiv({ text: `笔记：${fileName}` });
		this.contextEl.createDiv({
			text: selection
				? `选区：已选择 ${selection.length} 个字符，不会自动发送`
				: '正文不会自动发送；助手会按需搜索或读取笔记。',
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
