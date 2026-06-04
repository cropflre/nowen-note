import React, { forwardRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor, Editor, EditorContent, Extension, ReactNodeViewRenderer } from "@tiptap/react";

// 懒加载 docx 内联预览：office 解析器（fflate + 自研 OOXML parser）有几十 KB，
// 而绝大多数会话不会点 docx 附件，所以拆出去按需拉。
const DocxAttachmentPreview = lazy(() => import("@/office/word/DocxAttachmentPreview"));
// 复用的附件详情抽屉（与 FileManager 同一份实现）
import AttachmentDetailDrawer from "@/components/attachmentDetail/AttachmentDetailDrawer";
import { posToDOMRect } from "@tiptap/core";
import { AnimatePresence, motion } from "framer-motion";import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Image from "@tiptap/extension-image";
import ResizableImageView from "./ResizableImageView";
import { TableGridPicker, TableResizeDialog } from "./TableGridPicker";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Underline from "@tiptap/extension-underline";
import Highlight from "@tiptap/extension-highlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table, TableHeader, TableCell } from "@tiptap/extension-table";
import Mention from "@tiptap/extension-mention";
import MentionPicker from "@/components/MentionPicker";
// 自定义 TableRow：在原扩展基础上加 height 持久化 attribute + 行高拖拽手柄。
// 之所以从 @tiptap/extension-table 解构里去掉 TableRow，是因为下面要用扩展过的版本，
// 同名导出会冲突。行高语义为"min-height"——内容超出仍会撑开。
import { TableRowResizable } from "./extensions/TableRowResizable";
import TextAlign from "@tiptap/extension-text-align";
import { common, createLowlight } from "lowlight";
import { DOMParser as ProseMirrorDOMParser, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { markdownToSimpleHtml } from "@/lib/importService";
import { repairTiptapJson } from "@/lib/tiptapSchemaRepair";
import { markdownToHtml as mdToFullHtml, detectFormat as detectContentFormat, tiptapJsonToMarkdown } from "@/lib/contentFormat";
import { api } from "@/lib/api";
import { extractRtfImagesAsync } from "@/lib/rtfImageWorkerClient";
import { replaceDataUrlImagesWithAttachments } from "@/lib/rtfImageUploader";
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  List, ListOrdered, Heading1, Heading2, Heading3,
  Quote, ImagePlus, Film, Paperclip, CheckSquare, Highlighter, Minus, Undo, Redo,
  Code, FileCode, Sparkles, X, ZoomIn, ZoomOut, RotateCcw,
  Indent, Outdent, AlignLeft, AlignCenter, AlignRight, Trash2,
  FileType, Check, AlertCircle, Info, ArrowUp, Link as LinkIcon,
  ExternalLink, Unlink2, Workflow, Sigma, BookOpen, Download,
  Type, Palette, Eraser, ChevronDown, Search,
  // 表格气泡菜单图标
  Rows3, Columns3, Merge, Split, Heading,
} from "lucide-react";
import { downloadAttachment } from "@/lib/downloadFile";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { prompt as promptDialog } from "@/components/ui/confirm";
import { Note, Tag } from "@/types";
import TagInput from "@/components/TagInput";
import AIWritingAssistant from "@/components/AIWritingAssistant";
import type { NoteEditorHandle, NoteEditorHeading, NoteEditorProps } from "@/components/editors/types";
import type { FormatMenuPayload } from "@/lib/desktopBridge";
import { sendFormatState } from "@/lib/desktopBridge";
import { SlashCommandsMenu, getDefaultSlashCommands, createSlashExtension, createSlashEventHandlers } from "@/components/SlashCommands";
import { MarkdownEnhancements } from "@/components/MarkdownEnhancements";
import { MathExtensions } from "@/components/MathExtensions";
import { FootnoteExtensions, nextFootnoteIdentifier } from "@/components/FootnoteExtensions";
import {
  TextStyleKit,
  FONT_SIZE_PRESETS,
  COLOR_PRESETS,
  HIGHLIGHT_PRESETS,
} from "@/components/FontSizeExtension";
import CodeBlockView from "@/components/CodeBlockView";
import { SearchReplacePanel, createSearchReplaceExtension } from "@/components/SearchReplacePanel";
import { Video as VideoExtension } from "@/components/VideoExtension";

import { useTranslation } from "react-i18next";

const lowlight = createLowlight(common);

// ---------------------------------------------------------------------------
// ProseMirror 防御性补丁：避免 "Position X out of range" RangeError 导致崩溃
// ---------------------------------------------------------------------------
// 背景：
//   ProseMirror 的 DOMObserver 在某些情况下（如中文 IME composition、React
//   NodeView 的 DOM 结构与 PM 文档树短暂不一致、inputRule 引起的节点类型转换
//   等）会调用 Node.resolve(pos) 解析一个越界（常为负数）的位置，直接抛出
//   未被捕获的 RangeError，导致整个编辑器崩溃、页面显示异常。
//
// 思路：
//   覆盖 Node.prototype.resolve，对越界位置钳制到 [0, content.size] 范围内
//   再调用原实现。对于绝大多数场景：
//     - 合法位置：行为完全不变（走原 resolve 路径）。
//     - 越界位置：返回一个合法端点的 ResolvedPos，而不是抛错崩溃。
//
//   这与 PM 的设计哲学兼容：它会在下一次事务中通过 DOMObserver 重新同步 DOM
//   与文档树，通常一瞬即恢复一致；而崩溃后编辑器无法继续操作，用户必须刷新。
//
// 这是全局一次性补丁，使用 Symbol 防重复应用。
// ---------------------------------------------------------------------------
const RESOLVE_PATCHED = Symbol.for("nowen.pm.resolve.patched");
if (!(ProseMirrorNode.prototype as any)[RESOLVE_PATCHED]) {
  const originalResolve = ProseMirrorNode.prototype.resolve;
  ProseMirrorNode.prototype.resolve = function patchedResolve(pos: number) {
    const size = this.content.size;
    if (pos < 0 || pos > size) {
      // 位置越界：钳制到合法范围，避免抛 RangeError 崩溃。
      // 记录一次警告方便排查，但不中断用户输入。
      if (typeof console !== "undefined" && console.warn) {
        console.warn(
          `[PM Patch] resolve() called with out-of-range position ${pos} (valid: 0..${size}); clamped.`
        );
      }
      const clamped = Math.max(0, Math.min(size, pos));
      return originalResolve.call(this, clamped);
    }
    return originalResolve.call(this, pos);
  };
  (ProseMirrorNode.prototype as any)[RESOLVE_PATCHED] = true;
}

// ---------------------------------------------------------------------------
// 粘贴 HTML 归一化：把"伪多行段落"拆成真正的多个 <p>
// ---------------------------------------------------------------------------
// 很多来源（微信/QQ/钉钉/飞书网页复制、Word、部分浏览器富文本）在 clipboard
// 的 text/html 里会把多行文本序列化成：
//     <p>行1<br>行2<br>行3</p>          ← 同一段落内多个 <br>
//     <div>行1</div><div>行2</div>       ← 多个 <div> 当段落
// 这种结构粘到 Tiptap 后 ProseMirror 会解析成**一个 paragraph 节点里多个
// hardBreak**，视觉上是多行，但块级操作（toggleHeading / setParagraph /
// blockquote）会把**整段**转换，就出现"只选一行却整段变标题"的 bug。
//
// 这里在粘贴进入 PM DOMParser 之前，把顶层的 <br> 拆成段落边界、把 <div>
// 统一升级为 <p>，让 PM 看到的是真正的多段落结构。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// rescuePastedImages：从论坛 / 懒加载页面复制 HTML 时，<img src> 经常是
// 1×1 占位图（如 Discuz 的 static/image/common/none.gif），真正的图片地址
// 藏在 file / zoomfile / data-src / data-original / data-lazy-src 等自定义
// 属性里。这里把这些属性值"救"回到 src，并尝试把相对路径补成绝对 URL，
// 避免粘贴后图片完全消失或显示成 1×1 透明块。
//
// 选择第一个非空的"看起来像真正图片地址"的属性值；若 src 已经是绝对的
// http(s)/data:/blob: URL 则保留不动（不覆盖用户原本就正常的图）。
//
// 返回值：{ total, rescued, failed }
//   total   - 处理到的 <img> 总数
//   rescued - 从 data-src / file / srcset 等候选属性救回真实地址的 <img> 数
//   failed  - 仍然没有可用 src 的 <img>（通常是原网页图片还没加载完就被复制）
// ---------------------------------------------------------------------------
type RescueStats = { total: number; rescued: number; failed: number };
function rescuePastedImages(root: Element): RescueStats {
  const stats: RescueStats = { total: 0, rescued: 0, failed: 0 };
  // 1) 先扫一遍找出本片段内"任意一个绝对 URL 的 origin"，作为相对路径的 base。
  //    优先用 <a href>/<link href>/已经是绝对地址的 <img src>，因为 Discuz
  //    复制过来的 HTML 往往带有指向源站的链接（如附件下载链接）。
  let pasteBaseOrigin: string | null = null;
  const pickOrigin = (raw: string | null) => {
    if (pasteBaseOrigin || !raw) return;
    if (!/^https?:\/\//i.test(raw)) return;
    try {
      pasteBaseOrigin = new URL(raw).origin;
    } catch {
      /* ignore malformed */
    }
  };
  root.querySelectorAll("a[href]").forEach((a) => pickOrigin(a.getAttribute("href")));
  root.querySelectorAll("img").forEach((img) => {
    pickOrigin(img.getAttribute("src"));
    pickOrigin(img.getAttribute("file"));
    pickOrigin(img.getAttribute("zoomfile"));
    pickOrigin(img.getAttribute("data-src"));
    pickOrigin(img.getAttribute("data-original"));
  });

  // 2) 占位图特征：Discuz/typecho/常见 lazyload 库都用极小的 gif/png 占位，
  //    或干脆 src 为空、为 about:blank。命中即视为"需要救援"。
  const isPlaceholderSrc = (src: string | null): boolean => {
    if (!src) return true;
    const s = src.trim();
    if (!s || s === "about:blank") return true;
    // data:image/gif;base64,R0lGODlh...（1×1 透明 gif/png 占位）
    if (/^data:image\/(gif|png);base64,/i.test(s) && s.length < 200) return true;
    // Discuz 标准占位
    if (/\/none\.gif(\?|$)/i.test(s)) return true;
    if (/\/(blank|placeholder|spacer|grey|loading)\.(gif|png|svg)(\?|$)/i.test(s)) return true;
    return false;
  };

  // 3) 把相对/协议相对路径补成绝对 URL（找不到 base 则保持原样，让浏览器自行决定）
  const toAbsolute = (url: string): string => {
    const u = url.trim();
    if (!u) return u;
    if (/^(https?:|data:|blob:)/i.test(u)) return u;
    if (u.startsWith("//")) return `https:${u}`;
    if (!pasteBaseOrigin) return u;
    if (u.startsWith("/")) return `${pasteBaseOrigin}${u}`;
    return `${pasteBaseOrigin}/${u.replace(/^\.?\//, "")}`;
  };

  // 从 srcset 字符串中挑一个 URL（优先最高分辨率）。
  //   "url1 1x, url2 2x"  → url2
  //   "url1 320w, url2 1280w" → url2
  //   "url1"              → url1
  const pickFromSrcset = (raw: string | null): string | null => {
    if (!raw) return null;
    const entries = raw
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean)
      .map((e) => {
        // 允许 URL 内含空格（罕见）；取最后一段做 descriptor
        const m = e.match(/^(\S+)(?:\s+(\S+))?$/);
        if (!m) return null;
        const url = m[1];
        const desc = (m[2] || "").toLowerCase();
        let weight = 0;
        if (desc.endsWith("w")) weight = parseFloat(desc);
        else if (desc.endsWith("x")) weight = parseFloat(desc) * 1000; // 粗略统一量纲
        else weight = 0;
        return { url, weight };
      })
      .filter((x): x is { url: string; weight: number } => !!x);
    if (entries.length === 0) return null;
    entries.sort((a, b) => b.weight - a.weight);
    return entries[0].url;
  };

  // 4) 救援每一个 <img>：按优先级挑一个有效的真实地址覆盖到 src
  root.querySelectorAll("img").forEach((img) => {
    stats.total += 1;
    const currentSrc = img.getAttribute("src");
    // src 已经是合法且非占位的远端/data URL → 不动
    //   注意：file:// 不算合法（浏览器出于安全限制不会加载），
    //   Word 复制过来的 <img src="file:///C:/Users/.../clip_image001.png"> 必须走救援流程。
    if (currentSrc && /^(https?:|data:|blob:)/i.test(currentSrc) && !isPlaceholderSrc(currentSrc)) {
      return;
    }
    // 候选属性顺序：Discuz 的 zoomfile（点击放大原图）> file > 通用 lazyload 属性
    // 覆盖主流懒加载库与站点：lazysizes、lozad、jQuery.lazyload、微信公众号、
    // CSDN、简书、掘金、知乎、博客园、Medium 等
    const candidates = [
      "zoomfile",
      "file",
      "data-src",
      "data-original",
      "data-lazy-src",
      "data-actualsrc",
      "data-echo",
      "data-raw-src",
      "data-original-src",
      "data-src-large",
      "data-src-hd",
      "data-hires",
      "data-full",
      "data-url",
      "data-href",
    ];
    let picked: string | null = null;
    for (const attr of candidates) {
      const v = img.getAttribute(attr);
      if (v && v.trim()) {
        picked = v.trim();
        break;
      }
    }
    // 从 data-srcset / srcset 挑最大尺寸
    if (!picked) {
      picked = pickFromSrcset(img.getAttribute("data-srcset"))
        || pickFromSrcset(img.getAttribute("srcset"));
    }
    // 从父层 <picture> 的 <source srcset> 挑最大尺寸
    if (!picked) {
      const picture = img.closest("picture");
      if (picture) {
        const sources = Array.from(picture.querySelectorAll("source"));
        for (const s of sources) {
          const url = pickFromSrcset(s.getAttribute("srcset"))
            || pickFromSrcset(s.getAttribute("data-srcset"));
          if (url) {
            picked = url;
            break;
          }
        }
      }
    }
    // 候选都没有，但当前 src 是相对路径（非占位）→ 也尝试补全
    if (!picked && currentSrc && !isPlaceholderSrc(currentSrc)) {
      picked = currentSrc;
    }
    if (!picked) {
      // 救不回来，记一笔（常见来源：
      //   a) 懒加载网页图片未加载完；
      //   b) Word/WPS 复制而来 —— HTML 里 <img src="file:///..."> 浏览器无法加载）
      // 从片段中移除该 <img>，避免最终笔记里出现破图图标。
      stats.failed += 1;
      img.remove();
      return;
    }
    const abs = toAbsolute(picked);
    if (abs && /^(https?:|data:|blob:)/i.test(abs)) {
      img.setAttribute("src", abs);
      // 顺手清掉 file:// 的 data-* 与 srcset，避免干扰下游
      img.removeAttribute("srcset");
      stats.rescued += 1;
    } else {
      stats.failed += 1;
      img.remove();
    }
  });

  // 5) Discuz 把 <img> 包在 <ignore_js_op> 里（一个 Discuz 自造标签，
  //    PM schema 认不出会被丢，连带 <img> 一起丢）。这里把它替换为 <span>。
  root.querySelectorAll("ignore_js_op").forEach((el) => {
    const span = el.ownerDocument.createElement("span");
    while (el.firstChild) span.appendChild(el.firstChild);
    el.replaceWith(span);
  });

  return stats;
}

// ---------------------------------------------------------------------------
// isWordLikeHtml：判断剪贴板 HTML 是否来自 Microsoft Word / WPS / Outlook
// ---------------------------------------------------------------------------
// Office 系产品在写剪贴板 HTML 时有非常稳定的"指纹"：
//   - <html xmlns:o="urn:schemas-microsoft-com:office:office"> 等 Office 命名空间
//   - CSS class 带 Mso 前缀（MsoNormal、MsoListParagraph 等）
//   - 专有标签：<o:p>、<v:shape>、<v:imagedata>
//   - 注释 "ProgId" 指示 MS Office HTML
//   - <img src="file:///..."> 指向 Word 临时目录的本地图片（复制到其他程序后不可访问）
//
// 识别这些来源是为了在图片丢失时给出**更有针对性**的提示，告诉用户
// "Word 粘贴带不过来图片，请改用导入 Word 文档"。
// ---------------------------------------------------------------------------
function isWordLikeHtml(html: string): boolean {
  if (!html) return false;
  const head = html.slice(0, 4096); // 指纹基本都在头部，避免扫全量大块
  return (
    /xmlns:o="urn:schemas-microsoft-com:office/i.test(head) ||
    /xmlns:w="urn:schemas-microsoft-com:office:word/i.test(head) ||
    /<meta[^>]+content=["']?[^"']*Microsoft[^"']*Word/i.test(head) ||
    /ProgId["']?\s*=?\s*["']?Word\.Document/i.test(head) ||
    /class=["'][^"']*Mso[A-Z]/i.test(html) ||
    /<o:p[\s>/]/i.test(html) ||
    /<v:imagedata\b/i.test(html) ||
    /<v:shape\b/i.test(html)
  );
}

// ---------------------------------------------------------------------------
// extractImagesFromRtf：从 Word/WPS 粘贴的 RTF 里提取内联图片。
//
// 背景：Word 全选复制时，text/html 里的 <img> src 通常是 "file:///C:/Users/
// .../clip_image001.png" 等本地路径（浏览器出于安全限制无法加载），而真正
// 的图像二进制放在同时携带的 text/rtf 中，以 \pngblip 或 \jpegblip 开头、
// 后跟一大段十六进制字符、以 `}` 结束。腾讯文档 / Google Docs 粘贴能保留
// 图片就是因为它们解析了 RTF 通道。
//
// 返回顺序的 data URL 数组，与 HTML 里 <img> 出现顺序一一对应。
// ---------------------------------------------------------------------------
function hexToBase64(hex: string): string {
  // hex 字符串转 Uint8Array 再转 base64。采用分块 String.fromCharCode
  // 避免一次性 apply 超大数组栈溢出。
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const len = Math.floor(clean.length / 2);
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK))
    );
  }
  return btoa(binary);
}

function extractImagesFromRtf(rtf: string): string[] {
  const result: string[] = [];
  if (!rtf || rtf.length === 0) return result;
  // 以 \pict 块为单位扫描（Word 每张图都包在 {\pict ... } 里）。
  // 正则说明：
  //   \{\\\*?\\?pict      匹配 "{\pict" 或 "{\*\pict"（兼容部分写法）
  //   [\s\S]*?            非贪婪匹配块内内容
  //   (\\pngblip|\\jpegblip)   图片格式标识
  //   ([\s\S]*?)          捕获十六进制（含空白和换行）
  //   \}                  块结束
  // 用简化版：直接定位 \pngblip / \jpegblip，然后往后读十六进制直到遇到
  // 非 hex（通常是 `}` 或控制字）。这样对嵌套 {} 容忍度更高。
  const re = /\\(pngblip|jpegblip)[^}]*?([0-9a-fA-F\s]{32,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rtf)) !== null) {
    const format = m[1] === "pngblip" ? "png" : "jpeg";
    const hex = m[2];
    try {
      const b64 = hexToBase64(hex);
      if (b64.length > 0) {
        result.push(`data:image/${format};base64,${b64}`);
      }
    } catch {
      /* 单张图损坏不影响其他 */
    }
  }
  return result;
}

// 把 HTML 里的占位 <img>（file:///、v:imagedata、空 src 等）按出现顺序
// 替换成从 RTF 提取出来的 data URL。返回替换后的 HTML。
// 若 rtfImages 数量少于 HTML 里的 <img>，多出来的 <img> 保持原样（让后续
// rescue 流程去清理 / 标记为 failed）。
function mergeRtfImagesIntoHtml(html: string, rtfImages: string[]): string {
  if (!rtfImages.length || !html) return html;
  try {
    const doc = new DOMParser().parseFromString(
      `<div id="__root">${html}</div>`,
      "text/html"
    );
    const root = doc.getElementById("__root");
    if (!root) return html;
    // Word 有时会用 <v:imagedata src="file://..."/>（VML）承载图片占位，
    // 这些节点本身不是 <img>；但它们通常被 <img> 包裹或与 <img> 成对出现。
    // 这里只按顺序替换普通 <img> 的 src，已能覆盖 Word 的主流情况。
    const imgs = Array.from(root.querySelectorAll("img"));
    let cursor = 0;
    for (const img of imgs) {
      if (cursor >= rtfImages.length) break;
      const src = img.getAttribute("src") || "";
      // 只替换"显然无法加载"的占位：file:///、空、vml 协议等。
      // 若 src 已经是 http/https/data/blob，保留不动。
      const needReplace =
        !src ||
        /^file:\/\//i.test(src) ||
        /^about:/i.test(src) ||
        src.trim().length === 0;
      if (needReplace) {
        img.setAttribute("src", rtfImages[cursor]);
        cursor += 1;
      }
    }
    return root.innerHTML;
  } catch {
    return html;
  }
}

