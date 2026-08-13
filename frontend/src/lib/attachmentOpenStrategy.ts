export type AttachmentPreviewKind =
  | "image"
  | "svg"
  | "video"
  | "audio"
  | "pdf"
  | "docx"
  | "text"
  | "unsupported";

export type AttachmentPrimaryAction = "preview" | "desktop-default" | "details";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "ogg", "ogv", "m4v", "mov", "mkv", "avi"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "oga", "aac", "m4a", "flac"]);
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "xml", "yaml", "yml", "toml", "ini", "conf", "log",
  "csv", "tsv", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "java", "c", "h", "cpp",
  "cc", "cxx", "hpp", "cs", "go", "rs", "rb", "php", "swift", "kt", "kts", "sh", "bash",
  "zsh", "ps1", "sql", "html", "htm", "css", "scss", "less", "dockerfile",
]);
const DESKTOP_DOCUMENT_EXTENSIONS = new Set([
  "xls", "xlsx", "xlsm", "xlsb", "xlt", "xltx", "xltm", "ods", "numbers",
  "ppt", "pptx", "pptm", "pot", "potx", "potm", "pps", "ppsx", "ppsm", "odp", "key",
]);
const DESKTOP_DOCUMENT_MIMES = new Set([
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.ms-powerpoint.presentation.macroenabled.12",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.presentation",
]);

function getExtension(filename: string): string {
  const index = filename.lastIndexOf(".");
  return index < 0 ? "" : filename.slice(index + 1).toLowerCase();
}

export function detectAttachmentPreviewKind(mimeType: string, filename: string): AttachmentPreviewKind {
  const mime = (mimeType || "").toLowerCase();
  const extension = getExtension(filename);

  if (mime === "image/svg+xml" || extension === "svg") return "svg";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (mime === "application/pdf" || extension === "pdf") return "pdf";
  if (mime === DOCX_MIME || extension === "docx") return "docx";
  if (mime.startsWith("text/")) return "text";
  if ([
    "application/json",
    "application/xml",
    "application/javascript",
    "application/x-yaml",
    "application/x-sh",
  ].includes(mime)) return "text";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  return "unsupported";
}

export function decideAttachmentPrimaryAction(mimeType: string, filename: string): AttachmentPrimaryAction {
  if (detectAttachmentPreviewKind(mimeType, filename) !== "unsupported") return "preview";
  const mime = (mimeType || "").toLowerCase();
  return DESKTOP_DOCUMENT_EXTENSIONS.has(getExtension(filename)) || DESKTOP_DOCUMENT_MIMES.has(mime)
    ? "desktop-default"
    : "details";
}
