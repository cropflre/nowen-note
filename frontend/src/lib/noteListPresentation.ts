/** Ordinary list previews are summaries, not an editor for internal references. */
export function noteListPreview(text: string, labels: { mindmap: string; diagram: string }): string {
  const summary = text
    .replace(/```mermaid\s+([\s\S]*?)```/gi, (_, source: string) =>
      /^\s*mindmap\b/i.test(source) ? labels.mindmap : labels.diagram)
    .replace(/!\[\[mindmap:[a-f\d-]{32,36}\]\]/gi, labels.mindmap)
    .replace(/(?:^|\s)\^blk[a-f\d]{32}\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Rich-text plainText drops code fences, so a diagram-only note needs a label too.
  if (/^mindmap\s+root\s*\(/i.test(summary)) return labels.mindmap;
  if (/^(?:graph|flowchart)\s+(?:TD|TB|BT|RL|LR)\b/i.test(summary)) return labels.diagram;
  return summary.slice(0, 160);
}

/** Use the shortest unambiguous path suffix, keeping the full path for tooltips. */
export function compactNotebookLabels(paths: Map<string, string>): Map<string, { text: string; path: string }> {
  const entries = [...paths.entries()].map(([id, path]) => ({ id, path, parts: path.split(" / ") }));
  return new Map(entries.map(({ id, path, parts }) => {
    let depth = 1;
    while (depth < parts.length && entries.some((other) =>
      other.id !== id && other.parts.slice(-depth).join(" / ") === parts.slice(-depth).join(" / "))) {
      depth += 1;
    }
    return [id, { text: parts.slice(-depth).join(" / "), path }];
  }));
}

/** Includes the 4px gap; shared with the rendered row to prevent virtual-list drift. */
export function noteListRowHeight(titleOnly: boolean, searchQuery?: string): number {
  // Searching always retains its matched-field badge and two-line snippet.
  return searchQuery ? 124 : titleOnly ? 40 : 80;
}
