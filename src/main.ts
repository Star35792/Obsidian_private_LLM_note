import { Notice, Plugin } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	AiNoteAssistantSettings,
	AssistantSettingTab,
} from './settings';
import { AssistantView, VIEW_TYPE_ASSISTANT, type AssistantMode, type PendingChangeSelection } from './ui/assistant-view';
import type { CompletionCandidate, CompletionKind } from './ui/composer-completion';
import {
	buildMentionContext,
	buildSkillContext,
	matchesCommandToken,
	parsePromptInput,
	resolveMentions,
	slugifyCommandName,
	type MentionTargets,
} from './agent/prompt-input';
import { type NoteSnapshot } from './changes/change-plan';
import { buildOrganizeWriteChoices } from './changes/organize-write';
import { locateSelection, type SelectionTarget } from './changes/selection-target';
import { buildHunkSelectionPreview } from './changes/hunk-selection';
import { NoteAssistant } from './core/note-assistant';
import type { ModelRetryInfo } from './model/model-retry';
import { OpenAiCompatibleAdapter } from './model/openai-compatible-adapter';
import { ObsidianVaultAdapter } from './obsidian/vault-adapter';
import { confirmAgentStart, confirmLinkSend, confirmRemoteSend, showChangePreview } from './ui/modals';
import { AgentLoop, type AgentMessage, type AgentToolCall, type PendingChangePlan } from './agent/agent-loop';
import { createVaultReadTools } from './agent/vault-tools';
import { createVaultMutationTools } from './agent/vault-mutation-tools';
import { buildSkillPrompt, createSkillTools, loadSkills } from './agent/skills';
import { SessionRuntime } from './agent/session-runtime';
import { PluginDataStore } from './obsidian/plugin-data-store';
import { buildLinkBriefs, DEFAULT_MODEL_CANDIDATE_LIMIT } from './links/link-brief';
import { buildLinkSuggestionPreview, DEFAULT_SUGGESTION_LIMIT } from './links/link-suggestion';

/** 内置 `/` 命令：固定流水线，输入仍是当前笔记或选区，不接受补充说明。 */
const BUILT_IN_COMMANDS: ReadonlyArray<{ name: string; description: string; mode: AssistantMode }> = [
	{ name: '整理', description: '整理当前笔记或选区，生成写回预览', mode: 'organize' },
	{ name: '寻找关联', description: '用本地候选生成双链建议，逐条确认写回', mode: 'related' },
];

export default class AiNoteAssistantPlugin extends Plugin {
	settings!: AiNoteAssistantSettings;
	private assistant!: NoteAssistant;
	private agentModel!: OpenAiCompatibleAdapter;
	private vaultAdapter!: ObsidianVaultAdapter;
	private pluginData!: PluginDataStore;
	private sessionRuntime!: SessionRuntime;
	private remoteConfirmedScope?: 'selection' | 'full';
	private agentConfirmedThisSession = false;
	private linkConfirmedThisSession = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.sessionRuntime = new SessionRuntime(this.pluginData);
		await this.sessionRuntime.open();
		this.vaultAdapter = new ObsidianVaultAdapter(this.app, () => this.settings.localCandidateLimit);
		this.agentModel = new OpenAiCompatibleAdapter(() => this.settings, (info) => this.reportModelRetry(info));
		this.assistant = new NoteAssistant(this.agentModel);
		this.registerView(VIEW_TYPE_ASSISTANT, (leaf) => new AssistantView(leaf, this));
		this.addRibbonIcon('brain', '打开思维整理', () => void this.activateView());

