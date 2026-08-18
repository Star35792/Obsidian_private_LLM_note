export interface ClassificationSuggestion {
	type?: string;
	tags: string[];
	reason: string;
}

export interface AssistantProposal {
	summary: string;
	confirmed: string[];
	questions: string[];
	assumptions: string[];
	nextSteps: string[];
	rationale: string[];
	classification?: ClassificationSuggestion;
}

const INVALID_PROPOSAL = '模型返回的整理结果无效';

export function parseAssistantProposal(raw: string): AssistantProposal {
	try {
		const normalized = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
		const value: unknown = JSON.parse(normalized);
		if (!isRecord(value) || typeof value.summary !== 'string' || value.summary.trim() === '') {
			throw new Error(INVALID_PROPOSAL);
		}

		const proposal: AssistantProposal = {
			summary: value.summary.trim(),
			confirmed: readStringArray(value.confirmed),
			questions: readStringArray(value.questions),
			assumptions: readStringArray(value.assumptions),
			nextSteps: readStringArray(value.nextSteps),
			rationale: readStringArray(value.rationale),
		};

		if (value.classification !== undefined) {
			if (!isRecord(value.classification) || typeof value.classification.reason !== 'string') {
				throw new Error(INVALID_PROPOSAL);
			}
			proposal.classification = {
				type: typeof value.classification.type === 'string' ? value.classification.type : undefined,
				tags: readStringArray(value.classification.tags),
				reason: value.classification.reason.trim(),
			};
		}
		return proposal;
	} catch {
		throw new Error(INVALID_PROPOSAL);
	}
}

export function proposalToMarkdown(proposal: AssistantProposal): string {
	const sections = [
		'## 一句话概括\n\n' + proposal.summary,
		formatListSection('已确认', proposal.confirmed),
		formatListSection('待澄清', [...proposal.questions, ...proposal.assumptions.map((item) => `未验证的假设：${item}`)]),
		proposal.classification ? formatClassification(proposal.classification) : '',
		formatListSection('整理依据', proposal.rationale),
		formatListSection('下一步', proposal.nextSteps),
	].filter(Boolean);
	return `${sections.join('\n\n')}\n`;
}

function formatListSection(title: string, items: string[]): string {
	if (items.length === 0) return '';
	const lines = items.map((item) => title === '下一步' ? `- [ ] ${item}` : `- ${item}`);
	return `## ${title}\n\n${lines.join('\n')}`;
}

function formatClassification(classification: ClassificationSuggestion): string {
	const lines = [
		classification.type ? `- 笔记类型：${classification.type}` : '',
		classification.tags.length > 0 ? `- 主题标签：${classification.tags.join('、')}` : '',
		`- 建议依据：${classification.reason}`,
	].filter(Boolean);
	return `## 分类建议\n\n${lines.join('\n')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item: unknown) => typeof item !== 'string')) {
		throw new Error(INVALID_PROPOSAL);
	}
	return value
		.filter((item: unknown): item is string => typeof item === 'string')
		.map((item: string) => item.trim())
		.filter(Boolean);
}
