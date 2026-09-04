import React, { useCallback, useMemo, useState, useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { NodeViewWrapper, NodeViewContent, NodeViewProps } from "@tiptap/react";
import { Copy, Check, ChevronDown, ChevronRight, ChevronUp, Eye, Code2, FileText, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CODE_BLOCK_THEMES,
  CodeBlockThemeId,
  getSavedCodeBlockTheme,
  setCodeBlockTheme,
} from "@/lib/codeBlockTheme";
import MermaidView from "@/components/MermaidView";
import { isMermaidLang } from "@/lib/mermaidRenderer";
import { replaceCodeBlockWithPlainText } from "@/lib/tiptapEditorCommands";
import { canUseCodeBlockToolbarAction } from "@/lib/codeBlockPermissions";
import { formatCodeBlockLanguageLabel } from "@/lib/codeBlockLowlight";
import { copyText } from "@/lib/clipboard";
import { recordPhaseAPerfEvent } from "@/lib/phaseAPerfDiagnostics";
import {
  getEditorEditableSnapshot,
  subscribeEditorEditable,
} from "@/lib/editorEditableStore";

/**
 * 自定义代码块视图：
 *  - 顶部工具条：折叠箭头 + 标题输入框 + 语言切换下拉 + 主题切换下拉
 *  - 右侧操作：复制 / 运行 / 更多菜单（折叠、解散等）
 *  - 行号区（使用 CSS counter 自动生成，无需侵入 ProseMirror 内容模型）
 */

// 常用语言列表（超集由 lowlight.common 决定）
// 注：mermaid 不在 lowlight 注册，是 nowen 自己识别的特殊语言（用于流程图渲染），
// 把它放进常用列表是为了在语言下拉里可以一键切换到 mermaid，触发 MermaidView。
const POPULAR_LANGUAGES = [
  "auto", "plaintext",
  "javascript", "typescript", "tsx", "jsx",
  "html", "css", "scss", "json", "xml",
  "python", "java", "c", "cpp", "csharp",
  "go", "rust", "php", "ruby", "kotlin", "swift",
  "bash", "shell", "powershell",
  "sql", "yaml", "markdown", "diff", "dockerfile",
  "maxscript", "mermaid",
];

export function normalizeCodeBlockIndent(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(8, Math.trunc(numeric)));
}