		this.addCommand({ id: 'capture-thought', name: '捕捉当前想法', callback: () => void this.openAndRun('capture') });
		this.addCommand({ id: 'organize-current-note', name: '整理当前笔记', callback: () => void this.openAndRun('organize') });
		this.addCommand({ id: 'clarify-current-note', name: '澄清当前想法', callback: () => void this.openAndRun('clarify') });
		this.addCommand({ id: 'challenge-current-thought', name: '挑战当前想法', callback: () => void this.openAndRun('challenge') });
		this.addCommand({ id: 'actionize-current-note', name: '生成下一步', callback: () => void this.openAndRun('actionize') });
		this.addCommand({ id: 'suggest-related-notes', name: '寻找相关笔记', callback: () => void this.openAndRun('related') });
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

	private async openAndRun(mode: AssistantMode): Promise<void> {
		await this.activateView();
		if (!this.getAssistantView()) {
			new Notice('请先打开思维整理侧栏。');
			return;
		}
		await this.runMode(mode);
	}

	/** 候选只在面板打开时取一次：`/` 给命令与技能，`@` 给笔记与文件夹，都不读取正文。 */
	async completionCandidates(kind: CompletionKind): Promise<CompletionCandidate[]> {
		if (kind === 'command') {
			const skills = await loadSkills(this.vaultAdapter);
			return [
				...BUILT_IN_COMMANDS.map((command) => ({
					value: slugifyCommandName(command.name),
					label: `/${command.name}`,
					description: command.description,
				})),
				...skills.map((skill) => ({
					value: slugifyCommandName(skill.name),
					label: `/${skill.name}`,
					description: skill.description || `Vault 技能（${skill.path}）`,
				})),
			];
		}
		const targets = await this.mentionTargets();
		return [
			...targets.folders.map((folder) => ({ value: `${folder}/`, label: `${folder}/`, isFolder: true })),
			...targets.notes.map((note) => ({ value: note.path, label: note.title, description: note.path })),
		];
	}

	/**
	 * 侧栏输入框的唯一入口。`/` 命令决定走固定流水线还是显式技能，`@` 提及只声明本轮
	 * 工作范围：路径进运行环境提示，正文仍由模型按需读取。
	 */
	async submitPrompt(text: string): Promise<void> {
		const parsed = parsePromptInput(text);
		const view = this.getAssistantView();
		view?.setBusy(true);
		try {
			const steps: string[] = [];
			const extraContext: string[] = [];
			let skillName: string | undefined;
			if (parsed.commandToken) {
				const token = parsed.commandToken;
				const builtIn = BUILT_IN_COMMANDS.find((command) => matchesCommandToken(command.name, token));
				if (builtIn) {
					await this.runMode(builtIn.mode, this.describeBuiltIn(builtIn, parsed.commandArguments, parsed.mentions.length));
					return;
				}
				const skill = (await loadSkills(this.vaultAdapter))
					.find((candidate) => matchesCommandToken(candidate.name, token));
				if (skill) {
					skillName = skill.name;
					extraContext.push(buildSkillContext(skill));
					steps.push(`已显式触发技能「${skill.name}」（正文来自 ${skill.path}，只作为本轮运行环境提示）`);
				} else {
					steps.push(`/${token} 既不是内置命令也不是 Vault 技能，本轮按普通消息发送`);
				}
			}
			if (parsed.mentions.length > 0) {
				const resolution = resolveMentions(parsed.mentions, await this.mentionTargets());
				const mentionContext = buildMentionContext(resolution);
				if (mentionContext) extraContext.push(mentionContext);
				if (resolution.notes.length > 0) steps.push(`本轮指定笔记：${resolution.notes.join('、')}（正文按需读取）`);
				if (resolution.folders.length > 0) steps.push(`本轮指定文件夹：${resolution.folders.join('、')}`);
				for (const item of resolution.unresolved) steps.push(`${item.raw} 未解析：${item.reason}`);
			}
			const message = skillName
				? parsed.commandArguments || `请按技能「${skillName}」处理当前任务。`
				: parsed.text;
			await this.runAgent(message, { extraContext, processSteps: steps });
		} finally {
			view?.setBusy(false);
		}
	}

