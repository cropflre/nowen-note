/**
 * Excel 工作簿（Univer 快照）与 XLSX / CSV 之间的转换。
 *
 * 功能来源：cropflre/nowen-note PR #802（excelExchange.ts）。PR 使用的 xlsx@0.18.5 有已公开的
 * 安全问题，这里改为复用仓库现有的 JSZip 读取器（sheetXlsx.ts：解压体积上限、拒绝 DOCTYPE），
 * 不引入新的表格解析依赖。本模块只在导入 / 导出时按需加载。
 *
 * 保真范围：多工作表、数值 / 文本 / 布尔、公式（含共享公式展开）、合并区域、数字格式、列宽行高。
 * 其它内容（字体颜色边框、图表、图片、批注、条件格式、数据验证、宏等）不会导入，
 * 导入前以 warnings 列出，由界面让用户确认，绝不静默丢弃。
 */
import JSZip from "jszip";

import { parseCsvRows } from "@/lib/sheetModel";
import {
  BUILTIN_DATE_FORMAT_IDS,
  XLSX_MIME,
  XLSX_PREVIEW_LIMITS,
  XlsxError,
  attribute,
  boundedXmlReader,
  columnIndexFromRef,
  columnRef,
  decodeXml,
  escapeXml,
  excelSerialToIsoDate,
  looksLikeDateFormat,
  rowIndexFromRef,
  sharedStrings,
  workbookUses1904Dates,
  worksheetParts,
  type ReadXml,
} from "@/lib/sheetXlsx";

export { XLSX_MIME };

/** 与后端 EXCEL_MAX_DATA_BYTES、MAX_SHEETS 对应；超出时拒绝导入而不是截断。 */
export const EXCEL_FILE_LIMITS = {
  fileBytes: XLSX_PREVIEW_LIMITS.fileBytes,
  sheets: 50,
  rows: 20_000,
  columns: 1_000,
  cells: 300_000,
  snapshotBytes: 10 * 1024 * 1024,
};

const CELL_STRING = 1;
const CELL_NUMBER = 2;
const CELL_BOOLEAN = 3;
const EXCEL_1904_OFFSET = 1462;
const MAX_EXCEL_COLUMN = 16_384;

export interface ExcelCell { v?: string | number; t?: number; f?: string; s?: string }
export interface ExcelMerge { startRow: number; endRow: number; startColumn: number; endColumn: number }
export interface ExcelSheet {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  hidden?: 0 | 1;
  cellData: Record<string, Record<string, ExcelCell>>;
  mergeData: ExcelMerge[];
  columnData?: Record<string, { w?: number }>;
  rowData?: Record<string, { h?: number }>;
}
export interface ExcelWorkbook {
  id: string;
  name: string;
  locale?: string;
  styles: Record<string, { n?: { pattern: string } } & Record<string, unknown>>;
  sheetOrder: string[];
  sheets: Record<string, ExcelSheet>;
}
export interface ExcelImportResult { workbook: ExcelWorkbook; warnings: string[] }

export class ExcelFileError extends Error {
  constructor(public code: "limit" | "invalid" | "unsupported", message: string) { super(message); }
}

const BUILTIN_NUMBER_FORMATS: Record<number, string> = {
  1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00",
  14: "yyyy-mm-dd", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM",
  20: "h:mm", 21: "h:mm:ss", 22: "yyyy-mm-dd h:mm", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mm:ss.0", 49: "@",
};

const UNAMBIGUOUS_BUILTIN_FORMATS = new Set([1, 2, 3, 4, 9, 10, 11, 49]);

function limitError(message: string): ExcelFileError {
  return new ExcelFileError("limit", message);
}

function sheetId(index: number): string {
  return `sheet-${String(index + 1).padStart(2, "0")}`;
}

function setCell(sheet: ExcelSheet, row: number, column: number, cell: ExcelCell): void {
  const rowKey = String(row);
  sheet.cellData[rowKey] = sheet.cellData[rowKey] || {};
  sheet.cellData[rowKey][String(column)] = cell;
}

// ---------------------------------------------------------------------------
// 公式引用平移（共享公式展开）
// ---------------------------------------------------------------------------

