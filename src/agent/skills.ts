import type { ReadOnlyAgentTool } from './agent-loop';
import type { VaultReadPort } from './vault-tools';

export interface AgentSkill {
	name: string;
	description: string;
	whenToUse: string;
	instructions: string;
	path: string;
	modelInvocable: boolean;
}

const LISTING_DESCRIPTION_MAX = 250;

export async function loadSkills(vault: VaultReadPort, scope = 'skills'): Promise<AgentSkill[]> {
	const refs = await vault.listNotes(scope);
	const skills = await Promise.all(refs.map(async (ref) => {
		const note = await vault.readNote(ref.path);
		return parseSkill(note.path, note.content, ref.title);
	}));
	return skills.filter((skill): skill is AgentSkill => skill !== undefined)
		.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Lists skills by name and purpose only. Bodies stay out of the system prompt so
 * the per-turn fixed cost does not grow with the number of skills; the model
 * pulls a body through `useSkill` when it decides the skill applies.
 */
export function buildSkillPrompt(skills: AgentSkill[]): string {
	const header = [
		'你是一个运行在 Obsidian Vault 内的 AI 笔记助手。',
		'保持用户原意；只读工具可以自动调用；任何写工具调用都只是生成预览，必须等待用户确认。',
		'用户消息不会自动附带活动笔记正文。活动笔记路径只是定位信息，不代表正文已经读取。',
		'需要查找事实或定位段落时，优先调用 searchNotes 获取少量关键词命中片段；只有确实需要理解全文或编辑笔记时才调用 readNote，并按 hasMore 和 nextOffset 分段读取。',
		'需要修改笔记时，先读取必要内容，再调用写工具生成变更预览；不要只在回复中粘贴一份建议版本来代替工具编辑。',
		'以下技能都是可选的行为指南；仅在用户请求相关时使用，不要强制套用，也不要要求用户先选择动作。',
		'只把可核对的原文依据作为整理依据，不要求或展示隐藏思维链。',
	];
	const invocable = skills.filter((skill) => skill.modelInvocable);
	if (invocable.length === 0) return header.join('\n');
	return [
		...header,
		'',
		'当前可用技能（正文保存在 Vault，需要时用 useSkill 读取，按用户编辑版本执行）：',
		...invocable.map((skill) => formatSkillListing(skill)),
	].join('\n');
}

export function createSkillTools(skills: AgentSkill[]): ReadOnlyAgentTool[] {
	const invocable = skills.filter((skill) => skill.modelInvocable);
	if (invocable.length === 0) return [];
	const byName = new Map(invocable.map((skill) => [skill.name.toLocaleLowerCase(), skill]));
	return [{
		kind: 'read-only',
		name: 'useSkill',
		description: `读取一个技能的完整指令正文。仅在系统提示的技能清单里判断某个技能与当前请求相关时调用。可用技能：${invocable.map((skill) => skill.name).join('、')}。`,
		inputSchema: {
			type: 'object',
			required: ['name'],
			properties: { name: { type: 'string' } },
		},
		execute: async (arguments_) => {
			const requested = readSkillName(arguments_);
			const skill = byName.get(requested.toLocaleLowerCase());
			if (!skill) {
				throw new Error(`找不到技能 ${requested}；可用技能：${invocable.map((item) => item.name).join('、')}`);
			}
			return {
				name: skill.name,
				path: skill.path,
				description: skill.description,
				instructions: skill.instructions,
			};
		},
	}];
}

function formatSkillListing(skill: AgentSkill): string {
	const lines = [`- ${skill.name}${skill.description ? `：${truncate(skill.description, LISTING_DESCRIPTION_MAX)}` : ''}`];
	if (skill.whenToUse) lines.push(`  何时使用：${truncate(skill.whenToUse, LISTING_DESCRIPTION_MAX)}`);
	lines.push(`  正文：useSkill({"name":"${skill.name}"})`);
	return lines.join('\n');
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
		whenToUse: metadata.whenToUse || '',
		instructions,
		path,
		modelInvocable: metadata.disableModelInvocation !== 'true',
	};
}

const METADATA_ALIASES: Record<string, string> = {
	'when-to-use': 'whenToUse',
	when_to_use: 'whenToUse',
	'disable-model-invocation': 'disableModelInvocation',
	disable_model_invocation: 'disableModelInvocation',
};

function parseMetadata(raw: string): Record<string, string> {
	const metadata: Record<string, string> = {};
	for (const line of raw.split(/\r?\n/)) {
		const match = line.match(/^([a-zA-Z][\w-]*):\s*(.+)$/);
		if (!match?.[1] || !match[2]) continue;
		const key = METADATA_ALIASES[match[1]] ?? match[1];
		metadata[key] = match[2].trim().replace(/^['"]|['"]$/g, '');
	}
	return metadata;
}

function firstHeading(content: string): string | undefined {
	return content.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function readSkillName(arguments_: unknown): string {
	if (typeof arguments_ !== 'object' || arguments_ === null || Array.isArray(arguments_)) {
		throw new Error('工具参数必须是 JSON 对象');
	}
	const value = (arguments_ as Record<string, unknown>).name;
	if (typeof value !== 'string' || !value.trim()) throw new Error('工具参数 name 必须是非空字符串');
	return value.trim();
}

function truncate(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
