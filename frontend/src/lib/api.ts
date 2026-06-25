import { Notebook, NotebookMember, NotebookShareLink, Note, NoteListItem, Tag, SearchResult, User, UserPublicInfo, Task, TaskStats, TaskFilter, CustomFont, MindMap, MindMapListItem, Diary, DiaryMediaItem, DiaryTimeline, DiaryStats, Share, ShareInfo, SharedNoteContent, NoteVersion, ShareComment, Workspace, WorkspaceAdminItem, WorkspaceMember, WorkspaceInvite, WorkspaceRole, WorkspaceFeatures, FileItem, FileDetail, FileListResponse, FileStats, FileSortKey, FileCategory, FileFilter, FileMyUploadsRef } from "@/types";

export type TaskMutationResponse = { task: Task; generatedTask: Task | null };
import {
  shouldEnqueue as _shouldEnqueue,
  enqueue as _enqueue,
  inferMutationType as _inferMutationType,
  extractNoteId as _extractNoteId,
  generateLocalNoteId,
} from "@/lib/offlineQueue";
import {
  readNotebooks as _readNotebooks,
  readNotesList as _readNotesList,
  readTags as _readTags,
  readNote as _readNote,
} from "@/lib/offlineRead";

import { normalizeServerBaseUrl as _normalizeBase } from "@/lib/serverUrl";

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

/**
 * 判定存储的 serverUrl 是否合法。
 * 合法 = 能被 URL() 解析 + 协议是 http/https（或 capacitor 里常见的 capacitor:）。
 * 历史上遇到过写入脏值（例如空串、只写了域名没协议、写成了前端自己的页面 URL）
 * 的情况，导致 `${server}/api` 拼出 "localhost:5173/api" 这种跑到前端静态服务器
 * 的路径，接口返回 index.html，前端再 JSON.parse 就炸 `<!DOCTYPE`。
 */
/**
 * 判定存储的 serverUrl 是否合法（通过 normalizeServerBaseUrl 归一化后非空即合法）。
 */
function isValidServerUrl(url: string): boolean {
  return _normalizeBase(url) !== "";
}

function readServerUrlFromQuery(): string {
  if (typeof window === "undefined") return "";
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("serverUrl") || params.get("nowen-server-url") || "";
    return _normalizeBase(raw);
  } catch {
    return "";
  }
}

function isLoopbackServerUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
  } catch {
    return false;
  }
}

function shouldPreferInjectedServerUrl(stored: string, injected: string): boolean {
  if (!injected) return false;
  if (!stored) return true;
  // Electron full 本地模式每次启动后端端口可能变化；如果二者都是 loopback，
  // 注入地址代表本次真实后端，应覆盖旧端口。
  if (isLoopbackServerUrl(stored) && isLoopbackServerUrl(injected)) return true;
  // 从 full 本地切到 lite 远端时，主进程注入远端 URL；若 storage 里还残留旧本地
  // loopback，以主进程本次注入为准。
  if (isLoopbackServerUrl(stored) && !isLoopbackServerUrl(injected)) return true;
  // 反过来：full 桌面端通过 MigrationModal 手动切云时，loadFile 的 query 仍可能是
  // 本地 loopback。此时不能每次 getServerUrl 都把手动云端地址冲回本地，否则会出现
  // 云端/本地状态抖动甚至反复刷新。
  return false;
}

/**
 * 纯读：返回当前生效的 serverBaseUrl。
 * 不写 localStorage，无副作用。
 */
export function getServerUrl(): string {
  const injected = readServerUrlFromQuery();
  const stored = localStorage.getItem(SERVER_URL_KEY) || "";
  const raw = shouldPreferInjectedServerUrl(stored, injected) ? injected : stored;
  return _normalizeBase(raw);
}

/**
 * 用户主动保存服务器地址（登录页 / 设置页调用）。
 */
export function setServerUrl(url: string) {
  const normalized = _normalizeBase(url);
  if (!normalized) return;
  try { localStorage.setItem(SERVER_URL_KEY, normalized); } catch { /* ignore */ }
}

/**
 * 清除服务器地址。
 */
export function clearServerUrl() {
  try { localStorage.removeItem(SERVER_URL_KEY); } catch { /* ignore */ }
}

/**
 * 应用启动时调用一次，处理：
 *   1. Electron query serverUrl → 迁移到 localStorage
 *   2. 清理非法 stored 值（"null" / "file://" / 空串 / 非 http/https）
 *   3. 归一化 stored 值（去末尾 /、剥离 API 子路径）
 *
 * 调用时机：App.tsx 最顶层 useEffect，仅执行一次。
 */
export function initializeServerUrlFromRuntime(): void {
  const injected = readServerUrlFromQuery();
  const stored = localStorage.getItem(SERVER_URL_KEY) || "";

  // 1. 清理非法 stored 值
  if (stored && !isValidServerUrl(stored)) {
    console.warn("[api] clearing invalid stored serverUrl:", stored);
    try { localStorage.removeItem(SERVER_URL_KEY); } catch { /* ignore */ }
  }

  // 2. 如果注入值更优先，迁移到 localStorage
  if (injected && shouldPreferInjectedServerUrl(stored, injected)) {
    try { localStorage.setItem(SERVER_URL_KEY, injected); } catch { /* ignore */ }
    return;
  }

  // 3. 归一化 stored 值（去末尾 /、剥离 API 子路径等）
  const storedNorm = _normalizeBase(stored);
  if (stored && storedNorm !== stored) {
    try { localStorage.setItem(SERVER_URL_KEY, storedNorm); } catch { /* ignore */ }
  }
}

export function getBaseUrl(): string {
  const server = getServerUrl();
  return server ? `${server}/api` : "/api";
}

// ============================================================================
// SSE 流解析工具（专为 AI 流式接口设计）
// ----------------------------------------------------------------------------
// 为什么需要这个工具？
//   桌面 Chrome 上 fetch().body.getReader() 是真正的"逐 chunk 流"，每次拿到的
//   往往就是一行干净的 `data: {...}\n`，按 \n 拆行就够了。
//   但 Android WebView（System WebView 多个版本 + Capacitor Bridge）行为差异极大：
//     1) 可能直到响应整体结束才一次性把 body 喂回来
//     2) 可能在中间把多帧合并成一坨——表现为 reader.read() 一次返回
//        `data: {"t":"a"}\ndata: {"t":"b"}\n...` 但 \n 被剥成 \r\n / \r / 全没
//     3) 极端情况下 `data:` 前缀也丢了，整段就是 `{"t":"a"}{"t":"b"}{"t":"c"}`
//   截图里"AI 写作助手 · Markdown 格式化"出现的 `{"t":...}{"t":...}` 原样回显，
//   就是症状 (3) 命中——按行拆 + JSON.parse 整块失败 → 落到 catch 把原文塞进 UI。
//
// 设计：
//   1) parseSseChunks 接收一段累积的文本 buffer，返回（已抽出的 data 字符串数组，剩余 buffer）
//      - 同时支持 \n\n、\r\n\r\n（标准）以及 \n / \r\n（部分 server / 代理实现）作为事件边界
//   2) splitConcatenatedJson 把"多个 JSON 对象拼在一起"的字符串按对象拆开
//      —— 用大括号配平 + 字符串感知，比正则可靠
//   3) extractTextFromData 是"针对 AI chunk 的语义层"：
//      接收一段 data 文本，按 {t:"..."} 抽出文本片段；如果整段就是若干 JSON 串接，
//      也能正确逐个解析。无法解析为 JSON 时按"纯文本 chunk"（兼容老格式）处理。
// ----------------------------------------------------------------------------

/**
 * 把 buffer 按 SSE 事件边界切，返回完整事件的 data 内容数组 + 未消费 buffer。
 * 兼容多种行尾：\r\n\r\n（HTTP 标准）、\n\n（文本约定）、单 \n（WebView 合并）。
 */
function parseSseChunks(buffer: string): { events: string[]; rest: string } {
  // 先用"双换行"切事件；切不开就退化为"单换行"按行切
  // 这两条规则覆盖了绝大多数客户端实际收到的形式。
  const events: string[] = [];

  // 归一化 \r\n → \n，避免后面规则各写两份
  const norm = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // 优先按 \n\n 切（每个事件可能含多行 data）
  const parts = norm.split("\n\n");
  // 最后一段可能不完整（没遇到 \n\n），保留到 rest
  const rest = parts.pop() ?? "";

  for (const evt of parts) {
    // 一个事件可能是多行：data:xxx\ndata:yyy → 拼接
    const dataLines: string[] = [];
    for (const line of evt.split("\n")) {
      const ltrim = line.trimStart();
      if (ltrim.startsWith("data:")) {
        dataLines.push(ltrim.slice(5).trimStart());
      }
      // event: / id: / retry: / comment 行直接忽略
    }
    if (dataLines.length > 0) {
      events.push(dataLines.join("\n"));
    }
  }

  // 兜底：如果整段 buffer 一个 \n\n 都没出现（WebView 把分隔符吃光的最坏情况），
  // 但里面已经有完整的 `data:` 行——按单 \n 拆，凡是已经成行（后面跟着另一条 data:
  // 或 buffer 末尾出现完整 JSON）的都先吐出去；剩下不完整的留到 rest。
  // 简化策略：只有当 events 为空、且 rest 中含多个 "data:" 时，才走这个分支，
  // 把除最后一行之外的每条 data: 行都抽出来。
  if (events.length === 0 && (rest.match(/data:/g)?.length ?? 0) >= 2) {
    const lines = rest.split("\n");
    const last = lines.pop() ?? "";
    for (const line of lines) {
      const ltrim = line.trimStart();
      if (ltrim.startsWith("data:")) {
        events.push(ltrim.slice(5).trimStart());
      }
    }
    return { events, rest: last };
  }

  return { events, rest };
}

/**
 * 把一段"可能是多个 JSON 对象拼接"的文本，按顶层对象拆成数组。
 * 例：'{"t":"a"}{"t":"b"}{"t":"c"}' → ['{"t":"a"}','{"t":"b"}','{"t":"c"}']
 *
 * 用大括号深度计数；字符串内的 { } 不计入；处理转义。
 * 拆不出多个对象时返回 [input]，调用方按原样走 fallback。
 */
function splitConcatenatedJson(input: string): string[] {
  const s = input.trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return [s];

  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let escape = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && start !== -1) {
        out.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }

  // 没成功拆出任何完整对象 / 多余尾巴：返回原串让上游用通用兜底
  if (out.length === 0) return [s];
  return out;
}

/**
 * 把一段 SSE data 文本解析成 0..N 个"内容片段"。
 *   - 标准帧：单个 {"t":"..."} → 返回 [t]
 *   - WebView 合并帧：多个 {...}{...}{...} 拼接 → 拆开后每个抽 t
 *   - 数组帧：[{id,title},...] → 通过 onArray 回调分发，不进文本流
 *   - 老格式 / 非 JSON / [DONE] → 调用方处理
 */
function extractContentChunks(
  data: string,
  onArray?: (arr: any[]) => void,
): string[] {
  if (data === "[DONE]") return [];
  const isControlObject = (value: unknown) =>
    !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as { mode?: unknown }).mode === "string"
    && typeof (value as { t?: unknown }).t !== "string";

  // 直接试一次 JSON.parse；最常见的"一个 data: 一个对象"情况这里就直接搞定
  try {
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      onArray?.(parsed);
      return [];
    }
    if (parsed && typeof parsed === "object" && typeof parsed.t === "string") {
      return [parsed.t];
    }
    if (isControlObject(parsed)) {
      return [];
    }
  } catch {
    /* 落到下面继续尝试拆分 */
  }

  // 拼接的多对象 / 老格式纯文本
  const parts = splitConcatenatedJson(data);
  if (parts.length > 1) {
    const out: string[] = [];
    for (const p of parts) {
      try {
        const obj = JSON.parse(p);
        if (Array.isArray(obj)) {
          onArray?.(obj);
          continue;
        }
        if (obj && typeof obj === "object" && typeof obj.t === "string") {
          out.push(obj.t);
          continue;
        }
        if (isControlObject(obj)) {
          continue;
        }
        // 解析成功但不是预期结构，按文本兜底
        out.push(p);
      } catch {
        out.push(p);
      }
    }
    return out;
  }

  // 真正的纯文本老格式（无大括号 / 解析失败的单段）
  return [data];
}


/**
 * 把一个附件 URL（可能是相对路径，也可能是旧数据里的 /api/attachments/xxx）
 * 规范化成当前运行环境可访问的 URL。
 *
 * 为什么需要这个：
 *   - 后端写进笔记里的 attachment URL 是 `/api/attachments/<id>` 相对路径。
 *   - Web 端前端与后端同源时没问题；
 *   - 但原生 App / Capacitor / 某些把前端静态部署到独立域的场景，浏览器会
 *     把它解析到**前端自己的 origin**（capacitor://localhost、CDN 域等），
 *     请求打不到后端 → 图片一律 404 或返回 index.html 造成显示失败。
 *
 * 规则：
 *   - data: / blob: / http(s): 绝对 URL → 原样返回
 *   - 以 `/api/` 或 `api/` 开头 → 替换成 `${getServerUrl() || window.location.origin}/api/...`
 *   - 其他相对路径（历史的 `attachments/xxx`、或错误写法）→ 走 `${base}/${path}`
 *
 * 设计权衡：
 *   - 本函数是"渲染时兜底"，读取 localStorage 里的 serverUrl，因此调用方**不**
 *     需要把 serverUrl 写进 Tiptap content；历史笔记里的相对路径也可显示。
 *   - 也正因此，**不要**在上传成功时把绝对 URL 写回笔记——Electron 后端每次
 *     启动端口都可能变（见 electron/main.js getFreePort），把带 port 的 URL
 *     持久化到 notes.content 会让下次启动时所有图片全挂。相对路径 +
 *     渲染时动态补 origin 才是稳健策略。
 */
