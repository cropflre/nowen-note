// AttachmentPreview.tsx —— 附件预览统一分发入口
//
// 职责：
//   1. 根据 mime/扩展名 决定走哪种预览（图片 / 视频 / 音频 / 文本 / 代码 / SVG / docx / 不支持）
//   2. 把"懒加载"集中在这里——大解析器（docx）只在真正命中时拉
//
// 不做的事：
//   - 不在这里做 fetch / blob 管理：每个子组件自管
//   - 不做"全屏 / 工具栏"——交给详情抽屉或子组件
//
// 如果将来要加 PDF / xlsx 等新格式，只需新增一个分支 + 懒加载子组件，FileManager 不动。
import React, { lazy, Suspense } from "react";
import { Loader2, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import AttachmentTextPreview from "./AttachmentTextPreview";
import AttachmentMediaPreview from "./AttachmentMediaPreview";
import AttachmentPdfPreview from "./AttachmentPdfPreview";

// docx 解析器有 ~80KB 的运行时（fflate + 自研 OOXML 解析），与图片/视频路径无关
// → 懒加载，避免首屏体积。
const DocxAttachmentPreview = lazy(() => import("@/office/word/DocxAttachmentPreview"));

interface Props {
  url: string;
  filename: string;
  mimeType: string;
  size: number;
  /** 容器最小高度类，沿用 docx 那套 API */
  heightClass?: string;
  /** 图片预览的 max-height 类（小窗与放大态可调） */
  imgMaxHeightClass?: string;
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function getExt(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx < 0) return "";
  return filename.slice(idx + 1).toLowerCase();
}

/** 决定走哪种预览。优先级：image > svg > video > audio > pdf > docx > text/code > 不支持。 */
type PreviewKind = "image" | "svg" | "video" | "audio" | "pdf" | "docx" | "text" | "unsupported";

function detectKind(mime: string, filename: string): PreviewKind {
  const m = (mime || "").toLowerCase();
  const ext = getExt(filename);

  // SVG 走文本预览（sanitize 后内联），不走 <img>，避免 SVG 内的 <script> 风险
  if (m === "image/svg+xml" || ext === "svg") return "svg";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  // PDF：走浏览器内置 viewer（iframe），扩展名兜底是因为有些后端只给 octet-stream
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (m === DOCX_MIME || ext === "docx") return "docx";

  // 文本类：MIME 前缀或常见代码扩展名
  if (m.startsWith("text/")) return "text";
  if (
    m === "application/json" ||
    m === "application/xml" ||
    m === "application/javascript" ||
    m === "application/x-yaml" ||
    m === "application/x-sh"
  ) return "text";

  // 按扩展名兜底（很多代码文件 MIME 是 application/octet-stream）
  const TEXT_EXTS = new Set([
    "txt", "md", "markdown", "json", "xml", "yaml", "yml", "toml", "ini", "conf", "log",
    "csv", "tsv",
    "js", "mjs", "cjs", "ts", "tsx", "jsx",
    "py", "java", "c", "h", "cpp", "cc", "cxx", "hpp",
    "cs", "go", "rs", "rb", "php", "swift", "kt", "kts",
    "sh", "bash", "zsh", "ps1", "sql",
    "html", "htm", "css", "scss", "less",
    "dockerfile",
  ]);
  if (TEXT_EXTS.has(ext)) return "text";

  return "unsupported";
}

export default function AttachmentPreview({
  url,
  filename,
  mimeType,
  size,
  heightClass,
  imgMaxHeightClass,
}: Props) {
  const kind = detectKind(mimeType, filename);

  if (kind === "image") {
    return (
      <img
        src={url}
        alt={filename}
        className={cn("w-full object-contain bg-zinc-950/5", imgMaxHeightClass ?? "max-h-[360px]")}
      />
    );
  }

  if (kind === "video" || kind === "audio") {
    return (
      <AttachmentMediaPreview
        url={url}
        filename={filename}
        mimeType={mimeType}
        kind={kind}
        heightClass={heightClass}
      />
    );
  }

  if (kind === "pdf") {
    return <AttachmentPdfPreview url={url} filename={filename} heightClass={heightClass} />;
  }

  if (kind === "docx") {
    return (
      <Suspense
        fallback={
          <div className={cn("flex items-center justify-center text-tx-tertiary py-10", heightClass)}>
            <Loader2 size={14} className="animate-spin mr-2" />
            正在加载 docx 预览…
          </div>
        }
      >
        <DocxAttachmentPreview url={url} filename={filename} heightClass={heightClass} />
      </Suspense>
    );
  }

  if (kind === "text" || kind === "svg") {
    return (
      <AttachmentTextPreview
        url={url}
        filename={filename}
        mimeType={mimeType}
        size={size}
        heightClass={heightClass}
      />
    );
  }

  // 不支持：保留原 FileManager 的占位样式（图标 + MIME）
  return (
    <div className="flex flex-col items-center justify-center py-10 text-tx-tertiary">
      <div className="text-accent-primary mb-2"><FileText size={20} /></div>
      <span className="text-xs">{mimeType || "未知类型"}</span>
      <span className="text-[10px] text-tx-tertiary/70 mt-1">该格式不支持内联预览</span>
    </div>
  );
}