function columnNumber(letters: string): number {
  let value = 0;
  for (const char of letters.toUpperCase()) value = value * 26 + char.charCodeAt(0) - 64;
  return value;
}

function columnLetters(number: number): string {
  return columnRef(number - 1);
}

/**
 * 按行列偏移平移公式中的相对引用（$ 锁定的部分不动），用于把共享公式展开到每个单元格。
 * 跳过字符串字面量与带引号的工作表名，函数名（后跟括号）不当作引用。
 */
export function shiftFormulaReferences(formula: string, rowOffset: number, columnOffset: number): string {
  if (rowOffset === 0 && columnOffset === 0) return formula;
  let result = "";
  let index = 0;
  const isWordChar = (char: string | undefined) => !!char && /[A-Za-z0-9_.]/.test(char);
  while (index < formula.length) {
    const char = formula[index];
    if (char === "\"" || char === "'") {
      let end = index + 1;
      while (end < formula.length) {
        if (formula[end] === char) {
          if (formula[end + 1] === char) { end += 2; continue; }
          break;
        }
        end += 1;
      }
      result += formula.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === "[") {
      const end = formula.indexOf("]", index);
      const stop = end < 0 ? formula.length : end + 1;
      result += formula.slice(index, stop);
      index = stop;
      continue;
    }
    if (!isWordChar(formula[index - 1]) && /[$A-Za-z0-9]/.test(char)) {
      const rest = formula.slice(index);
      const cell = rest.match(/^(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(.])/);
      if (cell && columnNumber(cell[2]) <= MAX_EXCEL_COLUMN) {
        const column = cell[1] ? columnNumber(cell[2]) : columnNumber(cell[2]) + columnOffset;
        const row = cell[3] ? Number(cell[4]) : Number(cell[4]) + rowOffset;
        if (column < 1 || row < 1) throw new ExcelFileError("invalid", "共享公式平移后超出工作表范围");
        result += `${cell[1]}${columnLetters(column)}${cell[3]}${row}`;
        index += cell[0].length;
        continue;
      }
      const columns = rest.match(/^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_(])/);
      if (columns) {
        const shift = (locked: string, letters: string) => locked ? letters : columnLetters(columnNumber(letters) + columnOffset);
        result += `${columns[1]}${shift(columns[1], columns[2])}:${columns[3]}${shift(columns[3], columns[4])}`;
        index += columns[0].length;
        continue;
      }
      const rows = rest.match(/^(\$?)(\d+):(\$?)(\d+)(?![A-Za-z0-9_(.])/);
      if (rows) {
        const shift = (locked: string, value: string) => locked ? value : String(Number(value) + rowOffset);
        result += `${rows[1]}${shift(rows[1], rows[2])}:${rows[3]}${shift(rows[3], rows[4])}`;
        index += rows[0].length;
        continue;
      }
      const word = rest.match(/^[A-Za-z0-9_.$]+/);
      if (word) {
        result += word[0];
        index += word[0].length;
        continue;
      }
    }
    result += char;
    index += 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// XLSX → 工作簿
// ---------------------------------------------------------------------------

interface StyleInfo { pattern: string | null; isDate: boolean; decorated: boolean }

async function readStyles(readXml: ReadXml): Promise<StyleInfo[]> {
  const source = await readXml("xl/styles.xml");
  if (!source) return [];
  const custom = new Map<number, string>();
  for (const match of source.matchAll(/<numFmt\b([^>]*)\/?\s*>/gi)) {
    const id = Number.parseInt(attribute(match[1], "numFmtId"), 10);
    if (Number.isFinite(id)) custom.set(id, attribute(match[1], "formatCode"));
  }
  const cellXfs = source.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/i)?.[1] || "";
  const styles: StyleInfo[] = [];
  for (const xf of cellXfs.matchAll(/<xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/gi)) {
    const id = Number.parseInt(attribute(xf[1], "numFmtId"), 10) || 0;
    const pattern = custom.get(id) ?? BUILTIN_NUMBER_FORMATS[id] ?? null;
    const isDate = BUILTIN_DATE_FORMAT_IDS.has(id) || (custom.has(id) && looksLikeDateFormat(custom.get(id)!));
    const decorated = ["fontId", "fillId", "borderId"].some((name) => (Number.parseInt(attribute(xf[1], name), 10) || 0) !== 0)
      || /<alignment\b/i.test(xf[2] || "");
    styles.push({ pattern: pattern && pattern !== "General" ? pattern : null, isDate, decorated });
  }
  return styles;
}

function featureWarnings(zip: JSZip, workbookXml: string): string[] {
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
  const warnings: string[] = [];
  const has = (pattern: RegExp) => names.some((name) => pattern.test(name));
  if (has(/^xl\/charts\//i)) warnings.push("图表");
  // 批注会附带 VML 绘图（xl/drawings/*.vml），不算图片。
  if (has(/^xl\/media\//i) || has(/^xl\/drawings\/(?!.*\.vml$)/i)) warnings.push("图片与绘图对象");
  if (has(/^xl\/pivot(Tables|Cache)\//i)) warnings.push("数据透视表");
  if (has(/^xl\/(comments\d*|threadedComments\/)/i)) warnings.push("批注");
  if (has(/^xl\/vbaProject\.bin$/i)) warnings.push("宏（VBA）");
  if (has(/^xl\/externalLinks\//i)) warnings.push("外部链接");
  if (/<definedName\b/i.test(workbookXml)) warnings.push("名称管理器中的定义名称");
  return warnings;
}

/** XLSX 文件 → 工作簿快照。超限或无法解析时抛出 ExcelFileError，不返回残缺结果。 */
export async function readXlsxWorkbook(input: Blob | ArrayBuffer | Uint8Array, title: string): Promise<ExcelImportResult> {
  const size = input instanceof ArrayBuffer || input instanceof Uint8Array ? input.byteLength : input.size;
  if (size > EXCEL_FILE_LIMITS.fileBytes) throw limitError(`文件超过 ${EXCEL_FILE_LIMITS.fileBytes / 1024 / 1024} MB 上限`);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(input);
  } catch {
    throw new ExcelFileError("unsupported", "不是有效的 .xlsx 文件（不支持 .xls、加密或损坏的工作簿）");
  }
  try {
    const declared = Object.values(zip.files).reduce((sum, file) => {
      const meta = file as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } };
      return sum + (/\.(xml|rels)$/i.test(file.name) ? (meta._data?.uncompressedSize || 0) : 0);
    }, 0);
    if (declared > XLSX_PREVIEW_LIMITS.xmlBytes) throw limitError("工作簿解压后体积超过上限");
    const readXml = boundedXmlReader(zip);
    const workbookXml = await readXml("xl/workbook.xml");
    if (!workbookXml || !/<workbook\b/i.test(workbookXml)) throw new ExcelFileError("invalid", "缺少 workbook.xml");
    const parts = worksheetParts(workbookXml, await readXml("xl/_rels/workbook.xml.rels"));
    if (!parts.length) throw new ExcelFileError("invalid", "工作簿中没有工作表");
    if (parts.length > EXCEL_FILE_LIMITS.sheets) throw limitError(`工作表数量超过 ${EXCEL_FILE_LIMITS.sheets} 个`);
    const hiddenStates = Array.from(workbookXml.matchAll(/<sheet\b[^>]*>/gi), (match) => attribute(match[0], "state"));
    const strings = await sharedStrings(readXml);
    const styleInfo = await readStyles(readXml);
    const use1904 = workbookUses1904Dates(workbookXml);
    const warnings = new Set(featureWarnings(zip, workbookXml));
    const styles: ExcelWorkbook["styles"] = {};
    const patternStyle = new Map<string, string>();
    const styleIdFor = (pattern: string) => {
      let id = patternStyle.get(pattern);
      if (!id) {
        id = `numfmt-${patternStyle.size + 1}`;
        patternStyle.set(pattern, id);
        styles[id] = { n: { pattern } };
      }
      return id;
    };

    const workbook: ExcelWorkbook = { id: "workbook-01", name: title, locale: "zhCN", styles, sheetOrder: [], sheets: {} };
    let totalCells = 0;
    const usedNames = new Set<string>();
    for (const [index, part] of parts.entries()) {
      const xml = await readXml(part.path);
      if (!xml || !/<worksheet\b/i.test(xml)) {
        // 图表页（chartsheet）等非数据表无法承载，明确提示。
        warnings.add(`非数据工作表「${part.name}」`);
        continue;
      }
      const id = sheetId(workbook.sheetOrder.length);
      let name = part.name.slice(0, 31) || `Sheet${index + 1}`;
      while (usedNames.has(name)) name = `${name.slice(0, 28)}_${usedNames.size}`;
      usedNames.add(name);
      const sheet: ExcelSheet = { id, name, rowCount: 1, columnCount: 1, cellData: {}, mergeData: [] };
      if (hiddenStates[index] === "hidden" || hiddenStates[index] === "veryHidden") sheet.hidden = 1;

      const dimension = xml.match(/<dimension\b[^>]*>/i)?.[0];
      const lastRef = dimension ? attribute(dimension, "ref").split(":").pop() || "" : "";
      if (lastRef && (rowIndexFromRef(lastRef) >= EXCEL_FILE_LIMITS.rows || columnIndexFromRef(lastRef) >= EXCEL_FILE_LIMITS.columns)) {
        throw limitError(`工作表「${name}」超过 ${EXCEL_FILE_LIMITS.rows} 行或 ${EXCEL_FILE_LIMITS.columns} 列`);
      }
      if (/<conditionalFormatting\b/i.test(xml)) warnings.add("条件格式");
      if (/<dataValidations?\b/i.test(xml)) warnings.add("数据验证");
      if (/<hyperlinks?\b/i.test(xml)) warnings.add("超链接");
      if (/<sheetProtection\b/i.test(xml)) warnings.add("工作表保护");

      const sharedFormulas = new Map<string, { formula: string; row: number; column: number }>();
      let maxRow = 0;
      let maxColumn = 0;
      const cellPattern = /<c\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/c>)/gi;
      let match: RegExpExecArray | null;
      while ((match = cellPattern.exec(xml))) {
        const attrs = match[1];
        const body = match[2] || "";
        const ref = attribute(attrs, "r");
        const row = rowIndexFromRef(ref);
        const column = columnIndexFromRef(ref);
        if (row < 0 || column < 0) throw new ExcelFileError("invalid", "单元格引用无效");
        if (row >= EXCEL_FILE_LIMITS.rows || column >= EXCEL_FILE_LIMITS.columns) {
          throw limitError(`工作表「${name}」超过 ${EXCEL_FILE_LIMITS.rows} 行或 ${EXCEL_FILE_LIMITS.columns} 列`);
        }
        const type = attribute(attrs, "t");
        const style = styleInfo[Number.parseInt(attribute(attrs, "s"), 10) || 0];
        const rawValue = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1];
        const formulaTag = body.match(/<f\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/f>)/i);
        const cell: ExcelCell = {};

        if (formulaTag) {
          const formulaType = attribute(formulaTag[1], "t");
          let formula = decodeXml(formulaTag[2] || "");
          if (formulaType === "shared") {
            const si = attribute(formulaTag[1], "si");
            if (formula) sharedFormulas.set(si, { formula, row, column });
            else {
              const master = sharedFormulas.get(si);
              if (!master) throw new ExcelFileError("invalid", "共享公式缺少主公式");
              formula = shiftFormulaReferences(master.formula, row - master.row, column - master.column);
            }
          } else if (formulaType === "array" && formula) {
            warnings.add("数组公式（已按普通公式导入，结果可能不同）");
          } else if (formulaType === "dataTable") {
            warnings.add("模拟运算表（仅保留计算结果）");
            formula = "";
          }
          if (formula) cell.f = `=${formula}`;
        }

        if (type === "s") {
          const stringIndex = Number.parseInt(decodeXml(rawValue || ""), 10);
          if (!Number.isInteger(stringIndex) || stringIndex < 0 || stringIndex >= strings.length) {
            throw new ExcelFileError("invalid", "共享字符串索引无效");
          }
          cell.v = strings[stringIndex];
          cell.t = CELL_STRING;
        } else if (type === "inlineStr") {
          const text = body.match(/<is\b[^>]*>([\s\S]*?)<\/is>/i)?.[1] || "";
          cell.v = Array.from(text.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi), (run) => decodeXml(run[1])).join("");
          cell.t = CELL_STRING;
        } else if (type === "b") {
          if (rawValue !== undefined) { cell.v = decodeXml(rawValue) === "1" ? 1 : 0; cell.t = CELL_BOOLEAN; }
        } else if (type === "str" || type === "e") {
          if (rawValue !== undefined) { cell.v = decodeXml(rawValue); cell.t = CELL_STRING; }
        } else if (type === "d") {
          if (rawValue !== undefined) { cell.v = decodeXml(rawValue); cell.t = CELL_STRING; }
        } else if (rawValue !== undefined && rawValue !== "") {
          const number = Number(decodeXml(rawValue));
          if (!Number.isFinite(number)) throw new ExcelFileError("invalid", "数值单元格格式无效");
          cell.v = use1904 && style?.isDate ? number + EXCEL_1904_OFFSET : number;
          cell.t = CELL_NUMBER;
        }
        if (style?.pattern && (cell.t === CELL_NUMBER || cell.f)) cell.s = styleIdFor(style.pattern);
        if (style?.decorated) warnings.add("单元格样式（字体、颜色、边框、对齐）");
        if (typeof cell.v === "string" && cell.v.length > 32_767) throw limitError("单元格文本超过 32767 个字符");
        if (cell.v === undefined && !cell.f) continue;
        setCell(sheet, row, column, cell);
        totalCells += 1;
        if (totalCells > EXCEL_FILE_LIMITS.cells) throw limitError(`非空单元格超过 ${EXCEL_FILE_LIMITS.cells} 个`);
        maxRow = Math.max(maxRow, row);
        maxColumn = Math.max(maxColumn, column);
      }

      for (const merge of xml.matchAll(/<mergeCell\b[^>]*>/gi)) {
        const [start, end = start] = attribute(merge[0], "ref").split(":");
        const range = {
          startRow: rowIndexFromRef(start), endRow: rowIndexFromRef(end),
          startColumn: columnIndexFromRef(start), endColumn: columnIndexFromRef(end),
        };
        if ([range.startRow, range.endRow, range.startColumn, range.endColumn].some((value) => value < 0)
          || range.endRow >= EXCEL_FILE_LIMITS.rows || range.endColumn >= EXCEL_FILE_LIMITS.columns) {
          throw new ExcelFileError("invalid", "合并区域无效或超出范围");
        }
        sheet.mergeData.push(range);
        maxRow = Math.max(maxRow, range.endRow);
        maxColumn = Math.max(maxColumn, range.endColumn);
      }

      for (const col of xml.matchAll(/<col\b[^>]*>/gi)) {
        const width = Number(attribute(col[0], "width"));
        const min = Number(attribute(col[0], "min"));
        const max = Math.min(Number(attribute(col[0], "max")), EXCEL_FILE_LIMITS.columns);
        if (!Number.isFinite(width) || !Number.isInteger(min) || min < 1 || attribute(col[0], "customWidth") !== "1") continue;
        sheet.columnData = sheet.columnData || {};
        for (let column = min; column <= max; column += 1) sheet.columnData[String(column - 1)] = { w: Math.round(width * 7 + 5) };
      }
      for (const rowTag of xml.matchAll(/<row\b[^>]*>/gi)) {
        const height = Number(attribute(rowTag[0], "ht"));
        const rowNumber = Number(attribute(rowTag[0], "r"));
        if (!Number.isFinite(height) || !Number.isInteger(rowNumber) || attribute(rowTag[0], "customHeight") !== "1") continue;
        sheet.rowData = sheet.rowData || {};
        sheet.rowData[String(rowNumber - 1)] = { h: Math.round(height * 4 / 3) };
      }

      sheet.rowCount = Math.max(maxRow + 1 + 50, 200);
      sheet.columnCount = Math.max(maxColumn + 1 + 5, 26);
      workbook.sheets[id] = sheet;
      workbook.sheetOrder.push(id);
    }
    if (!workbook.sheetOrder.length) throw new ExcelFileError("invalid", "工作簿中没有可导入的数据工作表");
    assertSnapshotSize(workbook);
    return { workbook, warnings: [...warnings] };
  } catch (error) {
    if (error instanceof ExcelFileError) throw error;
    if (error instanceof XlsxError) {
      throw new ExcelFileError(error.code === "limit" ? "limit" : "invalid", error.code === "limit" ? "工作簿解压后体积超过上限" : "工作簿结构无效");
    }
    throw new ExcelFileError("invalid", "工作簿结构无效");
  }
}

export function assertSnapshotSize(workbook: unknown): void {
  const bytes = new TextEncoder().encode(JSON.stringify(workbook)).byteLength;
  if (bytes > EXCEL_FILE_LIMITS.snapshotBytes) {
    throw limitError(`表格数据约 ${(bytes / 1024 / 1024).toFixed(1)} MB，超过 ${EXCEL_FILE_LIMITS.snapshotBytes / 1024 / 1024} MB 上限`);
  }
}

// ---------------------------------------------------------------------------
// 工作簿 → XLSX
// ---------------------------------------------------------------------------

function orderedSheets(workbook: ExcelWorkbook): ExcelSheet[] {
  const order = Array.isArray(workbook.sheetOrder) && workbook.sheetOrder.length ? workbook.sheetOrder : Object.keys(workbook.sheets || {});
  return order.map((id) => workbook.sheets?.[id]).filter((sheet): sheet is ExcelSheet => !!sheet);
}

function sortedKeys(record: Record<string, unknown> | undefined): number[] {
  return Object.keys(record || {}).map(Number).filter((value) => Number.isInteger(value) && value >= 0).sort((a, b) => a - b);
}

function safeSheetNames(sheets: ExcelSheet[]): string[] {
  const used = new Set<string>();
  return sheets.map((sheet, index) => {
    const base = (String(sheet.name || "").replace(/[\\/:*?[\]]/g, " ").replace(/^'+|'+$/g, "").trim() || `Sheet${index + 1}`).slice(0, 31);
    let name = base;
    for (let suffix = 2; used.has(name.toLowerCase()); suffix += 1) name = `${base.slice(0, 31 - String(suffix).length - 1)}_${suffix}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** 导出会丢失的内容（Univer 中设置的字体颜色边框等样式），用于导出前提示。 */
export function xlsxExportWarnings(workbook: ExcelWorkbook): string[] {
  const styles = workbook.styles || {};
  const decorated = Object.values(styles).some((style) => style && Object.keys(style).some((key) => key !== "n"));
  return decorated ? ["单元格样式（字体、颜色、边框、对齐）"] : [];
}

/** 工作簿快照 → XLSX。公式保留并附带最近一次计算结果，Excel 打开时会重新计算。 */
export async function writeXlsxWorkbook(workbook: ExcelWorkbook): Promise<ArrayBuffer> {
  const sheets = orderedSheets(workbook);
  if (!sheets.length) throw new ExcelFileError("invalid", "工作簿中没有工作表");
  const names = safeSheetNames(sheets);
  const numFmtIds = new Map<string, number>();
  const xfForStyle = new Map<string, number>();
  const xfList: number[] = [0];
  const styleIndex = (styleId: string | undefined): number => {
    const pattern = styleId ? workbook.styles?.[styleId]?.n?.pattern : undefined;
    if (!pattern) return 0;
    let xf = xfForStyle.get(pattern);
    if (xf === undefined) {
      // 只复用含义固定的内置编号；日期等内置格式随 Excel 区域设置变化，一律写出确切的自定义格式。
      const builtin = Object.entries(BUILTIN_NUMBER_FORMATS)
        .find(([id, code]) => code === pattern && UNAMBIGUOUS_BUILTIN_FORMATS.has(Number(id)))?.[0];
      let fmtId = builtin ? Number(builtin) : numFmtIds.get(pattern);
      if (fmtId === undefined) {
        fmtId = 164 + numFmtIds.size;
        numFmtIds.set(pattern, fmtId);
      }
      xf = xfList.length;
      xfList.push(fmtId);
      xfForStyle.set(pattern, xf);
    }
    return xf;
  };

  const zip = new JSZip();
  const sheetXml = sheets.map((sheet) => {
    const rows = sortedKeys(sheet.cellData);
    const rowHeights = sheet.rowData || {};
    const allRows = Array.from(new Set([...rows, ...sortedKeys(rowHeights).filter((row) => rowHeights[String(row)]?.h)])).sort((a, b) => a - b);
    const rowXml = allRows.map((row) => {
      const columns = sheet.cellData[String(row)] || {};
      const cells = sortedKeys(columns).map((column) => {
        const cell = columns[String(column)];
        if (!cell || (cell.v === undefined && !cell.f)) return "";
        const ref = `${columnRef(column)}${row + 1}`;
        const s = styleIndex(cell.s);
        const sAttr = s ? ` s="${s}"` : "";
        const formula = cell.f ? `<f>${escapeXml(cell.f.replace(/^=/, ""))}</f>` : "";
        if (cell.t === CELL_BOOLEAN) return `<c r="${ref}" t="b"${sAttr}>${formula}<v>${Number(cell.v) ? 1 : 0}</v></c>`;
        if (typeof cell.v === "number" || (cell.t === CELL_NUMBER && cell.v !== "" && Number.isFinite(Number(cell.v)))) {
          return `<c r="${ref}"${sAttr}>${formula}<v>${Number(cell.v)}</v></c>`;
        }
        if (cell.f) return `<c r="${ref}" t="str"${sAttr}>${formula}${cell.v === undefined ? "" : `<v>${escapeXml(String(cell.v))}</v>`}</c>`;
        return `<c r="${ref}" t="inlineStr"${sAttr}><is><t xml:space="preserve">${escapeXml(String(cell.v))}</t></is></c>`;
      }).join("");
      const height = rowHeights[String(row)]?.h;
      const heightAttr = height ? ` ht="${Math.round(height * 0.75 * 100) / 100}" customHeight="1"` : "";
      return `<row r="${row + 1}"${heightAttr}>${cells}</row>`;
    }).join("");
    const widths = sheet.columnData || {};
    const colXml = sortedKeys(widths).filter((column) => widths[String(column)]?.w).map((column) => {
      const width = Math.max(1, Math.round(((widths[String(column)].w! - 5) / 7) * 100) / 100);
      return `<col min="${column + 1}" max="${column + 1}" width="${width}" customWidth="1"/>`;
    }).join("");
    const merges = (sheet.mergeData || []).map((merge) =>
      `<mergeCell ref="${columnRef(merge.startColumn)}${merge.startRow + 1}:${columnRef(merge.endColumn)}${merge.endRow + 1}"/>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${colXml ? `<cols>${colXml}</cols>` : ""}<sheetData>${rowXml}</sheetData>${merges ? `<mergeCells count="${sheet.mergeData.length}">${merges}</mergeCells>` : ""}</worksheet>`;
  });

  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${escapeXml(names[index])}" sheetId="${index + 1}"${sheet.hidden ? " state=\"hidden\"" : ""} r:id="rId${index + 1}"/>`).join("")}</sheets><calcPr fullCalcOnLoad="1"/></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  sheetXml.forEach((xml, index) => zip.file(`xl/worksheets/sheet${index + 1}.xml`, xml));
  const numFmtXml = [...numFmtIds].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${escapeXml(code)}"/>`).join("");
  zip.file("xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmtXml ? `<numFmts count="${numFmtIds.size}">${numFmtXml}</numFmts>` : ""}<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfList.length}">${xfList.map((fmt) => `<xf numFmtId="${fmt}" fontId="0" fillId="0" borderId="0" xfId="0"${fmt ? " applyNumberFormat=\"1\"" : ""}/>`).join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
  return zip.generateAsync({ type: "arraybuffer", mimeType: XLSX_MIME, compression: "DEFLATE", compressionOptions: { level: 6 } });
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** 只有写回字符串完全一致的数字才转为数值，避免 007、1.50、超长编号等丢失原样。 */
function csvValue(text: string): ExcelCell {
  const trimmed = text.trim();
  if (trimmed !== "" && trimmed === text && /^-?\d+(\.\d+)?$/.test(trimmed) && String(Number(trimmed)) === trimmed
    && Number.isSafeInteger(Math.trunc(Number(trimmed)))) {
    return { v: Number(trimmed), t: CELL_NUMBER };
  }
  // 以 = 开头的内容按文本保存，不把外部 CSV 当作公式执行。
  return { v: text, t: CELL_STRING };
}

export function readCsvWorkbook(text: string, title: string): ExcelImportResult {
  if (new TextEncoder().encode(text).byteLength > EXCEL_FILE_LIMITS.fileBytes) {
    throw limitError(`文件超过 ${EXCEL_FILE_LIMITS.fileBytes / 1024 / 1024} MB 上限`);
  }
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ""));
  if (rows.length > EXCEL_FILE_LIMITS.rows) throw limitError(`CSV 超过 ${EXCEL_FILE_LIMITS.rows} 行`);
  const sheet: ExcelSheet = { id: "sheet-01", name: "Sheet1", rowCount: 200, columnCount: 26, cellData: {}, mergeData: [] };
  let cells = 0;
  let maxColumn = 0;
  rows.forEach((row, rowIndex) => {
    if (row.length > EXCEL_FILE_LIMITS.columns) throw limitError(`CSV 超过 ${EXCEL_FILE_LIMITS.columns} 列`);
    row.forEach((value, columnIndex) => {
      if (value === "") return;
      if (value.length > 32_767) throw limitError("单元格文本超过 32767 个字符");
      setCell(sheet, rowIndex, columnIndex, csvValue(value));
      cells += 1;
      maxColumn = Math.max(maxColumn, columnIndex);
      if (cells > EXCEL_FILE_LIMITS.cells) throw limitError(`非空单元格超过 ${EXCEL_FILE_LIMITS.cells} 个`);
    });
  });
  sheet.rowCount = Math.max(rows.length + 50, 200);
  sheet.columnCount = Math.max(maxColumn + 1 + 5, 26);
  const workbook: ExcelWorkbook = { id: "workbook-01", name: title, locale: "zhCN", styles: {}, sheetOrder: ["sheet-01"], sheets: { "sheet-01": sheet } };
  assertSnapshotSize(workbook);
  return { workbook, warnings: [] };
}

function escapeCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value;
}

/** 工作表 → CSV。CSV 只能承载一张表的值：公式导出计算结果，合并区域与其它工作表在 warnings 中说明。 */
export function writeCsvSheet(workbook: ExcelWorkbook, sheetIdToExport?: string): { csv: string; warnings: string[] } {
  const sheets = orderedSheets(workbook);
  const sheet = (sheetIdToExport && workbook.sheets?.[sheetIdToExport]) || sheets[0];
  if (!sheet) throw new ExcelFileError("invalid", "工作簿中没有工作表");
  const warnings: string[] = [];
  if (sheets.length > 1) warnings.push(`只导出当前工作表「${sheet.name}」，其余 ${sheets.length - 1} 张工作表不包含在 CSV 中`);
  const rows = sortedKeys(sheet.cellData);
  let hasFormula = false;
  const lines: string[] = [];
  const lastRow = rows.length ? rows[rows.length - 1] : -1;
  for (let row = 0; row <= lastRow; row += 1) {
    const columns = sheet.cellData[String(row)] || {};
    const keys = sortedKeys(columns);
    const values: string[] = [];
    const lastColumn = keys.length ? keys[keys.length - 1] : -1;
    for (let column = 0; column <= lastColumn; column += 1) {
      const cell = columns[String(column)];
      if (cell?.f) hasFormula = true;
      const raw = cell?.v;
      // 日期单元格按用户看到的日期导出，而不是 Excel 序列号。
      const pattern = cell?.s ? workbook.styles?.[cell.s]?.n?.pattern : undefined;
      const date = typeof raw === "number" && pattern && looksLikeDateFormat(pattern) ? excelSerialToIsoDate(String(raw), false) : null;
      values.push(escapeCsv(cell?.t === CELL_BOOLEAN ? (Number(raw) ? "TRUE" : "FALSE") : date ?? (raw === undefined ? "" : String(raw))));
    }
    lines.push(values.join(","));
  }
  if (hasFormula) warnings.push("公式以计算结果导出");
  if ((sheet.mergeData || []).length) warnings.push("合并单元格不会保留");
  return { csv: lines.join("\r\n"), warnings };
}
