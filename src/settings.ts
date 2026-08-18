import { App, PluginSettingTab, Setting } from 'obsidian';
import AiNoteAssistantPlugin from './main';

export interface AiNoteAssistantSettings {
	remoteModelEnabled: boolean;
	apiBaseUrl: string;
	modelName: string;
	apiKey: string;
	localCandidateLimit: number;
	modelCandidateLimit: number;
	suggestionLimit: number;
}

export const DEFAULT_SETTINGS: AiNoteAssistantSettings = {
	remoteModelEnabled: false,
	apiBaseUrl: 'https://api.openai.com/v1',
	modelName: 'gpt-4o-mini',
	apiKey: '',
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

		this.addTextSetting(containerEl, 'API 地址', 'OpenAI-compatible 接口地址。', 'apiBaseUrl', DEFAULT_SETTINGS.apiBaseUrl);
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

	private addNumberSetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		key: 'localCandidateLimit' | 'modelCandidateLimit' | 'suggestionLimit',
	): void {
		new Setting(containerEl).setName(name).setDesc(desc).addText((text) => {
			text.setValue(String(this.plugin.settings[key]));
			text.inputEl.type = 'number';
			text.inputEl.min = '1';
			text.inputEl.step = '1';
			text.onChange(async (value: string) => {
				const parsed = Number.parseInt(value, 10);
				if (Number.isInteger(parsed) && parsed > 0) {
					this.plugin.settings[key] = parsed;
					await this.plugin.saveSettings();
				}
			});
		});
	}
}