export function resolveAttachmentUrl(src: string | null | undefined): string {
  if (!src) return "";
  // 已经是绝对 URL 或 data / blob / file 协议，原样返回
  if (/^(https?:|data:|blob:|file:|capacitor:)/i.test(src)) return src;

  const server = getServerUrl() || (typeof window !== "undefined" ? window.location.origin : "");
  const base = server.replace(/\/+$/, "");

  // 归一化：确保以 / 开头
  const normalized = src.startsWith("/") ? src : `/${src}`;
  return `${base}${normalized}`;
}

/**
 * 安全解析响应体为 JSON。
 *
 * 直接 `res.json()` 在服务端返回 HTML（常见于：dev server SPA fallback、
 * Capacitor WebView 内嵌静态服务、反代把 /api 也 fallback 到 index.html）
 * 时会抛出非常不友好的 `Unexpected token '<'`，让人看不到是哪条请求出了问题。
 *
 * 这里统一读 text → 再判断 content-type / 体内容首字符，失败时抛出包含
 * URL、status、content-type、body 前 200 字符的错，方便一眼定位环境问题。
 */
async function safeJson<T>(res: Response, fullUrl: string): Promise<T> {
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  // 优先按 content-type 判断；但部分后端会返回 text/plain 的 JSON，所以
  // content-type 不像 json 时也尝试 parse，parse 失败再报错。
  const looksJson = /json/i.test(ct) || /^\s*[[{]/.test(text);
  if (!looksJson) {
    const snippet = text.slice(0, 200).replace(/\s+/g, " ").trim();
    throw new Error(
      `Expected JSON from ${fullUrl} but got ${ct || "unknown"} (status=${res.status}). Body[0..200]: ${snippet}`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    const snippet = text.slice(0, 200).replace(/\s+/g, " ").trim();
    throw new Error(
      `Invalid JSON from ${fullUrl} (status=${res.status}, ct=${ct}). Body[0..200]: ${snippet}`,
    );
  }
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
  // Phase 7: 同步清掉 Keystore 中的快速登录镜像。原因：
  //   1) 用户主动登出 → 不希望"快速登录"再用旧 token 一键回到登录态；
  //   2) verify 失败 / 被踢下线 → 旧 token 已无意义，留着只会让下次启动多走
  //      一遭"生物识别 → verify 失败 → 回密码页"。
  // 失败忽略：secure storage 不可用时本来就没东西要清。
  void import("./quickLogin")
    .then((m) => m.disableQuickLogin())
    .catch(() => {});
}

/**
 * 通知其他 tab 认证信息已变更（改密/改用户名），但不登出当前 tab。
 * 与 broadcastLogout 的区别：当前 tab 保持登录态，只通知其他 tab 重新验证。
 */
export function broadcastAuthChanged(reason?: string) {
  try {
    localStorage.setItem("nowen-auth-changed", `${Date.now()}|${reason || ""}`);
    localStorage.removeItem("nowen-auth-changed");
  } catch {
    /* ignore */
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
  /** 标记此请求不走离线队列拦截（内部使用） */
  _skipOfflineQueue?: boolean;
}

async function request<T>(url: string, options?: RequestOptions): Promise<T> {
  const token = getToken();
  const { sudoToken, _skipOfflineQueue, ...restOptions } = options || {};
  const fullUrl = `${getBaseUrl()}${url}`;

  // ─── 离线队列拦截：网络不可达时直接入队，不发请求 ──────────────
  const method = (restOptions?.method || "GET").toUpperCase();
  if (
    !_skipOfflineQueue &&
    !navigator.onLine &&
    _shouldEnqueue(url, method, new TypeError("offline"))
  ) {
    return handleOfflineEnqueue<T>(url, method, restOptions?.body as string | undefined);
  }

  let res: Response;
  // ─── P0-2: 全局 30s 超时 ──────────────
  // 弱网下 fetch 不会主动失败，可能挂死几十秒甚至几分钟，期间用户继续输入
  // 但 syncStatus 一直是 "saving"，新内容也没机会再触发保存。
  // 用 AbortController 设 30s 硬上限：超时即抛 AbortError → 走 isNetworkError
  // 兜底入队，不影响其他正常请求。
  // 注意：调用方传入的 signal 仍然生效，二者用 "linked controller" 模式合并。
  const linkedController = new AbortController();
  const userSignal = (restOptions as any)?.signal as AbortSignal | undefined;
  if (userSignal) {
    if (userSignal.aborted) linkedController.abort();
    else userSignal.addEventListener("abort", () => linkedController.abort(), { once: true });
  }
  // 写入类请求才设超时（GET/读类不设，长轮询场景另行处理）；GET 也保留兜底但更长
  const TIMEOUT_MS = (method === "GET" || method === "HEAD") ? 60000 : 30000;
  const timeoutId = setTimeout(() => {
    try { linkedController.abort(); } catch { /* ignore */ }
  }, TIMEOUT_MS);
  try {
    // P0-3: 自动注入 X-Connection-Id（如果 WebSocket 已连接）。
    // 后端 notes PUT 路由据此从 note:updated 广播中排除发起者连接，
    // 避免"自写 → 服务端广播回自己 → 误推荐重新加载"的输入回退。
    // 运行期动态读取 window 上的 helper，避免 import 循环。WS 未连时返回 null，
    // 此时不设 header，后端行为退化为"广播给所有人含自己"，前端靠
    // selfUserId 守卫兜底。
    let connId: string | null = null;
    try {
      const fn = (window as any)?.__nowenGetConnectionId;
      if (typeof fn === "function") connId = fn();
    } catch {
      /* SSR / window 不可用时静默 */
    }
    const buildHeaders = (includeConnId: boolean): HeadersInit => ({
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(sudoToken ? { "X-Sudo-Token": sudoToken } : {}),
      ...(includeConnId && connId ? { "X-Connection-Id": connId } : {}),
      ...restOptions?.headers,
    });
    try {
      res = await fetch(fullUrl, { ...restOptions, signal: linkedController.signal, headers: buildHeaders(true) });
    } catch (firstErr: any) {
      // 兜底：当后端 CORS allowHeaders 没把 X-Connection-Id 加进白名单时，
      //   带它的请求会在 OPTIONS 预检阶段直接被浏览器/WebView 拦下，抛
      //   TypeError: Failed to fetch。一旦发生，剥离这个自定义 header 重试一次：
      //     - 如果重试成功 → 说明就是预检拦截，记一条 warn，本会话内停掉再次注入
      //       该 header（避免每次请求都白白跑两遍）；
      //     - 如果重试还是失败 → 真正的网络不可达，按原逻辑入队 / 抛错。
      //   只在 connId 存在时才尝试，否则跳过直接走原错误路径，避免无谓重试。
      if (connId) {
        try {
          res = await fetch(fullUrl, { ...restOptions, signal: linkedController.signal, headers: buildHeaders(false) });
          // eslint-disable-next-line no-console
          console.warn(
            "[api] retry without X-Connection-Id succeeded — backend CORS likely missing this header in allowHeaders. Disabling injection for this session.",
          );
          // 关闭后续注入。注意只关一个会话内的注入，不写 storage（升级后端后下次重启即恢复）。
          try { (window as any).__nowenGetConnectionId = () => null; } catch { /* ignore */ }
        } catch (retryErr: any) {
          // 用户主动 abort（非超时） → 原样抛
          if (retryErr?.name === "AbortError" && userSignal?.aborted) throw retryErr;
          // 超时（linkedController.abort 触发） → 当作网络错误入队
          const isTimeout = retryErr?.name === "AbortError";
          if (!_skipOfflineQueue && (isTimeout || _shouldEnqueue(url, method, retryErr))) {
            if (_shouldEnqueue(url, method, isTimeout ? new TypeError("timeout") : retryErr)) {
              return handleOfflineEnqueue<T>(url, method, restOptions?.body as string | undefined);
            }
          }
          throw retryErr;
        }
      } else {
        // 用户主动 abort → 原样抛
        if (firstErr?.name === "AbortError" && userSignal?.aborted) throw firstErr;
        // 超时 → 视为网络错误
        const isTimeout = firstErr?.name === "AbortError";
        if (!_skipOfflineQueue) {
          const enqueueErr = isTimeout ? new TypeError("timeout") : firstErr;
          if (_shouldEnqueue(url, method, enqueueErr)) {
            return handleOfflineEnqueue<T>(url, method, restOptions?.body as string | undefined);
          }
        }
        throw firstErr;
      }
    }
  } catch (fetchErr: any) {
    // fetch 抛出 = 网络不可达（TypeError: Failed to fetch 等）
    // 用户主动 abort → 原样抛
    if (fetchErr?.name === "AbortError" && userSignal?.aborted) throw fetchErr;
    const isTimeout = fetchErr?.name === "AbortError";
    if (!_skipOfflineQueue) {
      const enqueueErr = isTimeout ? new TypeError("timeout") : fetchErr;
      if (_shouldEnqueue(url, method, enqueueErr)) {
        return handleOfflineEnqueue<T>(url, method, restOptions?.body as string | undefined);
      }
    }
    throw fetchErr;
  } finally {
    clearTimeout(timeoutId);
  }

  // 401 / 403 + ACCOUNT_DISABLED：会话已失效（token 无效、用户被禁用、tokenVersion 被吊销等），
  // 统一清 token 并刷新回登录页。
  // 分享页（/share/:token）是无登录场景，不应 reload —— 否则会把整个分享页刷回登录页。
  const isSharePage =
    typeof window !== "undefined" && /^\/(?:share|notebook-share)\//.test(window.location.pathname);
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

    // ─── 弱网/服务端不稳定状态码入队离线重试 ──────────────
    // 覆盖：5xx（服务端故障）+ 408（请求超时）+ 425（Too Early）+ 429（限流）。
    // 这些都不是"用户行为不合法"的错误，重试有意义。
    // 4xx 中 400/401/403/404/409/422 不入队（参数错 / 鉴权失效 / 冲突，应让上层处理）。
    const isRetryable =
      res.status >= 500 ||
      res.status === 408 ||
      res.status === 425 ||
      res.status === 429;
    if (
      !_skipOfflineQueue &&
      isRetryable &&
      _shouldEnqueue(url, method, error)
    ) {
      return handleOfflineEnqueue<T>(url, method, restOptions?.body as string | undefined);
    }

    throw error;
  }
  return safeJson<T>(res, fullUrl);
}

// ─── 离线入队辅助 ────────────────────────────────────────────────────────────────

/**
 * 把请求入队并返回"假数据"让上层不报错。
 *
 * 返回值策略：
 *   - updateNote → 返回 body 本身（上层用 updated.version / updatedAt）
 *   - createNote → 返回带临时 id 的假 Note
 *   - deleteNote → 返回 {}
 */
function handleOfflineEnqueue<T>(url: string, method: string, bodyStr?: string): T {
  const body = bodyStr ? JSON.parse(bodyStr) : null;
  const mutationType = _inferMutationType(url, method);
  const noteId = mutationType === "createNote"
    ? (body?.id || generateLocalNoteId())
    : _extractNoteId(url);

  _enqueue({
    type: mutationType || "updateNote",
    noteId,
    url,
    method: method as "POST" | "PUT" | "DELETE",
    body,
  });

  // 派发自定义事件通知 UI（syncStatus = offline）
  window.dispatchEvent(new CustomEvent("nowen:offline-queued"));

  // Phase D: 离线写也要立刻反映到 localStore，否则用户离线创建的笔记
  //   在重启后会消失（offlineQueue 在 localStorage、笔记本身却没在 IDB 中）。
  //   动态 import 避免 syncEngine ↔ api 顶层循环。
  if (mutationType === "createNote" || mutationType === "updateNote") {
    const optimisticNote = {
      id: noteId,
      title: body?.title || "",
      content: body?.content || "",
      contentText: body?.contentText || "",
      version: body?.version || 1,
      updatedAt: new Date().toISOString(),
      ...body,
    };
    void import("@/lib/syncEngine").then((m) => m.cacheNoteContent(optimisticNote as any)).catch(() => {});
  } else if (mutationType === "deleteNote") {
    void import("@/lib/localStore").then((m) => m.deleteNote(noteId)).catch(() => {});
  }

  // 构造乐观返回值
  if (mutationType === "createNote") {
    return {
      id: noteId,
      title: body?.title || "",
      content: body?.content || "",
      contentText: body?.contentText || "",
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...body,
    } as unknown as T;
  }
  if (mutationType === "deleteNote") {
    return {} as T;
  }
  // updateNote: 返回 body + noteId，让 EditorPane 的 reconcile 能拿到 version/updatedAt
  return {
    id: noteId,
    version: body?.version || 1,
    updatedAt: new Date().toISOString(),
    title: body?.title || "",
    content: body?.content,
    contentText: body?.contentText,
    ...body,
  } as unknown as T;
}

export const api = {
  // Public (no auth required)
  getSiteSettingsPublic: async (): Promise<{
    site_title: string;
    site_favicon: string;
    editor_font_family: string;
    // 功能开关（字符串 "true"/"false"，未写过时 DEFAULTS 保证为 "true"）
    feature_personal_export_enabled?: string;
    feature_personal_import_enabled?: string;
  }> => {
    const res = await fetch(`${getBaseUrl()}/settings`);
    if (!res.ok)
      return {
        site_title: "nowen-note",
        site_favicon: "",
        editor_font_family: "",
        feature_personal_export_enabled: "true",
        feature_personal_import_enabled: "true",
      };
    return res.json();
  },

  // ========== 版本信息（Public，无需 token） ==========
  //
  // 用途：
  //   - UpdateNotifier 周期性轮询 /api/version，与前端构建期注入的 __APP_VERSION__
  //     比对，不一致时弹"有新版本，点击刷新"横幅；
  //   - AboutPanel 展示"当前版本 / 服务器版本 / 最新 release"；
  //
  // 注意：与大多数公开端点（settings / register/config）一致，这里**不**走通用
  // request()——否则 401 时会误触发登出逻辑。失败统一 throw，让调用方自己决定
  // 是否降级到"显示 unknown"。
  getVersion: async (): Promise<{
    appVersion: string;
    schemaVersion: number | null;
    codeSchemaVersion: number | null;
    buildTime?: string;
    /**
     * 当前实例托管的前端 bundle 标识（入口 chunk 的 hashed 文件名）。
     * 存在即表示后端已经部署了"按 buildId 比对"的新方案；前端应优先用它
     * 与本地 bundle 的 buildId 比对，避免"只升后端没升前端"导致的刷新 loop。
     * 旧后端不返回此字段 → 前端降级到 appVersion 比对（向后兼容）。
     */
    frontendBuildId?: string;
    /**
     * 最低兼容客户端版本号（语义化版本字符串，例 "1.0.30"）。
     * 用于 Android 原生壳硬性升级引导：当 __APP_VERSION__ < minClientVersion
     * 时，前端展示不可关闭的"请下载新 APK"卡片，因为 WebView 内只刷 JS 解决
     * 不了原生 plugin 不兼容。Web / Electron 无视此字段（它们走各自的升级通道）。
     */
    minClientVersion?: string;
  }> => {
    const res = await fetch(`${getBaseUrl()}/version`);
    if (!res.ok) throw new Error(`版本信息获取失败: ${res.status}`);
    return res.json();
  },

  // 取 GitHub 仓库最新 release（由后端做代理 + 60s 缓存，失败降级）。
  // 后端永远返回 200：成功 { available: true, ... }；失败 { available: false, reason }。
  getLatestRelease: async (): Promise<
    | {
        available: true;
        tag: string;
        version: string;
        name: string;
        htmlUrl: string;
        publishedAt: string;
        prerelease: boolean;
        draft: boolean;
        body?: string;
        // 资产列表：每条对应一个 GitHub release asset（exe/dmg/apk/fpk/upk 等）。
        // 后端从 GitHub API 整理后下发，前端在「下载客户端」面板里按文件名分类。
        assets: Array<{
          name: string;
          size: number;
          contentType: string;
          browserDownloadUrl: string;
        }>;
      }
    | { available: false; reason: string }
  > => {
    try {
      const res = await fetch(`${getBaseUrl()}/releases/latest`);
      if (!res.ok) return { available: false, reason: `HTTP ${res.status}` };
      return res.json();
    } catch (e) {
      return { available: false, reason: e instanceof Error ? e.message : String(e) };
    }
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
    data: Partial<{
      username: string;
      email: string | null;
      displayName: string | null;
      role: "admin" | "user";
      isDisabled: boolean;
      /**
       * v6 per-user 开关：个人空间导出 / 导入。
       * 非高危字段——后端 PATCH /users/:id 对这两列不要求 sudo，也不 bump tokenVersion。
       */
      personalExportEnabled: boolean;
      personalImportEnabled: boolean;
    }>,
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
    // Phase C: 网络失败时回退到 localStore 缓存
    return _readNotebooks(() => request<Notebook[]>(`/notebooks${qs}`));
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
  getSharedNotebooks: () => request<Notebook[]>("/notebooks/shared-with-me"),
  getNotebookMembers: (id: string) => request<NotebookMember[]>(`/notebooks/${id}/members`),
  addNotebookMember: (id: string, data: { userId: string; role: "editor" | "viewer" }) =>
    request<NotebookMember>(`/notebooks/${id}/members`, { method: "POST", body: JSON.stringify(data) }),
  updateNotebookMember: (id: string, userId: string, data: { role: "editor" | "viewer" }) =>
    request<{ success: boolean }>(`/notebooks/${id}/members/${userId}`, { method: "PATCH", body: JSON.stringify(data) }),
  removeNotebookMember: (id: string, userId: string) =>
    request<{ success: boolean }>(`/notebooks/${id}/members/${userId}`, { method: "DELETE" }),
  getNotebookShareLink: (id: string) => request<NotebookShareLink | null>(`/notebooks/${id}/share-link`),
  createNotebookShareLink: (id: string, data?: { role?: "editor" | "viewer"; expiresAt?: string | null }) =>
    request<NotebookShareLink>(`/notebooks/${id}/share-link`, { method: "POST", body: JSON.stringify(data || {}) }),
  updateNotebookShareLink: (
    id: string,
    data: { role?: "editor" | "viewer"; expiresAt?: string | null; enabled?: boolean },
  ) => request<NotebookShareLink>(`/notebooks/${id}/share-link`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteNotebookShareLink: (id: string) =>
    request<{ success: boolean }>(`/notebooks/${id}/share-link`, { method: "DELETE" }),
  getNotebookShareInfo: (token: string) =>
    request<{
      id: string;
      notebookId: string;
      role: "editor" | "viewer";
      enabled: number;
      expiresAt: string | null;
      createdAt: string;
      name: string;
      icon: string;
      color: string | null;
      ownerUsername: string;
      ownerDisplayName: string | null;
    }>(`/notebooks/share/${token}`),
  joinNotebookShareLink: (token: string) =>
    request<{ success: boolean; notebookId: string; role: "owner" | "editor" | "viewer" }>(
      `/notebooks/share/${token}/join`,
      { method: "POST" },
    ),

  // Notes
  getNotes: (params?: Record<string, string>) => {
    // 自动注入 workspaceId（除非调用方显式传入）
    const finalParams: Record<string, string> = { ...(params || {}) };
    if (!("workspaceId" in finalParams)) {
      finalParams.workspaceId = getCurrentWorkspace();
    }
    const qs = "?" + new URLSearchParams(finalParams).toString();
    // Phase C: 网络失败 -> 本地缓存 + 在客户端复刻主要 filter
    //   只覆盖三个高频场景：notebookId / isFavorite / isTrashed；
    //   其他复杂 query（全文搜索 / sort / page 等）离线不支持，让上层报错。
    const offlineFilter = (n: any): boolean => {
      const wsMatch = ("workspaceId" in finalParams)
        ? (n.workspaceId === finalParams.workspaceId
          || (finalParams.workspaceId === "personal" && !n.workspaceId))
        : true;
      if (!wsMatch) return false;
      if (finalParams.notebookId && n.notebookId !== finalParams.notebookId) return false;
      if (finalParams.isFavorite === "1" && !n.isFavorite) return false;
      if (finalParams.isTrashed === "1" && !n.isTrashed) return false;
      // 默认返回未在垃圾桶的（服务端默认过滤）
      if (finalParams.isTrashed !== "1" && n.isTrashed) return false;
      return true;
    };
    return _readNotesList(
      () => request<NoteListItem[]>(`/notes${qs}`),
      offlineFilter,
    );
  },
  getNote: (id: string) => _readNote(id, async () => {
    const note = await request<Note>(`/notes/${id}`);
    // Phase C: \u6210\u529f\u62c9\u5230\u7b14\u8bb0\u6b63\u6587 \u2192 \u5199\u5165\u672c\u5730\u7f13\u5b58\uff0c\u4f9b\u540e\u7eed\u79bb\u7ebf\u6253\u5f00
    void import("@/lib/syncEngine").then((m) => m.cacheNoteContent(note)).catch(() => {});
    return note;
  }),
  /**
   * 轻量版笔记 GET：不返回 content / contentText，仅元数据（含 version）。
   *
   * 使用场景：
   *   - 乐观锁 409 冲突重试时只需要 latest version
   *   - optimisticLockApi.makeFetchLatestNoteVersion
   * 背景：
   *   notes.content 可能包含大量 base64 内联图片，完整 GET 一次可能传 10+ MB，
   *   还会阻塞后端事件循环。slim 避开所有重字段。
   *
   * 注意：返回对象里 content / contentText 为 undefined，不要直接赋给 activeNote
   * 否则编辑器会拿到空内容。只在"只用 version / 元数据"的路径使用。
   */
  getNoteSlim: (id: string) =>
    request<Partial<Note> & { id: string; version: number; title: string; updatedAt: string }>(
      `/notes/${id}?slim=1`,
    ),
  createNote: (data: Partial<Note>) => {
    // Phase D: 客户端提前生成 UUID v4，后端接受。
    //   - 优点：离线创建不需要临时 ID + 后期映射；
    //   - 调用方依然可以显式传 id 覆盖（如导入场景）。
    const payload: Partial<Note> & { id?: string } = { ...data };
    if (!payload.id) {
      payload.id = (typeof crypto !== "undefined" && (crypto as any).randomUUID)
        ? (crypto as any).randomUUID()
        : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}-4${Math.random().toString(16).slice(2, 5)}-${Math.random().toString(16).slice(2, 6)}-${Math.random().toString(16).slice(2, 14)}`;
    }
    return request<Note>("/notes", { method: "POST", body: JSON.stringify(payload) });
  },
  updateNote: (id: string, data: Partial<Note>) => {
    const p = request<Note>(`/notes/${id}`, { method: "PUT", body: JSON.stringify(data) });
    // Phase D: 成功后同步本地缓存，保证离线重启后也能看到最新内容
    p.then((note) => {
      void import("@/lib/syncEngine").then((m) => m.cacheNoteContent(note)).catch(() => {});
    }).catch(() => { /* 失败不写入本地 */ });
    return p;
  },
  deleteNote: (id: string) => request(`/notes/${id}`, { method: "DELETE" }),
  emptyTrash: () =>
    request<{
      success: boolean;
      count: number;
      skipped: number;
      removedFiles?: number;
      /** 后端是否做了 WAL checkpoint（把 -wal 并回主文件并截断） */
      walTruncated?: boolean;
      /** 本次是否触发了 VACUUM（释放体量 >= 阈值时才做） */
      vacuumed?: boolean;
      /** 估算释放的字节数（笔记文本 + 附件 size 登记值） */
      freedBytesEstimate?: number;
    }>(`/notes/trash/empty`, { method: "DELETE" }),
  reorderNotes: (items: { id: string; sortOrder: number }[]) =>
    request<{ success: boolean }>("/notes/reorder/batch", { method: "PUT", body: JSON.stringify({ items }) }),
  /**
   * 释放笔记的 Y.js 房间：销毁服务端内存 Doc，并清空 note_yupdates / note_ysnapshots。
   * MD→RTE 切换时调用，避免下次切回 MD 时恢复出"上次 MD 会话的旧 yDoc"。
   */
  releaseYjsRoom: (id: string) =>
    request<{ success: boolean }>(`/notes/${id}/yjs/release-room`, { method: "POST" }),

  // Tags
  // -----------------------------------------------------------------
  // 与 notebooks / notes 一致的工作区隔离：
  //   - getTags 自动带当前 workspaceId（'personal' | <uuid>）
  //   - createTag 自动落到当前空间（除非调用方显式覆盖）
  //   - update / delete / attach 由后端按 tag.id 反查空间做 ACL，前端无需传
  getTags: (workspaceId?: string) => {
    const ws = workspaceId ?? getCurrentWorkspace();
    const qs = ws ? `?workspaceId=${encodeURIComponent(ws)}` : "";
    // Phase C: 网络失败时回退到 localStore 缓存
    return _readTags(() => request<Tag[]>(`/tags${qs}`));
  },
  createTag: (data: Partial<Tag> & { workspaceId?: string | null }) => {
    const payload: any = { ...data };
    if (payload.workspaceId === undefined) {
      const currentWs = getCurrentWorkspace();
      // 'personal' 不显式传，让后端按缺省走 NULL（个人空间）
      if (currentWs && currentWs !== "personal") {
        payload.workspaceId = currentWs;
      }
    }
    return request<Tag>("/tags", { method: "POST", body: JSON.stringify(payload) });
  },
  updateTag: (id: string, data: Partial<Tag>) => request<Tag>(`/tags/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteTag: (id: string) => request(`/tags/${id}`, { method: "DELETE" }),
  addTagToNote: (noteId: string, tagId: string) => request(`/tags/note/${noteId}/tag/${tagId}`, { method: "POST" }),
  removeTagFromNote: (noteId: string, tagId: string) => request(`/tags/note/${noteId}/tag/${tagId}`, { method: "DELETE" }),
  getNotesWithTag: (tagId: string, params?: Record<string, string>) => {
    const finalParams: Record<string, string> = { tagId, ...(params || {}) };
    if (!("workspaceId" in finalParams)) {
      finalParams.workspaceId = getCurrentWorkspace();
    }
    const qs = "?" + new URLSearchParams(finalParams).toString();
    return request<NoteListItem[]>(`/notes${qs}`);
  },

  // Search
  search: (q: string) => {
    const params = new URLSearchParams();
    params.set("q", q);
    params.set("workspaceId", getCurrentWorkspace());
    return request<SearchResult[]>(`/search?${params.toString()}`);
  },

  // Tasks
  // Y3: 自动注入当前工作区——personal 不带，workspace 带 ?workspaceId=<uuid>。
  //   - getTasks / getTaskStats / createTask 三个"集合"接口注入 workspaceId；
  //   - getTask / updateTask / toggleTask / deleteTask 按 id 操作，后端按行自带的
  //     workspaceId 做 ACL，不需注入。
  getTasks: (filter?: TaskFilter, noteId?: string, projectId?: string) => {
    const params = new URLSearchParams();
    if (filter && filter !== "all") params.set("filter", filter);
    if (noteId) params.set("noteId", noteId);
    if (projectId) params.set("projectId", projectId);
    const ws = getCurrentWorkspace();
    if (ws && ws !== "personal") params.set("workspaceId", ws);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return request<Task[]>(`/tasks${qs}`);
  },
  getTask: (id: string) => request<Task>(`/tasks/${id}`),
  createTask: (data: Partial<Task>) => {
    const ws = getCurrentWorkspace();
    const qs = ws && ws !== "personal" ? `?workspaceId=${encodeURIComponent(ws)}` : "";
    return request<Task>(`/tasks${qs}`, { method: "POST", body: JSON.stringify(data) });
  },
  updateTask: (id: string, data: Partial<Task>) => request<TaskMutationResponse>(`/tasks/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  reorderTasks: (items: { id: string; sortOrder: number }[]) =>
    request<{ success: boolean; affected: number }>("/tasks/reorder/batch", { method: "PUT", body: JSON.stringify({ items }) }),
  toggleTask: (id: string) => request<TaskMutationResponse>(`/tasks/${id}/toggle`, { method: "PATCH" }),
  aiBreakdownTask: (id: string, lang?: string) => request<{ subtasks: { title: string; priority: number; dueDate: string | null; reason: string }[] }>(`/tasks/${id}/ai-breakdown`, { method: "POST", body: JSON.stringify({ lang }) }),
  deleteTask: (id: string) => request(`/tasks/${id}`, { method: "DELETE" }),
  batchTasks: (ids: string[], action: "complete" | "delete") =>
    request<{ success: boolean; affected: number; generatedCount?: number }>("/tasks/batch", { method: "POST", body: JSON.stringify({ ids, action }) }),
  // Task projects
  getTaskProjects: () => {
    const ws = getCurrentWorkspace();
    const qs = ws && ws !== "personal" ? `?workspaceId=${encodeURIComponent(ws)}` : "";
    return request<import("@/types").TaskProject[]>(`/task-projects${qs}`);
  },
  createTaskProject: (data: { name: string; icon?: string; color?: string }) => {
    const ws = getCurrentWorkspace();
    const qs = ws && ws !== "personal" ? `?workspaceId=${encodeURIComponent(ws)}` : "";
    return request<import("@/types").TaskProject>(`/task-projects${qs}`, { method: "POST", body: JSON.stringify(data) });
  },
  updateTaskProject: (id: string, data: Partial<import("@/types").TaskProject>) =>
    request<import("@/types").TaskProject>(`/task-projects/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteTaskProject: (id: string) =>
    request(`/task-projects/${id}`, { method: "DELETE" }),
  // Task templates
  getTaskTemplates: () => {
    const ws = getCurrentWorkspace();
    const qs = ws && ws !== "personal" ? `?workspaceId=${encodeURIComponent(ws)}` : "";
    return request<import("@/types").TaskTemplate[]>(`/task-templates${qs}`);
  },
  createTaskTemplate: (data: { name: string; description?: string; icon?: string; color?: string; items: import("@/types").TaskTemplateItem[] }) => {
    const ws = getCurrentWorkspace();
    const qs = ws && ws !== "personal" ? `?workspaceId=${encodeURIComponent(ws)}` : "";
    return request<import("@/types").TaskTemplate>(`/task-templates${qs}`, { method: "POST", body: JSON.stringify(data) });
  },
  updateTaskTemplate: (id: string, data: Partial<import("@/types").TaskTemplate>) =>
    request<import("@/types").TaskTemplate>(`/task-templates/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteTaskTemplate: (id: string) =>
    request(`/task-templates/${id}`, { method: "DELETE" }),
  applyTaskTemplate: (id: string, options: { projectId?: string | null; parentId?: string | null; baseDate?: string | null }) =>
    request<{ createdTasks: any[]; count: number }>(`/task-templates/${id}/apply`, { method: "POST", body: JSON.stringify(options) }),

  // Task dependencies
  getTaskDependencies: (taskId?: string) => {
    const ws = getCurrentWorkspace();
    const params: string[] = [];
    if (ws && ws !== "personal") params.push("workspaceId=" + encodeURIComponent(ws));
    if (taskId) params.push("taskId=" + encodeURIComponent(taskId));
    const qs = params.length > 0 ? "?" + params.join("&") : "";
    return request<import("@/types").TaskDependency[]>(`/task-dependencies${qs}`);
  },
  createTaskDependency: (data: { predecessorTaskId: string; successorTaskId: string; type?: string }) => {
    return request<import("@/types").TaskDependency>("/task-dependencies", { method: "POST", body: JSON.stringify(data) });
  },
  deleteTaskDependency: (id: string) => {
    return request<{ success: boolean }>(`/task-dependencies/${id}`, { method: "DELETE" });
  },
    // Task reminders
  getRecentReminders: (since: number) =>
    request<{ reminders: Array<{ reminderId: string; taskId: string; taskTitle: string; triggeredAt: number }> }>(
      `/task-reminders/recent?since=${since}`
    ),
  getTaskReminders: (taskId: string) =>
    request<import("@/types").TaskReminder[]>(`/task-reminders/${taskId}`),
  createTaskReminder: (taskId: string, offsetMinutes: number) =>
    request<import("@/types").TaskReminder>(`/task-reminders/${taskId}`, { method: "POST", body: JSON.stringify({ offsetMinutes }) }),
  updateTaskReminder: (reminderId: string, data: { offsetMinutes?: number; enabled?: boolean; snoozedUntil?: string | null }) =>
    request<import("@/types").TaskReminder>(`/task-reminders/${reminderId}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteTaskReminder: (reminderId: string) =>
    request(`/task-reminders/${reminderId}`, { method: "DELETE" }),
  getReminderOverview: (days?: number) => {
    const ws = getCurrentWorkspace();
    const params: string[] = [];
    if (ws && ws !== "personal") params.push(`workspaceId=${encodeURIComponent(ws)}`);
    if (days) params.push(`days=${days}`);
    const qs = params.length > 0 ? "?" + params.join("&") : "";
    return request<import("@/types").ReminderOverview>(`/task-reminders/overview${qs}`);
  },
  getTaskStats: () => {
    const ws = getCurrentWorkspace();
    const qs = ws && ws !== "personal" ? `?workspaceId=${encodeURIComponent(ws)}` : "";
    return request<TaskStats>(`/tasks/stats/summary${qs}`);
  },


  // Task calendar subscription (ICS feed)
  taskCalendarFeed: {
    get: () => request<{ feed: any }>(`/task-calendar/feed`),
    create: () => request<{ feed: any }>(`/task-calendar/feed`, { method: "POST" }),
    update: (data: { enabled?: boolean; includeCompleted?: boolean; includeDescription?: boolean; defaultAlarmMinutes?: number }) =>
      request<{ feed: any }>(`/task-calendar/feed`, { method: "PATCH", body: JSON.stringify(data) }),
    rotateToken: () => request<{ success: boolean }>(`/task-calendar/feed/rotate-token`, { method: "POST" }),
  },

  // Folder sync (desktop only)
  folderSync: {
    importFile: (data: {
      filename: string;
      relativePath: string;
      sha256: string;
      targetNotebookId: string;
      contentText?: string;
      sourcePathHash: string;
      existingNoteId?: string;
    }) => request<{
      success: boolean;
      created: boolean;
      updated: boolean;
      skipped: boolean;
      noteId: string;
      sha256: string;
      reason?: string;
    }>(`/folder-sync/import-file`, { method: "POST", body: JSON.stringify(data) }),

    checkDedup: (sourcePathHashes: string[]) =>
      request<Record<string, string>>(`/folder-sync/check-dedup`, { method: "POST", body: JSON.stringify({ sourcePathHashes }) }),
  },

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
  // 与其它集合接口（notes / notebooks / tasks 等）保持一致：
  //   - personal 不带 workspaceId（后端按 NULL 落盘 / 过滤）
  //   - workspace 带 ?workspaceId=<uuid>
  // 调用方也可以显式传 workspaceId 覆盖（DataManager 拆"个人空间 / 工作区" Tab 后会用到）。
  getExportNotes: (workspaceId?: string) => {
    const ws = workspaceId ?? getCurrentWorkspace();
    const qs = ws && ws !== "personal" ? `?workspaceId=${encodeURIComponent(ws)}` : "";
    return request<any[]>(`/export/notes${qs}`);
  },
  /** 导出 Nowen 数据包（.nowen.zip） */
  downloadNowenPackage: async (opts?: { notebookId?: string; includeSubNotebooks?: boolean; includeTrashed?: boolean }) => {
    const ws = getCurrentWorkspace();
    const params = new URLSearchParams();
    if (ws && ws !== "personal") params.set("workspaceId", ws);
    if (opts?.notebookId) params.set("notebookId", opts.notebookId);
    if (opts?.includeSubNotebooks !== undefined) params.set("includeSubNotebooks", String(opts.includeSubNotebooks));
    if (opts?.includeTrashed) params.set("includeTrashed", "true");
    const qs = params.toString() ? `?${params.toString()}` : "";
    const token = getToken();
    const res = await fetch(`${getBaseUrl()}/export/nowen-package${qs}`, {
      credentials: "include",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Export failed" }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const contentDisp = res.headers.get("Content-Disposition") || "";
    const filenameMatch = /filename\*?=(?:UTF-8'')?([^;\n]*)/i.exec(contentDisp);
    const filename = filenameMatch ? decodeURIComponent(filenameMatch[1].replace(/"/g, "")) : "nowen-package.nowen.zip";
    return { blob, filename };
  },
  importNotes: (
    notes: { title: string; content: string; contentText: string; createdAt?: string; updatedAt?: string; notebookName?: string; notebookPath?: string[] }[],
    notebookId?: string,
    notebookName?: string,
    workspaceId?: string,
  ) => {
    const ws = workspaceId ?? getCurrentWorkspace();
    const qs = ws && ws !== "personal" ? `?workspaceId=${encodeURIComponent(ws)}` : "";
    return request<{ success: boolean; count: number; notebookId: string; notebookIds?: string[]; notes: any[]; workspaceId?: string | null }>(`/export/import${qs}`, {
      method: "POST",
      body: JSON.stringify({ notes, notebookId, notebookName }),
    });
  },
  /** Nowen 数据包 dry-run 预检 */
  dryRunNowenPackage: async (file: File) => {
    const token = getToken();
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${getBaseUrl()}/export/import/nowen-package?dryRun=1`, {
      method: "POST",
      credentials: "include",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },
  /** Nowen 数据包正式导入 */
  importNowenPackage: async (file: File, opts?: { importMode?: "new-root" | "into-target"; targetNotebookId?: string }) => {
    const token = getToken();
    const form = new FormData();
    form.append("file", file);
    const params = new URLSearchParams();
    if (opts?.importMode) params.set("importMode", opts.importMode);
    if (opts?.targetNotebookId) params.set("targetNotebookId", opts.targetNotebookId);
    const qs = params.toString() ? `?${params.toString()}` : "";
    const res = await fetch(`${getBaseUrl()}/export/import/nowen-package${qs}`, {
      method: "POST",
      credentials: "include",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },

  // Site Settings
  getSiteSettings: () =>
    request<{
      site_title: string;
      site_favicon: string;
      editor_font_family: string;
      feature_personal_export_enabled?: string;
      feature_personal_import_enabled?: string;
      // 调试开关："true" / "false"。仅管理员可写，未写过时为 "false"。
      debug_files_query?: string;
      web_ui_enabled?: string;
    }>("/settings"),
  updateSiteSettings: (data: {
    site_title?: string;
    site_favicon?: string;
    editor_font_family?: string;
    // 布尔值或 "true"/"false" 字符串；后端做归一化
    feature_personal_export_enabled?: boolean | string;
    feature_personal_import_enabled?: boolean | string;
    // 同上：后端归一化为 "true"/"false"
    debug_files_query?: boolean | string;
    web_ui_enabled?: boolean | string;
  }) =>
    request<{
      site_title: string;
      site_favicon: string;
      editor_font_family: string;
      feature_personal_export_enabled?: string;
      feature_personal_import_enabled?: string;
      debug_files_query?: string;
      web_ui_enabled?: string;
    }>("/settings", {
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

  // ========== Attachments（图片/任意格式附件走文件，不再内联 base64）==========
  //
  // 统一把编辑器里的二进制内容从 data:image;base64,... 迁到 /api/attachments/<id>。
  // 粘贴、拖拽、点"插入图片/插入附件"按钮都应走 uploadAttachment；导入
  // （importService）在解析到本地图片时也走这里把字节落盘。
  //
  // 后端不再限制 MIME（只黑掉极少数高危可执行类型），任何文件都能上传。
  // 响应里多带一个 category: "image" | "file"，前端据此决定编辑器里：
  //   - "image" → 插 <img>
  //   - "file"  → 插「附件链接」（<a download="原文件名">📎 文件名 (大小)</a>）
  //
  // 返回的 url 是**相对 URL**（/api/attachments/<id>），浏览器直接用作 img.src
  // 能正确带上 Authorization（fetch）……不过 <img> 标签的 HTTP 请求不会带
  // Authorization header。为此 attachments 下载接口不依赖 JWT，而是靠
  // "noteId 的 read 权限"做 ACL；客户端本地（同源）可以直接访问。
  // 若以后部署到不同域 + cookie 鉴权不可用，需改造为签名 URL。
  attachments: {
    /**
     * 上传一份附件（任意格式）。
     *
     * @param noteId 必须：绑定的笔记 ID，后端用它做 ACL 校验
     * @param file   File 对象（粘贴得到的 File、拖拽文件、或 input.files[0]）
     * @returns      { id, url, mimeType, size, filename, category }
     *
     * 注意：
     *   - 本调用绕过 request() 通用封装，因为 Content-Type 需要让浏览器自动
     *     带上 multipart boundary；
     *   - 错误时抛 Error（与 request() 风格一致）。
     */
    upload: async (
      noteId: string,
      file: File,
    ): Promise<{
      id: string;
      url: string;
      mimeType: string;
      size: number;
      filename: string;
      category: "image" | "file";
    }> => {
      const token = getToken();
      const form = new FormData();
      form.append("file", file);
      form.append("noteId", noteId);
      const res = await fetch(`${getBaseUrl()}/attachments`, {
        method: "POST",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: form,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `附件上传失败: ${res.status}`);
      }
      return res.json();
    },

    /**
     * 拼出一个附件的完整 URL。
     * 本地部署（前端与后端同源或走 vite 代理）时直接返回 `/api/attachments/<id>`
     * 即可；客户端模式若配置了外部 serverUrl，则前缀带上 serverUrl。
     */
    urlFor: (id: string): string => `${getBaseUrl()}/attachments/${id}`,

    /** 删除一份附件。一般用于编辑器内显式删除 + 管理页。 */
    remove: (id: string) =>
      request<{ success: boolean }>(`/attachments/${id}`, { method: "DELETE" }),
  },

  // ========== Task Attachments（待办事项的图片附件）==========
  //
  // 与 attachments 区别：
  //   - 不绑定 noteId，按 userId 做 ACL；
  //   - taskId 可空：新建任务时图片先以"孤儿"形式上传拿到 url，后端 task 创建
  //     成功后再 PATCH /:id/bind 把孤儿绑回 task。这样可以在用户点击"创建"
  //     之前就把图片塞到输入框里预览。
  //
  // url 仍然返回相对路径 `/api/task-attachments/<id>`，<img> 直接消费。
  taskAttachments: {
    /**
     * 上传一张任务图片附件。
     * @param file   File 对象（input.files[0] / 粘贴拿到的 File / 拖拽文件）
     * @param taskId 可选——新建任务流程通常先上传后建 task，此时不传，
     *               拿到 id 后再调用 bind() 关联。
     */
    upload: async (
      file: File,
      taskId?: string,
    ): Promise<{ id: string; url: string; mimeType: string; size: number; filename: string }> => {
      const token = getToken();
      const form = new FormData();
      form.append("file", file);
      if (taskId) form.append("taskId", taskId);
      // Y3: 孤儿态（未指定 taskId）时附件的 workspaceId 来自 query；
      //     若指定了 taskId，后端从 task 行继承 workspaceId，query 被忽略。
      const ws = getCurrentWorkspace();
      const qs = !taskId && ws && ws !== "personal"
        ? `?workspaceId=${encodeURIComponent(ws)}`
        : "";
      const res = await fetch(`${getBaseUrl()}/task-attachments${qs}`, {
        method: "POST",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: form,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `任务附件上传失败: ${res.status}`);
      }
      return res.json();
    },

    /** 把"孤儿附件"绑定到具体 task（创建 task 后调用）。 */
    bind: (id: string, taskId: string) =>
      request<{ success: boolean }>(`/task-attachments/${id}/bind`, {
        method: "PATCH",
        body: JSON.stringify({ taskId }),
      }),

    /** 删除任务附件。 */
    remove: (id: string) =>
      request<{ success: boolean }>(`/task-attachments/${id}`, { method: "DELETE" }),

    /** 拼出完整 URL（与 attachments 同理）。 */
    urlFor: (id: string): string => `${getBaseUrl()}/task-attachments/${id}`,
  },

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

  // URL 导入：当前仅支持微信公众号文章
  //   - 带当前 workspaceId（个人空间不带），让导入的笔记落到正确的空间
  //   - 后端会顺手把文章里的图片下载到 attachments 目录，url 改写为 /api/attachments/<id>
  urlImport: (url: string, notebookId?: string) => {
    const ws = getCurrentWorkspace();
    const qs = ws && ws !== "personal" ? `?workspaceId=${encodeURIComponent(ws)}` : "";
    return request<{
      success: boolean;
      noteId: string;
      title: string;
      author?: string;
      publishDate?: string;
      notebookId: string;
      images: { downloaded: number; failed: number };
    }>(`/url-import${qs}`, {
      method: "POST",
      body: JSON.stringify({ url, notebookId }),
    });
  },

  // Mind Maps
  // Y4: 与 tasks/diary 一致——"集合"接口自动带当前 workspaceId（personal 不带），
  //   "按 id"接口（get/update/delete）不带，后端按行自带的 workspaceId 做 ACL。
  getMindMaps: () => {
    const ws = getCurrentWorkspace();
    const qs = ws && ws !== "personal" ? `?workspaceId=${encodeURIComponent(ws)}` : "";
    return request<MindMapListItem[]>(`/mindmaps${qs}`);
  },
  getMindMap: (id: string) => request<MindMap>(`/mindmaps/${id}`),
  createMindMap: (data: { title?: string; data?: string }) => {
    const ws = getCurrentWorkspace();
    const qs = ws && ws !== "personal" ? `?workspaceId=${encodeURIComponent(ws)}` : "";
    return request<MindMap>(`/mindmaps${qs}`, { method: "POST", body: JSON.stringify(data) });
  },
  updateMindMap: (id: string, data: { title?: string; data?: string }) =>
    request<MindMap>(`/mindmaps/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteMindMap: (id: string) => request(`/mindmaps/${id}`, { method: "DELETE" }),
  toggleStarMindMap: (id: string) => request<MindMap>(`/mindmaps/${id}/star`, { method: "PATCH" }),

  // MindMap Folders
  getMindMapFolders: () => {
    const ws = getCurrentWorkspace();
    const qs = ws ? `?workspaceId=${encodeURIComponent(ws)}` : "";
    return request<any[]>(`/mindmap-folders${qs}`);
  },
  createMindMapFolder: (data: { name?: string; parentId?: string }) => {
    const ws = getCurrentWorkspace();
    const qs = ws ? `?workspaceId=${encodeURIComponent(ws)}` : "";
    return request<any>(`/mindmap-folders${qs}`, { method: "POST", body: JSON.stringify(data) });
  },
  updateMindMapFolder: (id: string, data: { name?: string; parentId?: string; sortOrder?: number }) =>
    request<any>(`/mindmap-folders/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteMindMapFolder: (id: string) => request(`/mindmap-folders/${id}`, { method: "DELETE" }),
  moveMindMap: (id: string, folderId: string | null) =>
    request<any>(`/mindmaps/${id}/move`, { method: "PATCH", body: JSON.stringify({ folderId }) }),

  // Diary (说说/动态)
  // Y2: 自动注入当前工作区。后端按 workspaceId 隔离数据：
  //   - 'personal' 或省略 → 个人空间（diaries.workspaceId IS NULL）
  //   - <uuid>            → 指定工作区（要求成员身份 + diaries 功能开关未关闭）
  // 在工作区中：发布权限按"是否成员 + 功能开关"，删除权限按 canManageResource
  //   （创建者本人 / admin / owner）。
  postDiary: (data: { contentText: string; mood?: string; images?: string[]; media?: DiaryMediaItem[] }) => {
    const ws = getCurrentWorkspace();
    const qs = ws && ws !== "personal" ? `?workspaceId=${encodeURIComponent(ws)}` : "";
    return request<Diary>(`/diary${qs}`, { method: "POST", body: JSON.stringify(data) });
  },
  getDiaryTimeline: (
    cursor?: string,
    limit?: number,
    range?: { from?: string; to?: string; mediaType?: string; mood?: string; q?: string },
  ) => {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    if (limit) params.set("limit", String(limit));
    if (range?.mediaType && range.mediaType !== "all") params.set("mediaType", range.mediaType);
    if (range?.mood) params.set("mood", range.mood);
    if (range?.q) params.set("q", range.q);
    // from/to 接收 "YYYY-MM-DD" 或完整 ISO 时间；后端会做 normalize
    if (range?.from) params.set("from", range.from);
    if (range?.to) params.set("to", range.to);
    const ws = getCurrentWorkspace();
    if (ws && ws !== "personal") params.set("workspaceId", ws);
    const qs = params.toString();
    return request<DiaryTimeline>(`/diary/timeline${qs ? `?${qs}` : ""}`);
  },
  deleteDiary: (id: string) => request(`/diary/${id}`, { method: "DELETE" }),
  /**
   * 编辑一条说说。仅传入需要修改的字段；图片字段传入即覆盖（差集
   * attach / 反 attach 由后端处理，会自动清理被移除的图片）。
   * 鉴权：作者本人 + 工作区 admin/owner（与 deleteDiary 一致）。
   */
  updateDiary: (
    id: string,
    data: { contentText?: string; mood?: string; images?: string[]; media?: DiaryMediaItem[] },
  ) =>
    request<Diary>(`/diary/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  getDiaryStats: (range?: { from?: string; to?: string; mediaType?: string; mood?: string; q?: string }) => {
    const params = new URLSearchParams();
    if (range?.from) params.set("from", range.from);
    if (range?.to) params.set("to", range.to);
    if (range?.mediaType && range.mediaType !== "all") params.set("mediaType", range.mediaType);
    if (range?.mood) params.set("mood", range.mood);
    if (range?.q) params.set("q", range.q);
    const ws = getCurrentWorkspace();
    if (ws && ws !== "personal") params.set("workspaceId", ws);
    const qs = params.toString();
    return request<DiaryStats>(`/diary/stats${qs ? `?${qs}` : ""}`);
  },

  // 说说图片：上传 / 删除悬空 / 拼 URL。
  // 上传时机：用户选好图就立即上传（不是发布时再传），体验上能即时看到缩略图、
  // 失败也能立即提示。返回的 id 在用户点"发布"时一并提交给 postDiary({ images })。
  diaryImages: {
    upload: async (
      file: File,
    ): Promise<{ id: string; url: string; mimeType: string; size: number; filename?: string; type: "image" | "video" }> => {
      const token = getToken();
      const form = new FormData();
      form.append("file", file);
      // Y2: 上传时即记录目标工作区，发布时再 attach 一致。
      const ws = getCurrentWorkspace();
      const qs = ws && ws !== "personal" ? `?workspaceId=${encodeURIComponent(ws)}` : "";
      const res = await fetch(`${getBaseUrl()}/diary/attachments${qs}`, {
        method: "POST",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: form,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `图片上传失败: ${res.status}`);
      }
      return res.json();
    },
    /** 删除一张悬空（未发布）的图片。已发布的图片只能通过删除整条说说级联清理。 */
    remove: (id: string) =>
      request<{ success: boolean }>(`/diary/attachments/${id}`, { method: "DELETE" }),
    /** 拼出图片完整 URL，给 <img src> 用。 */
    urlFor: (id: string): string => `${getBaseUrl()}/diary/attachments/${id}`,
  },

  // ========== Files（文件管理模块：统一查看/上传/删除附件资源）==========
  //
  // attachments 表承载编辑器里每一份二进制字节。文件管理模块是它的
  // "聚合视图"——给用户一个图片/文件混排的浏览入口，并支持反向引用跳回
  // 对应的笔记。为避免新增表/新增文件夹，后端直接从 attachments 聚合 +
  // 扫描 notes.content 做反查；前端只要走下面这几个接口即可。
  //
  // 上传支持"无笔记归属"：后端会自动创建/复用一个 isArchived=1 的 holder
  // note 兜底外键约束，用户看到的只是"未归档文件"。
  //
  files: {
    /** 分类聚合统计。侧栏/顶栏展示"X 张图片 / Y 个文件"用。
     *  Y4: 自动注入当前工作区 scope；personal 不带、workspace 带 ?workspaceId=。
     */
    stats: () => {
      const ws = getCurrentWorkspace();
      const qs = ws && ws !== "personal" ? `?workspaceId=${encodeURIComponent(ws)}` : "";
      return request<FileStats>(`/files/stats${qs}`);
    },

    /** 分页列出文件。所有筛选字段可选；默认按 createdAt desc。
     *  Y4: 自动注入 workspaceId（调用方未显式指定时）。
     *  filter=unreferenced：仅返回 scope 内"没有被任何笔记引用"的附件（含 24h 宽限期）。
     *    与 category 正交——可同时传 category=image 得到"孤儿图片"。
     *  filter=myUploads：仅返回"用户从文件管理页直接上传"的附件（noteId 指向 holder note）；
     *    可叠加 myUploadsRef=referenced/unreferenced 进一步拆分"已被笔记引用 / 还没引用"。
     */
    list: (params: {
      category?: FileCategory;
      filter?: FileFilter;
      myUploadsRef?: FileMyUploadsRef;
      mime?: string;
      notebookId?: string;
      /** 仅返回"被该笔记引用过"的附件（走 attachment_references 倒排表）。 */
      noteId?: string;
      q?: string;
      sort?: FileSortKey;
      order?: "asc" | "desc";
      page?: number;
      pageSize?: number;
    } = {}): Promise<FileListResponse> => {
      const qs = new URLSearchParams();
      // 注意：FileCategory 已收窄为 "image" | "file"，不再含 "all"。
      // 调用方（FileManager）自己维护 "all" | FileCategory 的 UI 过滤，
      // 在传进来之前就会把 "all" 映射成 undefined，这里只需非空判断。
      if (params.category) qs.set("category", params.category);
      if (params.filter) qs.set("filter", params.filter);
      // myUploadsRef 仅在 filter=myUploads 时才有意义；后端会忽略其他场景，
      // 但为了让 URL 干净，前端只在 filter 匹配时传。
      if (params.filter === "myUploads" && params.myUploadsRef) {
        qs.set("myUploadsRef", params.myUploadsRef);
      }
      if (params.mime) qs.set("mime", params.mime);
      if (params.notebookId) qs.set("notebookId", params.notebookId);
      if (params.noteId) qs.set("noteId", params.noteId);
      if (params.q) qs.set("q", params.q);
      if (params.sort) qs.set("sort", params.sort);
      if (params.order) qs.set("order", params.order);
      if (typeof params.page === "number") qs.set("page", String(params.page));
      if (typeof params.pageSize === "number") qs.set("pageSize", String(params.pageSize));
      // Y4: workspace scope
      const ws = getCurrentWorkspace();
      if (ws && ws !== "personal") qs.set("workspaceId", ws);
      const s = qs.toString();
      return request<FileListResponse>(`/files${s ? `?${s}` : ""}`);
    },

    /** 取单个文件详情，含反向引用的笔记列表。按 id 查，无需 workspaceId。 */
    get: (id: string) => request<FileDetail>(`/files/${id}`),

    /** 删除单个附件（含磁盘文件）。会做 ACL 校验，被别的笔记引用也一并断链。 */
    remove: (id: string) =>
      request<{ success: boolean }>(`/files/${id}`, { method: "DELETE" }),

    /**
     * 批量删除附件（含磁盘文件）。
     * 单次最多 200 个；后端逐项做 ACL，部分失败不影响其它项继续删。
     * 返回值里的 failed[] 会列出被跳过的 id 与原因，前端按需提示。
     */
    batchRemove: (ids: string[]) =>
      request<{
        success: boolean;
        deleted: number;
        failed: Array<{ id: string; reason: string }>;
      }>(`/files/batch-delete`, {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),

    /**
     * 重命名附件（仅改 attachments.filename 字段；磁盘上的 <uuid>.<ext> 不动）。
     *
     * - 后端会自动补扩展名：若新名不含点，会把原扩展接上；
     * - 返回 { success, filename }，filename 是后端最终采用的名字（可能补过扩展）。
     */
    rename: (id: string, filename: string) =>
      request<{ success: boolean; filename: string; unchanged?: boolean }>(
        `/files/${id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ filename }),
        },
      ),

    /**
     * 上传一份文件到文件管理（无笔记归属时后端落到 holder note）。
     * 用 FormData；不要手动设 Content-Type，交给浏览器注入 multipart boundary。
     * Y4: 自动把 workspaceId 作为 query 传给后端；后端会把 holder note 与
     *     attachments.workspaceId 一起落到对应 scope。
     */
    upload: async (file: File, opts: { noteId?: string; notebookId?: string } = {}): Promise<FileItem> => {
      const token = getToken();
      const form = new FormData();
      form.append("file", file);
      if (opts.noteId) form.append("noteId", opts.noteId);
      if (opts.notebookId) form.append("notebookId", opts.notebookId);
      const ws = getCurrentWorkspace();
      const qs = ws && ws !== "personal" ? `?workspaceId=${encodeURIComponent(ws)}` : "";
      const res = await fetch(`${getBaseUrl()}/files/upload${qs}`, {
        method: "POST",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: form,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `文件上传失败: ${res.status}`);
      }
      return res.json();
    },
  },

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
  restoreNoteVersion: (noteId: string, versionId: string) => {
    const p = request<Note>(`/shares/note/${noteId}/versions/${versionId}/restore`, { method: "POST" });
    p.then((note) => {
      void import("@/lib/syncEngine").then((m) => m.cacheNoteContent(note)).catch(() => {});
    }).catch(() => {});
    return p;
  },
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

    let result = "";
    const emit = (chunks: string[]) => {
      for (const c of chunks) {
        if (!c) continue;
        result += c;
        onChunk?.(c);
      }
    };

    // 部分 Android WebView 不支持 res.body 流（返回 null）。这种情况下退化为
    // "等响应结束、整段拿到 text 再按 SSE 协议解析一次"——失去打字机效果，
    // 但至少不会把 {"t":...}{"t":...} 原样喂给用户看。
    if (!res.body || typeof res.body.getReader !== "function") {
      const fullText = await res.text();
      const { events } = parseSseChunks(fullText + "\n\n");
      for (const data of events) {
        if (data === "[DONE]") break;
        emit(extractContentChunks(data));
      }
      return result;
    }

    // 流式路径：用 parseSseChunks 切事件，再用 extractContentChunks 兜底解析
    // "多对象合并到一个 data 行"的 Android WebView 退化情况（见 splitConcatenatedJson 注释）。
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    while (!done) {
      const r = await reader.read();
      done = r.done;
      if (r.value) buffer += decoder.decode(r.value, { stream: true });
      const parsed = parseSseChunks(buffer);
      buffer = parsed.rest;
      for (const data of parsed.events) {
        if (data === "[DONE]") { done = true; break; }
        emit(extractContentChunks(data));
      }
    }
    // 收尾：buffer 里可能残留一帧（流结束时未必有 \n\n），强制再走一遍解析
    if (buffer.trim()) {
      const tail = parseSseChunks(buffer + "\n\n");
      for (const data of tail.events) {
        if (data === "[DONE]") break;
        emit(extractContentChunks(data));
      }
    }
    return result;
  },

  aiAsk: async (
    question: string,
    history?: { role: string; content: string }[],
    onChunk?: (chunk: string) => void,
    onReferences?: (refs: {
      id: string;
      title: string;
      // v8：附件命中时后端会把 kind='attachment' + attachmentId/filename 一起发。
      // 老后端没有这些字段，这里标为可选保持前后向兼容。
      kind?: "note" | "attachment";
      attachmentId?: string;
      attachmentFilename?: string;
    }[]) => void,
    options?: { notebookId?: string; includeChildren?: boolean }
  ): Promise<string> => {
    const token = getToken();
    // v7 RAG 隔离：把当前 scope 透传给后端
    //   personal → 不带 ?workspaceId（后端按 workspaceId IS NULL 走个人空间）
    //   <uuid>   → 带 ?workspaceId=<uuid>（后端校验成员身份后按工作区检索）
    const ws = getCurrentWorkspace();
    const qs = ws && ws !== "personal" ? `?workspaceId=${encodeURIComponent(ws)}` : "";
    const res = await fetch(`${getBaseUrl()}/ai/ask${qs}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ question, history, notebookId: options?.notebookId, includeChildren: options?.includeChildren }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `AI 请求失败: ${res.status}`);
    }

    let result = "";
    const handleArray = (arr: any[]) => {
      // 后端在内容流里夹一条数组 = 参考笔记列表 [{id,title},...]
      if (arr.length > 0 && arr[0]?.id && arr[0]?.title) {
        onReferences?.(arr);
      }
    };
    const emit = (chunks: string[]) => {
      for (const c of chunks) {
        if (!c) continue;
        result += c;
        onChunk?.(c);
      }
    };

    if (!res.body || typeof res.body.getReader !== "function") {
      const fullText = await res.text();
      const { events } = parseSseChunks(fullText + "\n\n");
      for (const data of events) {
        if (data === "[DONE]") break;
        emit(extractContentChunks(data, handleArray));
      }
      return result;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    while (!done) {
      const r = await reader.read();
      done = r.done;
      if (r.value) buffer += decoder.decode(r.value, { stream: true });
      const parsed = parseSseChunks(buffer);
      buffer = parsed.rest;
      for (const data of parsed.events) {
        if (data === "[DONE]") { done = true; break; }
        emit(extractContentChunks(data, handleArray));
      }
    }
    if (buffer.trim()) {
      const tail = parseSseChunks(buffer + "\n\n");
      for (const data of tail.events) {
        if (data === "[DONE]") break;
        emit(extractContentChunks(data, handleArray));
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
    // v7：按当前 scope 拉统计；个人空间不带 workspaceId
    const ws = getCurrentWorkspace();
    const qs = ws && ws !== "personal" ? `?workspaceId=${encodeURIComponent(ws)}` : "";
    const res = await fetch(`${getBaseUrl()}/ai/knowledge-stats${qs}`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) throw new Error("获取知识库统计失败");
    return res.json();
  },

  // AI 聊天记录：跨会话持久化到后端（v10 起支持多会话）
  notebookSummary: async (notebookId: string, includeChildren = true): Promise<{ summary: string; noteCount: number }> => {
    const token = getToken();
    const ws = getCurrentWorkspace();
    const qs = ws && ws !== "personal" ? `?workspaceId=${encodeURIComponent(ws)}` : "";
    const res = await fetch(`${getBaseUrl()}/ai/notebook-summary${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ notebookId, includeChildren }),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `请求失败: ${res.status}`); }
    return res.json();
  },
  notebookMermaid: async (notebookId: string, includeChildren = true, diagramType: "mindmap" | "flowchart" = "mindmap"): Promise<{ mermaid: string; diagramType: string; noteCount: number }> => {
    const token = getToken();
    const ws = getCurrentWorkspace();
    const qs = ws && ws !== "personal" ? `?workspaceId=${encodeURIComponent(ws)}` : "";
    const res = await fetch(`${getBaseUrl()}/ai/notebook-mermaid${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ notebookId, includeChildren, diagramType }),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `请求失败: ${res.status}`); }
    return res.json();
  },

  // 这些方法失败时抛错由调用方决定如何容错（通常面板加载失败就退回空列表即可）。
  getAiChatHistory: async (
    limit = 100,
    conversationId?: string,
  ): Promise<{
    messages: {
      id: string;
      role: "user" | "assistant";
      content: string;
      references?: {
        id: string;
        title: string;
        kind?: "note" | "attachment";
        attachmentId?: string;
        attachmentFilename?: string;
      }[];
      createdAt: string;
    }[];
    conversationId: string | null;
  }> => {
    const token = getToken();
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (conversationId) params.set("conversationId", conversationId);
    const res = await fetch(`${getBaseUrl()}/ai/chat-history?${params.toString()}`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) throw new Error("加载聊天记录失败");
    return res.json();
  },

  appendAiChatHistory: async (msg: {
    id?: string;
    conversationId?: string;
    role: "user" | "assistant";
    content: string;
    references?: {
      id: string;
      title: string;
      kind?: "note" | "attachment";
      attachmentId?: string;
      attachmentFilename?: string;
    }[];
  }): Promise<{ ok: boolean; id?: string; createdAt?: string; skipped?: boolean; conversationId?: string }> => {
    const token = getToken();
    const res = await fetch(`${getBaseUrl()}/ai/chat-history`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(msg),
    });
    if (!res.ok) throw new Error("保存聊天记录失败");
    return res.json();
  },

  clearAiChatHistory: async (conversationId?: string): Promise<{ ok: boolean; deleted: number }> => {
    const token = getToken();
    const params = new URLSearchParams();
    if (conversationId) params.set("conversationId", conversationId);
    const qs = params.toString();
    const res = await fetch(`${getBaseUrl()}/ai/chat-history${qs ? `?${qs}` : ""}`, {
      method: "DELETE",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) throw new Error("清空聊天记录失败");
    return res.json();
  },

  // ========== AI 会话（多对话）==========
  // 约定：一个会话就是一个"话题"，可改名、可删除。消息通过 conversationId 挂到会话。
  // 列表失败由组件自行兜底（退化到"空列表 + 创建默认会话"即可）。
  aiConversations: {
    list: () =>
      request<{
        conversations: {
          id: string;
          title: string;
          archived: boolean;
          createdAt: string;
          updatedAt: string;
          messageCount: number;
          lastMessage: string | null;
          lastRole: string | null;
        }[];
      }>("/ai/conversations"),
    create: (data?: { title?: string }) =>
      request<{
        conversation: {
          id: string;
          title: string;
          archived: boolean;
          createdAt: string;
          updatedAt: string;
          messageCount: number;
          lastMessage: string | null;
          lastRole: string | null;
        };
      }>("/ai/conversations", {
        method: "POST",
        body: JSON.stringify(data || {}),
      }),
    update: (id: string, data: { title?: string; archived?: boolean }) =>
      request<{ ok: boolean }>(`/ai/conversations/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    remove: (id: string) =>
      request<{ ok: boolean }>(`/ai/conversations/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
  },

  // ========== AI 自定义指令模板（P2）==========
  // 与写作助手的"自定义指令"配合：列出 / 创建 / 更新 / 删除 / 点击计数。
  // 所有失败情况都抛 Error，调用方自行 toast；列表失败退化为空数组由组件容错。
  aiPrompts: {
    list: () =>
      request<{
        items: {
          id: string;
          name: string;
          prompt: string;
          usageCount: number;
          lastUsedAt: string | null;
          createdAt: string;
          updatedAt: string;
        }[];
      }>("/ai/prompts"),
    create: (data: { name: string; prompt: string }) =>
      request<{
        id: string;
        name: string;
        prompt: string;
        usageCount: number;
        lastUsedAt: string | null;
        createdAt: string;
        updatedAt: string;
      }>("/ai/prompts", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (id: string, data: { name: string; prompt: string }) =>
      request<{
        id: string;
        name: string;
        prompt: string;
        usageCount: number;
        lastUsedAt: string | null;
        createdAt: string;
        updatedAt: string;
      }>(`/ai/prompts/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    remove: (id: string) =>
      request<{ ok: boolean }>(`/ai/prompts/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    touch: (id: string) =>
      request<{ ok: boolean }>(`/ai/prompts/${encodeURIComponent(id)}/touch`, {
        method: "POST",
      }),
  },

  // ========== AI 自动归类（P3）==========
  // 让 AI 根据笔记内容推荐目标笔记本；返回最多 3 条建议按 confidence 降序。
  // 前端拿到建议后可直接用 api.updateNote 移动，或让用户确认后再移动。
  // workspaceId 自动从当前 scope 注入（个人空间不带，沿用其他 AI 端点约定）。
  aiClassify: (params: { noteId?: string; title?: string; content?: string }) => {
    const ws = getCurrentWorkspace();
    const qs = ws && ws !== "personal" ? `?workspaceId=${encodeURIComponent(ws)}` : "";
    return request<{
      suggestions: {
        notebookId: string;
        notebookName: string;
        path: string;
        confidence: number;
        reason: string;
      }[];
      currentNotebookId?: string | null;
    }>(`/ai/classify${qs}`, {
      method: "POST",
      body: JSON.stringify({
        noteId: params.noteId,
        title: params.title,
        content: params.content,
      }),
    });
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
    // v7：与 getKnowledgeStats 一致——按当前 scope 上传；
    // 个人空间不带 workspaceId，工作区把当前 workspaceId 透传给后端，
    // 后端会把笔记/笔记本写到对应 scope，避免落到个人空间。
    const ws = getCurrentWorkspace();
    const qs = ws && ws !== "personal" ? `?workspaceId=${encodeURIComponent(ws)}` : "";
    const res = await fetch(`${getBaseUrl()}/ai/import-to-knowledge${qs}`, {
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
  /**
   * 系统管理员：列出所有工作区（含 ownerName / ownerUsername），用于
   * 「设置 → 工作区管理」面板。后端用 requireAdmin 闸门，普通用户调用会 403。
   */
  listAllWorkspaces: () => request<WorkspaceAdminItem[]>("/workspaces/all"),
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

  // ========== 工作区功能开关（Phase 1 数据隔离）==========
  // 约定：
  //   - 后端返回 normalized 结构（所有 key 都有 boolean 值，undefined 语义已被后端回填为 true）。
  //   - 前端可直接 setState，无需再做 undefined=true 的容错。
  //   - PUT 是 PATCH 语义：只传要改的 key，后端会与现有配置合并。
  getWorkspaceFeatures: (id: string) =>
    request<WorkspaceFeatures>(`/workspaces/${id}/features`),
  updateWorkspaceFeatures: (id: string, patch: Partial<WorkspaceFeatures>) =>
    request<WorkspaceFeatures>(`/workspaces/${id}/features`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  // ========== 数据库文件（.data）导出 / 导入 / 占用统计 ==========
  //
  // - getDataFileInfo  所有登录用户可见；普通用户看自己数据量，管理员额外拿到整库文件大小/data 目录占用
  // - exportDataFile   管理员下载当前 `.data` 文件（SQLite 在线快照）
  // - importDataFile   管理员上传 `.data` 文件覆盖当前库（需 sudo + 重启后端）
  dataFile: {
    getInfo: () =>
      request<{
        dbFile: { path?: string; main: number; wal: number; shm: number; total: number };
        user: {
          notes: { count: number; bytes: number };
          attachments: { count: number; bytes: number };
          notebookCount: number;
          totalBytes: number;
        };
        system: {
          noteCount: number;
          userCount: number;
          notebookCount: number;
          dataDirBytes?: number;
          dataDirPath?: string;
        };
      }>("/data-file/info"),

    /**
     * 下载当前数据库文件。用浏览器原生下载流程：
     *   - fetch 返回 Blob（带 Content-Disposition filename）
     *   - 生成 ObjectURL → <a download> → click → revoke
     * 不走 request()，因为 request 只处理 JSON。
     */
    downloadExport: async () => {
      const token = localStorage.getItem("nowen-token");
      const res = await fetch(`${getBaseUrl()}/data-file/export`, {
        method: "GET",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`导出失败: ${res.status} ${errText}`);
      }
      // 从 Content-Disposition 里提取 filename
      const cd = res.headers.get("Content-Disposition") || "";
      const m = cd.match(/filename="?([^";]+)"?/);
      const fallbackTs = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = m?.[1] || `nowen-note-${fallbackTs}.data`;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { filename, size: blob.size };
    },

    /**
     * 上传 `.data` 文件替换当前库。
     * 需要 sudoToken（通过 withSudo 或 requestSudoToken 获取）。
     * 成功后 requireRestart=true —— 调用方必须明确提示用户重启后端。
     */
    uploadImport: async (file: File, sudoToken: string) => {
      const token = localStorage.getItem("nowen-token");
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${getBaseUrl()}/data-file/import`, {
        method: "POST",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "X-Sudo-Token": sudoToken,
          // 注意：不要手动设 Content-Type，浏览器会自动加 boundary
        },
        body: form,
      });
      const body = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) {
        const err = new Error(body?.error || `导入失败: ${res.status}`) as Error & { code?: string; status?: number };
        err.code = body?.code;
        err.status = res.status;
        throw err;
      }
      return body as { success: true; requireRestart: boolean; message: string; size: number; preImportBackup: string };
    },

    /**
     * 清理孤儿附件：
     *   - DB 孤儿：attachments 行对应 note 不存在
     *   - 内容孤儿：note 还在，但 notes.content 里不再引用该附件（解决"清理
     *     完文件管理里还能看到孤立图片"的问题）。有 24h 宽限期避免误杀新上传。
     *   - 磁盘孤儿：磁盘上有文件但 DB 无登记（仅管理员）
     *
     * @param dryRun 仅返回"将要清理"的统计，不真动磁盘/DB。
     *               前端用来显示"可回收 X MB / 共 N 项"的徽标。
     */
    cleanupOrphans: (opts?: { dryRun?: boolean; graceHours?: number }) => {
      const qs = new URLSearchParams();
      if (opts?.dryRun) qs.set("dryRun", "1");
      if (typeof opts?.graceHours === "number") qs.set("graceHours", String(opts.graceHours));
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request<{
        success: true;
        dryRun: boolean;
        graceHours: number;
        // DB 孤儿
        dbOrphansRemoved: number;
        dbOrphanFilesRemoved: number;
        dbOrphanBytes: number;
        // 内容孤儿（本次新增）
        contentOrphansRemoved: number;
        contentOrphanFilesRemoved: number;
        contentOrphanBytes: number;
        // 磁盘孤儿
        diskOrphansRemoved: number;
        diskOrphanBytes: number;
        diskScanSkipped: boolean;
        // 汇总
        totalFreedBytes: number;
        totalRemovedItems: number;
      }>(`/data-file/cleanup-orphans${suffix}`, { method: "POST" });
    },

    /**
     * 压缩 SQLite 数据库（VACUUM）——真正把删除后的空闲 page 释放回磁盘。
     * 仅管理员可执行。
     */
    vacuum: () =>
      request<{
        success: true;
        before: { main: number; wal: number; shm: number; total: number };
        after: { main: number; wal: number; shm: number; total: number };
        freed: number;
      }>("/data-file/vacuum", { method: "POST" }),
  },

  // ============================================================
  // 数据备份（B 系列）
  // ------------------------------------------------------------
  // 备份与 dataFile 区别：
  //   - dataFile 直接吐 raw `.data` SQLite 文件，给"换机器迁库"用；
  //   - backup   产生带 meta.json 的 zip（含附件 / 字体 / 插件 / 上传文件 / 加密 secret），
  //     是\"灾备\"语义，由后端 BackupManager 周期性写到独立卷。
  //
  // 健康指标 (/status) 字段供前端渲染:
  //   degraded                 → 需要红色横幅
  //   consecutiveFailures      → 连续失败次数（≥3 触发 degraded）
  //   hoursSinceLastSuccess    → 距上次成功小时数；超过 2x 间隔会触发 degraded
  //   sameVolume               → 备份目录与数据目录同卷（黄色告警）
  //   backupDirWritable=false  → 红色：根本写不进去
  //   lastFailureReason        → 鼠标 hover 看具体错误
  // ============================================================
  backup: {
    /** 健康指标（B4） */
    status: () =>
      request<{
        lastSuccessAt: string | null;
        lastFailureAt: string | null;
        lastFailureReason: string | null;
        consecutiveFailures: number;
        degraded: boolean;
        autoBackupRunning: boolean;
        autoBackupIntervalHours: number;
        autoBackupMode?: "interval" | "daily";
        autoBackupDailyAt?: string;
        autoBackupKeepCount?: number;
        autoBackupEmailOnSuccess?: boolean;
        autoBackupEmailTo?: string;
        autoBackupNextRunAt?: string | null;
        hoursSinceLastSuccess: number | null;
        backupDir: string;
        dataDir: string;
        sameVolume: boolean;
        backupDirWritable: boolean;
        backupDirFreeBytes: number | null;
      }>("/backups/status"),

    /** 列出所有备份 */
    list: () =>
      request<Array<{
        id: string;
        filename: string;
        size: number;
        type: "full" | "db-only";
        createdAt: string;
        noteCount: number;
        notebookCount: number;
        checksum: string;
        formatVersion: number;
        schemaVersion: number;
        description?: string;
      }>>("/backups"),

    /** 创建一次备份（管理员 + sudo） */
    create: (type: "full" | "db-only" = "db-only", sudoToken?: string, description?: string) =>
      request<{
        id: string;
        filename: string;
        size: number;
      }>("/backups", { method: "POST", body: JSON.stringify({ type, description }), sudoToken }),

    /**
     * 导入外部备份文件（.bak / .zip）到当前实例的备份仓库（管理员 + sudo）。
     *
     * 典型场景：
     *   - 管理员收到「发送到邮箱」的 .bak 附件，想在别的实例接上；
     *   - 从 U盘 / 异机拷贝 nowen-backup-*.zip 过来。
     *
     * 导入本身不触及现网数据——文件只是被放进 backupDir 并补齐 meta.json。要真
     * 正应用它，管理员还需要在列表里点「恢复」，走 dryRun 预览 + sudo 二次确认
     * 的完整流程，与就地创建的备份完全同构。
     *
     * 约束（违反会返回 400）：
     *   - 扩展名必须是 .bak / .zip；
     *   - .bak 文件头必须是 SQLite；.zip 必须含 meta.json + db.sqlite；
     *   - 单文件 ≤ 500MB（超限请用服务器文件系统拷贝到 backupDir）。
     *
     * 注意：本调用绕过 request() 通用封装，因为 Content-Type 需要让浏览器
     * 自动带上 multipart boundary；错误同样以 Error 抛出（带 code / status）。
     */
    upload: async (
      file: File,
      sudoToken: string,
      description?: string,
    ): Promise<{
      id: string;
      filename: string;
      size: number;
      type: "full" | "db-only";
      createdAt: string;
      noteCount: number;
      notebookCount: number;
      checksum: string;
      formatVersion: number;
      schemaVersion: number;
      description?: string;
    }> => {
      const token = getToken();
      const form = new FormData();
      form.append("file", file);
      if (description) form.append("description", description);
      const res = await fetch(`${getBaseUrl()}/backups/upload`, {
        method: "POST",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "X-Sudo-Token": sudoToken,
          // 注意：不要手动设 Content-Type，浏览器会自动加 boundary
        },
        body: form,
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const err = new Error(
          (body?.error as string) || `导入失败: ${res.status}`,
        ) as Error & { code?: string; status?: number };
        err.code = body?.code as string | undefined;
        err.status = res.status;
        throw err;
      }
      return body as Awaited<ReturnType<typeof api.backup.upload>>;
    },

    /**
     * 启停自动备份（管理员 + sudo）
     *
     * 后端把全量配置持久化到 system_settings.backup:auto，重启后由
     * BackupManager.readEffectiveAutoConfig 读取并按需启动。
     *
     * 旧签名 setAuto(enabled, intervalHours, sudoToken) 仍可用——
     * 新增的 mode/dailyAt/keepCount/email* 缺省时由后端走默认值。
     */
    setAuto: (
      enabled: boolean,
      intervalHours?: number,
      sudoToken?: string,
      extra?: {
        mode?: "interval" | "daily";
        dailyAt?: string;
        keepCount?: number;
        emailOnSuccess?: boolean;
        emailTo?: string;
      },
    ) =>
      request<{
        success: true;
        message: string;
        enabled: boolean;
        intervalHours: number;
        mode?: "interval" | "daily";
        dailyAt?: string;
        keepCount?: number;
        emailOnSuccess?: boolean;
        emailTo?: string;
      }>(
        "/backups/auto",
        {
          method: "POST",
          body: JSON.stringify({ enabled, intervalHours, ...(extra || {}) }),
          sudoToken,
        },
      ),

    /** 删除一份备份（管理员 + sudo） */
    remove: (filename: string, sudoToken?: string) =>
      request<{ success: boolean }>(`/backups/${encodeURIComponent(filename)}`, { method: "DELETE", sudoToken }),

    /**
     * 从备份恢复。
     *
     * **强烈推荐两步走**：
     *   1. dryRun=true（无需 sudoToken）→ 拿到将清空 / 插入 多少行的预览，
     *      在 UI 弹"确认"对话框；
     *   2. dryRun=false（**必须** sudoToken）→ 真正执行；后端会先做安全备份再覆盖。
     *
     * 单步直接 dryRun=false 也能跑，只是 UX 极差（用户没机会看到影响范围）。
     */
    restore: (filename: string, dryRun: boolean, sudoToken?: string) =>
      request<{
        success: boolean;
        error?: string;
        stats?: Record<string, number>;
        dryRun?: {
          tables: { name: string; willClear: number; willInsert: number }[];
          files: { attachments: number; fonts: number; plugins: number };
          schemaVersion: number;
        };
      }>(`/backups/${encodeURIComponent(filename)}/restore?dryRun=${dryRun ? 1 : 0}`, {
        method: "POST",
        body: JSON.stringify({ dryRun }),
        sudoToken: dryRun ? undefined : sudoToken,
      }),

    /**
     * 当前生效的备份目录 + 数据目录。
     * 用于在配置区显示 "现在备份写到哪 / dataDir 是哪"，让管理员判断是否需要切换。
     */
    getDir: () => request<{ backupDir: string; dataDir: string }>("/backups/dir"),

    /**
     * 切换备份目录。
     *
     * **强烈推荐两步走**：
     *   1. dryRun=true（无需 sudoToken）→ 拿到 ok/reason/sameVolume/freeBytes，
     *      在 UI 提前显示 "同卷警告 / 不可写报错 / 可用空间"；
     *   2. dryRun=false（**必须** sudoToken）→ 真正切换并持久化到 system_settings；
     *      切换后旧目录的备份文件不会被自动迁移（需要的话管理员手动 cp）。
     *
     * 后端约束（违反会返回 400 + reason）：
     *   - 必须绝对路径（reason: "not_absolute"）
     *   - 不能等于 dataDir（"equals_data_dir"）
     *   - 不能位于 dataDir 内部（"inside_data_dir"）
     *   - 必须可创建（"create_failed"）+ 可写（"not_writable"）
     */
    setDir: (dirPath: string, dryRun: boolean, sudoToken?: string) =>
      request<{
        ok: boolean;
        dryRun?: boolean;
        resolved: string;
        sameVolume?: boolean;
        freeBytes?: number | null;
        // 失败时
        reason?: "not_absolute" | "inside_data_dir" | "equals_data_dir" | "create_failed" | "not_writable";
        message?: string;
      }>(`/backups/dir?dryRun=${dryRun ? 1 : 0}`, {
        method: "POST",
        body: JSON.stringify({ path: dirPath, dryRun }),
        sudoToken: dryRun ? undefined : sudoToken,
      }),

    /**
     * 将一份备份作为附件发送到指定邮箱（管理员 + sudo）。
     *
     * 前置条件：
     *   - 必须先在 /api/email/smtp 配好 SMTP 并 enabled=true；
     *   - 附件上限 25 MB，超限后端返回 413 + ATTACHMENT_TOO_LARGE。
     *
     * 附件格式选择（createNew）：
     *   - 不传 / "current"：直接发送 URL 里指定的 filename 备份；
     *   - "full"   ：后端现场生成一份新的 .zip 全量备份再发送（会留在备份列表中）；
     *   - "db-only"：后端现场生成一份新的 .bak 数据库快照再发送（会留在备份列表中）。
     *
     * 这样用户不用手动先"创建 → 再发送"，在一步操作内就能完成
     * "归档 + 投递邮箱"，同时保留可追溯的本地副本。
     *
     * 设计注记：
     *   - note 只是一行可选备注，附加在邮件正文固定模板之后，
     *     不允许前端自定义 subject/html —— 避免把本站当钓鱼跳板；
     *   - 后端会返回 SMTP 末次响应文本（lastResponse），前端可直接 toast 展示，
     *     定位"被服务商拒收"这类问题特别高效；
     *   - 成功响应额外带 filename/generatedNew，让前端知道真正发出去的是哪份备份。
     */
    sendEmail: (
      filename: string,
      to: string,
      sudoToken?: string,
      note?: string,
      createNew?: "current" | "full" | "db-only",
    ) =>
      request<{
        success: boolean;
        lastResponse?: string;
        size?: number;
        filename?: string;
        generatedNew?: boolean;
      }>(`/backups/${encodeURIComponent(filename)}/send-email`, {
        method: "POST",
        body: JSON.stringify({ to, note, createNew }),
        sudoToken,
      }),
  },

  // ============================================================
  // 邮件服务（SMTP）配置 —— 管理员专属
  // ------------------------------------------------------------
  // 配套 backup.sendEmail 使用：先 GET 拉现状、PUT 写入、POST /test 验证。
  // 所有接口都走 requireAdmin，非管理员会直接收到 403，前端应根据 /api/me
  // 的 role 字段提前隐藏入口以避免无意义的 403。
  // ============================================================
  email: {
    /** 读取当前 SMTP 配置（密码永远不返回明文，只给 hasPassword 标记） */
    getSmtp: () =>
      request<{
        enabled: boolean;
        host: string;
        port: number;
        secure: boolean;
        username: string;
        fromName: string;
        fromEmail: string;
        hasPassword: boolean;
        updatedAt: string | null;
      }>("/email/smtp"),

    /**
     * 写入 SMTP 配置（管理员 + sudo）。
     *
     * password 字段：
     *   - undefined：保持旧密码不变（用于"只改 host/port" 场景）
     *   - ""       ：显式清空旧密码
     *   - 非空串    ：覆盖为新密码（后端 AES-GCM 加密后落库）
     */
    putSmtp: (
      input: {
        enabled: boolean;
        host: string;
        port: number;
        secure: boolean;
        username: string;
        password?: string;
        fromName: string;
        fromEmail: string;
      },
      sudoToken?: string,
    ) =>
      request<{
        enabled: boolean;
        host: string;
        port: number;
        secure: boolean;
        username: string;
        fromName: string;
        fromEmail: string;
        hasPassword: boolean;
        updatedAt: string | null;
      }>("/email/smtp", { method: "PUT", body: JSON.stringify(input), sudoToken }),

    /** 发送测试邮件，返回 success + SMTP 末次响应 */
    testSmtp: (to: string, sudoToken?: string) =>
      request<{ success: boolean; lastResponse?: string; error?: string }>(
        "/email/smtp/test",
        { method: "POST", body: JSON.stringify({ to }), sudoToken },
      ),
  },

  // ============================================================
  // 附件孤儿扫描（A2 配套）
  // ------------------------------------------------------------
  // 与 dataFile.cleanupOrphans 不同：
  //   - cleanupOrphans 是\"扫 + 删\"一步走（普通用户也能调，作用域是自己）
  //   - scanOrphans 是\"只扫不删\"的预览，仅管理员，可在删除前展示\"将释放 X MB\"
  // ============================================================
  attachmentsAdmin: {
    getStorageStatus: () =>
      request<{
        storage: {
          driver: "local" | "s3";
          localDir: string;
          bucket?: string;
          endpoint?: string;
          prefix?: string;
          migrationCommand?: string;
        };
        db: {
          rows: number;
          bytes: number;
          attachments: { count: number; bytes: number };
          diaryAttachments: { count: number; bytes: number };
          taskAttachments: { count: number; bytes: number };
        };
        local: { dir: string; files: number; bytes: number };
        migrationCommand?: string | null;
        checkedAt: string;
      }>("/attachments/_storage/status"),

    getStorageConfig: () =>
      request<{
        enabled: boolean;
        endpoint: string;
        region: string;
        bucket: string;
        accessKeyId: string;
        prefix: string;
        secretAccessKeySet: boolean;
        source: "settings" | "env" | "default";
        updatedAt: string | null;
      }>("/attachments/_storage/config"),

    putStorageConfig: (
      input: {
        enabled: boolean;
        endpoint: string;
        region?: string;
        bucket: string;
        accessKeyId: string;
        secretAccessKey?: string;
        prefix?: string;
      },
      sudoToken?: string,
    ) =>
      request<{
        enabled: boolean;
        endpoint: string;
        region: string;
        bucket: string;
        accessKeyId: string;
        prefix: string;
        secretAccessKeySet: boolean;
        source: "settings" | "env" | "default";
        updatedAt: string | null;
      }>("/attachments/_storage/config", { method: "PUT", body: JSON.stringify(input), sudoToken }),

    deleteStorageConfig: (sudoToken?: string) =>
      request<{
        enabled: boolean;
        endpoint: string;
        region: string;
        bucket: string;
        accessKeyId: string;
        prefix: string;
        secretAccessKeySet: boolean;
        source: "settings" | "env" | "default";
        updatedAt: string | null;
      }>("/attachments/_storage/config", { method: "DELETE", sudoToken }),

    testStorageConfig: (sudoToken?: string) =>
      request<{ ok: boolean; error?: string }>("/attachments/_storage/test", { method: "POST", sudoToken }),

    checkRemoteStorage: (limit = 50) =>
      request<{
        ok: boolean;
        skipped: boolean;
        reason?: string;
        storage: {
          driver: "local" | "s3";
          localDir: string;
          bucket?: string;
          endpoint?: string;
          prefix?: string;
          migrationCommand?: string;
        };
        total: number;
        limit: number;
        checked: number;
        exists: number;
        missing: Array<{ path: string; size: number; refs: number; status?: number }>;
        errors: Array<{ path: string; size: number; refs: number; status?: number; error: string }>;
        checkedAt: string;
      }>(`/attachments/_storage/remote-check?limit=${encodeURIComponent(limit)}`),

    /** GET /api/attachments/_orphans/scan — 仅扫描，不删除 */
    scanOrphans: (graceHours = 24) =>
      request<{
        dbOrphans: Array<{ filename: string; bytes: number }>;
        contentOrphans: Array<{ id: string; filename: string; bytes: number; noteId: string; createdAt: string }>;
        reclaimableBytes: number;
        totalAttachmentBytes: number;
        graceHours: number;
      }>(`/attachments/_orphans/scan?graceHours=${encodeURIComponent(graceHours)}`),

    /** GET /api/attachments/_health/report — 附件健康检查：裂图/悬空引用/共享物理文件 */
    scanHealth: (graceHours = 24) =>
      request<{
        ok: boolean;
        totalAttachments: number;
        totalPhysicalFiles: number;
        totalAttachmentBytes: number;
        missingPhysicalFiles: Array<{
          id: string;
          noteId: string;
          noteTitle?: string;
          filename: string;
          path: string;
          mimeType?: string;
          size: number;
          createdAt: string;
          referencedBy: number;
        }>;
        danglingReferences: Array<{
          attachmentId: string;
          noteId: string;
          noteTitle?: string;
          isTrashed?: boolean;
        }>;
        sharedPhysicalFiles: Array<{
          path: string;
          count: number;
          bytes: number;
          attachmentIds: string[];
        }>;
        orphans: {
          dbOrphans: Array<{ filename: string; bytes: number }>;
          contentOrphans: Array<{ id: string; filename: string; bytes: number; noteId: string; createdAt: string }>;
          reclaimableBytes: number;
          totalAttachmentBytes: number;
          graceHours: number;
        };
        checkedAt: string;
      }>(`/attachments/_health/report?graceHours=${encodeURIComponent(graceHours)}`),

    /** POST /api/attachments/_repair/missing/:id/upload — 上传替代文件修复缺失物理文件 */
    uploadMissingReplacement: async (id: string, file: File, sudoToken: string, opts?: { force?: boolean }) => {
      const token = getToken();
      const form = new FormData();
      form.append("file", file);
      if (opts?.force) form.append("force", "1");
      const res = await fetch(`${getBaseUrl()}/attachments/_repair/missing/${encodeURIComponent(id)}/upload`, {
        method: "POST",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "X-Sudo-Token": sudoToken,
        },
        body: form,
      });
      const body = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) {
        const err = new Error(body?.error || `修复失败: ${res.status}`) as Error & { code?: string; status?: number };
        err.code = body?.code;
        err.status = res.status;
        throw err;
      }
      return body as {
        success: true;
        repairedRows: number;
        path: string;
        size: number;
        hash: string;
        health: any;
      };
    },

    /** POST /api/attachments/_repair/dangling/remove — 移除正文中的悬空附件引用 */
    removeDanglingReferences: (body: { attachmentIds: string[]; noteIds?: string[] }, sudoToken: string) =>
      request<{
        success: true;
        notesUpdated: number;
        referencesRemoved: number;
        changed: Array<{ noteId: string; removed: number }>;
        health: any;
      }>("/attachments/_repair/dangling/remove", {
        method: "POST",
        body: JSON.stringify(body),
        sudoToken,
      }),
  },

  // ============================================================
  // Personal API Tokens（个人访问令牌）管理
  // ------------------------------------------------------------
  // 设计原则（与后端 backend/src/routes/tokens.ts 对应）：
  //   - 列表只返回元信息（名称 / scopes / 过期 / 最近使用），永远不返回明文；
  //   - 创建后**只此一次**返回明文（response.token），UI 必须立刻让用户复制；
  //   - 吊销是软删除（保留审计字段 revokedAt），列表里仍可见但状态为"已吊销"；
  //   - 后端禁止用 API Token 自己再创建 Token（防止权限自我增殖）。
  // ============================================================
  tokens: {
    /** GET /api/tokens — 列出当前用户的所有 token + 服务端支持的 scope 集合 */
    list: () =>
      request<{
        tokens: Array<{
          id: string;
          name: string;
          scopes: string[];
          /** ISO 字符串 / null 表示永不过期 */
          expiresAt: string | null;
          lastUsedAt: string | null;
          lastUsedIp: string | null;
          createdAt: string;
          /** ISO 字符串 / null 表示尚未吊销（软删除标记） */
          revokedAt: string | null;
        }>;
        availableScopes: readonly string[];
      }>("/tokens"),

    /**
     * POST /api/tokens — 创建新的 Personal API Token
     *
     * **注意**：返回的 `token` 字段是明文，**仅此一次**！UI 必须立即提示用户复制。
     * - 不传 expiresAt 和 expiresInDays → 永不过期（用户可随时手动吊销）
     * - expiresInDays 优先于 expiresAt（便于"30/90/365 天"快选 UI）
     */
    create: (payload: {
      name: string;
      scopes: string[];
      /** 二选一：指定天数 30/90/365 等，或者直接给 ISO 时间 */
      expiresInDays?: number;
      expiresAt?: string | null;
    }) =>
      request<{
        id: string;
        name: string;
        scopes: string[];
        expiresAt: string | null;
        createdAt: string;
        token: string;
        warning: string;
      }>("/tokens", { method: "POST", body: JSON.stringify(payload) }),

    /** DELETE /api/tokens/:id — 吊销 token（软删，保留审计） */
    revoke: (id: string) =>
      request<{ success: boolean; alreadyRevoked?: boolean }>(`/tokens/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),

    /**
     * GET /api/tokens/usage?days=N — 个人 token 使用统计
     *
     * 用于 TokenManagement 顶部的"使用概览"卡片：
     *   - total / prevTotal 用于显示总量 + 环比变化
     *   - series 是补零后的逐日折线/柱状图数据
     *   - byToken 已按 count 降序，前端取前 N 即可
     */
    usage: (days: 7 | 14 | 30 | 90 = 7) =>
      request<{
        days: number;
        total: number;
        prevTotal: number;
        series: Array<{ day: string; count: number }>;
        byToken: Array<{ tokenId: string; name: string; count: number }>;
      }>(`/tokens/usage?days=${days}`),
  },
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

/** 诊断结果 */
export interface DiagnosisResult {
  step: string;
  ok: boolean;
  detail: string;
}

/**
 * 分层连接诊断（未登录状态可用）。
 *
 * 依次测试：
 *   1. URL 格式检查
 *   2. GET /api/health
 *   3. GET /api/version
 *   4. GET /api/auth/register/config
 *   5. 检查返回是否 JSON（反代可能返回 HTML）
 *
 * 返回每一步的结果，便于 UI 逐行展示。
 */
export async function diagnoseConnection(serverUrl: string): Promise<DiagnosisResult[]> {
  const results: DiagnosisResult[] = [];
  const base = _normalizeBase(serverUrl);

  // Step 1: URL 格式
  if (!base) {
    results.push({ step: "url_format", ok: false, detail: "服务器地址格式无效或为空" });
    return results;
  }
  results.push({ step: "url_format", ok: true, detail: base });

  const baseUrl = `${base}/api`;
  const timeout = 8000;

  async function tryFetch(path: string, label: string): Promise<void> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const res = await fetch(`${baseUrl}${path}`, { signal: controller.signal });
      clearTimeout(timer);

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("text/html")) {
        results.push({ step: label, ok: false, detail: `返回了 HTML（HTTP ${res.status}），反代可能没有转发 /api 路径` });
        return;
      }
      if (!res.ok) {
        results.push({ step: label, ok: false, detail: `HTTP ${res.status}` });
        return;
      }
      try {
        await res.clone().json();
        results.push({ step: label, ok: true, detail: `HTTP ${res.status}，JSON 正常` });
      } catch {
        results.push({ step: label, ok: false, detail: `HTTP ${res.status}，但返回内容不是有效 JSON` });
      }
    } catch (e: any) {
      if (e.name === "AbortError") {
        results.push({ step: label, ok: false, detail: "请求超时（" + timeout / 1000 + "s）" });
      } else if (e instanceof TypeError) {
        results.push({ step: label, ok: false, detail: `网络错误：${e.message}（可能为 CORS / Mixed Content / 证书问题）` });
      } else {
        results.push({ step: label, ok: false, detail: e.message || "未知错误" });
      }
    }
  }

  // Step 2: health
  await tryFetch("/health", "api_health");

  // Step 3: version
  await tryFetch("/version", "api_version");

  // Step 4: register config
  await tryFetch("/auth/register/config", "api_auth");

  return results;
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

