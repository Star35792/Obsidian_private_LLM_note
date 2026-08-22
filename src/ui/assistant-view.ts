import { ItemView, MarkdownView, WorkspaceLeaf } from 'obsidian';
import { renderSelectableTextDiff, renderTextDiff } from './diff-view';
import { Composer } from './composer';
import {
	CONFIDENCE_LABELS,
	RELATION_LABELS,
	type LinkSuggestion,
	type LinkSuggestionResult,
} from '../links/link-suggestion';
import type AiNoteAssistantPlugin from '../main';
import type { AgentMessage, PendingChangePlan, PlannedChange } from '../agent/agent-loop';
import type { ChangePreview } from '../changes/change-plan';
import type { TextDiff } from '../changes/text-diff';

export const VIEW_TYPE_ASSISTANT = 'ai-note-assistant-view';

/** 一处变更中用户实际勾选要写回的 hunk；`selectedHunks` 为空表示这处不写回。 */
export interface PendingChangeSelection {
	change: PlannedChange;
	preview: ChangePreview;
	diff: TextDiff;
	selectedHunks: number[];
	totalHunks: number;
}

export type AssistantMode = 'capture' | 'organize' | 'clarify' | 'challenge' | 'actionize' | 'related';

const DEFAULT_STATUS = '输入 / 唤醒命令与技能，输入 @ 指定要读或要改的笔记与文件夹；正文仍按需读取。';

export class AssistantView extends ItemView {
	private readonly plugin: AiNoteAssistantPlugin;
	private contextEl?: HTMLElement;
	private statusEl?: HTMLElement;
	private processEl?: HTMLElement;
	private streamEl?: HTMLElement;
	private conversationEl?: HTMLElement;
	private pendingEl?: HTMLElement;
	private composer?: Composer;
	private processSteps: string[] = [];
	private streamedText = '';
	private conversation: AgentMessage[] = [];

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

	setStatus(status: string): void {
		if (this.statusEl) this.statusEl.setText(status);
	}

