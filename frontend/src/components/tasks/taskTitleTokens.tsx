import React from "react";
import { Link as LinkIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * 任务标题富文本协议
 * ---------------------------------------------------------------------------
 * task.title 是纯字符串，但允许内嵌两种 markdown 风格的 token：
 *   - 图片：![alt](/api/task-attachments/<id>)
 *   - 链接：[text](https://...) 或裸 URL
 *
 * 老数据没有任何 token —— parser 命中 0 个 match，退回单段纯文本。
 */

export type Token =
  | { kind: "text"; value: string }
  | { kind: "image"; alt: string; url: string }
  | { kind: "link"; text: string; url: string };

// markdown 图片 + 链接 + 裸 URL 的合并正则。
// 顺序：image > link > raw URL。先匹配到优先级高的。
const TOKEN_RE = /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|(https?:\/\/[^\s)]+)/g;

export function parseTaskTitle(title: string): Token[] {
  if (!title) return [];
  const out: Token[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(title)) !== null) {
    if (m.index > lastIndex) {
      out.push({ kind: "text", value: title.slice(lastIndex, m.index) });
    }
    if (m[1] !== undefined && m[2] !== undefined) {
      out.push({ kind: "image", alt: m[1], url: m[2] });
    } else if (m[3] !== undefined && m[4] !== undefined) {
      out.push({ kind: "link", text: m[3], url: m[4] });
    } else if (m[5]) {
      out.push({ kind: "link", text: hostnameOf(m[5]), url: m[5] });
    }
    lastIndex = TOKEN_RE.lastIndex;
  }
  if (lastIndex < title.length) {
    out.push({ kind: "text", value: title.slice(lastIndex) });
  }
  return out;
}

/** 把 URL 截成 hostname；解析失败时返回截短的原串，避免抛异常打破 UI。 */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.length > 24 ? url.slice(0, 24) + "…" : url;
  }
}

/** 素朴的 URL 检测：用于 onPaste 时判断是否要转 markdown 链接。 */
export function isHttpUrl(s: string): boolean {
  return /^https?:\/\/\S+$/i.test(s.trim());
}

/* ===== 富文本渲染：列表里"紧凑模式"，详情里"完整模式" ===== */
export function TitleView({
  title,
  compact,
  isCompleted,
}: {
  title: string;
  compact: boolean;
  isCompleted: boolean;
}) {
  const { t } = useTranslation();
  const tokens = parseTaskTitle(title);
  if (tokens.length === 1 && tokens[0].kind === "text") {
    return <>{tokens[0].value}</>;
  }

  return (
    <span className="inline">
      {tokens.map((tok, i) => {
        if (tok.kind === "text") {
          return <React.Fragment key={i}>{tok.value}</React.Fragment>;
        }
        if (tok.kind === "image") {
          if (compact) {
            return (
              <span
                key={i}
                className="inline-flex align-middle mx-0.5 w-7 h-7 rounded overflow-hidden bg-app-hover border border-app-border"
              >
                <img
                  src={tok.url}
                  alt={tok.alt || "image"}
                  className="w-full h-full object-cover"
                  loading="lazy"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
              </span>
            );
          }
          return (
            <span key={i} className="block my-2 max-w-full overflow-hidden rounded border border-app-border">
              <img
                src={tok.url}
                alt={tok.alt || "image"}
                className="max-w-full h-auto max-h-64 object-contain"
                loading="lazy"
              />
            </span>
          );
        }
        if (tok.kind === "link") {
          return (
            <a
              key={i}
              href={tok.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className={cn(
                "inline-flex items-center gap-0.5 align-middle max-w-[120px] md:max-w-[160px] truncate",
                compact ? "text-[12px]" : "text-sm",
                isCompleted
                  ? "text-tx-tertiary no-underline"
                  : "text-accent-primary underline underline-offset-2 hover:text-accent-primary/80"
              )}
              title={tok.url}
            >
              {compact ? (
                tok.text
              ) : (
                <>
                  <LinkIcon size={12} className="flex-shrink-0 opacity-60" />
                  {tok.text}
                </>
              )}
            </a>
          );
        }
        return null;
      })}
    </span>
  );
}
