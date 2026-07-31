import type { Note } from "@/types";
import {
  findPreferredMarkdownSplitLevel,
  type NoteSplitHeadingLevel,
} from "@/lib/noteSplit";
import { findPreferredTiptapSplitLevel } from "@/lib/tiptapNoteSplit";

interface SplitAnalysisCacheEntry {
  fingerprint: string;
  level: NoteSplitHeadingLevel | null;
}

export interface CachedSplitAnalysisResult {
  hit: boolean;
  level: NoteSplitHeadingLevel | null;
}

const MAX_CACHE_ENTRIES = 32;
const splitAnalysisCache = new Map<string, SplitAnalysisCacheEntry>();

function noteFingerprint(note: Note): string {
  const content = note.content || "";
  const prefix = content.slice(0, 64);
  const suffix = content.length > 64 ? content.slice(-64) : "";
  return [
    note.version,
    note.updatedAt,
    note.contentFormat || "",
    content.length,
    prefix,
    suffix,
  ].join("|");
}

function remember(noteId: string, entry: SplitAnalysisCacheEntry): void {
  splitAnalysisCache.delete(noteId);
  splitAnalysisCache.set(noteId, entry);
  while (splitAnalysisCache.size > MAX_CACHE_ENTRIES) {
    const oldest = splitAnalysisCache.keys().next().value as string | undefined;
    if (!oldest) break;
    splitAnalysisCache.delete(oldest);
  }
}

export function getCachedPreferredNoteSplitLevel(note: Note): CachedSplitAnalysisResult {
  const cached = splitAnalysisCache.get(note.id);
  if (!cached || cached.fingerprint !== noteFingerprint(note)) {
    return { hit: false, level: null };
  }
  remember(note.id, cached);
  return { hit: true, level: cached.level };
}

export function resolvePreferredNoteSplitLevel(
  note: Note | null | undefined,
): NoteSplitHeadingLevel | null {
  if (!note) return null;
  const cached = getCachedPreferredNoteSplitLevel(note);
  if (cached.hit) return cached.level;

  let level: NoteSplitHeadingLevel | null = null;
  if (note.contentFormat === "markdown") {
    level = findPreferredMarkdownSplitLevel(note.content || "");
  } else if (note.contentFormat === "tiptap-json") {
    level = findPreferredTiptapSplitLevel(note.content || "");
  }

  remember(note.id, {
    fingerprint: noteFingerprint(note),
    level,
  });
  return level;
}

type IdleCapableWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Heading discovery is useful for the optional document-split command, but it must not block the
 * first paint of every note. Schedule it for the browser's idle period and keep a cancellable
 * fallback for browsers/WebViews without requestIdleCallback.
 */
export function schedulePreferredNoteSplitLevel(
  note: Note,
  onResolved: (level: NoteSplitHeadingLevel | null) => void,
): () => void {
  let cancelled = false;
  const run = () => {
    if (!cancelled) onResolved(resolvePreferredNoteSplitLevel(note));
  };

  const browser = typeof window !== "undefined" ? window as IdleCapableWindow : null;
  if (browser?.requestIdleCallback) {
    const handle = browser.requestIdleCallback(run, { timeout: 500 });
    return () => {
      cancelled = true;
      browser.cancelIdleCallback?.(handle);
    };
  }

  const timer = globalThis.setTimeout(run, 16);
  return () => {
    cancelled = true;
    globalThis.clearTimeout(timer);
  };
}

export function clearPreferredNoteSplitLevelCache(): void {
  splitAnalysisCache.clear();
}
