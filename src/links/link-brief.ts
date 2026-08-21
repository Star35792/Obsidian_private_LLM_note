/**
 * Turns local link candidates into the bounded excerpts that may leave the
 * Vault. Candidate discovery ([[link-context]]) is local and free; this module
 * decides how much of each candidate a remote model gets to see, so every
 * excerpt is explicitly capped and marked when it was cut.
 */
import type { LinkCandidate, LinkSignal } from './link-context';

export interface LinkBrief {
	path: string;
	title: string;
	/** Text to put inside `[[ ]]`, already disambiguated by `collectLinkContext`. */
	linkTarget: string;
	ambiguous: boolean;
	signals: LinkSignal[];
	excerpt: string;
	/** True when the excerpt is only the beginning of the note. */
	truncated: boolean;
	sharedTags?: string[];
	mention?: string;
}

export interface LinkBriefInput {
	candidate: LinkCandidate;
	content: string;
}

export interface LinkBriefOptions {
	limit?: number;
	maxChars?: number;
}

export const DEFAULT_BRIEF_EXCERPT_CHARS = 400;
export const DEFAULT_MODEL_CANDIDATE_LIMIT = 8;

const SENTENCE_ENDINGS = ['。', '！', '？', '；', '.', '!', '?', ';'];

export function buildLinkBriefs(inputs: LinkBriefInput[], options: LinkBriefOptions = {}): LinkBrief[] {
	const limit = options.limit ?? DEFAULT_MODEL_CANDIDATE_LIMIT;
	if (!Number.isInteger(limit) || limit < 1) throw new Error('候选片段数量上限必须是正整数');
	return inputs
		.slice(0, limit)
		.map((input) => buildLinkBrief(input.candidate, input.content, options.maxChars));
}

export function buildLinkBrief(
	candidate: LinkCandidate,
	content: string,
	maxChars: number = DEFAULT_BRIEF_EXCERPT_CHARS,
): LinkBrief {
	if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('片段字符上限必须是正整数');
	const body = normalizeBody(content);
	const excerpt = body.length <= maxChars ? body : cutExcerpt(body, maxChars);
	return {
		path: candidate.target.path,
		title: candidate.target.title,
		linkTarget: candidate.linkTarget,
		ambiguous: candidate.ambiguous,
		signals: candidate.signals,
		excerpt,
		truncated: excerpt.length < body.length,
		...(candidate.sharedTags ? { sharedTags: candidate.sharedTags } : {}),
		...(candidate.mention === undefined ? {} : { mention: candidate.mention }),
	};
}

/**
 * Drops a leading YAML frontmatter block together with the blank lines that
 * follow it. An unclosed block is left alone: it is more likely a note that
 * starts with a horizontal rule than metadata.
 */
export function stripFrontmatter(content: string): string {
	const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:(?:\r?\n)+|$)/.exec(content);
	return match ? content.slice(match[0].length) : content;
}

function normalizeBody(content: string): string {
	return stripFrontmatter(content)
		.replace(/\r\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** Prefers a line break, then a sentence ending, then a hard cut. */
function cutExcerpt(body: string, maxChars: number): string {
	const window = body.slice(0, maxChars);
	const lineBreak = window.lastIndexOf('\n');
	if (lineBreak > 0) return window.slice(0, lineBreak).trimEnd();
	const sentenceEnd = Math.max(...SENTENCE_ENDINGS.map((ending) => window.lastIndexOf(ending)));
	if (sentenceEnd > 0) return window.slice(0, sentenceEnd + 1);
	return window;
}
