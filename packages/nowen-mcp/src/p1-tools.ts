import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NowenApiClient } from "./api-client.js";

/**
 * Personal file-manager assets do not have notebook ACLs. Restrict them to
 * unscoped personal API tokens; a notebook-restricted agent must not enumerate
 * global folders or recover unrelated files.
 */
function requirePersonalFileManagerMode(): void {
  if (!process.env.NOWEN_API_TOKEN?.trim()) {
    throw new Error("网盘 MCP 工具需要个人 API Token，不能使用共享账号密码");
  }
  if (Object.prototype.hasOwnProperty.call(process.env, "ALLOWED_NOTEBOOK_IDS")) {
    throw new Error("网盘文件夹无笔记本归属；启用 ALLOWED_NOTEBOOK_IDS 时禁止管理全局网盘");
  }
}

function response(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}
function failure(error: unknown) {
  return { content: [{ type: "text" as const, text: `错误: ${error instanceof Error ? error.message : String(error)}` }], isError: true as const };
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

type FileChange = {
  operation: "create_folder" | "update_folder" | "rename_file" | "move_files" | "restore_files";
  folderId?: string;
  parentId?: string | null;
  name?: string;
  fileIds?: string[];
  page?: number;
};
const fileChangeShape = {
  operation: z.enum(["create_folder", "update_folder", "rename_file", "move_files", "restore_files"]),
  folderId: z.string().min(1).optional().describe("update_folder 所选文件夹 ID，rename_file 所选文件 ID"),
  parentId: z.string().nullable().optional().describe("创建或移动文件夹的目标父目录，null 为网盘根目录；move_files 时为目标 folderId"),
  name: z.string().min(1).max(255).optional().describe("新文件夹名称或新文件名"),
  fileIds: z.array(z.string().min(1)).min(1).max(50).optional().describe("move_files/restore_files 文件 ID，最多 50 个"),
  page: z.number().int().min(1).max(10000).optional().describe("restore_files 所在回收站页码"),
};

async function prepareFileChange(api: NowenApiClient, params: FileChange) {
  requirePersonalFileManagerMode();
  const { operation, parentId, folderId, name } = params;
  const foldersResponse = await api.listFileFolders();
  const folders: any[] = foldersResponse?.folders ?? [];
  const byId = new Map(folders.map((folder: any) => [folder.id, folder]));
  if ((operation === "create_folder" || operation === "rename_file") && !name?.trim()) {
    throw new Error("需要填写新名称");
  }
  if (operation === "update_folder" && name === undefined && parentId === undefined) {
    throw new Error("重命名或移动文件夹需要设置 name 或 parentId");
  }
  if (operation === "update_folder" && name !== undefined && !name.trim()) {
    throw new Error("文件夹名称不能为空");
  }
  if (operation === "move_files" && parentId === undefined) {
    throw new Error("移动文件必须显式指定目标 parentId；null 表示未归档");
  }
  if (["create_folder", "update_folder"].includes(operation) && name !== undefined && name.trim().length > 100) {
    throw new Error("文件夹名称不能超过 100 个字符");
  }
  if ((operation === "create_folder" || operation === "update_folder" || operation === "move_files") && parentId) {
    if (!byId.has(parentId)) throw new Error("目标文件夹不存在或未授权");
  }
  if ((operation === "create_folder" || operation === "update_folder" || operation === "move_files") && foldersResponse.supported !== true) {
    throw new Error("附件文件夹尚未完成同步准备，当前仅可读取，不能移动或创建");
  }
  let files: any[] = [];
  let folder: any = null;
  let restoreSnapshot: Record<string, string> = {};
  if (operation === "update_folder") {
    if (!folderId || !byId.has(folderId)) throw new Error("待修改文件夹不存在");
    folder = byId.get(folderId);
    if (parentId === folderId) throw new Error("不能移动到自身");
    if (parentId) {
      let cursor: any = byId.get(parentId);
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor.id)) {
        if (cursor.id === folderId) throw new Error("不能将文件夹移动到自身的后代目录");
        seen.add(cursor.id);
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
      }
      if (cursor) throw new Error("目录存在循环关系，禁止修改");
    }
  }
  if (operation === "rename_file" || operation === "move_files") {
    const ids = operation === "rename_file" ? [folderId] : params.fileIds;
    if (!ids?.length || ids.length > 50 || ids.some((id) => !id)) throw new Error("请选择 1 至 50 个文件");
    if (new Set(ids).size !== ids.length) throw new Error("文件 ID 不可重复");
    files = await Promise.all(ids.map(async (id) => {
      const file = await api.personalFileDetail(id!);
      if (!file?.canManage) throw new Error("文件不存在或当前用户没有管理权限");
      return { id: file.id, filename: file.filename, folderId: file.folderId ?? null, size: file.size };
    }));
  }
  if (operation === "restore_files") {
    const ids = params.fileIds || [];
    if (!ids.length || ids.length > 50 || new Set(ids).size !== ids.length) throw new Error("请选择 1 至 50 个互不重复的文件");
    const page = params.page || 1;
    const trash = await api.listPersonalFileTrash(page);
    const byFileId = new Map((trash?.entries || []).map((item: any) => [item.id, item]));
    for (const id of ids) {
      const row: any = byFileId.get(id);
      if (!row || typeof row.trashedAt !== "string") throw new Error("所选文件不在当前回收站页面，或不属于个人网盘");
      restoreSnapshot[id] = row.trashedAt;
    }
  }
  const snapshot = {
    operation,
    folder: folder ? { id: folder.id, name: folder.name, parentId: folder.parentId ?? null } : null,
    target: parentId ? { id: byId.get(parentId)?.id, name: byId.get(parentId)?.name, parentId: byId.get(parentId)?.parentId ?? null } : null,
    files: files.sort((a, b) => a.id.localeCompare(b.id)),
    restoreSnapshot: Object.fromEntries(Object.entries(restoreSnapshot).sort(([a], [b]) => a.localeCompare(b))),
    name: name?.trim() ?? null,
    requestedParentId: parentId === undefined ? "__unchanged__" : parentId,
  };
  return { revision: digest(snapshot), snapshot, files, folder, restoreSnapshot };
}

