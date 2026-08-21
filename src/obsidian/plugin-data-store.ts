import type { AgentSessionSnapshot, SessionStore } from '../agent/session-runtime';
import { parseAgentSessionSnapshot } from '../agent/session-runtime';
import type { AiNoteAssistantSettings } from '../settings';

const ACTIVE_SESSION_KEY = 'activeSession';

export class PluginDataStore implements SessionStore {
	private readonly data: Record<string, unknown>;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(
		initialData: unknown,
		private readonly writeData: (value: unknown) => Promise<void>,
	) {
		this.data = isRecord(initialData) ? structuredClone(initialData) : {};
	}

	settings(): Partial<AiNoteAssistantSettings> {
		const { [ACTIVE_SESSION_KEY]: _activeSession, ...settings } = this.data;
		void _activeSession;
		return structuredClone(settings);
	}

	async saveSettings(settings: AiNoteAssistantSettings): Promise<void> {
		Object.assign(this.data, structuredClone(settings));
		await this.persist();
	}

	load(): Promise<AgentSessionSnapshot | undefined> {
		return Promise.resolve(parseAgentSessionSnapshot(this.data[ACTIVE_SESSION_KEY]));
	}

	async save(snapshot: AgentSessionSnapshot): Promise<void> {
		this.data[ACTIVE_SESSION_KEY] = structuredClone(snapshot);
		await this.persist();
	}

	private persist(): Promise<void> {
		const snapshot = structuredClone(this.data);
		const pending = this.writeQueue.then(() => this.writeData(snapshot));
		this.writeQueue = pending.catch(() => undefined);
		return pending;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
