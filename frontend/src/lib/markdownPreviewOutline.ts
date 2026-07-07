export function getNodeStartOffset(node: any): number | undefined {
  const offset = node?.position?.start?.offset;
  return typeof offset === "number" && Number.isFinite(offset) ? offset : undefined;
}

export function headingDataAttrs(node: any): Record<string, string> {
  const offset = getNodeStartOffset(node);
  return offset == null ? {} : { "data-md-pos": String(offset) };
}

export function findMarkdownPreviewHeadingTarget(
  headings: Iterable<HTMLElement>,
  pos: number,
): HTMLElement | null {
  const candidates = Array.from(headings)
    .map((el) => ({ el, pos: Number(el.dataset.mdPos) }))
    .filter((item) => Number.isFinite(item.pos))
    .sort((a, b) => a.pos - b.pos);

  if (!candidates.length) return null;

  const exact = candidates.find((item) => item.pos === pos);
  if (exact) return exact.el;

  const previous = [...candidates].reverse().find((item) => item.pos <= pos);
  return (previous || candidates[0]).el;
}
