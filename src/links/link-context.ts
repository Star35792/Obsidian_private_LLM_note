/**
 * Collects a small, explainable set of link candidates from Obsidian's local
 * metadata only. Nothing here calls a model: the whole point is that candidate
 * discovery happens before anything leaves the Vault, and that every candidate
 * carries the signals that put it on the list so the user can check the ranking.
 */
export interface LinkNote {
	path: string;
	title: string;
	aliases: string[];
	tags: string[];
}

export interface LinkGraph {
	source: LinkNote;
	sourceContent: string;
	/** Every note considered a possible target; may include the source itself. */
	notes: LinkNote[];
	/** Resolved forward links, keyed by source path. */
	links: Record<string, string[]>;
	/** Link texts in the source that resolve to no file yet. */
	unresolvedFromSource: string[];
	/** Paths already found by a keyword search, used as the weakest signal. */
	keywordHits: string[];
}

export type LinkSignal = 'unlinked-mention' | 'backlink' | 'shared-neighbor' | 'shared-tag' | 'keyword-hit';

export interface LinkCandidate {
	target: LinkNote;
	score: number;
	signals: LinkSignal[];
	/** Text to put inside `[[ ]]`: the title when unique, otherwise the full path. */
	linkTarget: string;
	ambiguous: boolean;
	sameTitlePaths?: string[];
	mention?: string;
	sharedTags?: string[];
}

export interface LinkContextOptions {
	limit?: number;
	/** Depth 1 uses direct signals only; depth 2 also uses two-hop neighbours. */
	depth?: number;
}

export interface LinkContextResult {
	source: LinkNote;
	depth: number;
	outgoing: LinkNote[];
	incoming: LinkNote[];
	candidates: LinkCandidate[];
	totalCandidates: number;
	hasMore: boolean;
	/** How many notes were dropped because the source already links to them. */
	skippedLinked: number;
}

export const DEFAULT_LINK_CANDIDATE_LIMIT = 20;
const MIN_MENTION_LENGTH = 2;
const SIGNAL_WEIGHTS: Record<LinkSignal, number> = {
	'unlinked-mention': 5,
	backlink: 3,
	'shared-neighbor': 2,
	'shared-tag': 2,
	'keyword-hit': 1,
};

export function collectLinkContext(graph: LinkGraph, options: LinkContextOptions = {}): LinkContextResult {
	const limit = options.limit ?? DEFAULT_LINK_CANDIDATE_LIMIT;
	if (!Number.isInteger(limit) || limit < 1) throw new Error('候选上限必须是正整数');
	const depth = options.depth ?? 1;
	if (!Number.isInteger(depth) || depth < 1 || depth > 2) throw new Error('关联深度必须是 1 或 2');

	const byPath = new Map(graph.notes.map((note) => [note.path, note]));
	const outgoing = graph.links[graph.source.path] ?? [];
	const incoming = Object.entries(graph.links)
		.filter(([from, targets]) => from !== graph.source.path && targets.includes(graph.source.path))
		.map(([from]) => from);
	const linkedPaths = new Set(outgoing);
	const unresolvedNames = new Set(graph.unresolvedFromSource.map((name) => normalize(name)));
	const titleCounts = countTitles(graph.notes);
	const mentionText = stripWikiLinks(graph.sourceContent).toLocaleLowerCase();
	const sourceTags = new Set(graph.source.tags.map((tag) => normalize(tag)));
	const neighbors = new Set([...outgoing, ...incoming]);
	const keywordHits = new Set(graph.keywordHits);

	let skippedLinked = 0;
	const candidates: LinkCandidate[] = [];
	for (const note of graph.notes) {
		if (note.path === graph.source.path) continue;
		if (linkedPaths.has(note.path) || namesLinkedByText(note, unresolvedNames)) {
			skippedLinked += 1;
			continue;
		}

		const signals: LinkSignal[] = [];
		const mention = findMention(note, mentionText);
		if (mention !== undefined) signals.push('unlinked-mention');
		if (incoming.includes(note.path)) signals.push('backlink');
		if (depth >= 2 && sharesNeighbor(note.path, graph.links, neighbors)) signals.push('shared-neighbor');
		const sharedTags = note.tags.filter((tag) => sourceTags.has(normalize(tag)));
		if (sharedTags.length > 0) signals.push('shared-tag');
		if (keywordHits.has(note.path)) signals.push('keyword-hit');
		if (signals.length === 0) continue;

		const sameTitlePaths = (titleCounts.get(normalize(note.title)) ?? []).length > 1
			? titleCounts.get(normalize(note.title))
			: undefined;
		candidates.push({
			target: note,
			score: signals.reduce((total, signal) => total + SIGNAL_WEIGHTS[signal], 0),
			signals,
			linkTarget: sameTitlePaths ? stripExtension(note.path) : note.title,
			ambiguous: sameTitlePaths !== undefined,
			...(sameTitlePaths ? { sameTitlePaths } : {}),
			...(mention === undefined ? {} : { mention }),
			...(sharedTags.length > 0 ? { sharedTags } : {}),
		});
	}

	candidates.sort(compareCandidates);
	return {
		source: graph.source,
		depth,
		outgoing: toNotes(outgoing, byPath),
		incoming: toNotes(incoming, byPath),
		candidates: candidates.slice(0, limit),
		totalCandidates: candidates.length,
		hasMore: candidates.length > limit,
		skippedLinked,
	};
}

/**
 * Wiki links are removed before looking for mentions: text inside `[[ ]]` is
 * already a link, so counting it would suggest a link the note already has.
 */
export function stripWikiLinks(content: string): string {
	return content.replace(/\[\[[^\]]*\]\]/g, ' ');
}

function findMention(note: LinkNote, mentionText: string): string | undefined {
	for (const name of [note.title, ...note.aliases]) {
		const trimmed = name.trim();
		if (trimmed.length < MIN_MENTION_LENGTH) continue;
		if (mentionText.includes(trimmed.toLocaleLowerCase())) return trimmed;
	}
	return undefined;
}

function namesLinkedByText(note: LinkNote, unresolvedNames: Set<string>): boolean {
	return [note.title, ...note.aliases, stripExtension(note.path)]
		.some((name) => unresolvedNames.has(normalize(name)));
}

function sharesNeighbor(path: string, links: Record<string, string[]>, neighbors: Set<string>): boolean {
	if ((links[path] ?? []).some((target) => neighbors.has(target))) return true;
	return [...neighbors].some((neighbor) => (links[neighbor] ?? []).includes(path));
}

function countTitles(notes: LinkNote[]): Map<string, string[]> {
	const byTitle = new Map<string, string[]>();
	for (const note of notes) {
		const key = normalize(note.title);
		const paths = byTitle.get(key);
		if (paths) paths.push(note.path);
		else byTitle.set(key, [note.path]);
	}
	for (const paths of byTitle.values()) paths.sort((left, right) => left.localeCompare(right));
	return byTitle;
}

function compareCandidates(left: LinkCandidate, right: LinkCandidate): number {
	if (left.score !== right.score) return right.score - left.score;
	const byTitle = left.target.title.localeCompare(right.target.title);
	return byTitle === 0 ? left.target.path.localeCompare(right.target.path) : byTitle;
}

function toNotes(paths: string[], byPath: Map<string, LinkNote>): LinkNote[] {
	return paths
		.map((path) => byPath.get(path))
		.filter((note): note is LinkNote => note !== undefined);
}

function stripExtension(path: string): string {
	return path.replace(/\.md$/i, '');
}

function normalize(value: string): string {
	return value.trim().toLocaleLowerCase();
}
