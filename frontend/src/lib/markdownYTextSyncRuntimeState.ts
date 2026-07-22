let activeIncrementalEditors = 0;

/**
 * The legacy large-Markdown editor still schedules a debounced collaboration save. Runtime shells
 * that already mirror every CodeMirror transaction to Y.Text acquire a lease so that fallback save
 * skips the obsolete whole-document prefix/suffix diff.
 */
export function acquireIncrementalMarkdownYTextSync(): () => void {
  activeIncrementalEditors += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeIncrementalEditors = Math.max(0, activeIncrementalEditors - 1);
  };
}

export function isIncrementalMarkdownYTextSyncActive(): boolean {
  return activeIncrementalEditors > 0;
}
