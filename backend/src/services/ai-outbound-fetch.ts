/**
 * Dedicated outbound network path for AI provider traffic.
 *
 * NOWEN_AI_PROXY_URL is an administrator-managed setting (Docker env). We do
 * not enable an unrestricted system-wide proxy because sync, attachments,
 * private user URLs and the plugin SSRF boundary must remain unaffected.
 */
import { ProxyAgent, fetch as undiciFetch } from "undici";

const DEFAULT_BYPASS = ["localhost", "127.0.0.1", "::1", "host.docker.internal", ".localhost", ".local"];

export interface AIOutboundProxyStatus {
  enabled: boolean;
  valid: boolean;
  bypass: string[];
  message: string;
}

export function aiProxyBypassRules(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...DEFAULT_BYPASS, ...(env.NOWEN_AI_NO_PROXY || "").split(",")]
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean);
}

export function shouldBypassAIProxy(target: URL, env: NodeJS.ProcessEnv = process.env): boolean {
  const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!/^https?:$/.test(target.protocol)) return true;
  // Local inference servers should not be sent to a public/remote proxy.
  if (host === "::1" || host.startsWith("127.") || host.startsWith("10.") ||
      host.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host.startsWith("169.254.") || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    return true;
  }
  return aiProxyBypassRules(env).some((rule) => {
    if (rule === "*") return true;
    const match = rule.startsWith("*.") ? rule.slice(1) : rule;
    if (match.startsWith(".")) return host.endsWith(match) || host === match.slice(1);
    return host === match;
  });
}

function parseProxyURL(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.NOWEN_AI_PROXY_URL || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) ||
        !url.hostname || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("Invalid proxy format");
    }
    return url.toString();
  } catch {
    throw new Error("NOWEN_AI_PROXY_URL 必须为 HTTP 或 HTTPS 代理地址，请检查服务器环境变量");
  }
}

export function getAIOutboundProxyStatus(env: NodeJS.ProcessEnv = process.env): AIOutboundProxyStatus {
  const enabled = !!env.NOWEN_AI_PROXY_URL?.trim();
  try {
    parseProxyURL(env);
    return {
      enabled, valid: true, bypass: aiProxyBypassRules(env),
      message: enabled ? "AI 服务请求使用服务器出站代理；命中绕过规则的地址仍直连" : "AI 服务请求直连（未配置服务器代理）",
    };
  } catch {
    return { enabled, valid: false, bypass: aiProxyBypassRules(env), message: "AI 代理配置无效，请管理员检查 NOWEN_AI_PROXY_URL" };
  }
}

let cachedProxyUrl: string | null = null;
let cachedAgent: ProxyAgent | null = null;

/** Mirrors fetch/Response semantics, including SSE streaming and AbortSignal. */
export async function aiOutboundFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const target = new URL(String(input));
  const proxy = parseProxyURL(process.env);
  if (!proxy || shouldBypassAIProxy(target)) return fetch(target, init);
  if (cachedProxyUrl !== proxy || !cachedAgent) {
    // Env vars are intended to change only on process restart; avoid mutating
    // the global dispatcher or closing in-flight provider connections.
    cachedAgent = new ProxyAgent(proxy);
    cachedProxyUrl = proxy;
  }
  const options = { ...init, dispatcher: cachedAgent } as unknown as Parameters<typeof undiciFetch>[1];
  return await undiciFetch(target.toString(), options) as unknown as Response;
}
