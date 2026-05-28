/**
 * MigrationModal —— 桌面端 "切换到云端账号" 时的迁移向导弹窗
 *
 * 步骤：
 *   1. step="login"      ：让用户填云端地址 + 账号密码，登录拿到 cloudToken
 *   2. step="choice"     ：登录成功后让用户选择「直接进入云端」或「迁移本地数据」
 *   3. step="confirm"    ：给出"将要迁移 X 个笔记到云端账号 Y"的确认
 *   4. step="running"    ：调用 runLightMigration，显示进度
 *   5. step="success"    ：写入 server-url + cloudToken，提示"即将刷新"，自动 reload
 *   6. step="error"      ：展示报错，提供"返回上一步"
 *
 * 设计：组件**不复用 LoginPage**——LoginPage 是全屏页面、自带 i18n 和 2FA 逻辑，
 *      硬塞进弹窗会打架。这里只做最小登录表单（用户名+密码），不支持 2FA。
 *      若用户云端账号开了 2FA，引导他先关闭 2FA 或使用常规登录页。
 *
 * 不做的事：
 *   - 不支持注册（迁移目标必须是已存在的云端账号）
 *   - 不持久化云端密码（仅内存）；但会记录最近成功登录的云端 token，便于下次快速登录
 *   - 不并发：D-2 只有 export+import 两个串行 IO，无需并发
 */

import { useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { Cloud, Loader2, AlertCircle, CheckCircle2, ArrowRight, LogIn, UploadCloud } from "lucide-react";
import { runLightMigration, runAttachmentMigration, rollbackMigration, MigrationProgress, MigrationError } from "@/lib/migrationEngine";
import { getServerUrl as getLocalServerUrl } from "@/lib/api";

type Step = "login" | "choice" | "confirm" | "running" | "success" | "error";
type SuccessKind = "direct" | "migration";

interface CloudLoginRecord {
  id: string;
  cloudUrl: string;
  username: string;
  displayName: string;
  token: string;
  lastUsedAt: number;
}

const CLOUD_LOGIN_RECORDS_KEY = "nowen-cloud-login-records-v1";
const MAX_CLOUD_LOGIN_RECORDS = 8;

function makeRecordId(cloudUrl: string, username: string): string {
  return `${cloudUrl.replace(/\/+$/, "").toLowerCase()}|${username.toLowerCase()}`;
}

function loadCloudLoginRecords(): CloudLoginRecord[] {
  try {
    const raw = localStorage.getItem(CLOUD_LOGIN_RECORDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CloudLoginRecord[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r) => r?.cloudUrl && r?.username && r?.token)
      .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))
      .slice(0, MAX_CLOUD_LOGIN_RECORDS);
  } catch {
    return [];
  }
}

function persistCloudLoginRecords(records: CloudLoginRecord[]): void {
  try {
    localStorage.setItem(CLOUD_LOGIN_RECORDS_KEY, JSON.stringify(records.slice(0, MAX_CLOUD_LOGIN_RECORDS)));
  } catch { /* ignore */ }
}

function upsertCloudLoginRecord(input: Omit<CloudLoginRecord, "id" | "lastUsedAt">): CloudLoginRecord[] {
  const record: CloudLoginRecord = {
    ...input,
    cloudUrl: input.cloudUrl.replace(/\/+$/, ""),
    id: makeRecordId(input.cloudUrl, input.username),
    lastUsedAt: Date.now(),
  };
  const rest = loadCloudLoginRecords().filter((r) => r.id !== record.id);
  const next = [record, ...rest].slice(0, MAX_CLOUD_LOGIN_RECORDS);
  persistCloudLoginRecords(next);
  return next;
}

function removeCloudLoginRecord(id: string): CloudLoginRecord[] {
  const next = loadCloudLoginRecords().filter((r) => r.id !== id);
  persistCloudLoginRecords(next);
  return next;
}

