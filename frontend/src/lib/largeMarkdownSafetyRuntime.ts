export * from "./largeMarkdownSafety";

import {
  computeSingleTextChange as computeLegacySingleTextChange,
  type SingleTextChange,
} from "./largeMarkdownSafety";
import { isIncrementalMarkdownYTextSyncActive } from "./markdownYTextSyncRuntimeState";

/**
 * Vite runtime replacement for the legacy collaboration fallback.
 *
 * The worker-backed large Markdown runtime mirrors CodeMirror ChangeSets directly to Y.Text. Its
 * original debounced save still executes as a safety boundary, but must not rescan the complete
 * document to rediscover a change that has already been synchronized transaction-by-transaction.
 */
export function computeSingleTextChange(
  previous: string,
  next: string,
): SingleTextChange | null {
  if (isIncrementalMarkdownYTextSyncActive()) return null;
  return computeLegacySingleTextChange(previous, next);
}
