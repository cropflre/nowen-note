/**
 * 笔记流的两个视图偏好（**纯客户端展示偏好**，存 localStorage）。
 *
 * 为什么不做在服务端：主 App 的 user-preferences 会同步到所有设备，
 * 而「手机上想按文件夹看、电脑上想按时间线看」是完全合理的诉求。
 * 这和 notebookPrefs.ts 的隐藏名单是同一个判断。
 *
 * 两种模式的语义：
 *   flat    —— 仅看笔记：全部笔记按时间倒序平铺（置顶在前），不看笔记本层级
 *   folders —— 文件夹排布：按笔记本层级分组，**只显示文件夹、不列笔记**，可展开折叠
 */
const VIEW_KEY = "nowen-lite.notes-view";
/**
 * 存**展开名单**（记的都是例外），所以**默认全部收起**。
 *
 * 为什么和隐藏名单反过来存：文件夹视图里展开一个文件夹只出**子文件夹**、
 * 不出笔记（笔记去「仅看笔记」），所以「默认全展开」会让上百个文件夹铺满屏幕；
 * 默认收起反而是更合理的初始态。
 *
 * 键名换成了 expanded（旧键 collapsed-notebooks 已废弃）——
 * 语义翻转后沿用旧键会把「上次折起的」误解成「要展开的」。
 */
const EXPANDED_KEY = "nowen-lite.expanded-notebooks";

export type NotesViewMode = "flat" | "folders";

export const DEFAULT_NOTES_VIEW: NotesViewMode = "flat";

export function getNotesViewMode(): NotesViewMode {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    return raw === "folders" ? "folders" : DEFAULT_NOTES_VIEW;
  } catch {
    return DEFAULT_NOTES_VIEW;
  }
}

export function setNotesViewMode(mode: NotesViewMode): void {
  try {
    localStorage.setItem(VIEW_KEY, mode);
  } catch {
    /* 隐私模式下忽略：不退化成崩溃，只是不记住 */
  }
}

export function getExpandedNotebookIds(): string[] {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function setExpandedNotebookIds(ids: string[]): void {
  try {
    if (ids.length === 0) localStorage.removeItem(EXPANDED_KEY);
    else localStorage.setItem(EXPANDED_KEY, JSON.stringify([...new Set(ids)]));
  } catch {
    /* 同上 */
  }
}

export function toggleNotebookExpanded(id: string): string[] {
  const next = new Set(getExpandedNotebookIds());
  if (next.has(id)) next.delete(id);
  else next.add(id);
  const list = [...next];
  setExpandedNotebookIds(list);
  return list;
}
