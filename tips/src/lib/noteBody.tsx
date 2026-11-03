/**
 * 笔记正文渲染。
 *
 * 三种格式（按你库里的真实分布）：
 *   - html        1295 条（69.6%）→ 消毒后直接渲染
 *   - markdown     521 条（28.0%）→ marked 转 HTML 再消毒
 *   - tiptap-json   11 条（ 0.6%）→ 自写递归渲染器（约 60 行，避免为了 11 条笔记引入整套 Tiptap）
 *
 * 为什么走 DOMPurify：
 *   你的笔记里有大量「网页剪藏 / 公众号导入」的 HTML，属于外部内容。
 *   直接 innerHTML 会有 XSS 风险。消毒成本很低（~20KB gzip），值得。
 *
 * 图片：正文里是相对路径 `/api/attachments/<uuid>`，
 *   而 <img> 带不了 Authorization 头 → 先用签名 URL 替换掉再渲染。
 */
import DOMPurify from "dompurify";
import { serverUrl } from "../api/rest";
import { retryImageViaFetch } from "./imageFallback";

/*
 * 正文容器的 onErrorCapture：error 事件不冒泡、但会走捕获，
 * 挂在容器上就能兜住正文里**所有** <img> 的加载失败。
 * 背景：App 里 <img> 的直连请求被拦（服务端日志里一条图片请求都没有），
 *       而同一页面的 fetch 是通的 → 用 fetch 取回来转 blob URL 再塞回去。
 */
import { marked } from "marked";
import React from "react";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ATTACHMENT_RE = new RegExp(`/api/attachments/(${UUID})(\\?[^"'\\s)]*)?`, "gi");

marked.setOptions({ gfm: true, breaks: true });

/**
 * 把正文里的 `/api/attachments/<uuid>` 换成签名 URL。
 * 已经带 query（exp/sig）的视为已签名，保持原样。
 */
export function rewriteAttachmentUrls(
  html: string,
  urls: Record<string, string>,
): string {
  if (!html) return html;
  return html.replace(ATTACHMENT_RE, (match, id: string, query?: string) => {
    if (query) return match;
    // ⚠️ 服务端下发的签名 URL 是相对路径，必须补成绝对：
    //    APK 里 WebView 的 origin 是 https://localhost，相对路径会打到手机本机 → 图片全裂。
    const resolved = urls[id] ?? urls[id.toLowerCase()];
    // ⚠️ 拿不到签名 URL 时（接口超时/失败 → urls 是空对象），
    //    **不能原样返回相对路径** `/api/attachments/<id>`：
    //    APK 里那会打到 https://localhost（手机自己）→ 图全裂。
    //    统一过一遍 serverUrl()，至少指向正确的服务器；
    //    它可能因缺签名被 403，但那是"这一张图（可重试）"，
    //    而不是"整台服务器都指错了"。
    return serverUrl(resolved ?? match);
  });
}

/** 单条 URL 解析 —— tiptap-json 的 image 节点用这个（不能走整段 HTML 的字符串替换）。 */
function resolveOne(rawUrl: string, urls: Record<string, string>): string {
  if (!rawUrl || !rawUrl.includes("/api/attachments/")) return rawUrl;
  return rewriteAttachmentUrls(rawUrl, urls);
}

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ["video", "audio", "source", "details", "summary"],
    ADD_ATTR: ["controls", "target", "rel", "colspan", "rowspan"],
    ALLOW_DATA_ATTR: false,
  });
}

// ============================================================
// tiptap-json（ProseMirror 文档）→ React 节点
// ============================================================

interface PMMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface PMNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  marks?: PMMark[];
  text?: string;
}

function renderText(node: PMNode, key: number): React.ReactNode {
  let el: React.ReactNode = node.text ?? "";
  for (const mark of node.marks ?? []) {
    const attrs = mark.attrs ?? {};
    switch (mark.type) {
      case "bold":
        el = <strong>{el}</strong>;
        break;
      case "italic":
        el = <em>{el}</em>;
        break;
      case "strike":
        el = <s>{el}</s>;
        break;
      case "underline":
        el = <u>{el}</u>;
        break;
      case "code":
        el = <code>{el}</code>;
        break;
      case "highlight":
        el = <mark>{el}</mark>;
        break;
      case "link":
        el = (
          <a href={String(attrs.href ?? "#")} target="_blank" rel="noreferrer">
            {el}
          </a>
        );
        break;
      default:
        break;
    }
  }
  return <React.Fragment key={key}>{el}</React.Fragment>;
}

