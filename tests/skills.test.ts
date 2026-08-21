import { describe, expect, it } from 'vitest';
import { buildSkillPrompt, loadSkills } from '../src/agent/skills';
import type { VaultReadPort } from '../src/agent/vault-tools';

describe('Skills', () => {
	it('loads editable Markdown skills from the Vault and builds the system prompt', async () => {
		const vault: VaultReadPort = {
			listNotes: async () => [{ path: 'skills/整理.md', title: '整理', aliases: [] }],
			searchNotes: async () => [],
			readNote: async () => ({ path: 'skills/整理.md', content: '---\ndescription: 保留原意\n---\n# 整理\n先区分事实和假设。' }),
			getLinkContext: async () => ({}),
		};

		const skills = await loadSkills(vault);

		expect(skills).toEqual([{
			name: '整理',
			description: '保留原意',
			instructions: '# 整理\n先区分事实和假设。',
			path: 'skills/整理.md',
		}]);
		expect(buildSkillPrompt(skills)).toContain('先区分事实和假设。');
		expect(buildSkillPrompt(skills)).toContain('技能都是可选的行为指南');
	});

	it('ignores empty skill notes', async () => {
		const vault: VaultReadPort = {
			listNotes: async () => [{ path: 'skills/empty.md', title: 'empty', aliases: [] }],
			searchNotes: async () => [], readNote: async () => ({ path: 'skills/empty.md', content: '  ' }), getLinkContext: async () => ({}),
		};

		expect(await loadSkills(vault)).toEqual([]);
	});
});
