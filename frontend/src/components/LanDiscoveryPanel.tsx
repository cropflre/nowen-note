import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Wifi, Radar, Loader2, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { parseServerUrl, type ServerAddressParts } from "@/lib/serverUrl";

/**
 * 局域网 nowen-note 服务器发现面板
 *
 * 仅在 Electron 桌面端可用（依赖 window.nowenDesktop.discovery）。移动端 / 浏览器下
 * 这个组件会自动隐身（返回 null），不要在外层额外判断。
 *
 * 设计要点：
 *   - mount 时自动 start 扫描，unmount 时 stop。避免用户进页面还要点一下。
 *   - 列表为空时显示"正在发现…"而非空白，首次扫描至少给 ~3s 时间再降级。
 *   - 发现到多条时：当前用户正在手填的 host 非空 → 不自动填；host 为空 → 自动选第
 *     一条填进去（最常见一机一实例场景）。自动填仅发生一次，用 ref 标记。
 *   - 条目点击 = 再次填入（用户可手动切换）。
 *   - 条目展示：name + 主机:端口；优先 IPv4，其次 IPv6 / host。
 */

export interface LanDiscoveryPanelProps {
  /** 当前 host 是否为空。自动填仅在用户未手填时发生 */
  currentHostIsEmpty: boolean;
  /** 选中一条服务时调用，传拆好的三段地址 */
  onSelect: (parts: ServerAddressParts) => void;
}

interface ServiceItem {
  name: string;
  host: string;
  port: number;
  ipv4: string;
  addresses: string[];
  txt: Record<string, string>;
  lastSeen: number;
}

function preferredHost(svc: ServiceItem): string {
  // 优先 IPv4（用户可达性最强），其次原始 host（.local 名字），最后第一个 address
  if (svc.ipv4) return svc.ipv4;
  if (svc.host) return svc.host.replace(/\.local\.?$/i, "");
  return svc.addresses[0] || "";
}

function toAddressParts(svc: ServiceItem): ServerAddressParts {
  const host = preferredHost(svc);
  const isHttps = svc.txt?.https === "1";
  const url = `${isHttps ? "https" : "http"}://${host}:${svc.port}`;
  return parseServerUrl(url);
}

export default function LanDiscoveryPanel({
  currentHostIsEmpty,
  onSelect,
}: LanDiscoveryPanelProps) {
  const { t } = useTranslation();
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [expanded, setExpanded] = useState(true);
  // 保证"自动填"仅做一次——用户一旦手动改 host 后就不再覆盖
  const autoFilledRef = useRef(false);

  const desktop: any = typeof window !== "undefined" ? (window as any).nowenDesktop : null;
  const hasDiscovery = !!desktop?.discovery;

  useEffect(() => {
    if (!hasDiscovery) return;

    let cancelled = false;
    const off = desktop.discovery.onUpdate((list: ServiceItem[]) => {
      if (cancelled) return;
      setServices(list);

      // 首次发现 + 用户未填 host → 自动选第一条
      if (
        !autoFilledRef.current &&
        list.length > 0 &&
        currentHostIsEmpty
      ) {
        autoFilledRef.current = true;
        onSelect(toAddressParts(list[0]));
      }
    });

    desktop.discovery
      .start()
      .then((r: { ok: boolean; available: boolean }) => {
        if (!cancelled) setAvailable(!!r?.available);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });

    return () => {
      cancelled = true;
      try {
        off?.();
      } catch {
        /* ignore */
      }
      try {
        desktop.discovery.stop();
      } catch {
        /* ignore */
      }
    };
    // currentHostIsEmpty 只用于首次判定，这里故意只在 mount 时读取 —— 否则用户一填 host
    // 就会移除订阅，违反"持续推送更新"的预期。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasDiscovery]);

  if (!hasDiscovery) return null;

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50/60 dark:bg-zinc-800/40 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100/70 dark:hover:bg-zinc-800/60 transition-colors"
      >
        <span className="flex items-center gap-2">
          <Wifi className="w-3.5 h-3.5 text-indigo-500" />
          {t("server.lanDiscoveryTitle", { defaultValue: "局域网发现" })}
          {services.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
              {services.length}
            </span>
          )}
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-zinc-400 transition-transform ${
            expanded ? "rotate-180" : ""
          }`}
        />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <div className="px-3 pb-2 space-y-1">
              {available === false && (
                <p className="text-[11px] text-zinc-400 dark:text-zinc-500 py-1">
                  {t("server.lanUnavailable", {
                    defaultValue: "当前环境不支持自动发现，请手动填写服务器地址。",
                  })}
                </p>
              )}

              {available !== false && services.length === 0 && (
                <div className="flex items-center gap-2 text-[11px] text-zinc-400 dark:text-zinc-500 py-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {t("server.lanScanning", {
                    defaultValue: "正在搜索局域网内的服务器…",
                  })}
                </div>
              )}

              {services.map((svc) => {
                const host = preferredHost(svc);
                const label = host ? `${host}:${svc.port}` : `:${svc.port}`;
                const friendly = svc.name || svc.txt?.name || host;
                return (
                  <button
                    key={svc.name || `${host}:${svc.port}`}
                    type="button"
                    onClick={() => onSelect(toAddressParts(svc))}
                    className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-white dark:hover:bg-zinc-700/60 transition-colors group"
                    title={`${friendly}\n${label}${svc.txt?.v ? `  v${svc.txt.v}` : ""}`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Radar className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">
                          {friendly}
                        </div>
                        <div className="text-[10px] text-zinc-500 dark:text-zinc-500 truncate font-mono">
                          {label}
                          {svc.txt?.v && (
                            <span className="ml-2 opacity-70">v{svc.txt.v}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <span className="text-[10px] text-indigo-500 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                      {t("server.lanUseThis", { defaultValue: "使用" })}
                    </span>
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
