// Format detection must stay independent of editor schemas and converters.
export type ContentFormat = "md" | "tiptap-json" | "html" | "empty";

/**
 * 启发式判断内容格式：
 * - 空串 / "{}" -> empty
 * - 形如 `{"type":"doc"...}` 或 `{"type":"..."}` -> tiptap-json
 * - 以 `<` 开头 + 含标签特征 -> html（历史少见，但 parseContent 里有兼容分支）
 * - 其他 -> md
 *
 * 这里做得比较保守：只有明确识别出 JSON 对象才认定为 tiptap-json，
 * 防止把以 `{` 开头的 MD 内容（极少见）误判。
 */
export function detectFormat(content: string | null | undefined): ContentFormat {
  if (content == null) return "empty";
  // 统一先剥掉首尾空白 + 零宽字符（常见于复制粘贴源污染）
  const trimmed = content.replace(/^[\s\uFEFF\u200B\u200C\u200D]+|[\s\uFEFF\u200B\u200C\u200D]+$/g, "");
  if (!trimmed || trimmed === "{}" || trimmed === "[]") return "empty";

  // Tiptap 以 `{` 开头。为减少误判，要求合法 JSON 对象且**明确含 Tiptap 文档特征**。
  // （`Array.isArray(parsed.content)` 单独一条不够严格——改为 type==="doc" OR
  // 顶层有 `type` 字段且含 `content` 数组。）
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const looksLikeTiptap =
          parsed.type === "doc" ||
          (typeof parsed.type === "string" && Array.isArray(parsed.content));
        if (looksLikeTiptap) return "tiptap-json";
      }
    } catch {
      /* 不是合法 JSON，往下当 md（例如 "{foo} 这段代码..." 这种 MD 内容） */
    }
  }

  // HTML 特征检测：
  //   1. 完整 HTML 文档：以 `<!DOCTYPE` 或 `<html` 开头（来自 clipper 完全克隆模式）
  //      注意：早期版本可能在文档前面拼了 HTML 注释（<!-- clipper-xxx -->），
  //      需要先跳过这些注释再检测。
  //   2. HTML 片段：以 `<tagname` 开头，且整体必须看起来像一个标签
  //      正确：<p>…   <div class="x">…   <br/>
  //      错误：<3 i love md   <= 5 items   < space

  // 跳过开头的 HTML 注释后再做 <!DOCTYPE / <html 检测
  const stripped = trimmed.replace(/^(\s*<!--[\s\S]*?-->\s*)+/, "");
  const lower = stripped.slice(0, 20).toLowerCase();
  if (lower.startsWith("<!doctype") || lower.startsWith("<html")) {
    return "html";
  }
  // 也检查原始内容（以 <!-- 开头且后续含 <!DOCTYPE 也算 HTML）
  if (trimmed.startsWith("<!--") && (lower.startsWith("<!doctype") || lower.startsWith("<html"))) {
    return "html";
  }
  if (trimmed.startsWith("<") && /^<[A-Za-z][A-Za-z0-9-]*(\s|\/|>)/.test(trimmed) && /<[A-Za-z][^<>]*>|<\/[A-Za-z][^<>]*>/.test(trimmed)) {
    return "html";
  }

  return "md";
}
