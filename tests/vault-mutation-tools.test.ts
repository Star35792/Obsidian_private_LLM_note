import { describe, expect, it } from 'vitest';
import { createVaultMutationTools, type VaultMutationPort } from '../src/agent/vault-mutation-tools';
import { buildTextDiff } from '../src/changes/text-diff';
import { buildHunkSelectionPreview } from '../src/changes/hunk-selection';
import type { ChangePreview } from '../src/changes/change-plan';

describe('Vault mutation tools', () => {
	it('plans a version-checked replacement and applies only after confirmation', async () => {
		const updates: unknown[] = [];
		const source = { path: '想法.md', content: '原文' };
		const vault: VaultMutationPort = {
			listNotes: async () => [], searchNotes: async () => [], readNote: async () => source,
			getLinkContext: async () => ({}), update: async (preview) => { updates.push(preview); return { path: preview.path, content: preview.proposedContent }; },
		};
		const tool = createVaultMutationTools(vault)[0]!;

		const plan = await tool.plan({ path: '想法.md', content: '整理后', reason: '追加整理结果' });

		expect(plan.summary).toBe('准备更新 想法.md');
		expect(plan.changes[0]?.preview?.proposedContent).toBe('整理后');
		expect(updates).toHaveLength(0);
		await plan.apply?.();
		expect(updates).toHaveLength(1);
	});

	it('rejects paths outside the Vault', async () => {
		const vault: VaultMutationPort = {
			listNotes: async () => [], searchNotes: async () => [], readNote: async () => ({ path: 'x.md', content: '' }),
			getLinkContext: async () => ({}), update: async () => ({ path: 'x.md', content: '' }),
		};
		const tool = createVaultMutationTools(vault)[0]!;

		await expect(tool.plan({ path: '../secret.md', content: 'x' })).rejects.toThrow('Vault 内');
	});

	it('plans an exact replacement only after reading the current note', async () => {
		const updates: unknown[] = [];
		const source = { path: '想法.md', content: '# 标题\n旧段落\n结尾' };
		const vault: VaultMutationPort = {
			listNotes: async () => [], searchNotes: async () => [], readNote: async () => source,
			getLinkContext: async () => ({}), update: async (preview) => { updates.push(preview); return { path: preview.path, content: preview.proposedContent }; },
		};
		const tool = createVaultMutationTools(vault).find(({ name }) => name === 'editNote');
		expect(tool).toBeDefined();

		const plan = await tool!.plan({ path: '想法.md', old_string: '旧段落', new_string: '新段落' });

		expect(plan.changes[0]?.preview?.proposedContent).toBe('# 标题\n新段落\n结尾');
		expect(updates).toHaveLength(0);
		await plan.apply?.();
		expect(updates).toHaveLength(1);
	});

	it('rejects an ambiguous exact replacement without replace_all', async () => {
		const vault: VaultMutationPort = {
			listNotes: async () => [], searchNotes: async () => [], readNote: async () => ({ path: '想法.md', content: '旧段落\n旧段落' }),
			getLinkContext: async () => ({}), update: async () => ({ path: '想法.md', content: '' }),
		};
		const tool = createVaultMutationTools(vault).find(({ name }) => name === 'editNote');
		expect(tool).toBeDefined();

		await expect(tool!.plan({ path: '想法.md', old_string: '旧段落', new_string: '新段落' })).rejects.toThrow('匹配到 2 处');
	});

	it('writes back only the selected hunk through the same version-checked path', async () => {
		const updates: ChangePreview[] = [];
		const lines = Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 行`);
		const source = { path: '想法.md', content: lines.join('\n') };
		const vault: VaultMutationPort = {
			listNotes: async () => [], searchNotes: async () => [], readNote: async () => source,
			getLinkContext: async () => ({}), update: async (preview) => { updates.push(preview); return { path: preview.path, content: preview.proposedContent }; },
		};
		const tool = createVaultMutationTools(vault)[0]!;
		const proposed = lines.map((line, index) => (index === 1 ? '开头改写' : index === 27 ? '结尾改写' : line)).join('\n');

		const plan = await tool.plan({ path: '想法.md', content: proposed });
		const change = plan.changes[0]!;
		const diff = buildTextDiff(source.content, proposed);
		await change.applyPreview?.(buildHunkSelectionPreview(change.preview!, diff, [0]));

		expect(change.applyPreview).toBeDefined();
		expect(updates).toHaveLength(1);
		expect(updates[0]?.expectedRevision).toBe(change.preview?.expectedRevision);
		expect(updates[0]?.proposedContent.split('\n')[1]).toBe('开头改写');
		expect(updates[0]?.proposedContent.split('\n')[27]).toBe('第 28 行');
	});
});
