import React, { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { AlertTriangle, BadgeAlert, ExternalLink, Info, Lightbulb, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { remarkSiyuanCallouts, type SiyuanCalloutType } from "@/lib/markdownCallouts";
import { headingDataAttrs } from "@/lib/markdownPreviewOutline";
import { preprocessMarkdownVideos } from "@/lib/markdownVideoSyntax";
import { MarkdownVideoPreview } from "@/components/MarkdownVideoPreview";
import { MarkdownCodeBlock, isMarkdownBlockCode } from "@/components/MarkdownCodeBlock";
import { MathView } from "@/components/MathView";
import { NoteLinkPreviewAnchor } from "@/components/NoteLinkPreview";
import { BlockEmbedCard } from "@/components/BlockEmbedExtension";
import { preprocessInternalNoteLinks } from "@/lib/noteLinkSyntax";
import { resolveAttachmentUrl } from "@/lib/api";

interface MarkdownPreviewProps {
  markdown: string;
  className?: string;
  compact?: boolean;
  containerRef?: React.Ref<HTMLDivElement>;
  onTaskCheckboxChange?: (taskIndex: number, checked: boolean) => void;
}

const RAW_HTML_RE = /<\/?[a-z][^>]*>/i;

function preprocessMarkdownMath(markdown: string): string {
  const fencedCode: string[] = [];
  let text = markdown.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (match) => {
    const index = fencedCode.push(match) - 1;
    return `\u0000NOWEN_MATH_CODE_${index}\u0000`;
  });

  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_match, source) => {
    const encoded = encodeURIComponent(String(source).trim());
    return `\n\n<div data-nowen-math-source="${encoded}" data-nowen-math-display="1"></div>\n\n`;
  });

  text = text.replace(
    /(^|[^\\$\w])\$([^\s$][^$\n]*?[^\s$]|[^\s$])\$(?=$|[^\w$])/g,
    (_match, prefix, source) => {
      const encoded = encodeURIComponent(String(source));
      return `${prefix}<span data-nowen-math-source="${encoded}" data-nowen-math-display="0"></span>`;
    },
  );

  return text.replace(/\u0000NOWEN_MATH_CODE_(\d+)\u0000/g, (_match, index) => {
    return fencedCode[Number(index)] || "";
  });
}

