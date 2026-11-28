/**
 * 启动时自动尝试快速登录
 * ============================================================================
 *
 * 渲染策略
 * ----------------------------------------------------------------------------
 * - 平台不支持（Web / Electron）→ 立即调 onSettled(false)，UI 走原密码登录路径。
 * - 未启用快速登录 → 同上。
 * - 已启用 → 渲染一个全屏占位 + 唤起生物识别。
 *   - 认证成功：把 token 写回 localStorage，调 /me 拉用户信息并校验会话后
 *     onSettled(true) + 调 onLogin 让 AuthGate 直接进主界面。
 *   - 认证失败 / token 已被吊销：清掉 secure storage 中的镜像，onSettled(false)
 *     回到密码登录页。
 *
 * 为什么不直接放在 AuthGate 内？
 * ----------------------------------------------------------------------------
 * AuthGate 已经有 verify token / storage 监听 / clientMode 判定 等大量逻辑。
 * 把"启动时唤起生物识别"独立成一个小组件，方便单独维护，也避免每次 storage
 * 事件都触发认证。本组件只在 AuthGate 第一次确认 isAuthenticated=false 时
 * 挂载一次，处理完后再 unmount。
 */

import React, { useEffect, useState } from "react";
import { Loader2, Fingerprint } from "lucide-react";
import {
  isQuickLoginPlatformSupported,
  isQuickLoginEnabled,
  attemptQuickLogin,
  disableQuickLogin,
  getQuickLoginUsername,
} from "@/lib/quickLogin";
import { setServerUrl, getServerUrl } from "@/lib/api";
import { hasActiveTwoFactorLoginChallenge } from "@/lib/twoFactorLoginChallenge";
import { isMobileAccountLoginRequested } from "@/lib/mobileLocalMode";
import type { User } from "@/types";
import { fetchWithAuthRefresh, getAccessToken, storeAuthTokens } from "@/lib/authSession";
import { getResolvedApiBaseUrl } from "@/lib/serverUrl";

interface Props {
  /** 是否处于客户端模式（Electron / Capacitor） */
  isClientMode: boolean;
  /**
   * 询问 / 处理完毕时回调：
   *   - usedQuickLogin=true 且带 user：表示已通过快速登录，AuthGate 直接进主界面
   *   - usedQuickLogin=false：未启用 / 用户取消 / 失败，AuthGate 走常规密码流程
   */
  onSettled: (
    usedQuickLogin: boolean,
    payload?: { token: string; user: User },
  ) => void;
}

type Phase = "probing" | "authenticating" | "verifying" | "fallback";

