import { api, getBaseUrl } from "./api";

export interface MiNoteEntry {
  id: string;
  title: string;
  snippet: string;
  folderId: string;
  folderName: string;
  createDate: number;
  modifyDate: number;
  colorId: number;
  selected: boolean;
}

export interface MiCloudState {
  phase: "idle" | "verifying" | "loading" | "ready" | "importing" | "done" | "error";
  message: string;
  notes: MiNoteEntry[];
  folders: Record<string, string>;
  importedCount: number;
}

interface MiCloudImportBatchResponse {
  success: boolean;
  count: number;
  notebookId?: string;
  errors?: string[];
}

const MI_CLOUD_COOKIE_KEY = "mi-cloud-cookie";

// 通用 API request() 会给 POST 请求设置 30 秒超时。小米云导入需要逐条拉取详情和图片，
// 大批量导入不可能在 30 秒内完成，因此这里把一次大请求拆成多个短批次，并给每个
// 批次独立的长任务超时。这样 600+ 条笔记也不会因为总耗时过长被 AbortController 中断。
export const MI_CLOUD_IMPORT_BATCH_SIZE = 8;
export const MI_CLOUD_IMPORT_BATCH_TIMEOUT_MS = 5 * 60 * 1000;

// 保存 cookie 到 sessionStorage（不持久化到 localStorage，安全考虑）
//
// 在受限的 WebView 环境（部分 Capacitor / Android System WebView 隐私模式 /
// 宿主 app 关闭存储权限）下，sessionStorage 访问会同步抛 SecurityError。
// MiCloudImport 在函数体里 `useState(getMiCookie())` 即触发同步访问，一旦
// 抛错且没有 ErrorBoundary 兜底，就会把整个 SettingsModal 卸掉。
// 这里统一吞掉异常退化为"读不到 / 写不进"，既不影响其它 storage 可用环境，
// 也彻底切断"sessionStorage 不可用 → 模态框崩溃"这条链路。
export function saveMiCookie(cookie: string) {
  try {
    sessionStorage.setItem(MI_CLOUD_COOKIE_KEY, cookie);
  } catch {
    // sessionStorage 不可用：静默忽略，本次会话内 cookie 不持久化即可。
  }
}

export function getMiCookie(): string {
  try {
    return sessionStorage.getItem(MI_CLOUD_COOKIE_KEY) || "";
  } catch {
    return "";
  }
}

export function clearMiCookie() {
  try {
    sessionStorage.removeItem(MI_CLOUD_COOKIE_KEY);
  } catch {
    // 同上：访问受限时无所谓"清不掉"。
  }
}

// 验证 Cookie
export async function verifyMiCookie(cookie: string): Promise<{ valid: boolean; error?: string }> {
  const res = await api.miCloudVerify(cookie);
  return res;
}

// 获取笔记列表
export async function fetchMiNotes(cookie: string): Promise<{
  notes: MiNoteEntry[];
  folders: Record<string, string>;
}> {
  const res = await api.miCloudNotes(cookie);
  return {
    notes: res.notes.map((n: any) => ({ ...n, selected: true })),
    folders: res.folders,
  };
}

function splitIntoImportBatches(noteIds: string[]): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < noteIds.length; index += MI_CLOUD_IMPORT_BATCH_SIZE) {
    batches.push(noteIds.slice(index, index + MI_CLOUD_IMPORT_BATCH_SIZE));
  }
  return batches;
}

function readAuthToken(): string | null {
  try {
    return localStorage.getItem("nowen-token");
  } catch {
    return null;
  }
}

async function importMiNoteBatch(
  cookie: string,
  noteIds: string[],
  notebookId?: string,
): Promise<MiCloudImportBatchResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, MI_CLOUD_IMPORT_BATCH_TIMEOUT_MS);

  try {
    const token = readAuthToken();
    const response = await fetch(`${getBaseUrl()}/micloud/import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/vnd.nowen.internal-note+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ cookie, noteIds, notebookId }),
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => ({}))) as Partial<MiCloudImportBatchResponse> & {
      error?: string;
    };

    if (!response.ok) {
      throw new Error(payload.error || `小米笔记导入失败: ${response.status}`);
    }

    return {
      success: payload.success !== false,
      count: typeof payload.count === "number" ? payload.count : 0,
      notebookId: typeof payload.notebookId === "string" ? payload.notebookId : undefined,
      errors: Array.isArray(payload.errors) ? payload.errors : [],
    };
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (timedOut || name === "AbortError") {
      throw new Error(
        "当前批次导入超时。服务端可能仍在处理，请稍后刷新目标笔记本确认结果，避免重复导入。",
      );
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

// 导入选中的笔记。
//
// 后端接口会在响应前逐条读取小米云详情和图片。这里按固定小批次串行调用：
// 1. 避免通用 POST 30 秒超时终止整个 600+ 条导入；
// 2. 避免一次请求体和服务端内存过大；
// 3. 第一批自动创建目标笔记本后，后续批次复用返回的 notebookId。
export async function importMiNotes(
  cookie: string,
  noteIds: string[],
  notebookId?: string
): Promise<{ success: boolean; count: number; errors: string[] }> {
  const uniqueNoteIds = Array.from(new Set(noteIds.filter((id) => typeof id === "string" && id.length > 0)));
  if (uniqueNoteIds.length === 0) {
    return { success: false, count: 0, errors: ["请选择要导入的笔记"] };
  }

  const batches = splitIntoImportBatches(uniqueNoteIds);
  const errors: string[] = [];
  let importedCount = 0;
  let processedCount = 0;
  let targetNotebookId = notebookId;

  for (const batch of batches) {
    try {
      const result = await importMiNoteBatch(cookie, batch, targetNotebookId);
      importedCount += result.count;
      processedCount += batch.length;
      errors.push(...(result.errors || []));
      if (!targetNotebookId && result.notebookId) {
        targetNotebookId = result.notebookId;
      }
    } catch (error) {
      const remainingCount = uniqueNoteIds.length - processedCount;
      const reason = error instanceof Error ? error.message : String(error || "未知错误");
      const prefix = importedCount > 0
        ? `已成功导入 ${importedCount} 条，剩余 ${remainingCount} 条未完成。`
        : "";
      throw new Error(`${prefix}${reason}`);
    }
  }

  return {
    success: importedCount > 0,
    count: importedCount,
    errors,
  };
}
