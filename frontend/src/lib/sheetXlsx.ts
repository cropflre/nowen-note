import JSZip from "jszip";

import {
  normalizeSheetData,
  sheetCellKey,
  type SheetCellType,
  type SheetDataModel,
  type SheetTextAlign,
} from "@/lib/sheetModel";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_ROWS = 1000;
const MAX_COLUMNS = 200;
export const XLSX_PREVIEW_LIMITS = { fileBytes: 20 * 1024 * 1024, xmlBytes: 64 * 1024 * 1024, sheets: 20, rows: MAX_ROWS, columns: MAX_COLUMNS, cells: 200_000 };

export class XlsxError extends Error {
  constructor(public code: "limit" | "invalid", message: string) { super(message); }
}

export interface WorkbookPreviewModel {
  sheets: Array<{ name: string; data: SheetDataModel }>;
}

type XlsxInput = File | Blob | ArrayBuffer | Uint8Array;
type ReadXml = (path: string) => Promise<string>;

// JSZip exposes streaming at runtime, but its object typings omit internalStream.
interface XmlStream {
  on(event: "data", callback: (chunk: Uint8Array) => void): XmlStream;
  on(event: "error", callback: (error: Error) => void): XmlStream;
  on(event: "end", callback: () => void): XmlStream;
  pause(): void;
  resume(): void;
}

function boundedXmlReader(zip: JSZip): ReadXml {
  let expandedBytes = 0;
  return async (path) => {
    const file = zip.file(path);
    if (!file) return "";
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      const stream = (file as JSZip.JSZipObject & { internalStream(type: "uint8array"): XmlStream }).internalStream("uint8array");
      const chunks: Uint8Array[] = [];
      let length = 0;
      let stopped = false;
      stream.on("data", (chunk) => {
        if (stopped) return;
        expandedBytes += chunk.length;
        if (expandedBytes > XLSX_PREVIEW_LIMITS.xmlBytes) {
          stopped = true;
          stream.pause();
          reject(new XlsxError("limit", "XLSX XML size limit exceeded"));
          return;
        }
        length += chunk.length;
        chunks.push(chunk);
      });
      stream.on("error", reject);
      stream.on("end", () => {
        if (stopped) return;
        const result = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
        resolve(result);
      });
      stream.resume();
    });
    const source = new TextDecoder().decode(bytes);
    if (/<!DOCTYPE/i.test(source)) throw new XlsxError("invalid", "Workbook XML cannot contain a document type");
    const document = new DOMParser().parseFromString(source, "application/xml");
    if (document.getElementsByTagName("parsererror").length) {
      throw new XlsxError("invalid", "Invalid workbook XML");
    }
    // OOXML may use namespace prefixes; the existing cell reader operates on local tag names.
    return source.replace(/(<\/?)[\w.-]+:/g, "$1");
  };
}

function escapeXml(value: string): string {
  return (value || "")
    .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXml(value: string): string {
  return (value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
}

function attribute(source: string, name: string): string {
  const match = source.match(new RegExp(`(?:^|\\s)${regexEscape(name)}=["']([^"']*)["']`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function textRuns(source: string): string {
  let text = "";
  const pattern = /<t\b[^>]*>([\s\S]*?)<\/t>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) text += decodeXml(match[1]);
  return text;
}

function columnIndexFromRef(ref: string): number {
  const letters = (ref.match(/[A-Za-z]+/)?.[0] || "").toUpperCase();
  let value = 0;
  for (const char of letters) value = value * 26 + char.charCodeAt(0) - 64;
  return value - 1;
}

function rowIndexFromRef(ref: string): number {
  const value = Number.parseInt(ref.match(/\d+/)?.[0] || "0", 10);
  return value - 1;
}

function columnRef(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function normalizeZipPath(basePart: string, target: string): string {
  if (target.startsWith("/")) return target.replace(/^\/+/, "");
  const base = basePart.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") base.pop();
    else base.push(segment);
  }
  return base.join("/");
}

function worksheetParts(workbookXml: string, relsXml: string): Array<{ name: string; path: string }> {
  const relations = new Map<string, string>();
  for (const relation of relsXml.matchAll(/<Relationship\b[^>]*>/gi)) {
    if (attribute(relation[0], "TargetMode").toLowerCase() === "external") continue;
    if (!attribute(relation[0], "Type").endsWith("/worksheet")) continue;
    const target = attribute(relation[0], "Target");
    if (target) relations.set(attribute(relation[0], "Id"), normalizeZipPath("xl/workbook.xml", target));
  }
  return Array.from(workbookXml.matchAll(/<sheet\b[^>]*>/gi), (sheet) => {
    const path = relations.get(attribute(sheet[0], "r:id"));
    if (!path) throw new XlsxError("invalid", "Worksheet relationship missing");
    return { name: attribute(sheet[0], "name") || "Sheet", path };
  });
}

async function sharedStrings(readXml: ReadXml): Promise<string[]> {
  const source = await readXml("xl/sharedStrings.xml");
  const strings: string[] = [];
  const pattern = /<si\b[^>]*>([\s\S]*?)<\/si>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) strings.push(textRuns(match[1]));
  return strings;
}

const BUILTIN_DATE_FORMAT_IDS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22,
  27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

function looksLikeDateFormat(formatCode: string): boolean {
  const normalized = formatCode
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[(?!h+\]|m+\]|s+\])[^\]]*\]/gi, "")
    .toLowerCase();
  return /(^|[^a-z])[ymdhis]/i.test(normalized);
}

