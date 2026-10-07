/**
 * 搜索框（玻璃材质）—— 笔记列表顶部与全局搜索共用。
 *
 * 受控组件：输入值由父级持有，父级决定是「本地过滤」还是「请求服务端」。
 */
export function SearchBar({
  value,
  onChange,
  placeholder = "搜索",
  autoFocus = false,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="searchbar glass">
      <span className="search-icon" aria-hidden="true">
        🔍
      </span>
      <input
        // 用 text 而不是 search：search 会带一个【浏览器原生】的清除按钮，
        // 和下面自绘的那个 × 叠在一起，手机上看着是两个叉。
        type="text"
        inputMode="search"
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        enterKeyHint="search"
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        aria-label={placeholder}
      />
      {value ? (
        <button
          className="search-clear"
          onClick={() => onChange("")}
          aria-label="清空"
          type="button"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

/** 把命中的关键词包成 <mark>，用于结果列表高亮（返回 React 节点，不拼 HTML 字符串）。 */
export function highlight(text: string, keyword: string): React.ReactNode {
  const kw = keyword.trim();
  if (!kw) return text;
  const parts = text.split(new RegExp(`(${escapeRegExp(kw)})`, "gi"));
  return parts.map((part, i) =>
    part.toLowerCase() === kw.toLowerCase() ? <mark key={i}>{part}</mark> : part,
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
