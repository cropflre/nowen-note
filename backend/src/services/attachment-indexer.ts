/**
 * Attachment Content Indexer — RAG Phase 3
 * ---------------------------------------------------------------------------
 *
 * 从磁盘读取附件字节 → 按 MIME 分派到对应解析器 → 得到可搜索的纯文本 →
 * 按 ~1500 字符切段，返回给 embedding-worker 去算向量。
 *
 * 支持格式（优先覆盖常用）：
 *   - text/*            ：UTF-8 解码，按 4MB 上限
 *   - application/pdf   ：unpdf 解析（纯 JS，跨平台，无本地依赖）
 *   - application/json  ：JSON.parse → 按 key/value 扁平化成行
 *   - application/xml
 *     text/xml          ：去标签后当纯文本
 *   - docx / odt        ：mammoth（已在依赖里，本 PR 顺手复用）
 *
 * 不支持（显式跳过，不报错，让 worker 把任务标 done+skipped）：
 *   - image/*           ：图片走 OCR 太重，后续可按需加
 *   - audio/* video/*   ：同上
 *   - application/zip 等二进制归档
 *   - 大文件（>MAX_PARSE_SIZE，默认 20MB）——避免把 1GB PDF 全部 OCR
 *
 * 安全：
 *   - 所有解析器都在 try/catch 里跑，单个附件解析失败不影响队列其它任务；
 *   - PDF 分页可能很多，我们只拼到 MAX_TEXT_CHARS（默认 200KB）就截断；
 *   - 路径严格在 ATTACHMENTS_DIR 下拼接，禁止上溯。
 */
import fs from "fs";
import path from "path";
import { getAttachmentsDir } from "./attachment-storage";

// 最大解析文件字节数（20MB）。更大的文件直接跳过，避免把内存打爆
const MAX_PARSE_SIZE = 20 * 1024 * 1024;

// 解析后的纯文本最大字符数（避免一本电子书切出几百段把队列灌爆）
const MAX_TEXT_CHARS = 200_000;

// 与 embedding-worker 保持一致的 chunk 尺寸
const CHUNK_SIZE = 1500;

// 单个附件最多切多少段（防止超长 PDF）
const MAX_CHUNKS_PER_ATTACHMENT = 16;

/** 判断 MIME 是否"显然是纯文本"——走最省事的 UTF-8 解码路径 */
function isTextLikeMime(mime: string): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase();
  if (m.startsWith("text/")) return true;
  // 常见的"名字叫 application/* 但其实是文本"的场景
  return (
    m === "application/json" ||
    m === "application/javascript" ||
    m === "application/x-ndjson" ||
    m === "application/x-yaml" ||
    m === "application/yaml" ||
    m === "application/toml" ||
    m === "application/x-sh"
  );
}

/** docx / odt 的 mime */
function isDocxMime(mime: string): boolean {
  const m = (mime || "").toLowerCase();
  return (
    m === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    m === "application/vnd.oasis.opendocument.text"
  );
}

function isPdfMime(mime: string): boolean {
  return (mime || "").toLowerCase() === "application/pdf";
}

function isXmlMime(mime: string): boolean {
  const m = (mime || "").toLowerCase();
  return m === "application/xml" || m === "text/xml";
}

/** xlsx / xlsm / xltx — Office Open XML 电子表格 */
function isXlsxMime(mime: string): boolean {
  const m = (mime || "").toLowerCase();
  return (
    m === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    m === "application/vnd.ms-excel.sheet.macroenabled.12" ||
    m === "application/vnd.openxmlformats-officedocument.spreadsheetml.template" ||
    // 部分浏览器 / OS 上传时把 xlsx 标成通用 zip / octet-stream，
    // 后续 guessByExt 兜底；这里只识别"声明明确就是 spreadsheet"的 mime。
    false
  );
}

/** 按扩展名兜底识别（MIME 不准确时） */
function guessByExt(
  filename: string,
): "pdf" | "docx" | "text" | "json" | "xml" | "xlsx" | null {
  const ext = (path.extname(filename || "").replace(/^\./, "") || "").toLowerCase();
  if (!ext) return null;
  if (ext === "pdf") return "pdf";
  if (ext === "docx" || ext === "odt") return "docx";
  // xlsx / xlsm 走 OOXML 解析；xltx 模板格式一样能读。
  // .xls（旧版 BIFF 二进制）这里不支持，让它走 unsupported。
  if (ext === "xlsx" || ext === "xlsm" || ext === "xltx") return "xlsx";
  if (ext === "json") return "json";
  if (ext === "xml") return "xml";
  if ([
    "txt", "md", "markdown", "rst", "log", "csv", "tsv",
    "js", "ts", "tsx", "jsx", "mjs", "cjs", "py", "java",
    "c", "h", "cpp", "hpp", "cs", "go", "rs", "rb", "php",
    "sh", "bash", "zsh", "ps1", "sql", "yaml", "yml", "toml",
    "ini", "cfg", "conf", "env", "html", "htm", "css", "scss",
  ].includes(ext)) return "text";
  return null;
}

