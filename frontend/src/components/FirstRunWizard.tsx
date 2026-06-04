/**
 * 首次运行向导
 * ---------------------------------------------------------------------------
 * 检测新用户（无工作区、无笔记），显示分步引导：
 * 1. 欢迎页 — 介绍 App 功能
 * 2. 创建家庭空间 — 一键创建
 * 3. 快速导览 — 了解主要模块
 */

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles, MessageCircle, ListTodo, FileText,
  ChevronRight, Check, Loader2,
} from "lucide-react";
import { api, setCurrentWorkspace } from "@/lib/api";
import { useAppActions } from "@/store/AppContext";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

interface FirstRunWizardProps {
  onComplete: () => void;
}

const STEPS = [
  {
    title: "欢迎来到 NowenNote",
    description: "为家庭打造的笔记、说说和待办协作空间。记录生活点滴、管理家庭事务、分享重要信息。",
    icon: <Sparkles size={32} />,
    color: "from-violet-500 to-pink-500",
  },
  {
    title: "创建家庭空间",
    description: "一键创建工作区，邀请家人一起使用。说说、待办、笔记，全家人共享。",
    icon: "🏠",
    color: "from-emerald-500 to-teal-500",
  },
  {
    title: "快速导览",
    description: "在左侧导航栏可以切换不同模块：📖 说说（记录生活）、✅ 待办（家庭任务）、📝 笔记（共享知识）、🧠 思维导图、🤖 AI 助手。",
    icon: <Sparkles size={32} />,
    color: "from-amber-500 to-orange-500",
  },
  {
    title: "开始使用",
    description: "现在你已经准备好和家人一起使用了！可以从写第一篇说说或创建一个待办事项开始。",
    icon: <Check size={32} />,
    color: "from-blue-500 to-indigo-500",
  },
];

const FEATURES = [
  { icon: "📖", label: "家庭说说", desc: "分享生活瞬间" },
  { icon: "✅", label: "共享待办", desc: "管理家庭事务" },
  { icon: "📝", label: "协作笔记", desc: "记录重要信息" },
  { icon: "🧠", label: "思维导图", desc: "头脑风暴" },
  { icon: "🤖", label: "AI 助手", desc: "智能问答" },
];

export default function FirstRunWizard({ onComplete }: FirstRunWizardProps) {
  const actions = useAppActions();
  const [step, setStep] = useState(0);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isNewUser, setIsNewUser] = useState(false);

  // 检测是否为新用户
  useEffect(() => {
    Promise.all([
      api.getWorkspaces().catch(() => []),
      api.getNotes({ limit: "1", isTrashed: "0" }).catch(() => []),
    ])
      .then(([workspaces, notes]) => {
        const hasWorkspace = workspaces.length > 0;
        const hasNotes = Array.isArray(notes) && notes.length > 0;
        setIsNewUser(!hasWorkspace && !hasNotes);
      })
      .catch(() => setIsNewUser(false))
      .finally(() => setLoading(false));
  }, []);

  // 创建家庭空间
  const handleCreateFamily = useCallback(async () => {
    setCreating(true);
    try {
      const ws = await api.createWorkspace({
        name: "我的家庭",
        description: "一家人共享的笔记、说说和待办空间",
        icon: "🏠",
      });
      setCurrentWorkspace(ws.id);
      window.dispatchEvent(new CustomEvent("nowen:workspace-changed", { detail: { workspaceId: ws.id } }));
      setCreated(true);
      toast.success("家庭空间创建成功！");
    } catch (e: any) {
      toast.error(e?.message || "创建失败");
    } finally {
      setCreating(false);
    }
  }, []);

  const handleNext = () => {
    if (step === STEPS.length - 1) {
      onComplete();
      return;
    }
    if (step === 1 && !created) {
      handleCreateFamily();
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const handleSkip = () => {
    onComplete();
  };

  if (loading) return null;
  if (!isNewUser) return null;

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  return (
    <div className="fixed inset-0 z-[200] bg-black/60 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-app-elevated rounded-3xl shadow-2xl border border-app-border w-full max-w-[440px] overflow-hidden"
      >
        {/* 进度条 */}
        <div className="flex gap-1.5 px-6 pt-5">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={cn(
                "h-1 flex-1 rounded-full transition-all duration-300",
                i <= step ? "bg-accent-primary" : "bg-app-border/40",
              )}
            />
          ))}
        </div>

        {/* 内容 */}
        <div className="px-6 py-6">
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
            >
              {/* 图标 */}
              <div className={cn(
                "w-16 h-16 rounded-2xl bg-gradient-to-br flex items-center justify-center mb-4",
                current.color,
              )}>
                {typeof current.icon === "string" ? (
                  <span className="text-3xl">{current.icon}</span>
                ) : (
                  <div className="text-white">{current.icon}</div>
                )}
              </div>

              {/* 标题 */}
              <h2 className="text-xl font-bold text-tx-primary mb-2">{current.title}</h2>
              <p className="text-sm text-tx-secondary leading-relaxed mb-4">{current.description}</p>

              {/* Step 2: 创建按钮 */}
              {step === 1 && (
                <button
                  onClick={handleCreateFamily}
                  disabled={creating || created}
                  className={cn(
                    "w-full py-3 rounded-xl text-sm font-medium transition-all flex items-center justify-center gap-2",
                    created
                      ? "bg-green-500/10 text-green-600 border border-green-500/20"
                      : "bg-gradient-to-r from-emerald-500 to-teal-500 text-white hover:opacity-90 shadow-lg shadow-emerald-500/20",
                  )}
                >
                  {creating ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : created ? (
                    <Check size={16} />
                  ) : (
                    <Sparkles size={16} />
                  )}
                  {creating ? "创建中..." : created ? "已创建" : "一键创建家庭空间"}
                </button>
              )}

              {/* Step 3: 功能列表 */}
              {step === 2 && (
                <div className="grid grid-cols-5 gap-2 mt-4">
                  {FEATURES.map((f) => (
                    <div key={f.label} className="text-center p-2 rounded-xl bg-app-hover/30">
                      <div className="text-2xl mb-1">{f.icon}</div>
                      <div className="text-[10px] font-medium text-tx-primary">{f.label}</div>
                      <div className="text-[8px] text-tx-tertiary mt-0.5">{f.desc}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Step 4: 快捷入口 */}
              {step === 3 && (
                <div className="flex flex-wrap gap-2 mt-4">
                  <button
                    onClick={() => { onComplete(); actions.setViewMode("diary"); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium bg-violet-500/10 text-violet-600 hover:bg-violet-500/20 transition-all"
                  >
                    <MessageCircle size={12} /> 写说说
                  </button>
                  <button
                    onClick={() => { onComplete(); actions.setViewMode("tasks"); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 transition-all"
                  >
                    <ListTodo size={12} /> 待办事项
                  </button>
                  <button
                    onClick={() => { onComplete(); actions.setViewMode("all"); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 transition-all"
                  >
                    <FileText size={12} /> 写笔记
                  </button>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-between px-6 pb-5">
          <button onClick={handleSkip} className="text-xs text-tx-tertiary hover:text-tx-secondary transition-colors">
            跳过引导
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-tx-secondary hover:bg-app-hover transition-all"
              >
                上一步
              </button>
            )}
            <button
              onClick={handleNext}
              className="px-5 py-2 rounded-xl bg-accent-primary text-white text-xs font-medium hover:bg-accent-primary/90 transition-all flex items-center gap-1.5"
            >
              {isLast ? "开始使用" : "下一步"}
              {!isLast && <ChevronRight size={14} />}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
