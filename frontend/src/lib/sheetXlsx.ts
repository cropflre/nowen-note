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

function firstWorksheetPath(zip: JSZip, workbookXml: string, relsXml: string): string | null {
  const sheetTag = workbookXml.match(/<sheet\b[^>]*>/i)?.[0] || "";
  const relId = attribute(sheetTag, "r:id");
  if (relId) {
    const relPattern = /<Relationship\b[^>]*\/?\s*>/gi;
    let relation: RegExpExecArray | null;
    while ((relation = relPattern.exec(relsXml))) {
      if (attribute(relation[0], "Id") !== relId) continue;
      const target = attribute(relation[0], "Target");
      if (target) return normalizeZipPath("xl/workbook.xml", target);
    }
  }
  const fallback = Object.keys(zip.files)
    .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(path))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
  return fallback || null;
}

async function sharedStrings(zip: JSZip): Promise<string[]> {
  const source = await zip.file("xl/sharedStrings.xml")?.async("string");
  if (!source) return [];
  const strings: string[] = [];
  const pattern = /<si\b[^>]*>([\s\S]*?)<\/si>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) strings.push(textRuns(match[1]));
  return strings;
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

export async function parseSheetXlsx(input: File | Blob | ArrayBuffer | Uint8Array): Promise<SheetDataModel> {
  const zip = await JSZip.loadAsync(input as any);
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  if (!workbookXml) throw new Error("XLSX 缺少 workbook.xml");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string") || "";
  const sheetPath = firstWorksheetPath(zip, workbookXml, relsXml);
  if (!sheetPath) throw new Error("XLSX 中未找到工作表");
  const worksheetXml = await zip.file(sheetPath)?.async("string");
  if (!worksheetXml) throw new Error("XLSX 工作表内容不存在");

  const strings = await sharedStrings(zip);
  const matrix: string[][] = [];
  const cellPattern = /<c\b([^>]*)>([\s\S]*?)<\/c>/gi;
  let cell: RegExpExecArray | null;
  while ((cell = cellPattern.exec(worksheetXml))) {
    const attrs = cell[1];
    const body = cell[2];
    const ref = attribute(attrs, "r");
    const rowIndex = rowIndexFromRef(ref);
    const columnIndex = columnIndexFromRef(ref);
    if (rowIndex < 0 || rowIndex > MAX_ROWS || columnIndex < 0 || columnIndex >= MAX_COLUMNS) continue;

    const type = attribute(attrs, "t");
    const rawValue = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] || "";
    let value = "";
    if (type === "s") {
      const index = Number.parseInt(decodeXml(rawValue), 10);
      value = Number.isFinite(index) ? strings[index] || "" : "";
    } else if (type === "inlineStr") {
      value = textRuns(body);
    } else if (type === "b") {
      value = decodeXml(rawValue) === "1" ? "TRUE" : "FALSE";
    } else {
      value = decodeXml(rawValue);
    }

    while (matrix.length <= rowIndex) matrix.push([]);
    while (matrix[rowIndex].length <= columnIndex) matrix[rowIndex].push("");
    matrix[rowIndex][columnIndex] = value.slice(0, 20_000);
  }

  return matrixToSheet(matrix);
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
