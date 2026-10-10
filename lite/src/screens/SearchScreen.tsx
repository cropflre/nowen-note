/**
 * 全局搜索（服务端 FTS5 全文检索）
 *
 * 与「笔记列表里的搜索框」的分工：
 *   - 笔记列表顶部那个 = **本地过滤**当前笔记本（零延迟）
 *   - 这个 = **跨全部笔记本**的服务端全文检索（能搜正文，代价是走网络）
 *
 * 防抖 300ms：手机上打字很快，每次都发请求既慢又浪费。
 * 用请求序号（seq）而不是 AbortController 来丢弃过期响应 —— 代码更短，
 * 且不用担心 abort 抛出的异常被当成错误显示出来。
 */
import { useEffect, useRef, useState } from "react";
import { getClient } from "../api/client";
import { noteHref } from "../lib/router";
import { SearchBar, highlight } from "../shell/SearchBar";
import { TopBar } from "../App";
import type { SearchResult } from "../../sdk/types";

const DEBOUNCE_MS = 300;

export function SearchScreen() {
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const q = keyword.trim();
    if (!q) {
      setResults(null);
      setError(null);
      setBusy(false);
      return;
    }

    setBusy(true);
    const mySeq = ++seq.current;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const list = await getClient().search(q);
          if (mySeq !== seq.current) return; // 已有更新的请求发出，丢弃这次结果
          setResults(list as SearchResult[]);
          setError(null);
        } catch (err) {
          if (mySeq !== seq.current) return;
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          if (mySeq === seq.current) setBusy(false);
        }
      })();
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [keyword]);

  // Lite 只管笔记；服务端还会返回思维导图/表格，这里如实告知但不做入口
  const notes = results?.filter((r) => !r.resourceType || r.resourceType === "note") ?? null;
  const others = (results?.length ?? 0) - (notes?.length ?? 0);

  return (
    <>
      <TopBar title="全局搜索" />
      <div className="app-content">
        <SearchBar
          value={keyword}
          onChange={setKeyword}
          placeholder="搜索全部笔记"
          autoFocus
        />

        {error ? <div className="notice">{error}</div> : null}

        {!keyword.trim() ? (
          <div className="empty">
            输入关键词，跨全部笔记本搜索
            <br />
            <span style={{ fontSize: 12 }}>标题与正文都会被检索</span>
          </div>
        ) : null}

        {keyword.trim() && busy && !results ? <div className="loading">搜索中…</div> : null}

        {notes && notes.length === 0 && !busy ? (
          <div className="empty">没有找到「{keyword}」相关的笔记</div>
        ) : null}

        {notes && notes.length > 0 ? (
          <>
            <div className="section-title">
              {notes.length} 条结果
              {others > 0 ? `（另有 ${others} 条来自思维导图/表格，Lite 暂不展示）` : ""}
            </div>
            <div className="card glass">
              <ul className="list">
                {notes.map((r) => (
                  <li key={`${r.resourceType ?? "note"}-${r.id}`}>
                    <a className="list-item" href={noteHref(r.id, r.title || "无标题")}>
                      <span className="li-main">
                        <span className="li-title">
                          {highlight(r.title || "无标题", keyword)}
                        </span>
                        <span className="li-sub">
                          {highlight((r.snippet || "").replace(/\s+/g, " ").trim(), keyword)}
                        </span>
                      </span>
                      <span className="li-chevron">›</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}
