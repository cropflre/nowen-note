function readWechatArticleClipboard(clipboard) {
  const text = clipboard.readText();
  if (text.length > 16384) return "";
  const urls = new Set();
  for (const match of text.matchAll(/https:\/\/[^\s<>"'，。；！？）】]+/gi)) {
    try {
      const url = new URL(match[0].replace(/[),.;!?]+$/, "").replace(/&amp;/g, "&"));
      if (url.hostname !== "mp.weixin.qq.com" || url.port || url.username || url.password || !/^\/s(?:\/[A-Za-z0-9_-]+)?$/.test(url.pathname)) continue;
      if (url.pathname === "/s" && !["__biz", "mid", "idx"].every((key) => url.searchParams.get(key))) continue;
      const clean = new URL(url.origin + url.pathname);
      for (const key of ["__biz", "mid", "idx", "sn", "chksm"]) if (url.searchParams.has(key)) clean.searchParams.set(key, url.searchParams.get(key));
      urls.add(clean.href);
    } catch { /* Ignore text that is not a public article URL. */ }
  }
  return urls.size <= 20 ? [...urls].join("\n") : "";
}
module.exports = { readWechatArticleClipboard };