export function CodeBlockView(props: NodeViewProps) {
  const { node, updateAttributes, extension, editor, getPos } = props;
  const lowlight = (extension.options as any)?.lowlight;
  const perfBlockId = String(node.attrs.blockId || node.attrs.language || "code-block");
  recordPhaseAPerfEvent({ type: "code-block-render", blockId: perfBlockId });

  const currentLang: string = node.attrs.language || "auto";
  const indent = normalizeCodeBlockIndent(node.attrs.indent);
  const isMermaid = isMermaidLang(currentLang);
  const [copied, setCopied] = useState(false);
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [langFilter, setLangFilter] = useState("");
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [activeTheme, setActiveTheme] = useState<CodeBlockThemeId>(getSavedCodeBlockTheme);
  const [collapsed, setCollapsed] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [titleEditing, setTitleEditing] = useState(false);
  const [toolbarHidden, setToolbarHidden] = useState(false);
  // 标题输入框使用本地草稿：每次按键只更新草稿，避免 updateAttributes 触发 ProseMirror
  // 事务导致 NodeView 重渲染、输入框丢失焦点（原 bug：无法连续输入/保存）。
  // 仅在失焦或回车时把草稿提交到节点 title 属性，并同步外部变化（如 undo）。
  const [titleDraft, setTitleDraft] = useState<string>((node.attrs.title as string) || "");
  useEffect(() => {
    if (!titleEditing) setTitleDraft((node.attrs.title as string) || "");
  }, [node.attrs.title, titleEditing]);
  const subscribeToEditable = useCallback((listener: () => void) => (
    subscribeEditorEditable(editor, () => {
      recordPhaseAPerfEvent({ type: "code-block-permission-state-update", blockId: perfBlockId });
      listener();
    })
  ), [editor, perfBlockId]);
  useSyncExternalStore(
    subscribeToEditable,
    () => getEditorEditableSnapshot(editor),
    () => getEditorEditableSnapshot(editor),
  );
  const canChangeLanguage = canUseCodeBlockToolbarAction("language", editor);
  const canDissolve = canUseCodeBlockToolbarAction("dissolve", editor);

  useEffect(() => {
    if (canChangeLanguage) return;
    setShowLangPicker(false);
    setLangFilter("");
  }, [canChangeLanguage]);

  // mermaid 块的"源码 / 预览"切换：
  //  - 已有内容（从文档加载、或用户已经输完）默认进入预览态，方便阅读
  //  - 空内容（刚通过工具栏/slash 插入）默认进入源码态，让用户立刻能输入
  //  另外双击预览区可随时切回源码（见下方 onDoubleClick）
  const [mermaidPreview, setMermaidPreview] = useState<boolean>(
    () => isMermaidLang(node.attrs.language || "") && node.textContent.trim().length > 0,
  );
  // 切换到非 mermaid 时把预览状态清掉，避免下次再切回 mermaid 时残留状态混乱
  useEffect(() => {
    if (!isMermaid) setMermaidPreview(true);
  }, [isMermaid]);

  // 下拉面板锚点按钮 ref，用于计算 fixed 弹出位置（避免被代码块容器 overflow-hidden 裁剪）
  const langBtnRef = useRef<HTMLButtonElement | null>(null);
  const themeBtnRef = useRef<HTMLButtonElement | null>(null);
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const [langPopupPos, setLangPopupPos] = useState<{ top: number; left: number; placement: "bottom" | "top" } | null>(null);
  const [themePopupPos, setThemePopupPos] = useState<{ top: number; right: number; placement: "bottom" | "top" } | null>(null);
  const [morePopupPos, setMorePopupPos] = useState<{ top: number; right: number; placement: "bottom" | "top" } | null>(null);

  // 语言下拉宽度 / 主题下拉宽度（与原样式保持一致：w-48 / w-52）
  const LANG_POPUP_WIDTH = 192; // w-48
  const THEME_POPUP_WIDTH = 208; // w-52
  // 预估面板最大高度（含搜索框/标题与列表）
  const LANG_POPUP_MAX_H = 260;
  const THEME_POPUP_MAX_H = 300;

  const computeLangPopupPos = useCallback(() => {
    const btn = langBtnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const placement: "bottom" | "top" = spaceBelow < LANG_POPUP_MAX_H && rect.top > spaceBelow ? "top" : "bottom";
    const top = placement === "bottom" ? rect.bottom + 4 : Math.max(8, rect.top - 4 - LANG_POPUP_MAX_H);
    // 左对齐按钮，同时避免超出右边界
    const left = Math.min(
      Math.max(8, rect.left),
      window.innerWidth - LANG_POPUP_WIDTH - 8,
    );
    setLangPopupPos({ top, left, placement });
  }, []);

  const computeThemePopupPos = useCallback(() => {
    const btn = themeBtnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const placement: "bottom" | "top" = spaceBelow < THEME_POPUP_MAX_H && rect.top > spaceBelow ? "top" : "bottom";
    const top = placement === "bottom" ? rect.bottom + 4 : Math.max(8, rect.top - 4 - THEME_POPUP_MAX_H);
    // 右对齐按钮
    const right = Math.max(8, window.innerWidth - rect.right);
    setThemePopupPos({ top, right, placement });
  }, []);

  const MORE_POPUP_MAX_H = 200;

  const computeMorePopupPos = useCallback(() => {
    const btn = moreBtnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const placement: "bottom" | "top" = spaceBelow < MORE_POPUP_MAX_H && rect.top > spaceBelow ? "top" : "bottom";
    const top = placement === "bottom" ? rect.bottom + 4 : Math.max(8, rect.top - 4 - MORE_POPUP_MAX_H);
    // 右对齐按钮
    const right = Math.max(8, window.innerWidth - rect.right);
    setMorePopupPos({ top, right, placement });
  }, []);

  const commitTitle = useCallback(() => {
    const val = titleDraft.trim();
    const current = (node.attrs.title as string) || "";
    if (val !== current) {
      updateAttributes({ title: val || undefined });
    }
  }, [titleDraft, node.attrs.title, updateAttributes]);

  const handleTitleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setTitleDraft(e.target.value);
  }, []);

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitTitle();
      setTitleEditing(false);
      (e.target as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
      setTitleDraft((node.attrs.title as string) || "");
      setTitleEditing(false);
      (e.target as HTMLInputElement).blur();
    }
  }, []);

  // 订阅全局主题变化，使同文档多个代码块同步刷新高亮（UI 内选中态）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<CodeBlockThemeId>).detail;
      if (detail) setActiveTheme(detail);
    };
    window.addEventListener("nowen:codeblock-theme-change", handler);
    return () => window.removeEventListener("nowen:codeblock-theme-change", handler);
  }, []);

  // 构造可选语言列表：lowlight 已注册 ∪ 常用语言（去重并排序）
  const availableLanguages = useMemo(() => {
    let registered: string[] = [];
    try {
      if (lowlight && typeof lowlight.listLanguages === "function") {
        registered = lowlight.listLanguages();
      }
    } catch {
      /* ignore */
    }
    const set = new Set<string>(["auto", "plaintext", ...registered, ...POPULAR_LANGUAGES]);
    return Array.from(set).sort((a, b) => {
      if (a === "auto") return -1;
      if (b === "auto") return 1;
      if (a === "plaintext") return -1;
      if (b === "plaintext") return 1;
      return a.localeCompare(b);
    });
  }, [lowlight]);

  const filteredLanguages = useMemo(() => {
    const q = langFilter.trim().toLowerCase();
    if (!q) return availableLanguages;
    return availableLanguages.filter((l) => l.toLowerCase().includes(q));
  }, [availableLanguages, langFilter]);

  const handleCopy = useCallback(async () => {
    const ok = await copyText(node.textContent);
    if (!ok) {
      console.error("Copy code block failed: clipboard API unavailable");
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [node]);

  const handleSelectLanguage = useCallback(
    (lang: string) => {
      // disabled 只保护鼠标交互；handler 仍需防御测试调用、键盘事件和未来重构。
      if (!canUseCodeBlockToolbarAction("language", editor)) return;
      updateAttributes({ language: lang === "auto" ? null : lang });
      setShowLangPicker(false);
      setLangFilter("");
    },
    [editor, updateAttributes],
  );

  const handleDissolveToText = useCallback(() => {
    if (!canUseCodeBlockToolbarAction("dissolve", editor) || typeof getPos !== "function") return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    replaceCodeBlockWithPlainText(editor, pos, node);
  }, [editor, getPos, node]);

  // 点击外部关闭语言选择器
  useEffect(() => {
    if (!showLangPicker) return;
    const handleDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (!target.closest("[data-codeblock-langpicker]")) {
        setShowLangPicker(false);
        setLangFilter("");
      }
    };
    // 微任务延迟，避免与触发按钮同一 tick 冲突
    const id = setTimeout(() => document.addEventListener("mousedown", handleDocClick), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", handleDocClick);
    };
  }, [showLangPicker]);

  // 打开语言选择器时计算位置；滚动/resize 时重算或关闭
  useEffect(() => {
    if (!showLangPicker) {
      setLangPopupPos(null);
      return;
    }
    computeLangPopupPos();
    let raf = 0;
    const scheduleRecompute = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(computeLangPopupPos);
    };
    const onScroll = (e: Event) => {
      const target = e.target as Element | null;
      if (target?.closest?.("[data-codeblock-langpicker]")) return;
      scheduleRecompute();
    };
    window.addEventListener("resize", scheduleRecompute);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", scheduleRecompute);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [showLangPicker, computeLangPopupPos]);

  // 点击外部关闭主题选择器
  useEffect(() => {
    if (!showThemePicker) return;
    const handleDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (!target.closest("[data-codeblock-themepicker]")) {
        setShowThemePicker(false);
      }
    };
    const id = setTimeout(() => document.addEventListener("mousedown", handleDocClick), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", handleDocClick);
    };
  }, [showThemePicker]);

  // 打开主题选择器时计算位置；滚动/resize 时关闭
  useEffect(() => {
    if (!showThemePicker) {
      setThemePopupPos(null);
      return;
    }
    computeThemePopupPos();
    let raf = 0;
    const scheduleRecompute = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(computeThemePopupPos);
    };
    const onScroll = (e: Event) => {
      const target = e.target as Element | null;
      if (target?.closest?.("[data-codeblock-themepicker]")) return;
      scheduleRecompute();
    };
    window.addEventListener("resize", scheduleRecompute);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", scheduleRecompute);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [showThemePicker, computeThemePopupPos]);

  // 点击外部关闭更多菜单
  useEffect(() => {
    if (!showMoreMenu) return;
    const handleDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (!target.closest("[data-codeblock-more]")) {
        setShowMoreMenu(false);
      }
    };
    const id = setTimeout(() => document.addEventListener("mousedown", handleDocClick), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", handleDocClick);
    };
  }, [showMoreMenu]);

  // 打开更多菜单时计算位置；滚动/resize 时关闭
  useEffect(() => {
    if (!showMoreMenu) {
      setMorePopupPos(null);
      return;
    }
    computeMorePopupPos();
    let raf = 0;
    const scheduleRecompute = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(computeMorePopupPos);
    };
    const onScroll = (e: Event) => {
      const target = e.target as Element | null;
      if (target?.closest?.("[data-codeblock-more]")) return;
      scheduleRecompute();
    };
    window.addEventListener("resize", scheduleRecompute);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", scheduleRecompute);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [showMoreMenu, computeMorePopupPos]);

  const handleSelectTheme = useCallback((theme: CodeBlockThemeId) => {
    setCodeBlockTheme(theme);
    setActiveTheme(theme);
    setShowThemePicker(false);
  }, []);

  return (
    <NodeViewWrapper
      className="code-block-wrapper group relative my-4 rounded-xl overflow-hidden border shadow-sm"
      data-indent={indent > 0 ? indent : undefined}
      style={{ position: "relative" }}
    >
      {/* 顶部工具栏（不可编辑） */}
      {!toolbarHidden && (
      <div
        className="code-block-toolbar flex items-center justify-between px-3 py-1.5 border-b select-none"
        contentEditable={false}
      >
        {/* 左侧：折叠箭头 + 标题输入框 + 语言选择器 + 主题选择器 */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {/* 折叠/展开箭头 */}
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="code-block-tool-btn shrink-0 p-0.5 rounded transition-colors text-[var(--code-muted)] hover:text-[var(--code-muted-strong)]"
            title={collapsed ? "展开代码" : "折叠代码"}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>

          {/* 标题输入框 */}
          <input
            ref={titleInputRef}
            type="text"
            value={titleDraft}
            onChange={handleTitleChange}
            onKeyDown={handleTitleKeyDown}
            onMouseDown={(e) => e.stopPropagation()}
            onFocus={() => setTitleEditing(true)}
            onBlur={() => {
              commitTitle();
              setTitleEditing(false);
            }}
            placeholder="请输入代码块名称"
            className="code-block-title-input bg-transparent border-none outline-none text-[12px] text-[var(--code-muted-strong)] placeholder:text-[var(--code-muted)] min-w-[100px] max-w-[200px]"
          />

          {/* 语言选择器 */}
          <div className="relative shrink-0" data-codeblock-langpicker>
            <button
              ref={langBtnRef}
              type="button"
              disabled={!canChangeLanguage}
              aria-disabled={!canChangeLanguage}
              onClick={(e) => {
                e.stopPropagation();
                if (!canUseCodeBlockToolbarAction("language", editor)) return;
                setShowLangPicker((v) => !v);
                setShowThemePicker(false);
                setShowMoreMenu(false);
              }}
              className={cn(
                "code-block-tool-btn flex items-center gap-0.5 px-2 py-0.5 rounded text-[12px] font-medium transition-colors",
                !canChangeLanguage && "opacity-40 cursor-not-allowed",
              )}
              title={canChangeLanguage ? "切换语言" : "笔记本已锁定，不能修改代码语言"}
            >
              <span>{formatCodeBlockLanguageLabel(currentLang)}</span>
              <ChevronDown size={11} />
            </button>

            {canChangeLanguage && showLangPicker && langPopupPos && createPortal(
              <div
                data-codeblock-langpicker
                className="code-block-popup border rounded-md shadow-xl overflow-hidden"
                style={{
                  position: "fixed",
                  top: langPopupPos.top,
                  left: langPopupPos.left,
                  width: LANG_POPUP_WIDTH,
                  zIndex: 1000,
                  animation: "contextMenuIn 0.12s ease-out",
                }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <input
                  autoFocus
                  value={langFilter}
                  onChange={(e) => setLangFilter(e.target.value)}
                  placeholder="搜索语言..."
                  className="code-block-popup-input w-full px-2 py-1.5 border-b text-[11px] focus:outline-none"
                />
                <div className="max-h-56 overflow-auto py-1">
                  {filteredLanguages.length === 0 ? (
                    <div className="code-block-popup-empty px-2 py-1.5 text-[11px]">无匹配</div>
                  ) : (
                    filteredLanguages.map((lang) => (
                      <button
                        key={lang}
                        type="button"
                        onClick={() => handleSelectLanguage(lang)}
                        className={cn(
                          "code-block-popup-item w-full text-left px-2 py-1 text-[11px] font-mono transition-colors",
                          lang === (currentLang || "auto") && "is-active",
                        )}
                      >
                        {formatCodeBlockLanguageLabel(lang)}
                      </button>
                    ))
                  )}
                </div>
              </div>,
              document.body,
            )}
          </div>

          {/* 主题选择器 */}
          <div className="relative shrink-0" data-codeblock-themepicker>
            <button
              ref={themeBtnRef}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowThemePicker((v) => !v);
                setShowLangPicker(false);
                setShowMoreMenu(false);
              }}
              className="code-block-tool-btn flex items-center gap-0.5 px-2 py-0.5 rounded text-[12px] font-medium transition-colors"
              title="切换代码块主题"
            >
              <span>{CODE_BLOCK_THEMES.find(t => t.id === activeTheme)?.label || activeTheme}</span>
              <ChevronDown size={11} />
            </button>

            {showThemePicker && themePopupPos && createPortal(
              <div
                data-codeblock-themepicker
                className="code-block-popup border rounded-md shadow-xl overflow-hidden"
                style={{
                  position: "fixed",
                  top: themePopupPos.top,
                  right: themePopupPos.right,
                  width: THEME_POPUP_WIDTH,
                  zIndex: 1000,
                  animation: "contextMenuIn 0.12s ease-out",
                }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="max-h-64 overflow-auto py-1">
                  {CODE_BLOCK_THEMES.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => handleSelectTheme(t.id)}
                      className={cn(
                        "code-block-popup-item w-full text-left px-2 py-1.5 text-[11px] transition-colors flex items-center gap-2",
                        t.id === activeTheme && "is-active",
                      )}
                    >
                      <span
                        className="w-5 h-5 rounded border shrink-0 flex items-center justify-center"
                        style={{
                          background: t.preview.bg,
                          borderColor: "rgba(128,128,128,0.35)",
                        }}
                      >
                        <span
                          className="w-2 h-2 rounded-sm"
                          style={{ background: t.preview.accent }}
                        />
                      </span>
                      <span className="flex-1">{t.label}</span>
                      {t.id === activeTheme && <Check size={12} />}
                    </button>
                  ))}
                </div>
              </div>,
              document.body,
            )}
          </div>
        </div>

        {/* 右侧：复制 + 更多菜单 */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={handleCopy}
            className={cn(
              "code-block-tool-btn flex items-center gap-1 px-1.5 py-0.5 rounded text-[12px] font-medium transition-colors",
              copied && "is-copied",
            )}
            title={copied ? "已复制" : "复制代码"}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
          <div className="relative" data-codeblock-more>
            <button
              ref={moreBtnRef}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowMoreMenu((v) => !v);
                setShowLangPicker(false);
                setShowThemePicker(false);
              }}
              className="code-block-tool-btn flex items-center px-1.5 py-0.5 rounded text-[12px] font-medium transition-colors"
              title="更多操作"
            >
              <MoreHorizontal size={14} />
            </button>

            {showMoreMenu && morePopupPos && createPortal(
              <div
                data-codeblock-more
                className="code-block-popup border rounded-lg shadow-xl overflow-hidden min-w-[150px] py-1"
                style={{
                  position: "fixed",
                  top: morePopupPos.top,
                  right: morePopupPos.right,
                  zIndex: 1000,
                  animation: "contextMenuIn 0.12s ease-out",
                }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {isMermaid && (
                  <button
                    type="button"
                    onClick={() => { setMermaidPreview((v) => !v); setShowMoreMenu(false); }}
                    className="code-block-popup-item w-full text-left px-3 py-1.5 text-[12px] transition-colors flex items-center gap-2"
                  >
                    {mermaidPreview ? <Code2 size={13} /> : <Eye size={13} />}
                    <span>{mermaidPreview ? "切换到源码" : "切换到预览"}</span>
                  </button>
                )}
                <button
                  type="button"
                  disabled={!canDissolve}
                  aria-disabled={!canDissolve}
                  onClick={() => { handleDissolveToText(); setShowMoreMenu(false); }}
                  className={cn(
                    "code-block-popup-item w-full text-left px-3 py-1.5 text-[12px] transition-colors flex items-center gap-2",
                    !canDissolve && "opacity-40 cursor-not-allowed",
                  )}
                >
                  <FileText size={13} />
                  <span>解散为文本</span>
                </button>
              </div>,
              document.body,
            )}
          </div>
        </div>
      </div>
      )}

      {/* 代码内容区 */}
      <div className="relative">
        {/* 工具栏隐藏时，悬浮显示恢复按钮 */}
        {toolbarHidden && (
          <button
            type="button"
            onClick={() => setToolbarHidden(false)}
            className="absolute top-2 right-2 z-10 code-block-tool-btn p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"
            title="显示工具栏"
          >
            <ChevronUp size={14} />
          </button>
        )}

        {/* 工具栏未隐藏时，悬浮显示收起按钮 */}
        {!toolbarHidden && (
          <button
            type="button"
            onClick={() => setToolbarHidden(true)}
            className="absolute top-2 right-2 z-10 code-block-tool-btn p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"
            title="隐藏工具栏"
          >
            <ChevronDown size={14} />
          </button>
        )}

        {isMermaid && mermaidPreview ? (
          <>
            <div
              className="mermaid-preview-host px-3 py-2 cursor-text"
              contentEditable={false}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setMermaidPreview(false);
              }}
              title="双击进入源码编辑"
            >
              <MermaidView source={node.textContent} debounceMs={250} />
            </div>
            <pre
              className="code-block-pre"
              style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", pointerEvents: "none" }}
              aria-hidden="true"
            >
              <NodeViewContent
                as={"code" as "div"}
                className="code-block-content"
                style={{ whiteSpace: "pre" }}
              />
            </pre>
          </>
        ) : (
          <pre
            className="code-block-pre"
            style={collapsed ? { maxHeight: "3.5em", overflow: "hidden" } : undefined}
          >
            <NodeViewContent
              as={"code" as "div"}
              className={cn(
                "code-block-content hljs",
                currentLang && currentLang !== "auto" && `language-${currentLang}`,
              )}
              style={{ whiteSpace: "pre" }}
            />
          </pre>
        )}
        {collapsed && !isMermaid && (
          <div
            className="absolute bottom-0 left-0 right-0 h-12 pointer-events-none"
            style={{
              background: "linear-gradient(transparent, var(--code-bg, #1e1e2e))",
            }}
          />
        )}
      </div>
    </NodeViewWrapper>
  );
}

export default CodeBlockView;
