/**
 * Validates the link suggestions a model returns and turns each accepted one
 * into a single-sentence change.
 *
 * Two invariants live here, because a prompt cannot enforce them:
 * the model never supplies offsets or line numbers — it quotes an anchor
 * sentence and the plugin locates it — and the rewritten sentence may only add
 * a Wiki Link, never reword the note. Anything else is rejected with a reason
 * the user can read, one suggestion at a time.
 */
import {
	buildChangePreview,
	createExactReplaceChanges,
	type ChangePreview,
	type NoteSnapshot,
} from '../changes/change-plan';

export type LinkRelation = 'supports' | 'contradicts' | 'extends' | 'background' | 'example' | 'related';
export type LinkConfidence = 'high' | 'medium';

export const RELATION_LABELS: Record<LinkRelation, string> = {
	supports: '支持',
	contradicts: '冲突',
	extends: '延伸',
	background: '背景',
	example: '例子',
	related: '相关',
};

export const CONFIDENCE_LABELS: Record<LinkConfidence, string> = {
	high: '高置信度',
	medium: '中置信度',
};

/** The minimum a candidate must expose to be linkable; `LinkBrief` satisfies it. */
export interface LinkSuggestionTarget {
	path: string;
	title: string;
	linkTarget: string;
}

export interface LinkSuggestion {
	targetPath: string;
	targetTitle: string;
	linkTarget: string;
	relation: LinkRelation;
	confidence: LinkConfidence;
	reason: string;
	evidence?: string;
	/** A sentence quoted verbatim from the source note. */
	anchor: string;
	/** The same sentence with a Wiki Link added. */
	anchorWithLink: string;
	/** `wrap` only linked existing words; `append` added a sentence after them. */
	mode: 'wrap' | 'append';
}

export interface RejectedLinkSuggestion {
	targetPath?: string;
	reason: string;
}

export interface LinkSuggestionResult {
	suggestions: LinkSuggestion[];
	rejected: RejectedLinkSuggestion[];
	/** Valid suggestions before the display limit was applied. */
	total: number;
	hasMore: boolean;
}

export interface ParseLinkSuggestionsOptions {
	targets: LinkSuggestionTarget[];
	sourceContent: string;
	limit?: number;
}

export const INVALID_LINK_SUGGESTIONS = '模型返回的关联建议无效';
export const DEFAULT_SUGGESTION_LIMIT = 5;

const RELATIONS = Object.keys(RELATION_LABELS) as LinkRelation[];
const WIKI_LINK = /\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|([^\]]*))?\]\]/g;

export function parseLinkSuggestions(raw: string, options: ParseLinkSuggestionsOptions): LinkSuggestionResult {
	const limit = options.limit ?? DEFAULT_SUGGESTION_LIMIT;
	if (!Number.isInteger(limit) || limit < 1) throw new Error('建议数量上限必须是正整数');

	const accepted: LinkSuggestion[] = [];
	const rejected: RejectedLinkSuggestion[] = [];
	for (const entry of readEntries(raw)) {
		const outcome = validateEntry(entry, options, accepted);
		if ('reason' in outcome) rejected.push(outcome);
		else accepted.push(outcome.suggestion);
	}

	return {
		suggestions: accepted.slice(0, limit),
		rejected,
		total: accepted.length,
		hasMore: accepted.length > limit,
	};
}

/** Rewrites `[[路径|显示]]` to the text a reader sees, so added links can be compared with the original sentence. */
export function reduceWikiLinks(text: string): string {
	return text.replace(WIKI_LINK, (_match, target: string, display?: string) => (
		display === undefined || display.trim() === '' ? target : display
	));
}

export function buildLinkSuggestionPreview(source: NoteSnapshot, suggestion: LinkSuggestion): ChangePreview {
	return buildChangePreview(
		source,
		createExactReplaceChanges(source.content, suggestion.anchor, suggestion.anchorWithLink),
		`加入指向「${suggestion.targetTitle}」的双链（关系：${RELATION_LABELS[suggestion.relation]}）：${suggestion.reason}`,
	);
}

