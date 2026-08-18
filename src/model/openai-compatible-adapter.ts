import { requestUrl } from 'obsidian';
import type { AiNoteAssistantSettings } from '../settings';
import type { ModelPort, ModelRequest, ModelResponse } from './model-port';

export class OpenAiCompatibleAdapter implements ModelPort {
	private readonly getSettings: () => AiNoteAssistantSettings;

	constructor(getSettings: () => AiNoteAssistantSettings) {
		this.getSettings = getSettings;
	}

	async complete(request: ModelRequest): Promise<ModelResponse> {
		const settings = this.getSettings();
		if (!settings.apiKey.trim()) throw new Error('尚未配置 API key');
		if (!settings.apiBaseUrl.trim() || !settings.modelName.trim()) throw new Error('模型地址或名称为空');

		const response = await requestUrl({
			url: `${settings.apiBaseUrl.replace(/\/$/, '')}/chat/completions`,
			method: 'POST',
			headers: {
				Authorization: `Bearer ${settings.apiKey}`,
				'Content-Type': 'application/json',
			},
				body: JSON.stringify({
					model: settings.modelName,
					messages: [
						{ role: 'system', content: request.system },
						{ role: 'user', content: request.user },
					],
					temperature: 0.2,
				}),
		});
		const content = readContent(response.json);
		if (!content) throw new Error('模型返回内容为空');
		return { content };
	}
}

function readContent(value: unknown): string {
	if (typeof value !== 'object' || value === null || !Array.isArray((value as { choices?: unknown }).choices)) return '';
	const choice = (value as { choices: unknown[] }).choices[0];
	if (typeof choice !== 'object' || choice === null) return '';
	const message = (choice as { message?: unknown }).message;
	if (typeof message !== 'object' || message === null) return '';
	const content = (message as { content?: unknown }).content;
	return typeof content === 'string' ? content : '';
}
