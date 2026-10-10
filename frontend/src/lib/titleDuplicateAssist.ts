export const TITLE_DUPLICATE_MIN_PREFIX_LENGTH = 8;

export interface TitleDuplicateCandidate {
  id: string;
  title: string;
  notebookId: string;
  isTrashed?: number | boolean | null;
}

export interface TitleDuplicateMatch {
  candidateId: string;
  candidateTitle: string;
  prefixLength: number;
  exact: boolean;
}

export interface TitleDuplicateRange {
  from: number;
  to: number;
  type: "exact" | "prefix" | "serial";
  candidateId: string;
}

type TitleToken = { from: number; to: number; key: string };

function extractTitleDuplicateTokens(title: string): TitleToken[] {
  const tokens: TitleToken[] = [];
  const patterns = [
    /\d{6,}/g,
    /[A-Za-z]+[-_ ]*[A-Za-z0-9]*\d{4,}[A-Za-z0-9]*|\d{3,}[A-Za-z]+\d{3,}/g,
  ];
  for (const pattern of patterns) {
    for (const match of title.matchAll(pattern)) {
      const key = match[0].replace(/[-_ ]/g, "").toUpperCase();
      if (/^[VH]\d{1,4}$/.test(key)) continue;
      tokens.push({ from: match.index, to: match.index + match[0].length, key });
    }
  }
  return tokens;
}

export function longestCommonTitlePrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

export function findTitleDuplicateMatch({
  title,
  currentNoteId,
  currentNotebookId,
  candidates,
  minPrefixLength = TITLE_DUPLICATE_MIN_PREFIX_LENGTH,
  includeDescendants = false,
}: {
  title: string;
  currentNoteId: string;
  currentNotebookId: string;
  candidates: readonly TitleDuplicateCandidate[];
  minPrefixLength?: number;
  includeDescendants?: boolean;
}): TitleDuplicateMatch | null {
  if (!title || !title.trim()) return null;

  let best: TitleDuplicateMatch | null = null;

  for (const candidate of candidates) {
    if (!candidate || candidate.id === currentNoteId) continue;
    if (!includeDescendants && candidate.notebookId !== currentNotebookId) continue;
    if (candidate.isTrashed) continue;
    if (!candidate.title) continue;

    const prefixLength = longestCommonTitlePrefixLength(title, candidate.title);
    const exact = title === candidate.title;

    if (exact) {
      return {
        candidateId: candidate.id,
        candidateTitle: candidate.title,
        prefixLength: title.length,
        exact: true,
      };
    }

    if (prefixLength < minPrefixLength) continue;
    if (!best || prefixLength > best.prefixLength) {
      best = {
        candidateId: candidate.id,
        candidateTitle: candidate.title,
        prefixLength,
        exact: false,
      };
    }
  }

  return best;
}

/** Candidates are already scoped to the current notebook and its descendants by the caller. */
export function findTitleDuplicateRanges(options: {
  title: string;
  currentNoteId: string;
  currentNotebookId: string;
  candidates: readonly TitleDuplicateCandidate[];
}): TitleDuplicateRange[] {
  const prefix = findTitleDuplicateMatch({ ...options, includeDescendants: true });
  if (prefix) return [{
    from: 0,
    to: prefix.prefixLength,
    type: prefix.exact ? "exact" : "prefix",
    candidateId: prefix.candidateId,
  }];

  const ownTokens = extractTitleDuplicateTokens(options.title);
  if (!ownTokens.length) return [];
  const matches: TitleDuplicateRange[] = [];
  for (const candidate of options.candidates) {
    if (!candidate || candidate.id === options.currentNoteId || candidate.isTrashed) continue;
    const candidateKeys = new Set(extractTitleDuplicateTokens(candidate.title || "").map((token) => token.key));
    for (const token of ownTokens) {
      if (candidateKeys.has(token.key)) matches.push({
        from: token.from, to: token.to, type: "serial", candidateId: candidate.id,
      });
    }
  }

  // Prefer a complete mixed code over the numeric run it contains, then render in title order.
  matches.sort((left, right) => (right.to - right.from) - (left.to - left.from) || left.from - right.from);
  const selected: TitleDuplicateRange[] = [];
  for (const match of matches) {
    if (!selected.some((item) => match.from < item.to && match.to > item.from)) selected.push(match);
  }
  return selected.sort((left, right) => left.from - right.from);
}
