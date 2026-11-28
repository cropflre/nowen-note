import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NowenApiClient } from "./api-client.js";
import { stringifyTimedResult } from "./result-time.js";

const simpleCellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const simpleSheetSchema = z.object({
  id: z.string().min(1).max(64).optional().describe("工作表 ID，如 sheet-01（可选）"),
  name: z.string().min(1).max(64).describe("工作表名称，如 Sheet1"),
  rows: z.array(z.array(simpleCellValueSchema)).describe("二维行数组，每一行是从第 0 列开始的单元格值"),
});

const cellUpdateSchema = z.object({
  sheetId: z.string().min(1).optional().describe("目标工作表 ID；与 sheetName 二选一，都不传时默认第一个工作表"),
  sheetName: z.string().min(1).optional().describe("目标工作表名称；与 sheetId 二选一"),
  row: z.number().int().min(0).max(50000).describe("行号（从 0 开始）"),
  col: z.number().int().min(0).max(500).describe("列号（从 0 开始）"),
  value: simpleCellValueSchema.optional().describe("单元格值；传 null 表示清空该单元格"),
  formula: z.string().optional().describe("可选公式，如 =SUM(A1:A5)"),
});

type SimpleCellValue = string | number | boolean | null;
type SimpleSheetInput = z.infer<typeof simpleSheetSchema>;
type CellUpdateInput = z.infer<typeof cellUpdateSchema>;

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildCellDataFromRows(rows: SimpleCellValue[][]): Record<string, Record<string, { v?: string | number | boolean; f?: string }>> {
  const cellData: Record<string, Record<string, { v?: string | number | boolean; f?: string }>> = {};
  rows.forEach((row, rowIndex) => {
    const rowObj: Record<string, { v?: string | number | boolean; f?: string }> = {};
    row.forEach((cell, colIndex) => {
      if (cell === null || cell === undefined) return;
      if (typeof cell === "string" && cell.startsWith("=")) {
        rowObj[String(colIndex)] = { f: cell };
      } else {
        rowObj[String(colIndex)] = { v: cell };
      }
    });
    if (Object.keys(rowObj).length > 0) {
      cellData[String(rowIndex)] = rowObj;
    }
  });
  return cellData;
}

export function buildWorkbookFromSheets(title: string, sheetsInput: SimpleSheetInput[]): Record<string, unknown> {
  const sheetOrder: string[] = [];
  const sheets: Record<string, unknown> = {};
  sheetsInput.forEach((sheet, idx) => {
    const id = sheet.id || `sheet-${String(idx + 1).padStart(2, "0")}`;
    sheetOrder.push(id);
    const maxCols = sheet.rows.reduce((acc, row) => Math.max(acc, row.length), 0);
    sheets[id] = {
      id,
      name: sheet.name || `Sheet${idx + 1}`,
      rowCount: Math.max(200, sheet.rows.length + 20),
      columnCount: Math.max(30, maxCols + 5),
      cellData: buildCellDataFromRows(sheet.rows),
      mergeData: [],
    };
  });
  if (sheetOrder.length === 0) {
    sheetOrder.push("sheet-01");
    sheets["sheet-01"] = {
      id: "sheet-01",
      name: "Sheet1",
      rowCount: 200,
      columnCount: 30,
      cellData: {},
      mergeData: [],
    };
  }
  return {
    id: "workbook-01",
    name: title || "无标题 Excel 表格",
    locale: "zhCN",
    styles: {},
    sheetOrder,
    sheets,
  };
}