function validateEntry(
	entry: unknown,
	options: ParseLinkSuggestionsOptions,
	accepted: LinkSuggestion[],
): { suggestion: LinkSuggestion } | RejectedLinkSuggestion {
	if (!isRecord(entry)) return { reason: '建议格式不正确' };
	const targetPath = readText(entry.targetPath);
	if (targetPath === undefined) return { reason: '缺少目标笔记路径' };
	const target = findTarget(options.targets, targetPath);
	if (!target) return { targetPath, reason: `目标笔记不在候选列表中：${targetPath}` };

	const relation = readText(entry.relation);
	if (relation === undefined || !isRelation(relation)) {
		return { targetPath: target.path, reason: `关系类型不在允许范围内：${relation ?? '缺失'}` };
	}
	const confidence = readText(entry.confidence)?.toLowerCase();
	if (confidence === 'low') return { targetPath: target.path, reason: '置信度过低，只展示 high 和 medium 的建议' };
	if (confidence !== 'high' && confidence !== 'medium') {
		return { targetPath: target.path, reason: `置信度不在允许范围内：${confidence ?? '缺失'}` };
	}
	const reason = readText(entry.reason);
	if (reason === undefined) return { targetPath: target.path, reason: '缺少可核对的理由' };

	const anchor = readText(entry.anchor);
	if (anchor === undefined) return { targetPath: target.path, reason: '缺少锚点句子' };
	const occurrences = countOccurrences(options.sourceContent, anchor);
	if (occurrences === 0) return { targetPath: target.path, reason: '锚点句子不在原文中，无法定位插入位置' };
	if (occurrences > 1) return { targetPath: target.path, reason: '锚点句子在原文中出现多次，无法唯一定位' };

	const anchorWithLink = readText(entry.anchorWithLink);
	if (anchorWithLink === undefined) return { targetPath: target.path, reason: '缺少加入链接后的句子' };
	const linkProblem = checkLink(anchorWithLink, target);
	if (linkProblem) return { targetPath: target.path, reason: linkProblem };

	const reduced = reduceWikiLinks(anchorWithLink);
	if (reduced !== anchor && !reduced.startsWith(anchor)) {
		return { targetPath: target.path, reason: '改写句子改动了原文内容，只允许加入链接' };
	}

	if (accepted.some((suggestion) => suggestion.targetPath === target.path)) {
		return { targetPath: target.path, reason: '同一目标笔记已有建议' };
	}
	if (accepted.some((suggestion) => overlaps(suggestion.anchor, anchor))) {
		return { targetPath: target.path, reason: '锚点句子与前一条建议重叠，先写回其中一条再重新生成' };
	}

	const evidence = readText(entry.evidence);
	return {
		suggestion: {
			targetPath: target.path,
			targetTitle: target.title,
			linkTarget: target.linkTarget,
			relation,
			confidence,
			reason,
			...(evidence === undefined ? {} : { evidence }),
			anchor,
			anchorWithLink,
			mode: reduced === anchor ? 'wrap' : 'append',
		},
	};
}

function readEntries(raw: string): unknown[] {
	let value: unknown;
	try {
		value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
	} catch {
		throw new Error(INVALID_LINK_SUGGESTIONS);
	}
	if (Array.isArray(value)) return value;
	if (isRecord(value) && Array.isArray(value.suggestions)) return value.suggestions;
	throw new Error(INVALID_LINK_SUGGESTIONS);
}

/**
 * Accepts the path, the path without `.md`, the suggested link text, or an
 * unambiguous title, because models quote targets in all four shapes.
 */
function findTarget(targets: LinkSuggestionTarget[], value: string): LinkSuggestionTarget | undefined {
	const wanted = normalize(value);
	const byPath = targets.find((target) => normalize(target.path) === wanted
		|| normalize(stripExtension(target.path)) === wanted
		|| normalize(target.linkTarget) === wanted);
	if (byPath) return byPath;
	const byTitle = targets.filter((target) => normalize(target.title) === wanted);
	return byTitle.length === 1 ? byTitle[0] : undefined;
}

function checkLink(anchorWithLink: string, target: LinkSuggestionTarget): string | undefined {
	const linked = [...anchorWithLink.matchAll(WIKI_LINK)].map((match) => normalize(match[1] ?? ''));
	const wanted = new Set([target.linkTarget, stripExtension(target.path), target.path].map(normalize));
	if (linked.some((link) => wanted.has(link))) return undefined;
	if (linked.includes(normalize(target.title))) {
		return `同名笔记必须使用完整路径链接：${target.linkTarget}`;
	}
	return '改写句子里没有指向该笔记的链接';
}

/** Two anchors on the same sentence cannot both be applied, since the first rewrite removes the second's anchor. */
function overlaps(left: string, right: string): boolean {
	return left.includes(right) || right.includes(left);
}

function countOccurrences(content: string, text: string): number {
	let count = 0;
	let from = content.indexOf(text);
	while (from !== -1) {
		count += 1;
		from = content.indexOf(text, from + text.length);
	}
	return count;
}

function isRelation(value: string): value is LinkRelation {
	return (RELATIONS as string[]).includes(value);
}

function readText(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalize(value: string): string {
	return value.trim().toLocaleLowerCase();
}

function stripExtension(path: string): string {
	return path.replace(/\.md$/i, '');
}
