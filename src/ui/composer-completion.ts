/** 触发类型：`/` 唤醒命令与技能，`@` 唤醒笔记与文件夹。 */
export type CompletionKind = 'command' | 'mention';

export interface CompletionRequest {
	kind: CompletionKind;
	/** 触发符之后、光标之前已经输入的内容。 */
	query: string;
	/** 触发符在文本中的下标；补全时这一段整体被替换。 */
	start: number;
	/** 光标位置。 */
	end: number;
}

export interface CompletionCandidate {
	/** 补全后写进输入框的内容（不含触发符与引号）。 */
	value: string;
	label: string;
	description?: string;
	isFolder?: boolean;
}

const COMMAND_PREFIX = /^(\s*)\/([^\s/]*)$/;
/** 引号也算分隔符，这样 `@"带 空格/的路径"` 之后的 `@` 仍能独立触发。 */
const MENTION_DELIMITERS = new Set([' ', '\t', '\n', '\r', '"', "'"]);

/**
 * Only looks at the text before the cursor, so a completion stays available
 * while the user edits the middle of a message. A command trigger must be the
 * first token of the message; a mention trigger must start a word, otherwise
 * text such as an email address would open the note list.
 */
export function detectCompletion(text: string, cursor: number): CompletionRequest | undefined {
	const before = text.slice(0, Math.max(0, Math.min(cursor, text.length)));
	const mention = detectMention(before);
	if (mention) return mention;
	const command = COMMAND_PREFIX.exec(before);
	if (!command) return undefined;
	return { kind: 'command', query: command[2] ?? '', start: (command[1] ?? '').length, end: before.length };
}

export function rankCompletionCandidates(
	candidates: readonly CompletionCandidate[],
	query: string,
	limit = 30,
): CompletionCandidate[] {
	const normalized = query.trim().toLocaleLowerCase();
	const scored: Array<{ candidate: CompletionCandidate; score: number }> = [];
	for (const candidate of candidates) {
		const score = scoreCandidate(candidate, normalized);
		if (score > 0) scored.push({ candidate, score });
	}
	scored.sort((left, right) => (
		right.score - left.score
		|| Number(right.candidate.isFolder ?? false) - Number(left.candidate.isFolder ?? false)
		|| left.candidate.value.length - right.candidate.value.length
		|| left.candidate.value.localeCompare(right.candidate.value)
	));
	return scored.slice(0, limit).map((entry) => entry.candidate);
}

/**
 * Replaces the trigger and everything typed after it with the chosen candidate.
 * A space follows the token so the next word does not merge into the path; when
 * one is already there it is reused instead of doubled.
 */
export function applyCompletion(
	text: string,
	request: CompletionRequest,
	candidate: CompletionCandidate,
): { text: string; cursor: number } {
	const token = request.kind === 'command'
		? `/${candidate.value}`
		: `@${quoteIfNeeded(candidate.value)}`;
	const before = text.slice(0, request.start);
	const after = text.slice(request.end);
	const spaceFollows = /^[ \t]/.test(after);
	return {
		text: `${before}${token}${spaceFollows ? '' : ' '}${after}`,
		cursor: before.length + token.length + 1,
	};
}

function detectMention(before: string): CompletionRequest | undefined {
	const quoted = detectQuotedMention(before);
	if (quoted) return quoted;
	let start = 0;
	for (let index = before.length - 1; index >= 0; index -= 1) {
		if (MENTION_DELIMITERS.has(before[index] ?? '')) {
			start = index + 1;
			break;
		}
	}
	if (before[start] !== '@') return undefined;
	return { kind: 'mention', query: before.slice(start + 1), start, end: before.length };
}

function detectQuotedMention(before: string): CompletionRequest | undefined {
	const start = before.lastIndexOf('@"');
	if (start < 0) return undefined;
	if (start > 0 && !MENTION_DELIMITERS.has(before[start - 1] ?? '')) return undefined;
	// A closing quote ends the mention, so the text after it is ordinary input.
	if (before.includes('"', start + 2)) return undefined;
	return { kind: 'mention', query: before.slice(start + 2), start, end: before.length };
}

function scoreCandidate(candidate: CompletionCandidate, query: string): number {
	const path = candidate.value.replace(/\/$/, '');
	if (query === '') return (candidate.isFolder ? 120 : 100) - (path.split('/').length - 1);
	const lowerPath = path.toLocaleLowerCase();
	const base = lowerPath.slice(lowerPath.lastIndexOf('/') + 1);
	if (base === query) return 100;
	if (base.startsWith(query)) return 80;
	if (base.includes(query)) return 50;
	if (lowerPath.includes(query)) return 30;
	return 0;
}

function quoteIfNeeded(value: string): string {
	return /[\s"]/.test(value) ? `"${value}"` : value;
}
