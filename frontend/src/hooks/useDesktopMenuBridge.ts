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
 *   - "切换侧边栏" 直接调 store actions。
 */
import { useEffect } from "react";
import { onMenuAction, onOpenFile, type OpenFilePayload } from "@/lib/desktopBridge";

export interface DesktopMenuBridgeOptions {
  onNewNote?: () => void;
  onOpenSearch?: () => void;
  onOpenSettings?: () => void;
  onToggleSidebar?: () => void;
  onFocusNoteList?: () => void;
  onOpenFile?: (file: OpenFilePayload) => void;
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
    unsubs.push(
      onMenuAction("menu:search", () => {
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
  ]);
}