export default function MigrationModal({
  onClose,
  onCancel,
}: {
  /** 迁移成功后调用——通常做 reload */
  onClose: () => void;
  /** 用户点"取消" / "稍后再说"——不做 reload，仅关弹窗 */
  onCancel: () => void;
}) {
  const [step, setStep] = useState<Step>("login");
  const [cloudUrl, setCloudUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [cloudToken, setCloudToken] = useState("");
  const [cloudUserDisplay, setCloudUserDisplay] = useState("");
  const [progress, setProgress] = useState<MigrationProgress>({
    phase: "export",
    ratio: 0,
    message: "",
  });
  const [successKind, setSuccessKind] = useState<SuccessKind>("migration");
  const [loginRecords, setLoginRecords] = useState<CloudLoginRecord[]>(() => loadCloudLoginRecords());
  const [quickLoginId, setQuickLoginId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // D-3 附件阶段的结果摘要（失败了哪些，成功 / 总量）
  const [attSummary, setAttSummary] = useState<{
    total: number;
    succeeded: number;
    failed: Array<{ id: string; filename: string; reason: string }>;
  } | null>(null);
  // 回滚提示：迁移失败后是否已成功清理云端脱不到的那部分数据
  const [rollbackInfo, setRollbackInfo] = useState<
    | { state: "running" | "done" | "failed"; removed?: Record<string, number>; error?: string }
    | null
  >(null);

  // 本地 endpoint：当前页面就是本地后端代理对象，token 是 localStorage 里的本地 token。
  const localBaseUrl = getLocalServerUrl() || ""; // 桌面零登录态下为空，等同于"同源"
  const localToken = localStorage.getItem("nowen-token") || "";

  function normalizeCloudUrl(raw: string): string {
    const t = raw.trim().replace(/\/+$/, "");
    if (!t) return "";
    return /^https?:\/\//i.test(t) ? t : `http://${t}`;
  }

  function rememberCloudLogin(args: { url: string; token: string; username: string; displayName?: string }) {
    setLoginRecords(upsertCloudLoginRecord({
      cloudUrl: normalizeCloudUrl(args.url),
      username: args.username,
      displayName: args.displayName || args.username,
      token: args.token,
    }));
  }

  async function verifyCloudToken(url: string, token: string): Promise<{ ok: boolean; user?: any; error?: string; code?: string }> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`${url}/api/me`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.id) {
        return {
          ok: false,
          error: data?.error || `登录态验证失败 (${res.status})`,
          code: data?.code,
        };
      }
      return { ok: true, user: data };
    } catch (e: any) {
      return {
        ok: false,
        error: e?.name === "AbortError" ? "服务器无响应" : (e?.message || "网络错误"),
      };
    }
  }

  async function handleQuickLogin(record: CloudLoginRecord) {
    setError("");
    setBusy(true);
    setQuickLoginId(record.id);
    try {
      const verified = await verifyCloudToken(record.cloudUrl, record.token);
      if (!verified.ok || !verified.user) {
        setLoginRecords(removeCloudLoginRecord(record.id));
        setCloudUrl(record.cloudUrl);
        setUsername(record.username);
        setPassword("");
        setError(`该登录记录已失效，请重新输入密码登录。${verified.error ? `（${verified.error}）` : ""}`);
        return;
      }
      const verifiedUsername = verified.user?.username || record.username;
      setCloudUrl(record.cloudUrl);
      setUsername(verifiedUsername);
      setCloudToken(record.token);
      setCloudUserDisplay(verified.user?.displayName || verifiedUsername);
      rememberCloudLogin({
        url: record.cloudUrl,
        token: record.token,
        username: verifiedUsername,
        displayName: verified.user?.displayName || verifiedUsername,
      });
      setStep("choice");
    } finally {
      setBusy(false);
      setQuickLoginId(null);
    }
  }

  function handleRemoveRecord(record: CloudLoginRecord) {
    setLoginRecords(removeCloudLoginRecord(record.id));
    if (cloudUrl === record.cloudUrl && username === record.username && !password) {
      setCloudUrl("");
      setUsername("");
    }
  }

  async function handleLogin() {
    setError("");
    const url = normalizeCloudUrl(cloudUrl);
    if (!url) {
      setError("请填写云端服务器地址");
      return;
    }
    if (!username || !password) {
      setError("请填写账号和密码");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${url}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || `登录失败 (${res.status})`);
        return;
      }
      if (data.requires2FA) {
        // 暂不支持 2FA；引导用户使用常规登录页，或关闭后再迁移
        setError("当前云端账号启用了二步验证，当前弹窗暂不支持。请使用常规登录页登录，或先在 Web 端关闭二步验证后再迁移。");
        return;
      }
      if (!data.token) {
        setError("登录响应缺少 token");
        return;
      }

      const displayName = data.user?.displayName || data.user?.username || username;
      const verifiedUsername = data.user?.username || username;
      setCloudToken(data.token);
      setCloudUrl(url);
      setUsername(verifiedUsername);
      setCloudUserDisplay(displayName);
      rememberCloudLogin({ url, token: data.token, username: verifiedUsername, displayName });
      setStep("choice");
    } catch (e: any) {
      setError(e?.message || "网络错误，请检查云端地址");
    } finally {
      setBusy(false);
    }
  }

  function enterCloudDirectly() {
    rememberCloudLogin({ url: cloudUrl, token: cloudToken, username, displayName: cloudUserDisplay });
    try {
      localStorage.setItem("nowen-server-url", cloudUrl);
      localStorage.setItem("nowen-token", cloudToken);
      localStorage.removeItem("nowen-prefer-cloud");
    } catch { /* ignore */ }
    setSuccessKind("direct");
    setStep("success");
    setTimeout(() => onClose(), 800);
  }

  async function ensureCloudSessionValid(): Promise<boolean> {
    const verified = await verifyCloudToken(cloudUrl, cloudToken);
    if (verified.ok && verified.user) {
      const verifiedUsername = verified.user?.username || username;
      setUsername(verifiedUsername);
      setCloudUserDisplay(verified.user?.displayName || verifiedUsername);
      rememberCloudLogin({
        url: cloudUrl,
        token: cloudToken,
        username: verifiedUsername,
        displayName: verified.user?.displayName || verifiedUsername,
      });
      return true;
    }

    const authInvalidCodes = new Set([
      "SESSION_REVOKED",
      "TOKEN_REVOKED",
      "TOKEN_INVALID",
      "USER_NOT_FOUND",
      "ACCOUNT_DISABLED",
      "UNAUTHENTICATED",
    ]);
    const authInvalid = authInvalidCodes.has(verified.code || "");
    if (authInvalid) {
      setLoginRecords(removeCloudLoginRecord(makeRecordId(cloudUrl, username)));
      setPassword("");
      setError(`云端登录态已失效，请重新输入密码登录。${verified.error ? `（${verified.error}）` : ""}`);
      setStep("login");
      return false;
    }

    setError(`云端登录态验证失败：${verified.error || "未知错误"}`);
    setStep("choice");
    return false;
  }

  async function precheckMigrationTarget(): Promise<boolean> {
    // ===== 1.1.7 防呆：拦截"迁移到同一台后端" =====
    // 只在用户明确选择"迁移本地数据"时执行；直接登录云端不应被迁移防呆阻塞。
    try {
      const [localVerRes, cloudVerRes] = await Promise.all([
        fetch(`${localBaseUrl}/api/version`).catch(() => null),
        fetch(`${cloudUrl}/api/version`).catch(() => null),
      ]);
      const localVer = localVerRes && localVerRes.ok ? await localVerRes.json().catch(() => null) : null;
      const cloudVer = cloudVerRes && cloudVerRes.ok ? await cloudVerRes.json().catch(() => null) : null;

      // 同实例硬阻断：两端 serverInstanceId 都拿到且相等 → 必然是同一台后端
      if (
        localVer?.serverInstanceId &&
        cloudVer?.serverInstanceId &&
        localVer.serverInstanceId === cloudVer.serverInstanceId
      ) {
        setError(
          "本地服务器和云端服务器是同一台机器，无需迁移。\n" +
          "如果你只是想进入这个账号，请选择‘直接进入云端’。",
        );
        setStep("choice");
        return false;
      }

      // 同账号软提示：即使是不同实例，把数据迁到同名账号通常也是误操作。
      let localUsername: string | null = null;
      if (localToken) {
        try {
          const parts = localToken.split(".");
          if (parts.length >= 2) {
            const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
            const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
            const payload = JSON.parse(atob(padded)) as { username?: string };
            localUsername = payload?.username || null;
          }
        } catch {
          /* ignore，无法解析时跳过同账号校验 */
        }
      }
      const cloudUsername: string | null = cloudUserDisplay || username || null;
      if (localUsername && cloudUsername && localUsername === cloudUsername) {
        const ok = window.confirm(
          `检测到本地和云端使用的是同一个账号 "${localUsername}"。\n\n` +
          `继续迁移会在云端再创建一份完全相同的笔记副本，通常不是你想要的。\n` +
          `如果你只是想登录到云端账号，请选择“直接进入云端”。\n\n` +
          `确定仍要继续迁移吗？`,
        );
        if (!ok) return false;
      }
      return true;
    } catch {
      // 防呆校验本身失败不应阻塞正常迁移流程；记录到 console 但继续走原逻辑
      console.warn("[migration] same-instance/same-account precheck skipped");
      return true;
    }
  }

  async function handleStart() {
    setError("");
    const sessionOk = await ensureCloudSessionValid();
    if (!sessionOk) return;
    const ok = await precheckMigrationTarget();
    if (!ok) return;
    setSuccessKind("migration");
    setStep("running");
    setError("");
    setAttSummary(null);
    setRollbackInfo(null);

    // 云端 endpoint 提取，后面 catch 里会复用
    const cloud = { baseUrl: cloudUrl, token: cloudToken };
    // 收集"已写入云端的资源 ID"——任何阶段抛错都能拿它们去调 /rollback
    let lightIdMap: { notebooks: Record<string, string>; notes: Record<string, string>; tags: Record<string, string> } | null = null;
    let attIdMap: Record<string, string> = {};

    try {
      // ===== D-2：轻量数据迁移 =====
      // 改进进度显示：D-2 占总进度 0~30%（它二样快），D-3 占 30~100%（附件上传耗时）
      const lightResult = await runLightMigration({
        local: { baseUrl: localBaseUrl, token: localToken },
        cloud,
        onProgress: (p) =>
          setProgress({
            ...p,
            ratio: p.ratio * 0.3,
            message: `[数据] ${p.message}`,
          }),
      });
      lightIdMap = lightResult.idMap;

      // ===== D-3：附件 + content 重写 =====
      // noteIdMap 是"本地旧→云端新"，D-3 附件阶段需要用它判断附件位置。
      const attResult = await runAttachmentMigration({
        local: { baseUrl: localBaseUrl, token: localToken },
        cloud,
        noteIdMap: lightResult.idMap.notes,
        onProgress: (p) =>
          setProgress({
            ...p,
            ratio: 0.3 + p.ratio * 0.7,
            message:
              p.phase === "rewrite"
                ? `[重写] ${p.message}`
                : p.phase === "done"
                ? p.message
                : `[附件] ${p.message}`,
          }),
      });
      attIdMap = attResult.idMap;

      setAttSummary({
        total: attResult.total,
        succeeded: attResult.succeeded,
        failed: attResult.failed,
      });

      // 写入云端凭证：让下次启动直接进入云端模式
      rememberCloudLogin({ url: cloudUrl, token: cloudToken, username, displayName: cloudUserDisplay });
      try {
        localStorage.setItem("nowen-server-url", cloudUrl);
        localStorage.setItem("nowen-token", cloudToken);
        localStorage.removeItem("nowen-prefer-cloud");
      } catch { /* ignore */ }
      setSuccessKind("migration");
      setStep("success");
      // 有失败附件时，延长到6s，让用户看清楚；全部成功则2s
      const wait = attResult.failed.length > 0 ? 6000 : 2000;
      setTimeout(() => onClose(), wait);
    } catch (e) {
      const stageMap: Record<string, string> = {
        preflight: "迁移预检查",
        export: "本地导出",
        import: "云端导入",
        attachments: "附件迁移",
        rewrite: "内容重写",
      };
      const msg = e instanceof MigrationError
        ? `${stageMap[e.stage] || e.stage}失败：${e.message}`
        : (e instanceof Error ? e.message : String(e));
      setError(msg);
      setStep("error");

      // 失败回滚：只要 import-light 走到了那一步（lightIdMap 不为 null）就需要清理云端。
      // export 失败走不到这里。rollback 本身失败不决定 UI——仅 console + 提示。
      if (lightIdMap) {
        setRollbackInfo({ state: "running" });
        const r = await rollbackMigration({
          cloud,
          notebookIds: Object.values(lightIdMap.notebooks),
          noteIds: Object.values(lightIdMap.notes),
          tagIds: Object.values(lightIdMap.tags),
          attachmentIds: Object.values(attIdMap),
        });
        setRollbackInfo(
          r.ok
            ? { state: "done", removed: r.removed }
            : { state: "failed", error: r.error },
        );
      }
    }
  }
  // 遮罩定位：必须 createPortal 到 document.body。
  //   原因：MigrationModal 是从 NavRail 里调用的，NavRail 祖先链上有 framer-motion 的
  //   transform/will-change 属性。按 CSS 规范，祖先元素有 transform 时会创建新的 containing
  //   block，导致后代 `position: fixed` 不再相对于 viewport 定位，而是被限在祖先容器内
  //   ——表现为遮罩只能覆盖左侧侧边栏区域，右侧大片区域透明。
  //   SettingsModal 里的 ImageLightbox 是同样场景、同样解法。
  // 候选1+6：卡片改为不透明纯色背景，避免透出底层模糊内容；同时把宽度从 max-w-md→max-w-lg、内边距 p-6→p-7，缓解内容拥挤
  const overlay = "fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-md";
  const card = "w-full max-w-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-2xl p-7";

  return createPortal(
    <motion.div
      className={overlay}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={(e) => e.target === e.currentTarget && step !== "running" && onCancel()}
    >
      <motion.div
        className={card}
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
      >
        {step === "login" && (
          <>
            {/* 候选7：图标加大到 22 + 标题加粗到 font-bold，提升标题视觉权重 */}
            <div className="flex items-center gap-2.5 mb-4">
              <Cloud className="text-indigo-500" size={22} />
              <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">登录云端账号</h2>
            </div>
            {/* 候选2：说明文字提高对比度（zinc-600/zinc-400 比 tx-secondary 更清晰），并加大下边距 */}
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-5 leading-relaxed">
              登录后，可直接进入云端，也可选择将本地数据迁移到云端账号下。
            </p>

            {loginRecords.length > 0 && (
              <div className="mb-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">最近登录</span>
                  <span className="text-[11px] text-zinc-400 dark:text-zinc-500">点击账号可快速登录</span>
                </div>
                <div className="max-h-32 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-200 dark:divide-zinc-800">
                  {loginRecords.map((record) => (
                    <div key={record.id} className="flex items-center gap-2 px-3 py-2 bg-zinc-50/60 dark:bg-zinc-800/30">
                      <button
                        type="button"
                        onClick={() => handleQuickLogin(record)}
                        disabled={busy}
                        className="flex-1 min-w-0 text-left disabled:opacity-50"
                        title={`${record.displayName || record.username} · ${record.cloudUrl}`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-200">
                            {record.displayName || record.username}
                          </span>
                          {quickLoginId === record.id && <Loader2 size={12} className="animate-spin text-indigo-500" />}
                        </div>
                        <div className="truncate text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                          {record.username} · {record.cloudUrl}
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveRecord(record)}
                        disabled={busy}
                        className="px-2 py-1 text-[11px] text-zinc-400 hover:text-red-500 disabled:opacity-50"
                        title="删除此记录"
                      >
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/*
              autoComplete + name 双管齐下，关闭 Edge/Chrome 内嵌密码管理器气泡。
              为什么这里要关：迁移弹窗是"一次性"账号录入，不需要被记住；而气泡 z-index
              高于 webview 内容，会覆盖在 modal 卡片上，造成视觉错位（截图里那块蓝色矩形）。
              密码框使用 "new-password"——比 "off" 在 Chromium 上更可靠地阻止建议条。
            */}
            {/* 候选3+4：输入框改为白底/zinc-300 边框，加 focus:ring 高亮反馈；候选6：space-y-3→space-y-3.5 略增间距 */}
            <div className="space-y-3.5">
              <input
                type="text"
                name="nowen-cloud-url"
                autoComplete="off"
                placeholder="服务器地址（如 http://192.168.1.10:3001）"
                value={cloudUrl}
                onChange={(e) => setCloudUrl(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-lg text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 text-sm outline-none transition-all focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 disabled:opacity-50"
                disabled={busy}
              />
              <input
                type="text"
                name="nowen-cloud-username"
                autoComplete="off"
                placeholder="用户名"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-lg text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 text-sm outline-none transition-all focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 disabled:opacity-50"
                disabled={busy}
              />
              <input
                type="password"
                name="nowen-cloud-password"
                autoComplete="new-password"
                placeholder="密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                className="w-full px-3.5 py-2.5 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-lg text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 text-sm outline-none transition-all focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 disabled:opacity-50"
                disabled={busy}
              />
            </div>
            {error && (
              <div className="mt-3 flex items-start gap-2 text-sm text-accent-danger bg-accent-danger/10 p-2 rounded-md">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            {/* 候选8：取消按钮去掉 border 改为弱化的文字按钮，让主按钮 "下一步" 视觉权重突出 */}
            {/* 候选5：主按钮加 hover 变深、shadow、过渡；候选6：mt-5→mt-6 */}
            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={onCancel}
                disabled={busy}
                className="px-4 py-2 text-sm text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={handleLogin}
                disabled={busy}
                className="px-5 py-2 text-sm font-medium bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg shadow-md hover:shadow-lg flex items-center gap-1.5 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-indigo-500 disabled:shadow-md"
              >
                {busy && <Loader2 size={14} className="animate-spin" />}
                登录
              </button>
            </div>
          </>
        )}

        {step === "choice" && (
          <>
            <div className="flex items-center gap-2 mb-4">
              <CheckCircle2 className="text-green-500" size={20} />
              <h2 className="text-lg font-semibold text-tx-primary">登录成功</h2>
            </div>
            <div className="space-y-2 text-sm text-tx-secondary mb-4">
              <p>已登录云端账号：<span className="text-tx-primary font-medium">{cloudUserDisplay}</span></p>
              <p>请选择接下来要做什么：</p>
            </div>

            {error && (
              <div className="mb-3 flex items-start gap-2 text-sm text-accent-danger bg-accent-danger/10 p-2 rounded-md whitespace-pre-line">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="grid gap-3">
              <button
                onClick={enterCloudDirectly}
                className="w-full text-left p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-indigo-400 hover:bg-indigo-50/50 dark:hover:bg-indigo-500/10 transition-colors group"
              >
                <div className="flex items-start gap-3">
                  <LogIn size={18} className="mt-0.5 text-indigo-500" />
                  <div>
                    <div className="text-sm font-medium text-tx-primary">直接进入云端</div>
                    <p className="text-xs text-tx-tertiary mt-1 leading-relaxed">
                      不复制本地数据，只切换到该云端账号。适合只是想查看云端内容或临时切换账号。
                    </p>
                  </div>
                </div>
              </button>

              <button
                onClick={() => { setError(""); setStep("confirm"); }}
                className="w-full text-left p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-indigo-400 hover:bg-indigo-50/50 dark:hover:bg-indigo-500/10 transition-colors group"
              >
                <div className="flex items-start gap-3">
                  <UploadCloud size={18} className="mt-0.5 text-indigo-500" />
                  <div>
                    <div className="text-sm font-medium text-tx-primary">迁移本地数据到云端</div>
                    <p className="text-xs text-tx-tertiary mt-1 leading-relaxed">
                      将本地笔记本、笔记、标签、附件和历史版本复制到云端账号；本地数据会保留作为备份。
                    </p>
                  </div>
                </div>
              </button>
            </div>

            <div className="flex justify-between gap-2 mt-5">
              <button
                onClick={() => { setError(""); setStep("login"); }}
                className="px-4 py-2 text-sm text-tx-secondary hover:bg-app-hover rounded-md"
              >
                上一步
              </button>
              <button
                onClick={onCancel}
                className="px-4 py-2 text-sm text-tx-secondary hover:bg-app-hover rounded-md"
              >
                稍后再说
              </button>
            </div>
          </>
        )}

        {step === "confirm" && (
          <>
            <div className="flex items-center gap-2 mb-4">
              <ArrowRight className="text-accent-primary" size={20} />
              <h2 className="text-lg font-semibold text-tx-primary">确认迁移</h2>
            </div>
            <div className="space-y-2 text-sm text-tx-secondary mb-4">
              <p>登录成功，账号：<span className="text-tx-primary font-medium">{cloudUserDisplay}</span></p>
              <p>即将把本地全部笔记本、笔记、标签复制到该账号下。</p>
              <p className="text-xs text-tx-tertiary">如果你只是想进入云端账号查看内容，请返回上一步选择「直接进入云端」。</p>
              <ul className="list-disc list-inside text-xs text-tx-tertiary mt-2 space-y-1">
                <li>本地数据保留，作为备份</li>
                <li>笔记里的图片 / 附件也会一起上传到云端</li>
                <li>包含笔记的历史版本记录</li>
                <li>如果中途失败，已写入云端的部分会自动撤销</li>
              </ul>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => setStep("choice")}
                className="px-4 py-2 text-sm text-tx-secondary hover:bg-app-hover rounded-md"
              >
                上一步
              </button>
              <button
                onClick={handleStart}
                className="px-4 py-2 text-sm bg-accent-primary text-white rounded-md"
              >
                开始迁移
              </button>
            </div>
          </>
        )}

        {step === "running" && (
          <>
            <div className="flex items-center gap-2 mb-4">
              <Loader2 className="text-accent-primary animate-spin" size={20} />
              <h2 className="text-lg font-semibold text-tx-primary">正在迁移…</h2>
            </div>
            <div className="space-y-3">
              <div className="h-2 bg-app-input rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent-primary transition-all duration-300"
                  style={{ width: `${Math.round(progress.ratio * 100)}%` }}
                />
              </div>
              <p className="text-sm text-tx-secondary">{progress.message}</p>
              <p className="text-xs text-tx-tertiary">请勿关闭窗口，迁移期间需要保持网络连接。</p>
            </div>
          </>
        )}

        {step === "success" && (
          <>
            <div className="flex items-center gap-2 mb-4">
              <CheckCircle2 className="text-green-500" size={20} />
              <h2 className="text-lg font-semibold text-tx-primary">{successKind === "migration" ? "迁移完成" : "切换完成"}</h2>
            </div>
            <p className="text-sm text-tx-secondary">
              {successKind === "migration"
                ? "数据已写入云端账号。即将刷新进入云端工作台…"
                : "已切换到云端账号。即将刷新进入云端工作台…"}
            </p>
            {successKind === "migration" && attSummary && attSummary.total > 0 && (
              <div className="mt-3 text-xs text-tx-tertiary">
                附件：{attSummary.succeeded} / {attSummary.total} 成功
                {attSummary.failed.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-accent-danger">
                      {attSummary.failed.length} 个附件迁移失败（点击展开）
                    </summary>
                    <ul className="mt-1 max-h-32 overflow-auto pl-4 list-disc text-tx-secondary">
                      {attSummary.failed.slice(0, 20).map((f) => (
                        <li key={f.id} className="break-words">
                          {f.filename}：{f.reason}
                        </li>
                      ))}
                      {attSummary.failed.length > 20 && (
                        <li>… 其余 {attSummary.failed.length - 20} 个未列出</li>
                      )}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </>
        )}

        {step === "error" && (
          <>
            <div className="flex items-center gap-2 mb-4">
              <AlertCircle className="text-accent-danger" size={20} />
              <h2 className="text-lg font-semibold text-tx-primary">迁移失败</h2>
            </div>
            <div className="bg-accent-danger/10 text-accent-danger p-3 rounded-md text-sm break-words">
              {error}
            </div>
            {rollbackInfo && (
              <div className="mt-2 text-xs">
                {rollbackInfo.state === "running" && (
                  <span className="text-tx-tertiary">
                    <Loader2 size={12} className="inline animate-spin mr-1" />
                    正在撤销云端已写入的部分…
                  </span>
                )}
                {rollbackInfo.state === "done" && rollbackInfo.removed && (
                  <span className="text-green-500">
                    已撤销云端已写入的数据（
                    {rollbackInfo.removed.notebooks ?? 0} 个笔记本 / {rollbackInfo.removed.notes ?? 0} 篇笔记 / {rollbackInfo.removed.attachments ?? 0} 个附件
                    ）。
                  </span>
                )}
                {rollbackInfo.state === "failed" && (
                  <span className="text-accent-danger">
                    自动撤销未完成：{rollbackInfo.error || "未知错误"}。请手动检查云端账号是否有本次迁移残留的重复数据。
                  </span>
                )}
              </div>
            )}
            <p className="text-xs text-tx-tertiary mt-2">
              本地数据完整保留，可重新尝试。如果反复失败，请先用"导出 zip"功能手动备份。
            </p>
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={onCancel}
                className="px-4 py-2 text-sm text-tx-primary border border-app-border hover:bg-app-hover rounded-md"
              >
                关闭
              </button>
              <button
                onClick={() => { setError(""); setStep("confirm"); }}
                className="px-4 py-2 text-sm bg-accent-primary text-white rounded-md"
              >
                重试
              </button>
            </div>
          </>
        )}
      </motion.div>
    </motion.div>,
    document.body
  );
}
