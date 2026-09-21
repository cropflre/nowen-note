// 附件文本预览：所有附件只读，Markdown 视图复用笔记的 MarkdownPreview / KaTeX 渲染链路。
import React, { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, AlertTriangle, Download, Copy, Check, Eye, Code2 } from "lucide-react";
import DOMPurify from "dompurify";
import { common, createLowlight } from "lowlight";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

// 不增加文件管理首页的 ReactMarkdown/KaTeX 初始体积：只在打开 Markdown 的视图时加载。
const MarkdownPreview = lazy(() => import("@/components/MarkdownPreview").then((mod) => ({ default: mod.MarkdownPreview })));
const lowlight = createLowlight(common);

interface Props {
  url: string;
  filename: string;
  mimeType: string;
  size: number;
  heightClass?: string;
}

// 兼容既有附件预览保护：超过 2MB 的文本仅显示前 200KB。
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const PREVIEW_HEAD_BYTES = 200 * 1024;

const EXT_TO_LANG: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", jsx: "javascript",
  py: "python", java: "java", c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp",
  go: "go", rs: "rust", rb: "ruby", php: "php", swift: "swift",
  kt: "kotlin", kts: "kotlin", sh: "bash", bash: "bash", zsh: "bash",
  ps1: "powershell", sql: "sql", html: "xml", htm: "xml", xml: "xml",
  css: "css", scss: "scss", less: "less", yml: "yaml", yaml: "yaml",
  toml: "ini", ini: "ini", conf: "ini", dockerfile: "dockerfile",
  md: "markdown", markdown: "markdown", json: "json",
};

function getExt(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx < 0 || idx === filename.length - 1) return "";
  return filename.slice(idx + 1).toLowerCase();
}

function detectLanguage(filename: string, mime: string): string {
  const ext = getExt(filename);
  if (ext && EXT_TO_LANG[ext]) return EXT_TO_LANG[ext];
  if (mime === "application/json") return "json";
  if (mime === "application/xml" || mime === "text/xml" || mime === "text/html") return "xml";
  if (mime === "text/css") return "css";
  if (mime === "text/javascript" || mime === "application/javascript") return "javascript";
  return "";
}