export default function QuickLoginGate({ isClientMode, onSettled }: Props) {
  const [phase, setPhase] = useState<Phase>("probing");
  const [username, setUsername] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string>("");

  // probe 阶段：判断是否需要展示 UI 并发起认证。
  // 整个流程仅在挂载时跑一次；如果用户取消后回到密码页，组件会被 unmount，
  // 不会反复弹出。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 密码第一步已经签发 2FA ticket 时，必须优先完成该挑战。否则 Android
      // 生物识别弹窗会覆盖验证码层，用户会误以为又被退回普通登录。
      // 主动添加账号或历史账号重登时，也不能用旧账号的生物识别覆盖目标。
      if (hasActiveTwoFactorLoginChallenge() || isMobileAccountLoginRequested()) {
        if (!cancelled) onSettled(false);
        return;
      }

      if (!isQuickLoginPlatformSupported()) {
        if (!cancelled) onSettled(false);
        return;
      }
      if (!isClientMode) {
        if (!cancelled) onSettled(false);
        return;
      }
      const enabled = await isQuickLoginEnabled();
      if (cancelled) return;
      if (!enabled) {
        onSettled(false);
        return;
      }

      // 取一下用户名，UI 上能展示"以 xxx 身份解锁"
      try {
        const u = await getQuickLoginUsername();
        if (!cancelled && u) setUsername(u);
      } catch {
        /* ignore */
      }

      if (cancelled) return;
      setPhase("authenticating");

      const result = await attemptQuickLogin();
      if (cancelled) return;

      if (!result.ok) {
        // 用户取消、生物识别不可用 → 静默回退到密码登录
        if (
          result.reason === "user_cancel" ||
          result.reason === "biometry_unavailable" ||
          result.reason === "not_enabled"
        ) {
          // biometry_unavailable 通常是用户清掉了所有指纹 / 关掉锁屏 ——
          // 这种状态下"快速登录"已不再可用，主动 disable 释放凭据，避免下次
          // 启动还卡在这里。
          if (result.reason === "biometry_unavailable") {
            await disableQuickLogin();
          }
          onSettled(false);
          return;
        }
        setErrorMsg(result.message || "解锁失败，请使用密码登录");
        setPhase("fallback");
        return;
      }

      // 取到 token → verify 一次
      setPhase("verifying");

      // 同步服务器 URL：如果 secure storage 里存的服务器地址与当前
      // localStorage 不一致，以 secure storage 为准（更可信，因为它是和
      // 当时登录成功的 token 一一对应的）。
      const ssServer = result.serverUrl || "";
      const lsServer = getServerUrl();
      if (ssServer && ssServer !== lsServer) {
        setServerUrl(ssServer);
      }

      const baseUrl = ssServer || lsServer || "";
      const apiBaseUrl = getResolvedApiBaseUrl(baseUrl);
      const verifyUrl = `${apiBaseUrl}/me`;

      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        storeAuthTokens({ token: result.token, refreshToken: result.refreshToken ?? null });
        const res = await fetchWithAuthRefresh(verifyUrl, {
          headers: { Authorization: `Bearer ${result.token}` },
          signal: ctrl.signal,
        }, apiBaseUrl);
        clearTimeout(timer);
        if (!res.ok) {
          // 401 / 403：token 已被吊销 / 改密。secure storage 凭据失效 → 清空
          if (res.status === 401 || res.status === 403) {
            await disableQuickLogin();
          }
          if (cancelled) return;
          setErrorMsg("登录态已失效，请重新输入密码");
          setPhase("fallback");
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        onSettled(true, { token: getAccessToken() || result.token, user: data });
      } catch (e: any) {
        if (cancelled) return;
        setErrorMsg(
          e?.name === "AbortError"
            ? "服务器无响应，请检查网络"
            : "网络异常，请使用密码登录",
        );
        setPhase("fallback");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isClientMode, onSettled]);

  if (phase === "probing") {
    // 还在探测，避免视觉闪烁，渲染一个最小 loading
    return (
      <div className="relative min-h-screen flex items-center justify-center overflow-hidden bg-slate-50 dark:bg-[#090d16]">
        <div className="pointer-events-none fixed inset-0">
          <div className="absolute -top-32 -left-24 h-80 w-80 rounded-full bg-indigo-500/12 blur-3xl dark:bg-indigo-500/20" />
          <div className="absolute -bottom-32 -right-24 h-80 w-80 rounded-full bg-sky-400/12 blur-3xl dark:bg-cyan-500/16" />
        </div>
        <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl border border-white/70 bg-white/80 shadow-lg backdrop-blur-xl dark:border-white/10 dark:bg-zinc-900/75">
          <div className="h-6 w-6 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
        </div>
      </div>
    );
  }

  // authenticating / verifying / fallback 都是"已经决定要展示快速登录 UI"，
  // 渲染一个统一的占位卡片。fallback 时给用户一个手动按钮可以直接关闭并回密码页。
  return (
    <div
      className="relative min-h-screen flex items-center justify-center overflow-hidden bg-gradient-to-br from-slate-50 via-indigo-50/40 to-sky-50/50 dark:from-[#070a12] dark:via-[#0b1020] dark:to-[#0a121f] px-5"
      style={{
        paddingTop: "var(--safe-area-top)",
        paddingBottom: "var(--safe-area-bottom)",
      }}
    >
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-36 -left-24 h-96 w-96 rounded-full bg-indigo-400/16 blur-3xl dark:bg-indigo-500/22" />
        <div className="absolute -bottom-36 -right-24 h-96 w-96 rounded-full bg-sky-400/16 blur-3xl dark:bg-cyan-500/18" />
      </div>

      <div className="relative w-full max-w-[368px] overflow-hidden rounded-[28px] border border-white/75 bg-white/82 p-7 text-center shadow-[0_24px_64px_-20px_rgba(15,23,42,0.18)] backdrop-blur-2xl dark:border-white/[0.09] dark:bg-zinc-900/76 dark:shadow-[0_28px_72px_-16px_rgba(0,0,0,0.65)]">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-indigo-500/60 to-transparent" />

        <div className="relative mx-auto mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/18 via-sky-500/14 to-violet-500/18 text-indigo-600 ring-1 ring-indigo-500/25 shadow-[inset_0_1px_0_rgba(255,255,255,0.65),0_4px_0_rgba(15,23,42,0.08),0_10px_20px_-8px_rgba(99,102,241,0.35)] dark:text-indigo-300 dark:ring-indigo-400/30">
          {phase === "authenticating" && (
            <span className="pointer-events-none absolute inset-0 rounded-2xl ring-2 ring-indigo-400/35 animate-ping" />
          )}
          <Fingerprint size={28} />
        </div>

        {phase === "authenticating" && (
          <>
            <h2 className="text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              正在解锁
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
              请验证你的指纹 / 人脸 / 锁屏密码
              {username ? `，登录账号 ${username}` : ""}
            </p>
          </>
        )}

        {phase === "verifying" && (
          <div className="mt-1 inline-flex items-center justify-center gap-2 rounded-full border border-indigo-500/20 bg-indigo-500/8 px-3.5 py-1.5 text-sm font-medium text-indigo-700 dark:text-indigo-300">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在登录…
          </div>
        )}

        {phase === "fallback" && (
          <>
            <h2 className="text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              快速登录失败
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
              {errorMsg || "请使用密码登录"}
            </p>
            <button
              type="button"
              onClick={() => onSettled(false)}
              className="mt-5 w-full rounded-xl bg-gradient-to-r from-indigo-600 via-indigo-500 to-violet-600 py-2.5 text-sm font-medium text-white shadow-md shadow-indigo-500/25 transition-all hover:-translate-y-[1px] hover:from-indigo-500 hover:to-violet-500 hover:shadow-lg hover:shadow-indigo-500/30 active:translate-y-[0.5px] active:scale-[0.98]"
            >
              使用密码登录
            </button>
          </>
        )}
      </div>
    </div>
  );
}