function getMathSource(props: Record<string, unknown>): string | null {
  const encoded = props["data-nowen-math-source"] ?? props.dataNowenMathSource;
  if (typeof encoded !== "string") return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

const safeHtmlSchema = {
  ...defaultSchema,
  tagNames: Array.from(new Set([
    ...(defaultSchema.tagNames || []),
    "iframe",
    "details",
    "summary",
    "mark",
    "kbd",
    "u",
    "sup",
    "sub",
    "video",
    "audio",
    "source",
  ])),
  attributes: {
    ...(defaultSchema.attributes || {}),
    "*": [
      ...((defaultSchema.attributes || {})["*"] || []),
      "dataNowenMathSource",
      "dataNowenMathDisplay",
      "dataNowenTitleMode",
      "dataNowenBlockEmbed",
    ],
    iframe: ["src", "title", "width", "height", "loading", "allow", "allowFullScreen", "referrerPolicy"],
    video: ["src", "controls", "poster", "preload", "width", "height"],
    audio: ["src", "controls", "preload"],
    source: ["src", "type"],
    details: ["open"],
    ul: ["className"],
    li: ["className"],
    input: ["type", "checked", "disabled"],
    code: ["className"],
  },
  protocols: {
    ...(defaultSchema.protocols || {}),
    href: ["http", "https", "mailto", "tel", "note"],
    src: ["http", "https", "data", "blob"],
  },
};

function normalizeEmbeddableUrl(src?: string): { url: string; sameOrigin: boolean } | null {
  if (!src) return null;
  try {
    const parsed = new URL(src, window.location.href);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return { url: parsed.toString(), sameOrigin: parsed.origin === window.location.origin };
  } catch {
    return null;
  }
}

function PreviewIframe({ src, title }: { src?: string; title?: string }) {
  const resolved = normalizeEmbeddableUrl(src);
  if (!resolved) {
    return (
      <div className="my-4 flex items-center gap-2 rounded-xl border border-amber-300/60 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
        <AlertTriangle size={16} className="shrink-0" />
        无法预览不安全或无效的 iframe 地址
      </div>
    );
  }

  const sandbox = resolved.sameOrigin
    ? "allow-scripts allow-forms allow-popups allow-presentation"
    : "allow-scripts allow-same-origin allow-forms allow-popups allow-presentation";

  return (
    <div className="my-4 overflow-hidden rounded-xl border border-app-border bg-black/5 shadow-sm dark:bg-white/5">
      <iframe
        src={resolved.url}
        title={title || "Embedded content"}
        loading="lazy"
        sandbox={sandbox}
        referrerPolicy="strict-origin-when-cross-origin"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
        allowFullScreen
        className="block min-h-[320px] w-full bg-white sm:min-h-[420px]"
      />
      <a
        href={resolved.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-end gap-1 border-t border-app-border px-3 py-2 text-[11px] text-tx-tertiary hover:text-accent-primary"
      >
        在新窗口打开 <ExternalLink size={11} />
      </a>
    </div>
  );
}

function PreviewImage({ src, alt }: { src?: string; alt?: string }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  if (!src) return null;
  const resolvedSrc = resolveAttachmentUrl(src);
  if (failed) {
    return <span className="inline-flex items-center gap-1 rounded-lg bg-app-hover px-3 py-2 text-xs text-tx-tertiary">⚠ {t("markdown.preview.imageLoadFailed")}</span>;
  }
  return (
    <img
      src={resolvedSrc}
      alt={alt || ""}
      loading="lazy"
      className="my-4 block max-h-[520px] max-w-full cursor-pointer rounded-xl border border-app-border object-contain shadow-sm transition-opacity hover:opacity-90"
      onClick={() => window.open(resolvedSrc, "_blank", "noopener,noreferrer")}
      onError={() => setFailed(true)}
    />
  );
}

function PreviewMediaImage({ src, alt }: { src?: string; alt?: string }) {
  const normalizedAlt = alt || "";
  if (normalizedAlt.startsWith("nowen-video:")) {
    return <MarkdownVideoPreview src={src || ""} title={normalizedAlt.slice("nowen-video:".length)} />;
  }
  return <PreviewImage src={src} alt={alt} />;
}

function PreviewLink({ href, children, ...props }: { href?: string; children?: React.ReactNode; [key: string]: any }) {
  if (href?.startsWith("note:")) {
    const mode = props["data-nowen-title-mode"] || props.dataNowenTitleMode;
    return <NoteLinkPreviewAnchor href={href} titleMode={mode === "alias" ? "alias" : "auto"}>{children}</NoteLinkPreviewAnchor>;
  }
  return <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent-primary underline-offset-2 hover:underline">{children}</a>;
}

const calloutStyles: Record<SiyuanCalloutType, { icon: React.ComponentType<any>; className: string }> = {
  note: { icon: Info, className: "border-blue-400/70 bg-blue-500/10 text-blue-600 dark:text-blue-300" },
  tip: { icon: Lightbulb, className: "border-emerald-400/70 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" },
  important: { icon: BadgeAlert, className: "border-violet-400/70 bg-violet-500/10 text-violet-600 dark:text-violet-300" },
  warning: { icon: AlertTriangle, className: "border-amber-400/80 bg-amber-500/10 text-amber-600 dark:text-amber-300" },
  caution: { icon: ShieldAlert, className: "border-red-400/80 bg-red-500/10 text-red-600 dark:text-red-300" },
};

function CalloutBlockquote({ node, children }: { node?: any; children?: React.ReactNode }) {
  const type = node?.properties?.["data-callout-type"] as SiyuanCalloutType | undefined;
  const title = node?.properties?.["data-callout-title"] as string | undefined;
  const style = type ? calloutStyles[type] : undefined;
  if (!type || !title || !style) {
    return <blockquote {...headingDataAttrs(node)} className="my-4 rounded-r-lg border-l-4 border-accent-primary/40 bg-app-hover/40 px-4 py-2 italic text-tx-secondary">{children}</blockquote>;
  }
  const Icon = style.icon;
  return (
    <blockquote {...headingDataAttrs(node)} className={cn("my-4 rounded-r-lg border-l-4 px-4 py-3", style.className)}>
      <div className="flex items-center gap-2 text-sm font-semibold"><Icon size={16} className="shrink-0" /><span>{title}</span></div>
      <div className="mt-2 text-tx-primary [&>p:first-child]:mt-0 [&>p:last-child]:mb-0">{children}</div>
    </blockquote>
  );
}

function createComponents(onTaskCheckboxChange?: (taskIndex: number, checked: boolean) => void): Record<string, React.FC<any>> {
  return {
    h1: ({ node, children }) => <h1 {...headingDataAttrs(node)} className="mb-4 mt-2 text-3xl font-bold leading-tight text-tx-primary">{children}</h1>,
    h2: ({ node, children }) => <h2 {...headingDataAttrs(node)} className="mb-3 mt-6 border-b border-app-border pb-2 text-2xl font-bold leading-snug text-tx-primary">{children}</h2>,
    h3: ({ node, children }) => <h3 {...headingDataAttrs(node)} className="mb-2 mt-5 text-xl font-semibold text-tx-primary">{children}</h3>,
    h4: ({ node, children }) => <h4 {...headingDataAttrs(node)} className="mb-2 mt-4 text-lg font-semibold text-tx-primary">{children}</h4>,
    h5: ({ node, children }) => <h5 {...headingDataAttrs(node)} className="mb-1.5 mt-3 text-base font-semibold text-tx-primary">{children}</h5>,
    h6: ({ node, children }) => <h6 {...headingDataAttrs(node)} className="mb-1.5 mt-3 text-sm font-semibold text-tx-secondary">{children}</h6>,
    p: ({ node, children }) => <p {...headingDataAttrs(node)} className="my-3 leading-7 text-tx-primary">{children}</p>,
    ul: ({ node, children, className }) => {
      const isTaskList = /(?:^|\s)contains-task-list(?:\s|$)/.test(className || "");
      return (
        <ul
          {...headingDataAttrs(node)}
          className={cn(
            "my-3 space-y-1 text-tx-primary",
            isTaskList ? "list-none pl-0" : "list-disc pl-6",
            className,
          )}
        >
          {children}
        </ul>
      );
    },
    ol: ({ node, children, className }) => <ol {...headingDataAttrs(node)} className={cn("my-3 list-decimal space-y-1 pl-6 text-tx-primary", className)}>{children}</ol>,
    li: ({ node, children, className }) => {
      const isTask = /(?:^|\s)task-list-item(?:\s|$)/.test(className || "");
      return (
        <li
          {...headingDataAttrs(node)}
          className={cn(
            "leading-7",
            isTask
              ? "list-none pl-0 [&>p]:my-1 [&>p]:flex [&>p]:items-start [&>p]:gap-2 [&>ul]:ml-6"
              : "pl-1",
            className,
          )}
        >
          {children}
        </li>
      );
    },
    strong: ({ children }) => <strong className="font-semibold text-tx-primary">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    a: PreviewLink,
    img: PreviewMediaImage,
    iframe: PreviewIframe,
    video: ({ src, children, ...props }) => <video src={src} controls preload="metadata" className="my-4 max-h-[520px] w-full rounded-xl border border-app-border bg-black" {...props}>{children}</video>,
    audio: ({ src, children, ...props }) => <audio src={src} controls preload="metadata" className="my-4 w-full" {...props}>{children}</audio>,
    details: ({ node, children, open }) => <details {...headingDataAttrs(node)} open={open} className="my-4 rounded-lg border border-app-border bg-app-surface px-4 py-2">{children}</details>,
    summary: ({ children }) => <summary className="cursor-pointer py-1 font-medium text-tx-primary">{children}</summary>,
    mark: ({ children }) => <mark className="rounded bg-yellow-200/80 px-0.5 text-inherit dark:bg-yellow-500/30">{children}</mark>,
    kbd: ({ children }) => <kbd className="rounded border border-app-border bg-app-hover px-1.5 py-0.5 font-mono text-xs shadow-sm">{children}</kbd>,
    u: ({ children }) => <u className="underline underline-offset-2">{children}</u>,
    span: ({ children, ...props }) => {
      const source = getMathSource(props);
      return source === null ? <span {...props}>{children}</span> : <MathView source={source} />;
    },
    div: ({ children, ...props }) => {
      const source = getMathSource(props);
      const embedHref = props["data-nowen-block-embed"] ?? props.dataNowenBlockEmbed;
      if (typeof embedHref === "string" && embedHref.startsWith("note:")) {
        return <div className="my-4"><BlockEmbedCard href={embedHref} /></div>;
      }
      return source === null
        ? <div {...props}>{children}</div>
        : <MathView source={source} display />;
    },
    code: ({ className, children }: any) => {
      const raw = String(children ?? "");
      const isBlock = isMarkdownBlockCode(className) || raw.endsWith("\n");
      return isBlock
        ? <MarkdownCodeBlock className={className}>{children}</MarkdownCodeBlock>
        : <code className="rounded bg-app-hover px-1.5 py-0.5 font-mono text-[13px] text-accent-primary">{children}</code>;
    },
    pre: ({ node, children }) => <div {...headingDataAttrs(node)}>{children}</div>,
    blockquote: CalloutBlockquote,
    table: ({ node, children }) => <div {...headingDataAttrs(node)} className="my-4 overflow-x-auto"><table className="w-full border-collapse text-sm">{children}</table></div>,
    thead: ({ children }) => <thead className="bg-app-hover">{children}</thead>,
    th: ({ children }) => <th className="border border-app-border px-3 py-2 text-left font-semibold text-tx-primary">{children}</th>,
    td: ({ children }) => <td className="border border-app-border px-3 py-2 text-tx-primary">{children}</td>,
    hr: ({ node }) => <hr {...headingDataAttrs(node)} className="my-6 border-app-border" />,
    del: ({ children }) => <del className="text-tx-tertiary line-through">{children}</del>,
    input: ({ checked, type }: { checked?: boolean; type?: string }) => {
      if (type !== "checkbox") return <input type={type} />;
      return (
        <input
          type="checkbox"
          checked={!!checked}
          readOnly={!onTaskCheckboxChange}
          onChange={(event) => {
            const root = event.currentTarget.closest(".nowen-md-preview");
            const inputs = Array.from(root?.querySelectorAll<HTMLInputElement>("input[type='checkbox']") || []);
            const index = inputs.indexOf(event.currentTarget);
            if (index >= 0) onTaskCheckboxChange?.(index, event.currentTarget.checked);
          }}
          className={cn("mt-[0.38rem] h-4 w-4 shrink-0 accent-accent-primary", onTaskCheckboxChange && "cursor-pointer")}
        />
      );
    },
  };
}

export function MarkdownPreview({ markdown, className, compact, containerRef, onTaskCheckboxChange }: MarkdownPreviewProps) {
  const { t } = useTranslation();
  const renderedMarkdown = useMemo(() => preprocessInternalNoteLinks(preprocessMarkdownMath(preprocessMarkdownVideos((markdown || "")
    .replace(/[​-‍﻿]/g, "")
    .replace(/[ 　]/g, " ")))), [markdown]);
  const containsRawHtml = RAW_HTML_RE.test(renderedMarkdown);
  const components = useMemo(() => createComponents(onTaskCheckboxChange), [onTaskCheckboxChange]);
  const rehypePlugins: any[] = containsRawHtml ? [rehypeRaw, [rehypeSanitize, safeHtmlSchema]] : [];

  if (!markdown || !markdown.trim()) {
    return <div ref={containerRef} className={cn("flex h-full items-center justify-center text-sm text-tx-tertiary", className)}>{t("markdown.preview.empty")}</div>;
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "nowen-md-preview overflow-y-auto leading-7 text-tx-primary",
        compact ? "p-4 md:p-6" : "mx-auto max-w-[860px] p-4 md:p-6",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkSiyuanCallouts]}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {renderedMarkdown}
      </ReactMarkdown>
    </div>
  );
}
