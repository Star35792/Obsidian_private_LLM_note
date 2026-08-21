import { describe, expect, it } from 'vitest';
import { budgetToolResultText, DEFAULT_TOOL_RESULT_BUDGET } from '../src/agent/tool-result-budget';

describe('budgetToolResultText', () => {
	it('passes a result under the limit through unchanged', () => {
		const text = '{"content":"短笔记"}';
		const result = budgetToolResultText('readNote', text);

		expect(result).toEqual({ content: text, truncated: false, originalLength: text.length });
	});

	it('truncates an oversized result and explains how to retrieve the rest', () => {
		const text = '段'.repeat(1000);
		const result = budgetToolResultText('readNote', text, { maxChars: 300, previewChars: 100 });

		expect(result.truncated).toBe(true);
		expect(result.originalLength).toBe(1000);
		expect(result.content).toContain('工具 readNote 的结果有 1000 个字符');
		expect(result.content).toContain('超过单条结果上限 300');
		expect(result.content).toContain('readNote 的 offset 和 limit');
		expect(result.content).toContain('[结果预览]');
		expect(result.content.endsWith('段'.repeat(100))).toBe(true);
	});

	it('never splits a surrogate pair in the preview', () => {
		const text = '🙂'.repeat(50);
		const result = budgetToolResultText('searchNotes', text, { maxChars: 10, previewChars: 5 });
		const preview = result.content.split('[结果预览]\n')[1] ?? '';

		expect(preview).toBe('🙂🙂');
		expect([...preview]).toHaveLength(2);
	});

	it('rejects an invalid budget', () => {
		expect(() => budgetToolResultText('readNote', '内容', { maxChars: 0, previewChars: 1 }))
			.toThrow('工具结果上限必须是正整数');
		expect(() => budgetToolResultText('readNote', '内容', { maxChars: 10, previewChars: 0 }))
			.toThrow('工具结果预览长度必须是正整数');
		expect(() => budgetToolResultText('readNote', '内容', { maxChars: 10, previewChars: 20 }))
			.toThrow('工具结果预览长度不能超过结果上限');
	});

	it('keeps the default preview smaller than the default limit', () => {
		expect(DEFAULT_TOOL_RESULT_BUDGET.previewChars).toBeLessThan(DEFAULT_TOOL_RESULT_BUDGET.maxChars);
	});
});