type RenderMode = "markdown" | "code" | "json" | "csv" | "svg" | "plain";
function detectRenderMode(filename: string, mime: string): RenderMode {
  const ext = getExt(filename);
  if (mime === "image/svg+xml" || ext === "svg") return "svg";
  if (ext === "md" || ext === "markdown" || mime === "text/markdown") return "markdown";
  if (mime === "application/json" || ext === "json") return "json";
  if (mime === "text/csv" || mime === "text/tab-separated-values" || ext === "csv" || ext === "tsv") return "csv";
  if (detectLanguage(filename, mime)) return "code";
  return "plain";
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function hastToHtml(node: any): string {
  if (!node) return "";
  if (node.type === "root") return (node.children || []).map(hastToHtml).join("");
  if (node.type === "text") return escapeHtml(node.value || "");
  if (node.type === "element") {
    const tag = String(node.tagName || "span");
    const classList = node.properties && Array.isArray(node.properties.className)
      ? node.properties.className.join(" ") : "";
    const classAttr = classList ? ` class="${escapeHtml(classList)}"` : "";
    return `<${tag}${classAttr}>${(node.children || []).map(hastToHtml).join("")}</${tag}>`;
  }
  return "";
}

function highlightCode(code: string, lang: string): string {
  if (!code) return "";
  try {
    if (!lowlight.registered(lang)) return escapeHtml(code);
    return hastToHtml(lowlight.highlight(lang, code));
  } catch {
    return escapeHtml(code);
  }
}

function parseCsv(text: string, delim: string): string[][] {
  const lines = text.split(/\r?\n/).filter((line, index, all) => line.length > 0 || index < all.length - 1);
  return lines.length > 1000 ? [] : lines.map((line) => line.split(delim));
}

export default function AttachmentTextPreview({ url, filename, mimeType, size, heightClass }: Props) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [mdView, setMdView] = useState<"rendered" | "source">("rendered");
  const mode = useMemo(() => detectRenderMode(filename, mimeType), [filename, mimeType]);
  const lang = useMemo(() => detectLanguage(filename, mimeType), [filename, mimeType]);

  useEffect(() => {
    // 使用本次请求独立的 cancelled 标记；不能复用 ref，否则新 URL 会让旧请求重新获得写入资格。
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setErrMsg("");
    setText("");
    setTruncated(false);
    setMdView("rendered");

    (async () => {
      try {
        const tooLarge = size > MAX_PREVIEW_BYTES;
        const headers: HeadersInit = tooLarge ? { Range: `bytes=0-${PREVIEW_HEAD_BYTES - 1}` } : {};
        const res = await fetch(url, { headers, signal: controller.signal });
        if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
        let buf = await res.arrayBuffer();
        if (tooLarge && res.status === 200 && buf.byteLength > PREVIEW_HEAD_BYTES) {
          buf = buf.slice(0, PREVIEW_HEAD_BYTES);
        }
        if (cancelled) return;
        setText(new TextDecoder("utf-8", { fatal: false }).decode(buf));
        setTruncated(tooLarge);
      } catch (error: any) {
        if (!cancelled && error?.name !== "AbortError") setErrMsg(String(error?.message || error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; controller.abort(); };
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
    return <div className={cn("relative w-full flex items-center justify-center text-tx-tertiary", minH)}>
      <Loader2 size={16} className="animate-spin mr-2" />正在加载 {filename}…
    </div>;
  }
  if (errMsg) {
    return <div className={cn("relative w-full flex flex-col items-center justify-center gap-2 text-tx-tertiary px-6 text-center", minH)}>
      <AlertTriangle size={20} className="text-amber-500" />
      <div className="text-xs">无法加载预览</div>
      <div className="text-[10px] text-tx-tertiary/70 max-w-full break-all">{errMsg}</div>
      <a href={url} download={filename}
        className="mt-1 inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] bg-app-surface border border-app-border hover:bg-app-hover text-tx-primary">
        <Download size={11} />下载原文件
      </a>
    </div>;
  }

  return <div className="flex flex-col min-w-0">
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-app-border bg-app-surface text-[11px]">
      <div className="flex items-center gap-2 text-tx-tertiary min-w-0">
        {lang && <span className="px-1.5 py-0.5 rounded bg-app-hover text-tx-secondary uppercase text-[10px] font-mono">{lang}</span>}
        {truncated && <span className="text-amber-500" title={`原文件 ${(size / 1024 / 1024).toFixed(1)} MB，仅预览前 ${PREVIEW_HEAD_BYTES / 1024} KB`}>
          已截断（仅显示前 {PREVIEW_HEAD_BYTES / 1024}KB）
        </span>}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {mode === "markdown" && <div className="inline-flex items-center rounded border border-app-border overflow-hidden" role="tablist" aria-label="Markdown 显示模式">
          <button type="button" role="tab" aria-selected={mdView === "rendered"} onClick={() => setMdView("rendered")}
            className={cn("px-2 py-0.5 inline-flex items-center gap-1 transition-colors", mdView === "rendered" ? "bg-accent-primary/15 text-accent-primary" : "text-tx-secondary hover:bg-app-hover")} title="渲染视图">
            <Eye size={11} />视图
          </button>
          <button type="button" role="tab" aria-selected={mdView === "source"} onClick={() => setMdView("source")}
            className={cn("px-2 py-0.5 inline-flex items-center gap-1 transition-colors border-l border-app-border", mdView === "source" ? "bg-accent-primary/15 text-accent-primary" : "text-tx-secondary hover:bg-app-hover")} title="源代码">
            <Code2 size={11} />源码
          </button>
        </div>}
        {(mode === "code" || mode === "json" || mode === "plain" || (mode === "markdown" && mdView === "source")) &&
          <button type="button" onClick={() => setWrap((value) => !value)} className="px-2 py-0.5 rounded hover:bg-app-hover text-tx-secondary" title={wrap ? "切换为不折行" : "切换为自动折行"}>
            {wrap ? "不折行" : "折行"}
          </button>}
        <button type="button" onClick={onCopy} className="px-2 py-0.5 rounded hover:bg-app-hover text-tx-secondary inline-flex items-center gap-1" title="复制全部内容">
          {copied ? <Check size={11} className="text-green-500" /> : <Copy size={11} />}{copied ? "已复制" : "复制"}
        </button>
      </div>
    </div>
    <div className={cn("relative w-full min-w-0 overflow-auto bg-app-bg", minH)}>
      {mode === "svg" ? <SvgPane text={text} />
        : mode === "markdown" ? (mdView === "rendered" ? <MarkdownPane text={text} /> : <CodePane text={text} lang="markdown" wrap={wrap} />)
        : mode === "json" ? <CodePane text={prettifyJson(text)} lang="json" wrap={wrap} />
        : mode === "csv" ? <CsvPane text={text} delim={getExt(filename) === "tsv" || mimeType === "text/tab-separated-values" ? "\t" : ","} />
        : mode === "code" ? <CodePane text={text} lang={lang} wrap={wrap} />
        : <CodePane text={text} lang="" wrap={wrap} />}
    </div>
  </div>;
}

function CodePane({ text, lang, wrap }: { text: string; lang: string; wrap: boolean }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  const html = useMemo(() => lang ? DOMPurify.sanitize(highlightCode(text, lang)) : escapeHtml(text), [text, lang]);
  return <div className="flex font-mono text-[12px] leading-[1.55]">
    <div className="select-none text-right text-tx-tertiary/60 px-2 py-2 border-r border-app-border bg-app-surface/50 sticky left-0" aria-hidden>
      {lines.map((_, index) => <div key={index}>{index + 1}</div>)}
    </div>
    <pre className={cn("py-2 px-3 flex-1 hljs", wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre")}
      dangerouslySetInnerHTML={{ __html: html }} />
  </div>;
}

function prettifyJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function CsvPane({ text, delim }: { text: string; delim: string }) {
  const rows = useMemo(() => parseCsv(text, delim), [text, delim]);
  if (!rows.length) return <CodePane text={text} lang="" wrap={false} />;
  const [header, ...body] = rows;
  return <div className="overflow-auto p-2"><table className="text-[12px] border-collapse">
    <thead><tr>{header.map((cell, index) => <th key={index} className="px-2 py-1 border border-app-border bg-app-surface text-tx-primary text-left font-semibold whitespace-nowrap">{cell}</th>)}</tr></thead>
    <tbody>{body.map((row, ri) => <tr key={ri} className="hover:bg-app-hover/40">
      {row.map((cell, ci) => <td key={ci} className="px-2 py-1 border border-app-border text-tx-secondary whitespace-nowrap">{cell}</td>)}
    </tr>)}</tbody>
  </table></div>;
}

function SvgPane({ text }: { text: string }) {
  const safe = useMemo(() => DOMPurify.sanitize(text, { USE_PROFILES: { svg: true, svgFilters: true } }), [text]);
  return <div className="flex items-center justify-center p-4 [&>svg]:max-w-full [&>svg]:h-auto" dangerouslySetInnerHTML={{ __html: safe }} />;
}

/** 与原生 Markdown 笔记共用同一套数学公式预处理、KaTeX 和安全渲染逻辑；附件仍保持只读。 */
function MarkdownPane({ text }: { text: string }) {
  return <div className="min-w-0 max-w-full overflow-x-auto [&_.math-view-block]:max-w-full [&_.math-view-block]:overflow-x-auto [&_.katex-display]:overflow-x-auto">
    <Suspense fallback={<div className="flex items-center justify-center py-10 text-tx-tertiary text-xs"><Loader2 size={14} className="animate-spin mr-2" />加载渲染器…</div>}>
      <MarkdownPreview markdown={text} compact className="!mx-0 !max-w-none !p-4 break-words" />
    </Suspense>
  </div>;
}