function normalizePastedHtmlForBlocks(html: string): { html: string; imageStats: RescueStats; isWordSource: boolean } {
  const empty: RescueStats = { total: 0, rescued: 0, failed: 0 };
  if (!html) return { html, imageStats: empty, isWordSource: false };
  const isWordSource = isWordLikeHtml(html);
  try {
    const doc = new DOMParser().parseFromString(`<div id="__root">${html}</div>`, "text/html");
    const root = doc.getElementById("__root");
    if (!root) return { html, imageStats: empty, isWordSource };

    // 0) 先抢救图片：把 Discuz / 懒加载站点中藏在 file/zoomfile/data-src
    //    等属性里的"真正图片地址"提升到 src，并补全相对路径，
    //    避免后续 PM DOMParser 把"src 是占位 / 空 / 相对路径"的 <img> 节点丢掉。
    const imageStats = rescuePastedImages(root);

    // 1) 顶层 <div> 直接替换为 <p>（保留内部内联内容）
    //    注意只处理"直接子节点层"，不递归改动引用/表格内的 <div>。
    Array.from(root.children).forEach((child) => {
      if (child.tagName === "DIV") {
        const p = doc.createElement("p");
        while (child.firstChild) p.appendChild(child.firstChild);
        child.replaceWith(p);
      }
    });

    // 2) 递归遍历 block 元素内部：<p>/<h1..h6>/<li>/<blockquote> 里若出现顶层 <br>，
    //    就按 <br> 切成多个同类型的兄弟节点（对 <p> 最常见，对标题也适用）。
    const splitByTopLevelBr = (el: Element) => {
      const brs = Array.from(el.children).filter((c) => c.tagName === "BR");
      if (brs.length === 0) return;
      const parent = el.parentNode;
      if (!parent) return;
      // 收集每一段内容（按 <br> 切分的内联片段）
      const groups: Node[][] = [[]];
      Array.from(el.childNodes).forEach((n) => {
        if (n.nodeType === 1 && (n as Element).tagName === "BR") {
          groups.push([]);
        } else {
          groups[groups.length - 1].push(n);
        }
      });
      // 丢掉完全空白的首/尾段，中间空段保留为空段落（符合用户视觉预期）
      while (groups.length && isWhitespaceGroup(groups[0])) groups.shift();
      while (groups.length && isWhitespaceGroup(groups[groups.length - 1])) groups.pop();
      if (groups.length <= 1) return; // 没有实际切分效果
      const frag = doc.createDocumentFragment();
      groups.forEach((nodes) => {
        const clone = doc.createElement(el.tagName.toLowerCase());
        // 拷贝属性（保留 class/style 等）
        Array.from(el.attributes).forEach((a) => clone.setAttribute(a.name, a.value));
        nodes.forEach((n) => clone.appendChild(n));
        frag.appendChild(clone);
      });
      parent.replaceChild(frag, el);
    };

    const isWhitespaceGroup = (nodes: Node[]) =>
      nodes.every((n) => n.nodeType === 3 && !(n.nodeValue || "").trim());

    // 只拆顶层 block：<p> <h1..h6>，避免破坏列表/表格/代码块内部结构
    const topBlocks = Array.from(root.querySelectorAll(":scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6"));
    topBlocks.forEach(splitByTopLevelBr);

    return { html: root.innerHTML, imageStats, isWordSource };
  } catch (e) {
    // 异常时不阻塞粘贴流程，返回原 HTML
    if (typeof console !== "undefined") console.warn("[normalizePastedHtmlForBlocks] failed:", e);
    return { html, imageStats: empty, isWordSource };
  }
}

// ---------------------------------------------------------------------------
// 智能 toggleHeading：先把当前段落里的 hardBreak 拆成独立段落，再 toggle
// ---------------------------------------------------------------------------
// 对应用户场景：老数据里已经存在"一个 <p> + 多个 <br>"的伪多行段落。
// 若用户只选中其中几个字点 H1，期望只把这一行转成标题，而不是整段。
//
// 策略：
//   1) 找到选区所覆盖的 paragraph 节点范围；
//   2) 对这些 paragraph 里的 hardBreak，从后往前遍历（避免位置偏移问题），
//      在 hardBreak 处执行 split（把前后切成两个 paragraph），并删除 hardBreak
//      自身；
//   3) split 完成后，用户光标会自然落到他原本选中的那一行对应的新段落里；
//   4) 最后调用标准 toggleHeading，只影响该段。
//
// 如果原段落里没有 hardBreak，直接走标准 toggleHeading（无性能损失）。
// ---------------------------------------------------------------------------
function toggleHeadingSmart(editor: any, level: 1 | 2 | 3 | 4 | 5 | 6) {
  if (!editor || editor.isDestroyed) return;
  try {
    const { state } = editor;
    const hardBreakType = state.schema.nodes.hardBreak;
    if (!hardBreakType) {
      editor.chain().focus().toggleHeading({ level }).run();
      return;
    }
    const { from, to } = state.selection;

    // 找出选区覆盖的"块级文本节点"（paragraph / heading）的位置区间
    const blocks: Array<{ from: number; to: number }> = [];
    state.doc.nodesBetween(from, to, (node: any, pos: number) => {
      if (node.type.name === "paragraph" || node.type.name === "heading") {
        blocks.push({ from: pos, to: pos + node.nodeSize });
        return false; // 不再深入（hardBreak 在叶子内部）
      }
      return true;
    });
    if (blocks.length === 0) {
      editor.chain().focus().toggleHeading({ level }).run();
      return;
    }

    // 收集所有需要拆的 hardBreak 绝对位置（倒序处理）
    const breakPositions: number[] = [];
    blocks.forEach((b) => {
      state.doc.nodesBetween(b.from, b.to, (node: any, pos: number) => {
        if (node.type === hardBreakType) breakPositions.push(pos);
      });
    });

    if (breakPositions.length === 0) {
      editor.chain().focus().toggleHeading({ level }).run();
      return;
    }

    // 倒序拆分：在每个 hardBreak 处 split paragraph 并删除 hardBreak。
    // tr.delete(pos, pos+1) + tr.split(pos) 会把 hardBreak 所在位置切成两个段落。
    const tr = state.tr;
    // 在未应用中间事务时，同一份 doc 上所有位置仍相对稳定；倒序保证前面位置不被影响。
    breakPositions.sort((a, b) => b - a);
    breakPositions.forEach((pos) => {
      // 删除 hardBreak（1 个位置），然后在原位置 split 到 paragraph 层
      tr.delete(pos, pos + 1);
      tr.split(pos);
    });
    editor.view.dispatch(tr);

    // split 后再触发 toggleHeading：此时光标所在段落就是单行
    editor.chain().focus().toggleHeading({ level }).run();
  } catch (e) {
    if (typeof console !== "undefined") console.warn("[toggleHeadingSmart] fallback:", e);
    editor.chain().focus().toggleHeading({ level }).run();
  }
}

// 自定义缩进扩展
// 支持段落、标题、列表（bullet / ordered / task）、引用、代码块整体做"手动缩进"调整。
// 通过 data-indent 属性 + CSS 的 padding-left 实现纯视觉缩进，不破坏文档结构。
const INDENT_MIN = 0;
const INDENT_MAX = 8;
const INDENTABLE_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "bulletList",
  "orderedList",
  "taskList",
] as const;

const IndentExtension = Extension.create({
  name: "indent",
  addGlobalAttributes() {
    return [
      {
        types: [...INDENTABLE_TYPES],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element) => parseInt(element.getAttribute("data-indent") || "0", 10),
            renderHTML: (attributes) => {
              if (!attributes.indent || attributes.indent === 0) return {};
              return { "data-indent": attributes.indent };
            },
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      // 对选区覆盖的可缩进块按 delta 调整 indent（限制 0..INDENT_MAX）
      changeIndent: (delta: number) => ({ state, tr, dispatch }: any) => {
        const { from, to } = state.selection;
        let changed = false;
        state.doc.nodesBetween(from, to, (node: any, pos: number) => {
          if (!(INDENTABLE_TYPES as readonly string[]).includes(node.type.name)) return;
          const current = (node.attrs as any).indent || 0;
          const next = Math.max(INDENT_MIN, Math.min(INDENT_MAX, current + delta));
          if (next === current) return;
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
          changed = true;
        });
        if (changed && dispatch) dispatch(tr);
        return changed;
      },
    } as any;
  },
});

/**
 * 键盘扩展：
 *   - Tab / Shift-Tab：智能缩进 —— 代码块内插空格；列表内 sink/lift；表格内由 tiptap-table 处理；其余调块级 indent。
 *   - Mod-s：立即保存（由外部通过 ref 注入 flush 函数）。
 */
function createKeyboardExtension(flushSaveRef: React.MutableRefObject<() => void>) {
  return Extension.create({
    name: "nowenKeyboard",
    addKeyboardShortcuts() {
      const editor = this.editor as any;

      const isInCodeBlock = () => editor.isActive("codeBlock");
      const isInTable = () => editor.isActive("table");
      const isInTaskList = () => editor.isActive("taskList") || editor.isActive("taskItem");
      const isInBulletOrOrdered = () =>
        editor.isActive("bulletList") || editor.isActive("orderedList") || editor.isActive("listItem");

      const handleTab = (delta: 1 | -1) => {
        // 表格：交给 tiptap-table 默认的 goToNextCell/goToPreviousCell
        if (isInTable()) return false;

        // 代码块：插入 / 删除 2 个空格
        if (isInCodeBlock()) {
          if (delta === 1) {
            editor.chain().focus().insertContent("  ").run();
            return true;
          } else {
            // Shift+Tab：若光标前有至多 2 个空格则删掉
            const { state } = editor;
            const { from, empty } = state.selection;
            if (!empty) return false;
            const before = state.doc.textBetween(Math.max(0, from - 2), from, "\n", "\n");
            const strip = before.endsWith("  ") ? 2 : before.endsWith(" ") ? 1 : 0;
            if (strip === 0) return true; // 阻止默认行为但不删
            editor.chain().focus().deleteRange({ from: from - strip, to: from }).run();
            return true;
          }
        }

        // 任务列表 / 普通列表：sink / lift
        if (isInTaskList()) {
          const ok = delta === 1
            ? editor.chain().focus().sinkListItem("taskItem").run()
            : editor.chain().focus().liftListItem("taskItem").run();
          if (ok) return true;
          // 若无法 sink/lift（例如已是最外层），退化为块级 indent
        } else if (isInBulletOrOrdered()) {
          const ok = delta === 1
            ? editor.chain().focus().sinkListItem("listItem").run()
            : editor.chain().focus().liftListItem("listItem").run();
          if (ok) return true;
        }

        // 其余：调整块级 indent 属性
        return editor.chain().focus().changeIndent(delta).run();
      };

      // 列表项内 Enter：空项 lift 跳出，非空项 split 出新项。
      // 显式接管全部分支（不依赖 listItem 内置 keymap fallthrough），
      // 避免 tiptap 多 keymap plugin 顺序 / IndentExtension 全局属性
      // 干扰下出现「输入内容也被一次回车跳出列表」的诡异行为。
      const handleEnterInListItem = () => {
        const { state } = editor;
        const { selection } = state;
        if (!selection.empty) return false;
        const $from = selection.$from;
        // 自下往上找最近的 listItem / taskItem
        for (let depth = $from.depth; depth > 0; depth--) {
          const node = $from.node(depth);
          const typeName = node.type.name;
          if (typeName !== "listItem" && typeName !== "taskItem") continue;
          // 判定「空 li」：单段落 + 无文本 + 段落内容尺寸为 0
          const isEmpty =
            node.childCount === 1 &&
            node.textContent === "" &&
            !!node.firstChild &&
            node.firstChild.content.size === 0;
          if (isEmpty) {
            return editor.chain().focus().liftListItem(typeName).run();
          }
          // 非空 li：显式 split，并强制 return true 阻止后续 keymap 再触发一次。
          return editor.chain().focus().splitListItem(typeName).run();
        }
        return false;
      };

      return {
        Backspace: () => {
          const { state } = editor;
          const { selection } = state;
          if (!selection.empty) return false;
          const { $from } = selection;
          if ($from.parentOffset !== 0) return false;
          const parent = $from.parent;
          const parentType = parent.type.name;
          // 行首 Backspace：若有 indent > 0 则先减缩进
          const currentIndent = (parent.attrs as any).indent || 0;
          if (currentIndent > 0) {
            return (editor as any).chain().focus().changeIndent(-1).run();
          }
          // heading → paragraph
          if (parentType === "heading") {
            const paragraphType = state.schema.nodes.paragraph;
            if (!paragraphType) return false;
            const depth = $from.depth;
            const tr = state.tr.setBlockType($from.before(depth), $from.after(depth), paragraphType);
            editor.view.dispatch(tr.scrollIntoView());
            return true;
          }
          return false;
        },
        Tab: () => handleTab(1),
        "Shift-Tab": () => handleTab(-1),
        Enter: () => handleEnterInListItem(),
        "Mod-s": () => {
          flushSaveRef.current?.();
          return true; // 返回 true 阻止浏览器默认的"保存网页"对话框
        },
      };
    },
  });
}

/**
 * 大纲/跳转条目：直接复用共享的 NoteEditorHeading。
 * 保留 `HeadingItem` 名字供历史 `import { HeadingItem } from "./TiptapEditor"` 的引用。
 */
export type HeadingItem = NoteEditorHeading;

interface ToolbarButtonProps {
  onClick: () => void;
  isActive?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  title?: string;
  compact?: boolean;
}

function ToolbarButton({ onClick, isActive, disabled, children, title, compact }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        compact ? "p-1 rounded-md transition-colors" : "p-1.5 rounded-md transition-colors",
        isActive
          ? "bg-accent-primary/20 text-accent-primary"
          : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
        disabled && "opacity-30 cursor-not-allowed"
      )}
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <div className="w-px h-5 bg-app-border mx-1" />;
}

/**
 * 字号选择器（轻量 Popover）
 * - 4 个预设档位 + 自定义 px 输入（8-96）
 * - "清除"：移除当前选区的 fontSize 属性
 * - 通过 onMouseDown preventDefault 防止编辑器 blur，保证 setMark 后选区还在
 */
interface FontSizePopoverProps {
  editor: any;
  iconSize?: number;
  /** 仅用于气泡菜单，UI 紧凑一些 */
  compact?: boolean;
}
function FontSizePopover({ editor, iconSize = 15, compact = false }: FontSizePopoverProps) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const currentSize: string | null = editor.getAttributes("textStyle")?.fontSize || null;

  // 打开时基于按钮位置计算弹层坐标（fixed 定位，避免被工具栏 overflow-x-auto 裁切）
  useEffect(() => {
    if (!open || !btnRef.current) return;
    const update = () => {
      const r = btnRef.current!.getBoundingClientRect();
      const POP_W = 176; // w-44
      let left = r.left;
      if (left + POP_W > window.innerWidth - 8) left = window.innerWidth - POP_W - 8;
      if (left < 8) left = 8;
      setPos({ top: r.bottom + 4, left });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  // 点击外部关闭（同时考虑按钮和弹层两个区域）
  useEffect(() => {
    if (!open) return;
    const onInteract = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      if ((t as Element)?.closest?.('[data-popover]')) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onInteract, true);
    return () => document.removeEventListener("mousedown", onInteract, true);
  }, [open]);

  const apply = (size: string) => {
    if (!size) return;
    editor.chain().focus().setFontSize(size).run();
    setOpen(false);
  };
  const clear = () => {
    editor.chain().focus().unsetFontSize().run();
    setOpen(false);
  };
  const applyCustom = () => {
    const raw = custom.trim();
    if (!raw) return;
    // 用户只输了数字 → 默认 px
    const size = /^\d+(\.\d+)?$/.test(raw) ? `${raw}px` : raw;
    apply(size);
    setCustom("");
  };

  const btnSize = compact ? 14 : iconSize;
  return (
    <div ref={ref} className="relative" onMouseDown={(e) => e.preventDefault()}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`${currentSize ? `字号: ${currentSize}` : "字号"}`}
        className={cn(
          "p-1.5 rounded-md transition-colors flex items-center gap-0.5",
          currentSize
            ? "bg-accent-primary/20 text-accent-primary"
            : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
        )}
      >
        <Type size={btnSize} />
        <ChevronDown size={10} className="opacity-60" />
      </button>
      {open && createPortal(
        <div
          ref={popRef}
          style={{ position: "fixed", top: pos.top, left: pos.left }}
          className="z-[100] w-52 p-2 rounded-lg shadow-lg bg-app-elevated border border-app-border"
          data-popover=""
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="text-[11px] text-tx-tertiary px-1 pb-1">预设</div>
          <div className="grid grid-cols-2 gap-1">
            {FONT_SIZE_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => apply(p.value)}
                className={cn(
                  "px-2 py-1 rounded text-left hover:bg-app-hover flex items-baseline gap-1.5",
                  currentSize === p.value && "bg-accent-primary/15 text-accent-primary",
                )}
              >
                {/* 弹层内统一字号，避免 24px"超大"撑破布局；预览效果在编辑区呈现 */}
                <span className="text-[13px] font-medium leading-tight">{p.label}</span>
                <span className="text-[10px] text-tx-tertiary">{p.value}</span>
              </button>
            ))}
          </div>
          <div className="text-[11px] text-tx-tertiary px-1 pt-2 pb-1">自定义 (8–96 px)</div>
          <div className="flex gap-1">
            <input
              type="text"
              inputMode="numeric"
              placeholder="如 18 或 18px"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  applyCustom();
                }
              }}
              // 阻止冒泡到弹层根 div 的 onMouseDown preventDefault，
              // 否则浏览器认为 mousedown 默认行为被取消，input 不会获得 focus，
              // 表现为"输入框打不进字"。
              onMouseDown={(e) => e.stopPropagation()}
              className="flex-1 px-2 py-1 text-xs rounded border border-app-border bg-app-surface focus:outline-none focus:ring-1 focus:ring-accent-primary"
            />
            <button
              type="button"
              onClick={applyCustom}
              className="px-2 py-1 text-xs rounded bg-accent-primary text-white hover:opacity-90"
            >
              <Check size={12} />
            </button>
          </div>
          <div className="border-t border-app-border my-2" />
          <button
            type="button"
            onClick={clear}
            className="w-full px-2 py-1 text-xs rounded text-tx-secondary hover:bg-app-hover flex items-center gap-1"
          >
            <Eraser size={12} />
            清除字号
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

/**
 * 颜色 / 高亮选择器（双 Tab）
 * - 前景色：基于 TextStyle + Color 扩展（setColor / unsetColor）
 * - 背景色：基于 Highlight multicolor 扩展（setHighlight {color} / unsetHighlight）
 * - 12 色 swatch + <input type="color"> 自定义
 */
