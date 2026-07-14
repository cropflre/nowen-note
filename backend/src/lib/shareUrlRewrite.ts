/**
 * shareUrlRewrite
 *
 * 用途：把分享笔记 content 中所有指向本站的相对附件路径
 *      （/api/attachments/<id>、/api/task-attachments/<id>）改写成绝对 URL，
 *      从而让分享页在以下场景中也能正常显示图片：
 *        - 第三方页面 / 公众号 webview / 邮件正文 嵌入分享链接
 *        - SPA 与后端不同源（前端走 dev server、后端走 API server）
 *        - 走 CDN/边缘缓存时分享 HTML 与图片 origin 不一致
 *
 * 设计原则：
 *   1) 只动相对路径，不碰 http(s)://、data:、blob:、//cdn... 这类已经绝对/协议相对的 src。
 *   2) 不修改数据库里的原始 content，只在 HTTP 出口层 "贴邮票"，
 *      因此搬域名 / 改端口 / 反代换路径都不会让历史数据失效。
 *   3) 同时覆盖三种内容形态：
 *        a. Tiptap/ProseMirror JSON 字符串里的  "src":"/api/attachments/xxx"
 *        b. HTML 透传里的 <img src="/api/attachments/xxx"> / src='...'
 *        c. Markdown 里的 ![alt](/api/attachments/xxx) 以及 [text](/api/attachments/xxx)
 *
 * 关于路径前缀：当前只改写 /api/attachments/ 与 /api/task-attachments/，
 *   都是"用 uuid 直链取附件"的图床式接口，无鉴权也能 GET 到。
 *   将来如果有新的附件路径，只需要往 ATTACHMENT_PATH_PREFIXES 里加一项即可。
 */

const ATTACHMENT_PATH_PREFIXES = ["/api/attachments/", "/api/task-attachments/"];

function isLoopbackHost(host: string): boolean {
  const lowered = host.toLowerCase();
  return lowered === "localhost"
    || lowered.startsWith("localhost:")
    || lowered.startsWith("127.")
    || lowered.startsWith("0.0.0.0")
    || lowered.startsWith("[::1]");
}

/**
 * 根据请求头推断 "公网访问本服务时" 应使用的 origin。
 * 优先使用反代/网关注入的 X-Forwarded-Proto / X-Forwarded-Host，
 * 退化到 Host 头并据 Host 自身格式猜测协议（127.x、localhost、:80 用 http，否则 https）。
 *
 * 重要：最终 Host 是 localhost / 127.0.0.1 / 0.0.0.0 时一律返回 null。
 * 这通常是 NAS、隧道或 Docker 反代传给上游的内部地址，不是用户浏览器可访问的地址；
 * 即使它来自 X-Forwarded-Host，也不能把回环地址签发给外部客户端。调用方此时应返回
 * 相对 URL，由客户端以真实 API 请求 origin 解析。
 *
 * 返回形如 "https://notes.example.com"，不带末尾斜杠。
 * 解析失败返回 null，调用方应放弃改写并保持相对路径。
 */
export function resolvePublicOrigin(getHeader: (name: string) => string | undefined | null): string | null {
  const xfProto = (getHeader("x-forwarded-proto") || "").split(",")[0]?.trim().toLowerCase();
  const xfHost = (getHeader("x-forwarded-host") || "").split(",")[0]?.trim();
  const host = (getHeader("host") || "").trim();

  const finalHost = xfHost || host;
  if (!finalHost || isLoopbackHost(finalHost)) return null;

  let proto = xfProto;
  if (!proto) {
    // 没有反代头时按 host 猜协议：
    //   - 仅在"明显是公网默认 HTTPS 端口（443 / 无端口的标准域名）"时才用 https；
    //   - 其余（带显式自定义端口、本地地址、纯 IP）一律退回 http。
    //
    // 历史教训：早期实现 "本地 → http；其余 → https"，导致用户用裸 IP+自定义端口
    // （如 http://1.2.3.4:666/share/...）访问 http 服务时，把 <img src="/api/attachments/...">
    // 改写成了 https://1.2.3.4:666/...，浏览器拉图全部 ERR_SSL_PROTOCOL_ERROR / 连不上。
    // 真正运行在 HTTPS 上的部署一般都在反代后面（nginx / caddy / cdn），那条路径有
    // X-Forwarded-Proto 兜底，不依赖这里的猜测，所以收紧这里更安全。
    const lowered = finalHost.toLowerCase();
    const hasExplicitPort = /:\d+$/.test(lowered) && !lowered.endsWith(":443");
    const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(lowered)
      || lowered.startsWith("[");           // IPv6 字面量 [::1]:xxxx

    if (isIpLiteral || hasExplicitPort) {
      proto = "http";
    } else {
      proto = "https";
    }
  }

  // 基本合法性校验，避免拼出 "javascript://..." 之类的脏 origin
  if (proto !== "http" && proto !== "https") return null;
  if (!/^[\w.\-:\[\]]+$/.test(finalHost)) return null;

  return `${proto}://${finalHost}`;
}

/**
 * 把字符串型 content 里的相对附件路径改写成绝对 URL。
 * 对所有非字符串、空字符串、不含目标前缀的输入直接原样返回，避免无谓正则扫描。
 *
 * 实现策略：
 *   - 不解析 HTML/Markdown/JSON，统一用正则按 "前导定界符 + 相对路径" 的形态匹配，
 *     这样能一次性覆盖三种语境（JSON 的双引号、HTML 的双/单引号、Markdown 的左括号）。
 *   - 仅当紧邻字符是 ", ', ( 这三种 "URL 起始定界" 之一时才替换，避免误伤
 *     如 "see /api/attachments/xxx in docs" 这种纯文本里的路径（虽然这种情况极少）。
 */
export function rewriteRelativeAttachmentUrls(content: string | null | undefined, publicOrigin: string): string | null | undefined {
  if (content == null) return content;
  if (typeof content !== "string" || content.length === 0) return content;
  if (!publicOrigin) return content;

  // 快速短路：内容里压根没有目标前缀就别走正则
  let hit = false;
  for (const prefix of ATTACHMENT_PATH_PREFIXES) {
    if (content.indexOf(prefix) !== -1) { hit = true; break; }
  }
  if (!hit) return content;

  const origin = publicOrigin.replace(/\/+$/, "");

  // 用一个组合正则一次扫完，捕获定界符以原样保留
  //   group1: 定界符 ("、'、( 之一)
  //   group2: 完整相对路径（从 / 开始，到下一个 ", ', ), 空白 或字符串结束为止）
  // 注意：我们只针对 ATTACHMENT_PATH_PREFIXES 中的前缀做替换。
  const prefixAlt = ATTACHMENT_PATH_PREFIXES
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const re = new RegExp(`(["'(])((?:${prefixAlt})[^"')\\s]*)`, "g");

  return content.replace(re, (_m, delim: string, path: string) => `${delim}${origin}${path}`);
}
