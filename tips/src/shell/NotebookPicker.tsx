/**
 * 笔记本选择器（可搜索）
 *
 * 为什么需要它：真实数据里笔记本可能上百个（实测 166 个，其中 144 个只有 ≤2 篇笔记）。
 * 只列「前 8 个」根本选不到想要的，所以必须有搜索 + 合理的排序。
 *
 * 排序：**笔记数多的在前** —— 常用的笔记本自然浮到顶部。
 * 搜索：匹配名字；同时列出层级缩进，父子关系仍然看得见。
 */
import { useEffect, useMemo, useState } from "react";
import type { FlatNotebook } from "../lib/notebookTree";

export function NotebookPicker({
  open,
  notebooks,
  title = "选择笔记本",
  onPick,
  onDismiss,
}: {
  open: boolean;
  notebooks: FlatNotebook[];
  title?: string;
  onPick: (id: string) => void;
  onDismiss: () => void;
}) {
  const [keyword, setKeyword] = useState("");

  useEffect(() => {
    if (open) setKeyword("");
  }, [open]);

  /** 按笔记数倒序 —— 常用的排前面 */
  const sorted = useMemo(
    () => [...notebooks].sort((a, b) => b.noteCount - a.noteCount || a.name.localeCompare(b.name)),
    [notebooks],
  );

  const shown = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return sorted;
    return sorted.filter((nb) => nb.name.toLowerCase().includes(kw));
  }, [sorted, keyword]);

  if (!open) return null;

  return (
    <div className="picker-backdrop" onClick={onDismiss} role="presentation">
      <div
        className="picker glass"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <div className="picker-head">
          <span className="picker-title">{title}</span>
          <button className="topbar-btn" onClick={onDismiss} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="searchbar glass picker-search">
          <span className="search-icon" aria-hidden="true">
            🔍
          </span>
          <input
            autoFocus
            type="text"
            placeholder={`搜索笔记本（共 ${notebooks.length} 个）`}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          {keyword ? (
            <button className="search-clear" onClick={() => setKeyword("")} aria-label="清空">
              ×
            </button>
          ) : null}
        </div>

        <div className="picker-list">
          {shown.length === 0 ? (
            <div className="empty">没有匹配「{keyword}」的笔记本</div>
          ) : (
            <ul className="list">
              {shown.map((nb) => (
                <li key={nb.id}>
                  <button
                    type="button"
                    className="list-item"
                    onClick={() => onPick(nb.id)}
                    data-testid="picker-item"
                  >
                    <span className="li-icon" style={{ marginLeft: nb.depth * 14 }}>
                      {nb.icon}
                    </span>
                    <span className="li-main">
                      <span className="li-title">{nb.name}</span>
                    </span>
                    <span className="li-sub" style={{ flex: "none" }}>
                      {nb.noteCount} 篇
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