interface ColorPopoverProps {
  editor: any;
  iconSize?: number;
  compact?: boolean;
}
function ColorPopover({ editor, iconSize = 15, compact = false }: ColorPopoverProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"fg" | "bg">("fg");
  const ref = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const fgColor: string | null = editor.getAttributes("textStyle")?.color || null;
  const bgColor: string | null = editor.getAttributes("highlight")?.color || null;
  const isActive = !!fgColor || !!bgColor;

  // 打开时基于按钮位置计算弹层坐标（fixed 定位，绕过工具栏 overflow-x-auto 裁切）
  useEffect(() => {
    if (!open || !btnRef.current) return;
    const update = () => {
      const r = btnRef.current!.getBoundingClientRect();
      const POP_W = 224; // w-56
      let left = r.left;
      if (left + POP_W > window.innerWidth - 8) left = window.innerWidth - POP_W - 8;
      if (left < 8) left = 8;
      setPos({ top: r.bottom + 4, left });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onInteract = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      if ((t as Element)?.closest?.('[data-popover]')) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onInteract, true);
    return () => document.removeEventListener("mousedown", onInteract, true);
  }, [open]);

  const applyColor = (c: string) => {
    if (tab === "fg") editor.chain().focus().setColor(c).run();
    else editor.chain().focus().setHighlight({ color: c }).run();
  };
  const clearColor = () => {
    if (tab === "fg") editor.chain().focus().unsetColor().run();
    else editor.chain().focus().unsetHighlight().run();
  };

  const swatches = tab === "fg" ? COLOR_PRESETS : HIGHLIGHT_PRESETS;
  const current = tab === "fg" ? fgColor : bgColor;
  const btnSize = compact ? 14 : iconSize;

  return (
    <div ref={ref} className="relative" onMouseDown={(e) => e.preventDefault()}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={isActive ? `颜色: ${fgColor || ""} ${bgColor ? "背景: " + bgColor : ""}`.trim() : "颜色"}
        className={cn(
          "p-1.5 rounded-md transition-colors flex items-center gap-0.5",
          isActive
            ? "bg-accent-primary/20 text-accent-primary"
            : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
        )}
      >
        <span className="relative inline-flex items-center">
          <Palette size={btnSize} />
          {/* 当前色提示横条 */}
          <span
            className="absolute -bottom-0.5 left-0 right-0 h-0.5 rounded-full"
            style={{ background: fgColor || "transparent" }}
          />
        </span>
        <ChevronDown size={10} className="opacity-60" />
      </button>
      {open && createPortal(
        <div
          ref={popRef}
          style={{ position: "fixed", top: pos.top, left: pos.left }}
          className="z-[100] w-56 p-2 rounded-lg shadow-lg bg-app-elevated border border-app-border"
          data-popover=""
          onMouseDown={(e) => e.preventDefault()}
        >
          {/* Tab */}
          <div className="flex gap-1 mb-2 p-0.5 rounded bg-app-surface">
            <button
              type="button"
              onClick={() => setTab("fg")}
              className={cn(
                "flex-1 px-2 py-1 text-xs rounded transition-colors",
                tab === "fg" ? "bg-app-elevated shadow-sm" : "text-tx-tertiary hover:text-tx-primary",
              )}
            >
              文字
            </button>
            <button
              type="button"
              onClick={() => setTab("bg")}
              className={cn(
                "flex-1 px-2 py-1 text-xs rounded transition-colors",
                tab === "bg" ? "bg-app-elevated shadow-sm" : "text-tx-tertiary hover:text-tx-primary",
              )}
            >
              背景
            </button>
          </div>
          {/* Swatches */}
          <div className="grid grid-cols-6 gap-1.5">
            {swatches.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => applyColor(c)}
                title={c}
                className={cn(
                  "w-7 h-7 rounded border transition-transform hover:scale-110",
                  current?.toLowerCase() === c.toLowerCase()
                    ? "border-accent-primary ring-2 ring-accent-primary/40"
                    : "border-app-border",
                )}
                style={{ background: c }}
              />
            ))}
          </div>
          {/* 自定义颜色 */}
          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={() => { const el = document.querySelector('input[type="color"]') as HTMLInputElement | null; el?.click(); }}
              className="flex items-center gap-1.5 px-2 py-1 text-xs rounded border border-app-border hover:bg-app-hover"
            >
              <input
                type="color"
                value={current || (tab === "fg" ? "#ef4444" : "#fef9c3")}
                onChange={(e) => applyColor(e.target.value)}
                className="sr-only"
              />
              <Palette size={12} className="text-tx-secondary" />
            </button>
            <button
              type="button"
              onClick={clearColor}
              className="ml-auto px-2 py-1 text-xs rounded text-tx-secondary hover:bg-app-hover flex items-center gap-1"
            >
              <Eraser size={12} />
              清除
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/**
 * TiptapEditor props 契约：完全继承 NoteEditorProps，保证和 MarkdownEditor 100% 对齐。
 * 若需要 Tiptap 独有的 prop，请在此处 extends 扩展，而非另起炉灶。
 */
type TiptapEditorProps = NoteEditorProps;

function extractHeadings(editor: any): HeadingItem[] {
  const headings: HeadingItem[] = [];
  const doc = editor.state.doc;
  let idx = 0;
  doc.descendants((node: any, pos: number) => {
    if (node.type.name === "heading") {
      headings.push({
        id: `h-${idx++}`,
        level: node.attrs.level,
        text: node.textContent || "",
        pos,
      });
    }
  });
  return headings;
}

export default forwardRef<NoteEditorHandle, TiptapEditorProps>(function TiptapEditor(
  { note, onUpdate, onTagsChange, onHeadingsChange, onEditorReady, editable = true, isGuest = false },
  ref,
) {
  const titleRef = useRef<HTMLInputElement>(null);
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);
  // P0-1: 标题 debounce 独立 timer。
  //   旧实现 handleTitleChange 复用 debounceTimer，导致：
  //     1) 用户敲内容 500ms 内改标题 → 内容的 debounce 被 clearTimeout 清掉，
  //        标题保存 payload 里虽然带了当前 editor.getJSON()，但**没有更新**
  //        lastEmittedContentRef。
  //     2) PUT 回包 setActiveNote → useEffect([note.id, note.content]) 触发，
  //        自写守卫因 lastEmittedContentRef 未同步而**未命中** → 走 setContent
  //        → 编辑器 DOM 重建 → 用户继续在打的字被截断/回退。
  //   独立 timer 后内容 debounce 不再被标题修改打断；标题保存只发 { title }，
  //   内容字段照常由 onUpdate 的 content debounce 保存。
  const titleDebounceTimer = useRef<NodeJS.Timeout | null>(null);
  const [wordStats, setWordStats] = useState({ chars: 0, charsNoSpace: 0, words: 0 });
  const [showAI, setShowAI] = useState(false);
  const [aiSelectedText, setAiSelectedText] = useState("");
  const [aiPosition, setAiPosition] = useState<{ top: number; left: number } | undefined>();

  // Tiptap @提及选择器状态
  const [tiptapMention, setTiptapMention] = useState<{
    query: string;
    range: any;
    rect: DOMRect | null;
    command: (props: any) => void;
  } | null>(null);
  // 内嵌附件预览：点编辑器里 📎 附件链接 → 右侧抽屉显示附件详情。
  // 采用 attachmentId 走 api.files.get 拿完整详情（包含外链分享 / 重命名 / 引用列表），
  // 与文件管理抽屉体验一致。
  // - id：从 /api/attachments/<uuid> 抠出。
  // - isDocx：docx 走中转渲染（支持上传新版本）；其他走默认 AttachmentPreview。
  const [attachmentPreview, setAttachmentPreview] = useState<
    { id: string; isDocx: boolean; filename: string } | null
  >(null);  // 图片预览状态
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [imageZoom, setImageZoom] = useState(1);
  const [imageDrag, setImageDrag] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  // 编辑器是否聚焦 —— 用来控制移动端浮动工具栏是否显示
  // （未聚焦时键盘其实已经收起，这里是双重保险：避免聚焦到标题栏时误显示）

  // 移动端软键盘是否弹起；用于在原生 + 键盘弹起时隐藏顶部工具栏（走底部浮动工具栏）

  const dragStart = useRef({ x: 0, y: 0, imgX: 0, imgY: 0 });
  const { t, i18n } = useTranslation();

  // ---------- 选区气泡菜单（划词弹出） ----------
  // 手动实现，不依赖 Tiptap 内置 BubbleMenu（v3 下有 overflow-auto 裁剪问题）
  const [bubble, setBubble] = useState<{ open: boolean; top: number; left: number }>({
    open: false, top: 0, left: 0,
  });
  // 图片选中时的快捷尺寸气泡
  const [imageBubble, setImageBubble] = useState<{ open: boolean; top: number; left: number }>({
    open: false, top: 0, left: 0,
  });
  // 光标在表格内时的表格操作气泡（合并/拆分/增删行列等）
  // 与文本/图片气泡互斥：选中图片或选中非空文本时不显示表格气泡
  const [tableBubble, setTableBubble] = useState<{ open: boolean; top: number; left: number }>({
    open: false, top: 0, left: 0,
  });
  // 调整表格尺寸对话框：按行列差值调用 addRow/deleteRow + addColumn/deleteColumn
  // initialRows/Cols 是打开对话框时的当前表格尺寸
  const [resizeDialog, setResizeDialog] = useState<{ open: boolean; rows: number; cols: number }>({
    open: false, rows: 3, cols: 3,
  });
  // 光标停在链接内（且无选区）时浮出的链接气泡：打开 / 编辑 / 取消链接
  // 与 bubble（文本选区格式化）互斥——选区有内容时优先显示文本气泡。
  // 链接气泡：附件链接（href 形如 /api/attachments/<id>）需要单独的下载交互，
  // 因此把 filename 一并存进来——下载时给浏览器一个友好的文件名，否则会用
  // URL 末尾的 uuid 当文件名。filename 取自 <a download="..."> DOM 属性。
  // source 区分气泡触发来源：
  //   - "caret"：光标停在链接里（selectionUpdate 触发），跟随光标，blur 时关
  //   - "hover"：鼠标悬停在链接上（mouseover 触发），不依赖 focus，鼠标离开 + 延迟才关
  // 区分的目的是让两条触发链路互不干扰：hover 离开不能关掉光标停留的气泡，
  // 反之 blur 不能关掉鼠标正在 hover 的气泡。
  // from/to ：该 link mark 在文档里的起止位置。动作按钮（取消链接/编辑链接）
  // 点击时先 setTextSelection({from,to}) 才能让 extendMarkRange("link") 生效——
  // 否则 hover 触发时光标可能不在链接里，unsetLink 会静默失败。
  const [linkBubble, setLinkBubble] = useState<{
    open: boolean; top: number; left: number; href: string; filename: string;
    source: "caret" | "hover"; from: number; to: number;
  }>({
    open: false, top: 0, left: 0, href: "", filename: "", source: "caret", from: 0, to: 0,
  });
  // hover 关闭延迟定时器：用户从链接移到气泡上时给一个缓冲，避免穿过空隙时闪烁
  const linkHoverCloseTimer = useRef<NodeJS.Timeout | null>(null);

  // 斜杠命令事件处理器（稳定引用）
  const slashHandlers = useRef(createSlashEventHandlers());
  const slashExtension = useRef(
    createSlashExtension(
      slashHandlers.current.onActivate,
      slashHandlers.current.onDeactivate,
      slashHandlers.current.onQueryChange,
    )
  );

  // Markdown 粘贴提示 toast
  // "confirm" 变体：检测到 MD 语法后询问用户是否转换，携带 action 按钮回调
  type PasteToastState =
    | { type: "converting" | "success" | "error"; message: string }
    | { type: "confirm"; message: string; actionLabel: string; onAction: () => void };
  const [pasteToast, setPasteToast] = useState<PasteToastState | null>(null);
  const pasteToastTimer = useRef<NodeJS.Timeout | null>(null);

  const showPasteToast = useCallback((type: "converting" | "success" | "error", message: string, duration = 2500) => {
    if (pasteToastTimer.current) clearTimeout(pasteToastTimer.current);
    setPasteToast({ type, message });
    if (type !== "converting") {
      pasteToastTimer.current = setTimeout(() => setPasteToast(null), duration);
    }
  }, []);

  // confirm 变体专用：8 秒自动消失，点按钮或 × 立即关闭
  const showPasteConfirmToast = useCallback(
    (message: string, actionLabel: string, onAction: () => void, duration = 8000) => {
      if (pasteToastTimer.current) clearTimeout(pasteToastTimer.current);
      setPasteToast({ type: "confirm", message, actionLabel, onAction });
      pasteToastTimer.current = setTimeout(() => setPasteToast(null), duration);
    },
    []
  );

  const dismissPasteToast = useCallback(() => {
    if (pasteToastTimer.current) clearTimeout(pasteToastTimer.current);
    setPasteToast(null);
  }, []);

  const editorScrollRef = useRef<HTMLDivElement | null>(null);
  // 防止 setContent 触发 onUpdate 导致无限循环
  const isSettingContent = useRef(false);
  // 保持最新的 note ref，避免闭包引用过期
  const noteRef = useRef(note);
  noteRef.current = note;
  // 保持最新的 onUpdate ref
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  /**
   * 本编辑器最近一次派发给 onUpdate 的 content 字符串。
   *
   * 作用：父级 EditorPane 保存成功后会把 `content` 回填到 `activeNote`，
   * 这会让本组件的 `note.content` 引用变化并触发
   * `useEffect([note.id, note.content])` 去 setContent —— 如果恰好 setContent
   * 的就是"自己刚派出去的那份"，没有意义且可能打断正在继续输入的用户。
   *
   * 守卫策略：
   *   - onUpdate 派出前把 JSON 记到这里
   *   - 同步 effect 里先比对：note.content === lastEmittedContentRef.current 就跳过
   *   - 其他来源（MD 编辑器保存、版本恢复、切换笔记）的变化不会等于这个值，
   *     走正常 setContent 路径
   */
  const lastEmittedContentRef = useRef<string | null>(null);

  // 立即保存（Ctrl/Cmd+S 使用）：清掉 debounce 并立刻调用 onUpdate
  const flushSaveRef = useRef<() => void>(() => {});

  // 稳定的键盘扩展引用（Tab/Shift-Tab/Mod-s）
  const keyboardExtension = useRef(createKeyboardExtension(flushSaveRef));

  const computeStats = useCallback((text: string) => {
    const chars = text.length;
    const charsNoSpace = text.replace(/\s/g, "").length;
    // 中文按字计数 + 英文按空格分词
    const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
    const nonCjk = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, " ").trim();
    const enWords = nonCjk ? nonCjk.split(/\s+/).filter(Boolean).length : 0;
    return { chars, charsNoSpace, words: cjk + enWords };
  }, []);

  const editor: Editor | null = useEditor({
    extensions: [
      keyboardExtension.current,
      StarterKit.configure({
        codeBlock: false,
        // 行内代码（inline code）使用 StarterKit 默认实现：
        //   - 反引号 `text` 触发 input rule 自动转 code mark
        //   - 快捷键 Mod-E（StarterKit 默认）切换
        //   - Markdown 序列化为 `text`
        // 之前显式置 false 是为了配合 codeBlock 一起关，但代码里 IPC "code" 分支、
        // editor.isActive("code")、工具栏按钮都依赖这个 mark，缺失会导致空跑。
        heading: { levels: [1, 2, 3] },
        // 链接：禁止点击自动打开（尤其是 mailto: / tel: 会唤起邮件/电话客户端
        // 造成误触）。保留自动识别 URL、粘贴自动链接等能力；新窗口目标仍通过
        // HTMLAttributes 指定，导出/分享页也沿用。
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          HTMLAttributes: {
            target: "_blank",
            rel: "noopener noreferrer nofollow",
          },
        },
      }),
      Placeholder.configure({
        placeholder: t('tiptap.placeholder'),
        emptyEditorClass: "is-editor-empty",
      }),
      // Image 扩展：在原扩展基础上 (1) 新增 width/height 可持久化属性；
      //             (2) 挂 ResizableImageView，提供选中后四角拖拽改宽度的能力。
      // 序列化 DOM 仍是一个普通 <img>，width/height 作为 HTML 属性，
      // 因此所有导出路径（zip/markdown/分享页/SSR）都无需改动。
      Image.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            width: {
              default: null,
              parseHTML: (element) => {
                const raw = element.getAttribute("width");
                if (!raw) return null;
                const n = parseInt(raw, 10);
                return Number.isFinite(n) && n > 0 ? n : null;
              },
              renderHTML: (attrs) => {
                if (attrs.width == null) return {};
                return { width: attrs.width };
              },
            },
            height: {
              default: null,
              parseHTML: (element) => {
                const raw = element.getAttribute("height");
                if (!raw) return null;
                const n = parseInt(raw, 10);
                return Number.isFinite(n) && n > 0 ? n : null;
              },
              renderHTML: (attrs) => {
                if (attrs.height == null) return {};
                return { height: attrs.height };
              },
            },
          };
        },
        addNodeView() {
          return ReactNodeViewRenderer(ResizableImageView);
        },
      }).configure({
        // inline: true —— 允许图片作为 inline 节点出现在 paragraph / listItem
        // 内部，解决"在有序列表里插图后序号无法顺延"的问题：
        //   若 inline:false，setImage 会把图片作为 block 插入 doc 顶层，
        //   当前 listItem 被截断，后续新 li 在 OL 里等同新起一个 list，
        //   视觉上表现为序号从 1 重新开始（或断开）。
        // inline:true 后，图片直接以 <img> 形式留在当前 <li> 内，
        // 列表结构完整保留，序号自然顺延。
        // NodeView (ResizableImageView) 已用 display:inline-block，视觉兼容。
        inline: true,
        allowBase64: true,
        HTMLAttributes: { class: "rounded-lg max-w-full mx-auto my-4 shadow-md" },
      }),
      CodeBlockLowlight.extend({
        addNodeView() {
          return ReactNodeViewRenderer(CodeBlockView);
        },
      }).configure({ lowlight, defaultLanguage: null as any }),
      Underline,
      Highlight.configure({
        multicolor: true,
        HTMLAttributes: { class: "highlight-mark" },
      }),
      TaskList.configure({
        HTMLAttributes: {
          class: 'task-list',
        },
      }),
      TaskItem.configure({
        nested: true,
        HTMLAttributes: {
          class: 'task-item',
        },
      }),
      Table.configure({
        resizable: true,
        handleWidth: 5,
        cellMinWidth: 60,
        lastColumnResizable: true,
        HTMLAttributes: { class: 'tiptap-table' },
      }),
      // TableRowResizable: 替换原 TableRow，新增行高拖拽能力（rowHeight 存在 <tr style="height">）
      TableRowResizable,
      TableHeader,
      TableCell,
      TextAlign.configure({
        types: ['heading', 'paragraph'],
      }),
      IndentExtension,

      slashExtension.current,
      // Markdown 语法增强：~~删除线~~ / ==高亮== input rule + 智能粘贴 markdown
      ...MarkdownEnhancements,
      // 数学公式：行内 $...$ 与块级 $$...$$（KaTeX 渲染，懒加载）
      ...MathExtensions,
      // 脚注：行内 [^id] 引用 + 块级 [^id]: content 定义
      ...FootnoteExtensions,
      // TextStyle + Color + FontSize：任意字号 + 任意前景色，落地为 <span style>
      // 三件套必须放在所有 mark 扩展之后：避免影响 StarterKit 的 mark 优先级
      // 与 importService / exportService / contentFormat / youdaoNoteService 的
      // extensions 列表保持一致，否则 generateHTML/JSON 时 textStyle 会被
      // schema 过滤掉 → 字号/颜色丢失
      ...TextStyleKit,
      // 查找替换：纯装饰器插件，不污染 schema，不参与导入/导出。
      // 只负责在 doc 上画高亮和维护命中状态，UI 在 SearchReplacePanel。
      createSearchReplaceExtension(),
      // 视频节点：直链 mp4/webm + B 站 / YouTube / 腾讯视频 / Vimeo embed。
      // atom + block + draggable，NodeView 用透明遮罩防 iframe 抢焦点。
      // parseHTML 同时识别 <iframe> / <video>，让剪藏过来的视频内容也能落到此节点。
      VideoExtension,
      Mention.configure({
        HTMLAttributes: {
          class: 'mention text-accent-primary bg-accent-primary/10 px-1.5 py-0.5 rounded font-medium',
        },
        suggestion: {
          char: '@',
          allowSpaces: false,
          render: () => {
            return {
              onStart: (props) => {
                setTiptapMention({
                  query: props.query,
                  range: props.range,
                  rect: props.clientRect ? (props.clientRect() as DOMRect) : null,
                  command: props.command,
                });
              },
              onUpdate: (props) => {
                setTiptapMention((prev) => prev ? {
                  ...prev,
                  query: props.query,
                  range: props.range,
                  rect: props.clientRect ? (props.clientRect() as DOMRect) : null,
                  command: props.command,
                } : null);
              },
              onKeyDown: (props) => {
                if (props.event.key === 'ArrowUp' || props.event.key === 'ArrowDown' || props.event.key === 'Enter' || props.event.key === 'Escape') {
                  return true;
                }
                return false;
              },
              onExit: () => {
                setTiptapMention(null);
              },
            };
          },
        },
      }),
    ],
    content: parseContent(note.content),
    editable,
    editorProps: {
      attributes: {
        class: "prose prose-sm max-w-none focus:outline-none min-h-[300px] px-1",
      },
      // 拦截 mailto: / tel: / sms: 链接的默认点击行为：
      //   - 编辑态：虽然 Link 扩展已配置 openOnClick:false，但浏览器对
      //     <a href="mailto:..."> 的原生点击仍可能被某些系统/浏览器拦截处理；
      //     这里额外以 DOM 事件兜底，防止误触唤起邮件客户端。
      //   - 只读态：extension-link 的 clickHandler 在 view.editable=false 时
      //     直接 return false 放行浏览器默认行为，因此更需要在这里拦住。
      // 其他协议（http/https、相对路径等）不处理，保持默认。
      handleDOMEvents: {
        click: (_view, event) => {
          const target = event.target as HTMLElement | null;
          const anchor = target?.closest?.("a") as HTMLAnchorElement | null;
          if (!anchor) return false;
          const href = anchor.getAttribute("href") || "";
          // 编辑器里所有 📎 附件链接 href 形如：/api/attachments/<uuid>
          // 这里用 href 前缀做识别（而不是 data-attachment 自定义属性）——原因：
          //   StarterKit 默认 Link mark 只保留 href / target / rel / class，
          //   data-attachment / data-size / download 等自定义属性会在 parse/serialize
          //   阶段被丢弃，因此只能依赖 href 模式。
          // 命中后阻止浏览器默认下载，改为右侧抽屉内联预览：
          //   - .docx → DocxAttachmentPreview（自研 OOXML 渲染，支持"上传新版本"）
          //   - 其他  → AttachmentPreview（图片 / 视频 / 文本 / 代码 等）
          // 不支持的格式由 AttachmentPreview 内部显示"该格式不支持内联预览"占位 + 下载兜底。
          const attachmentMatch = /^\/api\/attachments\/[0-9a-fA-F-]{36}/.test(href);
          if (attachmentMatch) {
            // 文件名优先取 download，没有则尝试从链接文字"📎 文件名 (大小)"里抠
            let fname = anchor.getAttribute("download") || "";
            if (!fname) {
              const txt = anchor.textContent || "";
              const m = txt.match(/📎\s*(.+?)\s*\([^)]*\)\s*$/);
              fname = m ? m[1] : txt.replace(/^📎\s*/, "");
            }
            // 从 /api/attachments/<uuid> 中抠 id；regex 已在 attachmentMatch 处验过。
            const idMatch = href.match(/\/api\/attachments\/([0-9a-fA-F-]{36})/);
            const attachmentId = idMatch ? idMatch[1] : "";
            if (!attachmentId) {
              return false;
            }
            event.preventDefault();
            // 打开右侧文件详情抽屉时，同步关闭 hover/caret 触发的链接气泡，
            // 避免气泡（路径预览 + 下载/链接/取消链接）与抽屉同屏并存造成视觉干扰。
            setLinkBubble(b => (b.open ? { ...b, open: false } : b));
            setAttachmentPreview({
              id: attachmentId,
              filename: fname,
              isDocx: /\.docx$/i.test(fname),
            });
            return true;
          }
          if (/^(mailto:|tel:|sms:)/i.test(href)) {
            event.preventDefault();
            const plain = href.replace(/^(mailto:|tel:|sms:)/i, "").split("?")[0];
            const label = /^mailto:/i.test(href)
              ? "邮箱"
              : /^tel:/i.test(href)
              ? "电话"
              : "号码";
            try {
              if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(plain).then(
                  () => toast.success(`已复制${label}：${plain}`),
                  () => toast.info(`${label}：${plain}`),
                );
              } else {
                toast.info(`${label}：${plain}`);
              }
            } catch {
              toast.info(`${label}：${plain}`);
            }
            return true;
          }
          return false;
        },
      },

      handlePaste: (view, event) => {
        // 始终阻止浏览器默认粘贴行为，防止页面跳转到空白页
        event.preventDefault();
        // --- [DIAG] 入口全局探针：确认路径和各通道数据 ---
        try {
          const cd = event.clipboardData;
          const probeHtml = cd?.getData("text/html") || "";
          const probeText = cd?.getData("text/plain") || "";
          const probeRtf = cd?.getData("text/rtf") || "";
          const itemList = cd ? Array.from(cd.items).map((it) => it.kind + "/" + it.type) : [];
          const fileList = cd ? Array.from(cd.files).map((f) => f.name + "/" + f.type + "/" + f.size) : [];
          console.log("[paste-diag] ENTRY",
            " text.len=", probeText.length,
            " html.len=", probeHtml.length,
            " rtf.len=", probeRtf.length,
            " pngblip=", (probeRtf.match(/\\pngblip/g) || []).length,
            " items=", itemList,
            " files=", fileList);
        } catch {}
        try {
          // 1) 处理剪贴板中的图片文件（如截图粘贴）
          //    走 /api/attachments 上传接口：写磁盘 + 落 attachments 行，
          //    编辑器插入的 <img> 引用服务端 URL，避免内联 base64 把文档体积撑大。
          //
          //    ⚠️ 关键：Word / 腾讯文档 等富文本源全选复制时，clipboardData 里
          //    同时存在 text/html（内联 base64 的多张 <img>）和 image/png（通常
          //    只是首张图或缩略合成图）。若直接遍历 items 看到 image/* 就 return，
          //    会"只上传一张图 + 丢掉 HTML 里其余所有图 + 丢掉正文文字"。
          //    因此：当剪贴板同时带有含 <img> 的 HTML 时，让 HTML 分支接管；
          //    只有纯截图场景（HTML 为空 / HTML 不含图）才走上传。
          const items = event.clipboardData?.items;
          const htmlForProbe = event.clipboardData?.getData("text/html") || "";
          const htmlHasImg = htmlForProbe.length > 0 && /<img\b/i.test(htmlForProbe);
          if (items && !htmlHasImg) {
            for (let i = 0; i < items.length; i++) {
              if (items[i].type.startsWith("image/")) {
                console.log("[paste-diag] PATH=items image/* (will upload as screenshot)");
                const file = items[i].getAsFile();
                if (file) {
                  const currentNote = noteRef.current;
                  const insertAtSrc = (src: string) => {
                    const { state: editorState, dispatch } = view;
                    const node = editorState.schema.nodes.image?.create({ src });
                    if (node) {
                      const tr = editorState.tr.replaceSelectionWith(node);
                      dispatch(tr);
                    }
                  };
                  if (currentNote?.id) {
                    showPasteToast("converting", t("tiptap.imageUploading"));
                    api.attachments
                      .upload(currentNote.id, file)
                      .then(({ url }) => {
                        insertAtSrc(url);
                        showPasteToast("success", t("tiptap.imageUploadSuccess"));
                      })
                      .catch((err) => {
                        console.error("Attachment upload failed, falling back to base64:", err);
                        showPasteToast("error", t("tiptap.imageUploadFailed"));
                        // 上传失败兜底：仍用 base64 插入，保证用户不丢失截图
                        const reader = new FileReader();
                        reader.onload = (e) => {
                          const src = e.target?.result as string;
                          if (src) insertAtSrc(src);
                        };
                        reader.readAsDataURL(file);
                      });
                  } else {
                    // 没有 note 上下文（理论上不应发生）：退回 base64
                    const reader = new FileReader();
                    reader.onload = (e) => {
                      const src = e.target?.result as string;
                      if (src) insertAtSrc(src);
                    };
                    reader.readAsDataURL(file);
                  }
                }
                return true;
              }
            }
          }

          // 1b) 非图片文件粘贴（剪贴板里来自资源管理器的复制）：当作附件上传
          //     用 clipboardData.files 比 items 更直观；它已剔除 string 类型项。
          const pastedFiles = Array.from(event.clipboardData?.files || []);
          if (pastedFiles.length > 0) {
            console.log("[paste-diag] PATH=files (attachments upload)");
            const currentNote = noteRef.current;
            if (currentNote?.id) {
              showPasteToast("converting", t("tiptap.attachmentUploading"));
              const insertAttachmentToView = (filename: string, url: string, size: number) => {
                const html = buildAttachmentLinkHtml(filename, url, size);
                const dom = document.createElement("div");
                dom.innerHTML = html;
                const slice = ProseMirrorDOMParser
                  .fromSchema(view.state.schema)
                  .parseSlice(dom);
                view.dispatch(view.state.tr.replaceSelection(slice));
              };
              const insertImageToView = (src: string) => {
                const node = view.state.schema.nodes.image?.create({ src });
                if (node) view.dispatch(view.state.tr.replaceSelectionWith(node));
              };
              const uploadAll = async () => {
                for (const file of pastedFiles) {
                  try {
                    const res = await api.attachments.upload(currentNote.id, file);
                    if (res.category === "image") {
                      insertImageToView(res.url);
                    } else {
                      insertAttachmentToView(res.filename, res.url, res.size);
                    }
                  } catch (err) {
                    console.error("Paste attachment upload failed:", err);
                  }
                }
                showPasteToast("success", t("tiptap.attachmentUploaded"));
              };
              uploadAll();
              return true;
            }
          }

          const text = event.clipboardData?.getData("text/plain") || "";
          const html = event.clipboardData?.getData("text/html") || "";

          // 2) 若当前光标在代码块内：不管来源是 html 还是 text，始终保留原始文本 + 换行
          const { state: stCode } = view;
          const $pasteFrom = stCode.selection.$from;
          let inCodeBlock = false;
          for (let d = $pasteFrom.depth; d >= 0; d--) {
            if ($pasteFrom.node(d).type.name === "codeBlock") {
              inCodeBlock = true;
              break;
            }
          }
          if (inCodeBlock) {
            console.log("[paste-diag] PATH=inCodeBlock (insertText)");
            if (!text) return true;
            const tr = stCode.tr.insertText(text);
            view.dispatch(tr);
            return true;
          }

          // 2.5) RTF 图片恢复分支（Word / WPS 全选粘贴核心路径）——必须早于
          //      looksLikeCode / looksLikeMarkdown 判断，否则 Word 的纯文本
          //      会被它们误判为代码/Markdown 从而 return true 抢走事件，
          //      RTF 通道里的 42 张 \pngblip 图就再也恢复不出来。
          //
          // Word/WPS 复制时的典型剪贴板形态：
          //   - text/plain ：可见文字（数 KB）
          //   - text/html  ：富文本标记；<img src> 多为 "file:///C:/..." 本地路径，
          //                  浏览器无法加载。Chromium 在超大剪贴板（RTF 百 MB 级）
          //                  下首次 getData("text/html") 偶尔返回空字符串，需第二
          //                  次才能读到，用户体感就是"第一次粘贴没反应"。
          //   - text/rtf   ：含所有图片字节，格式为 \pngblip / \jpegblip + 十六进制。
          //
          // 因此只要 RTF 里检测到 \pngblip/\jpegblip，就一律在这里兜底：
          //   a) 若 html 非空：把 RTF 里的图按顺序回填到 <img src=file://> 占位
          //   b) 若 html 为空：用 text/plain 按行拼成简化 HTML，再把 RTF 图片全部
          //                    追加到正文末尾；至少保证"文字 + 图片都不丢"。
          {
            const rtfForImg = event.clipboardData?.getData("text/rtf") || "";
            // 先做廉价探测：只数 \pngblip / \jpegblip 的出现次数，不做解码。
            // 这样能在阻塞主线程做重活之前，立刻决定是否需要弹 loading。
            const blipMatches = rtfForImg.length > 0
              ? rtfForImg.match(/\\(pngblip|jpegblip)/g)
              : null;
            const blipCount = blipMatches ? blipMatches.length : 0;
            if (blipCount > 0) {
              console.log("[paste-diag] PATH=rtf-image-rescue (html.len=", html.length,
                " blipCount=", blipCount, ")");

              // 1) 立刻弹 loading toast。真正的重活（hex→base64）已经挪到
              //    Web Worker 里，主线程完全不会阻塞，toast 和 UI 动画都能
              //    正常刷新。
              showPasteToast(
                "converting",
                t("tiptap.rtfRescueProcessing", { count: blipCount })
              );

              // 2) 保存入口时可见的值到闭包局部，异步流程继续使用。
              const htmlSnapshot = html;
              const textSnapshot = text;
              const noteAtPaste = noteRef.current;

              // 3) 丢给 worker。Worker 通信失败/不可用时 client 内部会自动
              //    降级为主线程同步实现（只会卡，不会错）。
              extractRtfImagesAsync(rtfForImg)
                .then((rtfImages) => {
                  if (view.isDestroyed) return;
                  console.log("[paste-diag] RTF images extracted (worker)=", rtfImages.length);
                  if (rtfImages.length === 0) {
                    dismissPasteToast();
                    return;
                  }

                  let htmlForParse: string;
                  if (htmlSnapshot && htmlSnapshot.trim().length > 0) {
                    // 情况 a：HTML 已就绪，按位置回填
                    htmlForParse = mergeRtfImagesIntoHtml(htmlSnapshot, rtfImages);
                  } else {
                    // 情况 b：HTML 为空（Chromium 大剪贴板首次读），用 text 构造最简 HTML
                    const lines = (textSnapshot || "").split(/\r?\n/);
                    const textHtml = lines
                      .map((l) => {
                        const trimmed = l.trim();
                        if (!trimmed) return "";
                        const safe = trimmed
                          .replace(/&/g, "&amp;")
                          .replace(/</g, "&lt;")
                          .replace(/>/g, "&gt;");
                        return `<p>${safe}</p>`;
                      })
                      .filter(Boolean)
                      .join("");
                    const imgHtml = rtfImages
                      .map((src) => `<p><img src="${src}"/></p>`)
                      .join("");
                    htmlForParse = textHtml + imgHtml;
                  }

                  const { state, dispatch } = view;
                  const parser = ProseMirrorDOMParser.fromSchema(state.schema);
                  const tempDiv = document.createElement("div");
                  const normalized = normalizePastedHtmlForBlocks(htmlForParse);
                  tempDiv.innerHTML = normalized.html;
                  try {
                    const finalImgs = tempDiv.querySelectorAll("img").length;
                    console.log("[paste-diag] rtf-rescue normalized <img>=", finalImgs,
                      " stats=", normalized.imageStats);
                  } catch {}
                  const slice = parser.parseSlice(tempDiv);
                  try {
                    let cnt = 0;
                    slice.content.descendants((n) => {
                      if (n.type.name === "image") cnt += 1;
                    });
                    console.log("[paste-diag] rtf-rescue PM slice image nodes=", cnt);
                  } catch {}
                  dispatch(state.tr.replaceSelection(slice));

                  // 4) 插入已完成 —— 此刻先告诉用户"图片已粘贴"，随后
                  //    进入后台上传阶段。分两条 toast 比挤在一条里流畅。
                  showPasteToast(
                    "success",
                    t("tiptap.rtfRescueDone", { count: rtfImages.length }),
                    1500
                  );

                  // 5) 后台异步：把文档里所有 data:image/* 替换成
                  //    /api/attachments/<id>。避免笔记 JSON 膨胀到几十 MB、
                  //    滚动/搜索/同步全部被拖慢，服务端也更好做去重/清理。
                  //
                  //    没有 noteId 时不做（比如未登录或临时编辑器实例）；
                  //    用户失焦保存时本来也走不了 /api/attachments，只能
                  //    保持 base64——功能不会坏，只是体积大。
                  if (editor && noteAtPaste?.id) {
                    const noteId = noteAtPaste.id;
                    // 稍作延迟让渲染先落地，避免上传 HTTP 请求和大图解码抢资源
                    setTimeout(() => {
                      if (editor.isDestroyed) return;
                      showPasteToast(
                        "converting",
                        t("tiptap.rtfRescueUploading", {
                          done: 0,
                          total: rtfImages.length,
                        })
                      );
                      replaceDataUrlImagesWithAttachments(editor, noteId, {
                        onProgress: (done, total) => {
                          showPasteToast(
                            "converting",
                            t("tiptap.rtfRescueUploading", { done, total })
                          );
                        },
                      })
                        .then(({ total, uploaded, failed }) => {
                          if (editor.isDestroyed) return;
                          if (total === 0) return;
                          if (failed === 0) {
                            showPasteToast(
                              "success",
                              t("tiptap.rtfRescueUploadDone", {
                                uploaded,
                                total,
                              })
                            );
                          } else {
                            showPasteToast(
                              "error",
                              t("tiptap.rtfRescueUploadPartial", {
                                uploaded,
                                total,
                                failed,
                              }),
                              4000
                            );
                          }
                        })
                        .catch((err) => {
                          console.error(
                            "[paste-diag] background upload failed:",
                            err
                          );
                          // 静默失败：base64 兜底图仍然在编辑器里，用户看得见。
                        });
                    }, 200);
                  }
                })
                .catch((err) => {
                  console.error("[paste-diag] rtf-rescue failed:", err);
                  showPasteToast("error", t("tiptap.imageUploadFailed"));
                });

              // 6) 同步返回 true：event.preventDefault 已调，PM 不会再插入
              //    原始剪贴板内容；真正的插入由上面的异步任务完成。
              return true;
            }
          }

          // 3) 多行纯文本（非 Markdown）且看起来像代码：整段包进单一 codeBlock。
          //    注意：必须优先于 HTML 分支，因为 VS Code / 浏览器复制代码时
          //    通常同时带 text/html（每行一个 <div> 或 <pre><br>），
          //    若走 HTML 解析会被拆成多块，导致"每行一个代码块"。
          //    增加 looksLikeCode 判断：含大量中文自然语言的多行文本不应被包成 codeBlock。
          if (text && text.includes("\n") && !looksLikeMarkdown(text) && looksLikeCode(text)) {
            console.log("[paste-diag] PATH=codeBlock (looksLikeCode)");
            // 把纯文本包在 <pre><code> 中，通过 PM 的 DOMParser.parseSlice → replaceSelection
            // 让 PM 自己处理块级节点（codeBlock）的嵌套与光标定位。
            // 之前的做法是手动 codeBlockType.create() + replaceSelectionWith()，
            // 但在光标位于段落内等场景下 PM 无法正确 fit 块级节点到行内位置，
            // 导致文档结构损坏 → 后续 DOM mutation 时 resolveSelection 报
            // "Position -12 out of range"。
            const { state, dispatch } = view;
            const parser = ProseMirrorDOMParser.fromSchema(state.schema);
            const wrapper = document.createElement("div");
            const pre = document.createElement("pre");
            const code = document.createElement("code");
            code.textContent = text;
            pre.appendChild(code);
            wrapper.appendChild(pre);
            const slice = parser.parseSlice(wrapper);
            const tr = state.tr.replaceSelection(slice).scrollIntoView();
            dispatch(tr);
            return true;
          }

          // 4) Markdown 纯文本：不自动转换，先原样插入纯文本并弹 confirm toast，
          //    用户点击"立即转换样式"时再用原始文本替换刚插入的那段范围。
          if (text && looksLikeMarkdown(text)) {
            console.log("[paste-diag] PATH=markdown (insertText + confirm toast)");
            const { state, dispatch } = view;
            // 记录插入起点，用于后续按 from..to 范围替换
            const insertFrom = state.selection.from;
            const tr = state.tr.insertText(text);
            dispatch(tr);
            // 注意：不能用 insertFrom + text.length，因为 ProseMirror 把 \n 转成段落节点，
            // 每个节点边界占 2 个位置，实际偏移远大于字符数。
            // insertText 后光标移到末尾，直接读 view.state.selection.to 即为真实终点。
            const insertTo = view.state.selection.to;

            // 构造转换动作：把 [insertFrom, insertTo] 替换为转换后的 HTML 切片。
            // 注意 view 在此闭包中长期有效（React 卸载时编辑器会 destroy，届时 isDestroyed 为真）。
            const doConvert = () => {
              try {
                if (view.isDestroyed) return;
                const convertedHtml = markdownToSimpleHtml(text);
                const parser = ProseMirrorDOMParser.fromSchema(view.state.schema);
                const tempDiv = document.createElement("div");
                tempDiv.innerHTML = convertedHtml;
                const slice = parser.parseSlice(tempDiv);
                // 替换范围要 clamp 到当前文档长度，防止用户此后又编辑/删除了部分内容
                const docSize = view.state.doc.content.size;
                const from = Math.min(insertFrom, docSize);
                const to = Math.min(insertTo, docSize);
                const replaceTr = view.state.tr.replaceRange(from, to, slice).scrollIntoView();
                view.dispatch(replaceTr);
                showPasteToast("success", t("tiptap.markdownConvertSuccess"));
              } catch (err) {
                console.error("Markdown paste conversion failed:", err);
                showPasteToast("error", t("tiptap.markdownConvertError"));
              }
            };

            showPasteConfirmToast(
              t("tiptap.markdownDetected"),
              t("tiptap.markdownConvertNow"),
              doConvert
            );
            return true;
          }

          // 5) 只有 HTML 没有多行纯文本（如从网页复制的富文本片段）：解析插入
          //    先归一化：把 <div>/<br> 伪多行段落拆成真正的多个 <p>，
          //    避免后续块级操作（toggleHeading 等）误把整段转换。
          if (html && html.trim().length > 0) {
            console.log("[paste-diag] PATH=html (normalize + parseSlice)");
            const { state, dispatch } = view;
            const parser = ProseMirrorDOMParser.fromSchema(state.schema);
            const tempDiv = document.createElement("div");
            // 5a) Word / WPS 粘贴：HTML 里的 <img src> 是 "file:///..." 本地路径，
            //     浏览器无法加载；但 text/rtf 里以 \pngblip / \jpegblip 内联了
            //     真正的图像字节。在归一化之前，先从 RTF 提取 data URL，按顺序
            //     回填到 HTML 的 <img> 占位上，这样后续 rescue / PM DOMParser
            //     能正常当作合法 data:image 插入（已超 200B，不会被判为占位）。
            let htmlForParse = html;
            try {
              const rtf = event.clipboardData?.getData("text/rtf") || "";
              if (rtf.length > 0 && /\\(pngblip|jpegblip)/.test(rtf)) {
                const rtfImages = extractImagesFromRtf(rtf);
                if (rtfImages.length > 0) {
                  htmlForParse = mergeRtfImagesIntoHtml(html, rtfImages);
                  console.log(
                    "[paste-diag] RTF images extracted=",
                    rtfImages.length
                  );
                }
              }
            } catch (err) {
              console.warn("[paste-diag] RTF image extraction failed:", err);
            }
            const normalized = normalizePastedHtmlForBlocks(htmlForParse);
            tempDiv.innerHTML = normalized.html;
            // --- [DIAG] Word 粘贴图片丢失排查 ---
            try {
              const rawImgs = (html.match(/<img[^>]*>/gi) || []).length;
              const normalizedImgs = tempDiv.querySelectorAll("img").length;
              const firstSrc = tempDiv.querySelector("img")?.getAttribute("src") || "";
              console.log("[paste-diag] raw html <img>=", rawImgs,
                " normalized <img>=", normalizedImgs,
                " isWord=", normalized.isWordSource,
                " stats=", normalized.imageStats,
                " firstSrcHead=", firstSrc.slice(0, 80));
            } catch {}
            const slice = parser.parseSlice(tempDiv);
            try {
              let imgCountInSlice = 0;
              slice.content.descendants((n) => {
                if (n.type.name === "image") imgCountInSlice += 1;
              });
              console.log("[paste-diag] PM slice image nodes=", imgCountInSlice);
            } catch {}
            const tr = state.tr.replaceSelection(slice);
            dispatch(tr);
            // 若存在图片还没加载完（没有任何可用 src 的 <img>），提示用户
            //   a) Word 粘贴：<img src="file:///..."> 浏览器不可加载 → 引导用户改用"导入 Word 文档"
            //   b) 懒加载网页：<img> 真实地址没填入 → 提示回原网页滚动加载后再复制
            if (normalized.imageStats.failed > 0) {
              const msgKey = normalized.isWordSource
                ? "tiptap.wordImagesNotPastable"
                : "tiptap.imagesNotLoaded";
              showPasteToast(
                "error",
                t(msgKey, { count: normalized.imageStats.failed }),
                6000
              );
            }
            return true;
          }

          // 6) 单行纯文本或其他：直接插入
          if (text) {
            const { state: st, dispatch: dp } = view;
            const tr = st.tr.insertText(text);
            dp(tr);
          }
          return true;
        } catch (err) {
          console.error("Paste handling error:", err);
          // 出错时尝试插入纯文本，避免页面崩溃
          try {
            const fallbackText = event.clipboardData?.getData("text/plain") || "";
            if (fallbackText) {
              const { state: fst, dispatch: fdp } = view;
              const tr = fst.tr.insertText(fallbackText);
              fdp(tr);
            }
          } catch {}
          return true;
        }
      },
      /**
       * 拖拽文件到编辑器：任意类型都走 /api/attachments 上传。
       *   - 图片 → setImage；
       *   - 非图片 → 插入附件链接。
       * 只在有 dataTransfer.files 时接管；其它情况（从编辑器内拖动节点）让 Tiptap/PM 默认处理。
       *
       * 注意：ProseMirror 会在拖拽过程中把当前光标放到鼠标释放位置，所以这里直接
       * replaceSelection 就会落在期望位置。
       */
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false; // 编辑器内部移动节点，不拦截
        const dt = (event as DragEvent).dataTransfer;
        const files = dt ? Array.from(dt.files || []) : [];
        if (files.length === 0) return false;
        event.preventDefault();

        const currentNote = noteRef.current;
        if (!currentNote?.id) return true;

        // 把落点换算到 PM 坐标，并把光标移过去，这样 replaceSelection 插在拖放位置。
        try {
          const coords = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY });
          if (coords) {
            const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, coords.pos));
            view.dispatch(tr);
          }
        } catch {
          /* ignore */
        }

        const insertAttachmentToView = (filename: string, url: string, size: number) => {
          const html = buildAttachmentLinkHtml(filename, url, size);
          const dom = document.createElement("div");
          dom.innerHTML = html;
          const slice = ProseMirrorDOMParser
            .fromSchema(view.state.schema)
            .parseSlice(dom);
          view.dispatch(view.state.tr.replaceSelection(slice));
        };
        const insertImageToView = (src: string) => {
          const node = view.state.schema.nodes.image?.create({ src });
          if (node) view.dispatch(view.state.tr.replaceSelectionWith(node));
        };

        showPasteToast("converting", t("tiptap.attachmentUploading"));
        (async () => {
          for (const file of files) {
            try {
              const res = await api.attachments.upload(currentNote.id, file);
              if (res.category === "image") {
                insertImageToView(res.url);
              } else {
                insertAttachmentToView(res.filename, res.url, res.size);
              }
            } catch (err) {
              console.error("Drop attachment upload failed:", err);
            }
          }
          showPasteToast("success", t("tiptap.attachmentUploaded"));
        })();
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      // setContent 触发的 onUpdate 不应该保存（防止死循环）
      if (isSettingContent.current) return;

      const text = editor.getText();
      setWordStats(computeStats(text));
      onHeadingsChange?.(extractHeadings(editor));
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        const json = JSON.stringify(editor.getJSON());
        const title = titleRef.current?.value || noteRef.current.title;
        lastEmittedContentRef.current = json;
        onUpdateRef.current({ content: json, contentText: text, title });
      }, 500);
    },
  });

  // 实现 flushSave：Ctrl/Cmd+S 触发，绕过 500ms debounce 立即保存
  flushSaveRef.current = () => {
    if (!editor) return;
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    const json = JSON.stringify(editor.getJSON());
    const text = editor.getText();
    const title = titleRef.current?.value || noteRef.current.title;
    lastEmittedContentRef.current = json;
    onUpdateRef.current({ content: json, contentText: text, title });
    try {
      toast.success(t('tiptap.saved') || 'Saved');
    } catch {}
  };

  /**
   * 对父组件暴露命令式 API：
   *   - flushSave(): 切换编辑器 / 切换笔记时立即把 pending 的 debounce 更新写出去，
   *                 防止丢字。这里**不弹 toast**（避免切换瞬间刷屏），
   *                 与 Ctrl/Cmd+S 的交互保持分离。
   *   - getSnapshot(): 同步读取编辑器当前内容。flushSave 只能触发**异步** PUT，
   *                 切换 RTE→MD 时若只靠 flushSave，MD 一 mount 读到的还是
   *                 切换前的旧 note.content（PUT 没回包），在几百毫秒内会闪烁
   *                 旧内容甚至丢失用户最近的输入。父组件可以调 getSnapshot()
   *                 拿到最新 JSON+纯文本，立即回填 activeNote 后再 setEditorMode，
   *                 MD 侧的 normalizeToMarkdown 就能直接基于最新内容初始化。
   */
  useImperativeHandle(
    ref,
    () => ({
      flushSave: () => {
        if (!editor) return;
        if (!debounceTimer.current) return;
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
        const json = JSON.stringify(editor.getJSON());
        const text = editor.getText();
        const title = titleRef.current?.value || noteRef.current.title;
        lastEmittedContentRef.current = json;
        onUpdateRef.current({ content: json, contentText: text, title });
      },
      discardPending: () => {
        // 切换编辑器时调用方已经自己 PUT 规范化内容，清掉 debounce 避免竞态
        if (debounceTimer.current) {
          clearTimeout(debounceTimer.current);
          debounceTimer.current = null;
        }
      },
      getSnapshot: () => {
        if (!editor) return null;
        return {
          content: JSON.stringify(editor.getJSON()),
          contentText: editor.getText(),
        };
      },
      isReady: () => !!editor && !editor.isDestroyed,
    }),
    [editor],
  );

  // 切换笔记时同步编辑器内容
  const lastSyncedNoteIdRef = useRef<string | null>(null);
  useEffect(() => {
    // 切换笔记时立即清理旧的 debounce timer，防止旧笔记的保存请求泄漏
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    if (titleDebounceTimer.current) {
      clearTimeout(titleDebounceTimer.current);
      titleDebounceTimer.current = null;
    }

    if (editor && note) {
      // 笔记切换时重置 lastEmitted 守卫（新笔记的 content 肯定要真正 setContent）
      if (lastSyncedNoteIdRef.current !== note.id) {
        lastEmittedContentRef.current = null;
        lastSyncedNoteIdRef.current = note.id;
      }

      // 自写自读守卫：如果 note.content 正是自己上次派出去的那份 JSON 字符串，
      // 说明这次 effect 是 EditorPane 保存完成后回填引起的 → 编辑器 DOM 已是
      // 最新，不需要 setContent（否则会打断继续输入 / 产生光标抖动）。
      if (
        lastEmittedContentRef.current !== null &&
        note.content === lastEmittedContentRef.current
      ) {
        // 仍然刷新字数/大纲，保证状态栏和大纲与实际内容同步
        setWordStats(computeStats(editor.getText()));
        onHeadingsChange?.(extractHeadings(editor));
        if (titleRef.current && titleRef.current.value !== note.title) {
          titleRef.current.value = note.title;
        }
        return;
      }

      const parsed = parseContent(note.content);
      const currentJson = JSON.stringify(editor.getJSON());
      const newJson = JSON.stringify(parsed);
      if (currentJson !== newJson) {
        // 标记正在设置内容，阻止 onUpdate 触发保存
        isSettingContent.current = true;
        editor.commands.setContent(parsed);
        // 使用 queueMicrotask 确保在 Tiptap 事务完成后才解锁
        queueMicrotask(() => {
          isSettingContent.current = false;
        });
        // 外部驱动的 setContent 之后，本编辑器当前持有的 content 不再等于
        // 自己之前派出去的值（现在持有的是 parsed 后再重新 serialize 的版本），
        // 把 lastEmitted 清掉，避免后续误判为"自写"。
        lastEmittedContentRef.current = null;
      }
      setWordStats(computeStats(editor.getText()));
      onHeadingsChange?.(extractHeadings(editor));
    }
    if (titleRef.current) {
      titleRef.current.value = note.title;
    }
  }, [note.id, note.content]);
  //   ^^^^^^^^^^^^^^^^^^^^^^
  //   依赖含 content 的完整语义（更新版）：
  //
  //   父组件 EditorPane.handleUpdate 现在会把保存成功的 content 回填到 activeNote，
  //   这样切换编辑器 (MD ↔ RTE) 时双方都能看到最新内容。但为避免 "自己刚派的
  //   JSON 又被 setContent 回来" 打断输入，本 effect 内用 lastEmittedContentRef
  //   做自写自读守卫。命中则 no-op，否则才执行真正的 setContent。
  //
  //   触发时机：
  //   1) 本编辑器打字保存：content 回填 == lastEmitted → 守卫命中 → 不重放。
  //   2) 对侧编辑器保存后切回来：content 不等于 lastEmitted → 正常 setContent。
  //   3) 版本恢复 / 切换笔记 / 外部修改：同上，走正常 setContent。

  // ---------- 标题单独同步 ----------
  //
  // 标题 input 是非受控的（`defaultValue={note.title}`），
  // 上面的主 effect 只在 [note.id, note.content] 变化时才会跑。
  // 当外部只改动 title（典型：点"AI 生成标题"按钮，后端返回新标题 → setActiveNote），
  // content 没变，主 effect 不触发，DOM 里的标题永远保持旧值——用户会以为
  //「AI 生成标题没生效」。这里加一个专用 effect 监听 note.title 即可。
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    if (el.value !== note.title) {
      el.value = note.title;
    }
  }, [note.title]);

  // 组件卸载时清理 debounce timer
  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      if (titleDebounceTimer.current) {
        clearTimeout(titleDebounceTimer.current);
        titleDebounceTimer.current = null;
      }
    };
  }, []);

  // 图片点击预览事件监听
  //
  // 行为分流（解决"点图片立即放大、调不出 ResizableImageView 的尺寸手柄"问题）：
  //   - 只读态（!editable）：保持原行为，单击图片即弹 Lightbox 预览，符合阅读期望。
  //   - 编辑态：
  //       * 单击  → 让 ProseMirror 选中图片节点，ResizableImageView 显示四角手柄。
  //                 这里只需"不打开预览"即可（选中由 ProseMirror 默认行为完成）。
  //       * 双击  → 打开 Lightbox 预览原图，相当于显式"我要看大图"的意图，
  //                 不会和拖动手柄改尺寸的操作互相干扰。
  //
  // 注意：handle 元素位于图片右下角等四角处，使用 pointer-events:auto 但
  //   onMouseDown 会 stopPropagation，所以拖手柄时不会冒泡到这里触发预览。
  useEffect(() => {
    if (!editor) return;

    const isEditorImage = (el: EventTarget | null): el is HTMLImageElement => {
      const node = el as HTMLElement | null;
      return !!node && node.tagName === "IMG" && !!node.closest(".ProseMirror");
    };

    const openPreview = (img: HTMLImageElement) => {
      const src = img.src;
      if (!src) return;
      setPreviewImage(src);
      setImageZoom(1);
      setImageDrag({ x: 0, y: 0 });
    };

    // 单击：仅在只读态下打开预览；编辑态保留给 ProseMirror 做节点选择。
    const handleClick = (e: MouseEvent) => {
      if (!isEditorImage(e.target)) return;
      if (editor.isEditable) return; // 编辑态：让出单击给"选中→出手柄"
      openPreview(e.target as HTMLImageElement);
    };

    // 双击：编辑态下显式"打开大图预览"。只读态此时已经走 click 了，
    // 不必重复处理（双击在只读态会被 click 先消费一次但行为一致）。
    const handleDblClick = (e: MouseEvent) => {
      if (!isEditorImage(e.target)) return;
      if (!editor.isEditable) return;
      e.preventDefault();
      e.stopPropagation();
      openPreview(e.target as HTMLImageElement);
    };

    const editorDom = editor.view.dom;
    editorDom.addEventListener("click", handleClick);
    editorDom.addEventListener("dblclick", handleDblClick);
    return () => {
      editorDom.removeEventListener("click", handleClick);
      editorDom.removeEventListener("dblclick", handleDblClick);
    };
  }, [editor]);

  // 图片预览滚轮缩放
  const handlePreviewWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setImageZoom(prev => {
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      return Math.max(0.1, Math.min(5, prev + delta));
    });
  }, []);

  // 图片预览拖拽
  const handlePreviewMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, imgX: imageDrag.x, imgY: imageDrag.y };
  }, [imageDrag]);

  const handlePreviewMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    setImageDrag({
      x: dragStart.current.imgX + (e.clientX - dragStart.current.x),
      y: dragStart.current.imgY + (e.clientY - dragStart.current.y),
    });
  }, [isDragging]);

  const handlePreviewMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // 动态切换编辑器的可编辑状态
  useEffect(() => {
    if (editor) {
      editor.setEditable(editable);
    }
  }, [editor, editable]);

  // ---------- 链接编辑：弹项目统一 prompt 弹窗，工具栏 & 链接气泡共用 ----------
  // 抽成共享回调避免两处重复 ~40 行 prompt + 解析 + apply 逻辑。
  // 输入框支持 markdown.com.cn 标准 `https://x.com "标题"` 写法，
  // 解析时把空格后的 "..." 部分作为 link mark 的 title 属性。
  // range 参数：hover 触发时传入该 link 在文档里的位置，先切换选区再读取/修改；
  //   caret 触发时不传，使用当前选区原语义不变。
  const openLinkEditor = useCallback(async (range?: { from: number; to: number }) => {
    if (!editor) return;
    if (range && range.from < range.to) {
      editor.chain().focus().setTextSelection(range).run();
    }
    const { from, to, empty } = editor.state.selection;
    const previousAttrs = editor.getAttributes("link") as { href?: string; title?: string | null };
    const previous = previousAttrs?.href ?? "";
    const previousTitle = previousAttrs?.title ?? "";
    const defaultValue = previous
      ? previousTitle
        ? `${previous} "${previousTitle}"`
        : previous
      : "https://";

    const url = await promptDialog({
      title: t("tiptap.link"),
      placeholder: 'https://example.com  或  https://example.com "标题"',
      defaultValue,
      confirmText: t("common.confirm"),
      cancelText: t("common.cancel"),
      allowEmpty: true, // 空字符串 = 移除链接，必须开
    });
    if (url == null) return;

    const trimmed = url.trim();
    if (!trimmed) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }

    const match = trimmed.match(/^(\S+)(?:\s+"([^"]*)")?$/);
    const rawHref = (match?.[1] ?? trimmed).trim();
    const linkTitle = match?.[2] ?? null;

    const safe = /^(https?:|mailto:|tel:|\/|#)/i.test(rawHref)
      ? rawHref
      : `https://${rawHref}`;

    const attrs: { href: string; title?: string | null } = { href: safe };
    if (linkTitle) attrs.title = linkTitle;

    if (empty) {
      // 光标在已有链接里：先扩到整段链接再 setLink，覆盖现有 mark
      // 完全空选区且不在链接上：直接插入 URL 文本并打 mark
      if (editor.isActive("link")) {
        editor.chain().focus().extendMarkRange("link").setLink(attrs).run();
      } else {
        editor
          .chain()
          .focus()
          .insertContent({
            type: "text",
            text: rawHref,
            marks: [{ type: "link", attrs }],
          })
          .run();
      }
    } else {
      editor.chain().focus().setTextSelection({ from, to }).extendMarkRange("link").setLink(attrs).run();
    }
  }, [editor, t]);

  // 取消链接：扩到 link mark 范围后 unsetLink。
  // range 参数：hover 触发时传入该 link 位置，避免“鼠标在链接上但光标不在”时静默失败。
  const removeLink = useCallback((range?: { from: number; to: number }) => {
    if (!editor) return;
    if (range && range.from < range.to) {
      editor.chain().focus().setTextSelection(range).extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
  }, [editor]);

  // 打开链接：在新窗口/新标签页里打开 href
  const openLinkUrl = useCallback((href: string) => {
    if (!href) return;
    window.open(href, "_blank", "noopener,noreferrer");
  }, []);

  // ---------- 手动选区气泡菜单定位 ----------
  // 监听 selectionUpdate / blur，计算浮动菜单坐标（fixed 定位，视口坐标）
  //
  // 触屏避让策略（2026-05-18，按用户反馈"系统复制菜单遮挡选区工具栏"修复）：
  //   Android / iOS 长按文本时系统会自动弹原生 ActionMode（剪切/复制/全选/朗读），
  //   默认显示在**选区上方**。我们的自定义气泡也默认放上方，两者会精确重叠。
  //   - 检测最近一次 pointer 事件 type 是否为 "touch"（350ms 内）；
  //   - 若是，则气泡放在**选区下方**（top = bottom + 8），错开系统菜单；
  //   - 若选区已经接近视口底部（再往下放会被键盘吞掉），fallback 回上方；
  //   - 鼠标 / 桌面端依然按"上方居中"逻辑，不变。
  const lastTouchAtRef = useRef<number>(0);
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (e.pointerType === "touch") lastTouchAtRef.current = Date.now();
    };
    window.addEventListener("pointerdown", onPointer, { passive: true });
    window.addEventListener("pointerup", onPointer, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("pointerup", onPointer);
    };
  }, []);

  useEffect(() => {
    if (!editor) return;

    /**
     * 根据选区矩形计算气泡位置：
     *   - desktop / 鼠标：上方居中（top = rect.top - 44）
     *   - 触屏：下方居中（top = rect.bottom + 8），错开系统 ActionMode
     *   - 触屏 & 选区贴近视口底部：fallback 上方
     */
    const placeBubble = (rect: { top: number; bottom: number; left: number; right: number; width: number }, bubbleHeight = 40, bubbleWidth = 220) => {
      const isTouch = Date.now() - lastTouchAtRef.current < 800; // 触屏后 800ms 内都算触屏触发
      const cx = rect.left + rect.width / 2;
      let top: number;
      if (isTouch) {
        const below = rect.bottom + 8;
        const overflowsBottom = below + bubbleHeight > window.innerHeight - 16;
        // 距离底部太近就 fallback 到上方（再上偏 4px，给系统菜单一些视觉缓冲）
        top = overflowsBottom ? Math.max(8, rect.top - bubbleHeight - 8) : below;
      } else {
        top = Math.max(8, rect.top - bubbleHeight - 4);
      }
      const left = Math.max(8, Math.min(cx - bubbleWidth / 2, window.innerWidth - bubbleWidth - 10));
      return { top, left };
    };

    const updateBubble = () => {
      const { state, view } = editor;
      const { selection } = state;
      const { from, to, empty } = selection;

      // 编辑器失焦 → 关闭所有气泡
      if (!view.hasFocus()) {
        setBubble(b => b.open ? { ...b, open: false } : b);
        setImageBubble(b => b.open ? { ...b, open: false } : b);
        setLinkBubble(b => b.open ? { ...b, open: false } : b);
        setTableBubble(b => b.open ? { ...b, open: false } : b);
        return;
      }

      // 空选区 → 文本/图片格式化气泡都关，但若光标停在链接里，显示链接气泡
      if (empty) {
        setBubble(b => b.open ? { ...b, open: false } : b);
        setImageBubble(b => b.open ? { ...b, open: false } : b);

        // 光标在表格里 → 显示表格操作气泡（独立于 link 气泡，因为表格里基本不会有 link）
        if (editor.isActive("table")) {
          // 用当前光标位置所在 <td>/<th> 的 DOM 作为锚定矩形
          let cellEl: HTMLElement | null = null;
          try {
            const dom = view.domAtPos(from).node as Node | null;
            const el = dom instanceof Element ? dom : dom?.parentElement ?? null;
            cellEl = el?.closest?.("td, th") as HTMLElement | null;
          } catch { /* ignore */ }
          if (cellEl) {
            const cellRect = cellEl.getBoundingClientRect();
            // 表格气泡较宽，估 360；放上方，放不下时降到下方（placeBubble 已处理）
            const { top } = placeBubble(cellRect, 40, 360);
            const cx = cellRect.left + cellRect.width / 2;
            const left = Math.max(8, Math.min(cx - 180, window.innerWidth - 370));
            setTableBubble({ open: true, top, left });
          } else {
            setTableBubble(b => b.open ? { ...b, open: false } : b);
          }
        } else {
          setTableBubble(b => b.open ? { ...b, open: false } : b);
        }

        if (editor.isActive("link")) {
          // 取整段 link mark 的范围用于定位（光标位置矩形是零宽，定位会偏）
          const $pos = state.doc.resolve(from);
          const linkType = state.schema.marks.link;
          // resolvedPos.marks() 给当前位置的所有 mark；找 link 后用 mark.attrs.href
          const linkMark = $pos.marks().find((m: any) => m.type === linkType);
          const href = (linkMark?.attrs as { href?: string } | undefined)?.href ?? "";
          // ProseMirror 没有 getMarkRange 在 Node 上，但 Tiptap 在选区方法里有；
          // 这里用 textBetween 反查 + 从当前位置向左右扩展找 mark 边界，避免引入新依赖
          let start = from;
          let end = from;
          // 向左扩
          while (start > 0) {
            const prevPos = state.doc.resolve(start - 1);
            if (prevPos.marks().some((m: any) => m.type === linkType && m.eq(linkMark!))) {
              start -= 1;
            } else break;
          }
          // 向右扩
          while (end < state.doc.content.size) {
            const nextPos = state.doc.resolve(end);
            if (nextPos.marks().some((m: any) => m.type === linkType && m.eq(linkMark!))) {
              end += 1;
            } else break;
          }

          // 链接气泡用整段 link rect + 光标 x（避免长链接换行时居中偏到行中点）
          const linkRect = posToDOMRect(view, start, end);
          const caretRect = posToDOMRect(view, from, from);
          const { top } = placeBubble(linkRect, 40, 280);
          const cx = caretRect.left; // 光标 x（零宽矩形，left===right）
          // 气泡宽度约 280px，居中减半，并夹到视口内
          const left = Math.max(8, Math.min(cx - 140, window.innerWidth - 290));
          // 附件链接需要 filename：从 DOM 上的 <a download="..."> 属性取——
          // ProseMirror 在 link mark attrs 里不存 download，但渲染出的 DOM
          // 节点上保留了。用 view.domAtPos 拿到包裹文本的 anchor 元素。
          let filename = "";
          try {
            const dom = view.domAtPos(from).node as Node | null;
            const el = dom instanceof Element ? dom : dom?.parentElement ?? null;
            const anchor = el?.closest?.("a") as HTMLAnchorElement | null;
            filename = anchor?.getAttribute("download") ?? "";
          } catch { /* 取不到就空，下载时降级用 URL 末尾段 */ }
          setLinkBubble({ open: true, top, left, href, filename, source: "caret", from: start, to: end });
        } else {
          // 仅关闭 caret 触发的气泡，hover 触发的留给 mouse 事件去关
          setLinkBubble(b => (b.open && b.source === "caret") ? { ...b, open: false } : b);
        }
        return;
      }

      // 有选区 → 关闭 caret 链接气泡（hover 的不动），走原有文本/图片气泡逻辑
      setLinkBubble(b => (b.open && b.source === "caret") ? { ...b, open: false } : b);
      // Keep table bubble open when cells are selected
      if (editor.isActive("table")) {
        const rect = posToDOMRect(view, from, to);
        const { top } = placeBubble(rect, 40, 360);
        const cx = rect.left + rect.width / 2;
        const left = Math.max(8, Math.min(cx - 180, window.innerWidth - 370));
        setTableBubble({ open: true, top, left });
      } else {
        setTableBubble(b => b.open ? { ...b, open: false } : b);
      }

      const isImage = editor.isActive("image");

      if (isImage) {
        // 图片选区 → 显示图片尺寸气泡
        setBubble(b => b.open ? { ...b, open: false } : b);
        const rect = posToDOMRect(view, from, to);
        const { top, left } = placeBubble(rect, 40, 280);
        setImageBubble({ open: true, top, left });
      } else {
        // 文本选区 → 显示格式化气泡
        setImageBubble(b => b.open ? { ...b, open: false } : b);
        // 若文本长度为 0（全是不可见字符）也跳过
        const text = state.doc.textBetween(from, to, " ");
        if (!text.trim().length) {
          setBubble(b => b.open ? { ...b, open: false } : b);
          return;
        }
        const rect = posToDOMRect(view, from, to);
        const { top, left } = placeBubble(rect, 40, 220);
        setBubble({ open: true, top, left });
      }
    };

    const onBlur = () => {
      // 延迟一帧关闭，避免点击气泡菜单按钮时因 blur 而菜单消失
      requestAnimationFrame(() => {
        if (!editor.view.hasFocus()) {
        // 如果焦点移到了弹窗内（如字号/颜色选择器），不关闭气泡菜单
          const ae = document.activeElement;
          if (ae && ae !== document.body && (ae as Element).closest?.('[data-popover]')) return;
          setBubble(b => b.open ? { ...b, open: false } : b);
          setImageBubble(b => b.open ? { ...b, open: false } : b);
          // 只关 caret 触发的链接气泡；hover 气泡不依赖编辑器 focus
          setLinkBubble(b => (b.open && b.source === "caret") ? { ...b, open: false } : b);
          setTableBubble(b => b.open ? { ...b, open: false } : b);
        }
      });
    };

    editor.on("selectionUpdate", updateBubble);
    editor.on("blur", onBlur);

    // ---- hover 触发链接气泡 ----
    // ProseMirror 的编辑器 DOM 不适合用 React 合成事件（需要给 contentEditable
    // 外部跳过事件体系），直接原生 addEventListener。用事件委派，在父 dom 上听
    // mouseover/mouseout，用 closest('a[href]') 过滤。
    const editorDom = editor.view.dom as HTMLElement;
    const ATTACHMENT_RE = /^\/api\/attachments\/[0-9a-fA-F-]{36}/;

    const showBubbleForAnchor = (anchor: HTMLAnchorElement) => {
      const href = anchor.getAttribute("href") || "";
      if (!href) return;
      // 附件链接优先用 download 属性；拿不到就从链接文本“📎 名字 (大小)”里抠
      let filename = anchor.getAttribute("download") || "";
      if (!filename && ATTACHMENT_RE.test(href)) {
        const txt = anchor.textContent || "";
        const m = txt.match(/📎\s*(.+?)\s*\([^)]*\)\s*$/);
        filename = m ? m[1] : txt.replace(/^📎\s*/, "");
      }
      const rect = anchor.getBoundingClientRect();
      const { top } = placeBubble(rect, 40, 280);
      // 与 caret 路径一致：气泡约 280宽，以链接横中为准，夹到视口内
      const cx = rect.left + rect.width / 2;
      const left = Math.max(8, Math.min(cx - 140, window.innerWidth - 290));
      // 从 anchor DOM 反查 ProseMirror 位置，再沿 link mark 向两侧扩到边界。
      // 拿不到位置就记 0/0，点击动作时会降级走原选区逻辑。
      let from = 0, to = 0;
      try {
        const view = editor.view;
        const pos = view.posAtDOM(anchor, 0);
        if (pos >= 0) {
          const linkType = view.state.schema.marks.link;
          let s = pos, e = pos;
          while (s > 0) {
            const $p = view.state.doc.resolve(s - 1);
            if ($p.marks().some((m: any) => m.type === linkType && m.attrs.href === href)) s -= 1;
            else break;
          }
          while (e < view.state.doc.content.size) {
            const $p = view.state.doc.resolve(e);
            if ($p.marks().some((m: any) => m.type === linkType && m.attrs.href === href)) e += 1;
            else break;
          }
          from = s; to = e;
        }
      } catch { /* 位置定不住就保持 0/0 */ }
      setLinkBubble({ open: true, top, left, href, filename, source: "hover", from, to });
    };

    const onMouseOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || !editorDom.contains(anchor)) return;
      // hover 中取消待关闭
      if (linkHoverCloseTimer.current) {
        clearTimeout(linkHoverCloseTimer.current);
        linkHoverCloseTimer.current = null;
      }
      showBubbleForAnchor(anchor);
    };

    const onMouseOut = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      // relatedTarget 仍在同一个 anchor 里（跨子节点移动）不算离开
      const next = e.relatedTarget as Node | null;
      if (next && anchor.contains(next)) return;
      // 延迟关闭，给鼠标从链接过渡到气泡留缓冲期
      if (linkHoverCloseTimer.current) clearTimeout(linkHoverCloseTimer.current);
      linkHoverCloseTimer.current = setTimeout(() => {
        setLinkBubble(b => (b.open && b.source === "hover") ? { ...b, open: false } : b);
      }, 150);
    };

    editorDom.addEventListener("mouseover", onMouseOver);
    editorDom.addEventListener("mouseout", onMouseOut);

    return () => {
      editor.off("selectionUpdate", updateBubble);
      editor.off("blur", onBlur);
      editorDom.removeEventListener("mouseover", onMouseOver);
      editorDom.removeEventListener("mouseout", onMouseOut);
      if (linkHoverCloseTimer.current) {
        clearTimeout(linkHoverCloseTimer.current);
        linkHoverCloseTimer.current = null;
      }
    };
  }, [editor]);

  // Provide scrollTo callback to parent
  useEffect(() => {
    if (!editor) return;
    const scrollTo = (pos: number) => {
      editor.commands.focus();
      editor.commands.setTextSelection(pos);
      // Scroll the heading node into view
      const dom = editor.view.domAtPos(pos + 1);
      if (dom?.node) {
        const el = dom.node instanceof HTMLElement ? dom.node : dom.node.parentElement;
        el?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    };
    onEditorReady?.(scrollTo);
  }, [editor, onEditorReady]);

  /**
   * 桌面端格式菜单桥（macOS 原生菜单 / 快捷键 → Tiptap）
   * ----------------------------------------------------------------
   * 监听 window "nowen:format" 自定义事件，由 `useDesktopMenuBridge`（App.tsx）
   * 在收到 Electron 主进程 "menu:format" IPC 时派发。payload 形如：
   *   { mark: "bold" | "italic" | "underline" | "strike" | "code" }
   *   { node: "heading", level: 1..6 }
   *   { node: "paragraph" }
   *
   * 为什么直接监听 window 事件（而不是通过 ref 暴露 runFormat）：
   *   - editor 是 TiptapEditor 闭包内变量，穿 ref 会污染 NoteEditorHandle 合约；
   *   - EditorPane 同一时刻只会渲染一个 TiptapEditor（MD/HTML 模式时不挂载），
   *     不存在多实例竞态；即使在 RTE 模式下也只有一个 subscription；
   *   - 当编辑器未挂载（切到 MD 模式），格式菜单本就应该无响应——
   *     没有 subscriber 自然 no-op，语义正确。
   *
   * 只在 editable 且 editor 已就绪时生效；editor 未就绪 / 只读模式下忽略，避免
   * `chain()` 在被销毁的 view 上报错。
   */
  useEffect(() => {
    if (!editor || !editable) return;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<FormatMenuPayload>).detail;
      if (!detail || editor.isDestroyed) return;

      const chain = editor.chain().focus();
      if (detail.mark) {
        switch (detail.mark) {
          case "bold":      chain.toggleBold().run();      break;
          case "italic":    chain.toggleItalic().run();    break;
          case "underline": chain.toggleUnderline().run(); break;
          case "strike":    chain.toggleStrike().run();    break;
          case "code":      chain.toggleCode().run();      break;
        }
        return;
      }
      if (detail.node === "heading" && detail.level) {
        const lvl = detail.level as 1 | 2 | 3 | 4 | 5 | 6;
        // 用 smart 版本：若当前段落含 <br>（hardBreak），先拆成独立段落再 toggle
        toggleHeadingSmart(editor, lvl);
        return;
      }
      if (detail.node === "paragraph") {
        chain.setParagraph().run();
      }
    };
    window.addEventListener("nowen:format", handler as EventListener);
    return () => window.removeEventListener("nowen:format", handler as EventListener);
  }, [editor, editable]);

  /**
   * 原生菜单 checked 同步（Electron / macOS）
   * ----------------------------------------------------------------
   * HIG：菜单项应反映当前上下文状态——当前选区已加粗，则"格式 → 加粗"旁显示 ✓。
   *
   * 实现思路：
   *   - 订阅 Tiptap 的 `selectionUpdate`/`transaction` 事件，采集布尔快照；
   *   - 节流 100ms：人眼 10fps 足够感知菜单勾选切换，更高频只是白白烧 IPC；
   *   - 浅比较去重：大多数键盘输入不改变格式状态，去重后 IPC 调用量降至 ~0。
   *   - 编辑器卸载 / 失焦时发 null，让主进程清空所有 checked（避免"残影"）。
   *
   * 仅在 Electron 环境下有效；Web / 移动端 window.nowenDesktop 不存在，直接短路。
   *
   * Markdown 模式下 TiptapEditor 根本没挂载，自然不会上报——符合语义：
   * 菜单 checked 反映的始终是"当前正在编辑的那个上下文"。MD 未来若需要可以
   * 复用同一通道，这里不展开。
   */
  useEffect(() => {
    if (!editor) return;

    let lastKey = "";
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      timer = null;
      if (editor.isDestroyed) return;
      const state = {
        bold: editor.isActive("bold"),
        italic: editor.isActive("italic"),
        underline: editor.isActive("underline"),
        strike: editor.isActive("strike"),
        code: editor.isActive("code"),
        heading1: editor.isActive("heading", { level: 1 }),
        heading2: editor.isActive("heading", { level: 2 }),
        heading3: editor.isActive("heading", { level: 3 }),
        paragraph: editor.isActive("paragraph"),
      };
      // 浅去重：把布尔值串成 9-bit 字符串，相等则不发 IPC
      const key = Object.values(state).map((v) => (v ? "1" : "0")).join("");
      if (key === lastKey) return;
      lastKey = key;
      sendFormatState(state);
    };

    const schedule = () => {
      if (timer) return; // 100ms 窗口内合并多个事件
      timer = setTimeout(flush, 100);
    };

    const onBlur = () => {
      // blur 立即清空：用户切到别处时菜单不应保留旧勾选
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      lastKey = "";
      sendFormatState(null);
    };

    editor.on("selectionUpdate", schedule);
    editor.on("transaction", schedule);
    editor.on("focus", schedule);
    editor.on("blur", onBlur);

    // 挂载时推一次初始状态
    schedule();

    return () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      editor.off("selectionUpdate", schedule);
      editor.off("transaction", schedule);
      editor.off("focus", schedule);
      editor.off("blur", onBlur);
      // 卸载清空，避免切到 MD 模式后菜单仍显示 Tiptap 的旧状态
      sendFormatState(null);
    };
  }, [editor]);

  const handleTitleChange = useCallback(() => {
    // P0-1: 使用独立的 titleDebounceTimer，不再复用 debounceTimer，
    // 避免清掉内容的 pending debounce，且只发 title 字段，绝不带 content。
    // 这样无论标题保存何时返回，都不会触碰 lastEmittedContentRef，
    // 后续主 effect 的自写守卫继续按"上次派出去的内容"判定，不会误重建编辑器。
    if (titleDebounceTimer.current) clearTimeout(titleDebounceTimer.current);
    titleDebounceTimer.current = setTimeout(() => {
      titleDebounceTimer.current = null;
      const title = titleRef.current?.value || "";
      onUpdateRef.current({ title });
    }, 500);
  }, []);

  const handleImageUpload = useCallback(() => {
    if (!editor) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const currentNote = noteRef.current;
      const insertAtSrc = (src: string) => {
        editor.chain().focus().setImage({ src }).run();
      };
      if (currentNote?.id) {
        // 走 /api/attachments：写磁盘 + 记录 attachments 表，编辑器只引用 URL
        toast.info(t("tiptap.imageUploading") || "Uploading image...");
        api.attachments
          .upload(currentNote.id, file)
          .then(({ url }) => {
            insertAtSrc(url);
            toast.success(t("tiptap.imageUploadSuccess") || "Image uploaded");
          })
          .catch((err) => {
            console.error("Attachment upload failed, falling back to base64:", err);
            toast.error(t("tiptap.imageUploadFailed") || "Image upload failed");
            // 兜底：失败时退回 base64，保证用户仍可插图
            const reader = new FileReader();
            reader.onload = (e) => {
              const src = e.target?.result as string;
              if (src) insertAtSrc(src);
            };
            reader.readAsDataURL(file);
          });
      } else {
        const reader = new FileReader();
        reader.onload = (e) => {
          const src = e.target?.result as string;
          if (src) insertAtSrc(src);
        };
        reader.readAsDataURL(file);
      }
    };
    input.click();
  }, [editor, t]);

  /**
   * 任意格式附件上传 → 在编辑器当前位置插入：
   *   - 图片（image/*）：当作 <img> 插入，与 handleImageUpload 一致路径
   *   - 其它：插入一段「附件链接」HTML：
   *       <a href="/api/attachments/<id>" download="<原文件名>"
   *          data-attachment="1" data-size="<bytes>">📎 文件名 (大小)</a>
   *     - data-attachment / data-size 用于将来识别 / 二次渲染（如换图标）；
   *     - download 属性 + 后端 Content-Disposition 双保险触发下载；
   *     - 链接由 StarterKit 默认 Link mark 承载（v3 starter-kit 默认含 link），
   *       即便没有 link mark 也能作为普通 <a> 文本节点存活下来。
   *
   * 与 handleImageUpload 解耦的好处：
   *   - 工具栏可以同时存在「插入图片」（仅图片文件 picker）和「插入附件」（任意），
   *     两个入口语义清晰；
   *   - 粘贴 / 拖拽路径只调本函数即可（已自动按 mime 分流）。
   */
  const handleAttachmentUpload = useCallback(() => {
    if (!editor) return;
    const input = document.createElement("input");
    input.type = "file";
    // 不设 accept：放开任意格式
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      uploadAndInsertAttachment(file);
    };
    input.click();

    function uploadAndInsertAttachment(file: File) {
      const currentNote = noteRef.current;
      if (!currentNote?.id) {
        toast.error(t("tiptap.attachmentUploadFailed") || "Attachment upload failed");
        return;
      }
      toast.info(t("tiptap.attachmentUploading") || "Uploading attachment...");
      api.attachments
        .upload(currentNote.id, file)
        .then((res) => {
          if (res.category === "image") {
            // 图片：与 handleImageUpload 一致，走 setImage
            editor!.chain().focus().setImage({ src: res.url }).run();
          } else {
            const html = buildAttachmentLinkHtml(res.filename, res.url, res.size);
            editor!.chain().focus().insertContent(html).run();
          }
          toast.success(t("tiptap.attachmentUploaded") || "Attachment uploaded");
        })
        .catch((err: any) => {
          console.error("Attachment upload failed:", err);
          const msg = String(err?.message || "");
          if (/最大|max\s+\d+\s*MB/i.test(msg)) {
            toast.error(t("tiptap.attachmentTooLarge") || "File too large");
          } else {
            toast.error(t("tiptap.attachmentUploadFailed") || "Attachment upload failed");
          }
        });
    }
  }, [editor, t]);

  /**
   * 严格作用于当前选区的代码块切换：
   *   - 光标在代码块内：取消代码块（转为段落），与默认 toggleCodeBlock 一致
   *   - 无选区：将光标所在的整个块切换为代码块（与默认行为一致）
   *   - 有选区：把选区覆盖的所有顶层块合并为一个 codeBlock
   *            （以顶层块为粒度，不做"半块切出"处理，避免跨多块替换产生多个代码块）
   */
  const toggleCodeBlockStrict = useCallback(() => {
    if (!editor) return;
    const { state } = editor;
    const { selection, schema, doc } = state;
    const codeBlockType = schema.nodes.codeBlock;
    if (!codeBlockType) return;

    // 光标已在代码块内：取消代码块
    if (editor.isActive("codeBlock")) {
      editor.chain().focus().toggleCodeBlock().run();
      return;
    }

    // 无选区：退回默认行为（转当前块为代码块）
    if (selection.empty) {
      editor.chain().focus().toggleCodeBlock().run();
      return;
    }

    const { from, to } = selection;
    const $from = doc.resolve(from);

    // 仅支持顶层（doc 直接子块）范围的整体包裹；
    // 嵌套结构（列表 / 表格 / 引用块等）内部的选区交给默认命令，避免破坏结构
    if ($from.depth !== 1) {
      editor.chain().focus().toggleCodeBlock().run();
      return;
    }
    // 为避免 $to.before(1) 在 to 正好位于两块边界时指到"下一个块"，
    // 用 (to - 1) 解析末块位置；当 from === to 已被上面 selection.empty 排除，所以 to-1 >= from。
    const $toInside = doc.resolve(Math.max(from, to - 1));
    if ($toInside.depth !== 1) {
      editor.chain().focus().toggleCodeBlock().run();
      return;
    }

    // 选区覆盖的顶层块范围（左闭右开）：从首块起点到末块终点
    const blockStart = $from.before(1);
    const blockEnd = $toInside.after(1);

    // 收集范围内所有顶层块的文本，按换行拼接
    const lines: string[] = [];
    doc.nodesBetween(blockStart, blockEnd, (node: any, _pos: number, _parent: any, _index: number) => {
      // 只处理 doc 的直接子节点
      if (_parent === doc) {
        if (node.type.name === "codeBlock" || node.isTextblock) {
          lines.push(node.textContent);
        } else {
          // 非文本块（如 horizontalRule、image 等）：用空行占位，避免完全丢失
          lines.push("");
        }
        return false; // 不再深入该块内部
      }
      return true;
    });

    const codeText = lines.join("\n");
    const codeNode = codeText
      ? codeBlockType.create({}, schema.text(codeText))
      : codeBlockType.create();

    editor
      .chain()
      .focus()
      .command(( { tr, dispatch }: { tr: any; dispatch: any }) => {
        if (!dispatch) return true;
        // 先删除覆盖范围，再在原位置插入单一 codeBlock
        tr.delete(blockStart, blockEnd);
        tr.insert(blockStart, codeNode);
        // 光标定位到新代码块末尾
        const caretPos = blockStart + codeNode.nodeSize - 1;
        const safePos = Math.min(caretPos, tr.doc.content.size);
        tr.setSelection(TextSelection.near(tr.doc.resolve(safePos), -1));
        return true;
      })
      .run();
  }, [editor]);

  const openAIAssistant = useCallback(() => {
    if (!editor) return;
    const { from, to } = editor.state.selection;

    // ⚠️ 关键修复：不要用 doc.textBetween(from, to) ——它只提取 text 节点的
    // 纯文本，会把 link mark、image 节点、bold/italic 等格式全部丢弃。
    // 用户选中带链接 / 图片的内容让 AI "Markdown 格式化"时，AI 收到的是
    // 已经丢失链接 URL 和图片 URL 的纯文本，再怎么排版也补不回来 → 替换
    // 写回后链接/图片消失（issue：AI 写作助手 markdown 格式化丢链接图片）。
    //
    // 正确做法：用 doc.cut(from, to) 把选区切成一个合法的子文档 Node
    // （PM 会自动补齐开放的 block 节点），再走 tiptap JSON → HTML →
    // Markdown 链路。这条链路在 MarkdownEditor 那边天然没问题（因为它
    // 本身就是 Markdown 源码字符串），现在 Tiptap 侧也对齐到 Markdown。
    // 这样 AI 拿到的就是 `[text](url)` / `![alt](url)` 形式，能完整保留。
    let selectedMd = "";
    if (from < to) {
      try {
        const sliceDoc = editor.state.doc.cut(from, to);
        selectedMd = tiptapJsonToMarkdown(sliceDoc.toJSON()).trim();
      } catch (err) {
        console.warn("[TiptapEditor] selection → markdown failed, fallback to textBetween:", err);
      }
    }
    // 兜底：若 Markdown 序列化失败或选区为空，退回纯文本（至少不崩）
    if (!selectedMd) {
      selectedMd = editor.state.doc.textBetween(from, to, " ");
    }
    setAiSelectedText(selectedMd || editor.getText().slice(0, 500));

    // 获取选区在屏幕上的位置
    const coords = editor.view.coordsAtPos(from);
    const editorRect = editor.view.dom.getBoundingClientRect();
    setAiPosition({
      top: Math.min(coords.top + 28, window.innerHeight - 500),
      left: Math.min(coords.left, window.innerWidth - 420),
    });
    setShowAI(true);
  }, [editor]);

  /**
   * 把一段可能是 Markdown 的文本注入到编辑器的 [from, to] 范围。
   * - 若检测到 Markdown 语法：直接转换为富文本 HTML 后插入，并弹 success toast 告知用户。
   * - 否则：作为纯文本插入。
   *
   * 注意：不走"先插纯文本再替换"的路径，因为 ProseMirror insertText 后
   * 文档位置偏移（\n → 段落节点，每个节点边界占 2 个位置）与 text.length 不一致，
   * 会导致 replaceRange 范围计算错误、内容大量丢失。
   */
  const insertWithMarkdownDetect = useCallback((text: string, from: number, to: number) => {
    if (!editor) return;
    const view = editor.view;

    if (looksLikeMarkdown(text)) {
      // 直接转换为富文本 HTML 后插入，一步到位
      try {
        const convertedHtml = markdownToSimpleHtml(text);
        const parser = ProseMirrorDOMParser.fromSchema(view.state.schema);
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = convertedHtml;
        const slice = parser.parseSlice(tempDiv);
        const docSize = view.state.doc.content.size;
        const safeFrom = Math.min(from, docSize);
        const safeTo = Math.min(to, docSize);
        const tr = view.state.tr.replaceRange(safeFrom, safeTo, slice).scrollIntoView();
        view.dispatch(tr);
        editor.chain().focus().run();
        showPasteToast("success", t("tiptap.markdownConvertSuccess"));
      } catch (err) {
        console.error("AI Markdown conversion failed:", err);
        // 降级：纯文本插入
        const tr = view.state.tr.insertText(text, from, to);
        view.dispatch(tr);
        editor.chain().focus().run();
      }
    } else {
      // 非 Markdown：纯文本插入
      const tr = view.state.tr.insertText(text, from, to);
      view.dispatch(tr);
      editor.chain().focus().run();
    }
  }, [editor, showPasteToast, t]);

  const handleAIInsert = useCallback((text: string) => {
    if (!editor) return;
    const { to } = editor.state.selection;
    insertWithMarkdownDetect(text, to, to);
  }, [editor, insertWithMarkdownDetect]);

  const handleAIReplace = useCallback((text: string) => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    insertWithMarkdownDetect(text, from, to);
  }, [editor, insertWithMarkdownDetect]);

  // 回到顶部 + sticky 工具栏阴影：合用一个滚动监听器避免重复订阅
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [showBackToTop, setShowBackToTop] = useState(false);
  // 内容不在顶端（>4px）时给 sticky 工具栏加底部阴影，
  // 让其视觉上「浮」于内容之上——跟 Notion / Bear / Craft 等主流移动端编辑器一致。
  const [toolbarShadow, setToolbarShadow] = useState(false);
  // 查找替换面板开关；Ctrl/Cmd+F 切换。
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const onScroll = () => {
      const top = el.scrollTop;
      setShowBackToTop(top > 240);
      setToolbarShadow(top > 4);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [editor]);
  const scrollToTop = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  // 全局 Ctrl/Cmd+F 快捷键打开查找面板，避免与浏览器原生查找冲突
  // 仅当焦点在编辑器容器内时才拦截，最大限度尊重用户在标题输入框等其他地方的习惯。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        const root = scrollContainerRef.current?.parentElement;
        const active = document.activeElement;
        const inEditor = root && active instanceof Node && root.contains(active);
        // 编辑器内 / 已打开搜索面板 时才接管，避免影响全局浏览器查找
        if (inEditor || searchOpen) {
          e.preventDefault();
          setSearchOpen(true);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen]);

  // 移动端 header 顶部的搜索按钮通过派发自定义事件触发查找面板。
  // 用 CustomEvent 而不是把 setSearchOpen 提到外部，是为了避免改 TiptapEditor 的对外接口。
  useEffect(() => {
    const onOpen = () => setSearchOpen(true);
    window.addEventListener("nowen:open-search", onOpen);
    return () => window.removeEventListener("nowen:open-search", onOpen);
  }, []);

  if (!editor) return null;

  const iconSize = 15;

  return (
    <div className="flex flex-col h-full relative">
      {/* Toolbar
          v2026-05-18：取消「键盘弹起时隐藏 + 浮动工具栏顶替」方案，改为始终保留
          单一顶部工具栏并 sticky 在容器顶端：
            - 键盘弹起时不再隐藏，避免移动端找不到格式按钮；
            - sticky top-0 让长内容滚动时也能随时点到工具栏；
            - z 索引压在选区/链接气泡之下（z-50），保留气泡的覆盖能力。 */}
      <div
        className={cn(
          "sticky top-0 z-20 flex items-center gap-0.5 px-4 py-2 border-b border-app-border bg-app-surface/95 backdrop-blur supports-[backdrop-filter]:bg-app-surface/70 md:flex-wrap overflow-x-auto hide-scrollbar touch-pan-x transition-shadow duration-200",
          // 滚动离顶后加底部阴影，表达「工具栏浮于内容之上」
          toolbarShadow && "shadow-[0_2px_8px_-2px_rgba(0,0,0,0.08)] dark:shadow-[0_2px_8px_-2px_rgba(0,0,0,0.4)]",
        )}
      >
        <ToolbarButton onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} title={t('tiptap.undo')}>
          <Undo size={iconSize} />
        </ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} title={t('tiptap.redo')}>
          <Redo size={iconSize} />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton
          onClick={() => toggleHeadingSmart(editor, 1)}
          isActive={editor.isActive("heading", { level: 1 })}
          title={t('tiptap.heading1')}
        >
          <Heading1 size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => toggleHeadingSmart(editor, 2)}
          isActive={editor.isActive("heading", { level: 2 })}
          title={t('tiptap.heading2')}
        >
          <Heading2 size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => toggleHeadingSmart(editor, 3)}
          isActive={editor.isActive("heading", { level: 3 })}
          title={t('tiptap.heading3')}
        >
          <Heading3 size={iconSize} />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBold().run()}
          isActive={editor.isActive("bold")}
          title={t('tiptap.bold')}
        >
          <Bold size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleItalic().run()}
          isActive={editor.isActive("italic")}
          title={t('tiptap.italic')}
        >
          <Italic size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          isActive={editor.isActive("underline")}
          title={t('tiptap.underline')}
        >
          <UnderlineIcon size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleStrike().run()}
          isActive={editor.isActive("strike")}
          title={t('tiptap.strikethrough')}
        >
          <Strikethrough size={iconSize} />
        </ToolbarButton>
        {/* 字号 / 颜色：基于 TextStyle + Color + FontSize 三件套，
            实际渲染为 <span style="font-size:..;color:..">；
            背景色复用 Highlight multicolor，由 ColorPopover 的「背景」Tab 暴露。
            原先单独的 Highlighter 切换按钮被 ColorPopover 覆盖，移除以避免重复。 */}
        <FontSizePopover editor={editor} iconSize={iconSize} />
        <ColorPopover editor={editor} iconSize={iconSize} />
        <ToolbarButton
          onClick={openLinkEditor}
          isActive={editor.isActive("link")}
          title={t('tiptap.link')}
        >
          <LinkIcon size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleCode().run()}
          isActive={editor.isActive("code")}
          title={t('tiptap.inlineCode')}
        >
          <Code size={iconSize} />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          isActive={editor.isActive("bulletList")}
          title={t('tiptap.bulletList')}
        >
          <List size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          isActive={editor.isActive("orderedList")}
          title={t('tiptap.orderedList')}
        >
          <ListOrdered size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleTaskList().run()}
          isActive={editor.isActive("taskList")}
          title={t('tiptap.taskList')}
        >
          <CheckSquare size={iconSize} />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          isActive={editor.isActive("blockquote")}
          title={t('tiptap.blockquote')}
        >
          <Quote size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={toggleCodeBlockStrict}
          isActive={editor.isActive("codeBlock")}
          title={t('tiptap.codeBlock')}
        >
          <FileCode size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
          title={t('tiptap.horizontalRule')}
        >
          <Minus size={iconSize} />
        </ToolbarButton>
        <ToolbarButton onClick={handleImageUpload} title={t('tiptap.insertImage')}>
          <ImagePlus size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={async () => {
            // 弹窗输入视频 URL；setVideo 会做 URL 解析，失败给 toast 提示。
            // 支持：直链 mp4/webm/ogg + B 站 / YouTube / 腾讯视频 / Vimeo。
            const url = await promptDialog({
              title: t('tiptap.insertVideo') || '插入视频',
              placeholder: 'https://www.bilibili.com/video/BV...  或 .mp4 直链',
              defaultValue: '',
              confirmText: t('common.confirm'),
              cancelText: t('common.cancel'),
              allowEmpty: false,
            });
            if (!url) return;
            const ok = (editor.commands as any).setVideo(url.trim());
            if (!ok) {
              toast.error(t('tiptap.videoUrlInvalid') || '无法识别该视频链接');
            }
          }}
          title={t('tiptap.insertVideo') || '插入视频'}
        >
          <Film size={iconSize} />
        </ToolbarButton>
        <ToolbarButton onClick={handleAttachmentUpload} title={t('tiptap.insertAttachment')}>
          <Paperclip size={iconSize} />
        </ToolbarButton>
        <TableGridPicker
          iconSize={iconSize}
          onPick={(rows, cols) =>
            editor
              .chain()
              .focus()
              .insertTable({ rows, cols, withHeaderRow: true })
              .run()
          }
        />
        {/* Mermaid 图表：插入空的 mermaid 代码块（lang=mermaid 由 CodeBlockView 渲染图形） */}
        <ToolbarButton
          onClick={() => {
            editor
              .chain()
              .focus()
              .insertContent({
                type: "codeBlock",
                attrs: { language: "mermaid" },
                content: [{ type: "text", text: "graph TD\n  A[开始] --> B[结束]" }],
              })
              .run();
          }}
          title={t('tiptap.insertMermaid')}
        >
          <Workflow size={iconSize} />
        </ToolbarButton>
        {/* LaTeX 数学公式：块级 mathBlock，空 latex 让 NodeView 自动进入编辑态 */}
        <ToolbarButton
          onClick={() => {
            editor
              .chain()
              .focus()
              .insertContent({
                type: "mathBlock",
                attrs: { latex: "" },
              })
              .run();
          }}
          title={t('tiptap.insertMath')}
        >
          <Sigma size={iconSize} />
        </ToolbarButton>
        {/* 脚注：光标处插 ref + 文档末尾追加配对 def，identifier 自动取下一个未占用数字 */}
        <ToolbarButton
          onClick={() => {
            const id = nextFootnoteIdentifier(editor);
            editor
              .chain()
              .focus()
              .insertContent({
                type: "footnoteReference",
                attrs: { identifier: id },
              })
              .run();
            const docEnd = editor.state.doc.content.size;
            editor
              .chain()
              .focus()
              .insertContentAt(docEnd, {
                type: "footnoteDefinition",
                attrs: { identifier: id, content: "" },
              })
              .run();
          }}
          title={t('tiptap.insertFootnote')}
        >
          <BookOpen size={iconSize} />
        </ToolbarButton>

        {/* 表格操作按钮（仅在光标在表格内时显示） */}
        {editor.isActive('table') && (
          <>
            <ToolbarDivider />
            <ToolbarButton
              onClick={() => editor.chain().focus().addRowAfter().run()}
              title={t('tiptap.addRowAfter')}
            >
              <span className="text-[10px] font-bold leading-none">+行</span>
            </ToolbarButton>
            <ToolbarButton
              onClick={() => editor.chain().focus().deleteRow().run()}
              title={t('tiptap.deleteRow')}
            >
              <span className="text-[10px] font-bold leading-none text-red-500">-行</span>
            </ToolbarButton>
            <ToolbarButton
              onClick={() => editor.chain().focus().addColumnAfter().run()}
              title={t('tiptap.addColumnAfter')}
            >
              <span className="text-[10px] font-bold leading-none">+列</span>
            </ToolbarButton>
            <ToolbarButton
              onClick={() => editor.chain().focus().deleteColumn().run()}
              title={t('tiptap.deleteColumn')}
            >
              <span className="text-[10px] font-bold leading-none text-red-500">-列</span>
            </ToolbarButton>
            <ToolbarButton
              onClick={() => editor.chain().focus().deleteTable().run()}
              title={t('tiptap.deleteTable')}
            >
              <Trash2 size={iconSize - 2} className="text-red-500" />
            </ToolbarButton>
          </>
        )}

        <ToolbarDivider />

        {/* 缩进控制 —— 逻辑与 Tab/Shift-Tab 键盘快捷键完全一致 */}
        <ToolbarButton
          onClick={() => {
            if (editor.isActive("taskList")) {
              if (editor.chain().focus().sinkListItem("taskItem").run()) return;
            } else if (editor.isActive("bulletList") || editor.isActive("orderedList")) {
              if (editor.chain().focus().sinkListItem("listItem").run()) return;
            }
            (editor.chain().focus() as any).changeIndent(1).run();
          }}
          title={t('tiptap.indent')}
        >
          <Indent size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => {
            if (editor.isActive("taskList")) {
              if (editor.chain().focus().liftListItem("taskItem").run()) return;
            } else if (editor.isActive("bulletList") || editor.isActive("orderedList")) {
              if (editor.chain().focus().liftListItem("listItem").run()) return;
            }
            (editor.chain().focus() as any).changeIndent(-1).run();
          }}
          title={t('tiptap.outdent')}
        >
          <Outdent size={iconSize} />
        </ToolbarButton>

        <ToolbarDivider />

        {/* 段落对齐 */}
        <ToolbarButton
          onClick={() => editor.chain().focus().setTextAlign('left').run()}
          isActive={editor.isActive({ textAlign: 'left' })}
          title={t('tiptap.alignLeft')}
        >
          <AlignLeft size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().setTextAlign('center').run()}
          isActive={editor.isActive({ textAlign: 'center' })}
          title={t('tiptap.alignCenter')}
        >
          <AlignCenter size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().setTextAlign('right').run()}
          isActive={editor.isActive({ textAlign: 'right' })}
          title={t('tiptap.alignRight')}
        >
          <AlignRight size={iconSize} />
        </ToolbarButton>

        {!isGuest && <ToolbarDivider />}

        {/* 查找替换：Ctrl/Cmd+F 也可唤起；访客只读下面板会隐藏替换输入框
            移动端 EditorPane header 已提供独立搜索按钮，这里隐藏避免重复（仅桌面端 md+ 显示） */}
        <span className="hidden md:inline-flex">
          <ToolbarButton
            onClick={() => setSearchOpen((v) => !v)}
            isActive={searchOpen}
            title={t('searchReplace.toolbarTitle') || '查找替换 (Ctrl+F)'}
          >
            <Search size={iconSize} />
          </ToolbarButton>
        </span>

        {!isGuest && (
          <ToolbarButton onClick={openAIAssistant} title={t('tiptap.aiAssistant')}>
            <Sparkles size={iconSize} className="text-violet-500" />
          </ToolbarButton>
        )}
      </div>

      {/* 查找替换浮窗：依附最外层 relative，右上角应于序列。
          - editable=false 的只读场景仍可查找，只是隐藏替换输入框 */}
      {editor && (
        <SearchReplacePanel
          editor={editor}
          open={searchOpen}
          onClose={() => setSearchOpen(false)}
          editable={editable}
        />
      )}

      {/* Title */}
      <div className="px-4 md:px-8 pt-4 md:pt-6 pb-0">
        <input
          ref={titleRef}
          defaultValue={note.title}
          onChange={handleTitleChange}
          placeholder={t('tiptap.titlePlaceholder')}
          readOnly={!editable}
          className={cn(
            "w-full bg-transparent text-2xl font-bold text-tx-primary placeholder:text-tx-tertiary focus:outline-none",
            !editable && "cursor-default"
          )}
        />
        <div className="flex items-center flex-wrap gap-x-3 gap-y-0.5 mt-2 text-[10px] text-tx-tertiary">
          <span>{t('tiptap.version')}{note.version}</span>
          <span className="max-md:hidden">·</span>
          <span>{t('tiptap.updatedAt')}{new Date(note.updatedAt + "Z").toLocaleString()}</span>
          <span className="max-md:hidden">·</span>
          <span>{wordStats.words}{t('tiptap.words')}</span>
          <span className="max-md:hidden">·</span>
          <span>{wordStats.charsNoSpace}{t('tiptap.chars')}</span>
        </div>
      </div>

      {/* Tag Bar：访客模式下隐藏（TagInput 依赖 AppProvider + 登录态 API） */}
      {!isGuest && (
        <div className="px-4 md:px-8 pb-2">
          <TagInput
            noteId={note.id}
            noteTags={note.tags || []}
            onTagsChange={onTagsChange}
          />
        </div>
      )}

      {/* 选区气泡菜单：文本格式化（手动实现，fixed 定位，避免被 overflow-auto 裁剪） */}
      {editor && editable && bubble.open && (
        <div
          className="fixed z-50 flex items-center gap-0.5 bg-app-elevated border border-app-border rounded-lg shadow-lg p-1"
          style={{ top: bubble.top, left: bubble.left }}
          onMouseDown={(e) => e.preventDefault()} // 阻止点击按钮时 editor blur
        >
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleBold().run()}
            isActive={editor.isActive("bold")}
            title={t('tiptap.bold')}
          >
            <Bold size={14} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleItalic().run()}
            isActive={editor.isActive("italic")}
            title={t('tiptap.italic')}
          >
            <Italic size={14} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleUnderline().run()}
            isActive={editor.isActive("underline")}
            title={t('tiptap.underline')}
          >
            <UnderlineIcon size={14} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleStrike().run()}
            isActive={editor.isActive("strike")}
            title={t('tiptap.strikethrough')}
          >
            <Strikethrough size={14} />
          </ToolbarButton>
          {/* 字号 + 颜色 / 背景色：选区气泡同步暴露，移动端常用 */}
          <FontSizePopover editor={editor} iconSize={14} compact />
          <ColorPopover editor={editor} iconSize={14} compact />
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleCode().run()}
            isActive={editor.isActive("code")}
            title={t('tiptap.inlineCode')}
          >
            <Code size={14} />
          </ToolbarButton>
          {/* 链接：选区有内容时一键转链接（或编辑已有链接），省得跑顶部工具栏 */}
          <ToolbarButton
            onClick={openLinkEditor}
            isActive={editor.isActive("link")}
            title={t('tiptap.link')}
          >
            <LinkIcon size={14} />
          </ToolbarButton>
          <ToolbarButton
            onClick={toggleCodeBlockStrict}
            isActive={editor.isActive("codeBlock")}
            title={t('tiptap.codeBlock')}
          >
            <FileCode size={14} />
          </ToolbarButton>
          {/* 清除全部 inline 文本格式（Mod-Shift-X 同等效果） */}
          <ToolbarButton
            onClick={() =>
              editor
                .chain()
                .focus()
                .unsetMark("textStyle")
                .unsetMark("highlight")
                .unsetMark("bold")
                .unsetMark("italic")
                .unsetMark("underline")
                .unsetMark("strike")
                .unsetMark("code")
                .run()
            }
            title={t('tiptap.clearFormat') || "清除格式 (Ctrl+Shift+X)"}
          >
            <Eraser size={14} />
          </ToolbarButton>
          {!isGuest && (
            <>
              <div className="w-px h-4 bg-app-border mx-0.5" />
              <ToolbarButton onClick={openAIAssistant} title={t('tiptap.aiAssistant')}>
                <Sparkles size={14} className="text-violet-500" />
              </ToolbarButton>
            </>
          )}
        </div>
      )}

      {/* 链接气泡菜单：光标停在链接内（无选区）或鼠标 hover 链接时浮出 — 打开 / 编辑 / 取消链接 */}
      {/* 抽屉打开期间不渲染链接气泡：双保险，防 hover/caret 在抽屉打开后又把它弹回来。 */}
      {editor && editable && linkBubble.open && !attachmentPreview && (
        <div
          className="fixed z-50 flex items-center gap-1 bg-app-elevated border border-app-border rounded-lg shadow-lg px-2 py-1 max-w-[320px]"
          style={{ top: linkBubble.top, left: linkBubble.left }}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => {
            // 鼠标进入气泡本体时，取消 hover 关闭定时器，保证点击按钮可达
            if (linkHoverCloseTimer.current) {
              clearTimeout(linkHoverCloseTimer.current);
              linkHoverCloseTimer.current = null;
            }
          }}
          onMouseLeave={() => {
            // 仅对 hover 触发的气泡生效；caret 触发的气泡跟随光标/blur 关闭
            if (linkBubble.source !== "hover") return;
            if (linkHoverCloseTimer.current) clearTimeout(linkHoverCloseTimer.current);
            linkHoverCloseTimer.current = setTimeout(() => {
              setLinkBubble(b => (b.open && b.source === "hover") ? { ...b, open: false } : b);
            }, 150);
          }}
        >
          {/* href 预览：超长时截断，给足上下文 + tooltip 完整 */}
          <a
            href={linkBubble.href}
            target="_blank"
            rel="noopener noreferrer"
            title={linkBubble.href}
            className="text-xs text-app-muted hover:text-app-accent truncate max-w-[160px] underline-offset-2 hover:underline"
          >
            {linkBubble.href}
          </a>
          <div className="w-px h-4 bg-app-border mx-0.5" />
          {/* 附件链接（href 形如 /api/attachments/<id>）展示「下载」按钮——
             点击链接文本本身已在 handleDOMEvents.click 里走内联预览抽屉，
             所以气泡里只补强"下载到本地"这个明确动作。普通 http(s) 链接
             保留"打开链接"在新标签页打开。 */}
          {/^\/api\/attachments\//.test(linkBubble.href) ? (
            <ToolbarButton
              onClick={() => {
                void downloadAttachment(linkBubble.href, linkBubble.filename || "");
              }}
              title={t('tiptap.linkDownload')}
            >
              <Download size={14} />
            </ToolbarButton>
          ) : (
            <ToolbarButton
              onClick={() => openLinkUrl(linkBubble.href)}
              title={t('tiptap.linkOpen')}
            >
              <ExternalLink size={14} />
            </ToolbarButton>
          )}
          <ToolbarButton
            onClick={() => {
              // hover 触发时光标可能不在链接上，必须传入 from/to 让两个 callback
              // 内部先 setTextSelection 再 extendMarkRange，否则 unsetLink 会静默失败。
              // caret 触发时 from===to===0 不传，沿用当前选区语义。
              const range = linkBubble.source === "hover" && linkBubble.from < linkBubble.to
                ? { from: linkBubble.from, to: linkBubble.to } : undefined;
              void openLinkEditor(range);
            }}
            title={t('tiptap.linkEdit')}
          >
            <LinkIcon size={14} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => {
              const range = linkBubble.source === "hover" && linkBubble.from < linkBubble.to
                ? { from: linkBubble.from, to: linkBubble.to } : undefined;
              removeLink(range);
            }}
            title={t('tiptap.linkRemove')}
          >
            <Unlink2 size={14} />
          </ToolbarButton>
        </div>
      )}

      {/* 选区气泡菜单：图片快捷尺寸 */}
      {editor && editable && imageBubble.open && (
        <div
          className="fixed z-50 flex items-center gap-0.5 bg-app-elevated border border-app-border rounded-lg shadow-lg p-1"
          style={{ top: imageBubble.top, left: imageBubble.left }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {[
            { key: "25", label: t("tiptap.imageSize25"), ratio: 0.25 },
            { key: "50", label: t("tiptap.imageSize50"), ratio: 0.5 },
            { key: "75", label: t("tiptap.imageSize75"), ratio: 0.75 },
            { key: "100", label: t("tiptap.imageSize100"), ratio: 1 },
          ].map((s) => (
            <ToolbarButton
              key={s.key}
              title={s.label}
              onClick={() => {
                const root = editor.view.dom as HTMLElement;
                const contentWidth = root.clientWidth || 640;
                const target = Math.round(contentWidth * s.ratio);
                editor
                  .chain()
                  .focus()
                  .updateAttributes("image", { width: target })
                  .run();
              }}
            >
              <span className="text-xs px-1">{s.label}</span>
            </ToolbarButton>
          ))}
          <div className="w-px h-4 bg-app-border mx-0.5" />
          <ToolbarButton
            title={t("tiptap.imageSizeOriginalTitle")}
            onClick={() => {
              editor
                .chain()
                .focus()
                .updateAttributes("image", { width: null, height: null })
                .run();
            }}
          >
            <span className="text-xs px-1">{t("tiptap.imageSizeOriginal")}</span>
          </ToolbarButton>
        </div>
      )}

      {/* 选区气泡菜单：表格操作（行/列/合并/拆分/表头/删除）
          光标停在表格内（空选区）时浮出，按钮直接调 Tiptap 内置命令。
          合并/拆分依赖 CellSelection——用户必须先按住鼠标拖选多个单元格再点合并。 */}
      {editor && editable && tableBubble.open && (
        <div
          className="fixed z-50 flex items-center gap-px bg-app-elevated border border-app-border rounded-lg shadow-lg p-0.5"
          style={{ top: tableBubble.top, left: tableBubble.left }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <ToolbarButton compact
            title={t("tiptap.addRowBefore")}
            onClick={() => editor.chain().focus().addRowBefore().run()}
          >
            <Rows3 size={14} className="rotate-180" />
          </ToolbarButton>
          <ToolbarButton compact
            title={t("tiptap.addRowAfter")}
            onClick={() => editor.chain().focus().addRowAfter().run()}
          >
            <Rows3 size={14} />
          </ToolbarButton>
          <ToolbarButton compact
            title={t("tiptap.deleteRow")}
            onClick={() => editor.chain().focus().deleteRow().run()}
          >
            <span className="flex items-center">
              <Rows3 size={14} />
              <Trash2 size={10} className="-ml-0.5" />
            </span>
          </ToolbarButton>
          <div className="w-px h-3 bg-app-border mx-0.5" />
          <ToolbarButton compact
            title={t("tiptap.addColumnBefore")}
            onClick={() => editor.chain().focus().addColumnBefore().run()}
          >
            <Columns3 size={14} className="-scale-x-100" />
          </ToolbarButton>
          <ToolbarButton compact
            title={t("tiptap.addColumnAfter")}
            onClick={() => editor.chain().focus().addColumnAfter().run()}
          >
            <Columns3 size={14} />
          </ToolbarButton>
          <ToolbarButton compact
            title={t("tiptap.deleteColumn")}
            onClick={() => editor.chain().focus().deleteColumn().run()}
          >
            <span className="flex items-center">
              <Columns3 size={14} />
              <Trash2 size={10} className="-ml-0.5" />
            </span>
          </ToolbarButton>
          <div className="w-px h-3 bg-app-border mx-0.5" />
          <ToolbarButton compact
            title={t("tiptap.mergeCells")}
            disabled={!editor.can().mergeCells()}
            onClick={() => editor.chain().focus().mergeCells().run()}
          >
            <Merge size={14} />
          </ToolbarButton>
          <ToolbarButton compact
            title={t("tiptap.splitCell")}
            disabled={!editor.can().splitCell()}
            onClick={() => editor.chain().focus().splitCell().run()}
          >
            <Split size={14} />
          </ToolbarButton>
          <ToolbarButton compact
            title={t("tiptap.toggleHeaderRow")}
            onClick={() => editor.chain().focus().toggleHeaderRow().run()}
          >
            <Heading size={14} />
          </ToolbarButton>
          <ToolbarButton compact
            title={t("tiptap.resizeTable")}
            onClick={() => {
              // 读出当前表格的真实行列数：从光标所在 <table> DOM 数 tr / 第一行 td
              const view = editor.view;
              const { from } = view.state.selection;
              let tableEl: HTMLTableElement | null = null;
              try {
                const dom = view.domAtPos(from).node as Node | null;
                const el = dom instanceof Element ? dom : dom?.parentElement ?? null;
                tableEl = el?.closest?.("table") as HTMLTableElement | null;
              } catch { /* ignore */ }
              const rows = tableEl?.querySelectorAll("tr").length ?? 3;
              const cols = tableEl?.querySelector("tr")?.children.length ?? 3;
              setResizeDialog({ open: true, rows, cols });
              setTableBubble(b => ({ ...b, open: false }));
            }}
          >
            <span className="text-[10px] px-0.5 tabular-nums">⊞</span>
          </ToolbarButton>
          <div className="w-px h-3 bg-app-border mx-0.5" />
          <ToolbarButton compact
            title={t("tiptap.deleteTable")}
            onClick={() => editor.chain().focus().deleteTable().run()}
          >
            <Trash2 size={14} className="text-red-500" />
          </ToolbarButton>
        </div>
      )}

      {/* 调整表格尺寸对话框 */}
      <TableResizeDialog
        open={resizeDialog.open}
        initialRows={resizeDialog.rows}
        initialCols={resizeDialog.cols}
        onCancel={() => setResizeDialog(d => ({ ...d, open: false }))}
        onConfirm={(targetRows, targetCols) => {
          // 按当前表格的行列数差值，批量加/删行列
          // 注意：必须保证光标在表格内（关闭气泡时焦点已落在 cell 上，没问题）
          const chain = editor.chain().focus();
          const dRow = targetRows - resizeDialog.rows;
          const dCol = targetCols - resizeDialog.cols;
          for (let i = 0; i < Math.abs(dRow); i++) {
            if (dRow > 0) chain.addRowAfter();
            else chain.deleteRow();
          }
          for (let i = 0; i < Math.abs(dCol); i++) {
            if (dCol > 0) chain.addColumnAfter();
            else chain.deleteColumn();
          }
          chain.run();
          setResizeDialog(d => ({ ...d, open: false }));
        }}
      />

      {/* Editor content
          paddingBottom 仅吃键盘高度即可（避光标被键盘遮）。
          v2026-05-18 起移除底部移动浮动工具栏，由顶部 sticky 主工具栏统一承担
          所有格式化命令。 */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-auto px-4 md:px-8 pb-12"
        style={{ paddingBottom: "calc(3rem + var(--keyboard-height, 0px))" }}
      >
        <EditorContent editor={editor} />
        {tiptapMention && (
          <MentionPicker
            search={tiptapMention.query}
            anchorRect={tiptapMention.rect}
            onSelect={(user) => {
              tiptapMention.command({ id: user.username, label: user.displayName || user.username });
              setTiptapMention(null);
            }}
            onClose={() => setTiptapMention(null)}
          />
        )}
      </div>

      {/* 附件内嵌预览：复用 AttachmentDetailDrawer
          - 触发：点正文里的 📎 附件链接（任意类型，data-attachment="1"）
          - 类型分流：
              .docx → 通过 renderPreview 走 DocxAttachmentPreview（保留"上传新版本"能力）
              其他  → 组件内置 AttachmentPreview（图片 / 视频 / 音频 / 文本 / 代码 / SVG）
          - 与文件管理中心同款抽屉：含外链分享 / 重命名 / 元信息 / 反向引用 / 下载。
          - 不开启 showDelete：编辑器场景里附件可能就是当前笔记自己引用的，删了会破图。 */}
      {attachmentPreview && (
        <AttachmentDetailDrawer
          attachmentId={attachmentPreview.id}
          onClose={() => setAttachmentPreview(null)}
          renderPreview={
            attachmentPreview.isDocx
              ? (detail, expanded) => (
                  <Suspense fallback={<div className="p-6 text-xs text-tx-tertiary">加载预览组件…</div>}>
                    <DocxAttachmentPreview
                      url={detail.url}
                      filename={detail.filename}
                      heightClass={expanded ? "min-h-[80vh]" : "min-h-[600px]"}
                      onReplace={async (file) => {
                        // 上传新 .docx 覆盖旧附件 + 更新笔记 content 指向新 url。
                        const oldId = detail.id;
                        const noteId = noteRef.current?.id || "";
                        if (!noteId) {
                          toast.error("无法识别当前笔记，刷新后重试");
                          return;
                        }
                        try {
                          const { replaceWordAttachment } = await import("@/lib/wordNoteService");
                          const res = await replaceWordAttachment({ noteId, oldAttachmentId: oldId, file });
                          toast.success("已上传新版本");
                          // 关掉预览：旧 id 已失效，再渲染会报错。
                          setAttachmentPreview(null);
                          // 触发笔记内容刷新：让外层 EditorPane 拉一次最新 note。
                          try {
                            window.dispatchEvent(new CustomEvent("nowen:note-updated", { detail: { noteId: res.note.id } }));
                          } catch { /* ignore */ }
                        } catch (err: any) {
                          console.error("Replace docx failed:", err);
                          toast.error(err?.message || "上传新版本失败");
                        }
                      }}
                    />
                  </Suspense>
                )
              : undefined
          }
        />
      )}

      {/* 回到顶部按钮：滚动超过阈值后显示在编辑区右下角 */}
      <AnimatePresence>
        {showBackToTop && (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 8, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.9 }}
            transition={{ duration: 0.15 }}
            onClick={scrollToTop}
            title={t("tiptap.backToTop", "回到顶部")}
            aria-label={t("tiptap.backToTop", "回到顶部")}
            className="absolute right-4 md:right-6 z-30 w-9 h-9 flex items-center justify-center rounded-full bg-app-elevated border border-app-border text-tx-secondary hover:text-accent-primary hover:border-accent-primary/50 shadow-lg backdrop-blur-sm transition-colors"
            style={{ bottom: "calc(1rem + var(--keyboard-height, 0px))" }}
          >
            <ArrowUp size={16} />
          </motion.button>
        )}
      </AnimatePresence>

      {/* Markdown 粘贴转换提示 Toast */}
      <AnimatePresence>
        {pasteToast && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className={cn(
              "fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2.5 px-4 py-2.5 rounded-xl shadow-lg border text-sm font-medium backdrop-blur-sm",
              pasteToast.type === "converting" && "bg-accent-primary/10 border-accent-primary/20 text-accent-primary",
              pasteToast.type === "success" && "bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400",
              pasteToast.type === "error" && "bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400",
              pasteToast.type === "confirm" && "bg-sky-500/10 border-sky-500/20 text-sky-600 dark:text-sky-400"
            )}
          >
            {pasteToast.type === "converting" && (
              <FileType size={16} className="animate-pulse" />
            )}
            {pasteToast.type === "success" && <Check size={16} />}
            {pasteToast.type === "error" && <AlertCircle size={16} />}
            {pasteToast.type === "confirm" && <Info size={16} />}
            <span>{pasteToast.message}</span>
            {pasteToast.type === "confirm" && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    const action = pasteToast.onAction;
                    dismissPasteToast();
                    action();
                  }}
                  className="ml-1 font-semibold underline-offset-2 hover:underline focus:outline-none"
                >
                  {pasteToast.actionLabel}
                </button>
                <button
                  type="button"
                  onClick={dismissPasteToast}
                  aria-label="close"
                  className="ml-1 p-0.5 rounded hover:bg-sky-500/10 focus:outline-none"
                >
                  <X size={14} />
                </button>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 斜杠命令菜单 */}
      <SlashCommandsMenu
        editor={editor}
        items={getDefaultSlashCommands(t, handleImageUpload, openAIAssistant)}
      />

      {/* 图片预览 Lightbox */}
      <AnimatePresence>
        {previewImage && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) { setPreviewImage(null); } }}
            onWheel={handlePreviewWheel}
            onMouseMove={handlePreviewMouseMove}
            onMouseUp={handlePreviewMouseUp}
            onMouseLeave={handlePreviewMouseUp}
          >
            {/* 工具栏 */}
            <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
              <button
                onClick={() => setImageZoom(prev => Math.min(5, prev + 0.25))}
                className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
                title="放大"
              >
                <ZoomIn size={18} />
              </button>
              <button
                onClick={() => setImageZoom(prev => Math.max(0.1, prev - 0.25))}
                className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
                title="缩小"
              >
                <ZoomOut size={18} />
              </button>
              <button
                onClick={() => { setImageZoom(1); setImageDrag({ x: 0, y: 0 }); }}
                className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
                title="重置"
              >
                <RotateCcw size={18} />
              </button>
              <span className="text-white/70 text-xs font-mono min-w-[3rem] text-center">
                {Math.round(imageZoom * 100)}%
              </span>
              <button
                onClick={() => setPreviewImage(null)}
                className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
                title="关闭"
              >
                <X size={18} />
              </button>
            </div>
            {/* 图片
                注意：缩放/平移交给 framer-motion 的独立 transform 通道（scale/x/y）来驱动，
                不能再写 style.transform 字符串——motion 会接管 transform 并覆盖外部 style，
                导致 100% 的数字一直在变但 DOM 上 transform 永远停在入场动画终态。
                入场仅用 opacity 做淡入，初始 scale 用当前 imageZoom 防止抖动。 */}
            <motion.img
              src={previewImage}
              alt="preview"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, scale: imageZoom, x: imageDrag.x, y: imageDrag.y }}
              exit={{ opacity: 0 }}
              transition={{ duration: isDragging ? 0 : 0.15 }}
              className="max-w-[90vw] max-h-[90vh] object-contain select-none"
              style={{
                cursor: isDragging ? 'grabbing' : 'grab',
              }}
              onMouseDown={handlePreviewMouseDown}
              draggable={false}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* AI Writing Assistant */}
      <AnimatePresence>
        {showAI && (
          <AIWritingAssistant
            selectedText={aiSelectedText}
            // fullText 作为上下文传给 AI（截前 2000 字），同样用 Markdown
            // 序列化而非 editor.getText()，保留链接 / 图片 URL，让 AI 在
            // 续写、改写等任务里也能感知到这些资源。失败时回退到纯文本。
            fullText={(() => {
              if (!editor) return "";
              try {
                const md = tiptapJsonToMarkdown(editor.getJSON());
                if (md) return md;
              } catch (err) {
                console.warn("[TiptapEditor] fullText → markdown failed:", err);
              }
              return editor.getText();
            })()}
            onInsert={handleAIInsert}
            onReplace={handleAIReplace}
            onClose={() => setShowAI(false)}
            position={aiPosition}
          />
        )}
      </AnimatePresence>

      {/* 移动端底部工具栏：固定在最下方，仅手机端可见 */}
      <div className="md:hidden sticky bottom-0 z-20 flex items-center justify-center gap-1 px-2 py-1.5 border-t border-app-border bg-app-surface/95 backdrop-blur supports-[backdrop-filter]:bg-app-surface/70 overflow-x-auto hide-scrollbar">
        <ToolbarButton onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} title="撤销">
          <Undo size={14} />
        </ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} title="重做">
          <Redo size={14} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => toggleHeadingSmart(editor, 2)}
          isActive={editor.isActive("heading", { level: 2 })}
          title="标题"
          compact
        >
          <Heading2 size={14} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBold().run()}
          isActive={editor.isActive("bold")}
          title="加粗"
          compact
        >
          <Bold size={14} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleItalic().run()}
          isActive={editor.isActive("italic")}
          title="斜体"
          compact
        >
          <Italic size={14} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          isActive={editor.isActive("underline")}
          title="下划线"
          compact
        >
          <UnderlineIcon size={14} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          isActive={editor.isActive("bulletList")}
          title="无序列表"
          compact
        >
          <List size={14} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          isActive={editor.isActive("orderedList")}
          title="有序列表"
          compact
        >
          <ListOrdered size={14} />
        </ToolbarButton>
      </div>
    </div>
  );
});

