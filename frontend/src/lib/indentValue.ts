export const INDENT_MIN = 0;
export const INDENT_MAX = 8;

export function normalizeIndentValue(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return INDENT_MIN;
  return Math.max(INDENT_MIN, Math.min(INDENT_MAX, Math.trunc(numeric)));
}
