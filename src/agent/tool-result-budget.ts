/**
 * Bounds how much of a tool result can enter the conversation. A single
 * unbounded result (a long note, a whole-Vault listing) can consume the model
 * context by itself, which message-count based history compaction cannot
 * prevent. Truncation always states how to retrieve the rest.
 */
export interface ToolResultBudget {
	maxChars: number;
	previewChars: number;
}

export const DEFAULT_TOOL_RESULT_BUDGET: ToolResultBudget = {
	maxChars: 20_000,
	previewChars: 6_000,
};

export interface BudgetedToolResult {
	content: string;
	truncated: boolean;
	originalLength: number;
}

export function budgetToolResultText(
	toolName: string,
	text: string,
	budget: ToolResultBudget = DEFAULT_TOOL_RESULT_BUDGET,
): BudgetedToolResult {
	assertBudget(budget);
	if (text.length <= budget.maxChars) {
		return { content: text, truncated: false, originalLength: text.length };
	}
	const preview = sliceWholeCharacters(text, budget.previewChars);
	return {
		content: [
			`工具 ${toolName} 的结果有 ${text.length} 个字符，超过单条结果上限 ${budget.maxChars}，以下只保留前 ${preview.length} 个字符。`,
			`取回其余内容：读取长笔记用 readNote 的 offset 和 limit 逐段读取；搜索或列表结果过大时用更精确的 query、scope 或 limit 缩小范围。`,
			'',
			'[结果预览]',
			preview,
		].join('\n'),
		truncated: true,
		originalLength: text.length,
	};
}

/** Avoids cutting a surrogate pair in half, which would corrupt the preview. */
function sliceWholeCharacters(text: string, maxChars: number): string {
	const sliced = text.slice(0, maxChars);
	const lastCode = sliced.charCodeAt(sliced.length - 1);
	const isHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
	return isHighSurrogate ? sliced.slice(0, -1) : sliced;
}

function assertBudget(budget: ToolResultBudget): void {
	if (!Number.isInteger(budget.maxChars) || budget.maxChars < 1) {
		throw new Error('工具结果上限必须是正整数');
	}
	if (!Number.isInteger(budget.previewChars) || budget.previewChars < 1) {
		throw new Error('工具结果预览长度必须是正整数');
	}
	if (budget.previewChars > budget.maxChars) {
		throw new Error('工具结果预览长度不能超过结果上限');
	}
}
