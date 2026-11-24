/**
 * 退出安装整包更新或重启应用热更新之前，让编辑器立即保存：广播 nowen:before-desktop-update，
 * 对焦点元素和编辑器触发 Ctrl/Cmd+S，再让焦点离开。调用方随后要等一小段时间再退出。
 */
export function runEditorSafetyFlush(reason = "desktop-update-install"): void {
  window.dispatchEvent(new CustomEvent("nowen:before-desktop-update", {
    detail: { reason },
  }));

  const eventInit: KeyboardEventInit = {
    key: "s",
    code: "KeyS",
    bubbles: true,
    cancelable: true,
    ctrlKey: !navigator.platform.toLowerCase().includes("mac"),
    metaKey: navigator.platform.toLowerCase().includes("mac"),
  };
  const targets = new Set<EventTarget>();
  if (document.activeElement) targets.add(document.activeElement);
  document.querySelectorAll<HTMLElement>(
    '.ProseMirror[contenteditable="true"], .cm-content[contenteditable="true"]',
  ).forEach((element) => targets.add(element));
  targets.forEach((target) => target.dispatchEvent(new KeyboardEvent("keydown", eventInit)));
  (document.activeElement as HTMLElement | null)?.blur?.();
}
