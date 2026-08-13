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
}: {
  title: string;
  currentNoteId: string;
  currentNotebookId: string;
  candidates: readonly TitleDuplicateCandidate[];
  minPrefixLength?: number;
}): TitleDuplicateMatch | null {
  if (!title || !title.trim()) return null;

  let best: TitleDuplicateMatch | null = null;

  for (const candidate of candidates) {
    if (!candidate || candidate.id === currentNoteId) continue;
    if (candidate.notebookId !== currentNotebookId) continue;
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