type UrlMap = Record<string, string>;

function renderNode(node: PMNode, key: number, urls: UrlMap): React.ReactNode {
  const kids = (): React.ReactNode => node.content?.map((c, i) => renderNode(c, i, urls)) ?? null;
  const attrs = node.attrs ?? {};

  switch (node.type) {
    case "doc":
      return <React.Fragment key={key}>{kids()}</React.Fragment>;
    case "paragraph":
      return <p key={key}>{kids()}</p>;
    case "heading": {
      const level = Math.min(Math.max(Number(attrs.level ?? 1), 1), 6);
      return React.createElement(`h${level}`, { key }, kids());
    }
    case "text":
      return renderText(node, key);
    case "bulletList":
      return <ul key={key}>{kids()}</ul>;
    case "orderedList":
      return <ol key={key}>{kids()}</ol>;
    case "listItem":
      return <li key={key}>{kids()}</li>;
    case "taskList":
      return (
        <ul className="task-list" key={key}>
          {kids()}
        </ul>
      );
    case "taskItem":
      return (
        <li key={key} className={attrs.checked ? "task-done" : undefined}>
          {kids()}
        </li>
      );
    case "blockquote":
      return <blockquote key={key}>{kids()}</blockquote>;
    case "codeBlock":
      return (
        <pre key={key}>
          <code>{kids()}</code>
        </pre>
      );
    case "horizontalRule":
      return <hr key={key} />;
    case "hardBreak":
      return <br key={key} />;
    case "image":
      // ⚠️ 这里必须做签名 URL 替换：JSON 节点里的 src 是 /api/attachments/<id>，
      //    而 <img> 带不了 Authorization 头，直接用会 401。
      return (
        <img
          key={key}
          src={resolveOne(String(attrs.src ?? ""), urls)}
          alt={String(attrs.alt ?? "")}
          loading="lazy"
        />
      );
    case "table":
      return (
        <table key={key}>
          <tbody>{kids()}</tbody>
        </table>
      );
    case "tableRow":
      return <tr key={key}>{kids()}</tr>;
    case "tableCell":
      return <td key={key}>{kids()}</td>;
    case "tableHeader":
      return <th key={key}>{kids()}</th>;
    default:
      // 未知节点类型：退化成它的子节点，保证内容不丢（宁可样式缺失，也不要白屏）
      return <React.Fragment key={key}>{kids()}</React.Fragment>;
  }
}

// ============================================================
// 对外入口
// ============================================================

export interface NoteBodyProps {
  format: string;
  content: string;
  attachmentUrls: Record<string, string>;
}

export function NoteBody({ format, content, attachmentUrls }: NoteBodyProps): React.ReactElement {
  const rendered = React.useMemo(() => {
    if (format === "tiptap-json") {
      try {
        const doc = JSON.parse(content) as PMNode;
        return { kind: "nodes" as const, nodes: renderNode(doc, 0, attachmentUrls) };
      } catch {
        return { kind: "html" as const, html: "<p>（这篇笔记的富文本内容解析失败）</p>" };
      }
    }

    const rawHtml = format === "markdown" ? (marked.parse(content) as string) : content;
    const withAttachments = rewriteAttachmentUrls(rawHtml, attachmentUrls);
    return { kind: "html" as const, html: sanitize(withAttachments) };
  }, [format, content, attachmentUrls]);

  if (rendered.kind === "nodes") {
    return (
      <div
        className="note-body"
        onErrorCapture={(e) => {
          const el = e.target as HTMLElement;
          if (el instanceof HTMLImageElement) void retryImageViaFetch(el);
        }}
      >
        {rendered.nodes}
      </div>
    );
  }
  return (
    <div
      className="note-body"
        onErrorCapture={(e) => {
          const el = e.target as HTMLElement;
          if (el instanceof HTMLImageElement) void retryImageViaFetch(el);
        }}
      // 已经过 DOMPurify 消毒
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  );
}