/**
 * 把附件信息渲染成一段「可粘附进 Tiptap 内容」的 HTML 链接。
 *
 * 形态：
 *   <a href="/api/attachments/<id>" download="<filename>"
 *      data-attachment="1" data-size="<bytes>"
 *      target="_blank" rel="noopener noreferrer">📎 filename (大小)</a>
 *
 * 设计点：
 *   - 用相对 URL：与图片一致，避免把 lite 模式下的远端 host 写进 notes.content；
 *     渲染端 / 分享页可以由 resolveAttachmentUrl 自动补 origin。
 *   - download 属性 + 后端 Content-Disposition 双保险，浏览器点击触发下载。
 *   - data-attachment="1" 给将来"换成自定义节点视图"留个抓手（识别一段链接是否
 *     源自附件上传），不影响导出/分享/SSR。
 *   - filename 通过 escapeHtml 双重转义；data-size 是纯数字。
 */
function buildAttachmentLinkHtml(filename: string, url: string, size: number): string {
  const safeName = escapeHtml(filename || "attachment");
  const safeUrl = escapeHtml(url);
  const sizeLabel = formatBytes(size);
  // 加 \u00a0(NBSP) + 一个普通空格，避免后续 typing 紧贴链接末尾导致光标卡在 mark 边界
  return `<a href="${safeUrl}" download="${safeName}" data-attachment="1" data-size="${size}" target="_blank" rel="noopener noreferrer">📎 ${safeName} (${sizeLabel})</a>&nbsp;`;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(gb < 10 ? 2 : 1)} GB`;
}

/**
 * 检测粘贴的多行纯文本是否看起来像代码/命令，而非中文自然语言段落。
 *
 * 策略：计算"中文字符密度"——如果文本中中文字符占比较高，说明是自然语言文本，
 * 不应自动包成 codeBlock。同时检测一些代码特征（缩进、大括号、分号结尾等）。
 *
 * 用例对比：
 *   - 代码：`const x = 1;\nif (x) {\n  return;\n}`       → true（无中文，有代码特征）
 *   - 运维文档：`#查看raid信息\nyum install megacli -y\n通过命令...` → false（中文占比高）
 *   - shell 命令：`ls -la\ncd /tmp\nmkdir test`           → true（无中文，命令格式）
 */
