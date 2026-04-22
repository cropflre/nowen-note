import { Notebook, Note, NoteListItem, Tag, SearchResult, User, UserPublicInfo, Task, TaskStats, TaskFilter, CustomFont, MindMap, MindMapListItem, Diary, DiaryTimeline, DiaryStats, Share, ShareInfo, SharedNoteContent, NoteVersion, ShareComment, Workspace, WorkspaceMember, WorkspaceInvite, WorkspaceRole } from "@/types";

// 服务器地址管理
const SERVER_URL_KEY = "nowen-server-url";

// ========== 当前工作区（Phase 1 协作） ==========
const WORKSPACE_KEY = "nowen-current-workspace";

/**
 * 获取当前激活的工作区 ID
 *   'personal' → 个人空间（默认）
 *   <workspaceId> → 指定工作区
 */
export function getCurrentWorkspace(): string {
  return localStorage.getItem(WORKSPACE_KEY) || "personal";
}

export function setCurrentWorkspace(workspaceId: string) {
  localStorage.setItem(WORKSPACE_KEY, workspaceId);
}

export function clearCurrentWorkspace() {
  localStorage.removeItem(WORKSPACE_KEY);
}

export function getServerUrl(): string {
  return localStorage.getItem(SERVER_URL_KEY) || "";
}

export function setServerUrl(url: string) {
  const normalized = url.replace(/\/+$/, "");
  localStorage.setItem(SERVER_URL_KEY, normalized);
}

export function clearServerUrl() {
  localStorage.removeItem(SERVER_URL_KEY);
}

function getBaseUrl(): string {
  const server = getServerUrl();
  return server ? `${server}/api` : "/api";
}

function getToken(): string | null {
  return localStorage.getItem("nowen-token");
}

/**
 * L10: 退出登录的统一入口。
 *
 * 设计要点：
 *   - 移除本 tab 的 token，同时通过 `nowen-logout-broadcast` 触发 storage 事件，
 *     让其他 tab 的 AuthGate 也一起退出；
 *   - broadcast 的 value 仅用来触发 storage 事件（不能连续写相同值，否则浏览器会
 *     合并掉不派发事件），因此写 Date.now()；
 *   - 只清 token，不动主题、服务器地址、草稿等用户偏好；
 *   - 调用方可选地传 reason，便于埋点/调试。
 */