	private describeBuiltIn(
		command: { name: string; description: string },
		commandArguments: string,
		mentionCount: number,
	): string[] {
		const steps = [`内置命令 /${command.name}：${command.description}`];
		if (commandArguments) {
			steps.push(`补充说明「${commandArguments}」未使用：内置命令按固定流程运行，需要额外要求请直接对话`);
		}
		if (mentionCount > 0) steps.push('内置命令以当前笔记或选区为输入，本轮的 @ 范围未使用');
		return steps;
	}

	private async mentionTargets(): Promise<MentionTargets> {
		return { notes: await this.vaultAdapter.listNotes(), folders: this.vaultAdapter.listFolders() };
	}

	async runMode(mode: AssistantMode, steps: readonly string[] = []): Promise<void> {
		const view = this.getAssistantView();
		view?.beginProcess();
		for (const step of steps) view?.addProcessStep(step);
		if (mode !== 'organize' && mode !== 'related') {
			new Notice('该动作将在后续切片中启用。当前可用命令是 /整理 和 /寻找关联。');
			view?.setStatus('当前可用命令是 /整理 和 /寻找关联。');
			return;
		}
		const label = mode === 'organize' ? '整理' : '寻找关联';
		view?.setStatus('正在读取当前笔记…');
		if (!this.settings.remoteModelEnabled) {
			new Notice('请先在设置中开启远程模型。');
			view?.setStatus('远程模型已关闭，未发送任何内容。');
			return;
		}

		try {
			if (mode === 'organize') await this.runOrganize(view);
			else await this.runRelated(view);
		} catch (error) {
			const message = error instanceof Error ? error.message : '未知错误';
			new Notice(`${label}失败：${message}`);
			view?.setStatus(`${label}失败：${message}`);
		}
	}

	private async runOrganize(view?: AssistantView): Promise<void> {
		const source = await this.vaultAdapter.readActive();
		const selection = this.resolveSelection(source, view);
		const sent = selection ? selection.text : source.content;
		view?.addProcessStep(selection
			? `已读取 ${source.path} 的选区（${sent.length} 个字符，全文 ${source.content.length} 个字符）`
			: `已读取 ${source.path}（${source.content.length} 个字符）`);
		const scope = selection ? 'selection' : 'full';
		// 确认过全文就不必为更窄的选区再确认；只确认过选区时，改发全文要重新确认。
		if (this.remoteConfirmedScope !== scope && this.remoteConfirmedScope !== 'full') {
			view?.addProcessStep('等待确认本次发送范围');
			const confirmed = await confirmRemoteSend(this.app, source.path, sent, selection ? '当前选区' : '当前笔记全文');
			if (!confirmed) {
				view?.setStatus('已取消发送，原笔记未改变。');
				return;
			}
			this.remoteConfirmedScope = scope;
			view?.addProcessStep(selection ? '用户已确认发送当前选区内容' : '用户已确认发送当前笔记内容');
		}
		view?.addProcessStep(`正在请求 ${this.settings.modelName}`);
		view?.setStatus('模型正在生成结构化草稿…');
		const result = await this.assistant.organize(
			selection ? { content: sent, selectionOnly: true } : { content: sent },
			{ onDelta: (delta) => view?.appendStreamDelta(delta) },
		);
		view?.addProcessStep(result.streamed ? '流式输出接收完成' : '流式连接不可用，已完成普通响应');
		view?.addProcessStep('结构化结果校验通过');
		const choices = buildOrganizeWriteChoices(source, result.markdown, selection);
		showChangePreview(this.app, choices, result.markdown, async (choice) => {
			await this.vaultAdapter.update(choice.preview);
			new Notice(choice.id === 'replace-selection' ? '整理结果已替换选区。' : '整理结果已追加到当前笔记。');
			view?.setStatus(choice.id === 'replace-selection' ? '已用整理结果替换选区。' : '已写回整理结果。');
		});
		view?.addProcessStep(selection
			? '写回预览已生成（可选替换选区或追加到末尾），原笔记尚未修改'
			: '写回预览已生成，原笔记尚未修改');
		view?.setStatus('已生成预览，请确认写回方式。');
	}

