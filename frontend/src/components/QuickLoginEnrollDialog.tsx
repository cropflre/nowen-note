/**
 * 登录后引导对话框：询问用户是否启用快速登录（生物识别 / 锁屏密码）
 *
 * 触发时机
 * ----------------------------------------------------------------------------
 * - 用户在客户端模式（Capacitor 原生）密码登录成功且未曾问过；
 * - 设备具备生物识别或锁屏密码；
 * - 当前账号尚未启用快速登录。
 *
 * 行为
 * ----------------------------------------------------------------------------
 * - "启用"：发起一次生物识别认证，把当前 token 镜像到 Keystore；
 * - "暂不启用"：标记为"已问过"，下次登录不再打扰；
 * - 关闭按钮：等同于"暂不启用"。
 *
 * 设计取舍
 * ----------------------------------------------------------------------------
 * - 不做"以后再说" 的稍后再问选项——否则状态太多。"已问过"统一意味着不再
 *   主动弹；用户随时可以从"设置"里手动开启（后续 PR 加 Settings 入口）。
 */

import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Fingerprint, ShieldCheck, X } from "lucide-react";
import {
  enableQuickLogin,
  checkBiometry,
  isQuickLoginPlatformSupported,
  isQuickLoginEnabled,
  hasAskedEnroll,
  markEnrollAsked,
  type BiometryStatus,
} from "@/lib/quickLogin";
import { getServerUrl } from "@/lib/api";
import { getRefreshToken } from "@/lib/authSession";

interface Props {
  /** 当前已登录用户名，仅用于文案 */
  username: string;
  /** 当前生效的 token（必须传，否则启用按钮失效） */
  token: string;
  /** 用户做出选择后回调（启用 / 跳过都会触发） */
  onClose: () => void;
}

export default function QuickLoginEnrollDialog({
  username,
  token,
  onClose,
}: Props) {
  const [shouldShow, setShouldShow] = useState(false);
  const [status, setStatus] = useState<BiometryStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // 首次挂载：判断是否需要展示。所有判断都异步，避免在 SSR / 不支持环境下
  // 误闪。在不需要展示时直接调用 onClose 关闭挂载点。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isQuickLoginPlatformSupported()) {
        if (!cancelled) onClose();
        return;
      }
      if (hasAskedEnroll()) {
        if (!cancelled) onClose();
        return;
      }
      if (await isQuickLoginEnabled()) {
        // 已启用过（理论上不会到这里：启用后我们也会 markEnrollAsked，但保险）
        if (!cancelled) onClose();
        return;
      }
      const s = await checkBiometry();
      if (cancelled) return;
      // 设备完全没有锁屏 + 没有生物识别 → 没法做快速登录，跳过
      if (!s.available && !s.deviceSecure) {
        markEnrollAsked();
        onClose();
        return;
      }
      setStatus(s);
      setShouldShow(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [onClose]);

  const handleEnable = async () => {
    setError("");
    setSubmitting(true);
    try {
      const result = await enableQuickLogin({
        token,
        refreshToken: getRefreshToken() || undefined,
        serverUrl: getServerUrl() || "",
        username,
      });
      if (!result.ok) {
        setError(result.error || "启用失败");
        return;
      }
      markEnrollAsked();
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const handleSkip = () => {
    markEnrollAsked();
    onClose();
  };

  // 文案：根据可用类型给出更精准的描述
  const featureLabel = (() => {
    if (!status) return "生物识别";
    if (status.available) {
      // BiometryType 在不同平台数值不同，统一描述为"指纹 / 人脸"
      return "指纹 / 人脸";
    }
    if (status.deviceSecure) return "锁屏密码";
    return "快速登录";
  })();

  return (
    <AnimatePresence>
      {shouldShow && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center px-5"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {/* 背景遮罩 */}
          <div
            className="absolute inset-0 bg-zinc-900/60 backdrop-blur-sm"
            onClick={submitting ? undefined : handleSkip}
          />

          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="relative w-full max-w-[380px] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xl p-6"
          >
            {/* 关闭 */}
            <button
              type="button"
              onClick={handleSkip}
              disabled={submitting}
              aria-label="跳过"
              className="absolute top-3 right-3 p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:text-zinc-200 dark:hover:bg-zinc-800 transition-colors disabled:opacity-40"
            >
              <X size={16} />
            </button>

            <div className="flex items-center justify-center w-12 h-12 mx-auto rounded-xl bg-indigo-500/10 dark:bg-indigo-500/15 mb-3">
              <Fingerprint
                size={26}
                className="text-indigo-600 dark:text-indigo-400"
              />
            </div>

            <h2 className="text-base font-semibold text-center text-zinc-900 dark:text-zinc-100">
              开启快速登录？
            </h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center mt-1.5">
              下次打开 Nowen Note 时使用 <strong className="font-medium text-zinc-700 dark:text-zinc-200">{featureLabel}</strong> 即可登录 <strong className="font-medium text-zinc-700 dark:text-zinc-200">{username || "当前账号"}</strong>，无需再输入密码。
            </p>

            <div className="mt-4 px-3 py-2.5 rounded-lg bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200/60 dark:border-zinc-700/60 flex items-start gap-2">
              <ShieldCheck className="w-4 h-4 mt-0.5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
              <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
                登录凭证使用 Android Keystore 加密保存在本机，不会上传到服务器。卸载或清除应用数据后会自动失效。
              </p>
            </div>

            <AnimatePresence>
              {error && (
                <motion.p
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  className="mt-3 text-xs text-red-600 dark:text-red-400 text-center"
                >
                  {error}
                </motion.p>
              )}
            </AnimatePresence>

            <div className="mt-5 flex flex-col gap-2">
              <button
                type="button"
                onClick={handleEnable}
                disabled={submitting}
                className="w-full py-2.5 rounded-xl text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 transition-colors shadow-sm"
              >
                {submitting ? "正在启用…" : `启用${featureLabel}`}
              </button>
              <button
                type="button"
                onClick={handleSkip}
                disabled={submitting}
                className="w-full py-2 rounded-xl text-sm font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
              >
                暂不启用
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