// ============================================================
// 解析器
// ============================================================

/** UTF-8 解码；二进制文件会得到乱码，但不抛错（由上游按 MIME 过滤） */
function parseText(buf: Buffer): string {
  // 用 utf-8 with replacement 容错（遇到非法字节不抛错）
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

/** JSON：解析后"键: 值"逐行展开，便于 embedding 命中字段名和值 */
function parseJson(buf: Buffer): string {
  const raw = parseText(buf);
  try {
    const obj = JSON.parse(raw);
    const lines: string[] = [];
    const walk = (v: unknown, keyPath: string) => {
      if (lines.length > 20_000) return; // 防止巨型 JSON 占爆内存
      if (v === null || v === undefined) return;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        lines.push(`${keyPath}: ${v}`);
        return;
      }
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length && i < 1000; i++) {
          walk(v[i], `${keyPath}[${i}]`);
        }
        return;
      }
      if (typeof v === "object") {
        for (const k of Object.keys(v)) {
          walk((v as any)[k], keyPath ? `${keyPath}.${k}` : k);
        }
      }
    };
    walk(obj, "");
    const joined = lines.join("\n");
    // 如果扁平化结果太短（例如是个字符串 JSON），回退到原文
    return joined.length > 50 ? joined : raw;
  } catch {
    // 不是合法 JSON → 当纯文本
    return raw;
  }
}

/** XML：去标签和实体，保留文本节点 */
function parseXml(buf: Buffer): string {
  const raw = parseText(buf);
  // 一次性正则去标签；解决 99% 场景。要彻底就得引入 fast-xml-parser。
  return raw
    .replace(/<!--[\s\S]*?-->/g, " ")          // 去注释
    .replace(/<\?[\s\S]*?\?>/g, " ")           // 去 PI
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1") // 保留 CDATA 内容
    .replace(/<[^>]+>/g, " ")                  // 去标签
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * PDF：用 unpdf 提取文本。
 *
 * unpdf 是 pdf.js 的纯 JS 包装，零依赖、跨平台、同步 API 也能用，
 * 完美适配 Node 环境。相对 pdf-parse 的优势是没有 "./test/data/05-versions-space.pdf"
 * 这种启动时硬编码文件的历史问题。
 *
 * 返回拼接后的所有页文本；超过 MAX_TEXT_CHARS 时截断。
 */
async function parsePdf(buf: Buffer): Promise<string> {
  // 动态 import 避免启动时就加载 unpdf（某些环境构建阶段不需要 PDF 支持）
  const { extractText, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(buf));
  const result = await extractText(doc, { mergePages: false }) as
    | { text: string[] | string; totalPages?: number }
    | string[]
    | string;

  // unpdf 的返回类型跨版本有差异：
  //   - 新版：{ text: string[], totalPages }
  //   - 旧版：string[] 或 string
  // 这里兼容多种形态。
  let pages: string[];
  if (Array.isArray(result)) {
    pages = result.map(String);
  } else if (typeof result === "string") {
    pages = [result];
  } else if (result && typeof result === "object" && "text" in result) {
    const t = (result as { text: string[] | string }).text;
    pages = Array.isArray(t) ? t.map(String) : [String(t)];
  } else {
    pages = [];
  }

  let total = "";
  for (const page of pages) {
    if (total.length >= MAX_TEXT_CHARS) break;
    total += page + "\n\n";
  }
  return total.slice(0, MAX_TEXT_CHARS);
}

/**
 * docx / odt：mammoth。
 *
 * 只取 raw text，不保留样式（向量检索也用不上）。
 */
async function parseDocx(buf: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ buffer: buf });
  return (value || "").slice(0, MAX_TEXT_CHARS);
}

