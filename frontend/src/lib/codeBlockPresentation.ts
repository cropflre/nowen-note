export type CodeBlockCollapseMode = "expanded" | "long" | "collapsed";

export const CODE_BLOCK_LONG_COLLAPSE_LINES = 20;

let currentCollapseMode: CodeBlockCollapseMode = "long";
const listeners = new Set<() => void>();

export function normalizeCodeBlockCollapseMode(
  value: unknown,
  fallback: CodeBlockCollapseMode = "long",
): CodeBlockCollapseMode {
  return value === "expanded" || value === "long" || value === "collapsed"
    ? value
    : fallback;
}

export function shouldCollapseCodeBlock(
  mode: CodeBlockCollapseMode,
  lineCount: number,
): boolean {
  if (mode === "collapsed") return true;
  if (mode === "expanded") return false;
  return Math.max(0, lineCount) >= CODE_BLOCK_LONG_COLLAPSE_LINES;
}

export function setCodeBlockCollapseMode(value: unknown): void {
  const next = normalizeCodeBlockCollapseMode(value);
  if (next === currentCollapseMode) return;
  currentCollapseMode = next;
  try {
    document.documentElement.dataset.codeBlockCollapseMode = next;
  } catch {
    // SSR / unit tests may not expose document.
  }
  for (const listener of listeners) listener();
}

export function getCodeBlockCollapseMode(): CodeBlockCollapseMode {
  return currentCollapseMode;
}

export function subscribeCodeBlockCollapseMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const CODE_BLOCK_WRAPPER_CLASS =
  "code-block-wrapper group/code group relative my-4 overflow-hidden rounded-xl border shadow-sm";
export const CODE_BLOCK_TOOLBAR_CLASS =
  "code-block-toolbar flex h-9 items-center justify-between gap-2 border-b px-3 py-1.5 text-[11px] select-none";
export const CODE_BLOCK_TOOL_BUTTON_CLASS =
  "code-block-tool-btn inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors";
