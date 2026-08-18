import { MarkdownView, Notice, Plugin } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	AiNoteAssistantSettings,
	AssistantSettingTab,
} from './settings';
import { AssistantView, VIEW_TYPE_ASSISTANT } from './ui/assistant-view';

export default class AiNoteAssistantPlugin extends Plugin {
	settings!: AiNoteAssistantSettings;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.registerView(VIEW_TYPE_ASSISTANT, (leaf) => new AssistantView(leaf, this));
		this.addRibbonIcon('brain', '打开思维整理', () => void this.activateView());

		this.addCommand({ id: 'capture-thought', name: '捕捉当前想法', callback: () => this.openMode('capture') });
		this.addCommand({ id: 'organize-current-note', name: '整理当前笔记', callback: () => this.openMode('organize') });
		this.addCommand({ id: 'clarify-current-note', name: '澄清当前想法', callback: () => this.openMode('clarify') });
		this.addCommand({ id: 'challenge-current-thought', name: '挑战当前想法', callback: () => this.openMode('challenge') });
		this.addCommand({ id: 'actionize-current-note', name: '生成下一步', callback: () => this.openMode('actionize') });
		this.addCommand({ id: 'suggest-related-notes', name: '寻找相关笔记', callback: () => this.openMode('related') });

		this.addSettingTab(new AssistantSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<AiNoteAssistantSettings>);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async activateView(): Promise<void> {
		const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_ASSISTANT)[0];
		if (existingLeaf) {
			await this.app.workspace.revealLeaf(existingLeaf);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf('split');
		await leaf.setViewState({ type: VIEW_TYPE_ASSISTANT, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	private async openMode(mode: AssistantView['mode']): Promise<void> {
		await this.activateView();
		const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_ASSISTANT)[0]?.view;
		if (view instanceof AssistantView) {
			view.setMode(mode);
			return;
		}
		if (!this.app.workspace.getActiveViewOfType(MarkdownView)) {
			new Notice('请先打开一篇 Markdown 笔记。');
		}
	}
}

export type AssistantPlugin = AiNoteAssistantPlugin;
