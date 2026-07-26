/**
 * useDesktopMenuBridge
 * ---------------------------------------------------
 * 把 Electron 主进程菜单事件路由到 App 层动作。
 * 在非 Electron 环境（浏览器 / Capacitor）里完全 no-op。
 *
 * 设计取舍：
 *   - "新建笔记" 与现有 Alt+N 共享同一条逻辑（在 App.tsx 里已有实现），
 *     这里优先通过调用 App.tsx 暴露的方法；若不方便注入，就派发自定义 DOM event
 *     "nowen:new-note"，让 App 层监听。
 *   - "搜索 / 设置" 等还没有全局 open state，暂用自定义事件 "nowen:open-search" /
 *     "nowen:open-settings"，后续由对应组件订阅。
 *   - "键盘快捷键" 由全局 ShortcutHelpCenter 订阅 "nowen:open-shortcut-help"。
 *   - "切换侧边栏" 直接调 store actions。
 */
import { useEffect } from "react";
import {
  onMenuAction,
  onFormatMenu,
  onOpenFile,
  type OpenFilePayload,
  type FormatMenuPayload,
} from "@/lib/desktopBridge";

export interface DesktopMenuBridgeOptions {
  onNewNote?: () => void;
  onOpenSearch?: () => void;
  onOpenSettings?: () => void;
  onToggleSidebar?: () => void;
  onFocusNoteList?: () => void;
  onOpenFile?: (file: OpenFilePayload) => void;
  /** 格式菜单（macOS 格式菜单 / 快捷键）。若未提供则派发 window 事件 "nowen:format"。 */
  onFormat?: (payload: FormatMenuPayload) => void;
}

export function useDesktopMenuBridge(opts: DesktopMenuBridgeOptions) {
  useEffect(() => {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      onMenuAction("menu:new-note", () => {
        if (opts.onNewNote) opts.onNewNote();
        else window.dispatchEvent(new CustomEvent("nowen:new-note"));
      })
    );
    // Dock 右键快捷入口（macOS）：复用同一 handler，保持行为统一
    unsubs.push(
      onMenuAction("dock:new-note", () => {
        if (opts.onNewNote) opts.onNewNote();
        else window.dispatchEvent(new CustomEvent("nowen:new-note"));
      })
    );
    unsubs.push(
      onMenuAction("menu:search", () => {
        if (opts.onOpenSearch) opts.onOpenSearch();
        else window.dispatchEvent(new CustomEvent("nowen:open-search"));
      })
    );
    unsubs.push(
      onMenuAction("dock:search", () => {
        if (opts.onOpenSearch) opts.onOpenSearch();
        else window.dispatchEvent(new CustomEvent("nowen:open-search"));
      })
    );
    unsubs.push(
      onMenuAction("menu:open-settings", () => {
        if (opts.onOpenSettings) opts.onOpenSettings();
        else window.dispatchEvent(new CustomEvent("nowen:open-settings"));
      })
    );
    unsubs.push(
      onMenuAction("menu:open-shortcuts", () => {
        window.dispatchEvent(new CustomEvent("nowen:open-shortcut-help"));
      })
    );
    unsubs.push(
      onMenuAction("menu:toggle-sidebar", () => {
        if (opts.onToggleSidebar) opts.onToggleSidebar();
        else window.dispatchEvent(new CustomEvent("nowen:toggle-sidebar"));
      })
    );
    unsubs.push(
      onMenuAction("menu:focus-note-list", () => {
        if (opts.onFocusNoteList) opts.onFocusNoteList();
        else window.dispatchEvent(new CustomEvent("nowen:focus-note-list"));
      })
    );
    // 格式菜单（加粗/斜体/标题等）：payload 由 Electron 菜单 click 时发出
    unsubs.push(
      onFormatMenu((payload) => {
        if (opts.onFormat) opts.onFormat(payload);
        else
          window.dispatchEvent(
            new CustomEvent<FormatMenuPayload>("nowen:format", { detail: payload })
          );
      })
    );
    // 文件关联：双击 .md 把文件内容透传进来
    unsubs.push(
      onOpenFile((file) => {
        if (opts.onOpenFile) opts.onOpenFile(file);
        else
          window.dispatchEvent(
            new CustomEvent<OpenFilePayload>("nowen:open-file", { detail: file })
          );
      })
    );

    return () => {
      for (const u of unsubs) u();
    };
    // 依赖 opts 的各回调，按引用变化重新订阅
  }, [
    opts.onNewNote,
    opts.onOpenSearch,
    opts.onOpenSettings,
    opts.onToggleSidebar,
    opts.onFocusNoteList,
    opts.onOpenFile,
    opts.onFormat,
  ]);
}
