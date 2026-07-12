// lib/wordNoteService.ts —— "新建 Word 文档"业务流程封装
//
// 阶段 1（W2 之前）的最小可用闭环：
//   1) api.createNote 创建一篇笔记，拿到 noteId
//   2) createBlankDocx() 在前端生成一份合法空白 .docx Blob
//   3) api.attachments.upload(noteId, file) 上传成附件，拿到 url
//   4) 把 Tiptap JSON 拼成"标题 + 一行附件链接"，调 api.updateNote 写回
//
// 之所以分两步（先建笔记拿 id 再上传，再 update）：
//   - attachments 表强外键到 notes.id，必须先有 noteId 才能上传
//   - notes.content 里需要带上附件 URL，才能在打开笔记时点开 docx 预览
//
// 任一步失败都给用户能识别的错误信息。轻度失败容忍：第 3 步如果失败但
// 笔记已经创建，至少留下一篇带标题的空笔记，不会污染数据。
//
// 后续阶段会把"附件链接"换成可编辑 WordViewer 入口节点，但生成 docx +
// 上传附件的链路保持不变，这套服务可以一直复用。

import { api } from "./api";
import { createBlankDocx, blankDocxFile, tiptapToIr, createDocx } from "@/office";
import type { Note } from "@/types";
import { generateJSON } from "@tiptap/core";
import { getTiptapExtensions } from "./contentFormat";

// Tiptap 扩展集：与 TiptapEditor / importService 保持一致，否则带颜色 / 字号 /
// 表格 / 任务列表的 HTML 在 generateJSON 阶段会被 schema 过滤掉。
export interface CreateWordNoteResult {
  /** 后端返回的最终 Note（已带附件链接的 content）。 */
  note: Note;
  /** 上传成功的附件 id（外链分享 / 后续覆盖保存可能要用）。 */
  attachmentId: string;
  /** 附件相对 URL，例如 /api/attachments/<id>。 */
  attachmentUrl: string;
}

interface CreateWordNoteParams {
  notebookId: string;
  /** 笔记标题，默认 "新建 Word 文档"。同时也写进 docx 的 title 元数据。 */
  title?: string;
  /** 文档作者写到 docx 的 author 元数据。 */
  author?: string;
}

/**
 * 把"附件链接"包成一段 Tiptap JSON。结构和 TiptapEditor 里
 * buildAttachmentLinkHtml 等价，但跳过 HTML→PM 的解析，省事。
 *
 * 形态：
 *   doc
 *   ├── heading(level=1)  "<title>"
 *   └── paragraph
 *       ├── text "📎 "
 *       ├── text "<filename>"   marks=[link(href, download, data-attachment=1)]
 *       └── text " (".concat(...) ...
 *
 * 注：这里直接落 type:"doc"+children 的 Tiptap JSON；后端只把它当字符串
 * 存。打开笔记时 TiptapEditor 反序列化。link mark 来自 StarterKit 默认的
 * Link 扩展，attrs 里的 data-attachment 借由 Tiptap 默认的 HTMLAttributes 透传，
 * 但 Tiptap 的 Link mark 不识别该 attr，因此点击预览的识别条件这里要兜底：
 * TiptapEditor 的 click handler 同时检查 download 后缀（见 TiptapEditor.tsx
 * 1382 附近注释），所以即使 data-attachment 属性丢失也仍能正常预览 docx。
 */
function buildContentJson(params: {
  title: string;
  filename: string;
  url: string;
  size: number;
}): string {
  const { title, filename, url, size } = params;
  const sizeLabel = formatBytes(size);

  const doc = {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: title }],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "📎 " },
          {
            type: "text",
            text: `${filename} (${sizeLabel})`,
            marks: [
              {
                type: "link",
                attrs: {
                  href: url,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  // 这两个 attr 多数 Link 扩展不会保留；我们在生成 HTML 阶段
                  // 是通过 download 后缀 + href 路径识别的，所以丢失也没关系。
                },
              },
            ],
          },
          { type: "text", text: " " },
        ],
      },
    ],
  };
  return JSON.stringify(doc);
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 创建一个"Word 笔记"：
 *   - 生成空白 docx
 *   - 通过 attachments 上传
 *   - 把附件链接写入笔记 content
 *
 * 失败语义：
 *   - createNote 失败 → 直接抛错，不留痕
 *   - upload 失败 → 留下已建的空笔记（带 title），抛错让 UI 提示"附件失败但笔记已建"
 *   - updateNote 失败 → 留下笔记 + 附件，抛错让 UI 提示"内容回写失败可手动重试"
 */
