import React, { useCallback, useMemo, useState, useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { NodeViewWrapper, NodeViewContent, NodeViewProps } from "@tiptap/react";
import { Copy, Check, ChevronDown, Palette, Eye, Code2, FileText, Minimize2, Maximize2 } from "lucide-react";
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
import { recordPhaseAPerfEvent } from "@/lib/phaseAPerfDiagnostics";
import {
  getEditorEditableSnapshot,
  subscribeEditorEditable,
} from "@/lib/editorEditableStore";

/**
 * 自定义代码块视图：
 *  - 顶部工具条：语言切换下拉 + 复制按钮
 *  - 行号区（使用 CSS counter 自动生成，无需侵入 ProseMirror 内容模型）
 *  - 深色代码区与浅色页面形成清晰对比，突出代码语义
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
  const [langPopupPos, setLangPopupPos] = useState<{ top: number; left: number; placement: "bottom" | "top" } | null>(null);
  const [themePopupPos, setThemePopupPos] = useState<{ top: number; right: number; placement: "bottom" | "top" } | null>(null);

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
    try {
      const text = node.textContent;
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        // 降级：textarea + execCommand
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
        } finally {
          document.body.removeChild(ta);
        }
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("Copy code block failed:", err);
    }
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

  const handleSelectTheme = useCallback((theme: CodeBlockThemeId) => {
    setCodeBlockTheme(theme);
    setActiveTheme(theme);
    setShowThemePicker(false);
  }, []);

  return (
    <NodeViewWrapper
      className="code-block-wrapper group relative my-4 rounded-xl overflow-hidden border shadow-sm"
      data-indent={indent > 0 ? indent : undefined}
      // 预览态时把隐藏的 NodeViewContent 用绝对定位藏起来，依赖外层 relative
      style={{ position: "relative" }}
    >
      {/* 顶部工具栏（不可编辑） */}
      <div
        className="code-block-toolbar flex items-center justify-between px-3 py-1.5 border-b select-none"
        contentEditable={false}
      >
        {/* 左侧：mac 风格小圆点 + 语言徽章（可点击切换） */}
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
          </span>

          <div className="relative" data-codeblock-langpicker>
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
              }}
              className={cn(
                "code-block-tool-btn flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[11px] font-mono transition-colors",
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
        </div>

        {/* 右侧：折叠/展开 + mermaid 切换 + 主题切换 + 复制按钮 */}
        <div className="flex items-center gap-1">
          {!isMermaid && (
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              className="code-block-tool-btn flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium transition-colors"
              title={collapsed ? "展开代码" : "折叠代码"}
            >
              {collapsed ? <Maximize2 size={12} /> : <Minimize2 size={12} />}
              <span className="hidden sm:inline">{collapsed ? "展开" : "折叠"}</span>
            </button>
          )}
          {/* 仅 mermaid 语言显示：源码 / 预览 切换。预览时按钮显示"代码"图标
              （提示点击会切回源码视图），源码时显示"眼睛"图标（提示切回预览） */}
          {isMermaid && (
            <button
              type="button"
              onClick={() => setMermaidPreview((v) => !v)}
              className="code-block-tool-btn flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium transition-colors"
              title={mermaidPreview ? "切换到源码" : "切换到预览"}
            >
              {mermaidPreview ? <Code2 size={12} /> : <Eye size={12} />}
              <span className="hidden sm:inline">{mermaidPreview ? "源码" : "预览"}</span>
            </button>
          )}
          <div className="relative" data-codeblock-themepicker>
            <button
              ref={themeBtnRef}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowThemePicker((v) => !v);
                setShowLangPicker(false);
              }}
              className="code-block-tool-btn flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium transition-colors"
              title="切换代码块主题"
            >
              <Palette size={12} />
              <span className="hidden sm:inline">主题</span>
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
                <div className="code-block-popup-title px-2 py-1.5 text-[11px] font-medium border-b">
                  代码块主题
                </div>
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

          <button
            type="button"
            onClick={handleCopy}
            className={cn(
              "code-block-tool-btn flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium transition-colors",
              copied && "is-copied",
            )}
            title={copied ? "已复制" : "复制代码"}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            <span>{copied ? "已复制" : "复制"}</span>
          </button>
          <button
            type="button"
            disabled={!canDissolve}
            aria-disabled={!canDissolve}
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleDissolveToText}
            className={cn(
              "code-block-tool-btn flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium transition-colors",
              !canDissolve && "opacity-40 cursor-not-allowed",
            )}
            title={canDissolve ? "解散为文本" : "笔记本已锁定，不能解散代码块"}
          >
            <FileText size={12} />
            <span className="hidden sm:inline">解散</span>
          </button>
        </div>
      </div>

      {/* 代码内容区
          - mermaid + 预览态：渲染 SVG 流程图；同时把 NodeViewContent 用零高
            容器藏起来（不能直接不渲染，否则 ProseMirror 找不到节点内容会报错），
            保留可编辑节点的引用同时让用户看到预览。
          - 其它情况：正常显示代码 + lowlight 高亮。 */}
      {isMermaid && mermaidPreview ? (
        <>
          {/* 双击预览区进入源码态，便于直接编辑（与脚注/公式 NodeView 交互一致）；
              单击不切换，避免阅读时误触把图变成代码。 */}
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
          {/* 隐藏但保留的可编辑内容承载节点；ProseMirror 需要它存在 */}
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
        <div className="relative">
          <pre
            className="code-block-pre"
            style={collapsed ? { maxHeight: "120px", overflow: "hidden" } : undefined}
          >
            <NodeViewContent
              // NodeViewContent 的类型声明把 as 限制为 "div"，但 Tiptap 运行时实际支持任意 tag；
              // 这里我们就是要 <code> 以便让 highlight.js / 复制按钮的语义正确。断言绕过类型窄化。
              as={"code" as "div"}
              className={cn(
                "code-block-content hljs",
                currentLang && currentLang !== "auto" && `language-${currentLang}`,
              )}
              style={{ whiteSpace: "pre" }}
            />
          </pre>
          {collapsed && (
            <div
              className="absolute bottom-0 left-0 right-0 h-12 pointer-events-none"
              style={{
                background: "linear-gradient(transparent, var(--code-bg, #1e1e2e))",
              }}
            />
          )}
        </div>
      )}
    </NodeViewWrapper>
  );
}

export default CodeBlockView;