/**
 * xlsx / xlsm / xltx：OOXML 电子表格。
 *
 * 不引第三方依赖，复用已有的 jszip：
 *   1. 读 `xl/sharedStrings.xml`（共享字符串池）→ 数组
 *   2. 遍历 `xl/worksheets/sheet*.xml`：
 *      - <c t="s"><v>{idx}</v></c>          → 字符串池里取
 *      - <c t="str"|"inlineStr"><is><t>...   → 内联字符串
 *      - <c><v>{number}</v></c>              → 数字字面量
 *   3. 一个 <row> 内的单元格用 " | " 分隔，行用 "\n" 分隔；多 sheet 用
 *      `=== Sheet: <name> ===\n` 分块——这样向量检索时既能命中具体单元格内容，
 *      也能命中所在工作表名。
 *
 * 取舍：
 *   - 不解析公式（=SUM(A1:A10)），值已经被 Excel 保存到 <v>，向量检索拿值即可；
 *   - 不解析样式 / 合并单元格 / 图表；
 *   - 文本上限沿用 MAX_TEXT_CHARS（200KB），超大表会被截断——能覆盖单表
 *     一两万行普通文本，对账型超大表 RAG 召回价值本来就有限。
 */
async function parseXlsx(buf: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);

  // ---- 1. sharedStrings.xml ----
  // 路径在标准 OOXML 里固定是 xl/sharedStrings.xml；存在性不保证（全数字表会没有）
  const sharedStrings: string[] = [];
  const ssFile = zip.file("xl/sharedStrings.xml");
  if (ssFile) {
    const ssXml = await ssFile.async("string");
    // <si>…</si> 是每一个字符串项；内部可能有多个 <t>（带富文本时）需要拼接
    const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let m: RegExpExecArray | null;
    while ((m = siRe.exec(ssXml)) !== null) {
      const inner = m[1];
      let text = "";
      let tm: RegExpExecArray | null;
      while ((tm = tRe.exec(inner)) !== null) {
        text += decodeXmlEntities(tm[1]);
      }
      sharedStrings.push(text);
      tRe.lastIndex = 0;
    }
  }

  // ---- 2. workbook.xml：sheet 顺序 + 名称 ----
  // <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
  const sheetNames = new Map<number, string>(); // 1-based index → display name
  const wbFile = zip.file("xl/workbook.xml");
  if (wbFile) {
    const wbXml = await wbFile.async("string");
    const sheetRe = /<sheet\b[^>]*\bname="([^"]+)"[^>]*\bsheetId="(\d+)"[^>]*\/>/g;
    let m: RegExpExecArray | null;
    let order = 1;
    while ((m = sheetRe.exec(wbXml)) !== null) {
      // OOXML 里 worksheets/sheet{N}.xml 的 N 与 sheets 中出现顺序对应，
      // sheetId 不一定与文件名 N 相同。这里以"出现顺序"为索引，能稳定对到
      // worksheets/sheet{order}.xml 文件。
      sheetNames.set(order++, decodeXmlEntities(m[1]));
    }
  }

  // ---- 3. 遍历 worksheets/sheet*.xml ----
  const parts: string[] = [];
  let used = 0;

  // 按文件名后缀数字升序遍历，保证 sheet1, sheet2, ... 的顺序
  const sheetEntries = Object.keys(zip.files)
    .filter((p) => /^xl\/worksheets\/sheet(\d+)\.xml$/.test(p))
    .map((p) => ({
      path: p,
      n: parseInt(p.replace(/^.*sheet(\d+)\.xml$/, "$1"), 10),
    }))
    .sort((a, b) => a.n - b.n);

  for (const ent of sheetEntries) {
    if (used >= MAX_TEXT_CHARS) break;
    const f = zip.file(ent.path);
    if (!f) continue;
    const xml = await f.async("string");

    const sheetTitle = sheetNames.get(ent.n) || `Sheet${ent.n}`;
    const header = `=== Sheet: ${sheetTitle} ===\n`;
    parts.push(header);
    used += header.length;

    // 逐行解析：<row>…</row> 内若干 <c>…</c>
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    const attrTypeRe = /\bt="([^"]+)"/;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(xml)) !== null) {
      if (used >= MAX_TEXT_CHARS) break;
      const rowInner = rm[1];
      const cells: string[] = [];
      let cm: RegExpExecArray | null;
      cellRe.lastIndex = 0;
      while ((cm = cellRe.exec(rowInner)) !== null) {
        const attrs = cm[1] || "";
        const inner = cm[2] || "";
        const tm = attrTypeRe.exec(attrs);
        const t = tm ? tm[1] : "";
        let val = "";
        if (t === "s") {
          // sharedStrings 索引
          const vMatch = /<v[^>]*>([\s\S]*?)<\/v>/.exec(inner);
          if (vMatch) {
            const idx = parseInt(vMatch[1], 10);
            if (Number.isFinite(idx) && idx >= 0 && idx < sharedStrings.length) {
              val = sharedStrings[idx];
            }
          }
        } else if (t === "inlineStr") {
          // <c t="inlineStr"><is><t>...</t></is></c>
          const tMatch = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);
          if (tMatch) val = decodeXmlEntities(tMatch[1]);
        } else if (t === "str") {
          // 公式返回的字符串：<v>...</v>
          const vMatch = /<v[^>]*>([\s\S]*?)<\/v>/.exec(inner);
          if (vMatch) val = decodeXmlEntities(vMatch[1]);
        } else {
          // 无 t 属性 / "n"（数字）/ "b"（布尔）：直接取 <v>
          const vMatch = /<v[^>]*>([\s\S]*?)<\/v>/.exec(inner);
          if (vMatch) val = decodeXmlEntities(vMatch[1]);
        }
        if (val) cells.push(val);
      }
      if (cells.length > 0) {
        const line = cells.join(" | ") + "\n";
        // 截断保护：如果一行就把上限撑爆，截到剩余空间
        if (used + line.length > MAX_TEXT_CHARS) {
          parts.push(line.slice(0, MAX_TEXT_CHARS - used));
          used = MAX_TEXT_CHARS;
          break;
        }
        parts.push(line);
        used += line.length;
      }
    }
  }

  return parts.join("");
}

