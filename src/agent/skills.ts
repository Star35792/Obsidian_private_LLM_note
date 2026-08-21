import type { VaultReadPort } from './vault-tools';

export interface AgentSkill {
	name: string;
	description: string;
	instructions: string;
	path: string;
}

export async function loadSkills(vault: VaultReadPort, scope = 'skills'): Promise<AgentSkill[]> {
	const refs = await vault.listNotes(scope);
	const skills = await Promise.all(refs.map(async (ref) => {
		const note = await vault.readNote(ref.path);
		return parseSkill(note.path, note.content, ref.title);
	}));
	return skills.filter((skill): skill is AgentSkill => skill !== undefined)
		.sort((left, right) => left.name.localeCompare(right.name));
}

export function buildSkillPrompt(skills: AgentSkill[]): string {
	const header = [
		'你是一个运行在 Obsidian Vault 内的 AI 笔记助手。',
		'保持用户原意；只读工具可以自动调用；任何写工具调用都只是生成预览，必须等待用户确认。',
		'用户消息不会自动附带活动笔记正文。活动笔记路径只是定位信息，不代表正文已经读取。',
		'需要查找事实或定位段落时，优先调用 searchNotes 获取少量关键词命中片段；只有确实需要理解全文或编辑笔记时才调用 readNote。',
		'需要修改笔记时，先读取必要内容，再调用写工具生成变更预览；不要只在回复中粘贴一份建议版本来代替工具编辑。',
		'以下技能都是可选的行为指南；仅在用户请求相关时使用，不要强制套用，也不要要求用户先选择动作。',
		'只把可核对的原文依据作为整理依据，不要求或展示隐藏思维链。',
	];
	if (skills.length === 0) return header.join('\n');
	return [...header, '', '当前可用技能（技能内容来自 Vault，按用户编辑版本执行）：', ...skills.map((skill) => [
		`## ${skill.name}`,
		skill.description ? `说明：${skill.description}` : '',
		skill.instructions,
	].filter(Boolean).join('\n'))].join('\n\n');
}

function parseSkill(path: string, content: string, fallbackName: string): AgentSkill | undefined {
	const body = content.trim();
	if (!body) return undefined;
	const frontmatter = body.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
	const metadata = frontmatter ? parseMetadata(frontmatter[1] ?? '') : {};
	const instructions = (frontmatter ? body.slice(frontmatter[0].length) : body).trim();
	if (!instructions) return undefined;
	return {
		name: metadata.name || firstHeading(instructions) || fallbackName,
		description: metadata.description || '',
		instructions,
		path,
	};
}

function parseMetadata(raw: string): Record<string, string> {
	const metadata: Record<string, string> = {};
	for (const line of raw.split(/\r?\n/)) {
		const match = line.match(/^([a-zA-Z][\w-]*):\s*(.+)$/);
		if (match?.[1] && match[2]) metadata[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
	}
	return metadata;
}

function firstHeading(content: string): string | undefined {
	return content.match(/^#\s+(.+)$/m)?.[1]?.trim();
}