	/** 运行期间禁用输入，避免同一轮里重复提交。 */
	setBusy(busy: boolean): void {
		this.composer?.setDisabled(busy);
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

	/** 重试同一请求前丢弃上一次尝试的增量，否则两次输出会拼在一起。 */
	resetStream(): void {
		this.streamedText = '';
		this.renderProcess();
	}

	setConversation(messages: AgentMessage[]): void {
		this.conversation = [...messages];
		this.renderConversation();
	}

	showPendingChangePlan(plan: PendingChangePlan, onConfirm: (selections: PendingChangeSelection[]) => Promise<void>): void {
		if (!this.pendingEl) return;
		this.pendingEl.empty();
		this.pendingEl.addClass('ai-note-assistant-change-card');
		this.pendingEl.createEl('strong', { text: plan.summary });
		// 逐处勾选要求每处变更都带预览和自己的写回方式，否则退回整体确认。
		const perHunk = plan.changes.length > 0
			&& plan.changes.every((change) => change.preview !== undefined && change.applyPreview !== undefined);
		const entries: Array<{ change: PlannedChange; preview: ChangePreview; diff: TextDiff }> = [];
		const selected = new Map<PlannedChange, number[]>();
		let updateConfirm = (): void => {};

		for (const change of plan.changes) {
			const item = this.pendingEl.createDiv({ cls: 'ai-note-assistant-change-item' });
			item.createDiv({ text: change.summary });
			const preview = change.preview;
			if (!preview) continue;
			item.createDiv({ text: preview.reason, cls: 'ai-note-assistant-change-reason' });
			if (!perHunk) {
				renderTextDiff(item, preview.originalContent, preview.proposedContent);
				continue;
			}
			const handle = renderSelectableTextDiff(item, preview.originalContent, preview.proposedContent, {
				onChange: (hunks) => {
					selected.set(change, hunks);
					updateConfirm();
				},
			});
			if (handle.selectable) {
				entries.push({ change, preview, diff: handle.diff });
				selected.set(change, handle.selected());
			}
		}

		const selectable = perHunk && entries.length === plan.changes.length;
		const actions = this.pendingEl.createDiv({ cls: 'ai-note-assistant-modal-actions' });
		const cancel = actions.createEl('button', { text: '取消' });
		cancel.type = 'button';
		cancel.addEventListener('click', () => {
			this.pendingEl?.empty();
			this.setStatus('已取消写回，笔记未改变。');
		});
		const confirm = actions.createEl('button', { text: '确认写回', cls: 'mod-cta' });
		confirm.type = 'button';
		const countSelected = (): number => entries
			.reduce((total, entry) => total + (selected.get(entry.change)?.length ?? 0), 0);
		updateConfirm = () => {
			if (!selectable) return;
			const count = countSelected();
			confirm.setText(count === 0 ? '未选择任何变更' : `确认写回选中的 ${count} 处变更`);
			confirm.disabled = count === 0 || !plan.apply;
		};
		confirm.disabled = !plan.apply;
		updateConfirm();
		confirm.addEventListener('click', () => {
			confirm.disabled = true;
			cancel.disabled = true;
			const selections: PendingChangeSelection[] = selectable
				? entries.map((entry) => ({
					change: entry.change,
					preview: entry.preview,
					diff: entry.diff,
					selectedHunks: selected.get(entry.change) ?? [],
					totalHunks: entry.diff.hunks.length,
				}))
				: [];
			void onConfirm(selections).then(() => this.pendingEl?.empty()).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : '未知错误';
				this.setStatus(`写回失败：${message}`);
				cancel.disabled = false;
				updateConfirm();
				if (!selectable) confirm.disabled = false;
			});
		});
	}

	/**
	 * Every suggestion is confirmed on its own: each accept re-reads the note and
	 * re-locates the anchor, so accepting one never silently applies another.
	 */
	showLinkSuggestions(result: LinkSuggestionResult, onAccept: (suggestion: LinkSuggestion) => Promise<void>): void {
		if (!this.pendingEl) return;
		this.pendingEl.empty();
		this.pendingEl.addClass('ai-note-assistant-change-card');
		this.pendingEl.createEl('strong', {
			text: result.suggestions.length === 0
				? '没有可写回的双链建议。'
				: `${result.suggestions.length} 条双链建议，逐条确认后写回。`,
		});
		if (result.hasMore) {
			this.pendingEl.createDiv({
				cls: 'ai-note-assistant-change-reason',
				text: `模型给出 ${result.total} 条有效建议，按设置只展示前 ${result.suggestions.length} 条。`,
			});
		}
		for (const suggestion of result.suggestions) this.renderLinkSuggestion(suggestion, onAccept);
		if (result.rejected.length > 0) {
			const rejected = this.pendingEl.createEl('details', { cls: 'ai-note-assistant-preview-full' });
			rejected.createEl('summary', { text: `未采用 ${result.rejected.length} 条建议` });
			for (const item of result.rejected) {
				rejected.createDiv({ text: `• ${item.targetPath ?? '未知目标'}：${item.reason}` });
			}
		}
		const actions = this.pendingEl.createDiv({ cls: 'ai-note-assistant-modal-actions' });
		const dismiss = actions.createEl('button', { text: '全部忽略' });
		dismiss.type = 'button';
		dismiss.addEventListener('click', () => {
			this.pendingEl?.empty();
			this.setStatus('已忽略全部双链建议，笔记未改变。');
		});
	}

	private renderLinkSuggestion(suggestion: LinkSuggestion, onAccept: (suggestion: LinkSuggestion) => Promise<void>): void {
		if (!this.pendingEl) return;
		const item = this.pendingEl.createDiv({ cls: 'ai-note-assistant-change-item' });
		item.createEl('strong', {
			text: `指向「${suggestion.targetTitle}」·${RELATION_LABELS[suggestion.relation]}·${CONFIDENCE_LABELS[suggestion.confidence]}`,
		});
		item.createDiv({ text: suggestion.reason, cls: 'ai-note-assistant-change-reason' });
		if (suggestion.evidence) {
			item.createDiv({ text: `依据：${suggestion.evidence}`, cls: 'ai-note-assistant-suggestion-evidence' });
		}
		item.createDiv({
			text: suggestion.mode === 'wrap' ? '只给原文中的词加链接' : '在原句之后追加一句带链接的说明',
			cls: 'ai-note-assistant-suggestion-evidence',
		});
		renderTextDiff(item, suggestion.anchor, suggestion.anchorWithLink);

		const actions = item.createDiv({ cls: 'ai-note-assistant-modal-actions' });
		const skip = actions.createEl('button', { text: '忽略这条' });
		skip.type = 'button';
		skip.addEventListener('click', () => item.remove());
		const accept = actions.createEl('button', { text: '接受并写回', cls: 'mod-cta' });
		accept.type = 'button';
		accept.addEventListener('click', () => {
			accept.disabled = true;
			skip.disabled = true;
			void onAccept(suggestion).then(() => {
				actions.remove();
				item.createDiv({ text: `已写回 [[${suggestion.linkTarget}]]`, cls: 'ai-note-assistant-diff-note' });
			}).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : '未知错误';
				item.createDiv({ text: `写回失败：${message}`, cls: 'ai-note-assistant-suggestion-error' });
				accept.disabled = false;
				skip.disabled = false;
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

		const conversationSection = contentEl.createDiv({ cls: 'ai-note-assistant-section' });
		conversationSection.createEl('h3', { text: '对话' });
		this.conversationEl = conversationSection.createDiv({ cls: 'ai-note-assistant-conversation' });
		this.renderConversation();
		this.composer = new Composer(conversationSection, {
			candidates: (kind) => this.plugin.completionCandidates(kind),
			onSubmit: (text) => this.plugin.submitPrompt(text),
		});

		const planSection = contentEl.createDiv({ cls: 'ai-note-assistant-section' });
		planSection.createEl('h3', { text: '待确认变更' });
		this.pendingEl = planSection.createDiv();

		this.statusEl = contentEl.createDiv({ cls: 'ai-note-assistant-status' });
		this.statusEl.setText(DEFAULT_STATUS);

		const processSection = contentEl.createDiv({ cls: 'ai-note-assistant-section' });
		processSection.createEl('h3', { text: '处理过程' });
		this.processEl = processSection.createDiv({ cls: 'ai-note-assistant-process' });
		processSection.createEl('h3', { text: '模型实时输出' });
		this.streamEl = processSection.createEl('pre', { cls: 'ai-note-assistant-stream' });
		this.renderProcess();
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
