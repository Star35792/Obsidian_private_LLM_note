export interface ModelRequest {
	system: string;
	user: string;
}

export interface ModelResponse {
	content: string;
	streamed: boolean;
}

export interface ModelCompletionOptions {
	signal?: AbortSignal;
	onDelta?: (delta: string) => void;
}

export interface ModelPort {
	complete(request: ModelRequest, options?: ModelCompletionOptions): Promise<ModelResponse>;
}
