import { describe, expect, it, vi } from 'vitest';
import {
	classifyModelFailure,
	DEFAULT_MODEL_RETRY_COUNT,
	MAX_MODEL_RETRY_COUNT,
	ModelHttpError,
	ModelStreamInterruptedError,
	normalizeRetryCount,
	retryDelayMs,
	runWithModelRetry,
	type ModelRetryInfo,
} from '../src/model/model-retry';

const abortError = (): Error => {
	const error = new Error('The operation was aborted');
	error.name = 'AbortError';
	return error;
};

describe('classifyModelFailure', () => {
	it('retries a failed fetch', () => {
		const decision = classifyModelFailure(new TypeError('Failed to fetch'));

		expect(decision.retryable).toBe(true);
		expect(decision.reason).toContain('网络');
	});

	it('retries a chromium network error', () => {
		expect(classifyModelFailure(new Error('net::ERR_CONNECTION_RESET')).retryable).toBe(true);
	});

	it('retries a socket level error', () => {
		expect(classifyModelFailure(new Error('read ECONNRESET')).retryable).toBe(true);
	});

	it('retries a throttled request and keeps the server delay', () => {
		const decision = classifyModelFailure(new ModelHttpError(429, '请求过多', 12));

		expect(decision.retryable).toBe(true);
		expect(decision.retryAfterSeconds).toBe(12);
		expect(decision.reason).toContain('限流');
	});

	it('retries a server error', () => {
		const decision = classifyModelFailure(new ModelHttpError(503, '暂时不可用'));

		expect(decision.retryable).toBe(true);
		expect(decision.reason).toContain('503');
	});

	it('does not retry an authentication failure', () => {
		const decision = classifyModelFailure(new ModelHttpError(401, 'invalid api key'));

		expect(decision.retryable).toBe(false);
		expect(decision.reason).toContain('401');
	});

	it('does not retry a rejected request body', () => {
		expect(classifyModelFailure(new ModelHttpError(400, 'bad request')).retryable).toBe(false);
	});

	it('does not retry a cancelled request', () => {
		const decision = classifyModelFailure(abortError());

		expect(decision.retryable).toBe(false);
		expect(decision.reason).toContain('取消');
	});

	it('retries an interrupted stream', () => {
		expect(classifyModelFailure(new ModelStreamInterruptedError('模型流式响应内容为空')).retryable).toBe(true);
	});

	it('does not retry a configuration error', () => {
		expect(classifyModelFailure(new Error('尚未配置 API key')).retryable).toBe(false);
	});
});

describe('retryDelayMs', () => {
	it('backs off exponentially up to a ceiling', () => {
		expect([1, 2, 3, 9].map((attempt) => retryDelayMs(attempt))).toEqual([800, 1600, 3200, 8000]);
	});

	it('waits at least as long as the server asked', () => {
		expect(retryDelayMs(1, 5)).toBe(5000);
	});

	it('caps an unreasonable server delay', () => {
		expect(retryDelayMs(1, 600)).toBe(20000);
	});

	it('ignores a zero or negative server delay', () => {
		expect(retryDelayMs(1, 0)).toBe(800);
	});
});

describe('normalizeRetryCount', () => {
	it('keeps a value inside the allowed range', () => {
		expect(normalizeRetryCount(0)).toBe(0);
		expect(normalizeRetryCount(MAX_MODEL_RETRY_COUNT)).toBe(MAX_MODEL_RETRY_COUNT);
	});

	it('falls back to the default for anything else', () => {
		for (const value of [-1, 1.5, MAX_MODEL_RETRY_COUNT + 1, '2', undefined, null]) {
			expect(normalizeRetryCount(value)).toBe(DEFAULT_MODEL_RETRY_COUNT);
		}
	});
});

describe('runWithModelRetry', () => {
	const sleeps: number[] = [];
	const sleep = async (ms: number): Promise<void> => {
		sleeps.push(ms);
	};

	it('does not retry a successful request', async () => {
		const operation = vi.fn(async () => 'ok');

		await expect(runWithModelRetry(operation, { retries: 2, sleep })).resolves.toBe('ok');
		expect(operation).toHaveBeenCalledTimes(1);
	});

	it('retries a network failure and reports the next attempt', async () => {
		const retries: ModelRetryInfo[] = [];
		let calls = 0;
		const operation = async (): Promise<string> => {
			calls += 1;
			if (calls === 1) throw new TypeError('Failed to fetch');
			return 'ok';
		};

		await expect(runWithModelRetry(operation, {
			retries: 2,
			sleep,
			onRetry: (info) => retries.push(info),
		})).resolves.toBe('ok');
		expect(calls).toBe(2);
		expect(retries).toEqual([{ attempt: 2, attempts: 3, delayMs: 800, reason: '网络连接失败', discardOutput: false }]);
	});

	it('throws the last error after the retries are used up', async () => {
		let calls = 0;
		const operation = async (): Promise<string> => {
			calls += 1;
			throw new Error(`net::ERR_CONNECTION_RESET（第 ${calls} 次）`);
		};

		await expect(runWithModelRetry(operation, { retries: 2, sleep })).rejects.toThrow('第 3 次');
		expect(calls).toBe(3);
	});

	it('gives up immediately on an error that will not go away', async () => {
		const operation = vi.fn(async () => {
			throw new ModelHttpError(401, 'invalid api key');
		});

		await expect(runWithModelRetry(operation, { retries: 3, sleep })).rejects.toThrow('invalid api key');
		expect(operation).toHaveBeenCalledTimes(1);
	});

	it('tries once when retries are turned off', async () => {
		const operation = vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		});

		await expect(runWithModelRetry(operation, { retries: 0, sleep })).rejects.toThrow('Failed to fetch');
		expect(operation).toHaveBeenCalledTimes(1);
	});

	it('waits as long as the server asked before retrying', async () => {
		sleeps.length = 0;
		let calls = 0;
		const operation = async (): Promise<string> => {
			calls += 1;
			if (calls === 1) throw new ModelHttpError(429, '请求过多', 3);
			return 'ok';
		};

		await runWithModelRetry(operation, { retries: 1, sleep });

		expect(sleeps).toEqual([3000]);
	});

	it('tells the caller to discard output that was already streamed', async () => {
		const retries: ModelRetryInfo[] = [];
		let calls = 0;
		const operation = async (): Promise<string> => {
			calls += 1;
			if (calls === 1) throw new ModelStreamInterruptedError('流断了');
			return 'ok';
		};

		await runWithModelRetry(operation, {
			retries: 1,
			sleep,
			shouldDiscardOutput: () => true,
			onRetry: (info) => retries.push(info),
		});

		expect(retries[0]?.discardOutput).toBe(true);
	});

	it('stops when the wait is cancelled', async () => {
		const operation = vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		});

		await expect(runWithModelRetry(operation, {
			retries: 3,
			sleep: () => Promise.reject(abortError()),
		})).rejects.toThrow('aborted');
		expect(operation).toHaveBeenCalledTimes(1);
	});
});
