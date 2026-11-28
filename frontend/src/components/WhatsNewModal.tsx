import React, { useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, Sparkles, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 更新日志结构（与 scripts/generate-changelog.mjs 的 --emit-json 输出保持一致）
 *
 * 数据来源：public/changelog.json
 *   - release.sh 在发版前自动重新生成该文件
 *   - vite 构建时会把 public/ 下的文件原样拷贝到产物根，
 *     因此线上、Electron、Capacitor 三端都能通过 `/changelog.json`（同源）访问。
 */
interface ChangelogEntry {
  version: string;
  date: string;
  body: string;   // Markdown 片段（不含顶层 ## 标题，只有 ### 分组及列表）
}

interface ChangelogData {
  generatedAt: string;
  entries: ChangelogEntry[];
}

interface WhatsNewModalProps {
  open: boolean;
  onClose: () => void;
  /** 高亮的版本号（首次升级弹窗时传当前版本）；未传时不高亮 */
  highlightVersion?: string;
}

/**
 * 「更新日志」Modal。
 *
 * 两条使用路径：
 *   1) 首次升级到新版本自动弹出（App.tsx 里检测 localStorage.nowen-seen-version vs __APP_VERSION__）
 *   2) 「设置 → 关于」面板里手动打开
 *
 * 数据加载策略：
 *   - 懒加载：open=true 时才 fetch，避免每次挂载都多一次请求
 *   - 失败时显示一条温和提示（不报错阻断），并给出一个 GitHub Releases 链接兜底
 */
export default function WhatsNewModal({ open, onClose, highlightVersion }: WhatsNewModalProps) {
  const { t } = useTranslation();
  const [data, setData] = useState<ChangelogData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (data) return; // 一次会话内只加载一次

    let cancelled = false;
    setLoading(true);
    setError(null);

    // 加上 ?v=version 让浏览器在升级后失效缓存，不然会看到上一版的内容
    const url = `/changelog.json?v=${encodeURIComponent(__APP_VERSION__)}`;
    fetch(url, { cache: "no-cache" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: ChangelogData) => {
        if (cancelled) return;
        setData(json);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("[WhatsNewModal] load changelog failed:", err);
        setError(err?.message || String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, data]);

  // 按 Esc 关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const entries = useMemo(() => data?.entries ?? [], [data]);

  if (!open) return null;

  const content = (
    <AnimatePresence>
      <motion.div
        key="backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        // data-swipe-blocker：与 SettingsModal 同款机制，阻止移动端全局侧滑误关
        data-swipe-blocker="whats-new"
        className="fixed inset-0 z-[120] bg-zinc-900/60 backdrop-blur-sm flex items-center justify-center p-4"
        onClick={onClose}
      >
        <motion.div
          key="panel"
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          onClick={(e) => e.stopPropagation()}
          className="relative w-full max-w-2xl max-h-[85vh] flex flex-col
                     bg-white/95 dark:bg-zinc-900/95 backdrop-blur-2xl rounded-[26px] shadow-2xl
                     border border-zinc-200/85 dark:border-zinc-800/85 overflow-hidden"
        >
          <div className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-indigo-500/75 via-violet-500/75 to-sky-400/75" />
          {/* 头部 */}
          <div className="flex items-center justify-between px-6 py-4
                          border-b border-zinc-200/80 dark:border-zinc-800/80 bg-zinc-50/50 dark:bg-zinc-900/60 backdrop-blur-md shrink-0">
            <div className="flex items-center gap-3">
              <span className="flex items-center justify-center w-9 h-9 rounded-xl
                               bg-gradient-to-br from-indigo-500/15 via-violet-500/15 to-sky-500/15 text-indigo-500 ring-1 ring-indigo-500/20 shadow-inner">
                <Sparkles size={18} />
              </span>
              <div>
                <h2 className="text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
                  {t("whatsNew.title", "更新日志")}
                </h2>
                <p className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400 mt-0.5">
                  {t("whatsNew.currentVersion", "当前版本")}: v{__APP_VERSION__}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-xl text-zinc-500 hover:text-zinc-900
                         dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800
                         transition-colors"
              aria-label={t("common.close", "关闭")}
            >
              <X size={18} />
            </button>
          </div>

          {/* 正文（滚动区） */}
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {loading && (
              <div className="flex items-center justify-center py-12">
                <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent
                                rounded-full animate-spin" />
                <span className="ml-3 text-sm text-zinc-500">
                  {t("common.loading", "加载中...")}
                </span>
              </div>
            )}

            {error && !loading && (
              <div className="rounded-2xl border border-dashed border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/40 text-center py-10 space-y-3">
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {t("whatsNew.loadFailed", "更新日志加载失败")}
                </p>
                <a
                  href="https://github.com/cropflre/nowen-note/releases"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl
                             bg-gradient-to-r from-indigo-500 to-violet-500 text-white text-xs font-medium shadow-sm shadow-indigo-500/25 hover:brightness-105
                             transition-all"
                >
                  <ExternalLink size={12} />
                  {t("whatsNew.viewOnGithub", "在 GitHub 查看所有版本")}
                </a>
              </div>
            )}

            {!loading && !error && entries.length === 0 && (
              <p className="text-center py-8 text-sm text-zinc-500">
                {t("whatsNew.empty", "暂无更新记录")}
              </p>
            )}

            {!loading && !error && entries.length > 0 && (
              <div className="space-y-4">
                {entries.map((entry) => {
                  const isHighlight = highlightVersion && entry.version === highlightVersion;
                  return (
                    <section
                      key={entry.version}
                      className={
                        isHighlight
                          ? "rounded-2xl border border-indigo-500/35 bg-gradient-to-br from-indigo-500/[0.08] via-violet-500/[0.04] to-transparent p-4 ring-1 ring-indigo-500/15 shadow-sm"
                          : "rounded-2xl border border-zinc-200/85 bg-zinc-50/55 dark:border-zinc-800/85 dark:bg-zinc-900/50 p-4 shadow-xs"
                      }
                    >
                      <header className="flex items-center gap-2 mb-3">
                        <span
                          className={
                            "text-sm font-semibold tabular-nums " +
                            (isHighlight
                              ? "text-indigo-600 dark:text-indigo-300"
                              : "text-zinc-900 dark:text-zinc-100")
                          }
                        >
                          v{entry.version}
                        </span>
                        {entry.date && (
                          <span className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                            {entry.date}
                          </span>
                        )}
                        {isHighlight && (
                          <span className="ml-auto text-[10px] font-medium uppercase
                                           px-2.5 py-0.5 rounded-full bg-gradient-to-r from-indigo-500 to-violet-500
                                           text-white tracking-wider shadow-xs">
                            {t("whatsNew.newBadge", "本次更新")}
                          </span>
                        )}
                      </header>

                      {/*
                        用 prose + react-markdown 渲染。body 里会有 h3（### 分组标题）+ ul+li，
                        这里用 Tailwind typography 做统一排版。不想引入新依赖 —— react-markdown
                        和 remark-gfm 在 AIChatPanel / SharedNoteView 已在用。
                      */}
                      <div
                        className="prose prose-sm dark:prose-invert max-w-none
                                   prose-headings:text-zinc-900 dark:prose-headings:text-zinc-100
                                   prose-h3:text-xs prose-h3:font-semibold prose-h3:mt-3 prose-h3:mb-1.5
                                   prose-h3:text-zinc-600 dark:prose-h3:text-zinc-300
                                   prose-h3:uppercase prose-h3:tracking-wider
                                   prose-ul:my-1 prose-ul:pl-5
                                   prose-li:my-0.5 prose-li:text-zinc-700 dark:prose-li:text-zinc-300
                                   prose-strong:text-indigo-600 dark:prose-strong:text-indigo-300 prose-strong:font-semibold
                                   prose-code:text-xs prose-code:bg-zinc-100 dark:prose-code:bg-zinc-800
                                   prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-md"
                      >
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {entry.body}
                        </ReactMarkdown>
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
          </div>

          {/* 底部 */}
          <div className="px-6 py-3.5 border-t border-zinc-200/80 dark:border-zinc-800/80
                          flex items-center justify-between shrink-0
                          bg-zinc-50/75 dark:bg-zinc-900/75 backdrop-blur-md">
            <a
              href="https://github.com/cropflre/nowen-note/releases"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-zinc-500 dark:text-zinc-400 hover:text-indigo-500
                         inline-flex items-center gap-1 transition-colors"
            >
              <ExternalLink size={11} />
              {t("whatsNew.viewAll", "查看完整历史")}
            </a>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 text-white
                         text-xs font-medium shadow-sm shadow-indigo-500/25 hover:brightness-105 active:scale-[0.98] transition-all"
            >
              {t("whatsNew.gotIt", "我知道了")}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );

  return createPortal(content, document.body);
}

/**
 * 首次升级检测 Hook。
 *
 * 策略：
 *   - localStorage.nowen-seen-version 与 __APP_VERSION__ 不一致 → 说明用户是刚升级上来的
 *   - 首次安装（key 不存在）也会触发一次，让新用户第一次就能看到产品能力速览
 *     （如果不想要此行为，外层组件可以在 enable=false 时不挂载此 Modal）
 *   - 关闭后立刻写回 localStorage，之后再也不弹；下次升版 key 不一致又会触发
 *
 * 返回：[shouldShow, markSeen]
 *   - shouldShow：当前是否应该展示 Modal
 *   - markSeen：调用后写入 seen version 并把 shouldShow 设为 false（Modal onClose 里调）
 */
const SEEN_VERSION_KEY = "nowen-seen-version";

export function useWhatsNew(enable: boolean = true): [boolean, () => void] {
  const [shouldShow, setShouldShow] = useState(false);

  useEffect(() => {
    if (!enable) return;
    try {
      const seen = localStorage.getItem(SEEN_VERSION_KEY);
      // __APP_VERSION__ 是 vite define 注入的编译期常量
      if (seen !== __APP_VERSION__) {
        // 延迟一小下再弹，避免首屏白屏被挡；也给应用内其他 modal（快速登录引导）先出手
        const t = setTimeout(() => setShouldShow(true), 800);
        return () => clearTimeout(t);
      }
    } catch {
      /* localStorage 被禁用时（隐私模式）静默跳过，不影响主流程 */
    }
  }, [enable]);

  const markSeen = () => {
    try {
      localStorage.setItem(SEEN_VERSION_KEY, __APP_VERSION__);
    } catch {
      /* 同上 */
    }
    setShouldShow(false);
  };

  return [shouldShow, markSeen];
}
