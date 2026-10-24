/**
 * 底部悬浮导航（液态玻璃胶囊）
 *
 * 设计要点：
 *   - 整条 nav 是 `position: fixed` 的圆角胶囊，浮在内容之上（glass 材质）
 *   - 选中态是一个**会滑动**的胶囊（只动 transform，保证 60fps）
 *   - 用 <a href="#/..."> 而不是 JS 跳转：让浏览器天然产生历史记录，
 *     系统返回键能回到上一个 tab（满足「切回来保持位置」）
 */
import { tabHref, tabOf, type Route, type TabId } from "../lib/router";
import { useI18n } from "../lib/i18n";

// label 存 i18n key，渲染时再取 —— 语言一变导航跟着变
const TABS: Array<{ id: TabId; labelKey: string; icon: string }> = [
  { id: "notes", labelKey: "nav.notes", icon: "📝" },
  { id: "diary", labelKey: "nav.diary", icon: "📔" },
  { id: "tasks", labelKey: "nav.tasks", icon: "✅" },
  { id: "search", labelKey: "nav.search", icon: "🔍" },
  { id: "settings", labelKey: "nav.settings", icon: "⚙️" },
];

export function BottomNav({ route }: { route: Route }) {
  const { t } = useI18n();
  const active = tabOf(route);
  const activeIndex = Math.max(
    0,
    TABS.findIndex((t) => t.id === active),
  );

  return (
    <nav
      className="bottom-nav glass"
      style={{ ["--nav-count" as string]: String(TABS.length) }}
    >
      <span
        className="nav-pill"
        style={{ transform: `translateX(${activeIndex * 100}%)` }}
        aria-hidden="true"
      />
      {TABS.map((tab) => (
        <a key={tab.id} href={tabHref(tab.id)} data-active={active === tab.id}>
          <span className="nav-icon">{tab.icon}</span>
          <span>{t(tab.labelKey)}</span>
        </a>
      ))}
    </nav>
  );
}
