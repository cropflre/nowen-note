/**
 * MigrationEngine（D-2/D-3/D-4 三阶段：本期实现 D-2 轻量数据）
 *
 * 角色：编排"两端 backend"——双 token 调度器。
 *   - 本地端：从 Electron 内嵌后端拉数据（地址 = http://127.0.0.1:<port>，token = 本地 token）
 *   - 云端：往用户填写的远程地址写数据（token = 用户登录得到的远程 token）
 *
 * 调用方（NavRail "切换到云端账号"按钮）的流程：
 *   1. 拉起一个登录弹窗让用户填云端地址 + 账号密码
 *   2. 拿到 cloudToken 后调 MigrationEngine.run({...})
 *   3. UI 用 progress 回调实时更新进度条
 *   4. 成功后：写入云端 server-url + token，清掉 prefer-cloud 标记，reload
 */

export interface MigrationEndpoint {
  /** 例如 http://127.0.0.1:23456，结尾不带斜杠 */
  baseUrl: string;
  /** 登录 JWT */
  token: string;
}

export interface MigrationProgress {
  phase: "export" | "import" | "attachments" | "rewrite" | "done";
  /** 0~1 */
  ratio: number;
  message: string;
}

export interface MigrationResult {
  imported: { notebooks: number; notes: number; tags: number; noteTags: number; noteVersions?: number };
  /** 旧 ID → 新 ID，D-3 上传附件时用 */
  idMap: {
    notebooks: Record<string, string>;
    notes: Record<string, string>;
    tags: Record<string, string>;
  };
  /** D-3 附件迁移结果（有则填充上） */
  attachments?: {
    total: number;
    succeeded: number;
    failed: Array<{ id: string; filename: string; reason: string }>;
    /** old attId → new attId */
    idMap: Record<string, string>;
    /** content 重写结果 */
    rewrite: { rewritten: number; skipped: number };
  };
}

export class MigrationError extends Error {
  constructor(
    message: string,
    public stage: "preflight" | "export" | "import" | "attachments" | "rewrite",
    public cause?: unknown,
  ) {
    super(message);
    this.name = "MigrationError";
  }
}

