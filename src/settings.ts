import { App, PluginSettingTab, Setting } from 'obsidian';
import AiNoteAssistantPlugin from './main';
import { DEFAULT_MODEL_RETRY_COUNT, MAX_MODEL_RETRY_COUNT } from './model/model-retry';
import type { ModelApiFormat } from './model/openai-protocol';

export interface AiNoteAssistantSettings {
	remoteModelEnabled: boolean;
	apiBaseUrl: string;
	apiFormat: ModelApiFormat;
	modelName: string;
	apiKey: string;
	modelRetryCount: number;
	localCandidateLimit: number;
	modelCandidateLimit: number;
	suggestionLimit: number;
}

export const DEFAULT_SETTINGS: AiNoteAssistantSettings = {
	remoteModelEnabled: false,
	apiBaseUrl: 'https://api.openai.com/v1/chat/completions',
	apiFormat: 'chat-completions',
	modelName: 'gpt-4o-mini',
	apiKey: '',
	modelRetryCount: DEFAULT_MODEL_RETRY_COUNT,
	localCandidateLimit: 20,
	modelCandidateLimit: 8,
	suggestionLimit: 5,
};

export class AssistantSettingTab extends PluginSettingTab {
	plugin: AiNoteAssistantPlugin;

	constructor(app: App, plugin: AiNoteAssistantPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl).setName('模型设置').setHeading();

		new Setting(containerEl)
			.setName('允许远程模型')
			.setDesc('关闭时不会向外部服务发送笔记内容。每个会话首次使用时仍会显示发送范围。')
			.addToggle((toggle) => toggle.setValue(this.plugin.settings.remoteModelEnabled).onChange(async (value) => {
				this.plugin.settings.remoteModelEnabled = value;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('响应格式')
			.setDesc('选择服务实际使用的 OpenAI-compatible 协议。')
			.addDropdown((dropdown) => dropdown
				.addOption('chat-completions', 'Chat completions')
				.addOption('responses', 'Responses API')
				.setValue(this.plugin.settings.apiFormat)
				.onChange(async (value: string) => {
					this.plugin.settings.apiFormat = value === 'responses' ? 'responses' : 'chat-completions';
					await this.plugin.saveSettings();
				}));

		this.addTextSetting(containerEl, 'API 完整地址', '请求会直接发送到此地址，不会追加或修改路径。', 'apiBaseUrl', DEFAULT_SETTINGS.apiBaseUrl);
		this.addTextSetting(containerEl, '模型名称', '发送给 API 的模型标识。', 'modelName', DEFAULT_SETTINGS.modelName);

		new Setting(containerEl)
			.setName('API key')
			.setDesc('仅保存在 Obsidian 插件设置中。')
			.addText((text) => {
				text.setPlaceholder('API key').setValue(this.plugin.settings.apiKey).onChange(async (value: string) => {
					this.plugin.settings.apiKey = value;
					await this.plugin.saveSettings();
				});
				text.inputEl.type = 'password';
			});

		this.addNumberSetting(
			containerEl,
			'请求重试次数',
			`网络中断、服务限流或 5xx 时自动重发同一请求的次数；0 表示不重试，最多 ${MAX_MODEL_RETRY_COUNT} 次。等待时间从 0.8 秒起指数增长，并遵守服务返回的 Retry-After。`,
			'modelRetryCount',
			0,
			MAX_MODEL_RETRY_COUNT,
		);

		new Setting(containerEl).setName('关联候选数量').setHeading();
		this.addNumberSetting(containerEl, '本地候选上限', '交给关联筛选的本地笔记数量。', 'localCandidateLimit');
		this.addNumberSetting(containerEl, '模型候选上限', '发送给模型的候选片段数量。', 'modelCandidateLimit');
		this.addNumberSetting(containerEl, '建议展示上限', '最终展示的双链建议数量。', 'suggestionLimit');
	}

	private addTextSetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		key: 'apiBaseUrl' | 'modelName',
		placeholder: string,
	): void {
		new Setting(containerEl).setName(name).setDesc(desc).addText((text) => text
			.setPlaceholder(placeholder)
			.setValue(this.plugin.settings[key])
			.onChange(async (value) => {
				this.plugin.settings[key] = value.trim();
				await this.plugin.saveSettings();
			}));
	}

	/** `min` 可以是 0，因为“不重试”是合法选择；越界输入直接忽略，不写坏已保存的值。 */
	private addNumberSetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		key: 'localCandidateLimit' | 'modelCandidateLimit' | 'suggestionLimit' | 'modelRetryCount',
		min = 1,
		max?: number,
	): void {
		new Setting(containerEl).setName(name).setDesc(desc).addText((text) => {
			text.setValue(String(this.plugin.settings[key]));
			text.inputEl.type = 'number';
			text.inputEl.min = String(min);
			if (max !== undefined) text.inputEl.max = String(max);
			text.inputEl.step = '1';
			text.onChange(async (value: string) => {
				const parsed = Number.parseInt(value, 10);
				if (Number.isInteger(parsed) && parsed >= min && (max === undefined || parsed <= max)) {
					this.plugin.settings[key] = parsed;
					await this.plugin.saveSettings();
				}
			});
		});
	}
}
