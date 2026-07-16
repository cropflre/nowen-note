import React, { useState } from "react";
import { BookOpen, FolderOpen, Heart } from "lucide-react";
import ObsidianImport from "@/components/ObsidianImport";
import WeChatFavoritesImport from "@/components/WeChatFavoritesImport";
import YoudaoImportLegacy from "@/components/YoudaoImportLegacy";

type Mode = "obsidian" | "wechat" | "youdao";

export default function FolderMigrationImport() {
  const [mode, setMode] = useState<Mode>("obsidian");

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-800/30">
        <div className="mb-2">
          <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            数据迁移
          </h4>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            支持完整 Obsidian Vault、WeChatDataAnalysis 微信收藏 ZIP 与有道云笔记导出目录。
          </p>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <button
            type="button"
            onClick={() => setMode("obsidian")}
            aria-pressed={mode === "obsidian"}
            className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
              mode === "obsidian"
                ? "border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-500/10 dark:text-violet-300"
                : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            }`}
          >
            <FolderOpen size={14} /> Obsidian Vault
          </button>
          <button
            type="button"
            onClick={() => setMode("wechat")}
            aria-pressed={mode === "wechat"}
            className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
              mode === "wechat"
                ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300"
                : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            }`}
          >
            <Heart size={14} /> 微信收藏
          </button>
          <button
            type="button"
            onClick={() => setMode("youdao")}
            aria-pressed={mode === "youdao"}
            className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
              mode === "youdao"
                ? "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-500/10 dark:text-rose-300"
                : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            }`}
          >
            <BookOpen size={14} /> 有道云笔记
          </button>
        </div>
      </div>

      {mode === "obsidian" && <ObsidianImport />}
      {mode === "wechat" && <WeChatFavoritesImport />}
      {mode === "youdao" && <YoudaoImportLegacy />}
    </div>
  );
}
