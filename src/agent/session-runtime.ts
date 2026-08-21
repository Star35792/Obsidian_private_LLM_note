import type { AgentMessage } from './agent-loop';

export interface AgentSessionSnapshot {
	version: 1;
	id: string;
	messages: AgentMessage[];
	createdAt: number;
	updatedAt: number;
}

export interface SessionStore {
	load(): Promise<AgentSessionSnapshot | undefined>;
	save(snapshot: AgentSessionSnapshot): Promise<void>;
}

export interface SessionRuntimeOptions {
	createId?: () => string;
	now?: () => number;
}

export function parseAgentSessionSnapshot(value: unknown): AgentSessionSnapshot | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	if (typeof value.id !== 'string' || !value.id.trim()) return undefined;
	if (!Array.isArray(value.messages)) return undefined;
	if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || value.updatedAt < value.createdAt) return undefined;
	const messages: AgentMessage[] = [];
	for (const valueMessage of value.messages) {
		const message = parseAgentMessage(valueMessage);
		if (!message) return undefined;
		messages.push(message);
	}
	return {
		version: 1,
		id: value.id,
		messages,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

export class SessionRuntime {
	private current?: AgentSessionSnapshot;
	private readonly createId: () => string;
	private readonly now: () => number;

	constructor(
		private readonly store: SessionStore,
		options: SessionRuntimeOptions = {},
	) {
		this.createId = options.createId ?? (() => crypto.randomUUID());
		this.now = options.now ?? (() => Date.now());
	}

	async open(): Promise<AgentSessionSnapshot> {
		if (this.current) return cloneSnapshot(this.current);
		const restored = await this.store.load();
		if (restored) {
			this.current = cloneSnapshot(restored);
			return cloneSnapshot(this.current);
		}
		const timestamp = this.now();
		const created: AgentSessionSnapshot = {
			version: 1,
			id: this.createId(),
			messages: [],
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		await this.store.save(created);
		this.current = created;
		return cloneSnapshot(created);
	}

	history(): AgentMessage[] {
		return structuredClone(this.requireCurrent().messages);
	}

	snapshot(): AgentSessionSnapshot {
		return cloneSnapshot(this.requireCurrent());
	}

	async commit(messages: AgentMessage[]): Promise<AgentSessionSnapshot> {
		const current = this.requireCurrent();
		const next: AgentSessionSnapshot = {
			...current,
			messages: structuredClone(messages),
			updatedAt: this.now(),
		};
		await this.store.save(next);
		this.current = next;
		return cloneSnapshot(next);
	}

	async reset(): Promise<AgentSessionSnapshot> {
		const timestamp = this.now();
		const next: AgentSessionSnapshot = {
			version: 1,
			id: this.createId(),
			messages: [],
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		await this.store.save(next);
		this.current = next;
		return cloneSnapshot(next);
	}

	private requireCurrent(): AgentSessionSnapshot {
		if (!this.current) throw new Error('SessionRuntime 尚未打开');
		return this.current;
	}
}

function cloneSnapshot(snapshot: AgentSessionSnapshot): AgentSessionSnapshot {
	return structuredClone(snapshot);
}

function parseAgentMessage(value: unknown): AgentMessage | undefined {
	if (!isRecord(value) || !isAgentMessageRole(value.role) || typeof value.content !== 'string') return undefined;
	if (value.persist !== undefined && typeof value.persist !== 'boolean') return undefined;
	if (value.toolCallId !== undefined && typeof value.toolCallId !== 'string') return undefined;
	if (value.toolCalls !== undefined && !isToolCallArray(value.toolCalls)) return undefined;
	return structuredClone(value) as unknown as AgentMessage;
}

function isToolCallArray(value: unknown): boolean {
	return Array.isArray(value) && value.every((call) => (
		isRecord(call) && typeof call.id === 'string' && typeof call.name === 'string' && 'arguments' in call
	));
}

function isAgentMessageRole(value: unknown): value is AgentMessage['role'] {
	return value === 'system' || value === 'user' || value === 'assistant' || value === 'tool';
}

function isTimestamp(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
