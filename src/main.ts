import { MarkdownView, Notice, Plugin } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	AiNoteAssistantSettings,
	AssistantSettingTab,
} from './settings';
import { AssistantView, VIEW_TYPE_ASSISTANT } from './ui/assistant-view';
import { createAppendChange, buildChangePreview } from './changes/change-plan';
import { NoteAssistant } from './core/note-assistant';
import { OpenAiCompatibleAdapter } from './model/openai-compatible-adapter';
import { ObsidianVaultAdapter } from './obsidian/vault-adapter';
import { confirmRemoteSend, showChangePreview } from './ui/modals';

export default class AiNoteAssistantPlugin extends Plugin {
	settings!: AiNoteAssistantSettings;
	private assistant!: NoteAssistant;
	private vaultAdapter!: ObsidianVaultAdapter;
	private remoteConfirmedThisSession = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.vaultAdapter = new ObsidianVaultAdapter(this.app);
		this.assistant = new NoteAssistant(new OpenAiCompatibleAdapter(() => this.settings));
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

	async runMode(mode: AssistantView['mode']): Promise<void> {
		const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_ASSISTANT)[0]?.view;
		if (view instanceof AssistantView) {
			view.beginProcess();
			view.setStatus('正在读取当前笔记…');
		}
		if (mode !== 'organize') {
			new Notice('该动作将在后续切片中启用。当前可用动作是“整理”。');
			if (view instanceof AssistantView) view.setStatus('当前可用动作是“整理”。');
			return;
		}
		if (!this.settings.remoteModelEnabled) {
			new Notice('请先在设置中开启远程模型。');
			if (view instanceof AssistantView) view.setStatus('远程模型已关闭，未发送任何内容。');
			return;
		}

		try {
			const source = await this.vaultAdapter.readActive();
			if (view instanceof AssistantView) view.addProcessStep(`已读取 ${source.path}（${source.content.length} 个字符）`);
			if (!this.remoteConfirmedThisSession) {
				if (view instanceof AssistantView) view.addProcessStep('等待确认本次发送范围');
				const confirmed = await confirmRemoteSend(this.app, source.path, source.content);
				if (!confirmed) {
					if (view instanceof AssistantView) view.setStatus('已取消发送，原笔记未改变。');
					return;
				}
				this.remoteConfirmedThisSession = true;
				if (view instanceof AssistantView) view.addProcessStep('用户已确认发送当前笔记内容');
			}
			if (view instanceof AssistantView) {
				view.addProcessStep(`正在请求 ${this.settings.modelName}`);
				view.setStatus('模型正在生成结构化草稿…');
			}
			const result = await this.assistant.organize(
				{ content: source.content },
				{ onDelta: (delta) => view instanceof AssistantView && view.appendStreamDelta(delta) },
			);
			if (view instanceof AssistantView) {
				view.addProcessStep(result.streamed ? '流式输出接收完成' : '流式连接不可用，已完成普通响应');
				view.addProcessStep('结构化结果校验通过');
			}
			const preview = buildChangePreview(
				source,
				[createAppendChange(source.content, `\n\n${result.markdown}`)],
				'整理结果默认追加到笔记末尾，原文保留。',
			);
			showChangePreview(this.app, preview, async () => {
				await this.vaultAdapter.update(preview);
				new Notice('整理结果已追加到当前笔记。');
				if (view instanceof AssistantView) view.setStatus('已写回整理结果。');
			});
			if (view instanceof AssistantView) {
				view.addProcessStep('写回预览已生成，原笔记尚未修改');
				view.setStatus('已生成预览，请确认写回方式。');
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : '未知错误';
			new Notice(`整理失败：${message}`);
			if (view instanceof AssistantView) view.setStatus(`整理失败：${message}`);
		}
	}
}

export type AssistantPlugin = AiNoteAssistantPlugin;
