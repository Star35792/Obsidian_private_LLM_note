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
import { confirmAgentStart, confirmRemoteSend, showChangePreview } from './ui/modals';
import { AgentLoop, type AgentMessage, type AgentToolCall } from './agent/agent-loop';
import { createVaultReadTools } from './agent/vault-tools';
import { createVaultMutationTools } from './agent/vault-mutation-tools';
import { buildSkillPrompt, createSkillTools, loadSkills } from './agent/skills';
import { SessionRuntime } from './agent/session-runtime';
import { PluginDataStore } from './obsidian/plugin-data-store';

export default class AiNoteAssistantPlugin extends Plugin {
	settings!: AiNoteAssistantSettings;
	private assistant!: NoteAssistant;
	private agentModel!: OpenAiCompatibleAdapter;
	private vaultAdapter!: ObsidianVaultAdapter;
	private pluginData!: PluginDataStore;
	private sessionRuntime!: SessionRuntime;
	private remoteConfirmedThisSession = false;
	private agentConfirmedThisSession = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.sessionRuntime = new SessionRuntime(this.pluginData);
		await this.sessionRuntime.open();
		this.vaultAdapter = new ObsidianVaultAdapter(this.app);
		this.agentModel = new OpenAiCompatibleAdapter(() => this.settings);
		this.assistant = new NoteAssistant(this.agentModel);
		this.registerView(VIEW_TYPE_ASSISTANT, (leaf) => new AssistantView(leaf, this));
		this.addRibbonIcon('brain', '打开思维整理', () => void this.activateView());

		this.addCommand({ id: 'capture-thought', name: '捕捉当前想法', callback: () => this.openMode('capture') });
		this.addCommand({ id: 'organize-current-note', name: '整理当前笔记', callback: () => this.openMode('organize') });
		this.addCommand({ id: 'clarify-current-note', name: '澄清当前想法', callback: () => this.openMode('clarify') });
		this.addCommand({ id: 'challenge-current-thought', name: '挑战当前想法', callback: () => this.openMode('challenge') });
		this.addCommand({ id: 'actionize-current-note', name: '生成下一步', callback: () => this.openMode('actionize') });
		this.addCommand({ id: 'suggest-related-notes', name: '寻找相关笔记', callback: () => this.openMode('related') });
		this.addCommand({ id: 'new-agent-session', name: '新建助手会话', callback: () => void this.startNewSession() });

		this.addSettingTab(new AssistantSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		this.pluginData = new PluginDataStore(await this.loadData(), (value) => this.saveData(value));
		this.settings = Object.assign({}, DEFAULT_SETTINGS, this.pluginData.settings());
	}

	async saveSettings(): Promise<void> {
		await this.pluginData.saveSettings(this.settings);
	}

	getSessionMessages(): AgentMessage[] {
		return this.sessionRuntime.history();
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

	async runAgent(userMessage: string): Promise<void> {
		const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_ASSISTANT)[0]?.view;
		if (!(view instanceof AssistantView)) return;
		if (!userMessage.trim()) return;
		view.beginProcess();
		view.setStatus('正在准备对话…');
		if (!this.settings.remoteModelEnabled) {
			view.setStatus('远程模型已关闭，未发送任何内容。');
			new Notice('请先在设置中开启远程模型。');
			return;
		}

		try {
			const activeNotePath = this.vaultAdapter.getActiveNotePath();
			view.addProcessStep(activeNotePath
				? `已定位活动笔记 ${activeNotePath}，尚未读取正文`
				: '当前没有活动 Markdown 笔记，可通过搜索工具定位笔记');
			if (!this.agentConfirmedThisSession) {
				view.addProcessStep('等待确认本次发送范围');
				const confirmed = await confirmAgentStart(this.app, activeNotePath, userMessage.trim());
				if (!confirmed) {
					view.setStatus('已取消对话，未发送笔记正文。');
					return;
				}
				this.agentConfirmedThisSession = true;
				view.addProcessStep('用户已确认发送请求；笔记正文仍按需读取');
			}

			const skills = await loadSkills(this.vaultAdapter);
			view.addProcessStep(`已加载 ${skills.length} 个 Vault 技能（正文按需读取）`);
			const loop = new AgentLoop(
				this.agentModel,
				[
					...createVaultReadTools(this.vaultAdapter),
					...createSkillTools(skills),
					...createVaultMutationTools(this.vaultAdapter),
				],
				{
					historyLimit: 48,
					systemPrompt: buildSkillPrompt(skills),
					onToolCall: (call) => view.addProcessStep(describeToolCall(call)),
				},
			);
			view.addProcessStep(`正在请求 ${this.settings.modelName}`);
			view.setStatus('模型正在处理对话…');
			const runtimeContext = activeNotePath
				? `运行环境：当前活动笔记路径是 ${activeNotePath}。正文尚未读取；需要时使用 searchNotes 或 readNote。`
				: '运行环境：当前没有活动 Markdown 笔记。需要时使用 listNotes 或 searchNotes 定位笔记。';
			const result = await loop.run(userMessage.trim(), this.sessionRuntime.history(), runtimeContext);
			await this.sessionRuntime.commit(result.messages);
			view.setConversation(result.messages);
			if (result.pendingChangePlan) {
				view.addProcessStep('写工具已转换为待确认预览');
				view.showPendingChangePlan(result.pendingChangePlan, async () => {
					await result.pendingChangePlan?.apply?.();
					new Notice('已按确认计划写回笔记。');
					view.setStatus('写回完成。');
				});
				view.setStatus('已生成写回预览，请确认变更。');
				return;
			}
			view.addProcessStep('对话响应接收完成');
			view.setStatus('对话已完成。');
		} catch (error) {
			const message = error instanceof Error ? error.message : '未知错误';
			new Notice(`对话失败：${message}`);
			view.setStatus(`对话失败：${message}`);
		}
	}

	private async startNewSession(): Promise<void> {
		await this.sessionRuntime.reset();
		const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_ASSISTANT)[0]?.view;
		if (view instanceof AssistantView) {
			view.setConversation([]);
			view.setStatus('已新建会话。');
		}
		new Notice('已新建助手会话。');
	}
}

export type AssistantPlugin = AiNoteAssistantPlugin;

function describeToolCall(call: AgentToolCall): string {
	const arguments_ = isRecord(call.arguments) ? call.arguments : {};
	const path = typeof arguments_.path === 'string' ? arguments_.path : undefined;
	const query = typeof arguments_.query === 'string' ? arguments_.query : undefined;
	const scope = typeof arguments_.scope === 'string' ? arguments_.scope : undefined;
	const name = typeof arguments_.name === 'string' ? arguments_.name : undefined;
	const offset = typeof arguments_.offset === 'number' ? arguments_.offset : undefined;
	if (call.name === 'searchNotes') return `工具：搜索关键词“${query ?? ''}”${scope ? `（范围：${scope}）` : ''}`;
	if (call.name === 'readNote') return `工具：读取笔记 ${path ?? ''}${offset === undefined ? '' : `（从第 ${offset} 行起）`}`;
	if (call.name === 'listNotes') return `工具：列出笔记${scope ? `（范围：${scope}）` : ''}`;
	if (call.name === 'getLinkContext') return `工具：读取链接上下文 ${path ?? ''}`;
	if (call.name === 'useSkill') return `工具：读取技能正文 ${name ?? ''}`;
	if (call.name === 'updateNote') return `工具：生成编辑预览 ${path ?? ''}`;
	if (call.name === 'editNote') return `工具：生成精确编辑预览 ${path ?? ''}`;
	return `工具：${call.name}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