export function summarizeExcelWorkbook(data: unknown, maxPreviewRows = 50): Array<{
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  nonEmptyCellCount: number;
  previewRows: Array<{ row: number; cells: Record<string, string | number | boolean | null> }>;
  truncated: boolean;
}> {
  if (!isPlainObject(data) || !isPlainObject(data.sheets)) return [];
  const sheetsObj = data.sheets as Record<string, any>;
  const order = Array.isArray(data.sheetOrder) && data.sheetOrder.length > 0
    ? data.sheetOrder.filter((id: unknown): id is string => typeof id === "string" && id in sheetsObj)
    : Object.keys(sheetsObj);

  return order.map((sheetId) => {
    const sheet = isPlainObject(sheetsObj[sheetId]) ? sheetsObj[sheetId] : {};
    const cellData = isPlainObject(sheet.cellData) ? sheet.cellData : {};
    const rowKeys = Object.keys(cellData)
      .map((k) => Number(k))
      .filter((n) => Number.isInteger(n) && n >= 0)
      .sort((a, b) => a - b);

    let nonEmptyCellCount = 0;
    const previewRows: Array<{ row: number; cells: Record<string, string | number | boolean | null> }> = [];
    for (const rowIndex of rowKeys) {
      const rowMap = cellData[String(rowIndex)];
      if (!isPlainObject(rowMap)) continue;
      const colKeys = Object.keys(rowMap)
        .map((k) => Number(k))
        .filter((n) => Number.isInteger(n) && n >= 0)
        .sort((a, b) => a - b);
      const cells: Record<string, string | number | boolean | null> = {};
      for (const colIndex of colKeys) {
        const cell = rowMap[String(colIndex)];
        if (!isPlainObject(cell)) continue;
        const val = cell.v !== undefined ? cell.v : cell.f !== undefined ? cell.f : null;
        if (val !== null && val !== undefined && val !== "") {
          nonEmptyCellCount += 1;
          cells[String(colIndex)] = val;
        }
      }
      if (Object.keys(cells).length > 0 && previewRows.length < maxPreviewRows) {
        previewRows.push({ row: rowIndex, cells });
      }
    }
    return {
      id: typeof sheet.id === "string" ? sheet.id : sheetId,
      name: typeof sheet.name === "string" ? sheet.name : sheetId,
      rowCount: typeof sheet.rowCount === "number" ? sheet.rowCount : 200,
      columnCount: typeof sheet.columnCount === "number" ? sheet.columnCount : 30,
      nonEmptyCellCount,
      previewRows,
      truncated: rowKeys.length > maxPreviewRows,
    };
  });
}

export function applyExcelUpdates(
  currentData: Record<string, unknown>,
  updates: {
    cellUpdates?: CellUpdateInput[];
    sheets?: SimpleSheetInput[];
  },
): Record<string, unknown> {
  const next = structuredClone(currentData) as Record<string, any>;
  if (!isPlainObject(next.sheets)) {
    next.sheets = {};
  }
  if (!Array.isArray(next.sheetOrder)) {
    next.sheetOrder = Object.keys(next.sheets);
  }

  if (updates.sheets && updates.sheets.length > 0) {
    for (const sheetInput of updates.sheets) {
      let targetId = sheetInput.id;
      if (!targetId) {
        targetId = Object.keys(next.sheets).find((id) => next.sheets[id]?.name === sheetInput.name);
      }
      if (!targetId) {
        targetId = `sheet-${String(Object.keys(next.sheets).length + 1).padStart(2, "0")}`;
      }
      const existing = isPlainObject(next.sheets[targetId]) ? next.sheets[targetId] : {};
      const maxCols = sheetInput.rows.reduce((acc, row) => Math.max(acc, row.length), 0);
      next.sheets[targetId] = {
        ...existing,
        id: targetId,
        name: sheetInput.name || existing.name || targetId,
        rowCount: Math.max(Number(existing.rowCount || 200), sheetInput.rows.length + 20),
        columnCount: Math.max(Number(existing.columnCount || 30), maxCols + 5),
        cellData: buildCellDataFromRows(sheetInput.rows),
        mergeData: Array.isArray(existing.mergeData) ? existing.mergeData : [],
      };
      if (!next.sheetOrder.includes(targetId)) {
        next.sheetOrder.push(targetId);
      }
    }
  }

  if (updates.cellUpdates && updates.cellUpdates.length > 0) {
    for (const patch of updates.cellUpdates) {
      const sheetId = resolveTargetSheetId(next, patch.sheetId, patch.sheetName);
      const sheet = next.sheets[sheetId];
      if (!isPlainObject(sheet.cellData)) sheet.cellData = {};
      const rowKey = String(patch.row);
      const colKey = String(patch.col);
      if (patch.value === null && patch.formula === undefined) {
        if (isPlainObject(sheet.cellData[rowKey])) {
          delete sheet.cellData[rowKey][colKey];
          if (Object.keys(sheet.cellData[rowKey]).length === 0) {
            delete sheet.cellData[rowKey];
          }
        }
        continue;
      }
      if (!isPlainObject(sheet.cellData[rowKey])) {
        sheet.cellData[rowKey] = {};
      }
      const prevCell = isPlainObject(sheet.cellData[rowKey][colKey]) ? sheet.cellData[rowKey][colKey] : {};
      const nextCell: Record<string, unknown> = { ...prevCell };
      if (patch.value !== undefined) {
        if (patch.value === null) delete nextCell.v;
        else nextCell.v = patch.value;
      }
      if (patch.formula !== undefined) {
        if (!patch.formula) delete nextCell.f;
        else nextCell.f = patch.formula;
      }
      sheet.cellData[rowKey][colKey] = nextCell;
      if (patch.row >= Number(sheet.rowCount || 0)) sheet.rowCount = patch.row + 20;
      if (patch.col >= Number(sheet.columnCount || 0)) sheet.columnCount = patch.col + 5;
    }
  }

  return next;
}

