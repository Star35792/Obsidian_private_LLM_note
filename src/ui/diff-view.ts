import { buildTextDiff, formatDiffStats } from '../changes/text-diff';
import type { DiffLineKind, TextDiff, TextDiffOptions } from '../changes/text-diff';

const LINE_PREFIX: Record<DiffLineKind, string> = {
	context: ' ',
	added: '+',
	removed: '-',
};

export interface DiffSelectionOptions extends TextDiffOptions {
	/** 勾选状态变化时回调，参数是仍然选中的 hunk 序号。 */
	onChange?: (selected: number[]) => void;
}

export interface DiffSelectionHandle {
	diff: TextDiff;
	/** 差异被截断或没有变更时无法逐处选择，只能整体确认。 */
	selectable: boolean;
	selected(): number[];
}

/** 在容器中渲染行级 diff，只用于展示；写回仍以 ChangePlan 的变更为准。 */
export function renderTextDiff(
	container: HTMLElement,
	original: string,
	proposed: string,
	options?: TextDiffOptions,
): TextDiff {
	return renderDiff(container, original, proposed, options ?? {}, false).diff;
}

/**
 * 渲染带勾选框的行级 diff，让用户逐处决定写回哪些变更。
 * 差异被截断时后续 hunk 并没有显示出来，逐处勾选会静默丢弃变更，因此改为只能整体确认。
 */
export function renderSelectableTextDiff(
	container: HTMLElement,
	original: string,
	proposed: string,
	options: DiffSelectionOptions = {},
): DiffSelectionHandle {
	return renderDiff(container, original, proposed, options, true);
}

function renderDiff(
	container: HTMLElement,
	original: string,
	proposed: string,
	options: DiffSelectionOptions,
	allowSelection: boolean,
): DiffSelectionHandle {
	const diff = buildTextDiff(original, proposed, options);
	const selectable = allowSelection && !diff.truncated && diff.hunks.length > 0;
	const selected = new Set(diff.hunks.map((_, index) => index));
	const wrapper = container.createDiv({ cls: 'ai-note-assistant-diff' });
	wrapper.createDiv({ text: formatDiffStats(diff), cls: 'ai-note-assistant-diff-stats' });
	for (const [index, hunk] of diff.hunks.entries()) {
		const hunkEl = wrapper.createDiv({ cls: 'ai-note-assistant-diff-hunk' });
		const header = hunkEl.createDiv({ cls: 'ai-note-assistant-diff-header' });
		if (selectable) {
			const label = header.createEl('label', { cls: 'ai-note-assistant-diff-toggle' });
			const toggle = label.createEl('input', {
				attr: { type: 'checkbox', 'aria-label': `写回第 ${index + 1} 处变更 ${hunk.header}` },
			});
			toggle.checked = true;
			label.createSpan({ text: `第 ${index + 1} 处 ${hunk.header}` });
			toggle.addEventListener('change', () => {
				if (toggle.checked) selected.add(index);
				else selected.delete(index);
				options.onChange?.(sortedSelection(selected));
			});
		} else {
			header.setText(hunk.header);
		}
		for (const line of hunk.lines) {
			hunkEl.createDiv({
				text: `${LINE_PREFIX[line.kind]}${line.text}`,
				cls: `ai-note-assistant-diff-line ai-note-assistant-diff-${line.kind}`,
			});
		}
	}
	if (diff.truncated) {
		wrapper.createDiv({
			text: allowSelection
				? '差异较长，仅显示前面的变更；未显示的变更无法单独勾选，只能整体确认写回。'
				: '差异较长，仅显示前面的变更；确认后仍会写回完整变更。',
			cls: 'ai-note-assistant-diff-note',
		});
	}
	return { diff, selectable, selected: () => sortedSelection(selected) };
}

function sortedSelection(selected: Set<number>): number[] {
	return [...selected].sort((left, right) => left - right);
}
