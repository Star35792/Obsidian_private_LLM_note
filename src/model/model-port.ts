export interface ModelRequest {
	system: string;
	user: string;
}

export interface ModelResponse {
	content: string;
}

export interface ModelPort {
	complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}
