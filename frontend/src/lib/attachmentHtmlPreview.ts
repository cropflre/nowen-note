const REMOVED_TAGS = [
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "base",
].join(",");

const URL_ATTRS = new Set([
  "href",
  "src",
  "xlink:href",
  "action",
  "formaction",
  "poster",
]);

const CSP_META_CONTENT = "script-src 'none'; object-src 'none'; base-uri 'none';";

function isDangerousUrl(raw: string): boolean {
  // 去除 ASCII 空白与控制字符，防止 `java\nscript:` 等绕过。
  // eslint-disable-next-line no-control-regex -- URL 预览协议检查必须过滤这些字符。
  const normalized = raw.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
  return (
    normalized.startsWith("javascript:") ||
    normalized.startsWith("vbscript:") ||
    normalized.startsWith("data:text/html") ||
    normalized.startsWith("data:application/xhtml+xml")
  );
}

function isExternalLink(href: string): boolean {
  const trimmed = href.trim().toLowerCase();
  return trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("mailto:");
}

/**
 * 为附件 HTML 预览生成隔离的 `srcDoc` 文档。
 *
 * 与 `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox">` 配合使用：
 * 保留 `<style>` 与完整排版，同时剥离脚本、内联事件与危险协议作为纵深防御。
 */
export function sanitizeAttachmentHtmlForPreview(rawHtml: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(rawHtml, "text/html");

  for (const el of Array.from(doc.querySelectorAll(REMOVED_TAGS))) {
    el.remove();
  }

  for (const meta of Array.from(doc.querySelectorAll("meta[http-equiv]"))) {
    const equiv = (meta.getAttribute("http-equiv") || "").trim().toLowerCase();
    if (equiv === "refresh" || equiv === "content-security-policy") {
      meta.remove();
    }
  }

  for (const el of Array.from(doc.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc") {
        el.removeAttribute(attr.name);
        continue;
      }
      if (URL_ATTRS.has(name) && isDangerousUrl(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }

    if (el.tagName === "A") {
      const href = el.getAttribute("href");
      if (href && isExternalLink(href)) {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
    }
  }

  const head = doc.head || doc.documentElement.insertBefore(doc.createElement("head"), doc.body);
  const cspMeta = doc.createElement("meta");
  cspMeta.setAttribute("http-equiv", "Content-Security-Policy");
  cspMeta.setAttribute("content", CSP_META_CONTENT);
  head.insertBefore(cspMeta, head.firstChild);

  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}
