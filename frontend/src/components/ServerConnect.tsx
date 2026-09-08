import React, { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Loader2, Server, Wifi, CheckCircle2, AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { setServerUrl, testServerConnection } from "@/lib/api";
import { buildServerUrl, parseServerUrl, type ServerAddressParts } from "@/lib/serverUrl";
import ServerAddressInput from "@/components/ServerAddressInput";

interface ServerConnectProps {
  onConnected: () => void;
}

export default function ServerConnect({ onConnected }: ServerConnectProps) {
  // 协议/主机/端口 三段式（默认 http）。
  // 旧版本可能把完整 URL 写进 localStorage，这里 parseServerUrl 会拆回三段回填。
  const [parts, setParts] = useState<ServerAddressParts>({
    protocol: "http",
    host: "",
    port: "",
    path: "",
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [status, setStatus] = useState<"idle" | "ok" | "fail">("idle");
  const { t } = useTranslation();

  // 尝试从 localStorage 恢复上次连接的地址
  useEffect(() => {
    const last = localStorage.getItem("nowen-server-url-last");
    if (last) setParts(parseServerUrl(last));
  }, []);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    const serverUrl = buildServerUrl(parts);
    if (!serverUrl) return;

    setIsLoading(true);
    setError("");
    setNotice("");
    setStatus("idle");

    const result = await testServerConnection(serverUrl);

    if (result.ok) {
      setStatus("ok");
      const notices = [
        t("server.connectionDiagnostics", {
          apiPath: result.apiPath,
          websocketPath: result.websocketPath,
          mode: t(result.proxyCompatibilityMode === "standard" ? "server.standardMode" : "server.proxyMode"),
        }),
        result.proxyCompatibilityMode && result.proxyCompatibilityMode !== "standard"
          ? t("server.proxyCompatibilityEnabled", {
            apiPath: result.proxyRewrittenApiPath || result.apiPath,
            websocketPath: result.proxyRewrittenWebsocketPath || result.websocketPath,
          })
          : "",
        result.websocketOk === false ? t("server.websocketUnavailable") : "",
      ].filter(Boolean);
      setNotice(notices.join(" "));
      setServerUrl(serverUrl);
      localStorage.setItem("nowen-server-url-last", serverUrl);
      onConnected();
    } else {
      setStatus("fail");
      setError(result.error || t("server.connectFailed"));
    }

    setIsLoading(false);
  };

  const statusIcon = () => {
    if (isLoading) return <Loader2 className="w-4 h-4 animate-spin text-amber-500" />;
    if (status === "ok") return <CheckCircle2 className="w-4 h-4 text-emerald-500" />;
    if (status === "fail") return <AlertCircle className="w-4 h-4 text-red-500" />;
    return null;
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950 selection:bg-indigo-500/30 transition-colors"
      style={{
        paddingTop: 'var(--safe-area-top)',
        paddingBottom: 'var(--safe-area-bottom)',
      }}
    >
      {/* 背景装饰 */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-1/2 -left-1/2 w-full h-full bg-gradient-to-br from-indigo-500/5 via-transparent to-transparent rounded-full blur-3xl" />
        <div className="absolute -bottom-1/2 -right-1/2 w-full h-full bg-gradient-to-tl from-emerald-500/5 via-transparent to-transparent rounded-full blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
        className="relative w-full max-w-[460px] mx-4"
      >
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-xl dark:shadow-2xl dark:shadow-black/20 p-8">
          {/* Icon & Title */}
          <div className="text-center mb-8">
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.1, duration: 0.4 }}
              className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-emerald-500/10 dark:bg-emerald-500/15 mb-4"
            >
              <Server size={24} className="text-emerald-600 dark:text-emerald-400" />
            </motion.div>
            <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 tracking-tight">
              {t("server.title")}
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1.5">
              {t("server.subtitle")}
            </p>
          </div>

          <form onSubmit={handleConnect} className="space-y-4">
            {/* 服务器地址输入（三段式） */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                {t("server.addressLabel")}
              </label>
              <ServerAddressInput
                value={parts}
                onChange={(next) => {
                  setParts(next);
                  if (status !== "idle") setStatus("idle");
                  if (notice) setNotice("");
                }}
                autoFocus
                accent="emerald"
                rightSlot={statusIcon()}
              />
              <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
                {t("server.addressHint")}
              </p>
            </div>

            {/* 错误提示 */}
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20"
              >
                <div className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0" />
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              </motion.div>
            )}

            {notice && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-5 text-amber-700 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-300">
                {notice}
              </div>
            )}

            {/* 连接按钮 */}
            <button
              type="submit"
              disabled={isLoading || !parts.host.trim()}
              className="w-full flex items-center justify-center py-2.5 px-4 rounded-xl text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-500 dark:focus:ring-offset-zinc-900 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm hover:shadow-md"
            >
              {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <span className="flex items-center gap-2">
                  <Wifi size={16} />
                  {t("server.connectButton")}
                </span>
              )}
            </button>
          </form>

          {/* 说明 */}
          <div className="mt-6 pt-5 border-t border-zinc-100 dark:border-zinc-800">
            <p className="text-xs text-zinc-400 dark:text-zinc-500 text-center">
              {t("server.note")}
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