	/**
	 * 编辑器有选区时只整理选区。选区要在已保存正文里重新定位，定位不了就整理全文，
	 * 因为按编辑器偏移猜位置会写错地方。
	 */
	private resolveSelection(source: NoteSnapshot, view?: AssistantView): SelectionTarget | undefined {
		const selection = this.vaultAdapter.getActiveSelection();
		if (!selection) return undefined;
		try {
			return locateSelection(source.content, selection.text, selection.offsetHint);
		} catch (error) {
			const message = error instanceof Error ? error.message : '未知错误';
			new Notice(`选区无法定位，已按全文整理：${message}`);
			view?.addProcessStep(`选区无法定位（${message}），本次按全文整理`);
			return undefined;
		}
	}

	/**
	 * Candidate discovery stays local; only the current note plus a bounded
	 * excerpt of each candidate is sent, and each returned suggestion is written
	 * back on its own after the user confirms it.
	 */
	private async runRelated(view?: AssistantView): Promise<void> {
		if (!view) {
			new Notice('请先打开思维整理侧栏，双链建议需要逐条确认。');
			return;
		}
		const source = await this.vaultAdapter.readActive();
		view.addProcessStep(`已读取 ${source.path}（${source.content.length} 个字符）`);
		const context = await this.vaultAdapter.getLinkContext(source.path, 2);
		view.addProcessStep(`本地候选 ${context.candidates.length} 篇（已跳过 ${context.skippedLinked} 篇已链接笔记）`);
		if (context.candidates.length === 0) {
			view.setStatus('本地没有找到关联候选，未发送任何内容。');
			return;
		}

		const modelLimit = positiveLimit(this.settings.modelCandidateLimit, DEFAULT_MODEL_CANDIDATE_LIMIT);
		const selected = context.candidates.slice(0, modelLimit);
		const inputs = await Promise.all(selected.map(async (candidate) => ({
			candidate,
			content: (await this.vaultAdapter.read(candidate.target.path)).content,
		})));
		const briefs = buildLinkBriefs(inputs, { limit: modelLimit });
		view.addProcessStep(`已提取 ${briefs.length} 条候选片段，尚未发送`);

		if (!this.linkConfirmedThisSession) {
			view.addProcessStep('等待确认本次发送范围');
			const confirmed = await confirmLinkSend(this.app, source.path, source.content.length, briefs);
			if (!confirmed) {
				view.setStatus('已取消发送，未发送任何笔记内容。');
				return;
			}
			this.linkConfirmedThisSession = true;
			view.addProcessStep('用户已确认发送当前笔记和候选片段');
		}

		view.addProcessStep(`正在请求 ${this.settings.modelName}`);
		view.setStatus('模型正在判断关系…');
		const result = await this.assistant.suggestLinks(
			{
				sourceContent: source.content,
				briefs,
				limit: positiveLimit(this.settings.suggestionLimit, DEFAULT_SUGGESTION_LIMIT),
			},
			{ onDelta: (delta) => view.appendStreamDelta(delta) },
		);
		view.addProcessStep(result.streamed ? '流式输出接收完成' : '流式连接不可用，已完成普通响应');
		view.addProcessStep(`建议校验完成：可写回 ${result.suggestions.length} 条，未采用 ${result.rejected.length} 条`);
		view.showLinkSuggestions(result, async (suggestion) => {
			const current = await this.vaultAdapter.read(source.path);
			const preview = buildLinkSuggestionPreview(current, suggestion);
			await this.vaultAdapter.update(preview);
			new Notice(`已加入指向「${suggestion.targetTitle}」的双链。`);
			view.setStatus(`已写回 [[${suggestion.linkTarget}]]，其余建议仍待确认。`);
		});
		view.setStatus(result.suggestions.length === 0
			? '模型没有给出可写回的双链建议，笔记未改变。'
			: '已生成双链建议，请逐条确认写回。');
	}

