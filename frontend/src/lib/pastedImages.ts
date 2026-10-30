import { sanitizeForPaste } from "./sanitizeHtml";

// ---------------------------------------------------------------------------
// rescuePastedImages：从论坛 / 懒加载页面复制 HTML 时，<img src> 经常是
// 1×1 占位图（如 Discuz 的 static/image/common/none.gif），真正的图片地址
// 藏在 file / zoomfile / data-src / data-original / data-lazy-src 等自定义
// 属性里。这里把这些属性值"救"回到 src，并尝试把相对路径补成绝对 URL，
// 避免粘贴后图片完全消失或显示成 1×1 透明块。
//
// 选择第一个非空的"看起来像真正图片地址"的属性值；若 src 已经是绝对的
// http(s)/安全 data: URL 或本地附件地址则保留不动。
//
// 返回值：{ total, rescued, failed }
//   total   - 处理到的 <img> 总数
//   rescued - 从 data-src / file / srcset 等候选属性救回真实地址的 <img> 数
//   failed  - 仍然没有可用 src 的 <img>，不能据此判断原网页是否加载完成
// ---------------------------------------------------------------------------
export type RescueStats = { total: number; rescued: number; failed: number };
export function rescuePastedImages(root: Element, removeUnavailableImages = true): RescueStats {
  const stats: RescueStats = { total: 0, rescued: 0, failed: 0 };
  // 1) 先扫一遍找出本片段内"任意一个绝对 URL 的 origin"，作为相对路径的 base。
  //    优先用 <a href>/<link href>/已经是绝对地址的 <img src>，因为 Discuz
  //    复制过来的 HTML 往往带有指向源站的链接（如附件下载链接）。
  let pasteBaseOrigin: string | null = null;
  const pickOrigin = (raw: string | null) => {
    if (pasteBaseOrigin || !raw) return;
    if (!/^https?:\/\//i.test(raw)) return;
    try {
      pasteBaseOrigin = new URL(raw).origin;
    } catch {
      /* ignore malformed */
    }
  };
  root.querySelectorAll("a[href]").forEach((a) => pickOrigin(a.getAttribute("href")));
  root.querySelectorAll("img").forEach((img) => {
    pickOrigin(img.getAttribute("src"));
    pickOrigin(img.getAttribute("file"));
    pickOrigin(img.getAttribute("zoomfile"));
    pickOrigin(img.getAttribute("data-src"));
    pickOrigin(img.getAttribute("data-original"));
  });

  // 2) 占位图特征：Discuz/typecho/常见 lazyload 库都用极小的 gif/png 占位，
  //    或干脆 src 为空、为 about:blank。命中即视为"需要救援"。
  const isPlaceholderSrc = (src: string | null): boolean => {
    if (!src) return true;
    const s = src.trim();
    if (!s || s === "about:blank") return true;
    // data:image/gif;base64,R0lGODlh...（1×1 透明 gif/png 占位）
    if (/^data:image\/(gif|png);base64,/i.test(s) && s.length < 200) return true;
    // Discuz 标准占位
    if (/\/none\.gif(\?|$)/i.test(s)) return true;
    if (/\/(blank|placeholder|spacer|grey|loading)\.(gif|png|svg)(\?|$)/i.test(s)) return true;
    return false;
  };

  // 3) 只恢复可用的图片地址；源页面的 blob/file 地址不能跨页面复用。
  const toAbsolute = (url: string | null): string | null => {
    if (!url) return null;
    const u = url.trim();
    if (!u) return null;
    if (/^\/api\/attachments\//.test(u)) return u;
    if (/^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|avif);base64,/i.test(u)) return u;
    // 不把 javascript:/file:/blob: 等协议误拼成 HTTP 相对路径。
    if (/^[a-z][a-z\d+.-]*:/i.test(u) && !/^https?:\/\//i.test(u)) return null;
    try {
      const absolute = u.startsWith("//") ? `https:${u}` : u;
      const resolved = pasteBaseOrigin ? new URL(absolute, `${pasteBaseOrigin}/`) : new URL(absolute);
      return /^https?:$/.test(resolved.protocol) ? resolved.href : null;
    } catch {
      return null;
    }
  };

  // 从 srcset 字符串中挑一个 URL（优先最高分辨率）。
  //   "url1 1x, url2 2x"  → url2
  //   "url1 320w, url2 1280w" → url2
  //   "url1"              → url1
  const pickFromSrcset = (raw: string | null): string | null => {
    if (!raw) return null;
    const entries = raw
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean)
      .map((e) => {
        // 允许 URL 内含空格（罕见）；取最后一段做 descriptor
        const m = e.match(/^(\S+)(?:\s+(\S+))?$/);
        if (!m) return null;
        const url = toAbsolute(m[1]);
        if (!url || isPlaceholderSrc(url)) return null;
        const desc = (m[2] || "").toLowerCase();
        let weight = 0;
        if (desc.endsWith("w")) weight = parseFloat(desc);
        else if (desc.endsWith("x")) weight = parseFloat(desc) * 1000; // 粗略统一量纲
        else weight = 0;
        return { url, weight };
      })
      .filter((x): x is { url: string; weight: number } => !!x);
    if (entries.length === 0) return null;
    entries.sort((a, b) => b.weight - a.weight);
    return entries[0].url;
  };

  // 4) 救援每一个 <img>：按优先级挑一个有效的真实地址覆盖到 src
  root.querySelectorAll("img").forEach((img) => {
    stats.total += 1;
    const currentSrc = img.getAttribute("src");
    // src 已经是合法且非占位的远端/data URL → 不动
    //   注意：file:// 不算合法（浏览器出于安全限制不会加载），
    //   Word 复制过来的 <img src="file:///C:/Users/.../clip_image001.png"> 必须走救援流程。
    if (currentSrc && /^(https?:\/\/|data:|\/api\/attachments\/)/i.test(currentSrc.trim())
      && toAbsolute(currentSrc) && !isPlaceholderSrc(currentSrc)) {
      return;
    }
    // 候选属性顺序：Discuz 的 zoomfile（点击放大原图）> file > 通用 lazyload 属性
    // 覆盖主流懒加载库与站点：lazysizes、lozad、jQuery.lazyload、微信公众号、
    // CSDN、简书、掘金、知乎、博客园、Medium 等
    const candidates = [
      "zoomfile",
      "file",
      "data-src",
      "data-original",
      "data-lazy-src",
      "data-actualsrc",
      "data-echo",
      "data-raw-src",
      "data-original-src",
      "data-src-large",
      "data-src-hd",
      "data-hires",
      "data-full",
      "data-url",
      "data-href",
    ];
    let picked: string | null = null;
    for (const attr of candidates) {
      const v = toAbsolute(img.getAttribute(attr));
      if (v && !isPlaceholderSrc(v)) {
        picked = v;
        break;
      }
    }
    // 从 data-srcset / srcset 挑最大尺寸
    if (!picked) {
      picked = pickFromSrcset(img.getAttribute("data-srcset"))
        || pickFromSrcset(img.getAttribute("srcset"));
    }
    // 从父层 <picture> 的 <source srcset> 挑最大尺寸
    if (!picked) {
      const picture = img.closest("picture");
      if (picture) {
        const sources = Array.from(picture.querySelectorAll("source"));
        for (const s of sources) {
          const url = pickFromSrcset(s.getAttribute("srcset"))
            || pickFromSrcset(s.getAttribute("data-srcset"));
          if (url) {
            picked = url;
            break;
          }
        }
      }
    }
    // 候选都没有，但当前 src 是相对路径（非占位）→ 也尝试补全
    if (!picked && currentSrc && !isPlaceholderSrc(currentSrc)) {
      picked = toAbsolute(currentSrc);
    }
    if (!picked) {
      // 救不回来，记一笔（常见来源：
      //   a) 懒加载网页图片未加载完；
      //   b) Word/WPS 复制而来 —— HTML 里 <img src="file:///..."> 浏览器无法加载）
      // 从片段中移除该 <img>，避免最终笔记里出现破图图标。
      stats.failed += 1;
      img.removeAttribute("src");
      if (removeUnavailableImages) img.remove();
      return;
    }
    img.setAttribute("src", picked);
    img.removeAttribute("srcset");
    stats.rescued += 1;
  });

  // 5) Discuz 把 <img> 包在 <ignore_js_op> 里（一个 Discuz 自造标签，
  //    PM schema 认不出会被丢，连带 <img> 一起丢）。这里把它替换为 <span>。
  root.querySelectorAll("ignore_js_op").forEach((el) => {
    const span = el.ownerDocument.createElement("span");
    while (el.firstChild) span.appendChild(el.firstChild);
    el.replaceWith(span);
  });

  return stats;
}

export function preparePastedImages(html: string): { html: string; imageStats: RescueStats } {
  // DOMParser 中的片段不进入页面；恢复地址后仍须经过统一安全清洗。
  const root = new DOMParser().parseFromString(html, "text/html").body;
  // 保留不可用图片的空占位：Word/WPS 需要按位置回填 RTF 图片，
  // 普通 HTML 插入则由最终归一化移除占位并准确报告失败数。
  const imageStats = rescuePastedImages(root, false);
  return { html: sanitizeForPaste(root.innerHTML), imageStats };
}
