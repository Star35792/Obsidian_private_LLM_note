import { requestUrl } from 'obsidian';
import type { AiNoteAssistantSettings } from '../settings';
import type { ModelCompletionOptions, ModelPort, ModelRequest, ModelResponse } from './model-port';
import { buildOpenAiRequest, readOpenAiContent, readOpenAiStreamDelta } from './openai-protocol';

export class OpenAiCompatibleAdapter implements ModelPort {
	private readonly getSettings: () => AiNoteAssistantSettings;

	constructor(getSettings: () => AiNoteAssistantSettings) {
		this.getSettings = getSettings;
	}

	async complete(request: ModelRequest, options: ModelCompletionOptions = {}): Promise<ModelResponse> {
		const settings = this.getSettings();
		if (!settings.apiKey.trim()) throw new Error('尚未配置 API key');
		if (!settings.apiBaseUrl.trim() || !settings.modelName.trim()) throw new Error('模型地址或名称为空');
		if (options.onDelta) {
			try {
				return await this.completeStreaming(request, settings, options);
			} catch (error) {
				if (!(error instanceof TypeError)) throw error;
				const fallback = await this.completeNonStreaming(request, settings);
				options.onDelta(fallback.content);
				return fallback;
			}
		}
		return this.completeNonStreaming(request, settings);
	}

	private async completeNonStreaming(
		request: ModelRequest,
		settings: AiNoteAssistantSettings,
	): Promise<ModelResponse> {
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
		return { content, streamed: false };
	}

	private async completeStreaming(
		request: ModelRequest,
		settings: AiNoteAssistantSettings,
		options: ModelCompletionOptions,
	): Promise<ModelResponse> {
		const builtRequest = buildOpenAiRequest(settings.apiBaseUrl, settings.apiFormat, settings.modelName, request, true);
		// requestUrl buffers the entire response, so native fetch is required for SSE streaming.
		const response = await activeWindow.fetch(builtRequest.url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${settings.apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(builtRequest.body),
			signal: options.signal,
		});
		if (!response.ok) throw new Error(`模型请求失败（HTTP ${response.status}）`);
		if (!response.body) throw new TypeError('当前环境无法读取流式响应');

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let content = '';
		while (true) {
			const { done, value } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.startsWith('data:')) continue;
				const data = line.slice(5).trim();
				if (!data || data === '[DONE]') continue;
				const delta = readOpenAiStreamDelta(settings.apiFormat, JSON.parse(data) as unknown);
				if (delta) {
					content += delta;
					options.onDelta?.(delta);
				}
			}
			if (done) break;
		}
		if (!content) throw new Error('模型流式响应内容为空');
		return { content, streamed: true };
	}
}
