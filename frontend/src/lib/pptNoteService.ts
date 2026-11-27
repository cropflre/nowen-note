// lib/pptNoteService.ts —— PPT 演示文稿导入与 .pptx 导出服务

import { api, getBaseUrl } from "./api";
import {
  createPptx,
  extractPptPlainText,
  parsePptx,
  serializePptDeckJson,
  type PptDeckIR,
} from "@/office";
import type { Note } from "@/types";

export function pickPptxFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation";
    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => finish(input.files?.[0] || null));
    input.addEventListener("cancel", () => finish(null));
    input.style.display = "none";
    document.body.appendChild(input);
    input.click();
  });
}

export async function importPptxAsNote(params: {
  notebookId: string;
  file: File;
}): Promise<{ note: Note; deck: PptDeckIR }> {
  const deck = await parsePptx(params.file);
  const rawName = params.file.name.replace(/\.pptx$/i, "").trim();
  const title = rawName || deck.slides[0]?.title?.trim() || "导入的 PPT 演示文稿";
  const content = serializePptDeckJson(deck);
  const contentText = extractPptPlainText(deck);
  const note = (await api.createNote({
    notebookId: params.notebookId,
    title,
    content,
    contentText,
    contentFormat: "ppt-json",
    noteType: "ppt",
  })) as Note;
  return { note, deck };
}

async function resolveAttachmentImage(url: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  try {
    const token = typeof localStorage !== "undefined" ? localStorage.getItem("nowen-token") || "" : "";
    const resolvedUrl = url.startsWith("/api/")
      ? `${getBaseUrl()}${url.slice("/api".length)}`
      : url;
    const headers: Record<string, string> = {};
    if (token && (url.startsWith("/api/") || resolvedUrl.startsWith(getBaseUrl()))) {
      headers.Authorization = `Bearer ${token}`;
    }
    const resp = await fetch(resolvedUrl, { headers });
    if (!resp.ok) return null;
    const mime = resp.headers.get("content-type") || "image/png";
    const buf = await resp.arrayBuffer();
    return { bytes: new Uint8Array(buf), mime };
  } catch {
    return null;
  }
}

export async function exportPptDeckToFile(deck: PptDeckIR, title: string): Promise<void> {
  const bytes = await createPptx(deck, { resolveImage: resolveAttachmentImage });
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
  const safeName = (title || "演示文稿")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .trim() || "演示文稿";
  const filename = safeName.toLowerCase().endsWith(".pptx") ? safeName : `${safeName}.pptx`;

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
