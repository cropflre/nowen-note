import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function asText(value: any): string {
  return value.content?.map((item: any) => item.text || "").join("\n") || "";
}

test("P1 personal file and task tools enforce preview, token and optimistic positions via real MCP stdio", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/scoped-entry.js");
  const folders: any[] = [{ id: "folder-a", name: "Inbox", parentId: null, fileCount: 1 }];
  const file = { id: "file-a", filename: "report.pdf", folderId: "folder-a", size: 100, canManage: true };
  let folderWrites = 0;
  let moved = 0;
  let snapshots = 0;
  let trashRestores = 0;
  let loginCalls = 0;
  let taskReorders = 0;
  const backend = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = url.pathname.replace(/\/$/, "");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) : {};
    res.setHeader("Content-Type", "application/json");
    const done = (code: number, value: unknown) => { res.statusCode = code; res.end(JSON.stringify(value)); };
    if (pathname === "/api/auth/login") { loginCalls++; done(500, { error: "PAT required" }); return; }
    if (req.headers.authorization !== "Bearer p1-integration-token") {
      done(401, { error: "invalid token" }); return;
    }
    if (pathname === "/api/attachment-folders" && req.method === "GET") {
      done(200, { supported: true, folders });
    } else if (pathname === "/api/attachment-folders" && req.method === "POST") {
      folderWrites++;
      const created = { id: "created-folder", name: body.name, parentId: body.parentId, fileCount: 0 };
      folders.push(created);
      done(201, created);
    } else if (pathname === "/api/files" && req.method === "GET") {
      done(200, { items: [file], page: 1, pageSize: 50, total: 1 });
    } else if (pathname === "/api/files/file-a" && req.method === "GET") {
      done(200, { ...file });
    } else if (pathname === "/api/files/batch-move" && req.method === "POST") {
      if (body.expectedFolderIds?.["file-a"] !== file.folderId) {
        done(409, { code: "FILE_POSITION_CONFLICT" }); return;
      }
      moved++;
      file.folderId = body.folderId;
      done(200, { success: true, moved: 1, folderId: file.folderId });
    } else if (pathname === "/api/files/trash" && req.method === "GET") {
      done(200, {
        entries: [{ id: "trashed-a", filename: "trash.png", trashedAt: "2026-10-16T00:00:00Z" }],
        page: 1, pageSize: 100, total: 1,
      });
    } else if (pathname === "/api/files/trash/restore" && req.method === "POST") {
      if (body.expectedTrashedAt?.["trashed-a"] !== "2026-10-16T00:00:00Z") {
        done(409, { code: "FILE_TRASH_VERSION_CONFLICT" }); return;
      }
      trashRestores++;
      done(200, { success: true, restored: [{ id: "trashed-a", folderId: null }] });
    } else if (pathname === "/api/tasks/task-1" && req.method === "GET") {
      done(200, {
        id: "task-1", title: "Build release", description: "Detailed work",
        workspaceId: null, updatedAt: "2026-10-16T09:00:00Z", sortOrder: 3,
      });
    } else if (pathname === "/api/tasks/task-1" && req.method === "PUT") {
      assert.equal(body.expectedUpdatedAt, "2026-10-16T09:00:00Z");
      assert.equal(body.expectedSortOrder, 3);
      taskReorders++;
      done(200, { id: "task-1", sortOrder: body.sortOrder });
    } else if (pathname === "/api/tasks/task-1/note" && req.method === "POST") {
      assert.equal(body.description, "Detailed work");
      assert.equal(body.expectedTaskUpdatedAt, "2026-10-16T09:00:00Z");
      assert.equal(body.expectedTaskTitle, "Build release");
      assert.equal(body.expectedTaskDescription, "Detailed work");
      assert.match(body.requestId, /^[a-f0-9-]{36}$/);
      snapshots++;
      done(201, { id: "saved-note", title: body.title });
    } else {
      done(404, { code: "NOT_FOUND", pathname });
    }
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  const address = backend.address();
  assert.ok(address && typeof address !== "string");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [root],
    env: {
      ...process.env, NOWEN_URL: `http://127.0.0.1:${address.port}`,
      NOWEN_API_TOKEN: "p1-integration-token",
      MCP_ACCESS_MODE: "read-write",
    } as Record<string, string>,
  });
  const client = new Client({ name: "nowen-p1-test", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    for (const name of ["nowen_list_file_folders", "nowen_list_managed_files", "nowen_preview_file_change",
      "nowen_apply_file_change", "nowen_list_file_trash", "nowen_preview_task_to_note", "nowen_save_task_to_note"]) {
      assert.ok(tools.tools.some((tool) => tool.name === name), name);
    }
    const listed = await client.callTool({ name: "nowen_list_managed_files", arguments: {} });
    assert.equal(JSON.parse(asText(listed)).items[0].id, "file-a");
    const missingTarget = await client.callTool({
      name: "nowen_preview_file_change",
      arguments: { operation: "move_files", fileIds: ["file-a"] },
    });
    assert.equal(missingTarget.isError, true, "file move must explicitly choose root or a folder");
    const prev = await client.callTool({
      name: "nowen_preview_file_change", arguments: {
        operation: "move_files", fileIds: ["file-a"], parentId: null,
      },
    });
    assert.ok(!prev.isError, asText(prev));
    const preview = JSON.parse(asText(prev));
    assert.equal(preview.snapshot.files[0].folderId, "folder-a");
    const invalid = await client.callTool({
      name: "nowen_apply_file_change", arguments: {
        operation: "move_files", fileIds: ["file-a"], parentId: null,
        expectedRevision: preview.revision, confirmation: "RESTORE_FILES",
      },
    });
    assert.equal(invalid.isError, true);
    assert.equal(moved, 0);
    const applied = await client.callTool({
      name: "nowen_apply_file_change", arguments: {
        operation: "move_files", fileIds: ["file-a"], parentId: null,
        expectedRevision: preview.revision, confirmation: "APPLY_FILE_CHANGE",
      },
    });
    assert.ok(!applied.isError, asText(applied));
    assert.equal(moved, 1);
    const stale = await client.callTool({
      name: "nowen_apply_file_change", arguments: {
        operation: "move_files", fileIds: ["file-a"], parentId: null,
        expectedRevision: preview.revision, confirmation: "APPLY_FILE_CHANGE",
      },
    });
    assert.equal(stale.isError, true);
    assert.equal(moved, 1);
    const folderPreview = JSON.parse(asText(await client.callTool({
      name: "nowen_preview_file_change", arguments: { operation: "create_folder", name: "AI", parentId: null },
    })));
    assert.ok(!folderPreview.isError);
    const folderResult = await client.callTool({
      name: "nowen_apply_file_change", arguments: {
        operation: "create_folder", name: "AI", parentId: null,
        expectedRevision: folderPreview.revision, confirmation: "APPLY_FILE_CHANGE",
      },
    });
    assert.ok(!folderResult.isError, asText(folderResult));
    assert.equal(folderWrites, 1);
    const trashed = await client.callTool({ name: "nowen_list_file_trash", arguments: { page: 1 } });
    assert.ok(!trashed.isError, asText(trashed));
    assert.equal(JSON.parse(asText(trashed)).entries[0].id, "trashed-a");
    const restorePreview = JSON.parse(asText(await client.callTool({
      name: "nowen_preview_file_change",
      arguments: { operation: "restore_files", fileIds: ["trashed-a"], page: 1 },
    })));
    assert.equal(restorePreview.snapshot.restoreSnapshot["trashed-a"], "2026-10-16T00:00:00Z");
    const restored = await client.callTool({
      name: "nowen_apply_file_change",
      arguments: {
        operation: "restore_files", fileIds: ["trashed-a"], page: 1,
        expectedRevision: restorePreview.revision, confirmation: "RESTORE_FILES",
      },
    });
    assert.ok(!restored.isError, asText(restored));
    assert.equal(trashRestores, 1);

    const taskPreview = JSON.parse(asText(await client.callTool({
      name: "nowen_preview_task_to_note", arguments: { taskId: "task-1", notebookId: "notebook-1" },
    })));
    const deniedSave = await client.callTool({
      name: "nowen_save_task_to_note", arguments: {
        taskId: "task-1", notebookId: "notebook-1",
        expectedRevision: "0".repeat(64), confirmation: "SAVE_TASK_NOTE",
      },
    });
    assert.equal(deniedSave.isError, true);
    assert.equal(snapshots, 0);
    const saved = await client.callTool({
      name: "nowen_save_task_to_note", arguments: {
        taskId: "task-1", notebookId: "notebook-1",
        expectedRevision: taskPreview.revision, confirmation: "SAVE_TASK_NOTE",
      },
    });
    assert.ok(!saved.isError, asText(saved));
    assert.equal(JSON.parse(asText(saved)).originalTaskRetained, true);
    const taskOrderPreview = JSON.parse(asText(await client.callTool({
      name: "nowen_reorder_task", arguments: { taskId: "task-1", sortOrder: 10 },
    })));
    assert.equal(taskOrderPreview.currentSortOrder, 3);
    const ordered = await client.callTool({
      name: "nowen_reorder_task", arguments: {
        taskId: "task-1", sortOrder: 10, dryRun: false,
        expectedUpdatedAt: taskOrderPreview.updatedAt,
        expectedSortOrder: taskOrderPreview.currentSortOrder,
        confirmation: "REORDER_TASK",
      },
    });
    assert.ok(!ordered.isError, asText(ordered));
    assert.equal(taskReorders, 1);
    assert.equal(snapshots, 1);
    assert.equal(loginCalls, 0, "PAT must never fall back to username/password");
    assert.equal(trashRestores, 1);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  }
});
