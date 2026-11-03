/**
 * Mermaid 渲染工具：懒加载 + 主题感知 + 错误兜底。
 *
 * 为什么独立成一个 lib 文件？
 *   - 编辑器内的 `CodeBlockView` 和分享页 `SharedNoteView` 都要调用 mermaid，
 *     行为（懒加载、主题、错误兜底）应当完全一致，避免两边维护两套。
 *   - mermaid 11.x 的 ESM 入口约 700KB+ gzip，必须保证只在确实出现 mermaid
 *     代码块时才动态 import。
 *
 * 关键设计：
 *   - 单例懒加载：第一次调用时 `import("mermaid")` 拉模块，之后复用同一个
 *     已初始化的实例。失败也只重试 1 次，避免每个块都报相同错。
 *   - 主题：根据 `<html>` 上的 dark class（项目里 next-themes 用的就是这个）
 *     选 `default` / `dark`，让 mermaid 自身配色跟随应用主题。
 *   - 渲染 ID：每次给一个递增的字符串 id，因为 mermaid 内部用 id 去拼 svg
 *     的 dom，重复 id 会导致 svg 串图。
 *   - 错误返回：把异常信息序列化进返回结构里，调用方可自行选择展示一条红条
 *     而不是整页崩。
 */

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
let initialized = false;
let renderSeq = 0;

/** 检测当前是否处于深色模式（与 next-themes / ThemeProvider 一致） */
function isDarkMode(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

/**
 * 懒加载 mermaid 模块。多次调用复用同一 Promise。
 * - 首次失败：清掉 promise 以便下次重试
 * - 主题切换：通过监听 nowen 主题事件主动重新 initialize
 */
async function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = (async () => {
      try {
        const mod = await import("mermaid");
        return mod.default;
      } catch (e) {
        // 加载失败：清掉 promise 以便下次重试
        mermaidPromise = null;
        throw e;
      }
    })();
  }
  const m = await mermaidPromise;
  if (!initialized) {
    m.initialize({
      startOnLoad: false,
      // suppressErrorRendering 让 parse 错误以 Promise reject 形式抛出，
      // 避免 mermaid 自己在 dom 里塞红色错误 svg（我们要自己控制错误 UI）
      suppressErrorRendering: true,
      securityLevel: "strict",
      // DOMPurify 的 SVG profile 会安全地移除 foreignObject；禁用 HTML 标签，
      // 让 Mermaid 使用原生 SVG text，避免节点外框保留而文字被清空。
      htmlLabels: false,
      theme: isDarkMode() ? "dark" : "default",
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    });
    initialized = true;
  }
  return m;
}

/**
 * 主题切换时重置 mermaid 配置。
 * 由 ThemeProvider 一类的入口在主题变更时主动调用，下一次渲染就会用新主题。
 */
export function resetMermaidTheme() {
  initialized = false;
}

export interface MermaidRenderResult {
  /** 渲染成功时的 svg 字符串；失败时为空 */
  svg: string;
  /** 失败的人类可读消息；成功时为空 */
  error: string;
}

/** Render-only compatibility for common flowchart input; never rewrite note source. */
function compatibleFlowchartSource(source: string): string {
  // Node text (including multiline labels) and native comments must remain literal.
  const code = source.replace(/"[^"]*"|%%[^\n]*|\[[^\]]*\]|\{[^}]*\}|\([^)]*\)|^[\t ]*\/\/[^\n]*/gm, (token) =>
    token.trimStart().startsWith("//") ? "" : token,
  );
  if (!/^(?:\s|%%[^\n]*\n)*(?:flowchart|graph)\b/.test(code)) return source;

  const shapeEnds: Record<string, readonly string[]> = {
    "[": ["]"], "{": ["}"], "[[": ["]]"], "{{": ["}}"],
    "[(": [")]"], "[/": ["/]", "\\]"], "[\\": ["\\]", "/]"],
  };
  return code.replace(
    /"[^"]*"|%%[^\n]*|@\{[^}]*\}|([\p{L}\p{N}_-]+)(\[\[|\[\(|\[\/|\[\\|\{\{|\[|\{)([^"[\]{}\n]*)(\]\]|\)\]|\/\]|\\\]|\}\}|\]|\})/gu,
    (token, id: string | undefined, open: string, label: string, close: string) => {
      if (!id) return token;
      // Resolve the closing delimiter from the opening shape, not label punctuation.
      const tail = label + close;
      const end = shapeEnds[open]?.find((candidate) => tail.endsWith(candidate));
      if (!end) return token;
      const text = tail.slice(0, -end.length);
      if (!/[()]/.test(text)) return token;
      return `${id}${open}"${text}"${end}`;
    },
  );
}

/**
 * 把一段 mermaid 源码渲染为 SVG 字符串。
 *
 * 设计要点：
 *   - 不直接挂到调用方的 dom，调用方决定怎么放 svg（dangerouslySetInnerHTML
 *     或 ref.innerHTML）；
 *   - 渲染 id 内部生成、单调递增，调用方不需关心；
 *   - 解析失败、空内容、未加载等异常一律以 `{ error }` 形式返回，调用方决定
 *     展示错误条 / 回退源码 / 静默。
 */
export async function renderMermaid(source: string): Promise<MermaidRenderResult> {
  const code = (source || "").trim();
  if (!code) return { svg: "", error: "" };
  try {
    const mermaid = await loadMermaid();
    // mermaid.render 在 v10+ 返回 { svg, bindFunctions? }
    let svg: string;
    try {
      ({ svg } = await mermaid.render(`mermaid-svg-${++renderSeq}`, code));
    } catch (error) {
      const compatible = compatibleFlowchartSource(code);
      if (compatible === code) throw error;
      ({ svg } = await mermaid.render(`mermaid-svg-${++renderSeq}`, compatible));
    }
    return { svg, error: "" };
  } catch (e: any) {
    // mermaid 抛出来的错误对象可能是 Error，也可能是 { str } 这种自定义结构
    const msg =
      (e && (e.message || e.str || e.toString?.())) ||
      "Mermaid 渲染失败";
    return { svg: "", error: String(msg) };
  }
}

/**
 * 判断一个语言标识是不是 mermaid。
 * 兼容大小写以及 `mmd` 这种部分编辑器的写法。
 */
export function isMermaidLang(lang: string | null | undefined): boolean {
  if (!lang) return false;
  const v = lang.trim().toLowerCase();
  return v === "mermaid" || v === "mmd";
}
