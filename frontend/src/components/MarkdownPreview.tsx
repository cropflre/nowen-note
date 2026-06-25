/**
 * MarkdownPreview —— Markdown 渲染预览组件
 *
 * 用于 MarkdownEditor 的预览模式和分屏模式。
 * 使用 react-markdown + remark-gfm 渲染标准 Markdown。
 * 不依赖 @tailwindcss/typography，直接为元素提供 nowen-note 风格样式。
 */

import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

interface MarkdownPreviewProps {
  markdown: string;
  className?: string;
  /** 紧凑模式（分屏时使用），去掉居中和过宽限制 */
  compact?: boolean;
}

/** 图片组件：支持 /api/attachments、http、data:image，带加载失败占位 */
function PreviewImage({ src, alt }: { src?: string; alt?: string }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);

  if (!src) return null;

  if (failed) {
    return (
      <span className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-app-hover text-tx-tertiary text-xs">
        ⚠ {t("markdown.preview.imageLoadFailed")}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={alt || ""}
      className="block my-4 max-w-full max-h-[520px] rounded-xl border border-app-border object-contain shadow-sm cursor-pointer hover:opacity-90 transition-opacity"
      onClick={() => window.open(src, "_blank", "noopener,noreferrer")}
      onError={() => setFailed(true)}
      loading="lazy"
    />
  );
}

/** 链接组件：新窗口打开 */
function PreviewLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent-primary hover:underline underline-offset-2"
    >
      {children}
    </a>
  );
}

/** 行内 code */
function InlineCode({ children }: { children?: React.ReactNode }) {
  return (
    <code className="px-1.5 py-0.5 rounded bg-app-hover text-accent-primary text-[13px] font-mono">
      {children}
    </code>
  );
}

/** 代码块（pre > code） */
function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  return (
    <pre className="my-4 rounded-lg bg-app-hover border border-app-border p-3 overflow-x-auto">
      <code className={cn("text-sm font-mono leading-6", className)}>
        {children}
      </code>
    </pre>
  );
}

/** 自定义渲染器 */
const components: Record<string, React.FC<any>> = {
  // 标题
  h1: ({ children }) => (
    <h1 className="text-3xl font-bold mt-2 mb-4 leading-tight text-tx-primary">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-2xl font-bold mt-6 mb-3 leading-snug text-tx-primary border-b border-app-border pb-2">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-xl font-semibold mt-5 mb-2 text-tx-primary">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-lg font-semibold mt-4 mb-2 text-tx-primary">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="text-base font-semibold mt-3 mb-1.5 text-tx-primary">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="text-sm font-semibold mt-3 mb-1.5 text-tx-secondary">{children}</h6>
  ),

  // 段落
  p: ({ children }) => (
    <p className="my-3 leading-7 text-tx-primary">{children}</p>
  ),

  // 列表
  ul: ({ children }) => (
    <ul className="list-disc pl-6 my-3 space-y-1 text-tx-primary">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-6 my-3 space-y-1 text-tx-primary">{children}</ol>
  ),
  li: ({ children }) => (
    <li className="leading-7 pl-1">{children}</li>
  ),

  // 强调
  strong: ({ children }) => (
    <strong className="font-semibold text-tx-primary">{children}</strong>
  ),
  em: ({ children }) => (
    <em className="italic">{children}</em>
  ),

  // 链接和图片
  a: PreviewLink,
  img: PreviewImage,

  // 代码
  code: ({ className, children, ...props }: any) => {
    // react-markdown v10+: inline code 没有 className，块级 code 有 language-xxx
    const isBlock = /language-/.test(className || "");
    if (isBlock) {
      return <CodeBlock className={className}>{children}</CodeBlock>;
    }
    return <InlineCode>{children}</InlineCode>;
  },
  pre: ({ children }) => {
    // pre 包裹 code 时，react-markdown 会把 code 作为 children
    // 我们在 code 组件里已经处理了块级样式，这里直接透传
    return <>{children}</>;
  },

  // 引用
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-4 border-accent-primary/40 bg-app-hover/40 px-4 py-2 rounded-r-lg text-tx-secondary italic">
      {children}
    </blockquote>
  ),

  // 表格
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-app-hover">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="border border-app-border px-3 py-2 font-semibold text-left text-tx-primary">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border border-app-border px-3 py-2 text-tx-primary">{children}</td>
  ),

  // 水平线
  hr: () => <hr className="my-6 border-app-border" />,

  // 删除线
  del: ({ children }) => (
    <del className="line-through text-tx-tertiary">{children}</del>
  ),

  // 复选框（GFM task list）
  input: ({ checked, type }: { checked?: boolean; type?: string }) => {
    if (type === "checkbox") {
      return (
        <input
          type="checkbox"
          checked={checked}
          readOnly
          className="mr-1.5 accent-accent-primary align-middle"
        />
      );
    }
    return <input type={type} />;
  },
};

export function MarkdownPreview({ markdown, className, compact }: MarkdownPreviewProps) {
  const { t } = useTranslation();

  if (!markdown || !markdown.trim()) {
    return (
      <div className={cn("flex items-center justify-center h-full text-tx-tertiary text-sm", className)}>
        {t("markdown.preview.empty")}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "nowen-md-preview leading-7 text-tx-primary overflow-y-auto",
        compact ? "p-4 md:p-6" : "p-4 md:p-6 max-w-[860px] mx-auto",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
