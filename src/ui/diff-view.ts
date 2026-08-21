import { buildTextDiff, formatDiffStats } from '../changes/text-diff';
import type { DiffLineKind, TextDiff, TextDiffOptions } from '../changes/text-diff';

const LINE_PREFIX: Record<DiffLineKind, string> = {
	context: ' ',
	added: '+',
	removed: '-',
};

/** 在容器中渲染行级 diff，只用于展示；写回仍以 ChangePlan 的变更为准。 */
export function renderTextDiff(
	container: HTMLElement,
	original: string,
	proposed: string,
	options?: TextDiffOptions,
): TextDiff {
	const diff = buildTextDiff(original, proposed, options);
	const wrapper = container.createDiv({ cls: 'ai-note-assistant-diff' });
	wrapper.createDiv({ text: formatDiffStats(diff), cls: 'ai-note-assistant-diff-stats' });
	for (const hunk of diff.hunks) {
		const hunkEl = wrapper.createDiv({ cls: 'ai-note-assistant-diff-hunk' });
		hunkEl.createDiv({ text: hunk.header, cls: 'ai-note-assistant-diff-header' });
		for (const line of hunk.lines) {
			hunkEl.createDiv({
				text: `${LINE_PREFIX[line.kind]}${line.text}`,
				cls: `ai-note-assistant-diff-line ai-note-assistant-diff-${line.kind}`,
			});
		}
	}
	if (diff.truncated) {
		wrapper.createDiv({
			text: '差异较长，仅显示前面的变更；确认后仍会写回完整变更。',
			cls: 'ai-note-assistant-diff-note',
		});
	}
	return diff;
}
