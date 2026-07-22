/**
 * EditorErrorBoundary —— 把编辑器（Tiptap / Markdown / HtmlPreview）的渲染期
 * 异常拦在 React 树之外，避免一篇脏笔记把整个应用打挂。
 *
 * 触发场景（已知）：
 *   - 历史导入路径写入了 schema 不合法的 Tiptap JSON，setContent 不立刻报错，
 *     但任何后续 transaction 走到 `Node.contentMatchAt` 都会抛
 *     "Called contentMatchAt on a node with invalid content"；
 *   - 旧 Android WebView 缺少依赖使用的运行时 API；
 *   - 此前没有 boundary，错误冒到 React root，整个页面变白屏。
 *
 * 行为：
 *   - 捕获后展示一个最小的"加载失败 + 重试"卡片；
 *   - resetKey 变化时自动重置（用 activeNote.id 作 key，切笔记自动重置）；
 *   - 把 error 与诊断窗口对象一起暴露到 console，方便排查。
 */
import { Component, type ReactNode } from "react";

interface Props {
  /** 切换它会让 boundary 自动重置；通常传 activeNote.id */
  resetKey?: string | number | null;
  children: ReactNode;
  /** 可选：自定义 fallback 渲染；默认是一个简单卡片 */
  fallback?: (err: Error, retry: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

export interface EditorErrorPresentation {
  description: string;
  hint: ReactNode;
}

const RUNTIME_COMPATIBILITY_ERROR_RE = /(?:\.findLast(?:Index)?\s+is not a function|\.(?:toSorted|toReversed)\s+is not a function)/i;

export function getEditorErrorPresentation(error: Error): EditorErrorPresentation {
  if (RUNTIME_COMPATIBILITY_ERROR_RE.test(error.message)) {
    return {
      description: "当前 Android WebView 版本过旧，编辑器缺少必要的运行时能力。请升级 APP；如已是最新版，可临时更新 Android System WebView 或 Chrome。",
      hint: "这是运行环境兼容问题，不代表笔记正文损坏，应用不会自动修改或修复这篇笔记。",
    };
  }

  return {
    description: "这篇笔记的内容结构异常，无法正常渲染。",
    hint: (
      <>
        提示：可在浏览器控制台输入 <code className="font-mono">window.__lastDirtyDoc</code> 查看原始脏 JSON。
      </>
    ),
  };
}

export class EditorErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: any) {
    // 这里只打日志，不上报；正式监控可以后续接入
    console.error("[EditorErrorBoundary] caught:", error, info);
    // 把脏 doc 也提示一下，便于 console 里直接 inspect
    try {
      const dirty = (window as any).__lastDirtyDoc;
      if (dirty) {
        console.error(
          "[EditorErrorBoundary] window.__lastDirtyDoc 存在 —— 可在 console 直接查看脏 JSON",
        );
      }
    } catch { /* ignore */ }
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      // 切笔记 / 外部强制重置 → 清错重新挂载
      this.setState({ error: null });
    }
  }

  retry = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.retry);

    const presentation = getEditorErrorPresentation(error);

    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center">
        <div className="max-w-md">
          <div className="w-12 h-12 mx-auto rounded-full bg-red-500/10 flex items-center justify-center mb-3">
            <span className="text-red-500 text-xl">!</span>
          </div>
          <h3 className="text-base font-semibold text-tx-primary mb-2">
            编辑器加载失败
          </h3>
          <p className="text-sm text-tx-secondary mb-4 break-words">
            {presentation.description}
            <br />
            <span className="text-xs text-tx-tertiary font-mono mt-1 block">
              {error.message}
            </span>
          </p>
          <div className="flex gap-2 justify-center">
            <button
              onClick={this.retry}
              className="px-3 py-1.5 text-sm rounded-md bg-accent-primary text-white hover:opacity-90 transition-opacity"
            >
              重试
            </button>
          </div>
          <p className="text-xs text-tx-tertiary mt-3">
            {presentation.hint}
          </p>
        </div>
      </div>
    );
  }
}

export default EditorErrorBoundary;
