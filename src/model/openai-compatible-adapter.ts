import { requestUrl } from 'obsidian';
import type { AiNoteAssistantSettings } from '../settings';
import type { ModelPort, ModelRequest, ModelResponse } from './model-port';
import { buildOpenAiRequest, readOpenAiContent } from './openai-protocol';

export class OpenAiCompatibleAdapter implements ModelPort {
	private readonly getSettings: () => AiNoteAssistantSettings;

	constructor(getSettings: () => AiNoteAssistantSettings) {
		this.getSettings = getSettings;
	}

	async complete(request: ModelRequest): Promise<ModelResponse> {
		const settings = this.getSettings();
		if (!settings.apiKey.trim()) throw new Error('尚未配置 API key');
		if (!settings.apiBaseUrl.trim() || !settings.modelName.trim()) throw new Error('模型地址或名称为空');
		const builtRequest = buildOpenAiRequest(settings.apiBaseUrl, settings.apiFormat, settings.modelName, request);

		const response = await requestUrl({
			url: builtRequest.url,
			method: 'POST',
			headers: {
				Authorization: `Bearer ${settings.apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(builtRequest.body),
		});
		const content = readOpenAiContent(settings.apiFormat, response.json);
		if (!content) throw new Error('模型返回内容为空');
		return { content };
	}
}