	async runAgent(
		userMessage: string,
		options: { extraContext?: readonly string[]; processSteps?: readonly string[] } = {},
	): Promise<void> {
		const view = this.getAssistantView();
		if (!view) return;
		if (!userMessage.trim()) return;
		view.beginProcess();
		for (const step of options.processSteps ?? []) view.addProcessStep(step);
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
			const runtimeContext = [
				activeNotePath
					? `运行环境：当前活动笔记路径是 ${activeNotePath}。正文尚未读取；需要时使用 searchNotes 或 readNote。`
					: '运行环境：当前没有活动 Markdown 笔记。需要时使用 listNotes 或 searchNotes 定位笔记。',
				...(options.extraContext ?? []),
			].join('\n\n');
			const result = await loop.run(userMessage.trim(), this.sessionRuntime.history(), runtimeContext);
			await this.sessionRuntime.commit(result.messages);
			view.setConversation(result.messages);
			if (result.pendingChangePlan) {
				const plan = result.pendingChangePlan;
				view.addProcessStep('写工具已转换为待确认预览');
				view.showPendingChangePlan(plan, async (selections) => {
					const written = await this.applyPendingSelection(plan, selections);
					new Notice(written === undefined ? '已按确认计划写回笔记。' : `已写回选中的 ${written} 处变更。`);
					view.setStatus(written === undefined
						? '写回完成。'
						: `写回完成：只写回了选中的 ${written} 处变更，其余保持原文；需要写回其余变更请重新生成预览。`);
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

	/**
	 * 全部勾选时沿用计划自带的写回；只勾选一部分时按选中的 hunk 重建预览，
	 * 因此部分写回同样要通过内容哈希校验。返回实际写回的变更处数，整体写回返回 undefined。
	 */
	private async applyPendingSelection(
		plan: PendingChangePlan,
		selections: PendingChangeSelection[],
	): Promise<number | undefined> {
		const partial = selections.some((selection) => selection.selectedHunks.length < selection.totalHunks);
		if (!partial) {
			await plan.apply?.();
			return undefined;
		}
		let written = 0;
		for (const selection of selections) {
			if (selection.selectedHunks.length === 0) continue;
			if (!selection.change.applyPreview) throw new Error('这处变更不支持逐处写回，请取消后整体确认。');
			await selection.change.applyPreview(
				buildHunkSelectionPreview(selection.preview, selection.diff, selection.selectedHunks),
			);
			written += selection.selectedHunks.length;
		}
		return written;
	}

	private async startNewSession(): Promise<void> {
		await this.sessionRuntime.reset();
		const view = this.getAssistantView();
		if (view) {
			view.setConversation([]);
			view.setStatus('已新建会话。');
		}
		new Notice('已新建助手会话。');
	}

	/** 重试要让用户看见：说明原因、等待时间和第几次尝试，并丢弃上一次已经显示的增量。 */
	private reportModelRetry(info: ModelRetryInfo): void {
		const view = this.getAssistantView();
		if (info.discardOutput) view?.resetStream();
		const attempt = `第 ${info.attempt}/${info.attempts} 次尝试`;
		view?.addProcessStep(info.delayMs > 0
			? `${info.reason}，${describeDelay(info.delayMs)}后重试（${attempt}）`
			: `${info.reason}（${attempt}）`);
		view?.setStatus(`模型请求失败，正在重试（${attempt}）…`);
	}

	private getAssistantView(): AssistantView | undefined {
		const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_ASSISTANT)[0]?.view;
		return view instanceof AssistantView ? view : undefined;
	}
}

function describeDelay(delayMs: number): string {
	const seconds = delayMs / 1000;
	return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} 秒`;
}

/** Plugin data can hold anything from an older version, so limits are re-checked before use. */
function positiveLimit(value: number, fallback: number): number {
	return Number.isInteger(value) && value > 0 ? value : fallback;
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
