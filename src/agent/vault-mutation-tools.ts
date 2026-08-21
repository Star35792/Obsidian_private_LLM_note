import {
	buildChangePreview,
	createExactReplaceChanges,
	createReplaceChange,
	type ChangePreview,
} from '../changes/change-plan';
import type { MutationAgentTool } from './agent-loop';
import type { NoteSnapshot } from '../changes/change-plan';
import type { VaultReadPort } from './vault-tools';

export interface VaultMutationPort extends VaultReadPort {
	update(preview: ChangePreview): Promise<NoteSnapshot>;
}

export function createVaultMutationTools(vault: VaultMutationPort): MutationAgentTool[] {
	return [{
		kind: 'mutation',
		name: 'updateNote',
		description: '生成对已有 Markdown 笔记的完整内容替换预览，用户确认后才写回。',
		inputSchema: {
			type: 'object',
			required: ['path', 'content'],
			properties: {
				path: { type: 'string' },
				content: { type: 'string' },
				reason: { type: 'string' },
			},
		},
		plan: async (arguments_) => {
			const input = readUpdateInput(arguments_);
			const source = await vault.readNote(input.path);
			const preview = buildChangePreview(
				source,
				[createReplaceChange(source.content, 0, source.content.length, input.content)],
				input.reason || '按用户请求更新笔记内容。',
			);
			return {
				summary: `准备更新 ${source.path}`,
				changes: [{
					id: preview.id,
					summary: `${source.path}：校验版本后替换笔记内容`,
					preview,
				}],
				apply: async () => { await vault.update(preview); },
			};
		},
	}, {
		kind: 'mutation',
		name: 'editNote',
		description: '读取当前笔记后，生成基于唯一旧文本匹配的最小编辑预览；需要替换所有匹配位置时必须显式设置 replace_all。用户确认后才写回。',
		inputSchema: {
			type: 'object',
			required: ['path', 'old_string', 'new_string'],
			properties: {
				path: { type: 'string' },
				old_string: { type: 'string' },
				new_string: { type: 'string' },
				replace_all: { type: 'boolean' },
				reason: { type: 'string' },
			},
		},
		plan: async (arguments_) => {
			const input = readExactEditInput(arguments_);
			const source = await vault.readNote(input.path);
			const preview = buildChangePreview(
				source,
				createExactReplaceChanges(source.content, input.oldString, input.newString, input.replaceAll),
				input.reason || '按用户请求精确编辑笔记内容。',
			);
			return {
				summary: `准备精确编辑 ${source.path}`,
				changes: [{
					id: preview.id,
					summary: `${source.path}：校验版本后替换指定文本`,
					preview,
				}],
				apply: async () => { await vault.update(preview); },
			};
		},
	}];
}

function readUpdateInput(arguments_: unknown): { path: string; content: string; reason?: string } {
	if (!isRecord(arguments_)) throw new Error('工具参数必须是 JSON 对象');
	const path = readRequiredString(arguments_, 'path');
	if (path.startsWith('/') || path.includes('\\') || path.split('/').some((segment) => segment === '..')) {
		throw new Error('笔记路径必须是 Vault 内的相对路径');
	}
	if (typeof arguments_.content !== 'string') throw new Error('工具参数 content 必须是字符串');
	return {
		path,
		content: arguments_.content,
		reason: typeof arguments_.reason === 'string' ? arguments_.reason.trim() : undefined,
	};
}

function readExactEditInput(arguments_: unknown): {
	path: string;
	oldString: string;
	newString: string;
	replaceAll: boolean;
	reason?: string;
} {
	if (!isRecord(arguments_)) throw new Error('工具参数必须是 JSON 对象');
	const path = readVaultPath(arguments_);
	if (typeof arguments_.old_string !== 'string') throw new Error('工具参数 old_string 必须是字符串');
	if (typeof arguments_.new_string !== 'string') throw new Error('工具参数 new_string 必须是字符串');
	if (arguments_.replace_all !== undefined && typeof arguments_.replace_all !== 'boolean') {
		throw new Error('工具参数 replace_all 必须是布尔值');
	}
	return {
		path,
		oldString: arguments_.old_string,
		newString: arguments_.new_string,
		replaceAll: arguments_.replace_all === true,
		reason: typeof arguments_.reason === 'string' ? arguments_.reason.trim() : undefined,
	};
}

function readRequiredString(arguments_: Record<string, unknown>, key: string): string {
	const value = arguments_[key];
	if (typeof value !== 'string' || !value.trim()) throw new Error(`工具参数 ${key} 必须是非空字符串`);
	return value.trim();
}

function readVaultPath(arguments_: Record<string, unknown>): string {
	const path = readRequiredString(arguments_, 'path');
	if (path.startsWith('/') || path.includes('\\') || path.split('/').some((segment) => segment === '..')) {
		throw new Error('笔记路径必须是 Vault 内的相对路径');
	}
	return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
