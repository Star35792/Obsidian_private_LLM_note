import { describe, expect, it } from 'vitest';
import { PluginDataStore } from '../src/obsidian/plugin-data-store';
import type { AiNoteAssistantSettings } from '../src/settings';
import type { AgentSessionSnapshot } from '../src/agent/session-runtime';

describe('PluginDataStore', () => {
	it('preserves legacy flat settings while session and settings are saved independently', async () => {
		const writes: unknown[] = [];
		const data = new PluginDataStore({
			remoteModelEnabled: true,
			modelName: 'legacy-model',
		}, async (value) => { writes.push(structuredClone(value)); });
		const session: AgentSessionSnapshot = {
			version: 1,
			id: 'session-1',
			messages: [{ role: 'user', content: '继续上次对话' }],
			createdAt: 100,
			updatedAt: 100,
		};
		const settings: AiNoteAssistantSettings = {
			remoteModelEnabled: true,
			apiBaseUrl: 'https://example.test/v1/chat/completions',
			apiFormat: 'chat-completions',
			modelName: 'new-model',
			apiKey: '',
			modelRetryCount: 2,
			localCandidateLimit: 20,
			modelCandidateLimit: 8,
			suggestionLimit: 5,
		};

		expect(data.settings()).toMatchObject({
			remoteModelEnabled: true,
			modelName: 'legacy-model',
		});
		await data.save(session);
		await data.saveSettings(settings);

		expect(writes.at(-1)).toMatchObject({
			modelName: 'new-model',
			activeSession: session,
		});
		expect(await data.load()).toEqual(session);
	});
});