async function dateStyleIndexes(readXml: ReadXml): Promise<Set<number>> {
  const source = await readXml("xl/styles.xml");
  if (!source) return new Set();

  const customDateIds = new Set<number>();
  const numFmtPattern = /<numFmt\b([^>]*)\/?\s*>/gi;
  let numFmt: RegExpExecArray | null;
  while ((numFmt = numFmtPattern.exec(source))) {
    const id = Number.parseInt(attribute(numFmt[1], "numFmtId"), 10);
    const code = attribute(numFmt[1], "formatCode");
    if (Number.isFinite(id) && looksLikeDateFormat(code)) customDateIds.add(id);
  }

  const cellXfs = source.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/i)?.[1] || "";
  const styles = new Set<number>();
  const xfPattern = /<xf\b([^>]*)\/?\s*>/gi;
  let xf: RegExpExecArray | null;
  let styleIndex = 0;
  while ((xf = xfPattern.exec(cellXfs))) {
    const numFmtId = Number.parseInt(attribute(xf[1], "numFmtId"), 10);
    if (BUILTIN_DATE_FORMAT_IDS.has(numFmtId) || customDateIds.has(numFmtId)) {
      styles.add(styleIndex);
    }
    styleIndex += 1;
  }
  return styles;
}

function workbookUses1904Dates(workbookXml: string): boolean {
  const workbookPr = workbookXml.match(/<workbookPr\b[^>]*>/i)?.[0] || "";
  const value = attribute(workbookPr, "date1904").toLowerCase();
  return value === "1" || value === "true";
}

function excelSerialToIsoDate(raw: string, use1904Dates: boolean): string | null {
  const serial = Number(raw);
  if (!Number.isFinite(serial)) return null;
  const wholeDays = Math.floor(serial);
  let timestamp: number;
  if (use1904Dates) {
    timestamp = Date.UTC(1904, 0, 1) + wholeDays * 86_400_000;
  } else {
    const adjustedDays = wholeDays >= 60 ? wholeDays - 1 : wholeDays;
    timestamp = Date.UTC(1899, 11, 31) + adjustedDays * 86_400_000;
  }
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function inferType(values: string[]): SheetCellType {
  const nonEmpty = values.map((value) => value.trim()).filter(Boolean);
  if (nonEmpty.length === 0) return "text";
  if (nonEmpty.every((value) => Number.isFinite(Number(value)))) return "number";
  if (nonEmpty.every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)))) {
    return "date";
  }
  return "text";
}

function matrixToSheet(matrix: string[][]): SheetDataModel {
  const header = (matrix[0] || ["A"]).slice(0, MAX_COLUMNS);
  const body = matrix.slice(1, MAX_ROWS + 1);
  const width = Math.max(1, header.length, ...body.map((row) => Math.min(MAX_COLUMNS, row.length)));
  const columns = Array.from({ length: width }, (_, index) => {
    const values = body.map((row) => row[index] || "");
    const type = inferType(values);
    return {
      id: `c${index + 1}`,
      title: (header[index] || columnRef(index)).slice(0, 120),
      width: 120,
      type,
      align: (type === "number" ? "right" : "left") as SheetTextAlign,
    };
  });
  const rows = (body.length > 0 ? body : [[]]).map((_, index) => ({
    id: `r${index + 1}`,
    height: 32,
  }));
  const cells: Record<string, string> = {};
  body.forEach((sourceRow, rowIndex) => {
    columns.forEach((column, columnIndex) => {
      const value = sourceRow[columnIndex] || "";
      if (value !== "") cells[sheetCellKey(rows[rowIndex].id, column.id)] = value.slice(0, 20_000);
    });
  });
  return normalizeSheetData({ version: 1, rows, columns, cells });
}

