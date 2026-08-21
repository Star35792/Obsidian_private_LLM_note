import { describe, expect, it } from 'vitest';
import { buildSkillPrompt, createSkillTools, loadSkills } from '../src/agent/skills';
import type { VaultReadPort } from '../src/agent/vault-tools';

describe('Skills', () => {
	it('loads editable Markdown skills from the Vault', async () => {
		const vault = skillVault([{
			path: 'skills/整理.md',
			content: '---\ndescription: 保留原意\nwhen-to-use: 用户要求整理笔记时\n---\n# 整理\n先区分事实和假设。',
		}]);

		expect(await loadSkills(vault)).toEqual([{
			name: '整理',
			description: '保留原意',
			whenToUse: '用户要求整理笔记时',
			instructions: '# 整理\n先区分事实和假设。',
			path: 'skills/整理.md',
			modelInvocable: true,
		}]);
	});

	it('lists skills in the system prompt without including their bodies', async () => {
		const skills = await loadSkills(skillVault([{
			path: 'skills/整理.md',
			content: '---\ndescription: 保留原意\nwhen-to-use: 用户要求整理笔记时\n---\n# 整理\n先区分事实和假设。',
		}]));
		const prompt = buildSkillPrompt(skills);

		expect(prompt).toContain('技能都是可选的行为指南');
		expect(prompt).toContain('- 整理：保留原意');
		expect(prompt).toContain('何时使用：用户要求整理笔记时');
		expect(prompt).toContain('useSkill({"name":"整理"})');
		expect(prompt).not.toContain('先区分事实和假设。');
	});

	it('hides skills that opt out of model invocation', async () => {
		const skills = await loadSkills(skillVault([{
			path: 'skills/手动.md',
			content: '---\nname: 手动\ndisable-model-invocation: true\n---\n只在用户点按时使用。',
		}]));

		expect(skills[0]?.modelInvocable).toBe(false);
		expect(buildSkillPrompt(skills)).not.toContain('手动');
		expect(createSkillTools(skills)).toEqual([]);
	});

	it('returns a skill body on demand through useSkill', async () => {
		const skills = await loadSkills(skillVault([{
			path: 'skills/整理.md',
			content: '---\ndescription: 保留原意\n---\n# 整理\n先区分事实和假设。',
		}]));
		const tools = createSkillTools(skills);

		expect(tools.map((tool) => [tool.name, tool.kind])).toEqual([['useSkill', 'read-only']]);
		expect(await tools[0]!.execute({ name: '整理' })).toEqual({
			name: '整理',
			path: 'skills/整理.md',
			description: '保留原意',
			instructions: '# 整理\n先区分事实和假设。',
		});
		await expect(tools[0]!.execute({ name: '不存在' })).rejects.toThrow('找不到技能 不存在');
		await expect(tools[0]!.execute({})).rejects.toThrow('name');
	});

	it('ignores empty skill notes', async () => {
		expect(await loadSkills(skillVault([{ path: 'skills/empty.md', content: '  ' }]))).toEqual([]);
	});
});

function skillVault(notes: Array<{ path: string; content: string }>): VaultReadPort {
	const byPath = new Map(notes.map((note) => [note.path, note.content]));
	return {
		listNotes: async () => notes.map((note) => ({
			path: note.path,
			title: note.path.replace(/^.*\//, '').replace(/\.md$/, ''),
			aliases: [],
		})),
		searchNotes: async () => [],
		readNote: async (path) => ({ path, content: byPath.get(path) ?? '' }),
		getLinkContext: async () => ({}),
	};
}
