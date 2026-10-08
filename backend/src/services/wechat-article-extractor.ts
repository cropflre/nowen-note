function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

export function isWeixinVerificationPage(html: string, url: string): boolean {
  return new URL(url).pathname === "/mp/wappoc_appmsgcaptcha"
    || /<[^>]+\bid=["']js_verify["'][^>]*>/i.test(html);
}

export function extractWeixinTitle(html: string): string {
  const m = html.match(/<h[12][^>]*id=["']activity-name["'][^>]*>([\s\S]*?)<\/h[12]>/i);
  if (m && m[1]) return stripTags(m[1]) || "未命名文章";
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t && t[1]) return stripTags(t[1]) || "未命名文章";
  return "未命名文章";
}

export function extractWeixinAuthor(html: string): string | undefined {
  const m = html.match(/<a[^>]*id=["']js_name["'][^>]*>([\s\S]*?)<\/a>/i);
  if (m && m[1]) {
    const v = stripTags(m[1]);
    return v || undefined;
  }
  return undefined;
}

export function extractWeixinPublishDate(html: string): string | undefined {
  // 新版微信：<em id="publish_time">；老版本：var ct = "1700000000"
  const m = html.match(/<em[^>]*id=["']publish_time["'][^>]*>([\s\S]*?)<\/em>/i);
  if (m && m[1]) {
    const v = stripTags(m[1]);
    if (v) return v;
  }
  const ct = html.match(/var\s+ct\s*=\s*["'](\d+)["']/);
  if (ct && ct[1]) {
    const sec = parseInt(ct[1], 10);
    if (!isNaN(sec)) return new Date(sec * 1000).toISOString().slice(0, 10);
  }
  return undefined;
}

/**
 * 抽取正文 div#js_content。
 * 微信正文嵌套很深，简单的 /<div id="js_content">(.*?)<\/div>/ 会在第一个内层 </div>
 * 处截断，必须做"匹配深度"的扫描。
 */
export function extractWeixinContent(html: string): string {
  const startRe = /<div[^>]*id=["']js_content["'][^>]*>/i;
  const startMatch = startRe.exec(html);
  if (!startMatch) return "";
  const startIdx = startMatch.index + startMatch[0].length;

  // 从 startIdx 开始，按 <div> / </div> 配对，找到与 js_content 对应的关闭标签
  const tagRe = /<\/?div\b[^>]*>/gi;
  tagRe.lastIndex = startIdx;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[0][1] === "/") {
      depth--;
      if (depth === 0) {
        return html.slice(startIdx, m.index);
      }
    } else {
      depth++;
    }
  }
  // 没找到闭合，兜底返回剩余
  return html.slice(startIdx);
}