async function jsonFetch(
  endpoint: MigrationEndpoint,
  pathAndQuery: string,
  init?: RequestInit,
): Promise<Response> {
  const url = `${endpoint.baseUrl}/api${pathAndQuery}`;
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${endpoint.token}`);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(url, { ...init, headers });
  return res;
}

interface ServerVersionInfo {
  serverInstanceId?: string;
}

async function fetchServerVersion(endpoint: MigrationEndpoint): Promise<ServerVersionInfo | null> {
  try {
    const headers = new Headers();
    if (endpoint.token) headers.set("Authorization", `Bearer ${endpoint.token}`);
    const res = await fetch(`${endpoint.baseUrl}/api/version`, { headers });
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as ServerVersionInfo | null;
  } catch {
    return null;
  }
}

async function assertDifferentServerInstances(local: MigrationEndpoint, cloud: MigrationEndpoint): Promise<void> {
  const [localVer, cloudVer] = await Promise.all([
    fetchServerVersion(local),
    fetchServerVersion(cloud),
  ]);
  const localId = typeof localVer?.serverInstanceId === "string" ? localVer.serverInstanceId.trim() : "";
  const cloudId = typeof cloudVer?.serverInstanceId === "string" ? cloudVer.serverInstanceId.trim() : "";
  if (localId && cloudId && localId === cloudId) {
    throw new MigrationError(
      "本地服务器和云端服务器是同一台机器，无需迁移。请取消迁移，直接退出登录后用新账号登录即可。",
      "preflight",
    );
  }
}

/**
 * 执行 D-2 轻量迁移：拉本地 → 推云端。
 *
 * 不做的事（本期）：
 *   - 不迁移附件二进制（D-3）
 *   - 不迁移 Yjs 历史（D-4）
 *   - 不做断点续传（一次性事务，失败重头来）
 */
export async function runLightMigration(opts: {
  local: MigrationEndpoint;
  cloud: MigrationEndpoint;
  onProgress?: (p: MigrationProgress) => void;
}): Promise<MigrationResult> {
  const { local, cloud, onProgress } = opts;
  const tick = (p: MigrationProgress) => onProgress?.(p);

  tick({ phase: "export", ratio: 0.01, message: "正在检查迁移目标…" });
  await assertDifferentServerInstances(local, cloud);

  // ===== 1. 从本地导出 =====
  tick({ phase: "export", ratio: 0.05, message: "正在从本地读取数据…" });
  let exportPayload: any;
  try {
    const res = await jsonFetch(local, "/user-migration/export-light");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`本地导出失败 (${res.status}): ${text.slice(0, 200)}`);
    }
    exportPayload = await res.json();
  } catch (e) {
    throw new MigrationError(
      e instanceof Error ? e.message : String(e),
      "export",
      e,
    );
  }

  const counts = {
    notebooks: exportPayload.notebooks?.length ?? 0,
    notes: exportPayload.notes?.length ?? 0,
    tags: exportPayload.tags?.length ?? 0,
  };
  tick({
    phase: "export",
    ratio: 0.4,
    message: `本地数据：${counts.notebooks} 个笔记本 / ${counts.notes} 篇笔记 / ${counts.tags} 个标签`,
  });

  // ===== 2. 推到云端 =====
  tick({ phase: "import", ratio: 0.5, message: "正在写入云端账号…" });
  let importResult: any;
  try {
    const res = await jsonFetch(cloud, "/user-migration/import-light", {
      method: "POST",
      body: JSON.stringify(exportPayload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`云端导入失败 (${res.status}): ${text.slice(0, 200)}`);
    }
    importResult = await res.json();
  } catch (e) {
    throw new MigrationError(
      e instanceof Error ? e.message : String(e),
      "import",
      e,
    );
  }

  tick({
    phase: "done",
    ratio: 1,
    message: `迁移完成：${importResult.imported?.notes ?? 0} 篇笔记`,
  });

  return importResult as MigrationResult;
}

// ============================================================================
// D-3：附件迁移 + content 重写
// ============================================================================

interface LocalAttachment {
  id: string;
  noteId: string;
  filename: string;
  mimeType: string;
  size: number;
}

/**
 * D-3 阶段：把本地附件依次上传到云端，然后调云端重写接口把笔记 content 里的 attId 替换。
 *
 * 调用前提：D-2 已成功，传入 D-2 返回的 idMap.notes。
 *
 * 失败语义：单张附件上传失败 → 跳过并记录。最后一次性 rewrite。
 *           rewrite 失败 → 抛 MigrationError。用户可以重跑。
 */
export async function runAttachmentMigration(opts: {
  local: MigrationEndpoint;
  cloud: MigrationEndpoint;
  /** D-2 返回的 noteIdMap：本地旧 noteId → 云端新 noteId */
  noteIdMap: Record<string, string>;
  onProgress?: (p: MigrationProgress) => void;
}): Promise<NonNullable<MigrationResult["attachments"]>> {
  const { local, cloud, noteIdMap, onProgress } = opts;
  const tick = (p: MigrationProgress) => onProgress?.(p);

  tick({ phase: "attachments", ratio: 0, message: "确认迁移目标…" });
  await assertDifferentServerInstances(local, cloud);

  // 1) 拉本地附件列表
  tick({ phase: "attachments", ratio: 0, message: "读取本地附件列表…" });
  let list: LocalAttachment[];
  try {
    const res = await jsonFetch(local, "/user-migration/list-attachments");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`本地附件列表读取失败 (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    list = data.attachments || [];
  } catch (e) {
    throw new MigrationError(
      e instanceof Error ? e.message : String(e),
      "attachments",
      e,
    );
  }

  // 只迁移那些 noteId 在本期 idMap 里的附件（避免脱主附件上传后被云端拒）
  const target = list.filter((a) => noteIdMap[a.noteId]);
  const skipped = list.length - target.length;
  if (skipped > 0) {
    console.warn(`[migration] ${skipped} 个附件其所属笔记不在迁移范围内，已跳过`);
  }

  // 2) 逐个上传
  const attIdMap: Record<string, string> = {};
  const failed: Array<{ id: string; filename: string; reason: string }> = [];
  let succeeded = 0;

  for (let i = 0; i < target.length; i++) {
    const att = target[i];
    const newNoteId = noteIdMap[att.noteId];
    const ratio = target.length === 0 ? 1 : i / target.length;
    tick({
      phase: "attachments",
      ratio,
      message: `上传附件 ${i + 1}/${target.length}：${att.filename}`,
    });

    try {
      // a) 从本地 GET 拿 binary。这个接口免 JWT，但为了一致性还是不带 token。
      const downloadUrl = `${local.baseUrl}/api/attachments/${att.id}`;
      const dlRes = await fetch(downloadUrl);
      if (!dlRes.ok) {
        failed.push({ id: att.id, filename: att.filename, reason: `下载失败 ${dlRes.status}` });
        continue;
      }
      const blob = await dlRes.blob();

      // b) POST 到云端 multipart/form-data
      const fd = new FormData();
      fd.append("file", new File([blob], att.filename, { type: att.mimeType || blob.type }));
      fd.append("noteId", newNoteId);

      const upRes = await fetch(`${cloud.baseUrl}/api/attachments`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cloud.token}` },
        body: fd,
      });
      if (!upRes.ok) {
        const t = await upRes.text().catch(() => "");
        failed.push({
          id: att.id,
          filename: att.filename,
          reason: `上传失败 ${upRes.status}: ${t.slice(0, 100)}`,
        });
        continue;
      }
      const upData = await upRes.json();
      if (!upData.id) {
        failed.push({ id: att.id, filename: att.filename, reason: "上传响应缺少 id" });
        continue;
      }
      attIdMap[att.id] = upData.id;
      succeeded++;
    } catch (e: any) {
      failed.push({ id: att.id, filename: att.filename, reason: e?.message || "未知错误" });
    }
  }

  // 3) 重写 content
  tick({ phase: "rewrite", ratio: 0.95, message: "重写笔记内容中的附件链接…" });
  let rewrite = { rewritten: 0, skipped: 0 };
  if (Object.keys(attIdMap).length > 0) {
    try {
      const res = await jsonFetch(cloud, "/user-migration/rewrite-content", {
        method: "POST",
        body: JSON.stringify({
          attMap: attIdMap,
          noteIds: Object.values(noteIdMap),
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`content 重写失败 (${res.status}): ${text.slice(0, 200)}`);
      }
      rewrite = await res.json();
    } catch (e) {
      throw new MigrationError(
        e instanceof Error ? e.message : String(e),
        "rewrite",
        e,
      );
    }
  }

  tick({
    phase: "done",
    ratio: 1,
    message: `附件迁移完成：${succeeded}/${target.length}`,
  });

  return {
    total: target.length,
    succeeded,
    failed,
    idMap: attIdMap,
    rewrite,
  };
}

/**
 * 调试用：可在控制台手工调起。
 *   await runLightMigrationFromCurrentSession({ cloudUrl, cloudToken })
 * 假设当前 localStorage 里 nowen-token 是本地 token（典型场景：桌面零登录态）。
 */
export async function runLightMigrationFromCurrentSession(args: {
  localBaseUrl: string;
  localToken: string;
  cloudBaseUrl: string;
  cloudToken: string;
  onProgress?: (p: MigrationProgress) => void;
}) {
  return runLightMigration({
    local: { baseUrl: args.localBaseUrl, token: args.localToken },
    cloud: { baseUrl: args.cloudBaseUrl, token: args.cloudToken },
    onProgress: args.onProgress,
  });
}

// ============================================================================
// 失败回滚：把已写入云端的笔记本 / 笔记 / 标签 / 附件清掉
// ============================================================================
//
// 调用时机：MigrationModal 的 catch 块——任意一步抛错时，把"已经入库的部分"
//          交给云端 /rollback 删干净，避免账号留半截脏数据。
//
// 入参语义：
//   - notebookIds / noteIds / tagIds：D-2 import-light 返回 idMap 的 values
//   - attachmentIds：D-3 attResult.idMap 的 values（仅成功上传的那些）
//
// 失败语义：rollback 自身失败时不抛异常，只 console.warn——这是"补偿动作"，
//          不能让一次回滚错误把原始报错给吞了；UI 仍显示原始错误。
export async function rollbackMigration(opts: {
  cloud: MigrationEndpoint;
  notebookIds?: string[];
  noteIds?: string[];
  tagIds?: string[];
  attachmentIds?: string[];
}): Promise<{ ok: boolean; removed?: Record<string, number>; error?: string }> {
  const total =
    (opts.notebookIds?.length || 0) +
    (opts.noteIds?.length || 0) +
    (opts.tagIds?.length || 0) +
    (opts.attachmentIds?.length || 0);
  if (total === 0) return { ok: true, removed: { notebooks: 0, notes: 0, tags: 0, attachments: 0 } };

  try {
    const res = await jsonFetch(opts.cloud, "/user-migration/rollback", {
      method: "POST",
      body: JSON.stringify({
        notebookIds: opts.notebookIds || [],
        noteIds: opts.noteIds || [],
        tagIds: opts.tagIds || [],
        attachmentIds: opts.attachmentIds || [],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn("[migration] rollback http error", res.status, text);
      return { ok: false, error: `rollback ${res.status}` };
    }
    const data = await res.json();
    return { ok: true, removed: data.removed };
  } catch (e: any) {
    console.warn("[migration] rollback network error", e);
    return { ok: false, error: e?.message || "rollback failed" };
  }
}
