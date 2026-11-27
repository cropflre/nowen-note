import { knowledgeTreeApi, type KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import type { SheetDataModel } from "@/lib/sheetModel";

const MAX_IMPORT_ROWS = 1000;
const MAX_IMPORT_COLUMNS = 200;
const MAX_IMPORT_CELLS = 50_000;

export function pickSheetFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv";
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

function deriveSheetTitle(filename: string): string {
  const normalized = String(filename || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/\.(?:xlsx|csv)$/i, "")
    .trim();
  return normalized || "导入的表格";
}

function ensureWithinImportLimits(sheetData: SheetDataModel): void {
  if (
    sheetData.rows.length > MAX_IMPORT_ROWS ||
    sheetData.columns.length > MAX_IMPORT_COLUMNS ||
    Object.keys(sheetData.cells).length > MAX_IMPORT_CELLS
  ) {
    throw new Error(`表格超出可导入上限（最多 ${MAX_IMPORT_ROWS} 行、${MAX_IMPORT_COLUMNS} 列、${MAX_IMPORT_CELLS} 个单元格）`);
  }
}

export async function parseSheetImportFile(file: File): Promise<SheetDataModel> {
  const name = String(file.name || "").trim().toLowerCase();
  const mime = String(file.type || "").toLowerCase().split(";", 1)[0].trim();

  let sheetData: SheetDataModel;
  if (name.endsWith(".xlsx") || mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    const { parseSheetXlsx } = await import("@/lib/sheetXlsx");
    sheetData = await parseSheetXlsx(file);
  } else if (name.endsWith(".csv") || mime === "text/csv") {
    const { sheetFromCsv } = await import("@/lib/sheetModel");
    sheetData = sheetFromCsv(await file.text());
  } else {
    throw new Error("暂只支持导入 .xlsx 或 .csv 表格文件");
  }

  ensureWithinImportLimits(sheetData);
  return sheetData;
}

export async function importSheetFileAsNode(params: {
  parentId: string | null;
  file: File;
}): Promise<KnowledgeTreeNode> {
  const sheetData = await parseSheetImportFile(params.file);
  const title = deriveSheetTitle(params.file.name);
  return knowledgeTreeApi.create({
    parentId: params.parentId,
    nodeType: "sheet",
    title,
    sheetData,
  });
}