function looksLikeCode(text: string): boolean {
  // 统计中文字符数量（CJK统一汉字 + 扩展）
  const cjkChars = text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g);
  const cjkCount = cjkChars ? cjkChars.length : 0;
  // 统计非空白可见字符总数
  const visibleChars = text.replace(/\s/g, "").length;
  if (visibleChars === 0) return false;

  const cjkRatio = cjkCount / visibleChars;

  // 如果中文字符占比 > 20%，大概率是自然语言文本而非代码
  if (cjkRatio > 0.2) return false;

  // 如果中文字符占比 > 8% 且没有明显的代码特征，也不当做代码
  if (cjkRatio > 0.08) {
    const lines = text.split("\n");
    let codeSignals = 0;
    for (const line of lines) {
      const trimmed = line.trimEnd();
      // 缩进（至少2空格或tab开头）
      if (/^(\s{2,}|\t)/.test(line) && trimmed.length > 0) codeSignals++;
      // 行尾分号、大括号
      if (/[;{}]\s*$/.test(trimmed)) codeSignals++;
      // 赋值语句
      if (/[=!<>]=|=>|->/.test(trimmed)) codeSignals++;
      // 函数调用 xxx(...)
      if (/\w+\(.*\)\s*[;{]?\s*$/.test(trimmed)) codeSignals++;
    }
    // 如果代码特征不够多，不当做代码
    if (codeSignals < lines.length * 0.3) return false;
  }

  return true;
}

