/**
 * 服务器地址的解析与拼接。
 *
 * ⚠️ 为什么需要它（真实踩过的坑）：
 *   用户手打 `192.168.8.9:3002`（没写协议）时，浏览器会把它当**相对路径**，
 *   解析成 `https://localhost/192.168.8.9:3002/api/notes` → 全部 404。
 *   所以：**存的时候必须带协议**，UI 上则用「协议下拉 + 主机端口」两段式，
 *   让用户根本不需要自己打 `http://`（对齐 Nowen Note 标准版的做法）。
 */

export type Scheme = "http" | "https";

export const SCHEMES: Scheme[] = ["http", "https"];

export interface ServerParts {
  scheme: Scheme;
  /** host[:port][/path]，不含协议头 */
  host: string;
}

/** 拆成「协议 + 主机端口」用于显示 */
export function splitServer(raw: string): ServerParts {
  const url = (raw || "").trim();
  const m = /^(https?):\/\/(.*)$/i.exec(url);
  if (m) {
    return { scheme: m[1].toLowerCase() as Scheme, host: m[2].replace(/\/+$/, "") };
  }
  return { scheme: "http", host: url.replace(/\/+$/, "") };
}

/** 拼回完整地址；host 为空则返回空串（＝与当前页面同源） */
export function joinServer(parts: ServerParts): string {
  const host = parts.host.trim().replace(/\/+$/, "");
  if (!host) return "";
  return `${parts.scheme}://${host}`;
}

/**
 * 补协议：非空且没写协议时补上 `http://`。
 * 空串保持空串（那是「同源」的合法表示，不能补）。
 */
export function ensureScheme(raw: string, fallback: Scheme = "http"): string {
  const url = (raw || "").trim().replace(/\/+$/, "");
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url; // 其它协议（capacitor: 等）不动
  return `${fallback}://${url}`;
}
