// rtfImageUploader.ts — 把编辑器里「粘贴后产生的 data:image/* 图片」
// 异步替换成 /api/attachments/<id> 的 URL，避免笔记 JSON 膨胀到几十 MB。
//
// 工作流：
//   1. 扫描当前 doc，收集所有 src 以 "data:image/" 开头的 image node 的 dataUrl
//      （只收字符串，不记 pos——pos 会随文档编辑/插入而失效）
//   2. 并发小批量地把每个 dataUrl 转成 Blob → File，调用
//      api.attachments.upload(noteId, file)
//   3. 每上传成功一张，用 doc.descendants 找出**当前**文档里所有
//      src === 此 dataUrl 的 image node，用 tr.setNodeMarkup 把 src 替换成
//      服务端 URL；这样即使用户已经在编辑器里移动光标、敲字、滚动，也不会
//      把替换事务打到错误位置上。
//   4. 所有 dataUrl 结束后返回上传成功与失败数。
//
// 为什么要异步并发 + 每次即时 replace？
//   - 42 张图 × 大文件，顺序上传要等很久，期间用户还能继续编辑；
//   - 如果最后一次性批量替换，会覆盖用户新输入；
//   - 并发过高会撑爆本地/服务器 I/O，所以限流到 DEFAULT_CONCURRENCY。

import type { Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { api } from "./api";

/** 并发上限：3 张同时上传已足够吃满本地 Node 后端，又不至于拖垮浏览器内存。 */
const DEFAULT_CONCURRENCY = 3;

/** 把 data:image/png;base64,xxx 这种 URL 转成 File 对象。不抛异常，失败返回 null。 */
function dataUrlToFile(dataUrl: string, indexHint: number): File | null {
  try {
    const m = /^data:([^;,]+)(?:;base64)?,/.exec(dataUrl);
    if (!m) return null;
    const mime = m[1] || "application/octet-stream";
    const isBase64 = /;base64,/i.test(dataUrl);
    const payload = dataUrl.slice(dataUrl.indexOf(",") + 1);
    let bytes: Uint8Array;
    if (isBase64) {
      const binary = atob(payload);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(payload));
    }
    const ext = mime.includes("png")
      ? "png"
      : mime.includes("jpeg") || mime.includes("jpg")
        ? "jpg"
        : mime.includes("gif")
          ? "gif"
          : mime.includes("webp")
            ? "webp"
            : "bin";
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    return new File([ab], `pasted-${Date.now()}-${indexHint}.${ext}`, {
      type: mime,
    });
  } catch {
    return null;
  }
}

/** 收集当前 doc 里所有 src 以 data:image/ 开头的 image node 的 dataUrl 列表（按出现顺序、去重）。 */
function collectDataUrls(editor: Editor): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  editor.state.doc.descendants((node: PMNode) => {
    if (node.type.name !== "image") return true;
    const src = (node.attrs?.src as string | undefined) || "";
    if (src.startsWith("data:image/") && !seen.has(src)) {
      seen.add(src);
      list.push(src);
    }
    return true;
  });
  return list;
}

/**
 * 把编辑器里当前所有 data:image/* 图片异步上传到 /api/attachments，
 * 成功一张就把相应 image node 的 src 原地替换成服务端 URL。
 *
 * 调用约束：editor 必须仍然挂载；noteId 必须有效。
 *
 * @returns Promise<{ total, uploaded, failed }>
 */
export async function replaceDataUrlImagesWithAttachments(
  editor: Editor,
  noteId: string,
  opts?: {
    concurrency?: number;
    isCurrent?: () => boolean;
    onProgress?: (done: number, total: number) => void;
  }
): Promise<{ total: number; uploaded: number; failed: number }> {
  const isCurrent = () => !editor.isDestroyed && (opts?.isCurrent?.() ?? true);
  if (!isCurrent()) return { total: 0, uploaded: 0, failed: 0 };
  const concurrency = Math.max(1, opts?.concurrency ?? DEFAULT_CONCURRENCY);
  const dataUrls = collectDataUrls(editor);
  const total = dataUrls.length;
  if (total === 0) return { total: 0, uploaded: 0, failed: 0 };
  opts?.onProgress?.(0, total);

  let uploaded = 0;
  let failed = 0;
  let done = 0;
  let cursor = 0;

  const worker = async () => {
    while (true) {
      if (!isCurrent()) return;
      const idx = cursor++;
      if (idx >= total) return;
      const dataUrl = dataUrls[idx];
      try {
        const file = dataUrlToFile(dataUrl, idx);
        if (!file) {
          failed += 1;
          continue;
        }
        const res = await api.attachments.upload(noteId, file);
        if (!isCurrent()) return;
        const tr = editor.state.tr;
        editor.state.doc.descendants((node: PMNode, pos: number) => {
          if (node.type.name === "image" && node.attrs?.src === dataUrl) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: res.url });
          }
        });
        // 重要：别把 tr 标记为 addToHistory=false，否则用户撤销看不到
        // 这次替换；但这会在 undo 栈里留一条历史。权衡后仍默认记录——
        // 用户多按一次 Ctrl+Z 的代价远小于"笔记里意外包含 base64"。
        // 用户可能已删除图片；重复出现的相同图片则一起替换。
        if (tr.docChanged) editor.view.dispatch(tr);
        uploaded += 1;
      } catch (err) {
        console.warn(
          "[rtfImageUploader] upload failed for pasted image:",
          err
        );
        failed += 1;
      } finally {
        done += 1;
        if (isCurrent()) opts?.onProgress?.(done, total);
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, total) }, () =>
    worker()
  );
  await Promise.all(workers);
  return { total, uploaded, failed };
}
