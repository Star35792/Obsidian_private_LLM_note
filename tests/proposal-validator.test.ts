import { describe, expect, it } from 'vitest';
import { parseAssistantProposal, proposalToMarkdown } from '../src/core/proposal-validator';

describe('ProposalValidator', () => {
	it('accepts the structured organize response and renders Markdown locally', () => {
		const proposal = parseAssistantProposal(JSON.stringify({
			summary: '当前正在整理一个本地优先的笔记流程。',
			confirmed: ['希望保留原始记录。'],
			questions: ['哪些内容还没有验证？'],
			assumptions: ['假设本地模型暂时不可用。'],
			nextSteps: ['确认模型配置。'],
			classification: {
				type: '思考记录',
				tags: ['笔记整理'],
				reason: '内容包含过程性判断和待验证问题。',
			},
		}));

		expect(proposal.summary).toBe('当前正在整理一个本地优先的笔记流程。');
		expect(proposalToMarkdown(proposal)).toContain('## 一句话概括');
		expect(proposalToMarkdown(proposal)).toContain('- [ ] 确认模型配置。');
	});

	it('rejects malformed or incomplete model output', () => {
		expect(() => parseAssistantProposal('{"summary": 42}')).toThrow('模型返回的整理结果无效');
		expect(() => parseAssistantProposal('not json')).toThrow('模型返回的整理结果无效');
	});
});
