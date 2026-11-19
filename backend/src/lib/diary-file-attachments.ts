/**
 * 说说文件附件（Issue #928）的元数据形状与规整。
 *
 * diaries.attachments 是 JSON 数组。REST 接口、Sync V2 上行/下行和首次同步都会
 * 经过这里：坏数据只丢弃对应项，不让整条说说或整条时间线解析失败。
 */
export interface DiaryFileAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** 接受 JSON 字符串或数组；按 id 去重并保留原顺序。 */
export function normalizeDiaryFileAttachments(value: unknown): DiaryFileAttachment[] {
  let list: unknown = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];

  const seen = new Set<string>();
  const result: DiaryFileAttachment[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const size = Number(item.size);
    result.push({
      id,
      filename: typeof item.filename === "string" && item.filename.trim() ? item.filename : "attachment",
      mimeType: typeof item.mimeType === "string" && item.mimeType.trim() ? item.mimeType : "application/octet-stream",
      size: Number.isFinite(size) && size > 0 ? Math.floor(size) : 0,
    });
  }
  return result;
}
