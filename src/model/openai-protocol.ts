import type { ModelRequest } from './model-port';

export type ModelApiFormat = 'chat-completions' | 'responses';

export function buildOpenAiRequest(
	url: string,
	format: ModelApiFormat,
	model: string,
	request: ModelRequest,
	stream = false,
): { url: string; body: Record<string, unknown> } {
	return { url, body: buildOpenAiBody(format, model, request, stream) };
}

export function buildOpenAiBody(
	format: ModelApiFormat,
	model: string,
	request: ModelRequest,
	stream = false,
): Record<string, unknown> {
	if (format === 'responses') {
		return {
			model,
			instructions: request.system,
			input: request.user,
			...(stream ? { stream: true } : {}),
		};
	}
	return {
		model,
		messages: [
			{ role: 'system', content: request.system },
			{ role: 'user', content: request.user },
		],
		temperature: 0.2,
		...(stream ? { stream: true } : {}),
	};
}

export function readOpenAiContent(format: ModelApiFormat, value: unknown): string {
	if (!isRecord(value)) return '';
	if (format === 'chat-completions') {
		const choices = value.choices;
		if (!Array.isArray(choices) || !isRecord(choices[0]) || !isRecord(choices[0].message)) return '';
		return typeof choices[0].message.content === 'string' ? choices[0].message.content : '';
	}

	if (typeof value.output_text === 'string') return value.output_text;
	if (!Array.isArray(value.output)) return '';
	const texts: string[] = [];
	for (const output of value.output) {
		if (!isRecord(output) || !Array.isArray(output.content)) continue;
		for (const part of output.content) {
			if (isRecord(part) && part.type === 'output_text' && typeof part.text === 'string') {
				texts.push(part.text);
			}
		}
	}
	return texts.join('');
}

export function readOpenAiStreamDelta(format: ModelApiFormat, value: unknown): string {
	if (!isRecord(value)) return '';
	if (format === 'responses') {
		return value.type === 'response.output_text.delta' && typeof value.delta === 'string' ? value.delta : '';
	}
	const choices = value.choices;
	if (!Array.isArray(choices) || !isRecord(choices[0]) || !isRecord(choices[0].delta)) return '';
	return typeof choices[0].delta.content === 'string' ? choices[0].delta.content : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
