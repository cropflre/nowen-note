import { common, createLowlight } from "lowlight";

const sharedLowlight = createLowlight(common);

/**
 * 使用 lowlight 对代码做语法高亮，返回可直接插入 <code> 的 HTML 字符串
 * - 已知语言：highlight(lang, code)
 * - auto 或未注册语言：highlightAuto(code)
 * - 失败时回退为转义后的纯文本
 */
export function highlightSharedCode(code: string, lang: string): string {
  if (!code) return "";
  try {
    let tree: any;
    if (lang && lang !== "auto" && sharedLowlight.registered(lang)) {
      tree = sharedLowlight.highlight(lang, code);
    } else {
      tree = sharedLowlight.highlightAuto(code);
    }
    return hastToHtml(tree);
  } catch {
    return escapeHtml(code);
  }
}

/**
 * 极简 hast → HTML 序列化器，只处理 lowlight 会产出的三种节点：
 *   - root：仅渲染 children
 *   - element：标签名 + className + children（lowlight 不产出其他属性）
 *   - text：转义后输出
 */
function hastToHtml(node: any): string {
  if (!node) return "";
  if (node.type === "root") {
    return (node.children || []).map(hastToHtml).join("");
  }
  if (node.type === "text") {
    return escapeHtml(node.value || "");
  }
  if (node.type === "element") {
    const tag = String(node.tagName || "span");
    const classList = node.properties && Array.isArray(node.properties.className)
      ? node.properties.className.join(" ")
      : "";
    const classAttr = classList ? ` class="${escapeHtml(classList)}"` : "";
    const inner = (node.children || []).map(hastToHtml).join("");
    return `<${tag}${classAttr}>${inner}</${tag}>`;
  }
  return "";
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