function resolveTargetSheetId(workbook: Record<string, any>, sheetId?: string, sheetName?: string): string {
  const sheets = workbook.sheets as Record<string, any>;
  if (sheetId) {
    if (!(sheetId in sheets)) throw new Error(`工作表 ID 不存在: ${sheetId}`);
    return sheetId;
  }
  if (sheetName) {
    const matched = Object.keys(sheets).find((id) => sheets[id]?.name === sheetName);
    if (!matched) throw new Error(`工作表名称不存在: ${sheetName}`);
    return matched;
  }
  const first = Array.isArray(workbook.sheetOrder) && workbook.sheetOrder.length > 0
    ? workbook.sheetOrder[0]
    : Object.keys(sheets)[0];
  if (!first || !(first in sheets)) throw new Error("当前 Excel 工作簿不包含任何工作表");
  return first;
}

function parseMindmapDataField(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function registerDocumentTypeTools(server: McpServer, api: NowenApiClient): void {
  // ==================== 思维导图 CRUD ====================

  server.tool(
    "nowen_list_mindmaps",
    "列出当前连接有权访问的思维导图，可按空间或所属笔记本 ID 筛选",
    {
      workspaceId: z.string().optional().describe("可选：personal 或团队工作区 ID"),
      notebookId: z.string().optional().describe("可选：按所属笔记本 ID 筛选"),
    },
    async ({ workspaceId, notebookId }) => {
      try {
        let items = await api.listMindmaps(workspaceId);
        if (notebookId) {
          items = items.filter((item: any) => item.notebookId === notebookId);
        }
        const summary = items.map((item: any) => ({
          id: item.id,
          title: item.title,
          notebookId: item.notebookId ?? null,
          workspaceId: item.workspaceId ?? "personal",
          starred: Boolean(item.starred),
          canEdit: item.canEdit,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        }));
        return { content: [{ type: "text" as const, text: stringifyTimedResult(summary) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    "nowen_read_mindmap",
    "读取指定思维导图的完整节点树数据（JSON）和元数据，包含用于并发保存校验的 updatedAt",
    {
      mindmapId: z.string().min(1).describe("思维导图 ID"),
    },
    async ({ mindmapId }) => {
      try {
        const doc = await api.getMindmap(mindmapId);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              id: doc.id,
              title: doc.title,
              notebookId: doc.notebookId ?? null,
              workspaceId: doc.workspaceId ?? "personal",
              canEdit: doc.canEdit,
              createdAt: doc.createdAt,
              updatedAt: doc.updatedAt,
              data: parseMindmapDataField(doc.data),
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    "nowen_create_mindmap",
    "在指定笔记本下创建新的思维导图（受限 Token 必须提供已授权的 notebookId）。可传入初始节点树 data（格式 { root: { id, text, children } }）",
    {
      title: z.string().trim().min(1).max(200).describe("思维导图标题"),
      notebookId: z.string().min(1).optional().describe("目标笔记本 ID（受限 Token 必填）"),
      data: z.record(z.any()).optional().describe("可选：初始节点树对象，必须包含 root 节点（{ root: { id: 'root', text: '...', children: [] } }）"),
      workspaceId: z.string().optional().describe("可选：personal 或团队工作区 ID"),
    },
    async ({ title, notebookId, data, workspaceId }) => {
      try {
        if (data !== undefined && !isPlainObject(data.root)) {
          throw new Error("data 必须包含 root 节点对象，例如 { root: { id: 'root', text: '中心主题', children: [] } }");
        }
        const created = await api.createMindmap({ title, notebookId, data }, workspaceId);
        return {
          content: [{
            type: "text" as const,
            text: `思维导图创建成功:\n${JSON.stringify({
              id: created.id,
              title: created.title,
              notebookId: created.notebookId ?? notebookId ?? null,
              workspaceId: created.workspaceId ?? "personal",
              updatedAt: created.updatedAt,
              data: parseMindmapDataField(created.data),
            }, null, 2)}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    "nowen_update_mindmap",
    "更新已有思维导图的标题或节点树 data，默认携带当前 updatedAt 做乐观锁校验以防并发覆盖",
    {
      mindmapId: z.string().min(1).describe("思维导图 ID"),
      title: z.string().trim().min(1).max(200).optional().describe("新标题"),
      data: z.record(z.any()).optional().describe("新的完整节点树对象，必须包含 root 节点"),
      expectedUpdatedAt: z.string().optional().describe("可选：上次读取得到的 updatedAt；不传时自动读取最新版本校验"),
    },
    async ({ mindmapId, title, data, expectedUpdatedAt }) => {
      try {
        if (title === undefined && data === undefined) {
          throw new Error("必须提供 title 或 data 至少一项");
        }
        if (data !== undefined && !isPlainObject(data.root)) {
          throw new Error("data 必须包含 root 节点对象");
        }
        let lockUpdatedAt = expectedUpdatedAt;
        if (!lockUpdatedAt) {
          const current = await api.getMindmap(mindmapId);
          lockUpdatedAt = current?.updatedAt;
        }
        const updated = await api.updateMindmap(mindmapId, {
          ...(title !== undefined ? { title } : {}),
          ...(data !== undefined ? { data } : {}),
          ...(lockUpdatedAt ? { expectedUpdatedAt: lockUpdatedAt } : {}),
        });
        return {
          content: [{
            type: "text" as const,
            text: `思维导图更新成功:\n${JSON.stringify({
              id: updated.id,
              title: updated.title,
              notebookId: updated.notebookId ?? null,
              updatedAt: updated.updatedAt,
            }, null, 2)}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    "nowen_delete_mindmap",
    "安全地将思维导图移入回收站（可恢复，绝不永久删除）。默认 dryRun=true 只预览；执行需传 dryRun=false、预览的 expectedUpdatedAt 和 confirmation=MOVE_TO_TRASH",
    {
      mindmapId: z.string().min(1).describe("思维导图 ID"),
      dryRun: z.boolean().optional().describe("默认 true：只预览，不执行删除"),
      expectedUpdatedAt: z.string().optional().describe("执行时必填：与预览返回的 updatedAt 一致"),
      confirmation: z.string().optional().describe("执行时必填 MOVE_TO_TRASH；应先征得用户确认"),
    },
    async ({ mindmapId, dryRun, expectedUpdatedAt, confirmation }) => {
      try {
        const current = await api.getMindmap(mindmapId);
        if (!current || current.id !== mindmapId) throw new Error("无法读取当前思维导图");
        const preview = {
          mindmapId: current.id,
          title: current.title,
          notebookId: current.notebookId ?? null,
          workspaceId: current.workspaceId ?? "personal",
          updatedAt: current.updatedAt,
        };
        if (dryRun !== false) {
          return {
            content: [{
              type: "text" as const,
              text: `思维导图移入回收站预览（未执行）：\n${JSON.stringify(preview, null, 2)}\n请确认后传 dryRun=false、expectedUpdatedAt、confirmation=MOVE_TO_TRASH。`,
            }],
          };
        }
        if (confirmation !== "MOVE_TO_TRASH") {
          throw new Error("缺少明确确认：confirmation 必须是 MOVE_TO_TRASH");
        }
        if (!expectedUpdatedAt || expectedUpdatedAt !== current.updatedAt) {
          throw new Error(`思维导图版本已变化或未确认，当前 updatedAt=${current.updatedAt}，请重新预览`);
        }
        await api.deleteMindmap(mindmapId);
        return {
          content: [{
            type: "text" as const,
            text: `思维导图已移入回收站（可恢复）：${JSON.stringify({ id: mindmapId, title: current.title })}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
      }
    },
  );

  // ==================== Excel 工作簿 CRUD ====================

  server.tool(
    "nowen_list_excels",
    "列出当前连接有权访问的 Excel 表格工作簿，可按笔记本、空间或关键词筛选",
    {
      notebookId: z.string().optional().describe("按笔记本 ID 筛选"),
      workspaceId: z.string().optional().describe("可选：personal 或团队工作区 ID"),
      search: z.string().optional().describe("关键词筛选"),
    },
    async ({ notebookId, workspaceId, search }) => {
      try {
        const query: Record<string, string> = {};
        if (notebookId) query.notebookId = notebookId;
        if (workspaceId) query.workspaceId = workspaceId;
        if (search) query.search = search;
        const notes = await api.listNotes(query);
        const excels = notes
          .filter((n: any) => n.noteType === "excel")
          .map((n: any) => ({
            noteId: n.id,
            title: n.title,
            notebookId: n.notebookId,
            version: n.version,
            updatedAt: n.updatedAt,
            contentPreview: n.contentText?.slice(0, 120),
          }));
        return { content: [{ type: "text" as const, text: stringifyTimedResult(excels) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    "nowen_read_excel",
    "读取指定 Excel 工作簿的元数据、revision 和各工作表单元格内容；需要完整 Univer JSON 快照时传 includeRawData=true",
    {
      noteId: z.string().min(1).describe("Excel 表格的 noteId"),
      includeRawData: z.boolean().optional().describe("默认 false：返回结构化工作表行摘要；true 时同时附带原始 Univer 快照 data"),
      maxPreviewRows: z.number().int().min(1).max(500).optional().describe("每个工作表最多返回的非空行预览数，默认 50"),
    },
    async ({ noteId, includeRawData, maxPreviewRows }) => {
      try {
        const doc = await api.getExcel(noteId);
        const result: Record<string, unknown> = {
          noteId: doc.noteId,
          title: doc.title,
          workspaceId: doc.workspaceId ?? "personal",
          revision: doc.revision,
          updatedAt: doc.updatedAt,
          canEdit: doc.canEdit,
          sheets: summarizeExcelWorkbook(doc.data, maxPreviewRows || 50),
        };
        if (includeRawData) {
          result.data = doc.data;
        }
        return { content: [{ type: "text" as const, text: stringifyTimedResult(result) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    "nowen_create_excel",
    "在指定笔记本中创建新的 Excel 工作簿。可通过简化的 sheets（二维行数组）或完整 Univer 快照 data 初始化内容",
    {
      notebookId: z.string().min(1).describe("目标笔记本 ID"),
      title: z.string().trim().min(1).max(200).describe("Excel 工作簿标题"),
      sheets: z.array(simpleSheetSchema).optional().describe("可选：简化工作表定义数组（与 data 二选一）"),
      data: z.record(z.any()).optional().describe("可选：完整 Univer 工作簿快照对象（与 sheets 二选一）"),
    },
    async ({ notebookId, title, sheets, data }) => {
      try {
        if (sheets && data) {
          throw new Error("sheets 与 data 请二选一，不要同时传入");
        }
        const initialData = data ?? (sheets ? buildWorkbookFromSheets(title, sheets) : undefined);
        const created = await api.createExcel({ notebookId, title, ...(initialData ? { data: initialData } : {}) });
        return {
          content: [{
            type: "text" as const,
            text: `Excel 工作簿创建成功:\n${stringifyTimedResult({
              noteId: created.noteId,
              title: created.title,
              notebookId: created.notebookId ?? notebookId,
              workspaceId: created.workspaceId ?? "personal",
              revision: created.revision,
              updatedAt: created.updatedAt,
              sheets: summarizeExcelWorkbook(created.data),
            })}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    "nowen_update_excel",
    "更新已有 Excel 工作簿的标题或单元格数据（支持 cellUpdates 精准改单元格、sheets 替换工作表行、或完整 Univer data 快照），使用 expectedRevision 乐观锁防止覆盖",
    {
      noteId: z.string().min(1).describe("Excel 表格的 noteId"),
      title: z.string().trim().min(1).max(200).optional().describe("可选：修改工作簿标题"),
      expectedRevision: z.number().int().positive().optional().describe("可选：上次读取得到的 revision；不传时自动读取最新 revision"),
      cellUpdates: z.array(cellUpdateSchema).optional().describe("可选：按行列精准增删改单元格"),
      sheets: z.array(simpleSheetSchema).optional().describe("可选：按名称或 ID 新增/覆盖工作表行数据"),
      data: z.record(z.any()).optional().describe("可选：完整替换 Univer 工作簿快照（与 cellUpdates/sheets 互斥）"),
    },
    async ({ noteId, title, expectedRevision, cellUpdates, sheets, data }) => {
      try {
        const hasWorkbookMutation = data !== undefined || (cellUpdates && cellUpdates.length > 0) || (sheets && sheets.length > 0);
        if (!hasWorkbookMutation && title === undefined) {
          throw new Error("至少需要提供 title、cellUpdates、sheets 或 data 中的一项");
        }
        if (data !== undefined && ((cellUpdates && cellUpdates.length > 0) || (sheets && sheets.length > 0))) {
          throw new Error("完整替换 data 与增量参数 cellUpdates/sheets 不能同时传入");
        }

        let updatedRevision: number | undefined;
        let updatedAt: string | undefined;
        let finalTitle = title;

        if (hasWorkbookMutation) {
          const current = await api.getExcel(noteId);
          const revision = expectedRevision ?? current.revision;
          const nextData = data ?? applyExcelUpdates(current.data as Record<string, unknown>, { cellUpdates, sheets });
          const saved = await api.updateExcel(noteId, { data: nextData, expectedRevision: revision });
          updatedRevision = saved.revision;
          updatedAt = saved.updatedAt;
          if (finalTitle === undefined) finalTitle = current.title;
        }

        let noteVersion: number | undefined;
        if (title !== undefined) {
          const currentNote = await api.getNote(noteId);
          const renamed = await api.updateNote(noteId, {
            title,
            version: currentNote.version || 1,
            writeSource: "mcp",
          });
          noteVersion = renamed.version;
          finalTitle = renamed.title;
        }

        return {
          content: [{
            type: "text" as const,
            text: `Excel 工作簿更新成功:\n${stringifyTimedResult({
              noteId,
              title: finalTitle,
              ...(updatedRevision !== undefined ? { revision: updatedRevision } : {}),
              ...(noteVersion !== undefined ? { noteVersion } : {}),
              ...(updatedAt ? { updatedAt } : {}),
            })}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    "nowen_delete_excel",
    "安全地将 Excel 工作簿移入回收站（可恢复，绝不永久删除）。默认 dryRun=true 只预览；执行需传 dryRun=false、预览的 expectedVersion 和 confirmation=MOVE_TO_TRASH",
    {
      noteId: z.string().min(1).describe("Excel 表格的 noteId"),
      dryRun: z.boolean().optional().describe("默认 true：只预览，不执行删除"),
      expectedVersion: z.number().int().positive().optional().describe("执行时必填：与预览返回的 version 一致"),
      confirmation: z.string().optional().describe("执行时必填 MOVE_TO_TRASH；应先征得用户确认"),
    },
    async ({ noteId, dryRun, expectedVersion, confirmation }) => {
      try {
        const note = await api.getNote(noteId);
        if (!note || note.id !== noteId) throw new Error("无法读取当前 Excel 工作簿");
        if (note.noteType !== "excel") {
          throw new Error(`目标文档不是 Excel 工作簿（当前类型: ${note.noteType || "normal"}），请改用 nowen_delete_note`);
        }
        const preview = {
          noteId,
          title: note.title,
          notebookId: note.notebookId,
          version: note.version,
          alreadyTrashed: Boolean(note.isTrashed),
        };
        if (dryRun !== false) {
          return {
            content: [{
              type: "text" as const,
              text: `Excel 工作簿移入回收站预览（未执行）：\n${stringifyTimedResult(preview)}\n请确认后传 dryRun=false、expectedVersion、confirmation=MOVE_TO_TRASH。`,
            }],
          };
        }
        if (confirmation !== "MOVE_TO_TRASH") {
          throw new Error("缺少明确确认：confirmation 必须是 MOVE_TO_TRASH");
        }
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== note.version) {
          throw new Error(`Excel 工作簿版本已变化或未确认，当前版本 ${note.version}，请重新预览`);
        }
        if (note.isTrashed) throw new Error("Excel 工作簿已在回收站，无须重复删除");
        const result = await api.updateNote(noteId, { isTrashed: 1, version: expectedVersion, writeSource: "mcp" });
        return {
          content: [{
            type: "text" as const,
            text: `Excel 工作簿已移入回收站（可恢复）：${JSON.stringify({ noteId, version: result?.version })}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
      }
    },
  );
}