export function broadcastLogout(reason?: string) {
  // Phase 6: 登出时顺便告诉后端吊销当前 session（不等待结果，失败忽略）。
  //   注意必须在 removeItem 前拿到 token；使用 keepalive 以让浏览器关闭时也尽量发出去。
  try {
    const token = localStorage.getItem("nowen-token");
    if (token) {
      fetch(`${getBaseUrl()}/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem("nowen-token");
    // 其他 tab 监听到该 key 的 storage 事件后会自己 removeItem("nowen-token") 并回登录页
    localStorage.setItem("nowen-logout-broadcast", `${Date.now()}|${reason || ""}`);
    // 立即删除，这样下次登出也能再次触发（避免 value 相同被合并）
    localStorage.removeItem("nowen-logout-broadcast");
  } catch {
    /* 隐私模式下 localStorage 可能不可用，忽略 */
  }
}

/**
 * H2: sudo 二次验证辅助工具。
 *
 * 敏感操作（删除用户 / 重置他人密码 / 改角色 / 禁用 / 恢复出厂设置 / 创建管理员）
 * 必须先调 `/auth/sudo`（输入当前密码）拿到一张 5 分钟的 sudoToken，随后在业务请求
 * 里通过 `X-Sudo-Token` header 携带。
 *
 * 为了减少 UI 层负担，request() 会在 options.sudoToken 存在时自动注入该 header；
 * 失败时（403 SUDO_REQUIRED / SUDO_INVALID）抛出带 code 的错误，UI 层捕获后弹密码
 * 框重取 sudoToken 再重试即可。
 */
interface RequestOptions extends RequestInit {
  sudoToken?: string;
}

async function request<T>(url: string, options?: RequestOptions): Promise<T> {
  const token = getToken();
  const { sudoToken, ...restOptions } = options || {};
  const res = await fetch(`${getBaseUrl()}${url}`, {
    ...restOptions,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(sudoToken ? { "X-Sudo-Token": sudoToken } : {}),
      ...restOptions?.headers,
    },
  });
  // 401 / 403 + ACCOUNT_DISABLED：会话已失效（token 无效、用户被禁用、tokenVersion 被吊销等），
  // 统一清 token 并刷新回登录页。
  // 分享页（/share/:token）是无登录场景，不应 reload —— 否则会把整个分享页刷回登录页。
  const isSharePage = typeof window !== "undefined" && /^\/share\//.test(window.location.pathname);
  if (res.status === 401 || res.status === 403) {
    let errBody: any = {};
    try { errBody = await res.clone().json(); } catch {}
    const code: string | undefined = errBody?.code;
    const sessionRevoked =
      res.status === 401 ||
      code === "ACCOUNT_DISABLED" ||
      code === "TOKEN_REVOKED" ||
      code === "USER_NOT_FOUND" ||
      code === "TOKEN_INVALID" ||
      code === "UNAUTHENTICATED";
    if (sessionRevoked && !isSharePage) {
      // L10: session 被后端吊销 → 广播给其他 tab 一起下线
      broadcastLogout("session_revoked");
      window.location.reload();
      throw new Error(errBody?.error || "未授权");
    }
    if (res.status === 401) {
      throw new Error(errBody?.error || "未授权");
    }
    // 403 非会话吊销 → 走下方通用错误路径
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    // 把 HTTP status 和服务端返回的业务字段挂到 Error 上，调用方（如 EditorPane
    // 的乐观锁 409 reconcile）可以直接用 err.status / err.currentVersion，
    // 不必再靠字符串匹配 err.message。
    // 之前只抛 new Error(msg) → status/currentVersion 全丢，使得 409 风暴里
    // 的兜底路径被迫多发一次 GET /notes/:id，且在某些情况下无法识别 409。
    const error = new Error(err.error || `Request failed: ${res.status}`) as Error & {
      status?: number;
      code?: string;
      currentVersion?: number;
    };
    error.status = res.status;
    if (err && typeof err === "object") {
      if (typeof err.code === "string") error.code = err.code;
      if (typeof err.currentVersion === "number") error.currentVersion = err.currentVersion;
    }
    throw error;
  }
  return res.json();
}

export const api = {
  // Public (no auth required)
  getSiteSettingsPublic: async (): Promise<{ site_title: string; site_favicon: string; editor_font_family: string }> => {
    const res = await fetch(`${getBaseUrl()}/settings`);
    if (!res.ok) return { site_title: "nowen-note", site_favicon: "", editor_font_family: "" };
    return res.json();
  },

  // User
  getMe: () => request<User>("/me"),

  // 用户搜索（所有已登录用户可用）
  searchUsers: (q?: string) => {
    const qs = q ? `?q=${encodeURIComponent(q)}` : "";
    return request<UserPublicInfo[]>(`/users/search${qs}`);
  },

  // 管理员 — 用户管理
  adminListUsers: (params?: { q?: string; role?: "admin" | "user"; status?: "active" | "disabled" }) => {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.role) qs.set("role", params.role);
    if (params?.status) qs.set("status", params.status);
    const s = qs.toString();
    return request<User[]>(`/users${s ? `?${s}` : ""}`);
  },
  // H2: 敏感管理动作需 sudoToken；非敏感字段（仅 username/email/displayName）可留空。
  adminCreateUser: (
    data: { username: string; password: string; email?: string; displayName?: string; role?: "admin" | "user" },
    sudoToken?: string,
  ) => request<User>("/users", { method: "POST", body: JSON.stringify(data), sudoToken }),
  adminUpdateUser: (
    id: string,
    data: Partial<{ username: string; email: string | null; displayName: string | null; role: "admin" | "user"; isDisabled: boolean }>,
    sudoToken?: string,
  ) => request<User>(`/users/${id}`, { method: "PATCH", body: JSON.stringify(data), sudoToken }),
  adminResetUserPassword: (id: string, newPassword: string, sudoToken?: string) =>
    request<{ success: boolean }>(`/users/${id}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ newPassword }),
      sudoToken,
    }),
  /**
   * 删除用户。
   *   - 不传 transferTo：原有语义，用户所有数据随 CASCADE 一起删掉
   *   - 传 transferTo：L3 数据转移，先把被删用户的笔记/工作区/标签/任务等 ownership
   *     迁到 transferTo 用户名下，再删除原账号（整个过程在一个事务里）
   */
  adminDeleteUser: (id: string, sudoToken?: string, transferTo?: string) => {
    const qs = transferTo ? `?transferTo=${encodeURIComponent(transferTo)}` : "";
    return request<{ success: boolean; transferred: boolean; moved?: Record<string, number> }>(
      `/users/${id}${qs}`,
      { method: "DELETE", sudoToken },
    );
  },
  /** L3: 删除预览——统计将被清理或转移的数据量，展示给管理员决策 */
  adminGetUserDataSummary: (id: string) =>
    request<{
      userId: string;
      username: string;
      notebooks: number;
      notes: number;
      tags: number;
      tasks: number;
      diaries: number;
      shares: number;
      ownedWorkspaces: number;
      workspaceMemberships: number;
      noteVersions: number;
      shareComments: number;
      attachments: number;
    }>(`/users/${id}/data-summary`),

  // 注册配置（公开读，管理员写）
  getRegisterConfig: async (baseUrlOverride?: string): Promise<{ allowRegistration: boolean }> => {
    const base = baseUrlOverride ? `${baseUrlOverride.replace(/\/+$/, "")}/api` : getBaseUrl();
    const res = await fetch(`${base}/auth/register/config`);
    if (!res.ok) return { allowRegistration: true };
    return res.json();
  },
  updateRegisterConfig: (allowRegistration: boolean) =>
    request<{ allowRegistration: boolean }>("/auth/register/config", {
      method: "PUT",
      body: JSON.stringify({ allowRegistration }),
    }),

  // Notebooks
  getNotebooks: (workspaceId?: string) => {
    const ws = workspaceId ?? getCurrentWorkspace();
    const qs = ws ? `?workspaceId=${encodeURIComponent(ws)}` : "";
    return request<Notebook[]>(`/notebooks${qs}`);
  },
  createNotebook: (data: Partial<Notebook>) => {
    // 自动带上当前工作区（除非数据里显式带了 workspaceId 或为个人空间）
    const currentWs = getCurrentWorkspace();
    const payload: any = { ...data };
    if (payload.workspaceId === undefined && currentWs && currentWs !== "personal") {
      payload.workspaceId = currentWs;
    }
    return request<Notebook>("/notebooks", { method: "POST", body: JSON.stringify(payload) });
  },
  updateNotebook: (id: string, data: Partial<Notebook>) => request<Notebook>(`/notebooks/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteNotebook: (id: string) => request(`/notebooks/${id}`, { method: "DELETE" }),
  reorderNotebooks: (items: { id: string; sortOrder: number }[]) =>
    request<{ success: boolean }>("/notebooks/reorder/batch", { method: "PUT", body: JSON.stringify({ items }) }),
  moveNotebook: (id: string, data: { parentId?: string | null; sortOrder?: number }) =>
    request<Notebook>(`/notebooks/${id}/move`, { method: "PUT", body: JSON.stringify(data) }),

  // Notes
  getNotes: (params?: Record<string, string>) => {
    // 自动注入 workspaceId（除非调用方显式传入）
    const finalParams: Record<string, string> = { ...(params || {}) };
    if (!("workspaceId" in finalParams)) {
      finalParams.workspaceId = getCurrentWorkspace();
    }
    const qs = "?" + new URLSearchParams(finalParams).toString();
    return request<NoteListItem[]>(`/notes${qs}`);
  },
  getNote: (id: string) => request<Note>(`/notes/${id}`),
  createNote: (data: Partial<Note>) => request<Note>("/notes", { method: "POST", body: JSON.stringify(data) }),
  updateNote: (id: string, data: Partial<Note>) => request<Note>(`/notes/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteNote: (id: string) => request(`/notes/${id}`, { method: "DELETE" }),
  emptyTrash: () =>
    request<{ success: boolean; count: number; skipped: number }>(`/notes/trash/empty`, { method: "DELETE" }),
  reorderNotes: (items: { id: string; sortOrder: number }[]) =>
    request<{ success: boolean }>("/notes/reorder/batch", { method: "PUT", body: JSON.stringify({ items }) }),
  /**
   * 释放笔记的 Y.js 房间：销毁服务端内存 Doc，并清空 note_yupdates / note_ysnapshots。
   * MD→RTE 切换时调用，避免下次切回 MD 时恢复出"上次 MD 会话的旧 yDoc"。
   */
  releaseYjsRoom: (id: string) =>
    request<{ success: boolean }>(`/notes/${id}/yjs/release-room`, { method: "POST" }),

  // Tags
  getTags: () => request<Tag[]>("/tags"),
  createTag: (data: Partial<Tag>) => request<Tag>("/tags", { method: "POST", body: JSON.stringify(data) }),
  updateTag: (id: string, data: Partial<Tag>) => request<Tag>(`/tags/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteTag: (id: string) => request(`/tags/${id}`, { method: "DELETE" }),
  addTagToNote: (noteId: string, tagId: string) => request(`/tags/note/${noteId}/tag/${tagId}`, { method: "POST" }),
  removeTagFromNote: (noteId: string, tagId: string) => request(`/tags/note/${noteId}/tag/${tagId}`, { method: "DELETE" }),
  getNotesWithTag: (tagId: string) => request<NoteListItem[]>(`/notes?tagId=${encodeURIComponent(tagId)}`),

  // Search
  search: (q: string) => request<SearchResult[]>(`/search?q=${encodeURIComponent(q)}`),

  // Tasks
  getTasks: (filter?: TaskFilter, noteId?: string) => {
    const params = new URLSearchParams();
    if (filter && filter !== "all") params.set("filter", filter);
    if (noteId) params.set("noteId", noteId);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return request<Task[]>(`/tasks${qs}`);
  },
  getTask: (id: string) => request<Task>(`/tasks/${id}`),
  createTask: (data: Partial<Task>) => request<Task>("/tasks", { method: "POST", body: JSON.stringify(data) }),
  updateTask: (id: string, data: Partial<Task>) => request<Task>(`/tasks/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  toggleTask: (id: string) => request<Task>(`/tasks/${id}/toggle`, { method: "PATCH" }),
  deleteTask: (id: string) => request(`/tasks/${id}`, { method: "DELETE" }),
  getTaskStats: () => request<TaskStats>("/tasks/stats/summary"),

  // Security
  // 注意：后端在修改密码成功后会 bump tokenVersion，让其它端旧 token 立即失效，
  //      同时下发一张新 token 给当前请求方。前端必须把新 token 写回 localStorage，
  //      否则当前 tab 的下次请求会被当成"旧 token"拒绝。
  updateSecurity: async (data: { currentPassword: string; newUsername?: string; newPassword?: string }) => {
    const res = await request<{ success: boolean; message: string; token?: string }>(
      "/auth/change-password",
      { method: "POST", body: JSON.stringify(data) },
    );
    if (res.token) {
      try { localStorage.setItem("nowen-token", res.token); } catch {}
    }
    return res;
  },
  factoryReset: async (confirmText: string, sudoToken?: string) => {
    // factory-reset 同样会 bump tokenVersion 并下发新 token，必须更新本地存储，
    // 否则管理员当前 tab 会立刻收到 401 被踢下线。
    const res = await request<{ success: boolean; message: string; token?: string; mustChangePassword?: boolean }>(
      "/auth/factory-reset",
      { method: "POST", body: JSON.stringify({ confirmText }), sudoToken },
    );
    if (res.token) {
      try { localStorage.setItem("nowen-token", res.token); } catch {}
    }
    return res;
  },

  /**
   * H2: 用当前密码换取短期 sudo token（有效期后端控制，目前 5 分钟）。
   * UI 层在触发敏感操作前先调用它；抛错时通常是密码错误或 429 限流。
   */
  requestSudoToken: (password: string) =>
    request<{ sudoToken: string; expiresIn: number }>("/auth/sudo", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  // ========== Phase 6: 2FA（TOTP）==========
  //
  // 前端 UI 流程：
  //   1. setup → 拿到 otpauthUri，显示二维码（或纯密钥）；
  //   2. 用户扫码后输入 6 位码 → activate，拿到 recoveryCodes（明文仅此一次）；
  //   3. disable 需要 sudoToken + 当前 6 位码（或 recovery code）；
  //   4. 登录第二步：LoginPage 拿着 ticket+code 走 /auth/2fa/verify（见 LoginPage）。

  getTwoFactorStatus: () =>
    request<{ enabled: boolean; enabledAt: string | null; recoveryCodesRemaining: number }>(
      "/auth/2fa/status",
    ),
  /** 生成 pending secret，返回 otpauth URI 和一张 5 分钟有效的 pending 令牌 */
  setupTwoFactor: () =>
    request<{ secret: string; otpauthUri: string; pending: string }>("/auth/2fa/setup", {
      method: "POST",
    }),
  /** 提交 pending 和扫码得到的 6 位 TOTP，启用 2FA 并返回明文恢复码 */
  activateTwoFactor: (pending: string, code: string) =>
    request<{ success: boolean; recoveryCodes: string[] }>("/auth/2fa/activate", {
      method: "POST",
      body: JSON.stringify({ pending, code }),
    }),
  /** 关闭 2FA（需 sudo + 当前 6 位码或恢复码） */
  disableTwoFactor: (code: string, sudoToken?: string) =>
    request<{ success: boolean }>("/auth/2fa/disable", {
      method: "POST",
      body: JSON.stringify({ code }),
      sudoToken,
    }),
  /** 重新生成恢复码（作废旧的，需 sudo） */
  regenerateRecoveryCodes: (sudoToken?: string) =>
    request<{ recoveryCodes: string[] }>("/auth/2fa/regenerate-recovery-codes", {
      method: "POST",
      sudoToken,
    }),

  // ========== Phase 6: 会话管理 ==========
  //
  // 展示当前用户所有活跃 session（包含自己当前的 current=true）；支持单个吊销、
  // 批量下线其他端。吊销仅更新 user_sessions.revokedAt，不会 bump tokenVersion，
  // 因此不会误踢其他还在线的设备。

  listSessions: () =>
    request<{
      sessions: Array<{
        id: string;
        createdAt: string;
        lastSeenAt: string;
        expiresAt: string | null;
        ip: string;
        userAgent: string;
        deviceLabel: string | null;
        current: boolean;
      }>;
      currentSessionId: string | null;
    }>("/auth/sessions"),
  revokeSession: (id: string) =>
    request<{ success: boolean }>(`/auth/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  /** 一键下线其他端（默认保留当前 session；keepCurrent=false 则全部下线）*/
  revokeOtherSessions: (keepCurrent = true) =>
    request<{ success: boolean; revoked: number }>(
      `/auth/sessions${keepCurrent ? "" : "?keepCurrent=0"}`,
      { method: "DELETE" },
    ),

  /**
   * 登出：通知后端把当前 session 的 revokedAt 置非 NULL，防止被踢下线后 token 被复用。
   * 无论成功失败都不应阻塞前端清 token 的流程，因此使用方直接忽略异常即可。
   */
  logout: () =>
    request<{ success: boolean }>("/auth/logout", { method: "POST" }).catch(() => ({ success: false })),

  // Export / Import
  getExportNotes: () => request<any[]>("/export/notes"),
  importNotes: (
    notes: { title: string; content: string; contentText: string; createdAt?: string; updatedAt?: string; notebookName?: string; notebookPath?: string[] }[],
    notebookId?: string,
    notebookName?: string,
  ) =>
    request<{ success: boolean; count: number; notebookId: string; notebookIds?: string[]; notes: any[] }>("/export/import", {
      method: "POST",
      body: JSON.stringify({ notes, notebookId, notebookName }),
    }),

  // Site Settings
  getSiteSettings: () => request<{ site_title: string; site_favicon: string; editor_font_family: string }>("/settings"),
  updateSiteSettings: (data: { site_title?: string; site_favicon?: string; editor_font_family?: string }) =>
    request<{ site_title: string; site_favicon: string; editor_font_family: string }>("/settings", {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  // Fonts
  getFonts: () => request<CustomFont[]>("/fonts"),
  getFontsPublic: async (): Promise<CustomFont[]> => {
    const res = await fetch(`${getBaseUrl()}/fonts`);
    if (!res.ok) return [];
    return res.json();
  },
  uploadFonts: async (files: FileList | File[]): Promise<{ uploaded: CustomFont[]; errors: string[] }> => {
    const token = getToken();
    const form = new FormData();
    for (const file of Array.from(files)) {
      form.append("files", file);
    }
    const res = await fetch(`${getBaseUrl()}/fonts/upload`, {
      method: "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "上传失败");
    }
    return res.json();
  },
  deleteFont: (id: string) => request(`/fonts/${id}`, { method: "DELETE" }),
  getFontFileUrl: (id: string) => `${getBaseUrl()}/fonts/file/${id}`,

  // Mi Cloud
  miCloudVerify: (cookie: string) =>
    request<{ valid: boolean; error?: string }>("/micloud/verify", {
      method: "POST",
      body: JSON.stringify({ cookie }),
    }),
  miCloudNotes: (cookie: string) =>
    request<{ notes: any[]; folders: Record<string, string> }>("/micloud/notes", {
      method: "POST",
      body: JSON.stringify({ cookie }),
    }),
  miCloudImport: (cookie: string, noteIds: string[], notebookId?: string) =>
    request<{ success: boolean; count: number; errors: string[] }>("/micloud/import", {
      method: "POST",
      body: JSON.stringify({ cookie, noteIds, notebookId }),
    }),

  // OPPO Cloud
  oppoCloudImport: (notes: { id: string; title: string; content: string }[], notebookId?: string) =>
    request<{ success: boolean; count: number; notebookId: string; notes: any[]; errors: string[] }>("/oppocloud/import", {
      method: "POST",
      body: JSON.stringify({ notes, notebookId }),
    }),

  // iCloud (iPhone 备忘录)
  icloudImport: (notes: { id: string; title: string; content: string; folder?: string; date?: string; createDate?: string; modifyDate?: string }[], notebookId?: string) =>
    request<{ success: boolean; count: number; notebookId: string; notes: any[]; errors: string[] }>("/icloud/import", {
      method: "POST",
      body: JSON.stringify({ notes, notebookId }),
    }),

  // Mind Maps
  getMindMaps: () => request<MindMapListItem[]>("/mindmaps"),
  getMindMap: (id: string) => request<MindMap>(`/mindmaps/${id}`),
  createMindMap: (data: { title?: string; data?: string }) =>
    request<MindMap>("/mindmaps", { method: "POST", body: JSON.stringify(data) }),
  updateMindMap: (id: string, data: { title?: string; data?: string }) =>
    request<MindMap>(`/mindmaps/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteMindMap: (id: string) => request(`/mindmaps/${id}`, { method: "DELETE" }),

  // Diary (说说/动态)
  postDiary: (data: { contentText: string; mood?: string }) =>
    request<Diary>("/diary", { method: "POST", body: JSON.stringify(data) }),
  getDiaryTimeline: (cursor?: string, limit?: number) => {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    if (limit) params.set("limit", String(limit));
    const qs = params.toString();
    return request<DiaryTimeline>(`/diary/timeline${qs ? `?${qs}` : ""}`);
  },
  deleteDiary: (id: string) => request(`/diary/${id}`, { method: "DELETE" }),
  getDiaryStats: () => request<DiaryStats>("/diary/stats"),

  // Shares (分享管理)
  createShare: (data: { noteId: string; permission?: string; password?: string; expiresAt?: string; maxViews?: number }) =>
    request<Share>("/shares", { method: "POST", body: JSON.stringify(data) }),
  getShares: () => request<Share[]>("/shares"),
  getSharesByNote: (noteId: string) => request<Share[]>(`/shares/note/${noteId}`),
  getShare: (id: string) => request<Share>(`/shares/${id}`),
  updateShare: (id: string, data: Partial<{ permission: string; password: string; expiresAt: string; maxViews: number; isActive: number }>) =>
    request<Share>(`/shares/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteShare: (id: string) => request(`/shares/${id}`, { method: "DELETE" }),

  // 分享状态批量查询
  getSharedNoteIds: () => request<string[]>("/shares/status/batch"),

  // 版本历史
  getNoteVersions: (noteId: string, limit = 20, offset = 0) =>
    request<{ versions: NoteVersion[]; total: number }>(`/shares/note/${noteId}/versions?limit=${limit}&offset=${offset}`),
  getNoteVersion: (noteId: string, versionId: string) =>
    request<NoteVersion>(`/shares/note/${noteId}/versions/${versionId}`),
  restoreNoteVersion: (noteId: string, versionId: string) =>
    request<Note>(`/shares/note/${noteId}/versions/${versionId}/restore`, { method: "POST" }),
  clearNoteVersions: (noteId: string) =>
    request<{ success: boolean; count: number }>(`/shares/note/${noteId}/versions`, { method: "DELETE" }),

  // 评论批注
  getNoteComments: (noteId: string) => request<ShareComment[]>(`/shares/note/${noteId}/comments`),
  addNoteComment: (noteId: string, data: { content: string; parentId?: string; anchorData?: string }) =>
    request<ShareComment>(`/shares/note/${noteId}/comments`, { method: "POST", body: JSON.stringify(data) }),
  deleteNoteComment: (noteId: string, commentId: string) =>
    request(`/shares/note/${noteId}/comments/${commentId}`, { method: "DELETE" }),
  toggleCommentResolved: (noteId: string, commentId: string) =>
    request<ShareComment>(`/shares/note/${noteId}/comments/${commentId}/resolve`, { method: "PATCH" }),

  // Shared (公开访问，无需 JWT)
  getShareInfo: async (token: string): Promise<ShareInfo> => {
    const res = await fetch(`${getBaseUrl()}/shared/${token}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `请求失败: ${res.status}`);
    }
    return res.json();
  },
  verifySharePassword: async (token: string, password: string): Promise<{ success: boolean; accessToken: string }> => {
    const res = await fetch(`${getBaseUrl()}/shared/${token}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `请求失败: ${res.status}`);
    }
    return res.json();
  },
  getSharedContent: async (token: string, accessToken?: string): Promise<SharedNoteContent> => {
    const headers: Record<string, string> = {};
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
    const res = await fetch(`${getBaseUrl()}/shared/${token}/content`, { headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `请求失败: ${res.status}`);
    }
    return res.json();
  },

  /**
   * 访客更新分享笔记内容（仅当 share.permission === 'edit'）
   * - guestName 必填，后端用于版本历史 changeSummary 审计
   * - version 由调用方带上用于乐观锁；冲突时后端返回 409
   * - accessToken 仅在密码分享时需要
   */
  updateSharedContent: async (
    token: string,
    data: { title?: string; content: string; contentText: string; version?: number; guestName: string },
    accessToken?: string,
  ): Promise<{ success: true; noteId: string; title: string; version: number; updatedAt: string; guestName: string }> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
    const res = await fetch(`${getBaseUrl()}/shared/${token}/content`, {
      method: "PUT",
      headers,
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const error = new Error(err.error || `请求失败: ${res.status}`) as Error & { code?: string; currentVersion?: number; status?: number };
      error.code = err.code;
      error.currentVersion = err.currentVersion;
      error.status = res.status;
      throw error;
    }
    return res.json();
  },

  // Phase 4: 同步轮询
  pollSharedNote: async (token: string, accessToken?: string): Promise<{ version: number; updatedAt: string }> => {
    const headers: Record<string, string> = {};
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
    const res = await fetch(`${getBaseUrl()}/shared/${token}/poll`, { headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `请求失败: ${res.status}`);
    }
    return res.json();
  },

  // 公开评论
  getSharedComments: async (token: string, accessToken?: string): Promise<ShareComment[]> => {
    const headers: Record<string, string> = {};
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
    const res = await fetch(`${getBaseUrl()}/shared/${token}/comments`, { headers });
    if (!res.ok) return [];
    return res.json();
  },
  addSharedComment: async (token: string, data: { content: string; parentId?: string; guestName?: string }, accessToken?: string): Promise<ShareComment> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
    const res = await fetch(`${getBaseUrl()}/shared/${token}/comments`, {
      method: "POST", headers, body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `请求失败: ${res.status}`);
    }
    return res.json();
  },

  // AI
  getAISettings: () =>
    request<{ ai_provider: string; ai_api_url: string; ai_api_key: string; ai_api_key_set: boolean; ai_model: string }>("/ai/settings"),
  updateAISettings: (data: { ai_provider?: string; ai_api_url?: string; ai_api_key?: string; ai_model?: string }) =>
    request<{ ai_provider: string; ai_api_url: string; ai_api_key: string; ai_api_key_set: boolean; ai_model: string }>("/ai/settings", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  testAIConnection: () =>
    request<{ success: boolean; message?: string; error?: string }>("/ai/test", { method: "POST" }),
  getAIModels: () =>
    request<{ models: { id: string; name: string }[] }>("/ai/models"),
  aiChat: async (action: string, text: string, context?: string, onChunk?: (chunk: string) => void, customPrompt?: string): Promise<string> => {
    const token = getToken();
    const res = await fetch(`${getBaseUrl()}/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ action, text, context, ...(customPrompt ? { customPrompt } : {}) }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `AI 请求失败: ${res.status}`);
    }
    // SSE stream
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let result = "";
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") break;
        result += data;
        onChunk?.(data);
      }
    }
    return result;
  },

  aiAsk: async (
    question: string,
    history?: { role: string; content: string }[],
    onChunk?: (chunk: string) => void,
    onReferences?: (refs: { id: string; title: string }[]) => void
  ): Promise<string> => {
    const token = getToken();
    const res = await fetch(`${getBaseUrl()}/ai/ask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ question, history }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `AI 请求失败: ${res.status}`);
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let result = "";
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("event:")) {
          const event = trimmed.slice(6).trim();
          // Read next data line
          continue;
        }
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") break;
        // Check if this is a references event by trying to parse as JSON array
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed) && parsed[0]?.id && parsed[0]?.title) {
            onReferences?.(parsed);
            continue;
          }
        } catch { /* not JSON, treat as content chunk */ }
        result += data;
        onChunk?.(data);
      }
    }
    return result;
  },

  getKnowledgeStats: async (): Promise<{
    noteCount: number;
    ftsCount: number;
    notebookCount: number;
    tagCount: number;
    recentTopics: string[];
    indexed: boolean;
  }> => {
    const token = getToken();
    const res = await fetch(`${getBaseUrl()}/ai/knowledge-stats`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) throw new Error("获取知识库统计失败");
    return res.json();
  },

  // ③ 文档智能解析
  parseDocument: async (
    file: File,
    options?: { notebookId?: string; formatMode?: "markdown" | "note" }
  ): Promise<{
    success: boolean;
    markdown: string;
    fileName?: string;
    noteId?: string;
    saved?: boolean;
    error?: string;
  }> => {
    const token = getToken();
    const form = new FormData();
    form.append("file", file);
    if (options?.notebookId) form.append("notebookId", options.notebookId);
    if (options?.formatMode) form.append("formatMode", options.formatMode);
    const res = await fetch(`${getBaseUrl()}/ai/parse-document`, {
      method: "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `解析失败: ${res.status}`);
    }
    return res.json();
  },

  // ⑤ 批量 Markdown 格式化
  batchFormatNotes: async (noteIds: string[]): Promise<{
    total: number;
    success: number;
    failed: number;
    results: { id: string; title: string; success: boolean; error?: string }[];
  }> => {
    return request("/ai/batch-format", {
      method: "POST",
      body: JSON.stringify({ noteIds }),
    });
  },

  // ⑥ 知识库文档导入
  importToKnowledge: async (
    files: File[],
    notebookId?: string
  ): Promise<{
    total: number;
    success: number;
    failed: number;
    notebookId: string;
    results: { fileName: string; success: boolean; noteId?: string; error?: string }[];
  }> => {
    const token = getToken();
    const form = new FormData();
    for (const file of files) {
      form.append("files", file);
    }
    if (notebookId) form.append("notebookId", notebookId);
    const res = await fetch(`${getBaseUrl()}/ai/import-to-knowledge`, {
      method: "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `导入失败: ${res.status}`);
    }
    return res.json();
  },

  // ========== Workspaces (Phase 1 多用户协作) ==========
  getWorkspaces: () => request<Workspace[]>("/workspaces"),
  getWorkspace: (id: string) => request<Workspace>(`/workspaces/${id}`),
  createWorkspace: (data: { name: string; description?: string; icon?: string }) =>
    request<Workspace>("/workspaces", { method: "POST", body: JSON.stringify(data) }),
  updateWorkspace: (id: string, data: { name?: string; description?: string; icon?: string }) =>
    request<Workspace>(`/workspaces/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteWorkspace: (id: string) => request(`/workspaces/${id}`, { method: "DELETE" }),
  leaveWorkspace: (id: string) =>
    request<{ success: boolean }>(`/workspaces/${id}/leave`, { method: "POST" }),

  // 成员
  getWorkspaceMembers: (id: string) => request<WorkspaceMember[]>(`/workspaces/${id}/members`),
  updateWorkspaceMember: (id: string, userId: string, role: WorkspaceRole) =>
    request<{ success: boolean }>(`/workspaces/${id}/members/${userId}`, {
      method: "PUT",
      body: JSON.stringify({ role }),
    }),
  removeWorkspaceMember: (id: string, userId: string) =>
    request<{ success: boolean }>(`/workspaces/${id}/members/${userId}`, { method: "DELETE" }),

  // 邀请
  getWorkspaceInvites: (id: string) => request<WorkspaceInvite[]>(`/workspaces/${id}/invites`),
  createWorkspaceInvite: (id: string, data: { role?: WorkspaceRole; maxUses?: number; expiresAt?: string }) =>
    request<WorkspaceInvite>(`/workspaces/${id}/invites`, { method: "POST", body: JSON.stringify(data) }),
  deleteWorkspaceInvite: (id: string, inviteId: string) =>
    request<{ success: boolean }>(`/workspaces/${id}/invites/${inviteId}`, { method: "DELETE" }),
  joinWorkspace: (code: string) =>
    request<{ success: boolean; workspace?: Workspace; role?: WorkspaceRole; alreadyMember?: boolean; workspaceId?: string }>(
      "/workspaces/join",
      { method: "POST", body: JSON.stringify({ code }) },
    ),

};

/**
 * H2: 通用的「先走 sudo，再跑敏感操作」包装器。
 *
 * 用法：
 *   await withSudo(
 *     (t) => api.adminDeleteUser(id, t),
 *     () => prompt("请输入当前密码以确认删除"),
 *   );
 *
 * - `action` 拿到 sudoToken 后执行真实业务请求；
 * - `askPassword` 由 UI 负责弹对话框；返回 null/空串表示用户取消；
 * - 如果后端抛 SUDO_REQUIRED / SUDO_INVALID，会再次调 askPassword 并重试一次；
 * - 其它错误（密码错误、429 等）直接抛给调用方，让 UI 给出提示。
 *
 * 多次敏感动作可以让 UI 层自己缓存 sudoToken（例如一次会话内连续改 3 个用户）。
 */
export async function withSudo<T>(
  action: (sudoToken: string) => Promise<T>,
  askPassword: () => string | null | Promise<string | null>,
  cachedToken?: string | null,
): Promise<{ result: T; sudoToken: string } | null> {
  // 先尝试使用已缓存的 sudoToken（若有）
  if (cachedToken) {
    try {
      const result = await action(cachedToken);
      return { result, sudoToken: cachedToken };
    } catch (e: any) {
      if (e?.code !== "SUDO_REQUIRED" && e?.code !== "SUDO_INVALID") throw e;
      // 过期 / 无效，走下面的询问流程
    }
  }

  const password = await askPassword();
  if (!password) return null; // 用户取消

  const { sudoToken } = await api.requestSudoToken(password);
  const result = await action(sudoToken);
  return { result, sudoToken };
}

// 测试服务器连接（不需要 token）
export async function testServerConnection(serverUrl: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const url = `${serverUrl.replace(/\/+$/, "")}/api/health`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    if (data.status === "ok") return { ok: true };
    return { ok: false, error: "Invalid response" };
  } catch (e: any) {
    if (e.name === "AbortError") return { ok: false, error: "连接超时" };
    return { ok: false, error: e.message || "连接失败" };
  }
}

/**
 * 登录页使用：注册新账号（无需 token）。
 * 可选 baseUrlOverride 让客户端模式下指向外部服务器。
 */
export async function registerAccount(
  data: { username: string; password: string; email?: string; displayName?: string },
  baseUrlOverride?: string,
): Promise<{ token: string; user: User }> {
  const base = baseUrlOverride ? `${baseUrlOverride.replace(/\/+$/, "")}/api` : getBaseUrl();
  const res = await fetch(`${base}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `注册失败: ${res.status}`);
  return json;
}

/**
 * 登录页使用：查询注册开关（无需 token）。
 */
export async function fetchRegisterConfig(baseUrlOverride?: string): Promise<{ allowRegistration: boolean }> {
  const base = baseUrlOverride ? `${baseUrlOverride.replace(/\/+$/, "")}/api` : getBaseUrl();
  try {
    const res = await fetch(`${base}/auth/register/config`);
    if (!res.ok) return { allowRegistration: true };
    return await res.json();
  } catch {
    return { allowRegistration: true };
  }
}