export async function createWordNote(
  params: CreateWordNoteParams,
): Promise<CreateWordNoteResult> {
  const title = (params.title || "").trim() || "新建 Word 文档";
  const filename = /\.docx$/i.test(title) ? title : `${title}.docx`;

  // 1) 先建笔记骨架
  const baseNote = (await api.createNote({
    notebookId: params.notebookId,
    title,
  })) as Note;

  // 2) 生成 .docx Blob 并上传为附件
  let attachmentId = "";
  let attachmentUrl = "";
  let attachmentSize = 0;
  try {
    const blob = await createBlankDocx({
      title,
      author: params.author,
    });
    const file = blankDocxFile(filename, blob);
    const uploaded = await api.attachments.upload(baseNote.id, file);
    attachmentId = uploaded.id;
    attachmentUrl = uploaded.url;
    attachmentSize = uploaded.size;
  } catch (err) {
    // 笔记骨架已建好，但附件上传失败。把错往上抛，调用方决定是否回滚。
    throw new Error(
      `Word 文档创建失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 3) 把附件链接写回 content
  const content = buildContentJson({
    title,
    filename,
    url: attachmentUrl,
    size: attachmentSize,
  });
  const contentText = `📎 ${filename}`;

  // 后端对 title/content/contentText 变更强制要求带 version（乐观锁）。
  // baseNote 是 createNote 刚返回的，中间没有别人改过，直接拿它的 version 即可。
  const updated = (await api.updateNote(baseNote.id, {
    content,
    contentText,
    version: baseNote.version,
  } as Partial<Note>)) as Note;

  return {
    note: updated,
    attachmentId,
    attachmentUrl,
  };
}

/**
 * 替换 Word 笔记里的 .docx 附件：删旧附件 → 上新附件 → 更新笔记 content
 * 让链接指向新 attachmentUrl。
 *
 * 用于"用 Word 改完文档 → 在笔记里点上传新版本"场景。
 *
 * 调用约束：
 *   - file 必须是 .docx；这里不做严格 MIME 校验（让后端兜底）
 *   - 失败时尽量保留旧附件，避免数据丢失：
 *       1. 先上传新附件（成功才继续）
 *       2. 再 update note.content 指向新 url
 *       3. 最后才删旧附件（如果删失败只 log，不抛错——避免链路看起来失败）
 */
export async function replaceWordAttachment(params: {
  noteId: string;
  oldAttachmentId: string;
  file: File;
}): Promise<{ attachmentId: string; attachmentUrl: string; note: Note }> {
  const { noteId, oldAttachmentId, file } = params;

  // 1) 先上传新附件
  const uploaded = await api.attachments.upload(noteId, file);

  // 2) 更新笔记 content：把指向旧 id 的链接换成新 id
  //    懒法：直接重新 build 一个简化 content（标题 + 一行链接），跟 createWordNote 一致。
  //    这样不用解析旧 content 里的 link node 做局部替换，鲁棒得多。
  const safeName = /\.docx$/i.test(file.name) ? file.name : `${file.name}.docx`;
  const titleFromName = safeName.replace(/\.docx$/i, "");
  const content = JSON.stringify({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: titleFromName }],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "📎 " },
          {
            type: "text",
            text: `${safeName} (${formatBytes(uploaded.size)})`,
            marks: [
              {
                type: "link",
                attrs: {
                  href: uploaded.url,
                  target: "_blank",
                  rel: "noopener noreferrer",
                },
              },
            ],
          },
          { type: "text", text: " " },
        ],
      },
    ],
  });
  const contentText = `📎 ${safeName}`;
  // 后端对 content 写入强制要求 version（乐观锁）。
  // 这里不从调用方拿，而是 GET 一次拿最新 version 再 PUT，
  // 避免调用方传进来的 note 快照过时导致 409。反正这个场景
  // 是用户主动点击"上传新版本"，多一次 round-trip 不会影响体验。
  const latest = (await api.getNote(noteId)) as Note;
  const updatedNote = (await api.updateNote(noteId, {
    content,
    contentText,
    version: latest.version,
  } as Partial<Note>)) as Note;

  // 3) 删旧附件（失败不阻塞，旧附件最坏情况成为孤儿，由后端 GC 兜底）
  try {
    await api.attachments.remove(oldAttachmentId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("旧 .docx 附件清理失败（可由后端 GC 后续清理）:", err);
  }

  return {
    attachmentId: uploaded.id,
    attachmentUrl: uploaded.url,
    note: updatedNote,
  };
}

/**
 * 把任意一篇笔记（Tiptap JSON content）导出为 .docx Blob。
 *
 * 走的是「Tiptap JSON → DocxIR → docx」两段映射：
 *   - 不依赖笔记是不是"Word 笔记"，所有笔记都能导
 *   - 图片若是相对 URL（/api/attachments/...）会同源 fetch 转 data URL
 *   - 任何未知节点降级成纯文本，保证导出不会因为单个奇葩节点彻底失败
 *
 * 调用方：UI 上点"导出 .docx"按钮 → 拿到 Blob → URL.createObjectURL + 触发下载。
 *
 * @param noteContent  笔记的 content 字段（Tiptap JSON 字符串）
 * @param title        文档标题（写到 docProps/core.xml + docMeta.title）
 * @param author       可选作者
 */
export async function exportNoteAsDocx(
  noteContent: string,
  title: string,
  author?: string,
): Promise<Blob> {
  // 兼容老笔记：content 可能是 HTML / Markdown / 纯文本（非 Tiptap JSON）
  // 这种情况下 tiptapToIr 拿到的不是 doc 节点会直接 fallback 成空 IR，
  // 这里再做一次保护：尝试解析失败就先用纯文本兜底。
  let parsed: any = null;
  try {
    parsed = JSON.parse(noteContent);
  } catch {
    // 非 JSON：包成一个段落 doc
    parsed = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: noteContent }] },
      ],
    };
  }

  // 不是 Tiptap doc（例如直接是 HTML 字符串解析出错的对象）→ 同样兜底
  if (!parsed || parsed.type !== "doc") {
    parsed = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: String(noteContent || "") }] },
      ],
    };
  }

  const ir = await tiptapToIr(parsed, { title, author });
  return createDocx(ir, { title, author });
}

/**
 * 把浏览器生成的 DOCX 暂存到服务端，再从真实 HTTP 地址触发下载。
 * 避免 Chrono 等下载扩展接管 about:blank Blob 后无法完成。
 */
export async function downloadDocxBlob(blob: Blob, filename: string): Promise<void> {
  const safeName = /\.docx$/i.test(filename) ? filename : `${filename}.docx`;
  const staged = await api.stageGeneratedExport(blob, safeName);
  api.downloadMarkdownExport(staged.downloadToken, staged.filename);
}

// ===== 导入 Word 文档 =====
//
// 设计取舍：
//   - 走 mammoth → HTML → Tiptap JSON 路线（不复用自研 parseDocx）。
//     原因见评估：mammoth 对表格 / 列表 / 嵌套样式覆盖度高于自研 parseDocx，
//     代码量也只是后者的 1/5。
//   - 图片走 mammoth 默认行为（base64 内嵌进 HTML）。MVP 选择，缺点是大图
//     笔记的 content 体积膨胀；后续可以改成"抽出图片 → 上传 attachments → 替换 src"。
//   - 限制单文件 50MB；超过的话浏览器解析会卡住主线程，先抛错让用户感知。
//   - generateJSON 跑空 doc 时降级返回 HTML 字符串（与 importService 同款兜底）。

/** 单文件大小上限（字节）。超过直接拒绝。 */
const IMPORT_DOCX_MAX_SIZE = 50 * 1024 * 1024;

export interface ImportDocxAsNoteParams {
  /** 目标笔记本 id */
  notebookId: string;
  /** 用户选择的 .docx 文件 */
  file: File;
}

export interface ImportDocxAsNoteResult {
  note: Note;
  /** 解析后第一段文本，给 toast 用 */
  previewText: string;
}

/**
 * 把一份用户选中的 .docx 文件导入为可编辑的富文本笔记。
 *
 * 流程：
 *   1) 大小校验
 *   2) 动态 import mammoth 解析 docx → HTML（图片 base64 内嵌）
 *   3) 从 HTML 提取标题（第一个 h1/h2 → 文件名兜底）
 *   4) generateJSON 转 Tiptap JSON
 *   5) createNote + updateNote 写回
 */
export async function importDocxAsNote(
  params: ImportDocxAsNoteParams,
): Promise<ImportDocxAsNoteResult> {
  const { notebookId, file } = params;

  if (!file) throw new Error("未选择文件");
  if (!/\.docx$/i.test(file.name)) {
    throw new Error("仅支持 .docx 文件（旧版 .doc 请先用 Word 另存为 .docx）");
  }
  if (file.size > IMPORT_DOCX_MAX_SIZE) {
    throw new Error(
      `文件过大（${(file.size / 1024 / 1024).toFixed(1)} MB），上限 ${IMPORT_DOCX_MAX_SIZE / 1024 / 1024} MB`,
    );
  }

  // 1) docx → HTML
  //   - mammoth 主入口在浏览器环境也能用，但 @types/mammoth 仅覆盖 node 路径，
  //     这里把它当 unknown 接住再窄化，避免引入 any。
  //   - 这是个 ~800KB 的重模块，所以延迟到导入阶段才动态加载。
  const mammothMod = (await import("mammoth")) as unknown as {
    convertToHtml: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value?: string }>;
  };
  const buf = await file.arrayBuffer();
  const result = await mammothMod.convertToHtml({ arrayBuffer: buf });
  const html: string = result?.value ?? "";
  if (!html.trim()) {
    throw new Error("文档内容为空或解析失败");
  }

  // 2) 提取标题
  const title = extractTitleFromHtml(html, file.name.replace(/\.docx$/i, ""));

  // 3) HTML → Tiptap JSON（与 importService / youdaoNoteService 同款扩展集，避免格式被 schema 过滤掉）
  const content = htmlToTiptapJsonString(html);

  // 4) contentText：拿前 200 个纯文本字符做摘要，方便列表展示
  const previewText = htmlToPlainText(html).slice(0, 200);

  // 5) 写后端：先建笔记骨架，再 update content（attachments 路径不同，
  //    但这里走纯笔记，不需要先拿 noteId 再上传）
  const baseNote = (await api.createNote({
    notebookId,
    title,
  })) as Note;

  const updated = (await api.updateNote(baseNote.id, {
    content,
    contentText: previewText,
    version: baseNote.version,
  } as Partial<Note>)) as Note;

  return { note: updated, previewText };
}

/** 从 mammoth 输出的 HTML 中提取标题：第一个 h1/h2 → 第一段文本 → 文件名 */
function extractTitleFromHtml(html: string, fallback: string): string {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1 && h1[1]) {
    const t = stripTags(h1[1]).trim();
    if (t) return t.slice(0, 120);
  }
  const h2 = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  if (h2 && h2[1]) {
    const t = stripTags(h2[1]).trim();
    if (t) return t.slice(0, 120);
  }
  const p = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (p && p[1]) {
    const t = stripTags(p[1]).trim();
    if (t) return t.slice(0, 60);
  }
  return fallback || "导入的 Word 文档";
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function htmlToPlainText(html: string): string {
  return stripTags(html).replace(/\s+/g, " ").trim();
}

/**
 * HTML → Tiptap JSON 字符串。
 *
 * 设计取舍（参考 importService.convertToTiptapJson）：
 *   - 复用顶层 tiptapExtensions（与 TiptapEditor 配置一致）
 *   - generateJSON 在 schema 命中失败时不会抛错而是吐空 doc，需要兜底返回
 *     原 HTML，让 TiptapEditor 走 parseHTML 自己解析，比展示空白靠谱
 *   - 任何异常都降级到 HTML
 */
function htmlToTiptapJsonString(html: string): string {
  try {
    const json = generateJSON(html, getTiptapExtensions());
    const looksEmpty =
      json &&
      json.type === "doc" &&
      Array.isArray(json.content) &&
      (json.content.length === 0 ||
        (json.content.length === 1 &&
          json.content[0]?.type === "paragraph" &&
          !json.content[0]?.content));
    if (looksEmpty && html.replace(/<[^>]+>/g, "").trim().length > 0) {
      console.warn("[wordNoteService] generateJSON produced empty doc; falling back to HTML");
      return html;
    }
    return JSON.stringify(json);
  } catch (err) {
    console.warn("[wordNoteService] generateJSON threw, falling back to HTML:", err);
    return html;
  }
}

/**
 * 弹出文件选择器，让用户选一个 .docx 文件。
 * 取消选择时 resolve(null)。
 */
export function pickDocxFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    input.style.display = "none";
    document.body.appendChild(input);

    let settled = false;
    const cleanup = () => {
      if (input.parentNode) input.parentNode.removeChild(input);
    };

    input.onchange = () => {
      settled = true;
      const f = input.files && input.files[0];
      cleanup();
      resolve(f || null);
    };

    // 部分浏览器在用户取消时会触发 cancel 事件；不触发也没关系——
    // 用户后续不会等待这个 promise resolve（重复点击会重新走一次 pickDocxFile）。
    input.oncancel = () => {
      if (settled) return;
      cleanup();
      resolve(null);
    };

    input.click();
  });
}
