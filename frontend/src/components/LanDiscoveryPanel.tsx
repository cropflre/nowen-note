import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Wifi, Radar, Loader2, ChevronDown, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { parseServerUrl, type ServerAddressParts } from "@/lib/serverUrl";
import { getLanDiscovery, type DiscoveredService } from "@/lib/lanDiscovery";

/**
 * 局域网 nowen-note 服务器发现面板
 *
 * 在以下环境可用（共享同一套 mDNS 协议 `_nowen-note._tcp.local.`）：
 *   - Electron 桌面端 → 走 main 进程 bonjour-service
 *   - Android / iOS（Capacitor 原生）→ 走 @capacitor-community/zeroconf
 *   - 普通浏览器 / Web → 不支持，组件自动隐身（返回 null）
 *
 * 设计要点：
 *   - mount 时自动 start 扫描，unmount 时 stop。避免用户进页面还要点一下。
 *   - 列表为空时显示"正在发现…"而非空白；调用方能从"扫描中" → "已发现 N 条"
 *     → "已选第一条自动填地址"无缝过渡。
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

function preferredHost(svc: DiscoveredService): string {
  // 优先 IPv4（用户可达性最强），其次原始 host（.local 名字），最后第一个 address
  if (svc.ipv4) return svc.ipv4;
  if (svc.host) return svc.host.replace(/\.local\.?$/i, "");
  return svc.addresses[0] || "";
}

function toAddressParts(svc: DiscoveredService): ServerAddressParts {
  const host = preferredHost(svc);
  const isHttps = svc.txt?.https === "1";
  const url = `${isHttps ? "https" : "http"}://${host}:${svc.port}`;
  return parseServerUrl(url);
}

/**
 * 扫描多久还没结果就转入"未发现"提示。设计取舍：
 *   - 太短（< 3s）：手机刚连上 Wi-Fi、第一轮多播包还没到就误报
 *   - 太长（> 10s）：用户一直盯着 spinner 不知所措
 *   5 秒是 mDNS 现网测试里"正常局域网应该已经收到至少一条 announcement"的经验
 *   阈值（每 1s 一发，丢包重传后 5s 内一定到）。
 */
const SCAN_TIMEOUT_MS = 5000;

export default function LanDiscoveryPanel({
  currentHostIsEmpty,
  onSelect,
}: LanDiscoveryPanelProps) {
  const { t } = useTranslation();
  const [services, setServices] = useState<DiscoveredService[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [expanded, setExpanded] = useState(true);
  // 扫描超时仍为空 → 切到"未发现"文案，避免无限转圈
  const [scanTimedOut, setScanTimedOut] = useState(false);
  // 保证"自动填"仅做一次——用户一旦手动改 host 后就不再覆盖
  const autoFilledRef = useRef(false);

  const discovery = getLanDiscovery();
  const hasDiscovery = discovery.isAvailable();

  useEffect(() => {
    if (!hasDiscovery) return;

    let cancelled = false;
    const off = discovery.onUpdate((list) => {
      if (cancelled) return;
      setServices(list);
      // 一旦发现到任意条目，立即解除"超时"状态——
      // 用户后续若把第一条移除（不太可能），UI 会回到 spinner 而非"未发现"，更直观
      if (list.length > 0) setScanTimedOut(false);

      // 首次发现 + 用户未填 host → 自动选第一条
      if (!autoFilledRef.current && list.length > 0 && currentHostIsEmpty) {
        autoFilledRef.current = true;
        onSelect(toAddressParts(list[0]));
      }
    });

    discovery
      .start()
      .then((r) => {
        if (!cancelled) setAvailable(!!r?.available);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });

    // 倒计时：到点仍空 → 标记超时；任何一条发现都会把这个标记重置（见上）
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      setScanTimedOut(true);
    }, SCAN_TIMEOUT_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      try {
        off?.();
      } catch {
        /* ignore */
      }
      // 最后一个订阅者离开时由 discovery 停止扫描；不能中断后台端点解析器的订阅。
    };
    // currentHostIsEmpty 只用于首次判定，这里故意只在 mount 时读取 —— 否则用户一填 host
    // 就会移除订阅，违反"持续推送更新"的预期。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasDiscovery]);

  /** 用户主动重新扫描：清空旧结果 + 重置超时 + 重新 start */
  const handleRescan = () => {
    setServices([]);
    setScanTimedOut(false);
    autoFilledRef.current = false;
    // 先停后开，确保 NsdManager / bonjour 内部缓存被清掉重新走一遍 announcement
    Promise.resolve(discovery.stop())
      .catch(() => {})
      .then(() => discovery.start())
      .then((r) => setAvailable(!!r?.available))
      .catch(() => setAvailable(false));
    // 重新启倒计时
    window.setTimeout(() => {
      // 若期间已收到结果，services 非空，下一次 onUpdate 会再次清掉 timeout 标记
      setScanTimedOut((prev) => prev || services.length === 0);
    }, SCAN_TIMEOUT_MS);
  };

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

              {available !== false &&
                services.length === 0 &&
                (scanTimedOut ? (
                  // 超时空态：明确告诉用户原因 + 提供"重新扫描"。
                  // 大多数"搜不到"的真实原因（按概率排序）：
                  //   1) 服务器在公网/跨网段，本来就不属于 mDNS 能力范围
                  //   2) 手机和 PC 不在同一个 Wi-Fi
                  //   3) Wi-Fi 路由器开了 multicast filter / AP isolation
                  //   4) 后端没启动 / 没装 bonjour-service
                  // 这些都不是 app 能从客户端侧自动修复的，只能告知。
                  <div className="space-y-1.5 py-1">
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
                      {t("server.lanNotFound", {
                        defaultValue:
                          "未在当前 Wi-Fi 内发现服务器。如果服务器在公网或跨网段，请直接手动填写地址。",
                      })}
                    </p>
                    <button
                      type="button"
                      onClick={handleRescan}
                      className="inline-flex items-center gap-1 text-[11px] text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors"
                    >
                      <RefreshCw className="w-3 h-3" />
                      {t("server.lanRescan", { defaultValue: "重新扫描" })}
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-[11px] text-zinc-400 dark:text-zinc-500 py-1.5">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    {t("server.lanScanning", {
                      defaultValue: "正在搜索局域网内的服务器…",
                    })}
                  </div>
                ))}

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

              {/* 已经有结果时也提供"重新扫描"——多设备/路由切换后能让用户主动刷新 */}
              {services.length > 0 && (
                <button
                  type="button"
                  onClick={handleRescan}
                  className="inline-flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors px-2 py-1"
                >
                  <RefreshCw className="w-3 h-3" />
                  {t("server.lanRescan", { defaultValue: "重新扫描" })}
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
