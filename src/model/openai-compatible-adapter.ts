import { requestUrl } from 'obsidian';
import type { AgentMessage, AgentModelPort, AgentToolDescription, AgentTurn } from '../agent/agent-loop';
import type { AiNoteAssistantSettings } from '../settings';
import type { ModelCompletionOptions, ModelPort, ModelRequest, ModelResponse } from './model-port';
import {
	ModelHttpError,
	ModelStreamInterruptedError,
	normalizeRetryCount,
	parseRetryAfterSeconds,
	runWithModelRetry,
	type ModelRetryInfo,
} from './model-retry';
import {
	buildOpenAiAgentBody,
	buildOpenAiRequest,
	readOpenAiAgentTurn,
	readOpenAiContent,
	readOpenAiStreamDelta,
} from './openai-protocol';

/** 每次重试都要能说清原因，因此由装配方（`main.ts`）接到侧栏处理过程。 */
export type ModelRetryNotifier = (info: ModelRetryInfo) => void;

const ERROR_BODY_MAX = 200;

export class OpenAiCompatibleAdapter implements ModelPort, AgentModelPort {
	private readonly getSettings: () => AiNoteAssistantSettings;
	private readonly notifyRetry: ModelRetryNotifier;

	constructor(getSettings: () => AiNoteAssistantSettings, notifyRetry: ModelRetryNotifier = () => {}) {
		this.getSettings = getSettings;
		this.notifyRetry = notifyRetry;
	}

	async complete(request: ModelRequest, options: ModelCompletionOptions = {}): Promise<ModelResponse> {
		const settings = this.requireSettings();
		const attempts = normalizeRetryCount(settings.modelRetryCount) + 1;
		// 重试前要让界面丢弃上一次尝试已经显示的增量，否则两次输出会拼在一起。
		let streamed = false;
		return runWithModelRetry(async (attempt) => {
			streamed = false;
			if (!options.onDelta) return this.completeNonStreaming(request, settings);
			const onDelta = (delta: string): void => {
				streamed = true;
				options.onDelta?.(delta);
			};
			try {
				return await this.completeStreaming(request, settings, { ...options, onDelta });
			} catch (error) {
				// TypeError 表示这个环境读不到流或连接中断，此时退回普通响应重发一次。
				if (!(error instanceof TypeError)) throw error;
				if (streamed) {
					this.notifyRetry({
						attempt,
						attempts,
						delayMs: 0,
						reason: '流式连接中断，改用普通响应重新请求',
						discardOutput: true,
					});
				}
				const fallback = await this.completeNonStreaming(request, settings);
				options.onDelta(fallback.content);
				return fallback;
			}
		}, {
			retries: attempts - 1,
			...(options.signal ? { signal: options.signal } : {}),
			onRetry: this.notifyRetry,
			shouldDiscardOutput: () => streamed,
		});
	}

	async completeAgent(messages: AgentMessage[], tools: AgentToolDescription[]): Promise<AgentTurn> {
		const settings = this.requireSettings();
		const body = buildOpenAiAgentBody(settings.apiFormat, settings.modelName, messages, tools);
		return runWithModelRetry(
			async () => readOpenAiAgentTurn(settings.apiFormat, await this.postJson(settings.apiBaseUrl, body, settings)),
			{ retries: normalizeRetryCount(settings.modelRetryCount), onRetry: this.notifyRetry },
		);
	}

	private requireSettings(): AiNoteAssistantSettings {
		const settings = this.getSettings();
		if (!settings.apiKey.trim()) throw new Error('尚未配置 API key');
		if (!settings.apiBaseUrl.trim() || !settings.modelName.trim()) throw new Error('模型地址或名称为空');
		return settings;
	}

	private async completeNonStreaming(
		request: ModelRequest,
		settings: AiNoteAssistantSettings,
	): Promise<ModelResponse> {
		const builtRequest = buildOpenAiRequest(settings.apiBaseUrl, settings.apiFormat, settings.modelName, request);
		const payload = await this.postJson(builtRequest.url, builtRequest.body, settings);
		const content = readOpenAiContent(settings.apiFormat, payload);
		if (!content) throw new Error('模型返回内容为空');
		return { content, streamed: false };
	}

	/**
	 * `requestUrl` 自己会在非 2xx 时抛错，但抛出的信息不带状态码，无法判断该不该重试；
	 * 因此这里关掉它的抛错，自己按状态码抛 `ModelHttpError`。
	 */
	private async postJson(url: string, body: unknown, settings: AiNoteAssistantSettings): Promise<unknown> {
		const response = await requestUrl({
			url,
			method: 'POST',
			headers: {
				Authorization: `Bearer ${settings.apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
			throw: false,
		});
		if (response.status < 200 || response.status >= 300) {
			throw new ModelHttpError(
				response.status,
				describeErrorBody(response.text),
				parseRetryAfterSeconds(headerValue(response.headers, 'retry-after')),
			);
		}
		try {
			return response.json;
		} catch {
			throw new Error('模型响应不是合法 JSON，请检查 API 地址与响应格式设置');
		}
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
		if (!response.ok) {
			throw new ModelHttpError(
				response.status,
				describeErrorBody(await response.text().catch(() => '')),
				parseRetryAfterSeconds(response.headers.get('retry-after')),
			);
		}
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
		// 连接在任何增量到达前就结束，属于连接层面的失败，重发同一请求是安全的。
		if (!content) throw new ModelStreamInterruptedError('模型流式响应内容为空');
		return { content, streamed: true };
	}
}

function describeErrorBody(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return '服务未返回错误详情';
	return trimmed.length <= ERROR_BODY_MAX ? trimmed : `${trimmed.slice(0, ERROR_BODY_MAX)}…`;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
	const match = Object.entries(headers).find(([key]) => key.toLocaleLowerCase() === name);
	return match?.[1];
}
