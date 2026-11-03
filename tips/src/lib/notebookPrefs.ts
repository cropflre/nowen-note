/**
 * 「哪些笔记本出现在笔记流里」的本地偏好。
 *
 * 存的是**隐藏名单**而不是白名单 —— 这样以后新建的笔记本默认就是可见的，
 * 不会出现「新笔记莫名其妙不显示」的困惑。
 *
 * 为什么放 localStorage 而不是服务端：这是**纯客户端的展示偏好**，
 * 不该污染用户设置（主 App 的 user-preferences 会同步到所有设备，
 * 而手机上想隐藏的笔记本，在电脑上未必想隐藏）。
 */
const HIDDEN_KEY = "nowen-lite.hidden-notebooks";

/**
 * 偏好变更事件。
 *
 * ⚠️ 为什么需要它：笔记流与设置页是**同时存在**的两个 tab 页面。
 *    在设置里改了开关后切回笔记流，组件并不会重新挂载（hash 路由复用同一实例），
 *    于是它读到的还是旧的隐藏名单 —— 表现为「改了设置没反应」。
 *    所以写入偏好时广播一次，笔记流订阅后立刻刷新。
 */
const CHANGE_EVENT = "nowen-lite:notebook-prefs-changed";

export function getHiddenNotebookIds(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function setHiddenNotebookIds(ids: string[]): void {
  try {
    if (ids.length === 0) localStorage.removeItem(HIDDEN_KEY);
    else localStorage.setItem(HIDDEN_KEY, JSON.stringify([...new Set(ids)]));
  } catch {
    /* 隐私模式下忽略 */
  }
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  } catch {
    /* ignore */
  }
}

/** 订阅偏好变更；返回取消订阅函数 */
export function subscribeNotebookPrefs(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

export function setNotebookVisible(notebookId: string, visible: boolean): void {
  const hidden = new Set(getHiddenNotebookIds());
  if (visible) hidden.delete(notebookId);
  else hidden.add(notebookId);
  setHiddenNotebookIds([...hidden]);
}

export function isNotebookVisible(notebookId: string): boolean {
  return !getHiddenNotebookIds().includes(notebookId);
}