export function registerP1Tools(server: McpServer, api: NowenApiClient): void {
  server.tool("nowen_list_file_folders", "读取个人网盘文件夹与文件数量；网盘工具要求不受笔记本白名单约束的个人 Token", {}, async () => {
    try { requirePersonalFileManagerMode(); return response(await api.listFileFolders()); } catch (error) { return failure(error); }
  });
  server.tool("nowen_list_managed_files", "按关键字或目录分页查询个人网盘文件管理器上传的文件（不混入编辑器附件）", {
    q: z.string().max(100).optional(), folderId: z.string().optional(),
    page: z.number().int().min(1).max(10000).optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
  }, async (params) => {
    try {
      requirePersonalFileManagerMode();
      const files = await api.listPersonalManagedFiles(params);
      return response({ items: files.items, total: files.total, page: files.page, pageSize: files.pageSize });
    } catch (error) { return failure(error); }
  });
  server.tool("nowen_list_file_trash", "分页查看当前用户个人网盘的可恢复文件，不包括其他用户和编辑器来源的附件", {
    page: z.number().int().min(1).max(10000).optional(),
  }, async ({ page }) => {
    try { requirePersonalFileManagerMode(); return response(await api.listPersonalFileTrash(page)); }
    catch (error) { return failure(error); }
  });
  server.tool("nowen_preview_file_change",
    "预览个人网盘的文件夹创建/重命名/移动、文件重命名/批量归档、回收站恢复，不修改任何数据",
    fileChangeShape, async (params) => {
      try {
        const plan = await prepareFileChange(api, params);
        return response({ dryRun: true, ...params, ...plan, nextStep: "得到用户确认后，传相同参数与 expectedRevision、confirmation=APPLY_FILE_CHANGE（回收站恢复用 RESTORE_FILES）。" });
      } catch (error) { return failure(error); }
    });
  server.tool("nowen_apply_file_change",
    "执行经用户确认的个人网盘整理；对原文件名、原位置和回收站时间做并发校验，不支持永久删除",
    {
      ...fileChangeShape,
      expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
      confirmation: z.enum(["APPLY_FILE_CHANGE", "RESTORE_FILES"]),
    },
    async (params) => {
      try {
        const plan = await prepareFileChange(api, params);
        if (plan.revision !== params.expectedRevision) throw new Error("网盘内容或目标文件夹已经变化，请重新预览");
        const needed = params.operation === "restore_files" ? "RESTORE_FILES" : "APPLY_FILE_CHANGE";
        if (params.confirmation !== needed) throw new Error("尚未得到正确的操作确认");
        let result: unknown;
        switch (params.operation) {
          case "create_folder":
            result = await api.createFileFolder(params.name!.trim(), params.parentId ?? null);
            break;
          case "update_folder":
            result = await api.updateFileFolder(params.folderId!, {
              ...(params.name !== undefined ? { name: params.name.trim() } : {}),
              ...(params.parentId !== undefined ? { parentId: params.parentId } : {}),
              expectedName: plan.folder.name, expectedParentId: plan.folder.parentId ?? null,
            });
            break;
          case "rename_file":
            result = await api.renameManagedFile(params.folderId!, params.name!.trim(), plan.files[0].filename);
            break;
          case "move_files":
            result = await api.moveManagedFiles(plan.files.map((item) => item.id), params.parentId ?? null,
              Object.fromEntries(plan.files.map((item) => [item.id, item.folderId])));
            break;
          case "restore_files":
            result = await api.restorePersonalFiles(params.fileIds!, plan.restoreSnapshot);
            break;
          default:
            throw new Error("不支持的文件操作");
        }
        return response({ applied: true, operation: params.operation, result });
      } catch (error) { return failure(error); }
    });

  server.tool("nowen_reorder_task",
    "预览或确认修改个人任务排序；保留项目和父子关系，使用原更新时间与顺序阻止过期写入",
    {
      taskId: z.string().min(1),
      sortOrder: z.number().int().min(0).max(1_000_000),
      dryRun: z.boolean().optional().describe("默认 true，只预览"),
      expectedUpdatedAt: z.string().optional().describe("执行时填写预览返回的更新时间"),
      expectedSortOrder: z.number().int().optional().describe("执行时填写预览返回的原 sortOrder"),
      confirmation: z.string().optional().describe("执行时必须为 REORDER_TASK"),
    },
    async ({ taskId, sortOrder, dryRun, expectedUpdatedAt, expectedSortOrder, confirmation }) => {
      try {
        const task = await api.getTask(taskId);
        if (!task || task.workspaceId != null) throw new Error("仅可调整本人个人任务");
        const preview = {
          taskId, title: task.title, currentSortOrder: task.sortOrder,
          updatedAt: task.updatedAt, targetSortOrder: sortOrder,
        };
        if (dryRun !== false) return response({ dryRun: true, ...preview });
        if (confirmation !== "REORDER_TASK") throw new Error("调整排序前须取得明确确认");
        if (expectedUpdatedAt !== task.updatedAt || expectedSortOrder !== task.sortOrder) {
          throw new Error("任务顺序或详情已变化，请重新预览");
        }
        const changed = await api.updateTask(taskId, {
          sortOrder, expectedUpdatedAt, expectedSortOrder,
        });
        return response({ applied: true, taskId, sortOrder: changed.sortOrder });
      } catch (error) { return failure(error); }
    });

  const taskPreviewShape = {
    taskId: z.string().min(1),
    notebookId: z.string().min(1).describe("目标笔记本 ID"),
    title: z.string().trim().min(1).max(200).optional().describe("笔记标题，默认沿用任务标题"),
  };
  const planTask = async (params: { taskId: string; notebookId: string; title?: string }) => {
    const task = await api.getTask(params.taskId);
    if (!task?.id || task.workspaceId != null) throw new Error("仅可转存个人空间任务");
    const title = params.title?.trim() || task.title || "任务成果";
    const description = typeof task.description === "string" ? task.description : "";
    const revision = digest([task.id, task.updatedAt, title, description, params.notebookId]);
    return { task, title, description, revision };
  };
  server.tool("nowen_preview_task_to_note", "预览将个人任务详情保存为 Markdown 笔记；原任务保留，附件由服务端安全转存",
    taskPreviewShape, async (params) => {
      try {
        const { task, title, description, revision } = await planTask(params);
        return response({
          dryRun: true, taskId: task.id, notebookId: params.notebookId, title,
          descriptionPreview: description.slice(0, 2000),
          descriptionLength: description.length,
          descriptionTruncated: description.length > 2000,
          taskUpdatedAt: task.updatedAt, revision,
          retainsOriginalTask: true,
          nextStep: "确认后调用 nowen_save_task_to_note，并传入 expectedRevision 与 SAVE_TASK_NOTE。",
        });
      } catch (error) { return failure(error); }
    });
  server.tool("nowen_save_task_to_note", "在确认和版本校验后将个人任务内容及附件转存笔记，保留原任务；相同预览幂等",
    { ...taskPreviewShape, expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
      confirmation: z.literal("SAVE_TASK_NOTE") },
    async (params) => {
      try {
        const plan = await planTask(params);
        if (plan.revision !== params.expectedRevision) throw new Error("任务内容发生变化，请重新预览");
        const hex = plan.revision.slice(0, 32);
        const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        const result = await api.saveTaskAsNote(params.taskId, {
          requestId, notebookId: params.notebookId, title: plan.title,
          description: plan.description, expectedTaskUpdatedAt: plan.task.updatedAt,
          expectedTaskTitle: plan.task.title, expectedTaskDescription: plan.description,
        });
        return response({ saved: true, taskId: params.taskId, originalTaskRetained: true, noteId: result.id, title: result.title });
      } catch (error) { return failure(error); }
    });
}