function worksheetMatrix(worksheetXml: string, strings: string[], dateStyles: Set<number>, use1904Dates: boolean, maxRows: number): string[][] {
  const dimension = worksheetXml.match(/<dimension\b[^>]*>/i)?.[0];
  const lastRef = dimension ? attribute(dimension, "ref").split(":").pop() || "" : "";
  if (lastRef && (rowIndexFromRef(lastRef) >= maxRows || columnIndexFromRef(lastRef) >= MAX_COLUMNS)) {
    throw new XlsxError("limit", "Worksheet dimensions exceed preview limits");
  }
  const matrix: string[][] = [];
  const cellPattern = /<c\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/c>)/gi;
  let cell: RegExpExecArray | null;
  while ((cell = cellPattern.exec(worksheetXml))) {
    const attrs = cell[1];
    const body = cell[2] || "";
    const ref = attribute(attrs, "r");
    const rowIndex = rowIndexFromRef(ref);
    const columnIndex = columnIndexFromRef(ref);
    if (rowIndex < 0 || columnIndex < 0) throw new XlsxError("invalid", "Invalid cell reference");
    if (rowIndex >= maxRows || columnIndex >= MAX_COLUMNS) throw new XlsxError("limit", "Worksheet row or column limit exceeded");

    const type = attribute(attrs, "t");
    const styleIndex = Number.parseInt(attribute(attrs, "s"), 10);
    const rawValue = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] || "";
    let value = "";
    if (type === "s") {
      const index = Number.parseInt(decodeXml(rawValue), 10);
      if (!Number.isInteger(index) || index < 0 || index >= strings.length) throw new XlsxError("invalid", "Invalid shared string index");
      value = strings[index];
    } else if (type === "inlineStr") {
      value = textRuns(body);
    } else if (type === "b") {
      value = rawValue ? (decodeXml(rawValue) === "1" ? "TRUE" : "FALSE") : "";
    } else if (type === "d") {
      value = decodeXml(rawValue).slice(0, 10);
    } else {
      const decoded = decodeXml(rawValue);
      value = decoded !== "" && Number.isFinite(styleIndex) && dateStyles.has(styleIndex)
        ? excelSerialToIsoDate(decoded, use1904Dates) || decoded
        : decoded;
    }

    while (matrix.length <= rowIndex) matrix.push([]);
    while (matrix[rowIndex].length <= columnIndex) matrix[rowIndex].push("");
    if (value.length > 20_000) throw new XlsxError("limit", "Cell text limit exceeded");
    matrix[rowIndex][columnIndex] = value;
  }

  return matrix;
}

function matrixToPreview(matrix: string[][]): SheetDataModel {
  const width = Math.max(1, ...matrix.map((row) => row.length));
  const columns = Array.from({ length: width }, (_, index) => ({
    id: `c${index + 1}`, title: columnRef(index), width: 120,
    type: inferType(matrix.map((row) => row[index] || "")),
    align: "left" as SheetTextAlign,
  }));
  const rows = matrix.map((_, index) => ({ id: `r${index + 1}`, height: 32 }));
  const cells: Record<string, string> = {};
  matrix.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    if (value) cells[sheetCellKey(rows[rowIndex].id, columns[columnIndex].id)] = value;
  }));
  return { version: 1, rows, columns, cells };
}

export function workbookSheetToImport(data: SheetDataModel): SheetDataModel {
  return matrixToSheet(data.rows.map((row) => data.columns.map((column) => data.cells[sheetCellKey(row.id, column.id)] || "")));
}

