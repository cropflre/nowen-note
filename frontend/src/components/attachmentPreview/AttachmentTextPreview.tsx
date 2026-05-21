// AttachmentTextPreview.tsx —— 文本/代码/JSON/CSV/TSV/SVG 通用预览
//
// 设计原则（参考已有的 DocxAttachmentPreview）：
//   - 单组件单文件，不引入新依赖（lowlight + DOMPurify 项目已用）
//   - loading / error / 空态 自带，外层只关心要不要渲染
//   - 大文件保护：> MAX_PREVIEW_BYTES 时仅取前 PREVIEW_HEAD_BYTES 字节，标注"已截断"
//
// 不做的事（避免膨胀）：
//   - 不做虚拟滚动：长文件已截断到 200KB，不会有性能问题
//   - 不做"在线编辑"：附件预览是只读视图
//   - 不做主题切换：跟随全局 dark/light（lowlight 的 highlight.js CSS 已经响应主题）
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, AlertTriangle, Download, Copy, Check, Eye, Code2 } from "lucide-react";
import DOMPurify from "dompurify";
import { common, createLowlight } from "lowlight";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

// 与编辑器保持同款 lowlight 实例（只支持 common 语言子集——和 TiptapEditor 一致）。
// 单独 createLowlight 的开销可忽略，但内存里多份语法表，所以这里直接 module-level 单例。
const lowlight = createLowlight(common);

interface Props {
  /** 完整附件 URL（已经过 resolveAttachmentUrl 处理） */
  url: string;
  /** 文件名，决定语言识别（按扩展名）和错误提示展示 */
  filename: string;
  /** MIME；与 filename 配合判定渲染模式 */
  mimeType: string;
  /** 文件大小（字节）。> MAX_PREVIEW_BYTES 时只拉前 PREVIEW_HEAD_BYTES 字节 */
  size: number;
  /** 容器最小高度类（与 DocxAttachmentPreview 同款 API） */
  heightClass?: string;
}

// 大文件兜底：超过 2MB 的文本只拉前 200KB——足够用户看个开头判断内容。
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const PREVIEW_HEAD_BYTES = 200 * 1024;

/** 文件名扩展名 → highlight.js 语言名（lowlight common 子集里有的才映射）。 */
const EXT_TO_LANG: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", jsx: "javascript",
  py: "python",
  java: "java",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
  cs: "csharp",
  go: "go",
  rs: "rust",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin", kts: "kotlin",
  sh: "bash", bash: "bash", zsh: "bash",
  ps1: "powershell",
  sql: "sql",
  html: "xml", htm: "xml", xml: "xml",
  css: "css", scss: "scss", less: "less",
  yml: "yaml", yaml: "yaml",
  toml: "ini", ini: "ini", conf: "ini",
  dockerfile: "dockerfile",
  md: "markdown", markdown: "markdown",
  json: "json",
};

function getExt(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx < 0 || idx === filename.length - 1) return "";
  return filename.slice(idx + 1).toLowerCase();
}

/** 判断要不要按"代码"模式渲染（语法高亮 + 行号）。 */
function detectLanguage(filename: string, mime: string): string | "" {
  const ext = getExt(filename);
  if (ext && EXT_TO_LANG[ext]) return EXT_TO_LANG[ext];
  if (mime === "application/json") return "json";
  if (mime === "application/xml" || mime === "text/xml") return "xml";
  if (mime === "text/html") return "xml";
  if (mime === "text/css") return "css";
  if (mime === "text/javascript" || mime === "application/javascript") return "javascript";
  return "";
}

type RenderMode = "markdown" | "code" | "json" | "csv" | "svg" | "plain";

function detectRenderMode(filename: string, mime: string): RenderMode {
  const ext = getExt(filename);
  if (mime === "image/svg+xml" || ext === "svg") return "svg";
  // markdown 优先于通用 code 分支：除了源码模式还要支持渲染视图
  if (ext === "md" || ext === "markdown" || mime === "text/markdown") return "markdown";
  if (mime === "application/json" || ext === "json") return "json";
  if (mime === "text/csv" || mime === "text/tab-separated-values" || ext === "csv" || ext === "tsv") return "csv";
  if (detectLanguage(filename, mime)) return "code";
  return "plain";
}

/**
 * 把 lowlight 的 hast 树转成 HTML 字符串。
 * lowlight v3 的 highlight() 返回 hast root，不在 npm dep 里直接暴露 hast-util-to-html，
 * 所以复用项目里 SharedNoteView 同款的极简手写序列化器（只处理 lowlight 会产出的三种节点）。
 */
