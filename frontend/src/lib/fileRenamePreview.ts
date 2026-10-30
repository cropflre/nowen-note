import type { FileRenameItem } from "@/types";

export function fileRenamePreview(
  files: Array<{ id: string; filename: string }>,
  base: string,
  start: number,
): FileRenameItem[] {
  const prefix = base.trim();
  if (
    !prefix ||
    // eslint-disable-next-line no-control-regex
    /[\\/\x00-\x1f\x7f]/.test(prefix) ||
    !Number.isSafeInteger(start) ||
    start < 1 ||
    start > 999999 ||
    !files.length ||
    files.length > 200
  )
    return [];
  const width = Math.max(3, String(start + files.length - 1).length);
  const preview = files.map((file, index) => {
    const dot = file.filename.lastIndexOf(".");
    const extension = dot > 0 ? file.filename.slice(dot) : "";
    return {
      id: file.id,
      expectedFilename: file.filename,
      filename: `${prefix}-${String(start + index).padStart(width, "0")}${extension}`,
    };
  });
  return preview.some((item) => item.filename.length > 255) ? [] : preview;
}