async function readWorkbook(input: XlsxInput, firstOnly = false): Promise<WorkbookPreviewModel> {
  const size = input instanceof ArrayBuffer || input instanceof Uint8Array ? input.byteLength : input.size;
  if (size > XLSX_PREVIEW_LIMITS.fileBytes) throw new XlsxError("limit", "XLSX file size limit exceeded");
  try {
    const zip = await JSZip.loadAsync(input as any);
    // Reject declared expansion before inflating; the streaming reader also checks actual bytes.
    const declaredXmlBytes = Object.values(zip.files).reduce((sum, file) => {
      const metadata = file as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } };
      return sum + (/\.(xml|rels)$/i.test(file.name) ? (metadata._data?.uncompressedSize || 0) : 0);
    }, 0);
    if (declaredXmlBytes > XLSX_PREVIEW_LIMITS.xmlBytes) throw new XlsxError("limit", "XLSX XML size limit exceeded");
    const readXml = boundedXmlReader(zip);
    const workbookXml = await readXml("xl/workbook.xml");
    if (!workbookXml || !/<workbook\b/i.test(workbookXml)) throw new XlsxError("invalid", "Workbook missing");
    const parts = worksheetParts(workbookXml, await readXml("xl/_rels/workbook.xml.rels"));
    if (!parts.length) throw new XlsxError("invalid", "No worksheets found");
    if (parts.length > XLSX_PREVIEW_LIMITS.sheets) throw new XlsxError("limit", "Worksheet count limit exceeded");
    const strings = await sharedStrings(readXml);
    const dateStyles = await dateStyleIndexes(readXml);
    const sheets: WorkbookPreviewModel["sheets"] = [];
    let totalCells = 0;
    for (const part of firstOnly ? parts.slice(0, 1) : parts) {
      const source = await readXml(part.path);
      if (!source || !/<worksheet\b/i.test(source)) throw new XlsxError("invalid", "Worksheet missing");
      const matrix = worksheetMatrix(source, strings, dateStyles, workbookUses1904Dates(workbookXml), firstOnly ? MAX_ROWS + 1 : MAX_ROWS);
      const data = matrixToPreview(matrix);
      totalCells += data.rows.length * data.columns.length;
      if (totalCells > XLSX_PREVIEW_LIMITS.cells + (firstOnly ? MAX_COLUMNS : 0)) throw new XlsxError("limit", "Workbook cell limit exceeded");
      sheets.push({ name: part.name, data });
    }
    return { sheets };
  } catch (error) {
    if (error instanceof XlsxError) throw error;
    throw new XlsxError("invalid", "Invalid or encrypted XLSX workbook");
  }
}

export async function parseWorkbookXlsx(input: XlsxInput): Promise<WorkbookPreviewModel> {
  return readWorkbook(input);
}

export async function parseSheetXlsx(input: XlsxInput): Promise<SheetDataModel> {
  const workbook = await readWorkbook(input, true);
  return workbookSheetToImport(workbook.sheets[0].data);
}

function safeSheetName(value: string): string {
  const normalized = (value || "Sheet1").replace(/[\\/:*?\[\]]/g, " ").trim();
  return (normalized || "Sheet1").slice(0, 31);
}

function styleForAlignment(align: SheetTextAlign): number {
  if (align === "center") return 2;
  if (align === "right") return 3;
  return 1;
}

function cellXml(ref: string, value: string, style: number, numeric: boolean): string {
  if (numeric && value.trim() !== "" && Number.isFinite(Number(value))) {
    return `<c r="${ref}" s="${style}"><v>${escapeXml(value)}</v></c>`;
  }
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

export async function createSheetXlsx(
  data: SheetDataModel,
  title = "Sheet1",
): Promise<ArrayBuffer> {
  const normalized = normalizeSheetData(data);
  const zip = new JSZip();
  const sheetName = safeSheetName(title);

  const columnXml = normalized.columns.map((column, index) => {
    const width = Math.max(8, Math.min(60, Math.round((column.width / 7) * 100) / 100));
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
  }).join("");

  const headerCells = normalized.columns.map((column, columnIndex) =>
    cellXml(`${columnRef(columnIndex)}1`, column.title, 4, false)
  ).join("");

  const bodyRows = normalized.rows.map((row, rowIndex) => {
    const cells = normalized.columns.map((column, columnIndex) => {
      const value = normalized.cells[sheetCellKey(row.id, column.id)] || "";
      if (value === "") return "";
      return cellXml(
        `${columnRef(columnIndex)}${rowIndex + 2}`,
        value,
        styleForAlignment(column.align),
        column.type === "number",
      );
    }).join("");
    const height = Math.max(18, Math.round(row.height * 0.75 * 10) / 10);
    return `<row r="${rowIndex + 2}" ht="${height}" customHeight="1">${cells}</row>`;
  }).join("");

  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`);

  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);

  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <bookViews><workbookView/></bookViews>
  <sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`);

  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);

  zip.file("xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/><family val="2"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>
  </fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="5">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right"/></xf>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`);

  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>${columnXml}</cols>
  <sheetData>
    <row r="1" ht="22" customHeight="1">${headerCells}</row>
    ${bodyRows}
  </sheetData>
</worksheet>`);

  return zip.generateAsync({
    type: "arraybuffer",
    mimeType: XLSX_MIME,
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

export { XLSX_MIME };
