import type { ModelCompletionOptions, ModelPort } from '../model/model-port';
import {
	parseAssistantProposal,
	proposalToMarkdown,
	type AssistantProposal,
} from './proposal-validator';

export interface OrganizeRequest {
	content: string;
	additionalInstructions?: string;
}

export interface OrganizeResult {
	proposal: AssistantProposal;
	markdown: string;
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
}
