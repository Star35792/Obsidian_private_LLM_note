/**
 * Retry policy for model requests. Network drops, throttling and gateway errors
 * are transient, so the same request is sent again after a growing wait; an
 * authentication failure or a rejected body is not, because retrying it would
 * only delay a clear error message. Kept free of Obsidian and `fetch` so the
 * classification and the backoff can be tested directly.
 */
export class ModelHttpError extends Error {
	readonly status: number;
	readonly retryAfterSeconds?: number;

	constructor(status: number, message: string, retryAfterSeconds?: number) {
		super(message);
		this.name = 'ModelHttpError';
		this.status = status;
		if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
	}
}

/** 流式响应中断或没有任何增量：连接层面的失败，重发同一请求是安全的。 */
export class ModelStreamInterruptedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ModelStreamInterruptedError';
	}
}

export interface RetryDecision {
	retryable: boolean;
	/** 中文原因，直接展示在处理过程里。 */
	reason: string;
	retryAfterSeconds?: number;
}

export interface ModelRetryInfo {
	/** 即将开始的尝试序号；第一次请求是 1，所以重试时至少是 2。 */
	attempt: number;
	attempts: number;
	delayMs: number;
	reason: string;
	/** 上一次尝试已经产出过可见增量，界面要先清空再接收。 */
	discardOutput: boolean;
}

export interface ModelRetryOptions {
	/** 失败后的额外尝试次数；0 表示只请求一次。 */
	retries: number;
	signal?: AbortSignal;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	onRetry?: (info: ModelRetryInfo) => void;
	classify?: (error: unknown) => RetryDecision;
	shouldDiscardOutput?: () => boolean;
}

export const DEFAULT_MODEL_RETRY_COUNT = 2;
export const MAX_MODEL_RETRY_COUNT = 5;

const BASE_DELAY_MS = 800;
const MAX_DELAY_MS = 8000;
/** 服务端要求等待再久也不无限等，避免界面像卡死。 */
const MAX_SERVER_DELAY_MS = 20000;
const RETRYABLE_STATUS = new Set([408, 409, 425, 429]);
const NETWORK_PATTERN = /failed to fetch|networkerror|network error|net::|err_[a-z_]+|econn|etimedout|enotfound|eai_again|epipe|socket hang up|load failed|timed out|timeout|连接失败|请求超时/i;

export function classifyModelFailure(error: unknown): RetryDecision {
	if (isAbort(error)) return { retryable: false, reason: '请求已取消' };
	if (error instanceof ModelHttpError) return classifyStatus(error);
	if (error instanceof ModelStreamInterruptedError) {
		return { retryable: true, reason: `流式响应中断（${error.message}）` };
	}
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof TypeError || NETWORK_PATTERN.test(message)) {
		return { retryable: true, reason: '网络连接失败' };
	}
	return { retryable: false, reason: message || '未知错误' };
}

export function retryDelayMs(attempt: number, retryAfterSeconds?: number): number {
	const backoff = Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), MAX_DELAY_MS);
	if (retryAfterSeconds === undefined || !(retryAfterSeconds > 0)) return backoff;
	return Math.max(backoff, Math.min(retryAfterSeconds * 1000, MAX_SERVER_DELAY_MS));
}

/** 插件数据可能来自旧版本或手工编辑，所以每次使用前都重新校验范围。 */
export function normalizeRetryCount(value: unknown): number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_MODEL_RETRY_COUNT
		? value
		: DEFAULT_MODEL_RETRY_COUNT;
}

export async function runWithModelRetry<T>(
	operation: (attempt: number) => Promise<T>,
	options: ModelRetryOptions,
): Promise<T> {
	const attempts = Math.max(0, Math.floor(options.retries)) + 1;
	const classify = options.classify ?? classifyModelFailure;
	const sleep = options.sleep ?? delay;
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await operation(attempt);
		} catch (error) {
			const decision = classify(error);
			if (!decision.retryable || attempt >= attempts) throw error;
			const delayMs = retryDelayMs(attempt, decision.retryAfterSeconds);
			options.onRetry?.({
				attempt: attempt + 1,
				attempts,
				delayMs,
				reason: decision.reason,
				discardOutput: options.shouldDiscardOutput?.() ?? false,
			});
			await sleep(delayMs, options.signal);
		}
	}
}

/** `Retry-After` 只支持秒数形式；HTTP 日期形式按未提供处理。 */
export function parseRetryAfterSeconds(value: string | undefined | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number.parseInt(value.trim(), 10);
	return Number.isInteger(seconds) && seconds > 0 ? seconds : undefined;
}

function classifyStatus(error: ModelHttpError): RetryDecision {
	const { status } = error;
	const retryAfter = error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds };
	if (status === 429) return { retryable: true, reason: `服务限流（HTTP 429）`, ...retryAfter };
	if (RETRYABLE_STATUS.has(status)) return { retryable: true, reason: `请求超时或冲突（HTTP ${status}）`, ...retryAfter };
	if (status >= 500) return { retryable: true, reason: `服务暂时不可用（HTTP ${status}）`, ...retryAfter };
	return { retryable: false, reason: `请求被拒绝（HTTP ${status}）：${error.message}` };
}

function isAbort(error: unknown): boolean {
	return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** 只有生产路径会用到默认等待；测试通过 `options.sleep` 注入，不依赖浏览器计时器。 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		let timer: number | undefined;
		const onAbort = (): void => {
			if (timer !== undefined) window.clearTimeout(timer);
			reject(abortError());
		};
		timer = window.setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

function abortError(): Error {
	const error = new Error('请求已取消');
	error.name = 'AbortError';
	return error;
}
