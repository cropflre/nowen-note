import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Palette, Shield, Database, X, Settings } from "lucide-react";
import ThemeToggle from "@/components/ThemeToggle";
import SecuritySettings from "@/components/SecuritySettings";
import DataManager from "@/components/DataManager";

const SETTING_TABS = [
  { id: "appearance", label: "外观设置", icon: Palette },
  { id: "security", label: "账号安全", icon: Shield },
  { id: "data", label: "数据管理", icon: Database },
] as const;

type TabId = (typeof SETTING_TABS)[number]["id"];

interface SettingsModalProps {
  onClose: () => void;
  defaultTab?: TabId;
}

function AppearancePanel() {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-1">外观与主题</h3>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6">自定义 nowen-note 的视觉体验</p>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30">
          <div>
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">主题模式</span>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">选择浅色、深色或跟随系统</p>
          </div>
          <ThemeToggle />
        </div>

        <div className="flex items-center justify-between p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30">
          <div>
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">编辑器字体</span>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Inter · 系统默认</p>
          </div>
          <span className="text-xs text-zinc-400 dark:text-zinc-600 px-2.5 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800">默认</span>
        </div>

        <div className="flex items-center justify-between p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30">
          <div>
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">侧边栏宽度</span>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">260px · 标准</p>
          </div>
          <span className="text-xs text-zinc-400 dark:text-zinc-600 px-2.5 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800">标准</span>
        </div>
      </div>
    </div>
  );
}

export default function SettingsModal({ onClose, defaultTab = "appearance" }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<TabId>(defaultTab);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
    >
      {/* 背景遮罩 */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-zinc-900/40 dark:bg-black/60 backdrop-blur-sm"
      />

      {/* 模态框主体 */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ type: "spring", duration: 0.5, bounce: 0 }}
        className="relative w-full max-w-4xl h-[80vh] min-h-[500px] flex overflow-hidden bg-white dark:bg-zinc-950 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 左侧导航栏 */}
        <div className="w-56 flex-shrink-0 bg-zinc-50 dark:bg-zinc-900/50 border-r border-zinc-200 dark:border-zinc-800 p-4 flex flex-col">
          <div className="flex items-center gap-2 mb-6 px-2">
            <Settings className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
            <span className="font-bold text-sm text-zinc-900 dark:text-zinc-100">设置</span>
          </div>

          <nav className="flex-1 space-y-0.5">
            {SETTING_TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-zinc-200/70 dark:bg-zinc-800 text-indigo-600 dark:text-indigo-400"
                      : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/40 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-200"
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {tab.label}
                </button>
              );
            })}
          </nav>

          {/* 底部版本信息 */}
          <div className="mt-auto pt-4 border-t border-zinc-200 dark:border-zinc-800 px-2">
            <p className="text-xs text-zinc-400 dark:text-zinc-600">nowen-note v1.0.0</p>
          </div>
        </div>

        {/* 右侧内容区 */}
        <div className="flex-1 overflow-y-auto relative">
          {/* 关闭按钮 */}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors z-10"
          >
            <X className="w-4 h-4" />
          </button>

          {/* 动态渲染内容 */}
          <div className="p-8 pr-14">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: 0.15 }}
              >
                {activeTab === "appearance" && <AppearancePanel />}
                {activeTab === "security" && <SecuritySettings />}
                {activeTab === "data" && <DataManager />}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