/**
 * 检测粘贴的文本是否包含 Markdown 格式标记
 * 通过匹配多种 Markdown 语法特征来判断
 */
function looksLikeMarkdown(text: string): boolean {
  // 短路：图片 / 链接 Markdown 语法在自然文本里几乎不会自然出现，一旦
  // 命中立刻判定为 Markdown。这是为了配合 AI 写作助手的"格式化"路径：
  // 若用户只选了一段含链接的短文本，AI 输出依然可能是单段，按下方累计
  // 评分仅 1~2 分（链接 +1、粗体 +1）拿不到 3 分阈值，就会被当纯文本
  // 插入 → 链接 URL 被吞掉。这条短路把这种情况兜住。
  if (/!\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\)/.test(text)) return true;  // 图片 ![](url)
  if (/(?<!!)\[[^\]]+\]\([^)\s]+(?:\s+"[^"]*")?\)/.test(text)) return true;  // 链接 [](url)

  const lines = text.split("\n");
  let score = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    // 标题：# ## ###
    if (/^#{1,6}\s+.+/.test(trimmed)) score += 2;
    // 代码块开始/结束：``` 或 ~~~
    else if (/^(`{3,}|~{3,})/.test(trimmed)) score += 2;
    // 表格行：| xxx | xxx |
    else if (/^\|.+\|$/.test(trimmed)) score += 2;
    // 表格分隔行：|---|---|
    else if (/^\|[\s:]*-{2,}[\s:]*\|/.test(trimmed)) score += 3;
    // 无序列表：- xxx 或 * xxx（排除分隔线）
    else if (/^[-*+]\s+(?!\[[ xX]\])/.test(trimmed) && !/^[-*_]{3,}$/.test(trimmed)) score += 1;
    // 有序列表：1. xxx
    else if (/^\d+\.\s+/.test(trimmed)) score += 1;
    // 引用块：> xxx
    else if (/^>\s+/.test(trimmed)) score += 1;
    // 粗体：**xxx**
    else if (/\*\*.+?\*\*/.test(trimmed)) score += 1;
    // 行内代码：`xxx`
    else if (/`.+?`/.test(trimmed)) score += 0.5;
    // 链接：[xxx](url)
    else if (/\[.+?\]\(.+?\)/.test(trimmed)) score += 1;
    // 任务列表：- [x] 或 - [ ]
    else if (/^[-*]\s+\[[ xX]\]\s+/.test(trimmed)) score += 2;
    // 水平线：--- *** ___
    else if (/^(---|\*\*\*|___)$/.test(trimmed)) score += 1;
  }

  // 得分阈值：至少需要 3 分才认为是 Markdown 内容
  // 单独的一行粗体或行内代码不应触发转换
  return score >= 3;
}

/**
 * 解析笔记内容为 Tiptap 可用的 doc 结构
 *
 * 输入可能是：
 *   1) Tiptap ProseMirror JSON 字符串（老笔记 / Tiptap 保存的）
 *   2) HTML 字符串（极少，历史导入路径）
 *   3) Markdown 字符串（MD 编辑器保存的 → 切回富文本时）
 *   4) 纯文本 / 空
 *
 * 关键点：
 *   - MD 分支必须先转 HTML 再交给 Tiptap，否则标题/列表/代码块等结构
 *     全部塌缩成一段纯文本 → 用户切回富文本后修改/保存时实际丢失了结构。
 *   - MD → HTML 优先用 `contentFormat.markdownToHtml`（基于 @lezer/markdown + GFM），
 *     覆盖表格、任务列表、删除线、setext 标题、嵌套列表、块级 HTML 等；
 *     失败时才降级到 `markdownToSimpleHtml`（逐行扫描，功能更弱但更宽松）。
 *     此前一律走 simpleHtml → GFM 表格 / 删除线等切到 RTE 后会丢失结构。
 *   - MD 识别与 contentFormat.detectFormat 保持一致：JSON 合法 + 含 Tiptap
 *     文档特征才认 tiptap-json，否则一律按 MD 处理（原先兜底只保留纯文本，
 *     是"切到富文本内容丢失"的直接原因）。
 */
function parseContent(content: string): any {
  if (!content || content === "{}") {
    return { type: "doc", content: [{ type: "paragraph" }] };
  }
  if (typeof content !== "string") return content;

  const trimmed = content.trim();

  // 1) Tiptap JSON：宽松尝试 parse，成功且长得像 doc 才接受
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        (parsed.type === "doc" ||
          (typeof parsed.type === "string" && Array.isArray(parsed.content)))
      ) {
        // 历史脏 JSON 修复：早期导入路径可能写入了 schema 不合法的 doc
        // （典型：表格 content 不满足 contentMatch）。直接喂给 setContent
        // 不会立刻报错，但任何后续 transaction 都会触发 contentMatchAt 崩溃。
        // 这里走一遍 headless Editor 的 schema fixup 兜底，~10-20ms 切笔记
        // 时一次开销，用户无感。详见 tiptapSchemaRepair.ts 顶部注释。
        return repairTiptapJson(parsed);
      }
      // 是合法 JSON 但不是 Tiptap doc → 当 MD / 纯文本继续往下走
    } catch {
      /* 不是合法 JSON，继续下一分支 */
    }
  }

  // 2) HTML 字符串：Tiptap 直接能吃
  if (/^<\w/.test(trimmed)) {
    return content;
  }

  // 3) Markdown / 纯文本 → 转 HTML 再交给 Tiptap
  //
  //   首选 contentFormat.markdownToHtml：与 MarkdownEditor 同源的 @lezer/markdown + GFM
  //   解析器，覆盖标题 / 列表 / 任务列表 / 表格 / 引用 / 代码块 / 水平线 / 链接 / 图片 /
  //   删除线 / 内嵌 HTML 等全部语法，且格式识别与 detectFormat 保持一致。
  //
  //   降级到 importService.markdownToSimpleHtml：只覆盖少数基本语法，且对复杂嵌套
  //   结构容易塌缩。当 mdToFullHtml 抛错（理论上不会）或返回空时才走它。
  try {
    // detectFormat 能把 "{ foo" 这种以 { 开头但不是 JSON 的内容识别为 md；
    // empty/html 也会在这里被分类。html 已经在上面处理过，empty 就直接返回空 doc。
    const fmt = detectContentFormat(content);
    if (fmt === "empty") {
      return { type: "doc", content: [{ type: "paragraph" }] };
    }
    // md / html 两种都尝试用完整 parser（html 走 markdownToHtml 时会被当作块级 HTML
    // 原样传递，兼容）。Tiptap 随后会 parseHTML。
    const html = mdToFullHtml(content);
    if (html && html.trim()) return html;
  } catch (err) {
    console.warn("[TiptapEditor] markdownToHtml(full) failed, falling back to simpleHtml:", err);
  }

  try {
    const html = markdownToSimpleHtml(content);
    if (html && html.trim()) return html;
  } catch (err) {
    console.warn("[TiptapEditor] markdownToSimpleHtml failed, fallback to text:", err);
  }

  // 兜底：纯文本段落
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: content }] }],
  };
}
