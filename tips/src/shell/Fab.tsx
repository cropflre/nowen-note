/**
 * 悬浮新建按钮（Floating Action Button）
 *
 * 每个主视图都带一个**语境化**的新建入口：
 *   笔记本列表 → 新建笔记（先选笔记本）
 *   笔记列表   → 新建笔记（直接建在当前笔记本）
 *   日记说说   → 写说说
 *   待办       → 新建待办
 *
 * 位置上浮在底部导航之上，不遮挡内容（内容区已留了底部 padding）。
 * 用「图标 + 文字」的胶囊而不是纯圆形：首次使用时能一眼看懂是干什么的。
 */
export function Fab({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="fab glass" onClick={onClick} aria-label={label}>
      <span className="fab-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="fab-label">{label}</span>
    </button>
  );
}
