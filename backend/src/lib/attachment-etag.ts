/**
 * 附件 ETag 计算与 If-None-Match 比对（PERF-ATTACHMENT-02）
 * ---------------------------------------------------------------------------
 * 背景：
 *   附件内容由 (attachmentId, variant) 唯一确定 —— variant 是"原图"或某个
 *   缩略图宽度（?w=240/480/960）。此前 ETag 统一写成 "att-<id>"，原图和不同
 *   宽度的缩略图共用同一个验证器，属于 RFC 7232 意义上的错误实体标识：浏览器
 *   可能把某个宽度的缩略图当作原图（或反之）直接复用。
 *
 *   本模块把 ETag 计算收敛成单一函数，供attachments.ts（外层 wrapper，负责
 *   Cache-Control 覆盖）和 attachments-core.ts（核心 handler，负责权限校验 +
 *   文件读取）共用，避免两处各算一份导致互相对不上。
 *
 *   独立成文件而不是放在 attachments.ts 或 attachments-core.ts 里，是因为
 *   这两个文件互相 import（attachments.ts 引用 attachments-core.ts 的
 *   handleDownloadAttachment），放在其中一个里会造成循环引用。
 */

/** 附件内容由 (id, variant) 唯一确定，原图与每个缩略图宽度各有独立 ETag。 */
export function computeAttachmentEtag(attachmentId: string, variant: "original" | number): string {
  return `"att-${attachmentId}-${variant === "original" ? "original" : `thumb-${variant}`}"`;
}

/** If-None-Match 比对，兼容多值与 W/ 弱验证器前缀。 */
export function requestMatchesEtag(requestHeaders: Headers, etag: string): boolean {
  const ifNoneMatch = requestHeaders.get("If-None-Match");
  if (!ifNoneMatch) return false;
  const normalize = (value: string) => value.trim().replace(/^W\//, "");
  const target = normalize(etag);
  return ifNoneMatch.split(",").some((candidate) => {
    const normalized = normalize(candidate);
    return normalized === "*" || normalized === target;
  });
}
