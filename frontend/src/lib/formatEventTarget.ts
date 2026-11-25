/**
 * `nowen:format` 是 window 事件，快捷键运行时（ShortcutRuntimeBridge）和桌面端原生格式菜单都会派发。
 * 分屏时可能同时挂着两个可编辑编辑器：焦点在另一个编辑器里时本编辑器不处理，
 * 避免一次快捷键同时改两篇笔记。焦点不在任何编辑器里时（如点原生菜单）保持原有行为。
 */
export function shouldHandleFormatEvent(
  editorRoot: Element | null | undefined,
  active: Element | null = typeof document === "undefined" ? null : document.activeElement,
): boolean {
  if (!editorRoot || !active || active === active.ownerDocument?.body) return true;
  if (editorRoot.contains(active)) return true;
  return !active.closest(".ProseMirror, .cm-editor");
}
