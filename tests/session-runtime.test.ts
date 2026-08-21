import { describe, expect, it } from 'vitest';
import {
	SessionRuntime,
	type AgentSessionSnapshot,
	type SessionStore,
} from '../src/agent/session-runtime';

describe('SessionRuntime', () => {
	it('restores the active conversation after the runtime is recreated', async () => {
		const store = new MemorySessionStore();
		const first = new SessionRuntime(store, {
			createId: () => 'session-1',
			now: () => 100,
		});
		await first.open();
		await first.commit([
			{ role: 'user', content: '整理这篇笔记' },
			{ role: 'assistant', content: '我先读取相关内容。' },
		]);

		const restored = new SessionRuntime(store, {
			createId: () => 'unused',
			now: () => 200,
		});
		await restored.open();

		expect(restored.history()).toEqual([
			{ role: 'user', content: '整理这篇笔记' },
			{ role: 'assistant', content: '我先读取相关内容。' },
		]);
		expect(restored.snapshot()).toMatchObject({
			id: 'session-1',
			createdAt: 100,
			updatedAt: 100,
		});
	});

	it('resets to a new empty active session', async () => {
		let timestamp = 100;
		const ids = ['session-1', 'session-2'];
		const store = new MemorySessionStore();
		const runtime = new SessionRuntime(store, {
			createId: () => ids.shift()!,
			now: () => timestamp,
		});
		await runtime.open();
		await runtime.commit([{ role: 'user', content: '旧会话' }]);
		timestamp = 200;

		const reset = await runtime.reset();

		expect(reset).toEqual({
			version: 1,
			id: 'session-2',
			messages: [],
			createdAt: 200,
			updatedAt: 200,
		});
		expect(runtime.history()).toEqual([]);
	});
});

class MemorySessionStore implements SessionStore {
	private value?: AgentSessionSnapshot;

	load(): Promise<AgentSessionSnapshot | undefined> {
		return Promise.resolve(this.value);
	}

	save(snapshot: AgentSessionSnapshot): Promise<void> {
		this.value = structuredClone(snapshot);
		return Promise.resolve();
	}
}
