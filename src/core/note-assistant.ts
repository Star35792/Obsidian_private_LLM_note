import type { ModelCompletionOptions, ModelPort } from '../model/model-port';
import {
	parseAssistantProposal,
	proposalToMarkdown,
	type AssistantProposal,
} from './proposal-validator';
import {
	parseLinkSuggestions,
	type LinkSuggestionResult,
} from '../links/link-suggestion';
import type { LinkBrief } from '../links/link-brief';

export interface OrganizeRequest {
	content: string;
	additionalInstructions?: string;
}

export interface OrganizeResult {
	proposal: AssistantProposal;
	markdown: string;
	streamed: boolean;
}

export interface SuggestLinksRequest {
	sourceContent: string;
	/** Bounded excerpts of the local candidates; nothing else about them is sent. */
	briefs: LinkBrief[];
	limit?: number;
}

export interface SuggestLinksResult extends LinkSuggestionResult {
	streamed: boolean;
}

export class NoteAssistant {
	private readonly model: ModelPort;

	constructor(model: ModelPort) {
		this.model = model;
	}

	async organize(request: OrganizeRequest, options?: ModelCompletionOptions): Promise<OrganizeResult> {
		const response = await this.model.complete({
			system: [
				'你是一个尊重用户原意的 AI 笔记整理助手。',
				'只返回合法 JSON，不要使用 Markdown 代码围栏。',
				'JSON 必须包含 summary、confirmed、questions、assumptions、nextSteps、rationale 六个字段，数组字段只能包含字符串。',
				'rationale 只简要说明整理结果依据了原文中的哪些可核对内容，不要输出隐藏思维链。',
				'可选 classification 对象包含 type、tags、reason。不能把推测写成事实。',
			].join('\n'),
			user: [
				'请整理下面的笔记，区分事实、判断、未验证假设、待澄清问题和下一步。',
				request.additionalInstructions ? `用户补充要求：${request.additionalInstructions}` : '',
				'笔记内容开始',
				'---',
				request.content,
				'---',
				'笔记内容结束',
			].filter(Boolean).join('\n'),
		}, options);
		const proposal = parseAssistantProposal(response.content);
		return { proposal, markdown: proposalToMarkdown(proposal), streamed: response.streamed };
	}

	/**
	 * Judges the relation between the current note and the local candidates. The
	 * model quotes an anchor sentence instead of giving offsets, and may only add
	 * a Wiki Link to it; `parseLinkSuggestions` enforces both.
	 */
	async suggestLinks(request: SuggestLinksRequest, options?: ModelCompletionOptions): Promise<SuggestLinksResult> {
		const response = await this.model.complete({
			system: [
				'你是一个尊重用户原意的 AI 笔记助手，任务是判断当前笔记和候选笔记之间的关系，并给出可以直接写回的双链。',
				'只返回合法 JSON，不要使用 Markdown 代码围栏。顶层是 {"suggestions": [...]}。',
				'每条建议包含 targetPath、relation、confidence、reason、evidence、anchor、anchorWithLink。',
				'relation 只能是 supports、contradicts、extends、background、example、related。',
				'confidence 只能是 high、medium、low；没有把握就用 low，插件不会展示 low。',
				'reason 说明为什么相关，evidence 引用双方可核对的原文，不要输出隐藏思维链。',
				'anchor 是锚点句子：必须从当前笔记里逐字复制一句话，且在全文中唯一；不要给行号或字符偏移。',
				'anchorWithLink 是同一句锚点句子加入 [[链接]] 之后的样子：只能加链接，不能改写、删减或重排原文用词。',
				'链接文本必须使用候选给出的 linkTarget 原样填写；ambiguous 为 true 的候选必须用完整路径。',
				'只使用候选列表里的笔记，不要凭空创造目标；关系不明显时宁可不给建议。',
			].join('\n'),
			user: [
				'请判断当前笔记与每个候选笔记的关系，并给出可以写回的双链建议。',
				'当前笔记开始',
				'---',
				request.sourceContent,
				'---',
				'当前笔记结束',
				'候选笔记（JSON 数组；truncated 为 true 表示 excerpt 只是这篇笔记的开头）：',
				JSON.stringify(request.briefs),
			].join('\n'),
		}, options);
		const result = parseLinkSuggestions(response.content, {
			targets: request.briefs,
			sourceContent: request.sourceContent,
			...(request.limit === undefined ? {} : { limit: request.limit }),
		});
		return { ...result, streamed: response.streamed };
	}
}
