/**
 * 极简 hash 路由（约 90 行，替代 react-router）
 *
 * 为什么自己写：Lite 只需要「5 个 tab + 二三级页」这点能力，
 * 引入 react-router（~20KB gzip）不划算。
 *
 * 用 hash 而不是 history：APK（Capacitor）里不需要服务端支持，也少一层状态同步。
 *
 * ⚠️ 结构上是**扁平**的：笔记 tab 直接就是笔记流（#/notes），
 *    没有「笔记本列表」这一层 —— 笔记本的取舍放在「设置 · 笔记展示」。
 */

export type TabId = "notes" | "diary" | "tasks" | "search" | "settings";

export type Route =
  | { name: "notes" }
  | { name: "note"; noteId: string; title: string }
  | { name: "edit"; noteId: string; title: string }
  | { name: "diary" }
  | { name: "tasks" }
  | { name: "search" }
  | { name: "settings" };

/** 路由 → 它属于哪个 tab（底部导航高亮用） */
export function tabOf(route: Route): TabId {
  switch (route.name) {
    case "notes":
    case "note":
    case "edit":
      return "notes";
    default:
      return route.name;
  }
}

const TAB_ROOT: Record<TabId, string> = {
  notes: "#/notes",
  diary: "#/diary",
  tasks: "#/tasks",
  search: "#/search",
  settings: "#/settings",
};

export function tabHref(tab: TabId): string {
  return TAB_ROOT[tab];
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

export function noteHref(noteId: string, title: string): string {
  return `#/note/${enc(noteId)}?t=${enc(title)}`;
}

export function noteEditHref(noteId: string, title: string): string {
  return `#/edit/${enc(noteId)}?t=${enc(title)}`;
}

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = raw.split("?");
  const segments = pathPart.split("/").filter(Boolean);
  const params = new URLSearchParams(queryPart || "");
  const title = params.get("t") || "";

  const [first, second] = segments;

  if (!first) return { name: "notes" };
  if (first === "notes") return { name: "notes" };
  if (first === "note" && second) return { name: "note", noteId: second, title };
  if (first === "edit" && second) return { name: "edit", noteId: second, title };
  if (first === "diary") return { name: "diary" };
  if (first === "tasks") return { name: "tasks" };
  if (first === "search") return { name: "search" };
  if (first === "settings") return { name: "settings" };

  // 旧链接兜底：以前有过 #/notebooks 与 #/notebook/<id>，统一落到笔记流
  return { name: "notes" };
}

/** 当前路由（同步读取，不用 state，避免首帧闪烁） */
export function currentRoute(): Route {
  return parseRoute(window.location.hash);
}

export function navigate(href: string): void {
  if (window.location.hash === href) return;
  window.location.hash = href;
}

export function goBack(fallbackTab: TabId = "notes"): void {
  if (window.history.length > 1) {
    window.history.back();
  } else {
    navigate(tabHref(fallbackTab));
  }
}
