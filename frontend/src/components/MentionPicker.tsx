/**
 * @提及用户选择器
 *
 * 用于编辑器（textarea / input）中检测 @ 输入，弹出用户搜索下拉。
 * 支持键盘导航、结果选中后自动插入 @username。
 *
 * 用法：
 *   const [mentionState, setMentionState] = useState<MentionState | null>(null);
 *   // 在 onInput/onChange 中检测 @：
 *   //   1. parseMentionTrigger(value, cursorPos) → MentionState | null
 *   //   2. 有结果则 render <MentionPicker ... />
 *   //   3. 选中后 replaceMentionText(value, state, "@username ") → 新 text
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "@/lib/api";
import type { UserPublicInfo } from "@/types";

// ---------------------------------------------------------------------------
// 公共工具函数
// ---------------------------------------------------------------------------

/** 从输入值 + 光标位置检测是否触发 @ 选择 */
export function parseMentionTrigger(
  value: string,
  cursorPos: number,
): { search: string; startIndex: number } | null {
  // 取光标前的文本
  const beforeCursor = value.slice(0, cursorPos);
  // 找最后一个 @ 符号的位置（从末尾往前找）
  const atIndex = beforeCursor.lastIndexOf("@");
  if (atIndex === -1) return null;

  // @ 前面不能是字母或中文（避免匹配邮箱等）
  if (atIndex > 0) {
    const charBefore = beforeCursor[atIndex - 1];
    if (/[\w一-鿿]/.test(charBefore)) return null;
  }

  const search = beforeCursor.slice(atIndex + 1);
  // 如果搜索词包含空格或过长，说明不是正在输入 @提及
  if (search.includes(" ") || search.length > 30) return null;

  return { search, startIndex: atIndex };
}

/** 在输入值中替换 @提及文本为选中的 @username */
export function replaceMentionText(
  value: string,
  cursorPos: number,
  startIndex: number,
  username: string,
): string {
  const before = value.slice(0, startIndex);
  const after = value.slice(cursorPos);
  return `${before}@${username} ${after}`;
}

// ---------------------------------------------------------------------------
// 选择器组件
// ---------------------------------------------------------------------------

interface MentionPickerProps {
  /** 当前搜索关键词（@ 后面的文字） */
  search: string;
  /** 弹出层定位参考元素（通常是与输入框对齐的容器） */
  anchorRect?: DOMRect | null;
  /** 选中用户 */
  onSelect: (user: UserPublicInfo) => void;
  /** 关闭下拉 */
  onClose: () => void;
}

interface SearchResult extends UserPublicInfo {
  _score?: number;
}

export default function MentionPicker({
  search,
  anchorRect,
  onSelect,
  onClose,
}: MentionPickerProps) {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // 搜索用户
  useEffect(() => {
    setLoading(true);
    api
      .searchUsers(search)
      .then((users) => {
        setResults(users || []);
        setHighlighted(0);
      })
      .catch(() => setResults([]))
      .finally(() => setLoading(false));
  }, [search]);

  // 键盘导航（由父组件通过 ref 调用）
  // 键盘监听（拦截上下键、回车、Esc，避免输入框换行或光标移动）
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (results.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setHighlighted((p) => Math.min(p + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setHighlighted((p) => Math.max(p - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        if (results[highlighted]) {
          onSelect(results[highlighted]);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    // 使用 capture 阶段拦截，确保在 input/textarea 默认行为之前拦截
    document.addEventListener("keydown", handleGlobalKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleGlobalKeyDown, true);
    };
  }, [results, highlighted, onSelect, onClose]);

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // 延迟绑定，避免当前点击触发表单元素冒泡
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  if (results.length === 0 && !loading) return null;

  // 定位
  const style: React.CSSProperties = {};
  if (anchorRect) {
    style.position = "absolute";
    style.left = Math.min(anchorRect.left, window.innerWidth - 260) + "px";
    style.top = anchorRect.bottom + 4 + "px";
    style.zIndex = 1000;
  }

  return (
    <div
      ref={containerRef}
      className={`fixed z-[1000] w-56 max-h-44 overflow-y-auto bg-app-elevated border border-app-border rounded-lg shadow-xl ${
        !anchorRect ? "relative" : ""
      }`}
      style={!anchorRect ? {} : style}
    >
      {loading && (
        <div className="px-3 py-2 text-xs text-tx-tertiary text-center">搜索中...</div>
      )}
      {results.map((user, i) => (
        <button
          key={user.id}
          onClick={() => onSelect(user)}
          className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 ${
            i === highlighted
              ? "bg-accent-primary/10 text-accent-primary"
              : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
          }`}
        >
          <div className="w-5 h-5 rounded-full bg-app-hover flex items-center justify-center text-[9px] font-medium text-tx-tertiary overflow-hidden shrink-0">
            {user.avatarUrl ? (
              <img src={user.avatarUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              user.displayName?.[0] || user.username[0]
            )}
          </div>
          <span className="flex-1 truncate">
            {user.displayName || user.username}
          </span>
          {user.displayName && (
            <span className="text-[10px] text-tx-tertiary truncate max-w-[60px]">
              @{user.username}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * Hook: 在 textarea/input 中管理 @提及状态
 *
 * 用法：
 *   const mention = useMentionState(value, cursorPos);
 *   // 在 JSX 中：
 *   {mention && (
 *     <MentionPicker
 *       search={mention.search}
 *       onSelect={(user) => { setValue(replaceMentionText(value, cursorPos, mention.startIndex, user.username)); }}
 *       onClose={() => mention.clear()}
 *     />
 *   )}
 */
export function useMentionState(value: string, cursorPos: number) {
  const [mention, setMention] = useState<{
    search: string;
    startIndex: number;
  } | null>(null);

  // 每次输入时重新检测
  useEffect(() => {
    const result = parseMentionTrigger(value, cursorPos);
    if (result) {
      setMention(result);
    } else if (mention) {
      // 只在确定不再触发时关闭（避免闪烁）
      const lastAt = value.slice(0, cursorPos).lastIndexOf("@");
      if (lastAt === -1 || cursorPos <= lastAt) {
        setMention(null);
      }
    }
  }, [value, cursorPos]); // eslint-disable-line react-hooks/exhaustive-deps

  const clear = useCallback(() => setMention(null), []);

  return mention ? { ...mention, clear } : null;
}
