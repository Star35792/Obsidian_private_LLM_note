import {
	applyCompletion,
	detectCompletion,
	rankCompletionCandidates,
	type CompletionCandidate,
	type CompletionKind,
	type CompletionRequest,
} from './composer-completion';

/**
 * The composer input with the `/` and `@` suggestion panel. It only knows how to
 * detect a trigger, show candidates and write the chosen one back into the text:
 * what the candidates mean is decided by the plugin when the message is
 * submitted, so nothing here reads or sends note content.
 */
export interface ComposerOptions {
	placeholder?: string;
	/** 面板打开时才取候选，避免每次输入都遍历 Vault。 */
	candidates: (kind: CompletionKind) => CompletionCandidate[] | Promise<CompletionCandidate[]>;
	onSubmit: (text: string) => void | Promise<void>;
}

const VISIBLE_CANDIDATE_LIMIT = 12;

export class Composer {
	private readonly options: ComposerOptions;
	private readonly inputEl: HTMLTextAreaElement;
	private readonly panelEl: HTMLElement;
	private readonly sendButton: HTMLButtonElement;
	private readonly loaded = new Map<CompletionKind, CompletionCandidate[]>();
	private request?: CompletionRequest;
	private visible: CompletionCandidate[] = [];
	private activeIndex = 0;
	private loadToken = 0;
	private submitting = false;

	constructor(parent: HTMLElement, options: ComposerOptions) {
		this.options = options;
		const wrapper = parent.createDiv({ cls: 'ai-note-assistant-composer' });
		this.panelEl = wrapper.createDiv({ cls: 'ai-note-assistant-completion' });
		this.panelEl.setAttribute('role', 'listbox');
		this.panelEl.hide();
		this.inputEl = wrapper.createEl('textarea', {
			attr: {
				rows: '3',
				placeholder: options.placeholder ?? '描述你想处理什么；输入 / 唤醒命令与技能，@ 指定笔记或文件夹',
			},
		});
		this.inputEl.addEventListener('keydown', (event) => this.onKeyDown(event));
		this.inputEl.addEventListener('input', () => this.refresh());
		this.inputEl.addEventListener('click', () => this.refresh());
		this.inputEl.addEventListener('blur', () => window.setTimeout(() => this.close(), 120));
		const actions = wrapper.createDiv({ cls: 'ai-note-assistant-composer-actions' });
		actions.createDiv({
			cls: 'ai-note-assistant-composer-hint',
			text: 'Ctrl/Cmd+Enter 发送 · / 命令 · @ 笔记或文件夹',
		});
		this.sendButton = actions.createEl('button', { text: '发送', cls: 'mod-cta' });
		this.sendButton.type = 'button';
		this.sendButton.addEventListener('click', () => void this.submit());
	}

	focus(): void {
		this.inputEl.focus();
	}

	setDisabled(disabled: boolean): void {
		this.inputEl.disabled = disabled;
		this.sendButton.disabled = disabled;
	}

	private onKeyDown(event: KeyboardEvent): void {
		if (event.isComposing) return;
		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			this.close();
			void this.submit();
			return;
		}
		if (!this.request || this.visible.length === 0) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			this.close();
			return;
		}
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const step = event.key === 'ArrowDown' ? 1 : -1;
			this.activeIndex = (this.activeIndex + step + this.visible.length) % this.visible.length;
			this.renderPanel();
			return;
		}
		if (event.key === 'Enter' || event.key === 'Tab') {
			event.preventDefault();
			this.accept(this.activeIndex);
		}
	}

	private refresh(): void {
		const request = detectCompletion(this.inputEl.value, this.inputEl.selectionStart ?? this.inputEl.value.length);
		if (!request) {
			this.close();
			return;
		}
		const sameKind = this.request?.kind === request.kind;
		this.request = request;
		if (!sameKind) this.activeIndex = 0;
		const cached = this.loaded.get(request.kind);
		if (cached) {
			this.show(cached, request);
			return;
		}
		const token = (this.loadToken += 1);
		void Promise.resolve(this.options.candidates(request.kind)).then((candidates) => {
			if (token !== this.loadToken) return;
			this.loaded.set(request.kind, candidates);
			const current = this.request;
			if (current?.kind === request.kind) this.show(candidates, current);
		}).catch(() => this.close());
	}

	private show(candidates: readonly CompletionCandidate[], request: CompletionRequest): void {
		this.visible = rankCompletionCandidates(candidates, request.query, VISIBLE_CANDIDATE_LIMIT);
		if (this.visible.length === 0) {
			this.panelEl.empty();
			this.panelEl.hide();
			return;
		}
		if (this.activeIndex >= this.visible.length) this.activeIndex = 0;
		this.renderPanel();
	}

	private renderPanel(): void {
		this.panelEl.empty();
		this.panelEl.show();
		this.visible.forEach((candidate, index) => {
			const item = this.panelEl.createDiv({
				cls: index === this.activeIndex
					? 'ai-note-assistant-completion-item is-active'
					: 'ai-note-assistant-completion-item',
			});
			item.setAttribute('role', 'option');
			item.setAttribute('aria-selected', String(index === this.activeIndex));
			item.createSpan({ cls: 'ai-note-assistant-completion-label', text: candidate.label });
			if (candidate.description) {
				item.createSpan({ cls: 'ai-note-assistant-completion-description', text: candidate.description });
			}
			// mousedown 而不是 click：click 之前 textarea 已经失焦，面板会先被关掉。
			item.addEventListener('mousedown', (event) => {
				event.preventDefault();
				this.accept(index);
			});
		});
	}

	private accept(index: number): void {
		const request = this.request;
		const candidate = this.visible[index];
		if (!request || !candidate) return;
		const applied = applyCompletion(this.inputEl.value, request, candidate);
		this.inputEl.value = applied.text;
		this.inputEl.setSelectionRange(applied.cursor, applied.cursor);
		this.close();
		this.inputEl.focus();
	}

	private close(): void {
		this.request = undefined;
		this.visible = [];
		this.activeIndex = 0;
		this.loaded.clear();
		this.panelEl.empty();
		this.panelEl.hide();
	}

	private async submit(): Promise<void> {
		const text = this.inputEl.value.trim();
		if (!text || this.submitting) return;
		this.submitting = true;
		this.inputEl.value = '';
		try {
			await this.options.onSubmit(text);
		} finally {
			this.submitting = false;
		}
	}
}