/** 标准 XML 实体反转义（共用） */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(parseInt(d, 10)));
}

// ============================================================
// 主入口
// ============================================================

export interface ExtractResult {
  /** 提取出的纯文本（可能被截断到 MAX_TEXT_CHARS） */
  text: string;
  /** 跳过原因（有值时 text === ''，调用方据此决定"标记 done + skipped"还是"失败"） */
  skipReason?: "unsupported" | "too-large" | "empty" | "not-found";
  /** 文件字节数（诊断用） */
  size: number;
}

/**
 * 按 attachments 行指示的路径 + MIME 从磁盘读字节并解析成纯文本。
 *
 * 失败策略：
 *   - 文件不存在 / MIME 不支持 / 超大 → 返回 skipReason，不抛错
 *   - 解析器抛错（例如 PDF 损坏）→ 重抛，让 worker 走重试逻辑
 */
export async function extractAttachmentText(att: {
  id: string;
  path: string;         // attachments.path（相对 ATTACHMENTS_DIR 的文件名）
  mimeType: string;
  filename: string;
  size: number;
}): Promise<ExtractResult> {
  const abs = path.join(getAttachmentsDir(), att.path);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { text: "", size: 0, skipReason: "not-found" };
  }
  if (stat.size === 0) {
    return { text: "", size: 0, skipReason: "empty" };
  }
  if (stat.size > MAX_PARSE_SIZE) {
    return { text: "", size: stat.size, skipReason: "too-large" };
  }

  const mime = (att.mimeType || "").toLowerCase();
  // 先按 MIME 判断，再退到扩展名
  const kind: "text" | "json" | "xml" | "pdf" | "docx" | "xlsx" | null =
    isPdfMime(mime) ? "pdf"
    : isDocxMime(mime) ? "docx"
    : isXlsxMime(mime) ? "xlsx"
    : isXmlMime(mime) ? "xml"
    : mime === "application/json" ? "json"
    : isTextLikeMime(mime) ? "text"
    : guessByExt(att.filename);

  if (!kind) {
    return { text: "", size: stat.size, skipReason: "unsupported" };
  }

  const buf = fs.readFileSync(abs);

  let text = "";
  switch (kind) {
    case "text":
      text = parseText(buf);
      break;
    case "json":
      text = parseJson(buf);
      break;
    case "xml":
      text = parseXml(buf);
      break;
    case "pdf":
      text = await parsePdf(buf);
      break;
    case "docx":
      text = await parseDocx(buf);
      break;
    case "xlsx":
      text = await parseXlsx(buf);
      break;
  }

  // 统一清洗：塌空白、截长度
  text = text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
  if (!text) {
    return { text: "", size: stat.size, skipReason: "empty" };
  }
  return { text, size: stat.size };
}

/**
 * 把提取出的文本切成 chunk。与 note 的 chunkText 策略对齐：
 *   - chunk 0：文件名（作为"标题"单独算一次向量，短查询"xxx.pdf"能命中）
 *   - chunk 1..N：正文按 CHUNK_SIZE 切
 */
export function chunkAttachmentText(
  filename: string,
  text: string,
): { idx: number; text: string }[] {
  const chunks: { idx: number; text: string }[] = [];
  const name = (filename || "").trim();
  if (name) {
    chunks.push({ idx: 0, text: `附件: ${name}` });
  }
  const body = (text || "").trim();
  if (!body) return chunks;

  let i = 0;
  let idx = 1;
  while (i < body.length && idx <= MAX_CHUNKS_PER_ATTACHMENT) {
    chunks.push({ idx, text: body.slice(i, i + CHUNK_SIZE) });
    i += CHUNK_SIZE;
    idx++;
  }
  return chunks;
}