function highlightCode(code: string, lang: string): string {
  if (!code) return "";
  try {
    if (!lowlight.registered(lang)) return escapeHtml(code);
    const tree = lowlight.highlight(lang, code);
    return hastToHtml(tree);
  } catch {
    return escapeHtml(code);
  }
}

function hastToHtml(node: any): string {
  if (!node) return "";
  if (node.type === "root") {
    return (node.children || []).map(hastToHtml).join("");
  }
  if (node.type === "text") {
    return escapeHtml(node.value || "");
  }
  if (node.type === "element") {
    const tag = String(node.tagName || "span");
    const classList = node.properties && Array.isArray(node.properties.className)
      ? node.properties.className.join(" ")
      : "";
    const classAttr = classList ? ` class="${escapeHtml(classList)}"` : "";
    const inner = (node.children || []).map(hastToHtml).join("");
    return `<${tag}${classAttr}>${inner}</${tag}>`;
  }
  return "";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 简单 CSV/TSV 解析。第一行做表头，其余作数据行。
 * 不支持嵌入逗号的引号转义——附件预览不做完整 RFC 4180 解析，
 * 真要做表格分析的人会用 Excel/编辑器；这里只求"能读"。
 */
function parseCsv(text: string, delim: string): string[][] {
  // 限制最大行数：>1000 行降级到纯文本，避免 DOM 爆炸
  const lines = text.split(/\r?\n/).filter((l, i, arr) => l.length > 0 || i < arr.length - 1);
  if (lines.length > 1000) return [];
  return lines.map((line) => line.split(delim));
}

export default function AttachmentTextPreview({
  url,
  filename,
  mimeType,
  size,
  heightClass,
}: Props) {
  const [text, setText] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string>("");
  const [truncated, setTruncated] = useState(false);
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  // markdown 视图/源码切换：默认走"视图"——预览附件就是想看渲染后的样子，
  // 看源码的人会主动点 "源码" 切换。
  const [mdView, setMdView] = useState<"rendered" | "source">("rendered");
  const cancelRef = useRef(false);

  const mode = useMemo(() => detectRenderMode(filename, mimeType), [filename, mimeType]);
  const lang = useMemo(() => detectLanguage(filename, mimeType), [filename, mimeType]);

  useEffect(() => {
    cancelRef.current = false;
    setLoading(true);
    setErrMsg("");
    setText("");
    setTruncated(false);

    (async () => {
      try {
        const tooLarge = size > MAX_PREVIEW_BYTES;
        // 大文件用 Range 头只拉前 200KB；服务端不支持 Range 时透明降级为整文件 fetch。
        const headers: HeadersInit = tooLarge
          ? { Range: `bytes=0-${PREVIEW_HEAD_BYTES - 1}` }
          : {};
        const res = await fetch(url, { headers });
        if (!res.ok && res.status !== 206) {
          throw new Error(`HTTP ${res.status}`);
        }
        let buf = await res.arrayBuffer();
        // 如果服务端没识别 Range（返回 200 + 全量），客户端再切一刀
        if (tooLarge && res.status === 200 && buf.byteLength > PREVIEW_HEAD_BYTES) {
          buf = buf.slice(0, PREVIEW_HEAD_BYTES);
        }
        const decoder = new TextDecoder("utf-8", { fatal: false });
        const decoded = decoder.decode(buf);
        if (cancelRef.current) return;
        setText(decoded);
        setTruncated(tooLarge);
      } catch (e: any) {
        if (!cancelRef.current) setErrMsg(String(e?.message || e));
      } finally {
        if (!cancelRef.current) setLoading(false);
      }
    })();

    return () => {
      cancelRef.current = true;
    };
  }, [url, size]);

  const onCopy = useCallback(async () => {
    const ok = await copyText(text);
    if (ok) {
      setCopied(true);
      toast.success("已复制到剪贴板");
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error("复制失败");
    }
  }, [text]);

  const minH = heightClass ?? "min-h-[400px]";

  if (loading) {
    return (
      <div className={cn("relative w-full flex items-center justify-center text-tx-tertiary", minH)}>
        <Loader2 size={16} className="animate-spin mr-2" />
        正在加载 {filename}…
      </div>
    );
  }

  if (errMsg) {
    return (
      <div className={cn("relative w-full flex flex-col items-center justify-center gap-2 text-tx-tertiary px-6 text-center", minH)}>
        <AlertTriangle size={20} className="text-amber-500" />
        <div className="text-xs">无法加载预览</div>
        <div className="text-[10px] text-tx-tertiary/70 max-w-full break-all">{errMsg}</div>
        <a
          href={url}
          download={filename}
          className="mt-1 inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] bg-app-surface border border-app-border hover:bg-app-hover text-tx-primary"
        >
          <Download size={11} />
          下载原文件
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* 工具栏：截断提示 + 复制 + 折行切换 */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-app-border bg-app-surface text-[11px]">
        <div className="flex items-center gap-2 text-tx-tertiary min-w-0">
          {lang && (
            <span className="px-1.5 py-0.5 rounded bg-app-hover text-tx-secondary uppercase text-[10px] font-mono">
              {lang}
            </span>
          )}
          {truncated && (
            <span className="text-amber-500" title={`原文件 ${(size / 1024 / 1024).toFixed(1)} MB，仅预览前 ${PREVIEW_HEAD_BYTES / 1024} KB`}>
              已截断（仅显示前 {PREVIEW_HEAD_BYTES / 1024}KB）
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* markdown 专属：视图/源码切换。视图模式下不显示折行按钮（无意义） */}
          {mode === "markdown" && (
            <div
              className="inline-flex items-center rounded border border-app-border overflow-hidden"
              role="tablist"
              aria-label="Markdown 显示模式"
            >
              <button
                type="button"
                role="tab"
                aria-selected={mdView === "rendered"}
                onClick={() => setMdView("rendered")}
                className={cn(
                  "px-2 py-0.5 inline-flex items-center gap-1 transition-colors",
                  mdView === "rendered"
                    ? "bg-accent-primary/15 text-accent-primary"
                    : "text-tx-secondary hover:bg-app-hover",
                )}
                title="渲染视图"
              >
                <Eye size={11} />
                视图
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mdView === "source"}
                onClick={() => setMdView("source")}
                className={cn(
                  "px-2 py-0.5 inline-flex items-center gap-1 transition-colors border-l border-app-border",
                  mdView === "source"
                    ? "bg-accent-primary/15 text-accent-primary"
                    : "text-tx-secondary hover:bg-app-hover",
                )}
                title="源代码"
              >
                <Code2 size={11} />
                源码
              </button>
            </div>
          )}
          {/* 折行按钮：md 仅在源码模式下显示 */}
          {(mode === "code" || mode === "json" || mode === "plain" || (mode === "markdown" && mdView === "source")) && (
            <button
              type="button"
              onClick={() => setWrap((v) => !v)}
              className="px-2 py-0.5 rounded hover:bg-app-hover text-tx-secondary"
              title={wrap ? "切换为不折行" : "切换为自动折行"}
            >
              {wrap ? "不折行" : "折行"}
            </button>
          )}
          <button
            type="button"
            onClick={onCopy}
            className="px-2 py-0.5 rounded hover:bg-app-hover text-tx-secondary inline-flex items-center gap-1"
            title="复制全部内容"
          >
            {copied ? <Check size={11} className="text-green-500" /> : <Copy size={11} />}
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>

      {/* 主预览区 */}
      <div className={cn("relative w-full overflow-auto bg-app-bg", minH)}>
        {mode === "svg" ? (
          <SvgPane text={text} />
        ) : mode === "markdown" ? (
          mdView === "rendered"
            ? <MarkdownPane text={text} />
            // 源码模式复用 CodePane（与切到 "code" 分支时一致：md 高亮 + 行号）
            : <CodePane text={text} lang="markdown" wrap={wrap} />
        ) : mode === "json" ? (
          <CodePane text={prettifyJson(text)} lang="json" wrap={wrap} />
        ) : mode === "csv" ? (
          <CsvPane text={text} delim={getExt(filename) === "tsv" || mimeType === "text/tab-separated-values" ? "\t" : ","} />
        ) : mode === "code" ? (
          <CodePane text={text} lang={lang} wrap={wrap} />
        ) : (
          <CodePane text={text} lang="" wrap={wrap} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子渲染：代码 / 文本（带行号 + 可选语法高亮）
// ---------------------------------------------------------------------------

function CodePane({ text, lang, wrap }: { text: string; lang: string; wrap: boolean }) {
  // 行号面板与代码面板分离，避免 user-select 时把行号也选进去
  const lines = useMemo(() => text.split("\n"), [text]);
  const html = useMemo(() => {
    if (!lang) return escapeHtml(text);
    return highlightCode(text, lang);
  }, [text, lang]);

  return (
    <div className="flex font-mono text-[12px] leading-[1.55]">
      {/* 行号 */}
      <div
        className="select-none text-right text-tx-tertiary/60 px-2 py-2 border-r border-app-border bg-app-surface/50 sticky left-0"
        aria-hidden
      >
        {lines.map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      {/* 代码内容 */}
      <pre
        className={cn(
          "py-2 px-3 flex-1 hljs",
          wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
        )}
        // hljs 类名让 highlight.js 主题 CSS 生效；用户全局已经引入过（CodeBlockLowlight）
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子渲染：JSON 格式化（解析失败回退原文）
// ---------------------------------------------------------------------------

function prettifyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text; // 解析失败保留原文，由代码高亮兜底
  }
}

// ---------------------------------------------------------------------------
// 子渲染：CSV/TSV 表格化
// ---------------------------------------------------------------------------

function CsvPane({ text, delim }: { text: string; delim: string }) {
  const rows = useMemo(() => parseCsv(text, delim), [text, delim]);
  // 行数过多 → 降级回纯文本（避免 1w 行 DOM 卡死）
  if (rows.length === 0) {
    return <CodePane text={text} lang="" wrap={false} />;
  }
  const [header, ...body] = rows;
  return (
    <div className="overflow-auto p-2">
      <table className="text-[12px] border-collapse">
        <thead>
          <tr>
            {header.map((cell, i) => (
              <th
                key={i}
                className="px-2 py-1 border border-app-border bg-app-surface text-tx-primary text-left font-semibold whitespace-nowrap"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri} className="hover:bg-app-hover/40">
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className="px-2 py-1 border border-app-border text-tx-secondary whitespace-nowrap"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子渲染：SVG（必须先 sanitize 拒绝 <script>/onclick）
// ---------------------------------------------------------------------------

function SvgPane({ text }: { text: string }) {
  const safe = useMemo(() => {
    // DOMPurify 对 SVG 的默认配置已经禁用 script，但显式 RETURN_DOM_FRAGMENT=false +
    // USE_PROFILES.svg 更稳。下载下来的 SVG 直接 sanitize 后内联渲染。
    return DOMPurify.sanitize(text, {
      USE_PROFILES: { svg: true, svgFilters: true },
    });
  }, [text]);
  return (
    <div
      className="flex items-center justify-center p-4 [&>svg]:max-w-full [&>svg]:h-auto"
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}

// ---------------------------------------------------------------------------
// 子渲染：Markdown 视图（与笔记导入后渲染同源）
// ---------------------------------------------------------------------------
//
// 为什么不用 ReactMarkdown？
//   - 项目里 markdownToHtml(@lezer/markdown) 是 TiptapEditor 导入路径同款解析器。
//     在这里复用，能让"附件预览的视图"与"导入笔记后的实际呈现"做到字符级一致。
//   - 不引入新组件，少打一份 bundle。
//
// 为什么懒加载 markdownToHtml？
//   - contentFormat.ts 顶部静态 import 了 @tiptap/core + StarterKit 等（~120KB）。
//     这个附件预览组件会出现在 FileManager 路径里，那里原本不依赖 Tiptap。
//   - 改为 dynamic import：只有用户真的打开 .md 附件且看"视图"时，才拉 Tiptap。
//
// 安全性：
//   - markdownToHtml 输出是受信解析器拼出的 HTML（不会原样吐 raw <script>），
//     但 md 源文件里可能含 `<img onerror>` 之类，这里还是过 DOMPurify 兜底。
function MarkdownPane({ text }: { text: string }) {
  // dynamic import 后缓存 markdownToHtml 引用；首次调用几十毫秒拉包，
  // 之后的切换/刷新都是同步路径。
  const [renderer, setRenderer] = useState<((md: string) => string) | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    import("@/lib/contentFormat")
      .then((mod) => {
        if (cancelled) return;
        setRenderer(() => mod.markdownToHtml);
        setLoading(false);
      })
      .catch((err) => {
        console.warn("[AttachmentTextPreview] load markdownToHtml failed:", err);
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const safeHtml = useMemo(() => {
    if (!renderer) return "";
    try {
      const raw = renderer(text);
      return DOMPurify.sanitize(raw, {
        // 允许常见富文本标签 + 表格 + 任务列表的 input[type=checkbox]
        ADD_TAGS: ["details", "summary"],
        ADD_ATTR: ["target", "rel", "checked", "disabled", "type"],
      });
    } catch (err) {
      console.warn("[AttachmentTextPreview] markdown render failed:", err);
      return `<pre>${escapeHtml(text)}</pre>`;
    }
  }, [renderer, text]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 text-tx-tertiary text-xs">
        <Loader2 size={14} className="animate-spin mr-2" />
        加载渲染器…
      </div>
    );
  }

  return (
    <div
      // 项目未启用 @tailwindcss/typography 插件，prose-* 类不生效。
      // 复用 index.css 中 .shared-note-content 这套"自给自足"的兜底排版：
      // 标题层级、列表 bullet、链接颜色、代码块、表格、blockquote 等都已覆盖。
      // 这样附件 .md 视图与分享笔记页的呈现保持一致。
      className="shared-note-content px-5 py-4"
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  );
}
