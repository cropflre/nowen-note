export const DOCX_IMPORT_LIMITS = {
  maxFileBytes: 50 * 1024 * 1024,
  maxEntries: 5_000,
  maxUncompressedBytes: 300 * 1024 * 1024,
  maxXmlBytes: 80 * 1024 * 1024,
  maxImageCount: 500,
  maxSingleImageBytes: 30 * 1024 * 1024,
  maxExpansionRatio: 120,
  maxHtmlChars: 24 * 1024 * 1024,
  maxContentChars: 32 * 1024 * 1024,
  maxPlainTextChars: 8 * 1024 * 1024,
} as const;

export interface DocxArchiveStats {
  originalBytes: number;
  entryCount: number;
  uncompressedBytes: number;
  xmlBytes: number;
  imageCount: number;
  largestImageBytes: number;
}

export type DocxImportSafetyCode =
  | "UNSUPPORTED_FILE"
  | "FILE_TOO_LARGE"
  | "TOO_MANY_ENTRIES"
  | "UNCOMPRESSED_TOO_LARGE"
  | "XML_TOO_LARGE"
  | "TOO_MANY_IMAGES"
  | "IMAGE_TOO_LARGE"
  | "EXPANSION_RATIO_TOO_HIGH";

export interface DocxImportSafetyViolation {
  code: DocxImportSafetyCode;
  message: string;
}

export function formatImportBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function getDocxFileViolation(file: Pick<File, "name" | "size">): DocxImportSafetyViolation | null {
  if (!/\.docx$/i.test(file.name || "")) {
    return {
      code: "UNSUPPORTED_FILE",
      message: "仅支持 .docx 文件（旧版 .doc 请先用 Word 另存为 .docx）",
    };
  }
  if (file.size > DOCX_IMPORT_LIMITS.maxFileBytes) {
    return {
      code: "FILE_TOO_LARGE",
      message: `文件过大（${formatImportBytes(file.size)}），安全上限为 ${formatImportBytes(DOCX_IMPORT_LIMITS.maxFileBytes)}`,
    };
  }
  return null;
}

export function getDocxArchiveViolation(stats: DocxArchiveStats): DocxImportSafetyViolation | null {
  if (stats.entryCount > DOCX_IMPORT_LIMITS.maxEntries) {
    return {
      code: "TOO_MANY_ENTRIES",
      message: `文档内部文件数量过多（${stats.entryCount}），上限为 ${DOCX_IMPORT_LIMITS.maxEntries}`,
    };
  }
  if (stats.uncompressedBytes > DOCX_IMPORT_LIMITS.maxUncompressedBytes) {
    return {
      code: "UNCOMPRESSED_TOO_LARGE",
      message: `文档解压后体积过大（${formatImportBytes(stats.uncompressedBytes)}），上限为 ${formatImportBytes(DOCX_IMPORT_LIMITS.maxUncompressedBytes)}`,
    };
  }
  if (stats.xmlBytes > DOCX_IMPORT_LIMITS.maxXmlBytes) {
    return {
      code: "XML_TOO_LARGE",
      message: `文档正文 XML 过大（${formatImportBytes(stats.xmlBytes)}），上限为 ${formatImportBytes(DOCX_IMPORT_LIMITS.maxXmlBytes)}`,
    };
  }
  if (stats.imageCount > DOCX_IMPORT_LIMITS.maxImageCount) {
    return {
      code: "TOO_MANY_IMAGES",
      message: `文档图片数量过多（${stats.imageCount}），上限为 ${DOCX_IMPORT_LIMITS.maxImageCount}`,
    };
  }
  if (stats.largestImageBytes > DOCX_IMPORT_LIMITS.maxSingleImageBytes) {
    return {
      code: "IMAGE_TOO_LARGE",
      message: `文档包含超大单张图片（${formatImportBytes(stats.largestImageBytes)}），上限为 ${formatImportBytes(DOCX_IMPORT_LIMITS.maxSingleImageBytes)}`,
    };
  }
  const expansionRatio = stats.uncompressedBytes / Math.max(1, stats.originalBytes);
  if (expansionRatio > DOCX_IMPORT_LIMITS.maxExpansionRatio) {
    return {
      code: "EXPANSION_RATIO_TOO_HIGH",
      message: `文档压缩比异常（${expansionRatio.toFixed(1)} 倍），为避免压缩炸弹已停止导入`,
    };
  }
  return null;
}

interface ImportedNoteSnapshot {
  id?: string;
  content?: string;
  contentText?: string;
  contentFormat?: string;
  version?: number;
}

function normalizePlainText(value: string | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

export interface ImportedNoteSemanticInput {
  expectedId: string;
  expectedContentText: string;
  expectedContentFormat: string;
  expectedAttachmentUrls: string[];
  minimumVersion: number;
  actual: ImportedNoteSnapshot;
}

/**
 * First response validation. The backend may legitimately add blockId attributes to Tiptap JSON,
 * so this check validates user-visible text and every attachment reference instead of requiring
 * byte-for-byte equality with the pre-save client JSON.
 */
export function getImportedNoteSemanticError(input: ImportedNoteSemanticInput): string | null {
  const { actual } = input;
  if (actual.id !== input.expectedId) return "服务端返回了错误的笔记 ID";
  if (actual.contentFormat !== input.expectedContentFormat) return "服务端返回的正文格式不一致";
  if (!Number.isFinite(actual.version) || Number(actual.version) < input.minimumVersion) {
    return "服务端没有确认新的笔记版本";
  }
  if (!actual.content || actual.content.length < 10) return "服务端返回的正文为空或异常短";
  if (normalizePlainText(actual.contentText) !== normalizePlainText(input.expectedContentText)) {
    return "服务端返回的纯文本内容不完整";
  }
  for (const url of input.expectedAttachmentUrls) {
    if (!actual.content.includes(url)) return `服务端正文缺少附件引用：${url}`;
  }
  return null;
}

export interface ImportedNoteIntegrityInput {
  expectedId: string;
  expectedContent: string;
  expectedContentText: string;
  expectedContentFormat: string;
  minimumVersion: number;
  actual: ImportedNoteSnapshot;
}

/** Second-read validation: compare the persisted GET with the already-normalized server response. */
export function getImportedNoteIntegrityError(input: ImportedNoteIntegrityInput): string | null {
  const { actual } = input;
  if (actual.id !== input.expectedId) return "服务端返回了错误的笔记 ID";
  if (actual.contentFormat !== input.expectedContentFormat) return "服务端返回的正文格式不一致";
  if (actual.content !== input.expectedContent) return "刷新后正文与保存响应不一致";
  if (actual.contentText !== input.expectedContentText) return "刷新后纯文本索引与保存响应不一致";
  if (!Number.isFinite(actual.version) || Number(actual.version) < input.minimumVersion) {
    return "刷新后笔记版本低于已确认版本";
  }
  return null;
}
