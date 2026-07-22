import JSZip from "jszip";
import * as mammothNamespace from "mammoth";
import {
  getDocxArchiveViolation,
  type DocxArchiveStats,
} from "../lib/docxImportSafety";

interface ParseRequest {
  type: "parse";
  requestId: string;
  fileName: string;
  originalBytes: number;
  buffer: ArrayBuffer;
}

interface WorkerImage {
  id: string;
  contentType: string;
  buffer: ArrayBuffer;
}

interface MammothImage {
  contentType: string;
  read: (encoding: "base64") => Promise<string>;
}

interface MammothResult {
  value?: string;
  messages?: Array<{ type?: string; message?: string }>;
}

interface ZipEntryLike {
  name: string;
  dir: boolean;
  _data?: { uncompressedSize?: number };
  _dataBinary?: { uncompressedSize?: number };
}

const mammoth = ((mammothNamespace as unknown as { default?: unknown }).default || mammothNamespace) as unknown as {
  convertToHtml: (
    input: { arrayBuffer: ArrayBuffer },
    options?: { convertImage?: unknown },
  ) => Promise<MammothResult>;
  images: {
    imgElement: (
      handler: (image: MammothImage) => Promise<Record<string, string>>,
    ) => unknown;
  };
};

function post(message: unknown, transfers?: Transferable[]): void {
  (self as unknown as { postMessage: (value: unknown, transfer?: Transferable[]) => void })
    .postMessage(message, transfers);
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function entryUncompressedSize(entry: ZipEntryLike): number {
  const value = entry._data?.uncompressedSize ?? entry._dataBinary?.uncompressedSize ?? 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function inspectArchive(buffer: ArrayBuffer, originalBytes: number): Promise<DocxArchiveStats> {
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: false });
  const entries = (Object.values(zip.files) as unknown as ZipEntryLike[])
    .filter((entry) => !entry.dir);
  let uncompressedBytes = 0;
  let xmlBytes = 0;
  let imageCount = 0;
  let largestImageBytes = 0;

  for (const entry of entries) {
    const size = entryUncompressedSize(entry);
    uncompressedBytes += size;
    if (/\.xml$/i.test(entry.name)) xmlBytes += size;
    if (/^word\/media\//i.test(entry.name)) {
      imageCount += 1;
      largestImageBytes = Math.max(largestImageBytes, size);
    }
  }

  return {
    originalBytes,
    entryCount: entries.length,
    uncompressedBytes,
    xmlBytes,
    imageCount,
    largestImageBytes,
  };
}

async function handleParse(request: ParseRequest): Promise<void> {
  const startedAt = performance.now();
  post({
    type: "progress",
    requestId: request.requestId,
    stage: "preflight",
    percent: 12,
    message: "正在检查 DOCX 结构与安全限制…",
  });

  const archiveStats = await inspectArchive(request.buffer, request.originalBytes);
  const violation = getDocxArchiveViolation(archiveStats);
  if (violation) {
    post({
      type: "error",
      requestId: request.requestId,
      code: violation.code,
      message: violation.message,
      archiveStats,
    });
    return;
  }

  post({
    type: "progress",
    requestId: request.requestId,
    stage: "parse",
    percent: 25,
    message: "正在后台解析 Word 正文…",
    archiveStats,
  });

  const images: WorkerImage[] = [];
  const convertImage = mammoth.images.imgElement(async (image) => {
    const id = `docx-image-${images.length + 1}`;
    const base64 = await image.read("base64");
    const buffer = base64ToArrayBuffer(base64);
    images.push({ id, contentType: image.contentType || "application/octet-stream", buffer });
    return {
      src: `nowen-docx-image://${id}`,
      "data-docx-image-id": id,
    };
  });

  const result = await mammoth.convertToHtml(
    { arrayBuffer: request.buffer },
    { convertImage },
  );
  const html = result.value || "";
  if (!html.trim()) {
    throw Object.assign(new Error("文档内容为空、已损坏或 Mammoth 无法解析"), { code: "DOCX_EMPTY" });
  }

  post({
    type: "progress",
    requestId: request.requestId,
    stage: "images",
    percent: 42,
    message: `已解析正文，发现 ${images.length} 张图片`,
    archiveStats,
    imageCount: images.length,
  });

  const transfers = images.map((image) => image.buffer as Transferable);
  post({
    type: "result",
    requestId: request.requestId,
    html,
    images,
    archiveStats,
    mammothWarnings: (result.messages || [])
      .filter((item) => item.type === "warning")
      .map((item) => item.message || "未知解析警告")
      .slice(0, 20),
    parseDurationMs: Math.round(performance.now() - startedAt),
  }, transfers);
}

(self as unknown as { onmessage: ((event: MessageEvent<ParseRequest>) => void) | null }).onmessage = (event) => {
  const request = event.data;
  if (!request || request.type !== "parse") return;
  void handleParse(request).catch((error: unknown) => {
    const value = error as { code?: string; message?: string };
    post({
      type: "error",
      requestId: request.requestId,
      code: value?.code || "DOCX_PARSE_FAILED",
      message: value?.message || "Word 文档解析失败",
    });
  });
};
